package main

import (
	"bytes"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"testing"

	"github.com/zond/godip"
)

// joinWithKey claims a power the way a phone does (ADR-049): it makes a key and
// sends the public half. It returns the private half and the answer.
func joinWithKey(t *testing.T, g *game, id string) (ed25519.PrivateKey, joinResponse, *httptest.ResponseRecorder) {
	t.Helper()
	public, private, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := json.Marshal(map[string]string{
		"signPub": base64.RawURLEncoding.EncodeToString(public),
	})
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/join", bytes.NewReader(body))
	handleJoin(g, id, g.flow.inviteToken, rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("join: got %v: %v", rec.Code, rec.Body.String())
	}
	var out joinResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	return private, out, rec
}

// sessionCookie is the cookie a recorder set, as a request header would carry
// it back.
func sessionCookie(t *testing.T, id string, rec *httptest.ResponseRecorder) *http.Cookie {
	t.Helper()
	for _, c := range rec.Result().Cookies() {
		if c.Name == seatSessionCookieName(id) {
			return c
		}
	}
	t.Fatal("no session cookie was set")
	return nil
}

func withCookie(r *http.Request, c *http.Cookie) *http.Request {
	r.AddCookie(&http.Cookie{Name: c.Name, Value: c.Value})
	return r
}

// TestAKeyedSeatStoresNoSecret is the claim this design earns: a copy of the
// database opens nothing. The seat row holds 32 public bytes and no token.
func TestAKeyedSeatStoresNoSecret(t *testing.T) {
	id := makeGame(t)
	g, found := games.lookup(id)
	if !found {
		t.Fatal("the created game is not in the registry")
	}
	_, answer, _ := joinWithKey(t, g, id)

	if !answer.Keyed {
		t.Error("the join did not report a keyed seat")
	}
	if answer.SeatURL != keyedSeatURL(httptest.NewRequest(http.MethodGet, "/", nil), id) {
		t.Errorf("seat address %v carries something it should not", answer.SeatURL)
	}
	var claimed *seat
	for _, s := range g.flow.seats {
		if s.signPub != "" {
			claimed = s
		}
	}
	if claimed == nil {
		t.Fatal("no seat was bound to a key")
	}
	if claimed.token != "" {
		t.Error("a keyed seat also holds a token")
	}
	if len(g.flow.bySeatToken) != 0 {
		t.Error("a token index entry survives a keyed claim")
	}
}

