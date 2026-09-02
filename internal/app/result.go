/*
A game ends: a solo, an agreed draw, or the end year (ADR-044).

Until this, the flow never asked who won. It adjudicated, put the next phase
on the board, and did that forever. A tournament board plays to a result and
the result is what the room came for.

Three endings, and only the first is a computation:

  - solo, from the variant's own SoloWinner. Classical's is SCCountWinner(18):
    the clear leader, when nobody ties them and they hold the variant's number.
  - draw, which the game master records because the table agreed out loud. It
    is an enumerated, logged act (ADR-007) like forcing adjudication, and for
    the same reason: nothing prevents a game master ending a game early, and
    the log is what makes it visible.
  - the end year, for a round with a hard stop at 17:00.

An ended game freezes. No phase follows, no seat may order, no deadline arms,
and force adjudication is closed for good. What it gains is a result, on every
answer the server gives about it, including the public per-phase JSON — so a
finished game is citable at the same address as every other phase (ADR-028).

We publish the centre counts and declare nothing else. Scoring is not our job
(DESIGN.md §1); dipvis does that, and ADR-046 feeds it.
*/
package app

import (
	"encoding/json"
	"net/http"
	"sort"
	"strings"

	"github.com/zond/godip"
)

// How a game ended. These strings are in the published JSON, so they are
// part of what a reader may match on.
const (
	resultSolo    = "solo"
	resultDraw    = "draw"
	resultEndYear = "endYear"
)

/*
gameResult is how a game ended and where it stood when it did.

Centres is the whole board, every power, zeros included, because a reader
counting survivors needs to see the eliminated ones as eliminated rather than
as absent. Powers is who the ending names: the winner of a solo, the powers
that agreed a draw, everybody still holding a centre at the end year.
*/
type gameResult struct {
	Kind    string         `json:"kind"`
	Powers  []string       `json:"powers"`
	Centres map[string]int `json:"centres"`
	Year    int            `json:"year"`
	// PhaseIndex is how many phases had resolved when the game ended, which
	// is the index of the last phase a /watch link can show.
	PhaseIndex int `json:"phaseIndex"`
}

// drawProposal is a draw that excludes one or more surviving powers. Powers
// are the proposed participants; Required are the survivors whose explicit
// consent is needed, and Confirmed is the durable audit trail of those replies.
type drawProposal struct {
	Powers    []string `json:"powers"`
	Required  []string `json:"required"`
	Confirmed []string `json:"confirmed"`
}

// over reports whether the game has ended. Everything that could change the
// board asks this first.
func (self *flow) over() bool {
	return self.result != nil
}

// centreCounts counts supply centres per power on the board as it stands,
// naming every power of the variant so an eliminated one reads as zero.
// The caller must hold g.mu.
func (self *game) centreCounts() map[string]int {
	out := map[string]int{}
	for _, p := range self.flow.powers {
		out[string(p)] = 0
	}
	for _, nation := range self.state.SupplyCenters() {
		if nation == "" {
			continue
		}
		out[string(nation)]++
	}
	return out
}

// survivors are the powers still holding at least one supply centre, in the
// variant's own order. The caller must hold g.mu.
func (self *game) survivors() []godip.Nation {
	counts := self.centreCounts()
	out := []godip.Nation{}
	for _, p := range self.flow.powers {
		if counts[string(p)] > 0 {
			out = append(out, p)
		}
	}
	return out
}

/*
endGame freezes the game and records how it ended. The caller must hold g.mu.

Clearing the deadline is what stops the clock on every screen at once: the
countdown, the grace period and canForce all read it. A game that has ended
twice is a bug somewhere else, so the first ending wins and the second is
ignored rather than overwritten.
*/
func (self *game) endGame(id, kind string, powers []godip.Nation, year int) {
	f := self.flow
	if f.over() {
		return
	}
	names := make([]string, 0, len(powers))
	for _, p := range powers {
		names = append(names, string(p))
	}
	sort.Strings(names)
	f.result = &gameResult{
		Kind:       kind,
		Powers:     names,
		Centres:    self.centreCounts(),
		Year:       year,
		PhaseIndex: f.phaseIndex,
	}
	f.drawProposal = nil
	f.deadlineAt = nil
	f.logEvent(id, "the game is over: %v in %v, %v", kind, year, strings.Join(names, ", "))
}

/*
checkEnd asks whether the phase that just resolved was the last one.

It runs at the end of every adjudication, on the live path only. A restored
game reads its result from the row it was written to instead, because a draw
is an act and no amount of replaying orders will find it.

playedYear is the year of the phase that resolved. The board has already
moved on by the time this runs, so the year on it is the next one, and that
difference is the end-year test: the year is over exactly when the board has
left it. The caller must hold g.mu.
*/
func (self *game) checkEnd(id string, playedYear int) {
	f := self.flow
	if f.over() {
		return
	}
	if self.variant.SoloWinner != nil {
		if winner := self.variant.SoloWinner(self.state); winner != "" {
			self.endGame(id, resultSolo, []godip.Nation{winner}, playedYear)
			return
		}
	}
	// Dated by the phase that played, not by the setting. The two agree on a
	// classical board, where the year the game leaves is the year it ends in,
	// and they part on a board whose years step (Hundred moves five at a time)
	// and whenever a game master lowers the end year past the board. The
	// result names a year the game was in.
	if end := f.settings.EndYear; end > 0 && self.state.Phase().Year() > end {
		self.endGame(id, resultEndYear, self.survivors(), playedYear)
	}
}

