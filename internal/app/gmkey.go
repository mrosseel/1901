/*
The game master's key, and the twelve words that recover it (ADR-048).

Until now the role was a URL and a cookie, and both live on one device. Lose
them together and nobody can run the game any more: the create response carries
no secret on purpose (ADR-041), the referee door answers only the browser that
made the game, and a handover link needs the role you have already lost.

So the game master's browser makes an Ed25519 keypair. The server is given the
public half and never sees the private one. The private half is written down as
twelve words from the BIP-39 English list, and typing them back is the whole
recovery:

	GET  /game/{id}/gm/{token}/key       what the server holds, if anything
	POST /game/{id}/gm/{token}/key       register the public half, once
	GET  /game/{id}/recover              a challenge to sign
	POST /game/{id}/recover              the signature, for a fresh token

The challenge is signed by the server and not stored, the same trick the
handover links use: it carries its own expiry and an HMAC over the salt, so a
recovery needs no row and no state between the two requests.

A recovery rotates the token and raises the role epoch, exactly as a handover
does. Whoever holds the words holds the role, and the device that held it
before stops holding it. That is deliberate: two game masters is a worse
failure than one locked out.

The key is registered once. A second, different key is refused, because the
token is not the credential the key is meant to protect — somebody who has the
token already has the role, and letting them overwrite the key would let them
lock the real game master out of their own recovery.
*/
package app

import (
	"crypto/ed25519"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"spring1901/spike/internal/httpx"
	"strconv"
	"strings"
	"time"
)

// recoverWindow is how long a challenge stands. It is a person typing twelve
// words on the device in front of them, not a link on a table, so minutes.
const recoverWindow = 10 * time.Minute

// gmKeyJSON is the public half, base64url with no padding. Empty means the
// game has no key and recovery is not possible for it.
type gmKeyJSON struct {
	PublicKey string `json:"publicKey"`
}

// recoverMessage is what the game master's key signs. The game id is in it so
// a signature made for one game cannot be replayed against another, and the
// purpose string is in it so nothing else this key ever signs can be replayed
// here.
func recoverMessage(id, nonce string) string {
	return "1901 game master recovery|" + id + "|" + nonce
}

/*
nonceFor mints a challenge nobody can forge and the server need not remember:
random bytes, an expiry, and an HMAC over both under the salt that signs the
handover links.

The purpose is inside the HMAC, so a challenge minted for one route cannot be
answered on another — a recovery nonce is not a session nonce.
*/
func nonceFor(id, purpose string) (string, error) {
	raw := make([]byte, 16)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	body := base64.RawURLEncoding.EncodeToString(raw) + "." +
		strconv.FormatInt(time.Now().Add(recoverWindow).Unix(), 10)
	return body + "." + nonceSig(id, purpose, body), nil
}

func nonceSig(id, purpose, body string) string {
	mac := hmac.New(sha256.New, handoverSalt)
	fmt.Fprintf(mac, "%v|%v|%v", purpose, id, body)
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))[:32]
}

// checkNonce says whether a challenge is one this server minted for this game
// and this purpose, and is still inside its window.
func checkNonce(id, purpose, nonce string) bool {
	parts := strings.Split(nonce, ".")
	if len(parts) != 3 {
		return false
	}
	body := parts[0] + "." + parts[1]
	if !hmac.Equal([]byte(parts[2]), []byte(nonceSig(id, purpose, body))) {
		return false
	}
	expiry, err := strconv.ParseInt(parts[1], 10, 64)
	if err != nil {
		return false
	}
	return time.Now().Unix() <= expiry
}

