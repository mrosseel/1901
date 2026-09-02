// The sandbox (ADR-047): a board with no players, one link that drives it,
// and two authorization paths that never meet.
package app

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// makeSandbox creates a sandbox through POST /games and returns its id and
// the one token that drives it.
func makeSandbox(t *testing.T) (string, string) {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/games",
		strings.NewReader(`{"settings":{"sandbox":true}}`))
	rec := httptest.NewRecorder()
	handleCreateGame(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("create sandbox: got %v, want 200: %v", rec.Code, rec.Body.String())
	}
	var created struct {
		GameID     string `json:"gameId"`
		InviteURL  string `json:"inviteUrl"`
		SandboxURL string `json:"sandboxUrl"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}
	if created.InviteURL != "" {
		t.Errorf("a sandbox handed out an invite: %v", created.InviteURL)
	}
	if created.SandboxURL == "" {
		t.Fatal("the create response carries no sandbox url")
	}
	parts := strings.Split(strings.Trim(created.SandboxURL, "/"), "/")
	return created.GameID, parts[len(parts)-1]
}

// drive posts one action to the sandbox scope and returns the recorder.
func drive(t *testing.T, id, token, action, body string) *httptest.ResponseRecorder {
	t.Helper()
	path := "/api/v1/game/" + id + "/sandbox/" + token + "/" + action
	method := http.MethodPost
	if body == "" {
		method = http.MethodGet
	}
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	rec := httptest.NewRecorder()
	testServer(t).serveFlowAPI(rec, req, path)
	return rec
}

func TestSandboxOpensWithNoSeatsAndNoClock(t *testing.T) {
	id, _ := makeSandbox(t)
	g, found := games.lookup(id)
	if !found {
		t.Fatal("the sandbox is not in the registry")
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	f := g.flow

	if !f.started {
		t.Error("a sandbox is not open the moment it exists")
	}
	if f.activeSeats() != 0 || f.joinedCount() != 0 {
		t.Errorf("a sandbox has seats: %v active, %v joined", f.activeSeats(), f.joinedCount())
	}
	if f.deadlineAt != nil {
		t.Errorf("a sandbox has a deadline: %v", f.deadlineAt)
	}
	if f.settings.DeadlineMinutes != 0 || f.settings.GraceMinutes != 0 {
		t.Errorf("a sandbox kept a clock: %+v", f.settings)
	}
	if f.sealed {
		t.Error("a sandbox seals its orders — there is nobody to hide them from")
	}
	if f.canForce() {
		t.Error("a sandbox offers a forced adjudication")
	}
}

func TestSandboxDrivesEveryPowerAndAdjudicates(t *testing.T) {
	id, token := makeSandbox(t)

	// Two powers that will bounce, which is the shortest proof that the
	// orders reached the engine and that both of them were applied.
	for _, order := range []string{
		`{"power":"France","province":"par","parts":["Move","bur"]}`,
		`{"power":"Germany","province":"mun","parts":["Move","bur"]}`,
	} {
		if rec := drive(t, id, token, "order", order); rec.Code != http.StatusOK {
			t.Fatalf("order %v: got %v: %v", order, rec.Code, rec.Body.String())
		}
	}

	rec := drive(t, id, token, "adjudicate", "{}")
	if rec.Code != http.StatusOK {
		t.Fatalf("adjudicate: got %v: %v", rec.Code, rec.Body.String())
	}
	var out struct {
		Phase struct {
			Season string `json:"season"`
			Type   string `json:"type"`
		} `json:"phase"`
		PhaseIndex    int `json:"phaseIndex"`
		PreviousPhase *struct {
			Resolutions map[string]string `json:"resolutions"`
		} `json:"previousPhase"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	// Two, not one: nothing was dislodged, so the Spring retreat phase asks
	// nobody for anything and the sandbox walks past it rather than parking
	// the driver on a board with no legal tap (ADR-034's rule, asked of the
	// position because there is no seat to ask).
	if out.PhaseIndex != 2 {
		t.Errorf("the sandbox stopped at phase %v, want 2", out.PhaseIndex)
	}
	if out.Phase.Season != "Fall" || out.Phase.Type != "Movement" {
		t.Errorf("the sandbox landed on %v %v, want Fall Movement", out.Phase.Season, out.Phase.Type)
	}
	// And the review is still the phase the driver played, not the empty
	// retreat that was walked past.
	if out.PreviousPhase == nil {
		t.Fatal("the sandbox adjudicated without a review — there is nothing to look at")
	}
	if got := out.PreviousPhase.Resolutions["par"]; !strings.HasPrefix(got, "ErrBounce") {
		t.Errorf("par resolved %q, want a bounce", got)
	}
}

