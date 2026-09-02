// A game ends: a solo, an agreed draw, or the end year (ADR-044).
package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/zond/godip"
	"github.com/zond/godip/variants/classical"
)

/*
giveCentres hands one power enough of the board to have soloed.

Playing eighteen centres out at the table would take a hundred orders and
would be a test of godip rather than of the ending. The position is set
directly instead: ownership is what SoloWinner reads, and this is the same
call the DATC harness uses to stand a case up.
*/
func giveCentres(t *testing.T, g *game, power godip.Nation, want int) {
	t.Helper()
	// Everything this power is not given goes to one other power. Leaving the
	// rest as they were would count wrong: an owned centre that stayed with
	// this power would be an extra one on top of `want`, and which centres
	// those are depends on the order a Go map ranges in.
	var other godip.Nation
	for _, p := range g.flow.powers {
		if p != power {
			other = p
			break
		}
	}
	owners := map[godip.Province]godip.Nation{}
	given := 0
	for prov := range g.state.SupplyCenters() {
		if given < want {
			owners[prov] = power
			given++
			continue
		}
		owners[prov] = other
	}
	if given < want {
		t.Fatalf("the board has %v supply centres owned, want at least %v", given, want)
	}
	g.state.SetSupplyCenters(owners)
}

func TestASoloEndsTheGame(t *testing.T) {
	g := watchTestGame(t)
	giveCentres(t, g, "France", 18)
	lockAll(t, g, "game")

	result := g.flow.result
	if result == nil {
		t.Fatal("eighteen centres and the game is still running")
	}
	if result.Kind != resultSolo {
		t.Errorf("kind is %q, want %q", result.Kind, resultSolo)
	}
	if len(result.Powers) != 1 || result.Powers[0] != "France" {
		t.Errorf("powers are %v, want [France]", result.Powers)
	}
	if result.Centres["France"] != 18 {
		t.Errorf("France is recorded with %v centres, want 18", result.Centres["France"])
	}
	if result.Year != 1901 {
		t.Errorf("the solo is dated %v, want 1901", result.Year)
	}
	// Every power of the variant is named, so an eliminated one reads as
	// eliminated rather than as missing.
	if len(result.Centres) != len(g.flow.powers) {
		t.Errorf("the count names %v powers, want %v", len(result.Centres), len(g.flow.powers))
	}
	if g.flow.deadlineAt != nil {
		t.Error("the clock is still running on a finished game")
	}
}

func TestAnEndedGameStopsAdjudicating(t *testing.T) {
	g := watchTestGame(t)
	giveCentres(t, g, "France", 18)
	lockAll(t, g, "game")

	phase := g.state.Phase()
	before := g.flow.phaseIndex
	// Every seat is locked from the adjudication that ended the game, so
	// without the guard enterPhase would resolve straight on.
	for _, p := range g.flow.powers {
		seatIn(g, p)
	}
	if err := g.enterPhase("game"); err != nil {
		t.Fatal(err)
	}
	if g.flow.phaseIndex != before {
		t.Errorf("the board moved from phase %v to %v after the game ended", before, g.flow.phaseIndex)
	}
	if g.state.Phase() != phase {
		t.Error("the phase changed after the game ended")
	}
	if g.flow.canForce() {
		t.Error("force adjudication is armed on a finished game")
	}
}

func TestTheEndYearStopsTheGame(t *testing.T) {
	g := watchTestGame(t)
	g.flow.settings.EndYear = 1901

	// Nobody orders anything, so 1901 runs to its adjustment and out.
	for i := 0; i < 6 && !g.flow.over(); i++ {
		lockAll(t, g, "game")
	}

	result := g.flow.result
	if result == nil {
		t.Fatalf("the game is still running, now at %v %v",
			g.state.Phase().Season(), g.state.Phase().Year())
	}
	if result.Kind != resultEndYear {
		t.Errorf("kind is %q, want %q", result.Kind, resultEndYear)
	}
	if result.Year != 1901 {
		t.Errorf("the ending is dated %v, want the end year 1901", result.Year)
	}
	// Nobody was eliminated in a year nobody moved in.
	if len(result.Powers) != len(g.flow.powers) {
		t.Errorf("%v survivors, want all %v", len(result.Powers), len(g.flow.powers))
	}
}

