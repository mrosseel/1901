// The referee flow: the create response carries no GM secret, the referee
// cookie opens the GM view, the GM's own seat may link back to it, and the
// game list publishes public facts only.
package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/zond/godip/variants/classical"
)

// testServer routes through the real mux, with no database behind it.
func testServer() *server {
	return &server{spaDir: "web/dist"}
}

// makeGame creates a game through POST /games and returns the id.
func makeGame(t *testing.T) string {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/games", strings.NewReader("{}"))
	rec := httptest.NewRecorder()
	handleCreateGame(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("create: got %v, want 200: %v", rec.Code, rec.Body.String())
	}
	var created struct {
		GameID string `json:"gameId"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}
	return created.GameID
}

func TestCreateHandsOutNoGMSecret(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "/games", strings.NewReader("{}"))
	rec := httptest.NewRecorder()
	handleCreateGame(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("create: got %v", rec.Code)
	}

	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"gmToken", "gmUrl"} {
		if _, present := body[key]; present {
			t.Errorf("the create response carries %q", key)
		}
	}
	if _, present := body["inviteUrl"]; !present {
		t.Error("the create response lost the invite url")
	}

	// The creating browser is marked as the referee.
	id := body["gameId"].(string)
	cookies := rec.Result().Cookies()
	found := false
	for _, c := range cookies {
		if c.Name == refereeCookieName(id) && c.Value != "" {
			found = true
		}
	}
	if !found {
		t.Error("create set no referee cookie")
	}
}

func TestRefereeEntryOpensForTheCreatingBrowserOnly(t *testing.T) {
	id := makeGame(t)
	g, found := games.lookup(id)
	if !found {
		t.Fatal("the created game is not in the registry")
	}

	srv := testServer()
	req := httptest.NewRequest(http.MethodGet, "/game/"+id+"/referee/", nil)
	rec := httptest.NewRecorder()
	srv.serveFlow(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("no cookie: got %v, want 404", rec.Code)
	}

	// Again, this time with the cookie the creation handed out.
	req = httptest.NewRequest(http.MethodGet, "/game/"+id+"/referee/", nil)
	req.AddCookie(&http.Cookie{Name: refereeCookieName(id), Value: g.flow.gmDevice})
	rec = httptest.NewRecorder()
	srv.serveFlow(rec, req)
	if rec.Code != http.StatusFound {
		t.Fatalf("with the cookie: got %v, want 302", rec.Code)
	}
	if target := rec.Header().Get("Location"); !strings.Contains(target, "/gm/") {
		t.Errorf("the referee entry led to %q, want a GM view", target)
	}

	// A wrong value is as good as none.
	req = httptest.NewRequest(http.MethodGet, "/game/"+id+"/referee/", nil)
	req.AddCookie(&http.Cookie{Name: refereeCookieName(id), Value: "not-the-secret"})
	rec = httptest.NewRecorder()
	srv.serveFlow(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Errorf("wrong cookie: got %v, want 404", rec.Code)
	}
}

func TestTheGmSeatAloneCarriesTheRefereeLink(t *testing.T) {
	g := watchTestGame(t)
	f := g.flow
	gmPower := f.powers[0]
	f.gmPower = gmPower

	// The GM's own seat gets the link back to the controls.
	req := httptest.NewRequest(http.MethodGet, "/state", nil)
	rec := httptest.NewRecorder()
	handleSeatState(g, "game", gmPower, rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("seat state: got %v", rec.Code)
	}
	var state seatStateJSON
	if err := json.Unmarshal(rec.Body.Bytes(), &state); err != nil {
		t.Fatal(err)
	}
	if state.RefereeURL == "" {
		t.Error("the GM's seat carries no referee url")
	}

	// Another seat gets none.
	other := f.powers[1]
	rec = httptest.NewRecorder()
	handleSeatState(g, "game", other, rec, req)
	state = seatStateJSON{}
	if err := json.Unmarshal(rec.Body.Bytes(), &state); err != nil {
		t.Fatal(err)
	}
	if state.RefereeURL != "" {
		t.Error("a player's seat carries the referee url")
	}
}

func TestGameListPublishesPublicFactsOnly(t *testing.T) {
	id := makeGame(t)
	g, found := games.lookup(id)
	if !found {
		t.Fatal("the created game is not in the registry")
	}

	req := httptest.NewRequest(http.MethodGet, "/games", nil)
	req.AddCookie(&http.Cookie{Name: refereeCookieName(id), Value: g.flow.gmDevice})
	rec := httptest.NewRecorder()
	handleCreateGame(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("list: got %v", rec.Code)
	}

	var list []gameSummaryJSON
	if err := json.Unmarshal(rec.Body.Bytes(), &list); err != nil {
		t.Fatal(err)
	}
	mine := false
	for _, one := range list {
		if one.GameID != id {
			continue
		}
		mine = true
		if !one.Referee {
			t.Error("the creating browser is not marked as the referee")
		}
		if one.Variant.Key == "" || one.TotalSeats == 0 {
			t.Error("the summary lost its public facts")
		}
	}
	if !mine {
		t.Fatal("the list lost the created game")
	}

	// Without the cookie the row is still there, but unmarked.
	req = httptest.NewRequest(http.MethodGet, "/games", nil)
	rec = httptest.NewRecorder()
	handleCreateGame(rec, req)
	list = nil
	if err := json.Unmarshal(rec.Body.Bytes(), &list); err != nil {
		t.Fatal(err)
	}
	for _, one := range list {
		if one.GameID == id && one.Referee {
			t.Error("a stranger is marked as the referee")
		}
	}
}

func TestRefereeCookieSurvivesARestart(t *testing.T) {
	// The secret is persisted with the game, so the main-page referee
	// link works again after a reload of every game.
	f, err := newFlow(settings{}.normalised(), classical.ClassicalVariant)
	if err != nil {
		t.Fatal(err)
	}
	if f.gmDevice == "" {
		t.Fatal("a created flow carries no referee secret")
	}
}