/*
handleGMKey reads or registers the public half.

Registering is not a logged act. It happens once, on the game master's own
screen, and it takes nothing away from anybody: what it does is give the person
already running the game a way back in. The act worth recording is a recovery,
and that is recorded where it happens.
*/
func handleGMKey(g *game, id string, w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		g.mu.Lock()
		defer g.mu.Unlock()
		httpx.WriteJSON(w, http.StatusOK, gmKeyJSON{PublicKey: g.flow.gmPublicKey})
	case http.MethodPost:
		var body gmKeyJSON
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			httpx.WriteErr(w, http.StatusBadRequest, "bad body: %v", err)
			return
		}
		raw, err := base64.RawURLEncoding.DecodeString(body.PublicKey)
		if err != nil || len(raw) != ed25519.PublicKeySize {
			httpx.WriteErr(w, http.StatusBadRequest, "publicKey must be 32 base64url bytes")
			return
		}
		g.mu.Lock()
		defer g.mu.Unlock()
		f := g.flow
		if f.gmPublicKey != "" && f.gmPublicKey != body.PublicKey {
			httpx.WriteErr(w, http.StatusConflict,
				"this game already has a key — recover with its words, or hand the role over")
			return
		}
		f.gmPublicKey = body.PublicKey
		g.persist(id)
		httpx.WriteJSON(w, http.StatusOK, gmKeyJSON{PublicKey: f.gmPublicKey})
	default:
		httpx.WriteErr(w, http.StatusMethodNotAllowed, "GET or POST")
	}
}

/*
handleRecoverChallenge hands out something to sign.

It carries no token, because the person asking has lost theirs — that is the
whole case. It gives away nothing: a nonce is random, and the only thing a
stranger learns is whether this game has a key at all, which its game master's
screen says out loud anyway.
*/
func handleRecoverChallenge(g *game, id string, w http.ResponseWriter, r *http.Request) {
	g.mu.Lock()
	hasKey := g.flow.gmPublicKey != ""
	g.mu.Unlock()
	if !hasKey {
		httpx.WriteErr(w, http.StatusNotFound, "this game has no recovery key")
		return
	}
	nonce, err := nonceFor(id, "recover")
	if err != nil {
		httpx.WriteErr(w, http.StatusInternalServerError, "nonce: %v", err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, struct {
		GameID  string `json:"gameId"`
		Nonce   string `json:"nonce"`
		Message string `json:"message"`
	}{GameID: id, Nonce: nonce, Message: recoverMessage(id, nonce)})
}

/*
handleRecoverClaim takes the role back.

A correct signature is proof the person holding the words holds the key the
game was created with, which is a stronger claim than any token in this app
makes. So it does what a role handover does: a fresh token, no device claim,
and the epoch past every link minted under the old one.
*/
func handleRecoverClaim(g *game, id string, w http.ResponseWriter, r *http.Request) {
	var body struct {
		Nonce     string `json:"nonce"`
		Signature string `json:"signature"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		httpx.WriteErr(w, http.StatusBadRequest, "bad body: %v", err)
		return
	}
	if !checkNonce(id, "recover", body.Nonce) {
		httpx.WriteErr(w, http.StatusForbidden, "this challenge has expired — start again")
		return
	}
	signature, err := base64.RawURLEncoding.DecodeString(body.Signature)
	if err != nil || len(signature) != ed25519.SignatureSize {
		httpx.WriteErr(w, http.StatusBadRequest, "signature must be 64 base64url bytes")
		return
	}

	g.mu.Lock()
	defer g.mu.Unlock()
	f := g.flow

	public, err := base64.RawURLEncoding.DecodeString(f.gmPublicKey)
	if err != nil || len(public) != ed25519.PublicKeySize {
		httpx.WriteErr(w, http.StatusNotFound, "this game has no recovery key")
		return
	}
	if !ed25519.Verify(public, []byte(recoverMessage(id, body.Nonce)), signature) {
		// Say nothing about which word is wrong. There is nothing useful to
		// say: the words are checked in the browser before they get here, so
		// this is either a typo that passed the checksum or the wrong game.
		httpx.WriteErr(w, http.StatusForbidden, "those words do not open this game")
		return
	}

	token, err := newToken()
	if err != nil {
		httpx.WriteErr(w, http.StatusInternalServerError, "tokens: %v", err)
		return
	}
	f.gmToken = token
	f.gmDevice = ""
	g.events.revokeGM()
	f.gmEpoch++

	f.logEvent(id, "the game master role was recovered with its twelve words")
	g.persist(id)

	httpx.WriteJSON(w, http.StatusOK, struct {
		GMURL string `json:"gmUrl"`
	}{GMURL: gmURL(r, id, token)})
}

// handleRecover is the one address the recovery page talks to: GET asks for a
// challenge, POST answers it.
func handleRecover(g *game, id string, w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		handleRecoverChallenge(g, id, w, r)
	case http.MethodPost:
		handleRecoverClaim(g, id, w, r)
	default:
		httpx.WriteErr(w, http.StatusMethodNotAllowed, "GET or POST")
	}
}
