// Order secrecy via commit-reveal (ADR-004, ADR-009, ADR-011).
package server

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"golang.org/x/crypto/chacha20poly1305"

	"github.com/zond/godip"
)

// seatKey stands in for the key a phone derives from its seat seed. It only
// has to be the same 32 bytes on both sides of one seat's lock and reveal.
func seatKey(power godip.Nation) []byte {
	key := make([]byte, chacha20poly1305.KeySize)
	copy(key, "key-for-"+string(power))
	return key
}

// draft is one seat's orders, as a phone would hold them.
func draft(pairs ...[]string) []revealedOrder {
	out := []revealedOrder{}
	for _, pair := range pairs {
		out = append(out, revealedOrder{Province: pair[0], Parts: pair[1:]})
	}
	return out
}

// commitAs locks a seat the way a phone does: the sealed orders, and no key.
func commitAs(g *game, id string, power godip.Nation, orders []revealedOrder) *httptest.ResponseRecorder {
	envelope, err := sealOrders(id, g.flow.phaseIndex, power, seatKey(power), orders)
	if err != nil {
		panic(err)
	}
	body := fmt.Sprintf(`{"sealed":%q}`, envelope)
	rec := httptest.NewRecorder()
	g.seatLock(id, power, true, rec, httptest.NewRequest(http.MethodPost, "/", strings.NewReader(body)))
	return rec
}

/*
revealAs sends one seat's key, which is what the phone does by itself the
moment it sees the window open. The orders are already on the server, inside
the envelope this key opens.

`key` overrides the seat's own, for the tests about a key that does not fit.
*/
func revealAs(g *game, id string, power godip.Nation, key []byte) *httptest.ResponseRecorder {
	if key == nil {
		key = seatKey(power)
	}
	body := fmt.Sprintf(`{"key":%q}`, base64.RawURLEncoding.EncodeToString(key))
	rec := httptest.NewRecorder()
	handleSeatReveal(g, id, power, rec, httptest.NewRequest(http.MethodPost, "/", strings.NewReader(body)))
	return rec
}

// sealedGame is a started classical game that keeps its orders on the phones,
// which is every game made from now on.
func sealedGame(t *testing.T) *game {
	t.Helper()
	g := watchTestGame(t)
	if !g.flow.sealed {
		t.Fatal("a new game must be sealed")
	}
	return g
}

/*
TestASealedGameHoldsNoOrderUntilEveryoneHasLocked is the property ADR-004
exists for, and the one M3's acceptance criterion names: an observer with full
read access to the server mid-phase learns nothing about anybody's orders.
*/
func TestASealedGameHoldsNoOrderUntilEveryoneHasLocked(t *testing.T) {
	g := sealedGame(t)
	orders := map[godip.Nation][]revealedOrder{
		"Austria": draft([]string{"bud", "Move", "ser"}),
		"Germany": draft([]string{"mun", "Move", "ruh"}),
	}

	// Six of seven lock in. The seventh has not, so nothing may be released.
	for _, p := range g.flow.powers {
		if p == "Turkey" {
			continue
		}
		if rec := commitAs(g, "game", p, orders[p]); rec.Code != http.StatusOK {
			t.Fatalf("%v could not lock: %v %v", p, rec.Code, rec.Body.String())
		}
	}
	if g.flow.revealOpen() {
		t.Fatal("the reveal window opened with a power still to lock in")
	}

	// Nothing about an order is anywhere on this server.
	if len(g.parts) != 0 || len(g.owner) != 0 {
		t.Errorf("the board holds orders mid-phase: %v", g.parts)
	}
	if len(g.state.Orders()) != 0 {
		t.Errorf("the engine holds orders mid-phase: %v", g.state.Orders())
	}
	view := httptest.NewRequest(http.MethodGet, "/", nil)
	for _, p := range g.flow.powers {
		state := g.seatState("game", p, view)
		if len(state.Orders) != 0 || len(state.OrderParts) != 0 {
			t.Errorf("%v's own seat was shown orders the server should not have: %v",
				p, state.Orders)
		}
	}
	// And what the server does hold about Austria is an envelope with no key.
	envelope := g.flow.seats["Austria"].sealed
	if envelope == "" {
		t.Fatal("Austria locked in and the server kept nothing")
	}
	if strings.Contains(envelope, "ser") || strings.Contains(envelope, "bud") {
		t.Errorf("the stored envelope is not opaque: %q", envelope)
	}
	if _, err := openOrders("game", 0, "Austria", make([]byte, 32), envelope); err == nil {
		t.Error("an all-zero key opened the envelope")
	}

	// A seat may not release early, and the last lock opens the window.
	if rec := revealAs(g, "game", "Austria", nil); rec.Code != http.StatusConflict {
		t.Errorf("revealing before the window answered %v, want 409", rec.Code)
	}
	if rec := commitAs(g, "game", "Turkey", nil); rec.Code != http.StatusOK {
		t.Fatalf("Turkey could not lock: %v %v", rec.Code, rec.Body.String())
	}
	if !g.flow.revealOpen() {
		t.Fatal("every power locked in and the window did not open")
	}
	// Locking is over: a seat that could re-commit now could read the other
	// reveals first and change its mind.
	if rec := commitAs(g, "game", "Austria", nil); rec.Code != http.StatusConflict {
		t.Errorf("re-locking after the window opened answered %v, want 409", rec.Code)
	}

	for _, p := range g.flow.powers {
		if rec := revealAs(g, "game", p, nil); rec.Code != http.StatusOK {
			t.Fatalf("%v could not reveal: %v %v", p, rec.Code, rec.Body.String())
		}
	}

	// The last reveal adjudicated. It may have carried on past the retreat
	// phase, which asks nobody when nothing was dislodged (ADR-034), so the
	// test is that the board moved rather than how far.
	if g.flow.phaseIndex < 1 {
		t.Fatalf("phase index is %v — the last reveal must adjudicate", g.flow.phaseIndex)
	}
	if _, _, ok := g.state.Unit(godip.Province("ser")); !ok {
		t.Error("Austria's revealed order did not happen")
	}
	if _, _, ok := g.state.Unit(godip.Province("ruh")); !ok {
		t.Error("Germany's revealed order did not happen")
	}
	if len(g.previousPhase.NMR) != 0 {
		t.Errorf("NMR %v, want none: every power revealed", g.previousPhase.NMR)
	}
}

