/*
The owner's own door (ADR-060).

There are no accounts here and there is not going to be one (ADR-020). But the
person who runs the server is not a player: they made the box, they pay for the
disk, and a public address collects test games the way a table collects empty
glasses. Somebody has to be able to throw one away.

So: one secret, read from ADMIN_TOKEN at startup, and one power behind it.
When the variable is unset there is no door at all — every address below is a
404, which is what a server nobody meant to administer should look like.

	POST /api/v1/admin/login    the token, for a session cookie
	GET  /api/v1/admin/me       whether this browser is the owner
	POST /api/v1/admin/logout   drop the session
	DELETE /api/v1/admin/games/{id}

The session is a random value this process remembers, not a signature over the
token: a restart ends every session, and the owner types the token again. That
is the right way round for a credential typed by hand — nothing photographed or
copied out of a cookie jar outlives the binary that issued it.
*/
package server

import (
	"encoding/json"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"spring1901/spike/internal/httpx"
)

// adminCookieName is the owner's session. One per server, unlike a seat's,
// which is one per game: there is one owner and one box.
const adminCookieName = "s1901_admin"

// adminSessionLife is how long a login lasts. An evening of tidying up, and
// then the token again.
const adminSessionLife = 12 * time.Hour

// adminLoginDelay is what a wrong token costs. The token is long and random,
// so this is not the thing that makes guessing hopeless; it is what stops a
// script from turning one address into thousands of tries a second.
const adminLoginDelay = time.Second

// adminToken is the shared secret, empty when the owner never set one. It is
// read on every call rather than pinned at startup so a test can set it, and
// it is never logged: the value is the whole of the authorization.
func adminToken() string {
	return os.Getenv("ADMIN_TOKEN")
}

// adminEnabled says whether this server has an owner's door at all.
func adminEnabled() bool {
	return adminToken() != ""
}

// adminSessions holds every session the login has handed out, with the moment
// it stops being one. It lives in memory only, like a seat's session.
var adminSessions = struct {
	mu   sync.Mutex
	open map[string]time.Time
}{open: map[string]time.Time{}}

// openAdminSession mints a session value and remembers it.
func openAdminSession() (string, error) {
	token, err := newToken()
	if err != nil {
		return "", err
	}
	adminSessions.mu.Lock()
	defer adminSessions.mu.Unlock()
	now := time.Now()
	for held, until := range adminSessions.open {
		if now.After(until) {
			delete(adminSessions.open, held)
		}
	}
	adminSessions.open[token] = now.Add(adminSessionLife)
	return token, nil
}

// isAdmin says whether this request carries a live admin session. It answers
// false for every request when no token is configured, so a stale cookie from
// a server that once had one opens nothing.
func isAdmin(r *http.Request) bool {
	if !adminEnabled() {
		return false
	}
	c, err := r.Cookie(adminCookieName)
	if err != nil || c.Value == "" {
		return false
	}
	adminSessions.mu.Lock()
	defer adminSessions.mu.Unlock()
	until, found := adminSessions.open[c.Value]
	if !found {
		return false
	}
	if time.Now().After(until) {
		delete(adminSessions.open, c.Value)
		return false
	}
	return true
}

/*
setAdminCookie is the one place the owner's cookie is written.

SameSite is strict rather than lax: nothing links into the admin surface from
anywhere, so a cookie that travels with a cross-site navigation buys nothing
and costs the only defence a delete button has against being pressed from
somebody else's page. The path is the admin scope, so no other request on the
server ever carries it.
*/
func setAdminCookie(w http.ResponseWriter, token string) {
	http.SetCookie(w, &http.Cookie{
		Name:     adminCookieName,
		Value:    token,
		Path:     apiPrefix + "/admin/",
		HttpOnly: true,
		SameSite: http.SameSiteStrictMode,
		MaxAge:   int(adminSessionLife / time.Second),
	})
}

// clearAdminCookie expires the cookie in the browser. The session itself is
// dropped from memory beside it, so a copy of the cookie is worth nothing.
func clearAdminCookie(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{
		Name:     adminCookieName,
		Value:    "",
		Path:     apiPrefix + "/admin/",
		HttpOnly: true,
		SameSite: http.SameSiteStrictMode,
		MaxAge:   -1,
	})
}

