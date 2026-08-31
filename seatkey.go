/*
A seat is a key, not a token (ADR-049).

Until now a seat was a secret in an address: whoever read /game/{id}/seat/{tok}
was that power, and the same string sat in the database. So a copied 1901.db, a
laptop backup or a server kept after the tournament was a set of working seats.

Now the joining phone makes 32 random bytes, derives an Ed25519 key from them,
and sends the public half. The server stores 32 public bytes and can open
nothing with them. The seed stays on the phone and travels only in a URL
fragment, which a browser never puts in a request.

	GET  /game/{id}/session   a nonce to sign
	POST /game/{id}/session   the signature, for a session cookie

Access and authorship are two different jobs and this file is only the first.
Signing every request would be slow and would buy little: a session cookie is
enough to read the board and write a draft, and it is HttpOnly, so a stolen one
reads a screen and dies with the phase's handover. The signature that will
matter is the one over a sealed order, and that is not built.

Old games keep their tokens. A seat row has either a token or a public key,
both paths are authorized, and no game is migrated: a game lasts an evening, so
the token path can be deleted when the last game that uses it is over.
*/
package main

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"net/http"

	"github.com/zond/godip"
)

// seatSessionCookieName is one session per game, so one phone can hold seats
// at two tables. It is scoped to the game's own path: nothing outside
// /game/{id}/ has any use for it.
func seatSessionCookieName(id string) string {
	return "s1901_" + id
}

// keyedSeatURL is the address of a seat that has a key. There is no token in
// it: the phone proves who it is with a signature and carries the seat's seed
// in the fragment, which never leaves the browser.
func keyedSeatURL(r *http.Request, id string) string {
	return baseURL(r) + "/game/" + id + "/seat/me/"
}

// sessionMessage is what a phone signs to open a session. The game id is in
// it, so a signature made at one table cannot be replayed at another, and the
// purpose is in it, so nothing else this key signs can be replayed here.
func sessionMessage(id, nonce string) string {
	return "1901 seat session|" + id + "|" + nonce
}

// checkSignPub says whether these 32 bytes are a public key at all. Anything
// else is refused before it reaches a seat.
func checkSignPub(encoded string) bool {
	raw, err := base64.RawURLEncoding.DecodeString(encoded)
	return err == nil && len(raw) == ed25519.PublicKeySize
}

// bindSeatKey gives a seat its public half and indexes it. The caller must
// hold the game lock. A seat that had a token loses it: the two paths are
// alternatives, and leaving the old string alive would leave the old address
// working.
func (f *flow) bindSeatKey(s *seat, signPub string) {
	if s.token != "" {
		delete(f.bySeatToken, s.token)
		s.token = ""
	}
	if s.signPub != "" {
		delete(f.bySignPub, s.signPub)
	}
	s.signPub = signPub
	f.bySignPub[signPub] = s.power
}

// dropSessions ends every session open on one power. A handover, and later a
// recovery, must not leave the last phone reading the board.
func (f *flow) dropSessions(power godip.Nation) {
	for token, held := range f.sessions {
		if held == power {
			delete(f.sessions, token)
		}
	}
}

// openSession mints a session for a power and returns the cookie value. The
// caller must hold the game lock.
func (f *flow) openSession(power godip.Nation) (string, error) {
	token, err := newToken()
	if err != nil {
		return "", err
	}
	f.sessions[token] = power
	return token, nil
}

// setSessionCookie is the one place the cookie is written, so its scope and
// flags cannot drift between the join, the handover and the session route.
func setSessionCookie(w http.ResponseWriter, id, token string) {
	http.SetCookie(w, &http.Cookie{
		Name:     seatSessionCookieName(id),
		Value:    token,
		Path:     "/game/" + id + "/",
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   60 * 60 * 24 * 7,
	})
}

// sessionPower reads the cookie and says which power this request is. The
// caller must hold the game lock.
func (f *flow) sessionPower(id string, r *http.Request) (godip.Nation, bool) {
	c, err := r.Cookie(seatSessionCookieName(id))
	if err != nil || c.Value == "" {
		return "", false
	}
	power, found := f.sessions[c.Value]
	return power, found
}

/*
handleSeatSession is how a phone that holds a seed becomes a seat again.

It carries no token, because a keyed seat has none. What it proves is
possession of the key the seat was claimed with, which is a stronger claim than
any address in this app makes.

Sessions live in memory and not in the database. A restart ends them and every
phone signs in again without being asked, because the seed is on the device;
what a restart must never do is leave a credential lying in a file that could
be copied, which is the whole point of this design.
*/
func handleSeatSession(g *game, id string, w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		nonce, err := nonceFor(id, "session")
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "nonce: %v", err)
			return
		}
		writeJSON(w, http.StatusOK, struct {
			Nonce   string `json:"nonce"`
			Message string `json:"message"`
		}{Nonce: nonce, Message: sessionMessage(id, nonce)})
	case http.MethodPost:
		var body struct {
			SignPub   string `json:"signPub"`
			Nonce     string `json:"nonce"`
			Signature string `json:"signature"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeErr(w, http.StatusBadRequest, "bad body: %v", err)
			return
		}
		if !checkNonce(id, "session", body.Nonce) {
			writeErr(w, http.StatusForbidden, "this challenge has expired — try again")
			return
		}
		public, err := base64.RawURLEncoding.DecodeString(body.SignPub)
		if err != nil || len(public) != ed25519.PublicKeySize {
			writeErr(w, http.StatusBadRequest, "signPub must be 32 base64url bytes")
			return
		}
		signature, err := base64.RawURLEncoding.DecodeString(body.Signature)
		if err != nil || len(signature) != ed25519.SignatureSize {
			writeErr(w, http.StatusBadRequest, "signature must be 64 base64url bytes")
			return
		}

		g.mu.Lock()
		defer g.mu.Unlock()
		f := g.flow

		power, seated := f.bySignPub[body.SignPub]
		// The signature is checked whether or not the key holds a seat, so
		// this address answers in the same time either way and cannot be
		// used to ask which keys are seated.
		valid := ed25519.Verify(public, []byte(sessionMessage(id, body.Nonce)), signature)
		if !valid || !seated {
			writeErr(w, http.StatusForbidden, "this key holds no seat in this game")
			return
		}

		token, err := f.openSession(power)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "tokens: %v", err)
			return
		}
		setSessionCookie(w, id, token)
		writeJSON(w, http.StatusOK, struct {
			Power string `json:"power"`
		}{Power: string(power)})
	default:
		writeErr(w, http.StatusMethodNotAllowed, "GET or POST")
	}
}
