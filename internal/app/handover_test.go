package app

import (
	"crypto/ed25519"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
)

// claimPath is the address a handover QR code's button posts to.
func claimPath(id string, power string, epoch int, sig string) string {
	return "/game/" + id + "/handover/" + power + "/" + strconv.Itoa(epoch) + "/" + sig
}

// TestHandoverMovesTheSeatAndKillsTheOldToken: the whole point of ADR-041. The
// new phone gets a working seat and the old one is not merely stale, it is
// gone from the index.
func TestHandoverMovesTheSeatAndKillsTheOldToken(t *testing.T) {
	id := makeGame(t)
	g, found := games.lookup(id)
	if !found {
		t.Fatal("the created game is not in the registry")
	}

	power := g.flow.powers[0]
	seat := g.flow.seats[power]
	seat.token = "old-token"
	seat.device = "old-device"
	g.flow.bySeatToken["old-token"] = power
	g.flow.byDevice["old-device"] = power
	_, _, revoked, unsubscribe, ok := g.events.subscribe(eventAudienceSeat, power)
	if !ok {
		t.Fatal("could not subscribe the old seat view")
	}
	defer unsubscribe()

	epoch := seat.epoch
	sig := handoverSig(id, power, epoch)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, claimPath(id, string(power), epoch, sig), nil)
	handleHandoverClaim(g, id, []string{string(power), strconv.Itoa(epoch), sig}, rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("claim: got %v: %v", rec.Code, rec.Body.String())
	}

	var taken struct {
		Power   string `json:"power"`
		SeatURL string `json:"seatUrl"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &taken); err != nil {
		t.Fatal(err)
	}
	if taken.Power != string(power) {
		t.Errorf("claim answered for %v, want %v", taken.Power, power)
	}

	if _, alive := g.flow.bySeatToken["old-token"]; alive {
		t.Error("the previous holder's token still opens the seat")
	}
	if _, alive := g.flow.byDevice["old-device"]; alive {
		t.Error("the previous holder's device still holds the seat")
	}
	if g.flow.seats[power].epoch != epoch+1 {
		t.Errorf("epoch %v, want %v", g.flow.seats[power].epoch, epoch+1)
	}
	if !strings.Contains(taken.SeatURL, g.flow.seats[power].token) {
		t.Error("the new seat address does not carry the new token")
	}
	if _, ok := g.flow.bySeatToken[g.flow.seats[power].token]; !ok {
		t.Error("the new token does not open the seat")
	}
	select {
	case <-revoked:
	default:
		t.Error("the previous holder's live connection was not revoked")
	}
}

// TestHandoverLinkWorksOnce: a link is signed for one epoch, so using it moves
// the seat past every link that was minted for it, including itself.
func TestHandoverLinkWorksOnce(t *testing.T) {
	id := makeGame(t)
	g, _ := games.lookup(id)
	power := g.flow.powers[0]
	epoch := g.flow.seats[power].epoch
	sig := handoverSig(id, power, epoch)
	parts := []string{string(power), strconv.Itoa(epoch), sig}

	first := httptest.NewRecorder()
	handleHandoverClaim(g, id, parts, first,
		httptest.NewRequest(http.MethodPost, claimPath(id, string(power), epoch, sig), nil))
	if first.Code != http.StatusOK {
		t.Fatalf("first claim: got %v", first.Code)
	}

	second := httptest.NewRecorder()
	handleHandoverClaim(g, id, parts, second,
		httptest.NewRequest(http.MethodPost, claimPath(id, string(power), epoch, sig), nil))
	if second.Code != http.StatusConflict {
		t.Errorf("second claim: got %v, want a refusal", second.Code)
	}
}

// TestHandoverRefusesAForgedSignature: the salt is the whole of the security,
// so a made-up signature must not be told apart from an address that is not
// there at all.
func TestHandoverRefusesAForgedSignature(t *testing.T) {
	id := makeGame(t)
	g, _ := games.lookup(id)
	power := g.flow.powers[0]
	epoch := g.flow.seats[power].epoch
	token := g.flow.seats[power].token

	rec := httptest.NewRecorder()
	handleHandoverClaim(g, id, []string{string(power), strconv.Itoa(epoch), "not-a-signature"}, rec,
		httptest.NewRequest(http.MethodPost, claimPath(id, string(power), epoch, "x"), nil))
	if rec.Code != http.StatusNotFound {
		t.Errorf("forged signature: got %v, want 404", rec.Code)
	}
	if g.flow.seats[power].epoch != epoch || g.flow.seats[power].token != token {
		t.Error("a forged signature moved the seat")
	}
}

// TestHandoverRefusesAGet: the signature is the whole credential, so a link
// preview or a scanner that fetches before it shows must not take the seat.
func TestHandoverRefusesAGet(t *testing.T) {
	id := makeGame(t)
	g, _ := games.lookup(id)
	power := g.flow.powers[0]
	epoch := g.flow.seats[power].epoch
	sig := handoverSig(id, power, epoch)

	rec := httptest.NewRecorder()
	handleHandoverClaim(g, id, []string{string(power), strconv.Itoa(epoch), sig}, rec,
		httptest.NewRequest(http.MethodGet, claimPath(id, string(power), epoch, sig), nil))
	if rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("GET: got %v, want a refusal", rec.Code)
	}
	if g.flow.seats[power].epoch != epoch {
		t.Error("a GET moved the seat")
	}
}

// TestGMMintsForAnyPowerAndLogsIt: the case this exists for is a phone that
// cannot open its own menu, and the act is enumerated and logged (ADR-007).
func TestGMMintsForAnyPowerAndLogsIt(t *testing.T) {
	id := makeGame(t)
	g, _ := games.lookup(id)
	power := g.flow.powers[1]
	before := len(g.flow.events)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/game/"+id+"/gm/tok/handover?power="+string(power), nil)
	handleGMHandover(g, id, rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("mint: got %v: %v", rec.Code, rec.Body.String())
	}

	var minted handoverJSON
	if err := json.Unmarshal(rec.Body.Bytes(), &minted); err != nil {
		t.Fatal(err)
	}
	if minted.Power != string(power) {
		t.Errorf("minted for %v, want %v", minted.Power, power)
	}
	if !strings.Contains(minted.URL, handoverSig(id, power, g.flow.seats[power].epoch)) {
		t.Error("the minted link does not carry this seat's signature")
	}
	if len(g.flow.events) == before {
		t.Error("minting a handover link was not logged (ADR-007)")
	}
}

// TestGMRoleHandoverRotatesTheTokenAndTheRefereeDoor: the role travels and a
// power does not, and both doors into the old game master's screen close.
func TestGMRoleHandoverRotatesTheTokenAndTheRefereeDoor(t *testing.T) {
	id := makeGame(t)
	g, _ := games.lookup(id)
	oldRecoveryKey := registerKey(t, g, id)
	before, device, epoch := g.flow.gmToken, g.flow.gmDevice, g.flow.gmEpoch
	if device == "" {
		t.Fatal("the created game has no referee cookie secret to lose")
	}
	power := g.flow.gmPower
	sig := gmHandoverSig(id, epoch)
	_, _, revoked, unsubscribe, ok := g.events.subscribe(eventAudienceGM, "")
	if !ok {
		t.Fatal("could not subscribe the old game master view")
	}
	defer unsubscribe()

	rec := httptest.NewRecorder()
	handleGMRoleClaim(g, id, []string{strconv.Itoa(epoch), sig}, rec,
		httptest.NewRequest(http.MethodPost, "/game/"+id+"/handover-gm/0/"+sig, nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("claim: got %v: %v", rec.Code, rec.Body.String())
	}

	if g.flow.gmToken == before {
		t.Error("the previous game master's token still runs the game")
	}
	if g.flow.gmDevice != "" {
		t.Error("the referee cookie still opens the game master view")
	}
	if g.flow.gmEpoch != epoch+1 {
		t.Errorf("gm epoch %v, want %v", g.flow.gmEpoch, epoch+1)
	}
	if g.flow.gmPublicKey != "" {
		t.Error("the former game master's recovery key survived the handover")
	}
	if g.flow.gmPower != power {
		t.Error("handing over the role moved a power with it")
	}
	select {
	case <-revoked:
	default:
		t.Error("the previous game master's live connection was not revoked")
	}

	replay := httptest.NewRecorder()
	handleGMRoleClaim(g, id, []string{strconv.Itoa(epoch), sig}, replay,
		httptest.NewRequest(http.MethodPost, "/game/"+id+"/handover-gm/0/"+sig, nil))
	if replay.Code != http.StatusConflict {
		t.Errorf("replayed role link: got %v, want a refusal", replay.Code)
	}

	// The twelve words are another door into the role. Once their public half
	// is retired, the former game master cannot even obtain a challenge.
	recover := httptest.NewRecorder()
	handleRecover(g, id, recover, httptest.NewRequest(http.MethodGet, "/recover", nil))
	if recover.Code != http.StatusNotFound {
		t.Errorf("old recovery door: got %v, want 404", recover.Code)
	}

	// The incoming holder can establish recovery again, under a new key. The
	// former words remain invalid after that new door exists.
	registerKey(t, g, id)
	nonce, message := challenge(t, g, id)
	oldClaim := claimRecovery(g, id, nonce,
		ed25519.Sign(oldRecoveryKey, []byte(message)))
	if oldClaim.Code != http.StatusForbidden {
		t.Errorf("former recovery key after re-enrolment: got %v, want 403", oldClaim.Code)
	}
}