// A game master shortening a round that has overrun lowers the end year below
// the board. The game ends at the next adjudication, and the result is dated
// by the phase that played, not by the year that was typed.
func TestALoweredEndYearIsDatedByThePhaseThatPlayed(t *testing.T) {
	g := watchTestGame(t)
	g.flow.settings.EndYear = 1900

	lockAll(t, g, "game")

	result := g.flow.result
	if result == nil {
		t.Fatal("the game is still running")
	}
	if result.Kind != resultEndYear {
		t.Errorf("kind is %q, want %q", result.Kind, resultEndYear)
	}
	if result.Year != 1901 {
		t.Errorf("the ending is dated %v, want 1901, the year that was played",
			result.Year)
	}
}

// gmRequest posts to one of the game master's routes and returns the recorder.
func gmRequest(g *game, id, route, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, "/"+route, strings.NewReader(body))
	rec := httptest.NewRecorder()
	gmRoutes[route](g, id, rec, req)
	return rec
}

func TestANonDIASDrawNeedsEveryExcludedSurvivor(t *testing.T) {
	g := watchTestGame(t)

	rec := gmRequest(g, "game", "draw", `{"powers":["France","England"]}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("draw refused: %v %v", rec.Code, rec.Body.String())
	}
	if g.flow.result != nil {
		t.Fatal("the proposal ended the game before excluded survivors consented")
	}
	proposal := g.flow.drawProposal
	if proposal == nil || len(proposal.Required) != 5 {
		t.Fatalf("proposal is %#v, want five excluded survivors", proposal)
	}
	for _, power := range proposal.Required {
		req := httptest.NewRequest(http.MethodPost, "/draw-response", strings.NewReader(`{"accept":true}`))
		rec := httptest.NewRecorder()
		handleSeatDrawResponse(g, "game", godip.Nation(power), rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("%v could not confirm: %v %v", power, rec.Code, rec.Body.String())
		}
	}
	result := g.flow.result
	if result == nil {
		t.Fatal("the draw did not end after every excluded survivor consented")
	}
	if result.Kind != resultDraw {
		t.Errorf("kind is %q, want %q", result.Kind, resultDraw)
	}
	// Sorted, so the same draw always reads the same way.
	if len(result.Powers) != 2 || result.Powers[0] != "England" || result.Powers[1] != "France" {
		t.Errorf("powers are %v, want [England France]", result.Powers)
	}

	// And a second ending cannot overwrite the first.
	rec = gmRequest(g, "game", "draw", `{"powers":["Italy"]}`)
	if rec.Code != http.StatusConflict {
		t.Errorf("a second draw answered %v, want 409", rec.Code)
	}
}

func TestADrawProposalPublishesALiveUpdate(t *testing.T) {
	g := watchTestGame(t)
	_, events, _, unsubscribe, ok := g.events.subscribe(eventAudiencePublic, "")
	if !ok {
		t.Fatal("could not subscribe the public view")
	}
	defer unsubscribe()

	rec := gmRequest(g, "game", "draw", `{"powers":["France","England"]}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("draw refused: %v %v", rec.Code, rec.Body.String())
	}
	select {
	case event := <-events:
		if event.Type != "state" || event.Version == 0 {
			t.Fatalf("draw notification is %#v", event)
		}
	default:
		t.Fatal("the draw proposal did not notify connected players")
	}
}

func TestADIASDrawIsRecordedDirectly(t *testing.T) {
	g := watchTestGame(t)
	rec := gmRequest(g, "game", "draw",
		`{"powers":["Austria","England","France","Germany","Italy","Russia","Turkey"]}`)
	if rec.Code != http.StatusOK || g.flow.result == nil {
		t.Fatalf("DIAS draw was not recorded: %v %v", rec.Code, rec.Body.String())
	}
}

