// Where a request goes: the two HTTP surfaces, and the scopes under them
// (ADR-050).
//
// A page route is served the app shell; everything under /api/v1 is answered
// here. The scope is read out of the address — referee, seat, sandbox — and a
// handler is only reached once the scope has been proved.

package server

import (
	"net/http"
	"strings"

	"github.com/zond/godip"
)

var gmRoutes = map[string]gameHandler{
	"state":         handleGMState,
	"handover":      handleGMHandover,
	"handover-role": handleGMRoleHandover,
	"key":           handleGMKey,
	"settings":      handleGMSettings,
	"start":         handleGMStart,
	"adjudicate":    handleGMForce,
	"draw":          handleGMDraw,
	"draw-withdraw": handleGMDrawWithdraw,
	"extend":        handleGMExtend,
	"events":        handleGMEvents,
	"map.svg":       handleMap,

	// The referee's mailbox (ADR-054). These answer only in a game whose
	// game master does not play and was declared to read press; in every
	// other game they are 404, like a route that does not exist.
	"press":        gmPress(handlePress),
	"press/key":    gmPress(handlePressKey),
	"press/open":   gmPress(handlePressOpen),
	"press/thread": gmPress(handlePressThread),
	"press/send":   gmPress(handlePressSend),
	"press/read":   gmPress(handlePressRead),
}

var seatRoutes = map[string]seatHandler{
	"state":         handleSeatState,
	"handover":      handleSeatHandover,
	"handover-role": handleSeatRoleHandover,
	"options":       handleSeatOptions,
	"order":         handleSeatOrder,
	"lock":          handleSeatLock,
	"unlock":        handleSeatUnlock,
	"draw-response": handleSeatDrawResponse,
	"events":        handleSeatEvents,
	// Only a sealed game answers this (ADR-004). The phone sends what it
	// locked in, once every power has.
	"reveal": handleSeatReveal,

	// The names these two carried until 2026-08-30. A phone that loaded the
	// seat page before the rename shipped still posts to them, and a game at
	// the table cannot be asked to reload mid-phase. Delete both once no
	// session that predates the rename can still be open.
	"finalize":   handleSeatLock,
	"unfinalize": handleSeatUnlock,

	// Press (ADR-053). Every one of these 404s in a game that carries no
	// messages, and every one takes the power from the credential rather
	// than from a body.
	"press":        seatPress(handlePress),
	"press/key":    seatPress(handlePressKey),
	"press/open":   seatPress(handlePressOpen),
	"press/thread": seatPress(handlePressThread),
	"press/send":   seatPress(handlePressSend),
	"press/read":   seatPress(handlePressRead),
}

/*
serveFlow routes the bare /game/{id}/ addresses, which are the published
surface and the pages (ADR-050).

Published: the board anybody may read, at an address anybody may paste.
Pages: the seat and the game master shell, which carry a token because the
address is the seat (ADR-012) but answer with nothing but the app.

Everything this app says to itself moved under /api/v1 and is answered by
serveFlowAPI below.
*/
func (self *server) serveFlow(w http.ResponseWriter, r *http.Request) {
	g, id, segments, ok := lookupFlow(w, r, "/game/")
	if !ok {
		return
	}

	switch segments[1] {
	case "public":
		handlePublic(g, id, w, r)
	case "watch":
		// Public and unauthenticated by design (ADR-013).
		handleWatch(g, id, segments[2:], w, r)
	case "results.json":
		// The counts a tournament pipeline reads (ADR-046). As public as the
		// board they are counted from.
		handleResults(g, id, w, r)
	case "results.csv":
		handleResultsCSV(g, id, w, r)
	case "map.svg":
		// The art of the board being watched, which is as public as the
		// board is.
		handleMap(g, id, w, r)
	case "referee":
		// Token-free on purpose: the referee cookie set at creation is
		// the credential. For anyone else the address is a 404. It answers
		// with a redirect to a page, so it belongs with the pages.
		handleRefereeEntry(g, id, w, r)
	case "gm", "seat", "sandbox":
		// The page only. Every action under it is transport and lives
		// under /api/v1; this address serves the shell.
		self.servePageScope(g, id, segments, w, r)
	default:
		http.NotFound(w, r)
	}
}