// A commitment is replaceable until the window opens (ADR-011): the last hash
// is the one the reveal is checked against.
func TestTheLastCommitmentIsTheOneThatCounts(t *testing.T) {
	g := sealedGame(t)
	first := draft([]string{"bud", "Move", "ser"})
	second := draft([]string{"bud", "Move", "rum"})

	// The first envelope is replaced, so the server no longer holds it and
	// the orders inside it can never reach the board.
	commitAs(g, "game", "Austria", first)
	held := g.flow.seats["Austria"].sealed
	commitAs(g, "game", "Austria", second)
	if g.flow.seats["Austria"].sealed == held {
		t.Fatal("the second lock did not replace the first envelope")
	}
	for _, p := range g.flow.powers {
		if p != "Austria" {
			commitAs(g, "game", p, nil)
		}
	}

	if rec := revealAs(g, "game", "Austria", nil); rec.Code != http.StatusOK {
		t.Fatalf("the committed draft was refused: %v %v", rec.Code, rec.Body.String())
	}
	// What reached the board is the second draft and not the first. The other
	// six seats have not revealed, so the phase has not resolved and the
	// applied order is still the one to read.
	if got := g.parts[godip.Province("bud")]; len(got) != 2 || got[1] != "rum" {
		t.Errorf("the board took %v, want the replacement Move rum", got)
	}
}

/*
An envelope belongs to one game, one phase and one seat.

Those three are the associated data, so the tag covers them and the same key
opens the envelope in one place only. Without that, a game master could move a
seat's envelope into the next phase and open it with the key that seat is about
to publish.
*/
func TestAnEnvelopeBelongsToOneGameOnePhaseAndOneSeat(t *testing.T) {
	orders := draft([]string{"bud", "Move", "ser"})
	key := seatKey("Austria")
	envelope, err := sealOrders("game", 0, "Austria", key, orders)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := openOrders("game", 0, "Austria", key, envelope); err != nil {
		t.Fatalf("its own key does not open it: %v", err)
	}
	for _, wrong := range []struct {
		what  string
		id    string
		phase int
		power godip.Nation
	}{
		{"another game", "other", 0, "Austria"},
		{"the next phase", "game", 1, "Austria"},
		{"another seat", "game", 0, "Germany"},
	} {
		if _, err := openOrders(wrong.id, wrong.phase, wrong.power, key, envelope); err == nil {
			t.Errorf("the envelope opened in %v", wrong.what)
		}
	}
	if _, err := openOrders("game", 0, "Austria", seatKey("Germany"), envelope); err == nil {
		t.Error("another seat's key opened it")
	}
	// A tampered envelope fails the same way, which is what the tag is for.
	broken := envelope[:len(envelope)-2] + "AA"
	if _, err := openOrders("game", 0, "Austria", key, broken); err == nil {
		t.Error("a tampered envelope opened")
	}
}

// The plaintext is the orders and nothing about the order they were tapped in.
func TestTheEnvelopeHoldsTheOrdersSorted(t *testing.T) {
	shuffled := draft([]string{"vie", "Hold"}, []string{"bud", "Move", "ser"})
	straight := draft([]string{"bud", "Move", "ser"}, []string{"vie", "Hold"})
	a, err := canonicalOrders(shuffled)
	if err != nil {
		t.Fatal(err)
	}
	b, err := canonicalOrders(straight)
	if err != nil {
		t.Fatal(err)
	}
	if string(a) != string(b) {
		t.Errorf("the same orders encode differently:\n%s\n%s", a, b)
	}
	if string(a) != `[{"province":"bud","parts":["Move","ser"]},{"province":"vie","parts":["Hold"]}]` {
		t.Errorf("the plaintext reads %s", a)
	}
	none, err := canonicalOrders(nil)
	if err != nil {
		t.Fatal(err)
	}
	if string(none) != "[]" {
		t.Errorf("no orders encode as %s, want []", none)
	}
}

