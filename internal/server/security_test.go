package server

import (
	"bytes"
	"crypto/ed25519"
	"crypto/tls"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"sync"
	"testing"
	"time"
)

func enrollmentBody(t *testing.T, id, purpose string, private ed25519.PrivateKey) map[string]string {
	t.Helper()
	nonce, err := nonceFor(id, purpose)
	if err != nil {
		t.Fatal(err)
	}
	return map[string]string{
		"signPub":   base64.RawURLEncoding.EncodeToString(private.Public().(ed25519.PublicKey)),
		"nonce":     nonce,
		"signature": base64.RawURLEncoding.EncodeToString(ed25519.Sign(private, []byte(enrollmentMessage(id, purpose, nonce)))),
	}
}

func TestDuplicateKeyCannotChangeSeats(t *testing.T) {
	id := makeGame(t)
	g, _ := games.lookup(id)
	private, _, joined := joinWithKey(t, g, id)
	pub := base64.RawURLEncoding.EncodeToString(private.Public().(ed25519.PublicKey))
	original := g.flow.bySignPub[pub]
	sessions := len(g.flow.sessions)
	data, _ := json.Marshal(enrollmentBody(t, id, "join", private))
	rec := httptest.NewRecorder()
	handleJoin(g, id, g.flow.inviteToken, rec, httptest.NewRequest("POST", "/join", bytes.NewReader(data)))
	if rec.Code != http.StatusConflict {
		t.Fatalf("duplicate join: %d %s", rec.Code, rec.Body.String())
	}
	if g.flow.bySignPub[pub] != original || len(g.flow.sessions) != sessions {
		t.Fatal("duplicate changed identity or sessions")
	}
	// A different power cannot be handed to this already-enrolled key either.
	_, _, other := joinWithKey(t, g, id)
	otherCookie := sessionCookie(t, id, other)
	otherPower, _ := g.flow.sessionPower(id, withCookie(httptest.NewRequest("GET", "/", nil), otherCookie))
	seat := g.flow.seats[otherPower]
	epoch := seat.epoch
	before := seat.signPub
	data, _ = json.Marshal(enrollmentBody(t, id, handoverPurpose(string(otherPower), epoch), private))
	rec = httptest.NewRecorder()
	handleHandoverClaim(g, id, []string{string(otherPower), strconv.Itoa(epoch), handoverSig(id, otherPower, epoch)}, rec, httptest.NewRequest("POST", "/handover", bytes.NewReader(data)))
	if rec.Code != http.StatusConflict || seat.epoch != epoch || seat.signPub != before {
		t.Fatal("duplicate handover changed seat")
	}
	for _, c := range []*http.Cookie{sessionCookie(t, id, joined), otherCookie} {
		if _, ok := g.flow.sessionPower(id, withCookie(httptest.NewRequest("GET", "/", nil), c)); !ok {
			t.Fatal("rejected handover revoked a session")
		}
	}
}

func TestRecoveryChallengeSingleUseAndEpoch(t *testing.T) {
	id := makeGame(t)
	g, _ := games.lookup(id)
	key := registerKey(t, g, id)
	nonce, message := challenge(t, g, id)
	stale, staleMessage := challenge(t, g, id)
	// A bad signature must not consume a legitimate challenge.
	_, wrong, _ := ed25519.GenerateKey(nil)
	if rec := claimRecovery(g, id, nonce, ed25519.Sign(wrong, []byte(message))); rec.Code != 403 {
		t.Fatal(rec.Code)
	}
	sig := ed25519.Sign(key, []byte(message))
	codes := make(chan int, 2)
	var wg sync.WaitGroup
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); codes <- claimRecovery(g, id, nonce, sig).Code }()
	}
	wg.Wait()
	close(codes)
	ok := 0
	for code := range codes {
		if code == 200 {
			ok++
		} else if code != 403 {
			t.Fatal(code)
		}
	}
	if ok != 1 {
		t.Fatalf("%d concurrent successes", ok)
	}
	if rec := claimRecovery(g, id, stale, ed25519.Sign(key, []byte(staleMessage))); rec.Code != 403 {
		t.Fatal("previous role epoch accepted")
	}
	fresh, msg := challenge(t, g, id)
	if rec := claimRecovery(g, id, fresh, ed25519.Sign(key, []byte(msg))); rec.Code != 200 {
		t.Fatal("cannot retry with a fresh challenge")
	}
}