// adminMeJSON is what every one of these routes answers with, so the page has
// one shape to read whether it just logged in or only asked.
type adminMeJSON struct {
	Admin bool `json:"admin"`
}

// handleAdminLogin takes the token and hands back a session.
func handleAdminLogin(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		httpx.WriteErr(w, http.StatusMethodNotAllowed, "post the token")
		return
	}
	var body struct {
		Token string `json:"token"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		httpx.WriteErr(w, http.StatusBadRequest, "could not read the request")
		return
	}
	if !subtleEqual(body.Token, adminToken()) {
		time.Sleep(adminLoginDelay)
		httpx.WriteErr(w, http.StatusUnauthorized, "that is not the token")
		return
	}
	token, err := openAdminSession()
	if err != nil {
		httpx.WriteErr(w, http.StatusInternalServerError, "could not open a session")
		return
	}
	setAdminCookie(w, token)
	httpx.WriteJSON(w, http.StatusOK, adminMeJSON{Admin: true})
}

// handleAdminMe answers whether this browser holds a live session.
func handleAdminMe(w http.ResponseWriter, r *http.Request) {
	httpx.WriteJSON(w, http.StatusOK, adminMeJSON{Admin: isAdmin(r)})
}

// handleAdminLogout forgets the session and expires the cookie.
func handleAdminLogout(w http.ResponseWriter, r *http.Request) {
	if c, err := r.Cookie(adminCookieName); err == nil && c.Value != "" {
		adminSessions.mu.Lock()
		delete(adminSessions.open, c.Value)
		adminSessions.mu.Unlock()
	}
	clearAdminCookie(w)
	httpx.WriteJSON(w, http.StatusOK, adminMeJSON{Admin: false})
}

/*
handleAdminDeleteGame throws a game away, board and history together.

Deleting the row is enough for the database: every table that hangs off a game
names game_id with ON DELETE CASCADE, and the connection is opened with
foreign_keys on (see openDB), so the seats, the orders, the events, the press
and the commitments go with it in one statement.

The registry and the open sockets are the other half. A game that is gone from
disk but still in memory keeps answering, and a phone watching it would sit on
a board that no longer exists, so the game leaves the map first and everybody
connected to it is cut loose.
*/
func handleAdminDeleteGame(w http.ResponseWriter, r *http.Request, id string) {
	if !isAdmin(r) {
		httpx.WriteErr(w, http.StatusForbidden, "log in first")
		return
	}
	if r.Method != http.MethodDelete {
		httpx.WriteErr(w, http.StatusMethodNotAllowed, "delete the game")
		return
	}
	if !validID(id) {
		http.NotFound(w, r)
		return
	}
	if !games.remove(id) {
		http.NotFound(w, r)
		return
	}
	if _, err := db.Exec(`DELETE FROM game WHERE id = ?`, id); err != nil {
		httpx.WriteErr(w, http.StatusInternalServerError, "could not delete the game")
		return
	}
	httpx.WriteJSON(w, http.StatusOK, struct {
		Deleted string `json:"deleted"`
	}{Deleted: id})
}

/*
serveAdmin routes everything under /api/v1/admin.

The whole scope is a 404 when no token is configured. That is not politeness:
a server with no owner's door should be indistinguishable from a build that
never had one, so nothing here tells a stranger there is a login to find.
*/
func serveAdmin(w http.ResponseWriter, r *http.Request, rest string) {
	if !adminEnabled() {
		http.NotFound(w, r)
		return
	}
	switch {
	case rest == "/admin/login":
		handleAdminLogin(w, r)
	case rest == "/admin/me":
		handleAdminMe(w, r)
	case rest == "/admin/logout":
		handleAdminLogout(w, r)
	case strings.HasPrefix(rest, "/admin/games/"):
		handleAdminDeleteGame(w, r, strings.Trim(strings.TrimPrefix(rest, "/admin/games/"), "/"))
	default:
		http.NotFound(w, r)
	}
}