/*
The server opens what the phone sealed (ADR-004).

The envelope below was produced by web/src/sealed.ts, with a fixed key, and is
pinned here. If the two sides drift, every reveal in a real game fails and the
player is told their key does not open their own orders — so this side is
checked against bytes the other one made rather than against itself.

It is padded (ADR-057), so it also pins the frame: the version byte, the
big-endian length and the zero bytes after it are all inside the tag, and a Go
side that framed differently would not open this.
*/
func TestTheServerOpensWhatThePhoneSealed(t *testing.T) {
	key, err := base64.RawURLEncoding.DecodeString("AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8")
	if err != nil {
		t.Fatal(err)
	}
	const fromThePhone = "mFeqI6ON2-Unp3rUYjG8jpI9vJ_lL9a3r8t_rhXtYdEZ16qCAmFEi-ilgPJwNFJFWQWaM27e5vp-5rmqM_gVe_BUTb_RB1ECRRHiSadXZ7y-xjVSIBNrAzTa51oajxKJIOHuAZmebafuAYeIFydj1I0USghWDJJ_htpmE1HVl7jI540gpV423jZLVnpF9cOg1Va_nJsdsJMWJiwwICwes57y-pEuoI0IaS1nfBpjOgX0qUL_pMDR9KMEAomRR6zh0xfgKEuoE-042D8IZrXmtzS2nur92qptnHiaVO9h2EIENEJJ4gTTP3LnYXwg31a9WrqOrks7DHRLD6DDiUKgIxwpqHBNZzPf7QlTHnCr8NWnBiPK0orpE-wQI1ptcO4dPypO1uNP2pWg0kOX-MiChTFbTOdhxbmGZjkbfnXTRm4xE3RSPO7hBTxLfwddHgW9L1ol96MlV5nThLlZ6TCEbnnJ_eapImJio6lu5MDfXo8qMScBKm8tO00D3txWr_Copj60Yy6FM6IXvSlHi9CPLE-REpcIitYj7Q9uEaMNPYGCVBGRnRVJ_n0S46BP4L2y-ozx1sKsFLIPVGLW15b4ym2E_r6E-Go2kPwYLJNcSScLn-KsIUMuw3Ods2V3LkqBbHFBmOTymbQ2Tj1J5nGMBhhyh8p1hN9ojZ32ynhQFVkj73oGBTbQbydYILMcEDyQ2AhBT3mQraFQ5F-PJ3JwnY6ZGXiayo-dBxCsU3A5Wd7FEkoTAHCK_Qy6z8sk73DeL_Aaev8oNyD0XyopWMIVD1Sm1BwPANvWW89EVyLrQPkk260NzC5Za8IFRMBV6nJDIvlEi-Pf0fels78w9WU_iGrXWjFa7DKcbfXKbEvvV4eyW5OlYKU8nww2eo7v1gvvDf-zw3xtqrwoYQpmQ7KDORHFwzC69VGpfb4B3jUqyNOFJJqFbioV93bfWDqqnbXAqTL2ustMOuab-j5K8ihZHi-_NbKLTs47_bBJTBYJ9OqI_o20KdDY9xwvAPRSnHycQP9U5dLHOhAbfxQdOaH7DLWg9UaSdCpYURqAG9r4ghk3jckelTlTc9c29pyWdVtL34JWNNeHolgYt59AmYBAoStWOWoKsZhH9uX8NQ4Y7V1rLyhlQ285EKELxkiKflr15ymZNaIy5qWSxN-urXTB6cWotE3-fHgN69N3AeJaeZZNmjj0kdyuQAlymjRw4_P0Vbd_vq8sMwN-vq3zYT7-ziWxOr3kQ0SO8BJk7vtCQioXkycGWoqnuCfmT8XEDyG4Xt9lqWTHzxrUBYUOGzX1hCupEqeddIV63YXbTUyjMCm9onRO3ES2w62FLDh-7UUdYhdb9rBhOpHg7MSS9acBKaRmhIIyaYtDgNqOXgoCaedd-lqWs122O7i92y3qvO12m0PDkkawOaK6B2lb7tS4AqrbMZEugEA_npoIb3NkE6yvpXkdXdPd32fM1KxZLTkVmZMz75EeogFnNLFLOJEVpussJjPVuFZ61zAf1e8YezAprG8di0O6Daejl6phtAic6L75QPhMPouh1B_k8iawFBPkoUfwKzMBSb080lX1XvxW_z9rzrp-BbzgC_IFfj4OeMF8FmXSiFaa84qsVcqiIkqC7rlNuOQTYqwpxsLXhbtN3NgK6nAQuo11_5kFzlDcWH2GkM4f2588OwAytgYR4ogbhR4xhluu7BpnnZbEnBwKAKCnJ5feak93YlynrEa0XepfOR2UIZ-xv3CPPrr84v8iRfcDwU-LR-VOup6X0yvke_c5QGqSdCGKvgVQlULV3mCeQ-e3xDVv7mAk5nx3ZR_AgcODLkqm7c2le17p4F8jeyYI-Dkm7K5ENDki7QAdMhLfuDC0dWPWMr7-DxY3mCErFVJ2AHZtyUnmGkhjlMHFqJ3cP8PEwpM9rHlhnT4fkFRJQxWGjg9ENMYvD1bwyEr6VVvR-wrs-03td0asYQVa2bGNn7-9TE1dXatyCRROaxqCZzvWCSLKcTHAjkHdE3V1KtuyayMSUGVIcoWHUvKB24iZjN6ndiubrxXd6PH_kQ7JcWllyvSGEwONmaJjCdcha-2B8n60z5A0edn66pCpqn_CMimegGWcUEQ2DDVMEzATAOTfHfr7xh7kz6d7bBkRW9WHsSCt3CT005WwwuzWfcvVmOSaQYIRWuuQAlQCDZhTXJvBFN3384SKQ6g44RTe0oWgg9NFt6bIo3iAEVAob154wpdzKysr8bcGbMHdisorC2u2cqg0U0l31CdpneZru2AXWjLyDSJC_1fkwQ65ve4VQHhuw5FAwtZ3kIyxrf1B3-yVfaZJMLlHIwsrl5cMma1ItpHtcWh2TROV75bxj-iBD4v_lZ_cDFOCZEIPpAuuyPgb1hlL3gm2MGm6ez3JwUaZUFepMGJHBvgBl8nSkmsQ6dwDg24u8KXdXs3yctZvrm9UdtUQopppMHCKatStHLMv3aqYUVnv16dUr0JfKdhAOP0BREk8Tk59jersImYnFst2FJ3bhPwMew2NSErMrj5SfotP8oIPbqXx45_pbER5M9SmG_ihzm3fbVlNhaKH8Q5AlyWzb1R83IEX-DHb6dnDtKukR0EwnUX4AUFBtIbOInl_5c-uKnuQ0h_fjMtY-GpTctyWbmS0THemxK62d3xCrVXgBQZbIhDHSgzHTa-NcuguoohIXKuCVUR4Hfhg1LLA34se6O6RlBiaG8gL578CBaXYiPkAAzQkcKM7X_5o3anaad5ej6DsKfPi0CkEgrS96nibBCctc4oGpBoWA93KhCEzgbGh3TCB7A1Ub77BDNyJWZn3s3fGs8ve4RcqpazvpT6CwND4snFidh2iS4TK9QLy23WdmNmS2gIFM674375RqD-ZEXpjIqXHtfnp2Tc8N4n67V0hqwNC_5xfSeUMNh5HLw0D6pwH1tdUJgEdG_x0hBppiWVEIWUAD7QwK4bSu3pKgfGivOv97RL5lBWJE8JCjO9tAEIKuO7Dr6daIUaZONjdOYgFm3DCML3tg6HDdyaJHAEGxcf2ijKZmHMTVEdqU4FhXH8ooK914xM-KRECjuAqEe7HNM-5D_2_fIO9DBIgEHkVvOGENHlUe15MQiaQ6yBrDL_lZT_uVTNJqvkQV_rZ5WXK5LsPCIdOEhG7GkE5k9rNdaHCvRWIsEU_gCsKGcgj8aGd9Ai-1mQ68TiPgdInDEiaNfEH81yoQNMARHSefb5JiOJAstMnJ5knh26OPxFpVziaNK_KQYsC4tBVi6865b5QNXjr6HdB9B5kIsHY3wAgdFDSFe4JkKQiu2LZnsMkOetOzPssAYpP_Fe2aAsvgW4FXIlFOitGj70RlRcpr4Ra7mCHzGOsFMpokmgim7uQ2kw0A5pAhbmnOAbPSDxA4pmosbUVOMlRv0BQVdyP5UEMhqKiD4dGbBMCqhuBCH0cuzb3fQLNWvjhH5UB6ONEG71-8SZXB-O6jdFbVWIqheOmbYQRGgw3M6ogp_hQ3FMxHP3XiKKfXggO61IItxrc862R7iC-tmgQKkmexqLxMVsUDQOGT29nkJRFM3l4M0x0PJoFj7T-K7f5_zypbxNA-vPMqHAc23CSXbVJwiRrRkDVk3TvqubcZ9RXY3tQPbpwU8C2gZ_a2qZwsjk7UwlGjlNUl4x5XvPtp510h_EixC9C0g4IDjFFrwGda59VzE3n3zyFBMCyHkrLW0hf5k3Y2FEINzyLeMplhFRU21trEiALx_vQJjVShOmTV1qNTbD93_LBo_SgF0LM3_Bc6rF7jG4-6_e5oEw8hKD894R8efuBqOEUPrht638HlVU4STJWViR4f9E9M_IGCnTg2_rJi8oKcXh0JcoG3btneJZhYilTqpHG1W04pbNoZzFBx9bBYBgBueoY3Qibr6k-Cowqn7ITmYuavxcv_ynrBLflffWSlKG1ghe_B1OCrDdZb8MOCQzRV0sTb80yhss1i8NP-vfSlROmWV2-XCY-UjMWGrIxANZ83l9OQM0GfxW8GdkUngXtFxjLQ-C11h8oDYbp4kvUjijXxsISN2g2xBBiaQ4ngte_0zqCHsru6Lf7hqquVO5oWS9tRQRi_UblE5-F6QcE2CDsmNFfHvmg4kDwufKonuOWNbYNfD4dShbbKA1oHiY6iv0DYtOvUs6TURpZIwHZZh6tjwV6pIkusrMdY8T0QO6NYxjeTBpMNvB_D2uDJ_-r0xfRnQkAvs6JDexjLWfQrN4PfrgetRNf7fSLrOpluHX8DtbNe2MKKCCGXisUtt0bia8_o_D1s5qjpe2QaFRKNi7UUStoeYrojg4vGqqy_1YLv6FO7wtsxJ5CWk2wzLI4T0SDzjj4tMCTnvYpUgm-M2Q1CUEX1QrMIoVWyFn1C6eObNczAGOPCj3hYvJuhAg-6psH4TUSS39EPkBWQF9Csk0Djgd1FwlyopZwHGOnbqTbNitmP0KH-nu_VwrOdE6e6gqhr-xgtiF7b8S1yjo9n1K4U8yJDNYcXFLEkQWw8NtG0b9tHA19hpKyWaKfJVBLyZjYLJVm7JplkpPmGxRVldJxQkmngq51ugKn4lyc9nP9aA9Li_n8kgnPwftsAPqoWFvUATOiw92AWQKYRLGZq1rEQsDzQ5y0pv5-nN6ZWCHlAJ6PVVXU2NijEgTch7D5KSmNwMROhuasItOBy-NVjgAowjYG8Zn5CmM70PgpDWOF6rsIp6hqnntjTTHrb2R04D2Xs5mS-pinvt97zp0vI6DqHKxuge0zfdGjtxdcoTM0co78XEHJ9CGLORYCgGaeODM9-ndFYod_T7DlY0Hyq4HI3R3Scf-RSeyvQzDWKv79rPljvguuAtljl5DTCtSiFKC63FXV8uly4OXWL-zoYTsa1mMa5BcnQKsSmTF_bgOUtEEukr_WXm1o5i6jG5e7pJ2dCJa4hOgXFBTm6RAUJ-T2We-4jDG-UC48EfHYT_QgBIGSfrZrZoLkI0NJB-aCPYkMfaaipeQfrGEcvJnCHXAhXWbtd6vcbYUNIrMjs7sauZvXCpccUVEwnll0a-JM0DoeGD0lFYmaX8ruSBg9AbPiCQaMRfV4kWtntMvf56QeBMN0yIhg8URokW5vdSdYBmRRNo9M2IuPe9411TL_vvOCANunwoYKKlkmdLN630kwMVIxQqjfi7BiR4nWRDx5IWC4QyG1PYirsno40vIO_aiKDSbqZmsNDrmzuiMeIiT52G9ZSGx_CAsCAD2MLFz8ZkKqixUaFpipq4u51h20CE3RSHuwgzCEdj30HLAKom5yxeHjNhO13XFFHaZySqu7PCgqRHQc8nLrvyWofqj7ft4EU3Wyi4SeDY3oBsmzotIrReuu8uCJ4Kcfp9zaTYfmU4uda3aNSRA9FB-bbuA4KwsTLujwqOxsH_uIHtA8QeA6_2NvktVdxrqxxhMWv5oSWteLl85p_ZQm3sBFTLf1c5Wf5X4G36DpJs9W8SnCycRqSCjs4Bj6hkt0IiqhXcUdKaJBsfolEfy8iIkuM-Ustrumo8B-r4W2P7Q"
	orders, err := openOrders("g1", 0, "Austria", key, fromThePhone)
	if err != nil {
		t.Fatalf("the phone's envelope did not open: %v", err)
	}
	if len(orders) != 2 || orders[0].Province != "bud" || orders[1].Province != "vie" {
		t.Errorf("the phone's envelope held %+v", orders)
	}
	if len(orders[0].Parts) != 2 || orders[0].Parts[1] != "ser" {
		t.Errorf("Budapest reads %v", orders[0].Parts)
	}
}

