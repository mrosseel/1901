// Joining: one shared invite, and a seat drawn at random (ADR-020).
//
// Nobody picks a power. The invite is the same link for everybody, the seat
// is assigned on arrival, and the seats stay anonymous to each other.

package server

import (
	"crypto/rand"
	"encoding/json"
	"math/big"
	"net/http"

	"spring1901/spike/internal/httpx"
)

type joinResponse struct {
	SeatURL string `json:"seatUrl"`
	// Whether this seat is held by a key rather than by a token in its
	// address (ADR-049). The page needs to know: a keyed seat's seed has to
	// be written to this device's storage before the board is opened.
	Keyed bool `json:"keyed,omitempty"`
}

func handleJoin(g *game, id, token string, w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		httpx.WriteErr(w, http.StatusMethodNotAllowed, "POST only")
		return
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	f := g.flow

	if token != f.inviteToken {
		http.NotFound(w, r)
		return
	}
	// A sandbox has no seat to claim (ADR-047). Its invite token is minted
	// like any other and handed to nobody, so this is unreachable through
	// the app — and it is written here rather than trusted, because the two
	// authorization paths must never meet.
	if f.settings.Sandbox {
		http.NotFound(w, r)
		return
	}

	// The joining phone made a key and sends its public half (ADR-049). A
	// body without one still claims a seat the old way, so a link opened
	// by something that is not this app is not left with a dead page.
	var body struct {
		SignPub string `json:"signPub"`
	}
	json.NewDecoder(r.Body).Decode(&body)
	if body.SignPub != "" && !checkSignPub(body.SignPub) {
		httpx.WriteErr(w, http.StatusBadRequest, "signPub must be 32 base64url bytes")
		return
	}

	// Everything below runs under the game lock, so two simultaneous
	// scans can never draw the same power (ADR-020).
	device := ""
	if c, err := r.Cookie(deviceCookieName(id)); err == nil {
		device = c.Value
	}
	if device != "" {
		if power, found := f.byDevice[device]; found {
			// This phone already holds a power. A keyed seat is handed
			// back its own address and nothing else: the seed is on the
			// device and the session is opened by signing, never by a
			// cookie that merely says which phone this is.
			s := f.seats[power]
			if s.signPub != "" {
				httpx.WriteJSON(w, http.StatusOK, joinResponse{
					SeatURL: keyedSeatURL(r, id),
					Keyed:   true,
				})
				return
			}
			httpx.WriteJSON(w, http.StatusOK, joinResponse{SeatURL: seatURL(r, id, s.token)})
			return
		}
	}

	free := f.unassignedPowers()
	if f.settings.GMPlays {
		// Hold one power back for the GM; it is never drawn (ADR-021).
		if len(free) <= 1 {
			free = nil
		}
	}
	if len(free) == 0 {
		httpx.WriteErr(w, http.StatusConflict, "every power is taken — ask the GM for a seat")
		return
	}

	pick, err := rand.Int(rand.Reader, big.NewInt(int64(len(free))))
	if err != nil {
		httpx.WriteErr(w, http.StatusInternalServerError, "random: %v", err)
		return
	}
	power := free[pick.Int64()]

	if device == "" {
		device, err = newToken()
		if err != nil {
			httpx.WriteErr(w, http.StatusInternalServerError, "tokens: %v", err)
			return
		}
	}

	s := f.seats[power]
	s.device = device
	f.byDevice[device] = power

	// One or the other, never both (ADR-049).
	session := ""
	if body.SignPub != "" {
		f.bindSeatKey(s, body.SignPub)
		session, err = f.openSession(power)
		if err != nil {
			httpx.WriteErr(w, http.StatusInternalServerError, "tokens: %v", err)
			return
		}
	} else {
		seatToken, err := newToken()
		if err != nil {
			httpx.WriteErr(w, http.StatusInternalServerError, "tokens: %v", err)
			return
		}
		s.token = seatToken
		f.bySeatToken[seatToken] = power
	}
	f.logEvent(id, "seat claimed (%v of %v)", f.joinedCount(), f.joinerSeats())
	g.persist(id)

	http.SetCookie(w, &http.Cookie{
		Name:     deviceCookieName(id),
		Value:    device,
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   60 * 60 * 24 * 30,
	})
	if session != "" {
		setSessionCookie(w, id, session)
		httpx.WriteJSON(w, http.StatusOK, joinResponse{SeatURL: keyedSeatURL(r, id), Keyed: true})
		return
	}
	httpx.WriteJSON(w, http.StatusOK, joinResponse{SeatURL: seatURL(r, id, s.token)})
}