func TestAnExcludedSurvivorCanRejectTheProposal(t *testing.T) {
	g := watchTestGame(t)
	gmRequest(g, "game", "draw", `{"powers":["France","England"]}`)
	req := httptest.NewRequest(http.MethodPost, "/draw-response", strings.NewReader(`{"accept":false}`))
	rec := httptest.NewRecorder()
	handleSeatDrawResponse(g, "game", "Austria", rec, req)
	if rec.Code != http.StatusOK || g.flow.drawProposal != nil || g.flow.result != nil {
		t.Fatalf("rejection did not cancel proposal: %v %v", rec.Code, rec.Body.String())
	}
}

func TestADrawRefusesAPowerWithNothingLeft(t *testing.T) {
	g := watchTestGame(t)
	// France holds every centre, so nobody else is in a position to draw.
	giveCentres(t, g, "France", len(g.state.SupplyCenters()))

	for _, body := range []string{
		`{"powers":[]}`,
		`{"powers":["Italy"]}`,
		`{"powers":["France","France"]}`,
		`{"powers":["Atlantis"]}`,
	} {
		rec := gmRequest(g, "game", "draw", body)
		if rec.Code != http.StatusBadRequest {
			t.Errorf("%v answered %v, want 400", body, rec.Code)
		}
	}
	if g.flow.over() {
		t.Error("a refused draw ended the game anyway")
	}
}

func TestAFinishedGameTakesNoMoreOrders(t *testing.T) {
	g := watchTestGame(t)
	giveCentres(t, g, "France", 18)
	lockAll(t, g, "game")

	req := httptest.NewRequest(http.MethodPost, "/order",
		strings.NewReader(`{"province":"par","parts":["Hold"]}`))
	rec := httptest.NewRecorder()
	handleSeatOrder(g, "game", "France", rec, req)
	if rec.Code != http.StatusConflict {
		t.Errorf("an order on a finished game answered %v, want 409", rec.Code)
	}

	req = httptest.NewRequest(http.MethodPost, "/lock", nil)
	rec = httptest.NewRecorder()
	handleSeatLock(g, "game", "France", rec, req)
	if rec.Code != http.StatusConflict {
		t.Errorf("a lock on a finished game answered %v, want 409", rec.Code)
	}

	req = httptest.NewRequest(http.MethodPost, "/extend", strings.NewReader(`{"minutes":5}`))
	rec = httptest.NewRecorder()
	handleGMExtend(g, "game", rec, req)
	if rec.Code != http.StatusConflict {
		t.Errorf("extending a finished game answered %v, want 409", rec.Code)
	}
}

// TestTheResultIsOnEveryAnswer: a finished game says so wherever it is read,
// including the public per-phase feed, so a citation of one phase carries it.
func TestTheResultIsOnEveryAnswer(t *testing.T) {
	g := watchTestGame(t)
	giveCentres(t, g, "France", 18)
	lockAll(t, g, "game")

	r := httptest.NewRequest(http.MethodGet, "/", nil)
	if got := g.seatState("game", "France", r).Result; got == nil {
		t.Error("the seat is not told the game is over")
	}
	if got := g.gmState("game", r).Result; got == nil {
		t.Error("the game master is not told the game is over")
	}
	for index := 0; index <= g.flow.phaseIndex; index++ {
		state, found := g.watchState("game", index)
		if !found {
			t.Fatalf("phase %v is missing from the feed", index)
		}
		if state.Result == nil {
			t.Errorf("the spectator feed for phase %v does not carry the result", index)
		}
	}

	rec := httptest.NewRecorder()
	handlePublic(g, "game", rec, r)
	body := struct {
		Result *gameResult `json:"result"`
	}{}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Result == nil {
		t.Error("the public summary does not carry the result")
	}
}