/*
serveFlowAPI routes /api/v1/game/{id}/… — everything the app says to itself
about one game.

No promises are made about any of it (ADR-050). The only caller is the
JavaScript this same build shipped, and the version in the path is what lets
that stay true without breaking a phone that is still on the old one.
*/
func (self *server) serveFlowAPI(w http.ResponseWriter, r *http.Request, path string) {
	g, id, segments, ok := lookupFlow(w, r, "/game/")
	if !ok {
		return
	}
	_ = path

	switch segments[1] {
	case "events":
		if len(segments) != 2 {
			http.NotFound(w, r)
			return
		}
		// Public invalidations contain no state, only a changing version. The
		// spectator and join pages use them to re-read their public views.
		handleEvents(g, id, w, r)
	case "join":
		if len(segments) != 3 {
			http.NotFound(w, r)
			return
		}
		handleJoin(g, id, segments[2], w, r)
	case "handover":
		// The signature in the path is the whole credential (ADR-041), so
		// this sits beside join rather than inside a token scope.
		handleHandoverClaim(g, id, segments[2:], w, r)
	case "handover-gm":
		handleGMRoleClaim(g, id, segments[2:], w, r)
	case "session":
		// Token-free: a keyed seat has none (ADR-049). The signature the
		// phone sends back is the credential.
		handleSeatSession(g, id, w, r)
	case "recover":
		// Token-free for the reason it exists (ADR-048): the person asking
		// has lost every token they had. The signature they send back is
		// the credential.
		handleRecover(g, id, w, r)
	case "gm", "seat":
		self.serveTokenScope(g, id, segments, w, r)
	case "sandbox":
		self.serveSandboxScope(g, id, segments, w, r)
	default:
		http.NotFound(w, r)
	}
}

// lookupFlow finds the game an address names, whichever surface the address
// is on. It answers the request itself when there is nothing to find.
func lookupFlow(w http.ResponseWriter, r *http.Request, prefix string) (*game, string, []string, bool) {
	path := r.URL.Path
	if i := strings.Index(path, prefix); i >= 0 {
		path = path[i+len(prefix):]
	}
	segments := strings.Split(path, "/")
	if len(segments) < 2 || !validID(segments[0]) {
		http.NotFound(w, r)
		return nil, "", nil, false
	}
	g, found := games.lookup(segments[0])
	if !found {
		http.NotFound(w, r)
		return nil, "", nil, false
	}
	return g, segments[0], segments, true
}

/*
servePageScope serves the seat and the game master pages.

The address carries a token and the page carries none of it: what is served is
the same shell every address serves, and the JavaScript in it goes to /api/v1
with whatever the address holds. The token is checked there, not here — which
is also what lets a keyed seat open the page that signs it back in with no
session at all (ADR-049).
*/
func (self *server) servePageScope(g *game, id string, segments []string, w http.ResponseWriter, r *http.Request) {
	kind := segments[1]
	if len(segments) < 3 {
		http.NotFound(w, r)
		return
	}
	token := segments[2]
	if len(segments) == 3 {
		// Normalize to the trailing-slash form the pages live at.
		target := "/game/" + id + "/" + kind + "/" + token + "/"
		if r.URL.RawQuery != "" {
			target += "?" + r.URL.RawQuery
		}
		http.Redirect(w, r, target, http.StatusFound)
		return
	}
	if strings.Join(segments[3:], "/") != "" {
		http.NotFound(w, r)
		return
	}
	self.serveSPA(w, r)
}