func TestSeatSessionLifetimeAndCap(t *testing.T) {
	id := makeGame(t)
	g, _ := games.lookup(id)
	_, _, joined := joinWithKey(t, g, id)
	cookie := sessionCookie(t, id, joined)
	power := g.flow.sessions[cookie.Value].power
	for i := 0; i < maxSeatSessions*4; i++ {
		if _, err := g.flow.openSession(power); err != nil {
			t.Fatal(err)
		}
	}
	if len(g.flow.sessions) != maxSeatSessions {
		t.Fatalf("session count %d", len(g.flow.sessions))
	}
	if _, ok := g.flow.sessions[cookie.Value]; ok {
		t.Fatal("oldest session survived cap")
	}
	token, _ := g.flow.openSession(power)
	g.flow.sessions[token] = seatSession{power: power, expires: time.Now().Add(-time.Second)}
	req := httptest.NewRequest("GET", "/", nil)
	req.AddCookie(&http.Cookie{Name: seatSessionCookieName(id), Value: token})
	if _, ok := g.flow.sessionPower(id, req); ok {
		t.Fatal("expired session accepted")
	}
}

func TestCookieTransportPolicy(t *testing.T) {
	oldBase, oldProxies := baseURLFixed, trustedProxies
	t.Cleanup(func() { baseURLFixed, trustedProxies = oldBase, oldProxies })
	trustedProxies, _ = parseTrustedProxies("127.0.0.1")
	for _, tc := range []struct {
		name, base, remote, proto string
		tls, want                 bool
	}{
		{"LAN", "", "192.0.2.1:20", "", false, false},
		{"forged proxy", "", "192.0.2.1:20", "https", false, false},
		{"proxy TLS", "", "127.0.0.1:20", "https", false, true},
		{"last proxy hop", "", "127.0.0.1:20", "https, http", false, false},
		{"pinned TLS", "https://table.example", "127.0.0.1:20", "", false, true},
		{"explicit HTTP", "http://table.local", "127.0.0.1:20", "https", false, false},
		{"direct TLS", "", "192.0.2.1:20", "", true, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			baseURLFixed = tc.base
			r := httptest.NewRequest("GET", "/", nil)
			r.RemoteAddr = tc.remote
			r.Header.Set("X-Forwarded-Proto", tc.proto)
			if tc.tls {
				r.TLS = &tls.ConnectionState{}
			}
			w := httptest.NewRecorder()
			setSessionCookie(w, r, "game", "secret")
			setAdminCookie(w, r, "secret")
			clearAdminCookie(w, r)
			for _, c := range w.Result().Cookies() {
				if c.Secure != tc.want {
					t.Errorf("%s Secure=%v", c.Name, c.Secure)
				}
			}
		})
	}
}

func TestEnrollmentRequiresPossession(t *testing.T) {
	id := makeGame(t)
	g, _ := games.lookup(id)
	_, key, _ := ed25519.GenerateKey(nil)
	proof := enrollmentBody(t, id, "join", key)
	valid := proof["signature"]
	proof["signature"] = "invalid"
	post := func() *httptest.ResponseRecorder {
		body, _ := json.Marshal(proof)
		w := httptest.NewRecorder()
		handleJoin(g, id, g.flow.inviteToken, w, httptest.NewRequest("POST", "/join", bytes.NewReader(body)))
		return w
	}
	if w := post(); w.Code != 403 {
		t.Fatalf("no possession: %d", w.Code)
	}
	if len(g.flow.bySignPub) != 0 || len(g.flow.sessions) != 0 || len(g.flow.byDevice) != 0 {
		t.Fatal("failed proof mutated state")
	}
	proof["signature"] = valid
	if w := post(); w.Code != 200 {
		t.Fatalf("valid proof after bad one: %d %s", w.Code, w.Body.String())
	}
}

func TestSessionProofCannotBeReplayed(t *testing.T) {
	id := makeGame(t)
	g, _ := games.lookup(id)
	key, _, _ := joinWithKey(t, g, id)
	nonce, _ := nonceFor(id, "session")
	body, _ := json.Marshal(map[string]string{"nonce": nonce, "signPub": base64.RawURLEncoding.EncodeToString(key.Public().(ed25519.PublicKey)), "signature": base64.RawURLEncoding.EncodeToString(ed25519.Sign(key, []byte(sessionMessage(id, nonce))))})
	for i, want := range []int{200, 403} {
		w := httptest.NewRecorder()
		handleSeatSession(g, id, w, httptest.NewRequest("POST", "/session", bytes.NewReader(body)))
		if w.Code != want {
			t.Fatalf("request %d: %d", i, w.Code)
		}
	}
}