// TestTheResultSurvivesARestart: both pending consent and the resulting draw
// are acts, not computations. Replaying orders cannot recover either one.
func TestTheResultSurvivesARestart(t *testing.T) {
	path := filepath.Join(t.TempDir(), "ended.db")
	handle, err := openDB(path)
	if err != nil {
		t.Fatalf("openDB: %v", err)
	}
	saved := db
	db = handle
	t.Cleanup(func() {
		db = saved
		handle.Close()
		games.mu.Lock()
		games.games = map[string]*game{}
		games.mu.Unlock()
	})

	f, err := newFlow(defaultSettings(), classical.ClassicalVariant)
	if err != nil {
		t.Fatal(err)
	}
	g, id, err := games.create("classical", classical.ClassicalVariant, f)
	if err != nil {
		t.Fatal(err)
	}
	for i, power := range f.powers {
		s := f.seats[power]
		s.token = string(rune('a'+i)) + "-token"
		f.bySeatToken[s.token] = power
	}
	f.started = true
	f.settings.EndYear = 1908

	if rec := gmRequest(g, id, "draw", `{"powers":["England","France"]}`); rec.Code != http.StatusOK {
		t.Fatalf("draw refused: %v %v", rec.Code, rec.Body.String())
	}

	games.mu.Lock()
	games.games = map[string]*game{}
	games.mu.Unlock()
	if err := loadAll(); err != nil {
		t.Fatalf("loadAll: %v", err)
	}
	restored, found := games.lookup(id)
	if !found {
		t.Fatal("the finished game did not come back")
	}
	if restored.flow.result != nil || restored.flow.drawProposal == nil {
		t.Fatal("the pending draw proposal did not survive the restart")
	}
	for _, power := range append([]string(nil), restored.flow.drawProposal.Required...) {
		req := httptest.NewRequest(http.MethodPost, "/draw-response", strings.NewReader(`{"accept":true}`))
		rec := httptest.NewRecorder()
		handleSeatDrawResponse(restored, id, godip.Nation(power), rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("%v could not confirm after restart: %v", power, rec.Body.String())
		}
	}
	if restored.flow.result == nil {
		t.Fatal("confirmations after restart did not end the game")
	}

	games.mu.Lock()
	games.games = map[string]*game{}
	games.mu.Unlock()
	if err := loadAll(); err != nil {
		t.Fatalf("second loadAll: %v", err)
	}
	restored, found = games.lookup(id)
	if !found || restored.flow.result == nil {
		t.Fatal("the finished game did not come back")
	}
	result := restored.flow.result
	if result.Kind != resultDraw {
		t.Errorf("kind came back %q, want %q", result.Kind, resultDraw)
	}
	if len(result.Powers) != 2 || result.Powers[0] != "England" {
		t.Errorf("powers came back %v, want [England France]", result.Powers)
	}
	if restored.flow.settings.EndYear != 1908 {
		t.Errorf("the end year came back %v, want 1908", restored.flow.settings.EndYear)
	}
	// Counted from the replayed board rather than read from a row, and it
	// has to agree with what was written.
	if len(result.Centres) != len(restored.flow.powers) {
		t.Errorf("the restored count names %v powers, want %v",
			len(result.Centres), len(restored.flow.powers))
	}
	if result.Centres["France"] != 3 {
		t.Errorf("France came back with %v centres, want its opening 3", result.Centres["France"])
	}
}

// The summary every phone polls is what a seat on the fallback path reads, so
// an open proposal has to be in it. It carries no orders and names only powers.
func TestThePublicSummaryCarriesAnOpenDrawProposal(t *testing.T) {
	g := watchTestGame(t)
	if rec := gmRequest(g, "game", "draw", `{"powers":["France","England"]}`); rec.Code != http.StatusOK {
		t.Fatalf("draw refused: %v %v", rec.Code, rec.Body.String())
	}

	req := httptest.NewRequest(http.MethodGet, "/public", nil)
	rec := httptest.NewRecorder()
	handlePublic(g, "game", rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("public summary answered %v", rec.Code)
	}
	body := struct {
		DrawProposal *drawProposal `json:"drawProposal"`
	}{}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("public summary is not JSON: %v", err)
	}
	if body.DrawProposal == nil || len(body.DrawProposal.Required) != 5 {
		t.Fatalf("the summary carries %#v, want the open proposal", body.DrawProposal)
	}
}
