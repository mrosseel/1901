package app

import (
	"testing"

	"github.com/zond/godip"
	"github.com/zond/godip/variants/classical"
)

// watchTestGame is a started classical game with every seat claimed, playing
// with no database behind it.
func watchTestGame(t *testing.T) *game {
	t.Helper()
	f, err := newFlow(settings{}.normalised(), classical.ClassicalVariant)
	if err != nil {
		t.Fatal(err)
	}
	g, err := newGame("classical", classical.ClassicalVariant)
	if err != nil {
		t.Fatal(err)
	}
	g.flow = f
	for i, power := range f.powers {
		s := f.seats[power]
		s.token = string(rune('a'+i)) + "-token"
		f.bySeatToken[s.token] = power
	}
	f.started = true
	return g
}

func TestWatchShowsAResolvedPhaseWholeAndTheCurrentOneBare(t *testing.T) {
	g := watchTestGame(t)

	// Spring 1901: two real orders, and one power that never locks.
	if err := g.setOrder(godip.Province("bud"), []string{"Move", "ser"}); err != nil {
		t.Fatal(err)
	}
	if err := g.setOrder(godip.Province("mun"), []string{"Move", "ruh"}); err != nil {
		t.Fatal(err)
	}
	for _, power := range g.flow.powers {
		if power == "Austria" {
			continue // the NMR
		}
		seatIn(g, power)
	}
	if err := g.adjudicate("game", true); err != nil {
		t.Fatal(err)
	}

	// The resolved phase: everything is public, orders included.
	past, found := g.watchState("game", 0)
	if !found {
		t.Fatal("phase 0 is not watchable")
	}
	if !past.Adjudicated || past.Current {
		t.Error("phase 0 should read as adjudicated and not current")
	}
	if past.Phase.Season != "Spring" || past.Phase.Type != "Movement" {
		t.Errorf("got %v %v", past.Phase.Season, past.Phase.Type)
	}
	if len(past.Units) != 22 {
		t.Errorf("got %v units, want classical's 22 at the start", len(past.Units))
	}
	// Austria's order was dropped by the NMR; Germany's was applied.
	if _, present := past.Orders["mun"]; !present {
		t.Errorf("the applied orders are missing from the resolved phase: %v", past.Orders)
	}
	if past.Powers["mun"] != "Germany" {
		t.Errorf("got %q, want Germany", past.Powers["mun"])
	}
	if len(past.Resolutions) == 0 {
		t.Error("a resolved phase must carry its resolutions")
	}
	if len(past.NMR) != 1 || past.NMR[0] != "Austria" {
		t.Errorf("got NMR %v, want [Austria]", past.NMR)
	}

	// The phase now being played: the board and the clock, and no order of
	// any kind. This endpoint has no token and cannot know who is asking.
	// On to a movement phase, where an ordinary unit has an order to give.
	for g.state.Phase().Type() != godip.Movement {
		for _, power := range g.flow.powers {
			seatIn(g, power)
		}
		if err := g.adjudicate("game", false); err != nil {
			t.Fatal(err)
		}
	}
	drafted := false
	for prov := range g.state.Units() {
		if err := g.setOrder(prov, []string{"Hold"}); err == nil {
			drafted = true
			break
		}
	}
	if !drafted {
		t.Fatal("no draft order could be entered, so the leak check would prove nothing")
	}
	now, found := g.watchState("game", g.flow.phaseIndex)
	if !found {
		t.Fatal("the current phase is not watchable")
	}
	if !now.Current || now.Adjudicated {
		t.Error("the current phase should read as current and not adjudicated")
	}
	if len(now.Orders) != 0 || len(now.OrderParts) != 0 || len(now.Powers) != 0 {
		t.Errorf("the current phase leaked draft orders: %v", now.Orders)
	}
	if len(now.Units) == 0 || len(now.SupplyCenters) == 0 {
		t.Error("the current phase must still show the board")
	}
	if now.Locked == nil {
		t.Error("the current phase must show who has locked")
	}
	if now.PhaseCount != g.flow.phaseIndex+1 {
		t.Errorf("phaseCount %v, want %v", now.PhaseCount, g.flow.phaseIndex+1)
	}
}

// A spectator link is most often opened before the game runs, so the answer
// has to say so and carry the count the table is watching — and nothing more.
func TestWatchCountsTheSeatsBeforeTheGameStarts(t *testing.T) {
	g := watchTestGame(t)
	g.flow.started = false
	joined := 0
	for i, power := range g.flow.powers {
		if i < 2 {
			joined++
			continue
		}
		s := g.flow.seats[power]
		delete(g.flow.bySeatToken, s.token)
		s.token = ""
	}

	now, found := g.watchState("game", 0)
	if !found {
		t.Fatal("the phase being played is not watchable")
	}
	if now.Started {
		t.Error("started must be false before the game runs")
	}
	if now.JoinedCount != joined || now.SeatsToFill != g.flow.joinerSeats() {
		t.Errorf("joined %v of %v, want %v of %v",
			now.JoinedCount, now.SeatsToFill, joined, g.flow.joinerSeats())
	}
	if len(now.Orders) != 0 || len(now.Powers) != 0 {
		t.Error("the phase being played must carry no orders")
	}
}

// TestWatchCarriesTheGameName: the spectator screen is the one screen read
// across a room, and an id names nothing there (ADR-042).
func TestWatchCarriesTheGameName(t *testing.T) {
	g := watchTestGame(t)
	g.flow.settings.Name = "Thursday table"

	now, found := g.watchState("game", 0)
	if !found {
		t.Fatal("the phase being played is not watchable")
	}
	if now.Name != "Thursday table" {
		t.Errorf("name %q, want the game's own", now.Name)
	}

	g.flow.settings.Name = ""
	bare, _ := g.watchState("game", 0)
	if bare.Name != "" {
		t.Errorf("an unnamed game answered with %q", bare.Name)
	}
}

func TestWatchRefusesAPhaseThatHasNotHappened(t *testing.T) {
	g := watchTestGame(t)
	for _, index := range []int{-1, 1, 99} {
		if _, found := g.watchState("game", index); found {
			t.Errorf("phase %v answered before it existed", index)
		}
	}
	if _, found := g.watchState("game", 0); !found {
		t.Error("the phase being played must be watchable")
	}
}
