// Auto-lock: a seat whose power has no legal order this phase is locked
// by the server rather than by the player (D-034).
package main

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/zond/godip"
)

// lockedPowers lists the seats the server locked, in the flow's order.
func lockedPowers(g *game) []godip.Nation {
	out := []godip.Nation{}
	for _, p := range g.flow.powers {
		if g.flow.seats[p].autoLocked {
			out = append(out, p)
		}
	}
	return out
}

// lockAll locks every seat and adjudicates, the way a table that all
// locked in does.
func lockAll(t *testing.T, g *game, id string) {
	t.Helper()
	for _, p := range g.flow.powers {
		g.flow.seats[p].locked = true
	}
	if err := g.adjudicate(id, false); err != nil {
		t.Fatal(err)
	}
}

func order(t *testing.T, g *game, prov string, parts ...string) {
	t.Helper()
	if err := g.setOrder(godip.Province(prov), parts); err != nil {
		t.Fatalf("%v: %v", prov, err)
	}
}

/*
dislodgedRetreat plays classical into Fall 1901 Retreat with exactly one
dislodged unit: Austria walks to Trieste and Tyrolia in the spring, then takes
Venice with support, and Italy's army there has to go somewhere.
*/
func dislodgedRetreat(t *testing.T, g *game, id string) {
	t.Helper()
	order(t, g, "vie", "Move", "tyr")
	order(t, g, "bud", "Move", "tri")
	order(t, g, "tri", "Move", "alb")
	lockAll(t, g, id)

	order(t, g, "tri", "Move", "ven")
	order(t, g, "tyr", "Support", "tri", "ven")
	order(t, g, "ven", "Hold")
	lockAll(t, g, id)

	if got := g.state.Phase().Type(); got != godip.Retreat {
		t.Fatalf("phase is %v, want a retreat phase", got)
	}
	if len(g.state.Dislodgeds()) != 1 {
		t.Fatalf("got %v dislodged units, want 1: %v", len(g.state.Dislodgeds()), g.state.Dislodgeds())
	}
}

func TestARetreatLocksEveryPowerThatWasNotDislodged(t *testing.T) {
	g := watchTestGame(t)
	dislodgedRetreat(t, g, "game")

	for _, p := range g.flow.powers {
		s := g.flow.seats[p]
		want := p != "Italy"
		if s.autoLocked != want || s.locked != want {
			t.Errorf("%v: locked=%v autoLocked=%v, want %v", p, s.locked, s.autoLocked, want)
		}
	}

	// Six of seven are in, and the seventh is the only player the phase
	// asked anything of. The GM is not offered a force button for that.
	if got := g.flow.lockedCount(); got != 6 {
		t.Errorf("got %v seats in, want 6", got)
	}
	if got := g.flow.activeSeats(); got != 7 {
		t.Errorf("got %v active seats, want 7 — an auto-locked seat is still a seat", got)
	}
	if g.flow.canForce() {
		t.Error("the auto-lock armed force adjudication on its own")
	}

	// And the screen is told which of the two states it is in.
	r := httptest.NewRequest(http.MethodGet, "/", nil)
	if state := g.seatState("game", "Austria", r); !state.NothingToOrder || !state.YouLocked {
		t.Errorf("Austria's seat reads nothingToOrder=%v youLocked=%v",
			state.NothingToOrder, state.YouLocked)
	}
	if state := g.seatState("game", "Italy", r); state.NothingToOrder || state.YouLocked {
		t.Errorf("Italy's seat reads nothingToOrder=%v youLocked=%v",
			state.NothingToOrder, state.YouLocked)
	}
}

func TestAnAdjustmentLocksThePowersWhoseCentresMatchTheirUnits(t *testing.T) {
	g := watchTestGame(t)
	// Austria takes Serbia and so is owed a build. Nobody else moves, so
	// every other power ends 1901 with the three centres it started with.
	order(t, g, "bud", "Move", "ser")
	lockAll(t, g, "game")
	lockAll(t, g, "game")

	if got := g.state.Phase().Type(); got != godip.Adjustment {
		t.Fatalf("phase is %v, want an adjustment phase", got)
	}
	for _, p := range g.flow.powers {
		s := g.flow.seats[p]
		want := p != "Austria"
		if s.autoLocked != want {
			t.Errorf("%v: autoLocked=%v, want %v", p, s.autoLocked, want)
		}
	}
}

