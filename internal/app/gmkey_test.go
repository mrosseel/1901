package app

import (
	"bytes"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// registerKey gives a game a public half and returns the private one, the way
// a game master's browser does: it makes the pair and sends 32 bytes.
func registerKey(t *testing.T, g *game, id string) ed25519.PrivateKey {
	t.Helper()
	public, private, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	body, err := json.Marshal(gmKeyJSON{
		PublicKey: base64.RawURLEncoding.EncodeToString(public),
	})
	if err != nil {
		t.Fatal(err)
	}
	rec := httptest.NewRecorder()
	handleGMKey(g, id, rec, httptest.NewRequest(http.MethodPost, "/key", bytes.NewReader(body)))
	if rec.Code != http.StatusOK {
		t.Fatalf("register: got %v: %v", rec.Code, rec.Body.String())
	}
	return private
}

// challenge asks for something to sign.
func challenge(t *testing.T, g *game, id string) (nonce, message string) {
	t.Helper()
	rec := httptest.NewRecorder()
	handleRecover(g, id, rec, httptest.NewRequest(http.MethodGet, "/recover", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("challenge: got %v: %v", rec.Code, rec.Body.String())
	}
	var out struct {
		Nonce   string `json:"nonce"`
		Message string `json:"message"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	return out.Nonce, out.Message
}

func claimRecovery(g *game, id, nonce string, signature []byte) *httptest.ResponseRecorder {
	body, _ := json.Marshal(map[string]string{
		"nonce":     nonce,
		"signature": base64.RawURLEncoding.EncodeToString(signature),
	})
	rec := httptest.NewRecorder()
	handleRecover(g, id, rec, httptest.NewRequest(http.MethodPost, "/recover", bytes.NewReader(body)))
	return rec
}

// TestRecoveryTakesTheRoleAndKillsTheOldToken is the whole of ADR-048: twelve
// words on any device buy a fresh game master address, and the one the last
// device held stops working.
func TestRecoveryTakesTheRoleAndKillsTheOldToken(t *testing.T) {
	id := makeGame(t)
	g, found := games.lookup(id)
	if !found {
		t.Fatal("the created game is not in the registry")
	}
	private := registerKey(t, g, id)

	g.flow.gmDevice = "the-lost-laptop"
	before := g.flow.gmToken
	epoch := g.flow.gmEpoch
	_, _, revoked, unsubscribe, ok := g.events.subscribe(eventAudienceGM, "")
	if !ok {
		t.Fatal("could not subscribe the lost game master view")
	}
	defer unsubscribe()

	nonce, message := challenge(t, g, id)
	rec := claimRecovery(g, id, nonce, ed25519.Sign(private, []byte(message)))
	if rec.Code != http.StatusOK {
		t.Fatalf("recover: got %v: %v", rec.Code, rec.Body.String())
	}
	var taken struct {
		GMURL string `json:"gmUrl"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &taken); err != nil {
		t.Fatal(err)
	}

	if g.flow.gmToken == before {
		t.Error("the game master token did not change")
	}
	if !strings.Contains(taken.GMURL, g.flow.gmToken) {
		t.Error("the answer does not carry the new token")
	}
	if g.flow.gmDevice != "" {
		t.Error("the referee cookie still opens the game master door")
	}
	if g.flow.gmEpoch != epoch+1 {
		t.Errorf("role epoch %v, want %v", g.flow.gmEpoch, epoch+1)
	}
	select {
	case <-revoked:
	default:
		t.Error("the lost game master's live connection was not revoked")
	}
}

// TestRecoveryRefusesAnotherKey: a signature from a key this game never
// registered opens nothing, and the role stays where it was.
func TestRecoveryRefusesAnotherKey(t *testing.T) {
	id := makeGame(t)
	g, _ := games.lookup(id)
	registerKey(t, g, id)

	_, stranger, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	before := g.flow.gmToken

	nonce, message := challenge(t, g, id)
	rec := claimRecovery(g, id, nonce, ed25519.Sign(stranger, []byte(message)))
	if rec.Code != http.StatusForbidden {
		t.Fatalf("got %v, want 403: %v", rec.Code, rec.Body.String())
	}
	if g.flow.gmToken != before {
		t.Error("a refused recovery still rotated the token")
	}
}

// TestRecoveryRefusesAForgedChallenge: the nonce is signed by the server, so
// one the server never minted is not something to sign against.
func TestRecoveryRefusesAForgedChallenge(t *testing.T) {
	id := makeGame(t)
	g, _ := games.lookup(id)
	private := registerKey(t, g, id)

	forged := "not-a-nonce.9999999999.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	signature := ed25519.Sign(private, []byte(recoverMessage(id, forged)))
	rec := claimRecovery(g, id, forged, signature)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("got %v, want 403: %v", rec.Code, rec.Body.String())
	}
}

// TestChallengeIsRefusedWithoutAKey: a game whose game master never made one
// has no recovery, and the address says so rather than inventing a challenge.
func TestChallengeIsRefusedWithoutAKey(t *testing.T) {
	id := makeGame(t)
	g, _ := games.lookup(id)

	rec := httptest.NewRecorder()
	handleRecover(g, id, rec, httptest.NewRequest(http.MethodGet, "/recover", nil))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("got %v, want 404: %v", rec.Code, rec.Body.String())
	}
}

// TestKeyIsWriteOnce: the game master token is not the credential the key
// protects. Somebody holding a stolen token must not be able to replace the
// key and lock the real game master out of their own recovery.
func TestKeyIsWriteOnce(t *testing.T) {
	id := makeGame(t)
	g, _ := games.lookup(id)
	registerKey(t, g, id)
	first := g.flow.gmPublicKey

	other, _, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := json.Marshal(gmKeyJSON{PublicKey: base64.RawURLEncoding.EncodeToString(other)})
	rec := httptest.NewRecorder()
	handleGMKey(g, id, rec, httptest.NewRequest(http.MethodPost, "/key", bytes.NewReader(body)))
	if rec.Code != http.StatusConflict {
		t.Fatalf("got %v, want 409: %v", rec.Code, rec.Body.String())
	}
	if g.flow.gmPublicKey != first {
		t.Error("the second key replaced the first")
	}
}
