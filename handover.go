/*
Handing a power to another person, by link (D-041).

A seat is a token on a phone. Phones die, run flat and go home in a pocket
halfway through a game, and until now that took a power with it: D-012's claim
was hard and had no release. This is the release.

	GET  /game/{id}/seat/{token}/handover      the holder mints their own link
	GET  /game/{id}/gm/{token}/handover?power= the game master mints any (D-007)
	GET  /handover/{id}/{power}/{epoch}/{sig}  the page the next person opens
	POST /game/{id}/handover/{power}/{epoch}/{sig}  taking the seat

The link is signed and not stored. The server holds one salt and the link
carries HMAC(salt, game id, power, epoch), so nothing about a handover needs a
row and nothing can be forged without the salt.

The epoch is a counter per seat, and taking a seat raises it. That is what
makes a handover a handover rather than a share: every link and every token
minted under the old epoch stops working the moment the new person opens
theirs, including the phone that just gave the power away. A power belongs to
one person at a time.

Orders already given stand. The signed value authenticates a command, so an
order the server took was taken under an epoch that was valid then; raising the
epoch stops the old holder sending anything more and reaches back into nothing.
The new holder inherits the seat as it stands, orders included, and may change
them while the phase is open (D-011).
*/
package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"net/http"
	"net/url"
	"strconv"

	"github.com/zond/godip"
)

// handoverSalt signs every handover link on this server. It is read from the
// database at startup and made there on first run, so a link survives a
// restart — a QR code on a table outlives the process behind it.
var handoverSalt []byte

// handoverSig is the signature a link carries. The epoch is in it, which is
// what makes an old link dead rather than merely stale: it signs a different
// string once the seat has moved on.
func handoverSig(id string, power godip.Nation, epoch int) string {
	mac := hmac.New(sha256.New, handoverSalt)
	fmt.Fprintf(mac, "%v|%v|%v", id, power, epoch)
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))[:32]
}

// handoverURL is the address the QR code carries.
func handoverURL(r *http.Request, id string, power godip.Nation, epoch int) string {
	return fmt.Sprintf("%v/handover/%v/%v/%v/%v",
		baseURL(r), id, url.PathEscape(string(power)), epoch, handoverSig(id, power, epoch))
}

// handoverJSON is what a mint answers with. The power is in it because the
// game master mints for seats that are not theirs.
type handoverJSON struct {
	Power string `json:"power"`
	URL   string `json:"url"`
}

// handleSeatHandover mints the link for the seat asking. A holder hands their
// own power on: they scan nothing, they show a code.
func handleSeatHandover(g *game, id string, power godip.Nation, w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeErr(w, http.StatusMethodNotAllowed, "GET only")
		return
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	s, found := g.flow.seats[power]
	if !found {
		http.NotFound(w, r)
		return
	}
	writeJSON(w, http.StatusOK, handoverJSON{
		Power: string(power),
		URL:   handoverURL(r, id, power, s.epoch),
	})
}

/*
handleGMHandover mints a link for any power (D-041, r44).

A dead phone takes its own menu with it, so the holder cannot hand the seat
over themselves. That is the case this exists for and it is the common one.

It is an enumerated, logged game master power (D-007), because it is the one
that could be abused: a game master who can mint a link for any seat can take
any seat. Nothing prevents that and nothing should pretend to. The record is
what makes it visible afterwards.
*/
func handleGMHandover(g *game, id string, w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeErr(w, http.StatusMethodNotAllowed, "GET only")
		return
	}
	power := godip.Nation(r.URL.Query().Get("power"))
	if power == "" {
		writeErr(w, http.StatusBadRequest, "power is required")
		return
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	s, found := g.flow.seats[power]
	if !found {
		writeErr(w, http.StatusNotFound, "%v is not a power in this game", power)
		return
	}
	g.flow.logEvent(id, "the game master minted a handover link for %v", power)
	writeJSON(w, http.StatusOK, handoverJSON{
		Power: string(power),
		URL:   handoverURL(r, id, power, s.epoch),
	})
}

/*
handleHandoverClaim takes the seat.

The signature is the whole credential, so this address needs no token of its
own — and for the same reason it must never act on a GET. A link preview, a
scanner that fetches before it shows, a chat client unfurling the URL: any of
those would hand the power to nobody and kill the phone that still holds it.
The GET is a page with a button; this is what the button posts to.
*/
func handleHandoverClaim(g *game, id string, rest []string, w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeErr(w, http.StatusMethodNotAllowed, "POST only")
		return
	}
	if len(rest) != 3 {
		http.NotFound(w, r)
		return
	}
	name, err := url.PathUnescape(rest[0])
	if err != nil {
		http.NotFound(w, r)
		return
	}
	power := godip.Nation(name)
	epoch, err := strconv.Atoi(rest[1])
	if err != nil {
		http.NotFound(w, r)
		return
	}
	signature := rest[2]

	g.mu.Lock()
	defer g.mu.Unlock()
	f := g.flow

	s, found := f.seats[power]
	if !found {
		http.NotFound(w, r)
		return
	}
	if !hmac.Equal([]byte(signature), []byte(handoverSig(id, power, epoch))) {
		http.NotFound(w, r)
		return
	}
	// A link for an epoch the seat has left is not an error to explain in
	// detail; it is a link that was already used, or one the game master
	// minted after it. Say which, because the person holding it is standing
	// at a table wondering whether to ask for another.
	if epoch != s.epoch {
		writeErr(w, http.StatusConflict,
			"this link has been used — ask for a new one")
		return
	}

	token, err := newToken()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "tokens: %v", err)
		return
	}

	// Everything the old holder had stops working here: the token leaves the
	// index, the device claim is dropped so the next phone may take the seat,
	// and the epoch moves past every link that was signed for it.
	delete(f.bySeatToken, s.token)
	if s.device != "" {
		delete(f.byDevice, s.device)
	}
	s.token = token
	s.device = ""
	s.epoch++
	f.bySeatToken[token] = power

	f.logEvent(id, "%v was handed to another device", power)
	g.persist(id)

	writeJSON(w, http.StatusOK, struct {
		Power   string `json:"power"`
		SeatURL string `json:"seatUrl"`
	}{
		Power:   string(power),
		SeatURL: seatURL(r, id, token),
	})
}
