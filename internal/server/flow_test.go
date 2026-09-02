// The referee flow: the create response carries no GM secret, the referee
// cookie opens the GM view, the GM's own seat may link back to it, and the
// game list publishes public facts only.
package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/zond/godip/variants/classical"
)

// testServer routes through the real mux, with no database behind it.
func testServer(t *testing.T) *server {
	t.Helper()
	return &server{spa: os.DirFS(repoPath(t, "web/dist"))}
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

	srv := testServer(t)
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

	req := httptest.NewRequest(http.MethodGet, "/games/list", nil)
	req.AddCookie(&http.Cookie{Name: refereeCookieName(id), Value: g.flow.gmDevice})
	rec := httptest.NewRecorder()
	handleListGames(rec, req)
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
	req = httptest.NewRequest(http.MethodGet, "/games/list", nil)
	rec = httptest.NewRecorder()
	handleListGames(rec, req)
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

func TestALoopbackLinkBecomesTheLanAddress(t *testing.T) {
	// The GM opens the app on localhost, and the QR code must still open
	// on a phone. Only the host changes; the port is the one the GM used.
	old, oldFixed := lanHost, baseURLFixed
	defer func() { lanHost, baseURLFixed = old, oldFixed }()
	lanHost, baseURLFixed = "192.168.1.23", ""

	for _, c := range []struct{ host, want string }{
		{"localhost:8190", "192.168.1.23:8190"},
		{"LOCALHOST:8190", "192.168.1.23:8190"},
		{"127.0.0.1:8190", "192.168.1.23:8190"},
		{"[::1]:8190", "192.168.1.23:8190"},
		{"localhost", "192.168.1.23"},
		{"192.168.1.23:8190", "192.168.1.23:8190"},
		{"table.local:8190", "table.local:8190"},
	} {
		if got := reachableHost(c.host); got != c.want {
			t.Errorf("reachableHost(%q) = %q, want %q", c.host, got, c.want)
		}
	}
}

func TestWithoutALanAddressTheHostIsLeftAlone(t *testing.T) {
	// No address, or several: the server must not guess.
	old, oldFixed := lanHost, baseURLFixed
	defer func() { lanHost, baseURLFixed = old, oldFixed }()
	lanHost, baseURLFixed = "", ""

	if got := reachableHost("localhost:8190"); got != "localhost:8190" {
		t.Errorf("reachableHost with no LAN address = %q", got)
	}
}

func TestBaseURLPinnedWins(t *testing.T) {
	// BASE_URL is the operator's answer, and it beats the swap.
	old, oldFixed := lanHost, baseURLFixed
	defer func() { lanHost, baseURLFixed = old, oldFixed }()
	lanHost, baseURLFixed = "192.168.1.23", "https://table.example"

	req := httptest.NewRequest(http.MethodGet, "http://localhost:8190/games", nil)
	if got := baseURL(req); got != "https://table.example" {
		t.Errorf("baseURL = %q, want the pinned origin", got)
	}
}

func TestPinLANHostLeavesAPinnedOriginAlone(t *testing.T) {
	old, oldFixed := lanHost, baseURLFixed
	defer func() { lanHost, baseURLFixed = old, oldFixed }()
	lanHost, baseURLFixed = "", "https://table.example"

	pinLANHost()
	if lanHost != "" {
		t.Errorf("pinLANHost looked for an address behind BASE_URL: %q", lanHost)
	}
}

// TestGameNameIsSetAtCreationAndShownOnTheList: the name rides in with the
// settings, comes back on the GM view and on the public list, and is tidied
// on the way in.
func TestGameNameIsSetAtCreationAndShownOnTheList(t *testing.T) {
	body := `{"settings":{"name":"  Thursday   table  "}}`
	req := httptest.NewRequest(http.MethodPost, "/games", strings.NewReader(body))
	rec := httptest.NewRecorder()
	handleCreateGame(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("create: got %v: %v", rec.Code, rec.Body.String())
	}
	var created struct {
		GameID string `json:"gameId"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}
	g, found := games.lookup(created.GameID)
	if !found {
		t.Fatal("the created game is not in the registry")
	}
	if got := g.flow.settings.Name; got != "Thursday table" {
		t.Errorf("stored name %q, want the tidied one", got)
	}

	req = httptest.NewRequest(http.MethodGet, "/games/list", nil)
	rec = httptest.NewRecorder()
	handleListGames(rec, req)
	var list []map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &list); err != nil {
		t.Fatal(err)
	}
	seen := false
	for _, row := range list {
		if row["gameId"] == created.GameID {
			seen = true
			if row["name"] != "Thursday table" {
				t.Errorf("the list row carries name %v", row["name"])
			}
		}
	}
	if !seen {
		t.Error("the named game is not on the list")
	}

	// An unnamed game is the empty string, never a missing key.
	other := makeGame(t)
	og, _ := games.lookup(other)
	if og.flow.settings.Name != "" {
		t.Errorf("an unnamed game came out as %q", og.flow.settings.Name)
	}
}

// TestRenameIsNotARuleChange: a name carries no rule, so renaming must not
// bump the settings version that tells every seat "the rules changed".
func TestRenameIsNotARuleChange(t *testing.T) {
	id := makeGame(t)
	g, _ := games.lookup(id)
	before := g.flow.settingsVersion

	req := httptest.NewRequest(http.MethodPost, "/game/"+id+"/gm/settings",
		strings.NewReader(`{"name":"Ostend club"}`))
	rec := httptest.NewRecorder()
	handleGMSettings(g, id, rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("rename: got %v: %v", rec.Code, rec.Body.String())
	}
	if g.flow.settings.Name != "Ostend club" {
		t.Errorf("name after the rename is %q", g.flow.settings.Name)
	}
	if g.flow.settingsVersion != before {
		t.Errorf("the rename bumped the settings version to %v", g.flow.settingsVersion)
	}

	// A rule beside the name still bumps it.
	req = httptest.NewRequest(http.MethodPost, "/game/"+id+"/gm/settings",
		strings.NewReader(`{"name":"Ostend club","deadlineMinutes":42}`))
	rec = httptest.NewRecorder()
	handleGMSettings(g, id, rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("settings: got %v", rec.Code)
	}
	if g.flow.settingsVersion == before {
		t.Error("a changed deadline did not bump the settings version")
	}
}