func TestSandboxRefusesAnOrderForAnotherPower(t *testing.T) {
	id, token := makeSandbox(t)
	rec := drive(t, id, token, "order", `{"power":"France","province":"mun","parts":["Move","bur"]}`)
	if rec.Code != http.StatusForbidden {
		t.Errorf("France ordered Munich: got %v, want 403", rec.Code)
	}
	rec = drive(t, id, token, "order", `{"power":"Atlantis","province":"par","parts":["Hold"]}`)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("an unknown power was accepted: got %v, want 400", rec.Code)
	}
}

// The two authorization paths never meet (ADR-047).
func TestSandboxAndSeatScopesRejectEachOther(t *testing.T) {
	sandboxID, sandboxToken := makeSandbox(t)
	tableID := makeGame(t)
	g, _ := games.lookup(tableID)
	g.mu.Lock()
	gmToken := g.flow.gmToken
	inviteToken := g.flow.inviteToken
	g.mu.Unlock()

	// A sandbox has no game master and no seats, whatever token is sent.
	for _, action := range []string{"state", "start", "adjudicate"} {
		path := "/api/v1/game/" + sandboxID + "/gm/" + gmToken + "/" + action
		req := httptest.NewRequest(http.MethodPost, path, strings.NewReader("{}"))
		rec := httptest.NewRecorder()
		testServer(t).serveFlowAPI(rec, req, path)
		if rec.Code != http.StatusNotFound {
			t.Errorf("the game master scope answered a sandbox %v: got %v", action, rec.Code)
		}
	}

	// And nothing may claim a seat in one.
	g2, _ := games.lookup(sandboxID)
	g2.mu.Lock()
	sandboxInvite := g2.flow.inviteToken
	g2.mu.Unlock()
	path := "/api/v1/game/" + sandboxID + "/join/" + sandboxInvite
	req := httptest.NewRequest(http.MethodPost, path, strings.NewReader("{}"))
	rec := httptest.NewRecorder()
	testServer(t).serveFlowAPI(rec, req, path)
	if rec.Code != http.StatusNotFound {
		t.Errorf("a sandbox handed out a seat: got %v", rec.Code)
	}
	_ = inviteToken

	// An ordinary game is not driveable, whatever token is sent.
	for _, token := range []string{sandboxToken, gmToken} {
		path := "/api/v1/game/" + tableID + "/sandbox/" + token + "/state"
		req := httptest.NewRequest(http.MethodGet, path, nil)
		rec := httptest.NewRecorder()
		testServer(t).serveFlowAPI(rec, req, path)
		if rec.Code != http.StatusNotFound {
			t.Errorf("the sandbox scope answered an ordinary game: got %v", rec.Code)
		}
	}

	// And a wrong token opens nothing.
	if rec := drive(t, sandboxID, gmToken, "state", ""); rec.Code != http.StatusNotFound {
		t.Errorf("the sandbox opened to the wrong token: got %v", rec.Code)
	}
}

// The flag is fixed when the game is made (ADR-047).
func TestSandboxFlagCannotBeSetLater(t *testing.T) {
	id := makeGame(t)
	g, _ := games.lookup(id)
	g.mu.Lock()
	gmToken := g.flow.gmToken
	g.mu.Unlock()

	path := "/api/v1/game/" + id + "/gm/" + gmToken + "/settings"
	req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(`{"sandbox":true}`))
	rec := httptest.NewRecorder()
	testServer(t).serveFlowAPI(rec, req, path)

	g.mu.Lock()
	defer g.mu.Unlock()
	if g.flow.settings.Sandbox {
		t.Error("a running game became a sandbox: its players' orders changed hands")
	}
}

// The public addresses are the ordinary ones (ADR-028), and they say what
// kind of board this is.
func TestSandboxIsPublicToReadAndSaysSo(t *testing.T) {
	id, _ := makeSandbox(t)
	g, _ := games.lookup(id)
	g.mu.Lock()
	out, found := g.watchState(id, 0)
	g.mu.Unlock()
	if !found {
		t.Fatal("a sandbox has no watch address")
	}
	if !out.Sandbox {
		t.Error("the watch feed does not say the board had no players")
	}
	if len(out.Units) == 0 {
		t.Error("the watch feed shows no opening position")
	}
}