func TestChallengeStorageIsBoundedAndAnonymousIssuanceIsStateless(t *testing.T) {
	challenges.Lock()
	saved := challenges.used
	challenges.used = map[string]map[[32]byte]usedChallenge{}
	challenges.Unlock()
	t.Cleanup(func() { challenges.Lock(); challenges.used = saved; challenges.Unlock() })
	for i := 0; i < maxGameChallenges+10; i++ {
		if _, err := nonceFor("limits", "session"); err != nil {
			t.Fatal(err)
		}
	}
	if len(challenges.used) != 0 {
		t.Fatal("anonymous requests allocated records")
	}
	// One key may not fill the game: it gets its own share and then stops.
	for i := 0; i < maxKeyChallenges; i++ {
		nonce, err := nonceFor("limits", "session")
		if err != nil || !consumeNonce("limits", "session", nonce, "key-0") {
			t.Fatalf("consume %d: %v", i, err)
		}
	}
	nonce, _ := nonceFor("limits", "session")
	if consumeNonce("limits", "session", nonce, "key-0") {
		t.Fatal("one key exceeded its share")
	}
	if !consumeNonce("limits", "session", nonce, "key-1") {
		t.Fatal("a full key blocked another key")
	}
	for i := 1; len(challenges.used["limits"]) < maxGameChallenges; i++ {
		nonce, err := nonceFor("limits", "session")
		if err != nil || !consumeNonce("limits", "session", nonce, fmt.Sprintf("key-%d", i/maxKeyChallenges+1)) {
			t.Fatalf("fill %d: %v", i, err)
		}
	}
	if _, err := nonceFor("limits", "session"); err == nil {
		t.Fatal("issuance ignored capacity")
	}
	if _, err := nonceFor("other-game", "session"); err != nil {
		t.Fatal("per-game limit affected another game")
	}
	for key, record := range challenges.used["limits"] {
		record.expires = time.Now().Add(-time.Second)
		challenges.used["limits"][key] = record
	}
	if _, err := nonceFor("limits", "session"); err != nil {
		t.Fatal("expired hashes were not pruned")
	}
	if len(challenges.used) != 0 {
		t.Fatal("an emptied game kept its bucket")
	}
}

func TestConcurrentEnrollmentCannotShareAKey(t *testing.T) {
	id := makeGame(t)
	g, _ := games.lookup(id)
	_, key, _ := ed25519.GenerateKey(nil)
	bodies := make([][]byte, 2)
	for i := range bodies {
		bodies[i], _ = json.Marshal(enrollmentBody(t, id, "join", key))
	}
	codes := make(chan int, 2)
	var wg sync.WaitGroup
	for _, body := range bodies {
		wg.Add(1)
		go func(body []byte) {
			defer wg.Done()
			w := httptest.NewRecorder()
			handleJoin(g, id, g.flow.inviteToken, w, httptest.NewRequest("POST", "/join", bytes.NewReader(body)))
			codes <- w.Code
		}(body)
	}
	wg.Wait()
	close(codes)
	success := 0
	for code := range codes {
		if code == 200 {
			success++
		} else if code != 409 {
			t.Fatal(code)
		}
	}
	if success != 1 || len(g.flow.bySignPub) != 1 || len(g.flow.sessions) != 1 {
		t.Fatal("concurrent claims changed multiple seats")
	}
}

func TestSigningKeysMustHaveOneEncoding(t *testing.T) {
	pub, _, _ := ed25519.GenerateKey(nil)
	canonical := base64.RawURLEncoding.EncodeToString(pub)
	if !checkSignPub(canonical) {
		t.Fatal("canonical key rejected")
	}
	for _, alias := range []string{canonical + "\n", canonical[:10] + "\r\n" + canonical[10:], canonical + "="} {
		if checkSignPub(alias) {
			t.Fatal("alternate encoding bypasses uniqueness")
		}
	}
}

func TestPrivateAPIResponsesAreNotCacheable(t *testing.T) {
	srv := testServer(t)
	for _, path := range []string{"/api/v1/build", "/api/v1/admin/me", "/api/v1/game/missing/session"} {
		w := httptest.NewRecorder()
		srv.serveAPI(w, httptest.NewRequest("GET", path, nil))
		if w.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("cacheable %s", path)
		}
	}
}

func TestHTTPSJoinAndCreationCookiesAreSecure(t *testing.T) {
	saved := baseURLFixed
	baseURLFixed = "https://table.example"
	t.Cleanup(func() { baseURLFixed = saved })
	w := httptest.NewRecorder()
	handleCreateGame(w, httptest.NewRequest("POST", "/api/v1/games", bytes.NewBufferString("{}")))
	if w.Code != 200 {
		t.Fatal(w.Code)
	}
	var made createResponse
	if err := json.Unmarshal(w.Body.Bytes(), &made); err != nil {
		t.Fatal(err)
	}
	for _, cookie := range w.Result().Cookies() {
		if !cookie.Secure {
			t.Fatal("insecure referee cookie")
		}
	}
	g, _ := games.lookup(made.GameID)
	_, _, joined := joinWithKey(t, g, made.GameID)
	for _, cookie := range joined.Result().Cookies() {
		if !cookie.Secure {
			t.Fatalf("insecure %s", cookie.Name)
		}
	}
}
