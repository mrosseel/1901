// Public, permanent, login-free per-phase URLs (D-013;
// research/platforms.md, steal 1).
//
// Backstabbr's single most valuable property is not a feature: it is that
// /game/<id>/<year>/<season> renders the board, the orders and the results to
// a signed-out visitor, forever. That is why it owns post-game analysis, why
// its links are the community's citation format, and why the tournament
// pipeline scrapes it. Our spectator view is already secret-free by D-013, so
// the data model was done; what was missing was the URL.
//
//	/watch/{gameId}/                the page, at the phase now being played
//	/watch/{gameId}/{phaseIndex}    the page, at one phase of the past
//	/game/{id}/watch                the JSON behind the first
//	/game/{id}/watch/{phaseIndex}   the JSON behind the second
//
// What a resolved phase shows is everything: the position it was played from,
// every order that was applied, who gave it, how it resolved, what was
// dislodged and who was NMRed. All of that is public the moment the phase
// resolves — it is what the players themselves see in the review — so there
// is nothing here to leak.
//
// What the CURRENT phase shows is the board, the phase, the deadline and who
// has locked. Never an order, not even one's own: this endpoint has no
// token and cannot know who is asking, so it carries no draft orders at all.
// That is the no-leak discipline, and it is why the two shapes are one type
// with a flag rather than two functions that might drift apart.
//
// The history is not stored in a table of its own. Every snapshot is built by
// the same replay machinery that rebuilds a game after a restart (store.go):
// the phases are replayed from their order rows, and each one records what it
// saw on the way past. A historical URL is therefore stable forever and
// survives a SIGKILL, because it is derived from the same rows the board is.
package main

import (
	"net/http"
	"strconv"
	"strings"
)

// watchPosition is the board as one phase began.
type watchPosition struct {
	phase         phaseJSON
	units         map[string]unitJSON
	dislodged     map[string]unitJSON
	supplyCenters map[string]string
}

// positionNow reads the board as it stands. The caller must hold g.mu.
func (self *game) positionNow() watchPosition {
	s := self.state
	out := watchPosition{
		phase: phaseJSON{
			Season: string(s.Phase().Season()),
			Year:   s.Phase().Year(),
			Type:   string(s.Phase().Type()),
		},
		units:         map[string]unitJSON{},
		dislodged:     self.dislodgedMap(),
		supplyCenters: map[string]string{},
	}
	for prov, unit := range s.Units() {
		out.units[string(prov)] = unitJSON{Type: string(unit.Type), Nation: string(unit.Nation)}
	}
	for prov, nation := range s.SupplyCenters() {
		out.supplyCenters[string(prov)] = string(nation)
	}
	return out
}

// watchSnapshot is one resolved phase, kept for as long as the game is
// loaded: the position it was played from, and what the players did with it.
type watchSnapshot struct {
	position watchPosition
	review   *phaseReviewJSON
}

// recordWatch files the phase that has just resolved. It must run after
// endReview, and before the phase index moves on. The caller must hold g.mu.
//
// Both the live path and replay() call it, which is the whole trick: a game
// that was killed and restarted rebuilds exactly the same history, because
// the history is a function of the stored order rows and nothing else.
func (self *game) recordWatch(phaseIndex int, position watchPosition, review *phaseReviewJSON) {
	for len(self.watch) <= phaseIndex {
		self.watch = append(self.watch, nil)
	}
	self.watch[phaseIndex] = &watchSnapshot{position: position, review: review}
}

// watchJSON is one phase, as anybody with the link may see it.
type watchJSON struct {
	GameID     string `json:"gameId"`
	PhaseIndex int    `json:"phaseIndex"`
	// PhaseCount is how many phases the game has had, the last of which is
	// the one being played. It is what a viewer pages through.
	PhaseCount  int       `json:"phaseCount"`
	Current     bool      `json:"current"`
	Adjudicated bool      `json:"adjudicated"`
	Phase       phaseJSON `json:"phase"`

	Units         map[string]unitJSON `json:"units"`
	Dislodged     map[string]unitJSON `json:"dislodged"`
	SupplyCenters map[string]string   `json:"supplyCenters"`

	// Set on a resolved phase only. Past orders are public.
	Orders      map[string]string   `json:"orders"`
	OrderParts  map[string][]string `json:"orderParts"`
	Powers      map[string]string   `json:"powers"`
	Resolutions map[string]string   `json:"resolutions"`
	// Illegal names the provinces whose order never reached the engine
	// (D-029). Their resolution is "IllegalOrder" and their unit held.
	Illegal []string `json:"illegal"`
	NMR     []string `json:"nmr"`

	// Set on the phase being played. No order of any kind appears here.
	Started bool `json:"started"`
	// The seats, as counts only. A game that has not started yet is the
	// state a spectator link is most often opened in, and "3 of 7 joined"
	// is the whole of what there is to watch then. It names nobody: the
	// same two numbers the join page shows anyone with the invite.
	JoinedCount int             `json:"joinedCount"`
	SeatsToFill int             `json:"seatsToFill"`
	LockedCount int             `json:"lockedCount"`
	TotalSeats  int             `json:"totalSeats"`
	Locked      map[string]bool `json:"locked"`
	DeadlineAt  interface{}     `json:"deadlineAt"`
	GraceUntil  interface{}     `json:"graceUntil"`

	Variant       variantRefJSON    `json:"variant"`
	ProvinceNames map[string]string `json:"provinceNames"`
	Placements    placementTable    `json:"placements"`
	Labels        *labelPlanJSON    `json:"labels,omitempty"`
	Now           string            `json:"now"`
}