// TestSessionNeedsTheKey: the cookie is bought with a signature and with
// nothing else.
func TestSessionNeedsTheKey(t *testing.T) {
	id := makeGame(t)
	g, _ := games.lookup(id)
	private, _, _ := joinWithKey(t, g, id)

	rec := httptest.NewRecorder()
	handleSeatSession(g, id, rec, httptest.NewRequest(http.MethodGet, "/session", nil))
	var challenge struct {
		Nonce   string `json:"nonce"`
		Message string `json:"message"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &challenge); err != nil {
		t.Fatal(err)
	}

	public := private.Public().(ed25519.PublicKey)
	sign := func(key ed25519.PrivateKey, pub ed25519.PublicKey) *httptest.ResponseRecorder {
		body, _ := json.Marshal(map[string]string{
			"signPub":   base64.RawURLEncoding.EncodeToString(pub),
			"nonce":     challenge.Nonce,
			"signature": base64.RawURLEncoding.EncodeToString(ed25519.Sign(key, []byte(challenge.Message))),
		})
		out := httptest.NewRecorder()
		handleSeatSession(g, id, out, httptest.NewRequest(http.MethodPost, "/session", bytes.NewReader(body)))
		return out
	}

	strangerPub, strangerKey, _ := ed25519.GenerateKey(nil)
	if got := sign(strangerKey, strangerPub); got.Code != http.StatusForbidden {
		t.Errorf("a key that holds no seat got %v, want 403", got.Code)
	}
	// The right seat's public half, signed by the wrong key: the signature is
	// what is checked, never the claim about which key this is.
	if got := sign(strangerKey, public); got.Code != http.StatusForbidden {
		t.Errorf("a forged signature got %v, want 403", got.Code)
	}

	// The claim already opened one session, so signing in adds a second:
	// the same seat on a second device is the case this exists for.
	before := len(g.flow.sessions)
	opened := sign(private, public)
	if opened.Code != http.StatusOK {
		t.Fatalf("the seat's own key got %v: %v", opened.Code, opened.Body.String())
	}
	if len(g.flow.sessions) != before+1 {
		t.Errorf("%v sessions open, want %v", len(g.flow.sessions), before+1)
	}
}

// TestTheSessionCookieOpensTheSeat: `me` plus the cookie is the seat, and the
// same address without the cookie is a 404 like any other wrong address.
func TestTheSessionCookieOpensTheSeat(t *testing.T) {
	id := makeGame(t)
	g, _ := games.lookup(id)
	_, _, joined := joinWithKey(t, g, id)
	cookie := sessionCookie(t, id, joined)

	srv := &server{}
	path := apiPrefix + "/game/" + id + "/seat/me/state"

	rec := httptest.NewRecorder()
	srv.serveFlowAPI(rec, withCookie(httptest.NewRequest(http.MethodGet, path, nil), cookie), path)
	if rec.Code != http.StatusOK {
		t.Fatalf("with the cookie: got %v: %v", rec.Code, rec.Body.String())
	}

	rec = httptest.NewRecorder()
	srv.serveFlowAPI(rec, httptest.NewRequest(http.MethodGet, path, nil), path)
	if rec.Code != http.StatusNotFound {
		t.Errorf("without the cookie: got %v, want 404", rec.Code)
	}
}

// TestHandoverRekeysAndClosesTheSession: the phone taking the seat brings its
// own key, and everything the last one had stops working — the old key, and
// the session it was still holding.
func TestHandoverRekeysAndClosesTheSession(t *testing.T) {
	id := makeGame(t)
	g, _ := games.lookup(id)
	_, _, joined := joinWithKey(t, g, id)
	cookie := sessionCookie(t, id, joined)

	var power godip.Nation
	for p, s := range g.flow.seats {
		if s.signPub != "" {
			power = p
		}
	}
	oldPub := g.flow.seats[power].signPub
	epoch := g.flow.seats[power].epoch
	signature := handoverSig(id, power, epoch)

	nextPub, _, _ := ed25519.GenerateKey(nil)
	body, _ := json.Marshal(map[string]string{
		"signPub": base64.RawURLEncoding.EncodeToString(nextPub),
	})
	rec := httptest.NewRecorder()
	handleHandoverClaim(g, id, []string{string(power), strconv.Itoa(epoch), signature}, rec,
		httptest.NewRequest(http.MethodPost, "/handover", bytes.NewReader(body)))
	if rec.Code != http.StatusOK {
		t.Fatalf("handover: got %v: %v", rec.Code, rec.Body.String())
	}

	if g.flow.seats[power].signPub == oldPub {
		t.Error("the seat still answers to the key it was handed away from")
	}
	if _, alive := g.flow.bySignPub[oldPub]; alive {
		t.Error("the old key is still indexed")
	}
	if _, alive := g.flow.sessions[cookie.Value]; alive {
		t.Error("the old holder's session survived the handover")
	}
	if g.flow.seats[power].epoch != epoch+1 {
		t.Errorf("epoch %v, want %v", g.flow.seats[power].epoch, epoch+1)
	}
}

// TestAnOldGameKeepsItsTokens: no migration (ADR-049). A claim that sends no
// key is answered with a token, and that seat's address still opens it.
func TestAnOldGameKeepsItsTokens(t *testing.T) {
	id := makeGame(t)
	g, _ := games.lookup(id)

	rec := httptest.NewRecorder()
	handleJoin(g, id, g.flow.inviteToken, rec,
		httptest.NewRequest(http.MethodPost, "/join", bytes.NewReader([]byte("{}"))))
	if rec.Code != http.StatusOK {
		t.Fatalf("join: got %v: %v", rec.Code, rec.Body.String())
	}
	var answer joinResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &answer); err != nil {
		t.Fatal(err)
	}
	if answer.Keyed {
		t.Error("a claim with no key was answered as a keyed seat")
	}
	if len(g.flow.bySeatToken) != 1 {
		t.Fatalf("%v seat tokens, want 1", len(g.flow.bySeatToken))
	}
}

/*
TestTheSeatPageOpensWithoutASession is the lockout ADR-049 nearly shipped.

Sessions live in the server's memory, so a restart, a second device or a
private tab arrives with no cookie. The thing that signs back in is the
JavaScript on the seat page itself, using the seed the device already holds —
so refusing that page makes the only way back into a seat a page the seat
cannot open.
*/
func TestTheSeatPageOpensWithoutASession(t *testing.T) {
	id := makeGame(t)
	g, _ := games.lookup(id)
	joinWithKey(t, g, id)

	// Every session gone, as a restart leaves it.
	g.flow.sessions = map[string]godip.Nation{}

	// Through the real front doors, so this covers the routing and not one
	// handler: the page is on the bare surface, its actions are transport.
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "index.html"), []byte("<html></html>"), 0o644); err != nil {
		t.Fatal(err)
	}
	srv := &server{spaDir: dir}

	rec := httptest.NewRecorder()
	srv.serveFlow(rec, httptest.NewRequest(http.MethodGet, "/game/"+id+"/seat/me/", nil))
	if rec.Code == http.StatusNotFound {
		t.Fatal("the seat page is a 404 without a session, so nothing can sign back in")
	}

	// The page, and only the page. Everything it goes on to ask for still
	// needs a device that can sign for the seat.
	rec = httptest.NewRecorder()
	path := apiPrefix + "/game/" + id + "/seat/me/state"
	srv.serveFlowAPI(rec, httptest.NewRequest(http.MethodGet, path, nil), path)
	if rec.Code != http.StatusNotFound {
		t.Errorf("the seat state answered %v without a session, want 404", rec.Code)
	}
}