/*
serveTokenScope answers one seat's or one game master's actions, under
/api/v1/game/{id}/{gm|seat}/{token}/{action}.

The token in the address is the credential, except for a keyed seat, whose
address says "me" and whose credential is the session cookie its own key
bought (ADR-049). The page at the matching bare address is served by
servePageScope and checks nothing, which is what lets a phone with a seed and
no session load the page that signs it back in.
*/
func (self *server) serveTokenScope(g *game, id string, segments []string, w http.ResponseWriter, r *http.Request) {
	kind := segments[1]
	if len(segments) < 4 {
		http.NotFound(w, r)
		return
	}
	token := segments[2]
	action := strings.Join(segments[3:], "/")

	g.mu.Lock()
	f := g.flow
	if f.settings.Sandbox {
		// A sandbox has no seats and no game master (ADR-047). Its own
		// scope answers below; these two never do, so no credential minted
		// for a table can drive a sandbox and no sandbox link can reach a
		// seat route.
		g.mu.Unlock()
		http.NotFound(w, r)
		return
	}
	var power godip.Nation
	authorized := false
	if kind == "gm" {
		authorized = subtleEqual(token, f.gmToken)
	} else if token == "me" {
		// A keyed seat (ADR-049). The address carries no secret, so the
		// session cookie is what says which power this is.
		power, authorized = f.sessionPower(id, r)
	} else {
		if p, ok := f.bySeatToken[token]; ok {
			power = p
			authorized = true
		}
	}
	g.mu.Unlock()

	if !authorized {
		http.NotFound(w, r)
		return
	}

	if kind == "gm" {
		if h, ok := gmRoutes[action]; ok {
			h(g, id, w, r)
			return
		}
		http.NotFound(w, r)
		return
	}
	if action == "map.svg" {
		handleMap(g, id, w, r)
		return
	}
	if h, ok := seatRoutes[action]; ok {
		h(g, id, power, w, r)
		return
	}
	http.NotFound(w, r)
}

// handleRefereeEntry sends the browser that created the game to the GM
// view. The URL carries no secret, so it may sit on the main page for
// every game; it opens the controls only for the browser holding the
// referee cookie.
func handleRefereeEntry(g *game, id string, w http.ResponseWriter, r *http.Request) {
	g.mu.Lock()
	device := refereeCookieValue(r, id)
	ok := g.flow.gmDevice != "" && subtleEqual(device, g.flow.gmDevice)
	target := gmURL(r, id, g.flow.gmToken)
	if g.flow.settings.Sandbox {
		// A sandbox has no game master view to open. The browser that made
		// it gets the driver's link back, which is the only way in.
		target = sandboxURL(r, id, g.flow.sandboxToken)
	}
	g.mu.Unlock()
	if !ok {
		http.NotFound(w, r)
		return
	}
	http.Redirect(w, r, target, http.StatusFound)
}

// subtleEqual compares two tokens in constant time.
func subtleEqual(a, b string) bool {
	if len(a) != len(b) {
		return false
	}
	diff := byte(0)
	for i := 0; i < len(a); i++ {
		diff |= a[i] ^ b[i]
	}
	return diff == 0
}

// serveJoinPage handles GET /join/{id}/{inviteToken}.
func (self *server) serveJoinPage(w http.ResponseWriter, r *http.Request) {
	rest := strings.TrimPrefix(r.URL.Path, "/join/")
	segments := strings.Split(strings.TrimSuffix(rest, "/"), "/")
	if len(segments) != 2 || !validID(segments[0]) {
		http.NotFound(w, r)
		return
	}
	g, found := games.lookup(segments[0])
	if !found {
		http.NotFound(w, r)
		return
	}
	g.mu.Lock()
	ok := subtleEqual(segments[1], g.flow.inviteToken)
	g.mu.Unlock()
	if !ok {
		http.NotFound(w, r)
		return
	}
	self.serveSPA(w, r)
}