func TestAnEliminatedPowerIsLockedInAMovementPhase(t *testing.T) {
	g := watchTestGame(t)
	// Italy off the board: no units, no home centres, nothing to order in
	// any phase — including the movement phase that would otherwise wait
	// for it forever.
	for prov, unit := range g.state.Units() {
		if unit.Nation == "Italy" {
			g.state.RemoveUnit(prov)
		}
	}
	for prov, owner := range g.state.SupplyCenters() {
		if owner == "Italy" {
			g.state.SetSC(prov, "Austria")
		}
	}
	if err := g.enterPhase("game"); err != nil {
		t.Fatal(err)
	}

	if got := g.state.Phase().Type(); got != godip.Movement {
		t.Fatalf("phase is %v, want the movement phase", got)
	}
	if got := lockedPowers(g); len(got) != 1 || got[0] != "Italy" {
		t.Errorf("got %v locked, want [Italy]", got)
	}
	// Six players, not seven, and the phase still needs all six.
	if g.flow.lockedCount() != 1 || g.flow.canForce() {
		t.Errorf("in=%v canForce=%v", g.flow.lockedCount(), g.flow.canForce())
	}
}

func TestAPhaseNobodyCanOrderResolvesItself(t *testing.T) {
	g := watchTestGame(t)
	// Spring 1901 with no orders dislodges nobody, so the retreat phase
	// behind it asks the table for nothing. It must not be a screen that
	// seven players have to tap through.
	lockAll(t, g, "game")

	phase := g.state.Phase()
	if phase.Type() != godip.Movement || phase.Season() != godip.Fall {
		t.Fatalf("the board sits on %v %v %v, want Fall 1901 Movement",
			phase.Season(), phase.Year(), phase.Type())
	}
	if g.flow.phaseIndex != 2 {
		t.Errorf("got phaseIndex %v, want 2 — the empty retreat counts as adjudicated", g.flow.phaseIndex)
	}
	for _, p := range g.flow.powers {
		if s := g.flow.seats[p]; s.locked || s.autoLocked {
			t.Errorf("%v carried a lock into the new phase", p)
		}
	}
}

func TestAnAutoLockedSeatCannotBeUnlocked(t *testing.T) {
	g := watchTestGame(t)
	dislodgedRetreat(t, g, "game")

	post := func(power godip.Nation, want bool) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		g.seatLock("game", power, want, rec, httptest.NewRequest(http.MethodPost, "/", nil))
		return rec
	}

	rec := post("Austria", false)
	if rec.Code != http.StatusConflict {
		t.Errorf("unlocking an auto-locked seat: got %v, want 409: %v", rec.Code, rec.Body.String())
	}
	if !g.flow.seats["Austria"].locked {
		t.Error("the refused request unlocked the seat anyway")
	}

	// The one power the phase did ask still owns its own lock.
	if rec := post("Italy", true); rec.Code != http.StatusOK {
		t.Fatalf("Italy could not lock: %v %v", rec.Code, rec.Body.String())
	}
	if g.state.Phase().Type() == godip.Retreat {
		t.Error("the last player locked and the retreat phase did not resolve")
	}
}

func TestAutoLockSurvivesARestore(t *testing.T) {
	g, id := illegalTestGame(t, true)
	dislodgedRetreat(t, g, id)
	g.persist(id)
	logged := len(g.flow.events)

	games.mu.Lock()
	games.games = map[string]*game{}
	games.mu.Unlock()
	if err := loadAll(); err != nil {
		t.Fatal(err)
	}
	restored, found := games.lookup(id)
	if !found {
		t.Fatal("the game did not come back")
	}
	if got := restored.state.Phase().Type(); got != godip.Retreat {
		t.Fatalf("restored into %v, want the retreat phase", got)
	}
	for _, p := range restored.flow.powers {
		s := restored.flow.seats[p]
		want := p != "Italy"
		if s.autoLocked != want || s.locked != want {
			t.Errorf("%v after restore: locked=%v autoLocked=%v, want %v",
				p, s.locked, s.autoLocked, want)
		}
	}
	// The restore recomputes the locks from the replayed position, so it
	// must not write the lines the log already carries.
	if got := len(restored.flow.events); got != logged {
		t.Errorf("the restore grew the event log from %v to %v lines", logged, got)
	}
}
