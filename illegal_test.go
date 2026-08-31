package main

import (
	"net/http/httptest"
	"path/filepath"
	"testing"

	"github.com/zond/godip"
	"github.com/zond/godip/variants/classical"
)

// illegalTestGame is a started classical game with every seat claimed and
// illegal orders allowed, backed by a database in the test's own directory.
func illegalTestGame(t *testing.T, allow bool) (*game, string) {
	t.Helper()
	handle, err := openDB(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	saved := db
	db = handle
	t.Cleanup(func() {
		handle.Close()
		db = saved
		games.mu.Lock()
		games.games = map[string]*game{}
		games.mu.Unlock()
	})

	s := defaultSettings()
	s.IllegalMoves = allow
	f, err := newFlow(s, classical.ClassicalVariant)
	if err != nil {
		t.Fatal(err)
	}
	g, id, err := games.create("classical", classical.ClassicalVariant, f)
	if err != nil {
		t.Fatal(err)
	}
	for i, power := range f.powers {
		seat := f.seats[power]
		seat.token = string(rune('a'+i)) + "-token"
		f.bySeatToken[seat.token] = power
	}
	f.started = true
	g.persist(id)
	return g, id
}

// The misorder every one of these tests uses: Vienna, which is Austrian and
// landlocked in the middle of the board, ordered to Paris. It parses — both
// are provinces of this variant and Move takes two of them — and no rule of
// Diplomacy lets it happen.
var (
	vienna  = godip.Province("vie")
	toParis = []string{"Move", "par"}
)

func TestIllegalOrderIsKeptAndStruck(t *testing.T) {
	g, id := illegalTestGame(t, true)

	// A legal order from one power, a misorder from another.
	if err := g.setOrder(godip.Province("mun"), []string{"Move", "ruh"}); err != nil {
		t.Fatalf("the legal order was refused: %v", err)
	}
	if err := g.setOrder(vienna, toParis); err != nil {
		t.Fatalf("with illegalMoves on, a misorder must be accepted: %v", err)
	}

	// It is stored as written, marked, and out of the engine.
	if !g.illegal[vienna] {
		t.Fatal("the misorder was not marked illegal")
	}
	if g.owner[vienna] != "Austria" {
		t.Errorf("owner %q, want Austria", g.owner[vienna])
	}
	if got := g.describe(vienna, g.parts[vienna]); got != "Army Vienna Move Paris" {
		t.Errorf("the written order reads %q", got)
	}
	if _, present := g.state.Orders()[vienna]; present {
		t.Error("the misorder reached the engine's order set")
	}
	if _, present := g.state.Orders()[godip.Province("mun")]; !present {
		t.Error("the legal order did not reach the engine")
	}

	// A seat sees its own misorder marked, and nobody else's.
	view := httptest.NewRequest("GET", "/game/"+id+"/seat/x/state", nil)
	austria := g.seatState(id, "Austria", view)
	if len(austria.Illegal) != 1 || austria.Illegal[0] != "vie" {
		t.Errorf("Austria's own view: got illegal %v, want [vie]", austria.Illegal)
	}
	if got := g.seatState(id, "England", view).Illegal; len(got) != 0 {
		t.Errorf("England was told which provinces Austria misordered: %v", got)
	}

	// Adjudicate with everybody locked, so the NMR list stays empty.
	for _, power := range g.flow.powers {
		g.flow.seats[power].locked = true
	}
	if err := g.adjudicate(id, true); err != nil {
		t.Fatal(err)
	}

	review := g.previousPhase
	if review.Resolutions["vie"] != illegalResolution {
		t.Errorf("resolution %q, want %q", review.Resolutions["vie"], illegalResolution)
	}
	if review.Resolutions["mun"] != "OK" {
		t.Errorf("the legal order resolved %q, want OK", review.Resolutions["mun"])
	}
	if review.Orders["vie"] != "Army Vienna Move Paris" {
		t.Errorf("the review lost the written order: %q", review.Orders["vie"])
	}
	if review.Powers["vie"] != "Austria" {
		t.Errorf("the review lost the power: %q", review.Powers["vie"])
	}
	if len(review.Illegal) != 1 || review.Illegal[0] != "vie" {
		t.Errorf("review illegal list %v, want [vie]", review.Illegal)
	}
	if len(review.NMR) != 0 {
		t.Errorf("an illegal order is still an order: NMR %v, want none", review.NMR)
	}

	// The unit held, and the legal order moved.
	if unit, _, ok := g.state.Unit(vienna); !ok || unit.Nation != "Austria" {
		t.Error("the misordered unit did not hold in Vienna")
	}
	if _, _, ok := g.state.Unit(godip.Province("ruh")); !ok {
		t.Error("the legal move did not happen")
	}

	// And the public per-phase URL says the same thing.
	watch, found := g.watchState(id, 0)
	if !found {
		t.Fatal("phase 0 is not watchable")
	}
	if watch.Resolutions["vie"] != illegalResolution || len(watch.Illegal) != 1 {
		t.Errorf("watch: resolution %q, illegal %v", watch.Resolutions["vie"], watch.Illegal)
	}
}

func TestIllegalOrderSurvivesARestart(t *testing.T) {
	g, id := illegalTestGame(t, true)
	if err := g.setOrder(godip.Province("mun"), []string{"Move", "ruh"}); err != nil {
		t.Fatal(err)
	}
	if err := g.setOrder(vienna, toParis); err != nil {
		t.Fatal(err)
	}
	g.persist(id)

	// The process dies here. Everything below is what the next one reads.
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
	if !restored.illegal[vienna] {
		t.Fatal("the stored illegal order came back as something else, or not at all")
	}
	if restored.owner[vienna] != "Austria" {
		t.Errorf("owner %q, want Austria", restored.owner[vienna])
	}
	if _, present := restored.state.Orders()[vienna]; present {
		t.Error("replay put the misorder into the engine")
	}
	if !restored.flow.settings.IllegalMoves {
		t.Error("the setting did not survive the restart")
	}

	// Adjudicating after the restart must produce the same review.
	for _, power := range restored.flow.powers {
		restored.flow.seats[power].locked = true
	}
	if err := restored.adjudicate(id, true); err != nil {
		t.Fatal(err)
	}
	review := restored.previousPhase
	if review.Resolutions["vie"] != illegalResolution ||
		review.Orders["vie"] != "Army Vienna Move Paris" ||
		review.Resolutions["mun"] != "OK" {
		t.Errorf("the review after a restart differs: %v / %v", review.Orders, review.Resolutions)
	}
	if unit, _, ok := restored.state.Unit(vienna); !ok || unit.Nation != "Austria" {
		t.Error("the misordered unit did not hold after the restart")
	}
}

func TestStrictGameStillRefusesAMisorder(t *testing.T) {
	g, _ := illegalTestGame(t, false)
	if err := g.setOrder(vienna, toParis); err == nil {
		t.Fatal("with illegalMoves off a misorder must be refused")
	}
	if g.illegal[vienna] {
		t.Error("a refused order was stored anyway")
	}
	if _, present := g.parts[vienna]; present {
		t.Error("a refused order left parts behind")
	}
}

func TestAnOrderThatDoesNotParseIsAlwaysRefused(t *testing.T) {
	// The boundary: parsing is what turns words into an order at all. A
	// failure there means there is nothing coherent to store, whatever the
	// setting says, so it is a 400 in both modes.
	g, _ := illegalTestGame(t, true)
	for _, parts := range [][]string{
		{"Teleport", "par"}, // no such order type
		{"Move"},            // a move type with nowhere to move to
		{},                  // nothing at all
	} {
		if err := g.setOrder(vienna, parts); err == nil {
			t.Errorf("%v was accepted; it does not parse", parts)
		}
	}
	if len(g.parts) != 0 {
		t.Errorf("an unparseable order left something behind: %v", g.parts)
	}

	// What godip's parser checks is the order TYPE and the number of parts.
	// It does not check that a province exists, so a move to Atlantis parses
	// and fails validation, which makes it a misorder like any other.
	if err := g.setOrder(vienna, []string{"Move", "atlantis"}); err != nil {
		t.Fatalf("a move to a province that does not exist: %v", err)
	}
	if !g.illegal[vienna] {
		t.Error("it should have been kept as an illegal order")
	}
}

func TestReplacingAndCancellingAnIllegalOrder(t *testing.T) {
	g, _ := illegalTestGame(t, true)
	if err := g.setOrder(vienna, toParis); err != nil {
		t.Fatal(err)
	}
	// Replaced by a legal one: the mark goes with it.
	if err := g.setOrder(vienna, []string{"Move", "tri"}); err != nil {
		t.Fatal(err)
	}
	if g.illegal[vienna] {
		t.Error("the illegal mark outlived the order it belonged to")
	}
	if _, present := g.state.Orders()[vienna]; !present {
		t.Error("the replacement did not reach the engine")
	}
	// And back again, then cancelled.
	if err := g.setOrder(vienna, toParis); err != nil {
		t.Fatal(err)
	}
	if _, present := g.state.Orders()[vienna]; present {
		t.Error("replacing a legal order with a misorder left the old one in the engine")
	}
	g.clearOrder(vienna)
	if g.illegal[vienna] || len(g.parts) != 0 {
		t.Error("cancelling left the misorder behind")
	}
}

func TestIllegalMovesIsOnUnlessItIsTurnedOff(t *testing.T) {
	if !defaultSettings().IllegalMoves {
		t.Error("illegalMoves must default to on (ADR-029)")
	}
	// A patch that says nothing about it leaves it alone, in both
	// directions. This is why the envelope is a patch: a client that sends
	// {"deadlineMinutes":10} must not turn the setting off by omission.
	on := defaultSettings()
	minutes := 10
	patched := settingsEnvelope{settingsPatch: settingsPatch{DeadlineMinutes: &minutes}}.merge(on)
	if !patched.IllegalMoves {
		t.Error("a patch that never mentioned illegalMoves turned it off")
	}
	off := false
	patched = settingsEnvelope{settingsPatch: settingsPatch{IllegalMoves: &off}}.merge(on)
	if patched.IllegalMoves {
		t.Error("the GM could not turn illegalMoves off")
	}
	// The wrapped {"settings":{…}} shape is a patch too.
	patched = settingsEnvelope{Settings: &settingsPatch{DeadlineMinutes: &minutes}}.merge(on)
	if !patched.IllegalMoves {
		t.Error("the wrapped shape turned illegalMoves off by omission")
	}
}