// Unlocking withdraws the commitment rather than leaving it beside a false
// flag: a hash the seat has abandoned must not be revealable.
func TestUnlockingWithdrawsTheCommitment(t *testing.T) {
	g := sealedGame(t)
	orders := draft([]string{"bud", "Move", "ser"})
	commitAs(g, "game", "Austria", orders)

	rec := httptest.NewRecorder()
	g.seatLock("game", "Austria", false, rec, httptest.NewRequest(http.MethodPost, "/", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("unlock answered %v: %v", rec.Code, rec.Body.String())
	}
	if s := g.flow.seats["Austria"]; s.sealed != "" || s.locked {
		t.Errorf("the seat kept sealed=%q locked=%v", s.sealed, s.locked)
	}
	for _, p := range g.flow.powers {
		if p != "Austria" {
			commitAs(g, "game", p, nil)
		}
	}
	if g.flow.revealOpen() {
		t.Error("the window opened with a withdrawn lock counted as one")
	}
}

/*
A phone that locked in and then died (ADR-009). The window opens, the seat
never sends, the game master is told which one, and forcing writes an NMR
against it while every seat that did reveal keeps its orders.
*/
func TestACommittedSeatThatNeverRevealsIsFlaggedAndForced(t *testing.T) {
	g := sealedGame(t)
	orders := map[godip.Nation][]revealedOrder{
		"Germany": draft([]string{"mun", "Move", "ruh"}),
		"Austria": draft([]string{"bud", "Move", "ser"}),
	}
	for _, p := range g.flow.powers {
		commitAs(g, "game", p, orders[p])
	}
	for _, p := range g.flow.powers {
		if p != "Austria" {
			revealAs(g, "game", p, nil)
		}
	}

	waiting := g.flow.awaitingReveal()
	if len(waiting) != 1 || waiting[0] != "Austria" {
		t.Fatalf("awaiting %v, want [Austria]", waiting)
	}
	if !g.flow.canForce() {
		t.Error("the game master is not armed while a seat is unreachable")
	}
	view := httptest.NewRequest(http.MethodGet, "/", nil)
	if got := g.gmState("game", view).AwaitingReveal; len(got) != 1 || got[0] != "Austria" {
		t.Errorf("the game master view says %v", got)
	}

	if err := g.adjudicate("game", true); err != nil {
		t.Fatal(err)
	}
	if len(g.previousPhase.NMR) != 1 || g.previousPhase.NMR[0] != "Austria" {
		t.Errorf("NMR %v, want [Austria]", g.previousPhase.NMR)
	}
	if _, _, ok := g.state.Unit(godip.Province("ruh")); !ok {
		t.Error("Germany revealed in time and its order did not happen")
	}
	if _, _, ok := g.state.Unit(godip.Province("bud")); !ok {
		t.Error("Austria's unit did not hold where it started")
	}
}

/*
The other way the window opens (ADR-009): the deadline. Without it one player
who never locks in would hold every other phone's orders on its own phone, and
the game master would have nothing to force but a table of NMRs.
*/
func TestTheDeadlineOpensTheWindowForTheSeatsThatDidLockIn(t *testing.T) {
	g := sealedGame(t)
	orders := draft([]string{"mun", "Move", "ruh"})
	for _, p := range g.flow.powers {
		if p == "Turkey" {
			continue
		}
		var mine []revealedOrder
		if p == "Germany" {
			mine = orders
		}
		commitAs(g, "game", p, mine)
	}
	if g.flow.revealOpen() {
		t.Fatal("the window opened before the deadline with a power still out")
	}

	past := time.Now().Add(-time.Minute)
	g.flow.deadlineAt = &past
	if !g.flow.revealOpen() {
		t.Fatal("the deadline passed and the window did not open")
	}
	if rec := revealAs(g, "game", "Germany", nil); rec.Code != http.StatusOK {
		t.Fatalf("Germany could not reveal after the deadline: %v %v", rec.Code, rec.Body.String())
	}
	// Turkey never locked in, so the phase does not resolve on its own.
	if g.flow.phaseIndex != 0 {
		t.Error("the phase resolved with a power that never locked in")
	}
	if err := g.adjudicate("game", true); err != nil {
		t.Fatal(err)
	}
	if _, _, ok := g.state.Unit(godip.Province("ruh")); !ok {
		t.Error("Germany locked in before the deadline and lost its order anyway")
	}
	if len(g.previousPhase.NMR) == 0 {
		t.Error("Turkey never locked in and is not an NMR")
	}
}

// A sealed game has no server-side draft to write to (ADR-011).
func TestASealedGameRefusesAServerSideDraft(t *testing.T) {
	g := sealedGame(t)
	rec := httptest.NewRecorder()
	handleSeatOrder(g, "game", "Austria", rec, httptest.NewRequest(http.MethodPost, "/",
		strings.NewReader(`{"province":"bud","parts":["Move","ser"]}`)))
	if rec.Code != http.StatusConflict {
		t.Errorf("an order posted to a sealed game answered %v, want 409: %v",
			rec.Code, rec.Body.String())
	}
	if len(g.parts) != 0 {
		t.Error("the refused order was stored anyway")
	}
}

// A seat may only reveal its own orders, whatever it sealed.
func TestARevealCannotOrderAnotherPower(t *testing.T) {
	g := sealedGame(t)
	theirs := draft([]string{"mun", "Move", "ruh"})
	for _, p := range g.flow.powers {
		var mine []revealedOrder
		if p == "Austria" {
			mine = theirs
		}
		commitAs(g, "game", p, mine)
	}
	if rec := revealAs(g, "game", "Austria", nil); rec.Code != http.StatusForbidden {
		t.Errorf("Austria revealed a German order and got %v, want 403", rec.Code)
	}
	if _, present := g.parts[godip.Province("mun")]; present {
		t.Error("the order was applied anyway")
	}
}

// A restart mid-phase brings the hashes back and nothing else. The orders are
// on the phones, which is the property, and the phones reveal again.
func TestTheCommitmentsSurviveARestart(t *testing.T) {
	g, id := illegalTestGame(t, true)
	orders := draft([]string{"bud", "Move", "ser"})
	for _, p := range g.flow.powers {
		var mine []revealedOrder
		if p == "Austria" {
			mine = orders
		}
		if rec := commitAs(g, id, p, mine); rec.Code != http.StatusOK {
			t.Fatalf("%v could not lock: %v %v", p, rec.Code, rec.Body.String())
		}
	}
	revealAs(g, id, "Germany", nil)
	g.persist(id)

	games.mu.Lock()
	games.games = map[string]*game{}
	games.mu.Unlock()
	if err := loadAll(); err != nil {
		t.Fatalf("loadAll: %v", err)
	}
	restored, found := games.lookup(id)
	if !found {
		t.Fatal("the game did not come back")
	}
	if !restored.flow.sealed {
		t.Error("the game came back unsealed")
	}
	if got := restored.flow.seats["Austria"].sealed; got != g.flow.seats["Austria"].sealed {
		t.Errorf("Austria's envelope came back %q", got)
	}
	if !restored.flow.seats["Germany"].revealed {
		t.Error("Germany had revealed and came back as if it had not")
	}
	if restored.flow.seats["Austria"].revealed {
		t.Error("Austria came back revealed without ever having revealed")
	}
	// And the phone can still finish the job against the restored hash.
	if rec := revealAs(restored, id, "Austria", nil); rec.Code != http.StatusOK {
		t.Fatalf("Austria could not reveal after the restart: %v %v", rec.Code, rec.Body.String())
	}
}

/*
The recovery an envelope buys, and a digest could not (ADR-004, ADR-009).

A phone locks in and goes flat. Its envelope is on the server already. A second
device that holds the same seat seed derives the same key and sends it, and the
orders the dead phone wrote reach the board.

The derivation is the phone's side and lives in web/src/keys.ts, where
sealed.test.ts proves the two devices reach the same 32 bytes. What is checked
here is the server's side: it never knew which device sent the key, and it
opens the envelope for whichever one does.
*/
func TestASecondDeviceCanReleaseADeadPhonesOrders(t *testing.T) {
	g := sealedGame(t)
	orders := draft([]string{"bud", "Move", "ser"})
	for _, p := range g.flow.powers {
		var mine []revealedOrder
		if p == "Austria" {
			mine = orders
		}
		if rec := commitAs(g, "game", p, mine); rec.Code != http.StatusOK {
			t.Fatalf("%v could not lock: %v %v", p, rec.Code, rec.Body.String())
		}
	}

	// The phone dies here. Nothing about it is on the server, and nothing
	// about it needs to be: the envelope is, and the key is derivable.
	if rec := revealAs(g, "game", "Austria", seatKey("Austria")); rec.Code != http.StatusOK {
		t.Fatalf("the spare device could not release the orders: %v %v", rec.Code, rec.Body.String())
	}
	for _, p := range g.flow.powers {
		if p != "Austria" {
			revealAs(g, "game", p, nil)
		}
	}
	if _, _, ok := g.state.Unit(godip.Province("ser")); !ok {
		t.Error("the orders the dead phone wrote did not reach the board")
	}
	if len(g.previousPhase.NMR) != 0 {
		t.Errorf("NMR %v — the recovery should have prevented one", g.previousPhase.NMR)
	}
}

// The three addresses a sealed phase uses are wired to the handlers that
// answer them. A reveal that reached no route would leave every table stuck
// at the window with no message to say why.
func TestTheSealedRoutesAreWired(t *testing.T) {
	for _, name := range []string{"lock", "unlock", "reveal"} {
		if _, found := seatRoutes[name]; !found {
			t.Errorf("no seat route answers %q", name)
		}
	}
	g := sealedGame(t)
	for _, p := range g.flow.powers {
		commitAs(g, "game", p, nil)
	}
	body := fmt.Sprintf(`{"key":%q}`,
		base64.RawURLEncoding.EncodeToString(seatKey("Austria")))
	rec := httptest.NewRecorder()
	seatRoutes["reveal"](g, "game", "Austria", rec,
		httptest.NewRequest(http.MethodPost, "/", strings.NewReader(body)))
	if rec.Code != http.StatusOK {
		t.Fatalf("the routed reveal answered %v: %v", rec.Code, rec.Body.String())
	}
	if !g.flow.seats["Austria"].revealed {
		t.Error("the routed reveal did not take")
	}
}

// A key that is not 32 bytes is a bad request, not a failed unsealing: the
// two are different faults and the phone should be told which it has.
func TestAKeyMustBeThirtyTwoBytes(t *testing.T) {
	g := sealedGame(t)
	for _, p := range g.flow.powers {
		commitAs(g, "game", p, nil)
	}
	for _, bad := range []string{"", "short", "not base64url!!"} {
		body := fmt.Sprintf(`{"key":%q}`, bad)
		rec := httptest.NewRecorder()
		handleSeatReveal(g, "game", "Austria", rec,
			httptest.NewRequest(http.MethodPost, "/", strings.NewReader(body)))
		if rec.Code != http.StatusBadRequest {
			t.Errorf("key %q answered %v, want 400", bad, rec.Code)
		}
	}
	if g.flow.seats["Austria"].revealed {
		t.Error("a refused key marked the seat revealed")
	}
}

// A game written before commit-reveal existed keeps the path it was played
// on: migrating a game that is mid-phase at a table would lose the orders on
// the table (ADR-004, and ADR-049 for the same rule about seats).
func TestAGameFromBeforeThisKeepsItsServerSideDrafts(t *testing.T) {
	g := watchTestGame(t)
	g.flow.sealed = false

	rec := httptest.NewRecorder()
	handleSeatOrder(g, "game", "Austria", rec, httptest.NewRequest(http.MethodPost, "/",
		strings.NewReader(`{"province":"bud","parts":["Move","ser"]}`)))
	if rec.Code != http.StatusOK {
		t.Fatalf("an unsealed game refused an order: %v %v", rec.Code, rec.Body.String())
	}
	if len(g.parts) != 1 {
		t.Error("the order was not stored")
	}
	if g.flow.revealOpen() {
		t.Error("an unsealed game opened a reveal window")
	}
}

/*
The record a resolved phase leaves behind (ADR-058).

The orders are public once the phase resolves. What this adds is the envelope
they came out of and the seat's signature over it, so a table arguing
afterwards about what somebody committed has something to check rather than
this server's word for it.
*/
func TestAResolvedPhaseKeepsTheSignedEnvelope(t *testing.T) {
	g := sealedGame(t)
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	g.flow.seats["Austria"].signPub = base64.RawURLEncoding.EncodeToString(public)

	orders := draft([]string{"bud", "Move", "ser"})
	envelope, err := sealOrders("game", 0, "Austria", seatKey("Austria"), orders)
	if err != nil {
		t.Fatal(err)
	}
	sig := base64.RawURLEncoding.EncodeToString(
		ed25519.Sign(private, []byte(commitBody("game", 0, "Austria", envelope))))
	body := fmt.Sprintf(`{"sealed":%q,"sig":%q}`, envelope, sig)
	rec := httptest.NewRecorder()
	g.seatLock("game", "Austria", true, rec,
		httptest.NewRequest(http.MethodPost, "/", strings.NewReader(body)))
	if rec.Code != http.StatusOK {
		t.Fatalf("locking: %v %v", rec.Code, rec.Body.String())
	}

	// Nothing is kept until the phase is over: a commitment that can still be
	// withdrawn is not a record of anything.
	if len(g.flow.commitments) != 0 {
		t.Fatalf("a commitment was recorded before the reveal: %+v", g.flow.commitments)
	}
	for _, power := range g.flow.powers {
		if power != "Austria" {
			g.flow.seats[power].autoLocked = true
		}
	}
	if rec := revealAs(g, "game", "Austria", nil); rec.Code != http.StatusOK {
		t.Fatalf("revealing: %v %v", rec.Code, rec.Body.String())
	}

	kept := g.flow.commitments[0]["Austria"]
	if kept.Envelope != envelope || kept.Sig != sig {
		t.Fatalf("the record reads %+v", kept)
	}
	// And the signature really covers the envelope that was revealed, which
	// is the whole of what the record is for.
	if !ed25519.Verify(public, []byte(commitBody("game", 0, "Austria", kept.Envelope)),
		mustDecode(t, kept.Sig)) {
		t.Error("the kept signature does not cover the kept envelope")
	}
	// The phase's review carries it, so the record is on the page rather than
	// only in memory.
	if g.previousPhase == nil || g.previousPhase.Commitments["Austria"].Envelope != envelope {
		t.Errorf("the review carries %+v", g.previousPhase)
	}
	// Withdrawing a lock takes the signature with it, so nothing can reveal
	// against a commitment the seat abandoned.
	g.flow.seats["Austria"].sealed = "x"
	g.flow.seats["Austria"].sealedSig = "y"
	g.flow.clearCommits()
	if g.flow.seats["Austria"].sealedSig != "" {
		t.Error("a new phase kept the last one's signature")
	}
}

func mustDecode(t *testing.T, encoded string) []byte {
	t.Helper()
	raw, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}