// drawRequest is the game master naming who is in the draw.
type drawRequest struct {
	Powers []string `json:"powers"`
}

func (self *drawProposal) allConfirmed() bool {
	seen := map[string]bool{}
	for _, power := range self.Confirmed {
		seen[power] = true
	}
	for _, power := range self.Required {
		if !seen[power] {
			return false
		}
	}
	return true
}

/*
handleGMDraw records a DIAS draw immediately, or opens a proposal that needs
the explicit consent of every surviving power it excludes (ADR-052).
*/
func handleGMDraw(g *game, id string, w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeErr(w, http.StatusMethodNotAllowed, "POST only")
		return
	}
	body := drawRequest{}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "bad body: %v", err)
		return
	}

	g.mu.Lock()
	defer g.mu.Unlock()
	f := g.flow

	if !f.started {
		writeErr(w, http.StatusConflict, "the game has not started")
		return
	}
	if f.over() {
		writeErr(w, http.StatusConflict, "the game is already over")
		return
	}
	if len(body.Powers) == 0 {
		writeErr(w, http.StatusBadRequest, "name the powers in the draw")
		return
	}

	counts := g.centreCounts()
	seen := map[godip.Nation]bool{}
	powers := []godip.Nation{}
	for _, name := range body.Powers {
		p := godip.Nation(name)
		if _, found := f.seats[p]; !found {
			writeErr(w, http.StatusBadRequest, "%v is not a power in this game", name)
			return
		}
		if seen[p] {
			writeErr(w, http.StatusBadRequest, "%v is named twice", name)
			return
		}
		if counts[name] == 0 {
			writeErr(w, http.StatusBadRequest, "%v holds no supply centre", name)
			return
		}
		seen[p] = true
		powers = append(powers, p)
	}

	sort.Slice(powers, func(i, j int) bool { return powers[i] < powers[j] })
	survivors := g.survivors()
	if len(powers) == len(survivors) {
		g.endGame(id, resultDraw, powers, g.state.Phase().Year())
	} else {
		required := []string{}
		for _, power := range survivors {
			if !seen[power] {
				required = append(required, string(power))
			}
		}
		names := nations(powers)
		sort.Strings(names)
		sort.Strings(required)
		f.drawProposal = &drawProposal{Powers: names, Required: required, Confirmed: []string{}}
		f.logEvent(id, "GM proposed draw for %v; awaiting consent from %v",
			strings.Join(names, ", "), strings.Join(required, ", "))
	}
	g.persist(id)
	writeJSON(w, http.StatusOK, g.gmState(id, r))
}

// handleGMDrawWithdraw cancels an unresolved proposal. It cannot undo a draw.
func handleGMDrawWithdraw(g *game, id string, w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeErr(w, http.StatusMethodNotAllowed, "POST only")
		return
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.flow.drawProposal == nil {
		writeErr(w, http.StatusConflict, "there is no draw proposal to withdraw")
		return
	}
	g.flow.logEvent(id, "GM withdrew the draw proposal")
	g.flow.drawProposal = nil
	g.persist(id)
	writeJSON(w, http.StatusOK, g.gmState(id, r))
}

// handleSeatDrawResponse accepts or rejects exclusion from a proposed draw.
func handleSeatDrawResponse(g *game, id string, power godip.Nation, w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeErr(w, http.StatusMethodNotAllowed, "POST only")
		return
	}
	body := struct {
		Accept bool `json:"accept"`
	}{}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "bad body: %v", err)
		return
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	f := g.flow
	proposal := f.drawProposal
	if proposal == nil || f.over() {
		writeErr(w, http.StatusConflict, "there is no draw proposal to answer")
		return
	}
	name := string(power)
	required := false
	for _, candidate := range proposal.Required {
		if candidate == name {
			required = true
			break
		}
	}
	if !required {
		writeErr(w, http.StatusForbidden, "%v is included in this draw and has no exclusion to confirm", power)
		return
	}
	if !body.Accept {
		f.logEvent(id, "%v rejected the draw proposal", power)
		f.drawProposal = nil
		g.persist(id)
		writeJSON(w, http.StatusOK, g.seatState(id, power, r))
		return
	}
	for _, confirmed := range proposal.Confirmed {
		if confirmed == name {
			writeJSON(w, http.StatusOK, g.seatState(id, power, r))
			return
		}
	}
	proposal.Confirmed = append(proposal.Confirmed, name)
	sort.Strings(proposal.Confirmed)
	f.logEvent(id, "%v consented to exclusion from the draw", power)
	if proposal.allConfirmed() {
		powers := make([]godip.Nation, 0, len(proposal.Powers))
		for _, included := range proposal.Powers {
			powers = append(powers, godip.Nation(included))
		}
		g.endGame(id, resultDraw, powers, g.state.Phase().Year())
	}
	g.persist(id)
	writeJSON(w, http.StatusOK, g.seatState(id, power, r))
}