// watchState renders one phase for the public. The caller must hold g.mu.
func (self *game) watchState(id string, phaseIndex int) (watchJSON, bool) {
	f := self.flow
	count := f.phaseIndex + 1
	if phaseIndex < 0 || phaseIndex >= count {
		return watchJSON{}, false
	}
	out := watchJSON{
		GameID:        id,
		PhaseIndex:    phaseIndex,
		PhaseCount:    count,
		Variant:       self.variantRef(),
		ProvinceNames: self.provinceNames(),
		Placements:    self.placements(),
		Labels:        self.labels(),
		Now:           serverNow(),
		Units:         map[string]unitJSON{},
		Dislodged:     map[string]unitJSON{},
		SupplyCenters: map[string]string{},
	}

	if phaseIndex == f.phaseIndex {
		// The phase now being played: the board, the clock, and who has
		// locked. Nothing else exists here to show.
		position := self.positionNow()
		out.Current = true
		out.Phase = position.phase
		out.Units = position.units
		out.Dislodged = position.dislodged
		out.SupplyCenters = position.supplyCenters
		out.Started = f.started
		out.JoinedCount = f.joinedCount()
		out.SeatsToFill = f.joinerSeats()
		out.LockedCount = f.lockedCount()
		out.TotalSeats = f.activeSeats()
		out.Locked = f.lockedMap()
		out.DeadlineAt = rfc3339(f.deadlineAt)
		out.GraceUntil = rfc3339(f.graceEndsAt())
		return out, true
	}

	snapshot := self.watch[phaseIndex]
	if snapshot == nil {
		return watchJSON{}, false
	}
	out.Adjudicated = true
	out.Phase = snapshot.position.phase
	out.Units = snapshot.position.units
	out.SupplyCenters = snapshot.position.supplyCenters
	if review := snapshot.review; review != nil {
		out.Orders = review.Orders
		out.OrderParts = review.OrderParts
		out.Powers = review.Powers
		out.Resolutions = review.Resolutions
		out.Illegal = review.Illegal
		out.NMR = review.NMR
		// The dislodgements this phase produced, which is what a reader of a
		// resolved phase wants: who was pushed out by what just happened.
		out.Dislodged = review.Dislodged
	}
	return out, true
}

// handleWatch serves /game/{id}/watch and /game/{id}/watch/{phaseIndex}.
func handleWatch(g *game, id string, rest []string, w http.ResponseWriter, r *http.Request) {
	g.mu.Lock()
	defer g.mu.Unlock()

	index := g.flow.phaseIndex
	if len(rest) > 0 && rest[0] != "" {
		parsed, err := strconv.Atoi(rest[0])
		if err != nil {
			http.NotFound(w, r)
			return
		}
		index = parsed
	}
	out, found := g.watchState(id, index)
	if !found {
		http.NotFound(w, r)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// serveWatchPage serves /watch/{id}/ and /watch/{id}/{phaseIndex}: the SPA
// shell, which routes itself from the path. A game that does not exist is a
// 404 rather than a shell that will find nothing, because a public link that
// has gone stale should say so at once.
func (self *server) serveWatchPage(w http.ResponseWriter, r *http.Request) {
	rest := strings.TrimPrefix(r.URL.Path, "/watch/")
	segments := strings.Split(strings.TrimSuffix(rest, "/"), "/")
	if len(segments) == 0 || !validID(segments[0]) || len(segments) > 2 {
		http.NotFound(w, r)
		return
	}
	if _, found := games.lookup(segments[0]); !found {
		http.NotFound(w, r)
		return
	}
	if len(segments) == 2 && segments[1] != "" {
		if _, err := strconv.Atoi(segments[1]); err != nil {
			http.NotFound(w, r)
			return
		}
	}
	self.serveSPA(w, r)
}
