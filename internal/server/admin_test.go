// The owner's door (ADR-060): one token from the environment, a session
// cookie, and the one thing it may do.
package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/zond/godip/variants/classical"
)

// withAdminToken points ADMIN_TOKEN at a secret for one test and forgets
// every session it opened afterwards, so no login leaks into the next test.
func withAdminToken(t *testing.T, token string) {
	t.Helper()
	t.Setenv("ADMIN_TOKEN", token)
	t.Cleanup(func() {
		adminSessions.mu.Lock()
		adminSessions.open = map[string]time.Time{}
		adminSessions.mu.Unlock()
	})
}

// login posts the token and returns the session cookie, or nil when the
// server refused.
func login(t *testing.T, token string) (*http.Cookie, int) {
	t.Helper()
	body := strings.NewReader(`{"token":` + quote(token) + `}`)
	req := httptest.NewRequest(http.MethodPost, apiPrefix+"/admin/login", body)
	rec := httptest.NewRecorder()
	serveAdmin(rec, req, "/admin/login")
	for _, c := range rec.Result().Cookies() {
		if c.Name == adminCookieName && c.Value != "" {
			return c, rec.Code
		}
	}
	return nil, rec.Code
}

func quote(s string) string {
	out, err := json.Marshal(s)
	if err != nil {
		panic(err)
	}
	return string(out)
}

func TestAdminIsAbsentWithoutAToken(t *testing.T) {
	t.Setenv("ADMIN_TOKEN", "")
	for _, path := range []string{"/admin/login", "/admin/me", "/admin/logout", "/admin/games/abc"} {
		req := httptest.NewRequest(http.MethodPost, apiPrefix+path, strings.NewReader("{}"))
		rec := httptest.NewRecorder()
		serveAdmin(rec, req, path)
		if rec.Code != http.StatusNotFound {
			t.Errorf("%v on a server with no token: got %v, want 404", path, rec.Code)
		}
	}
}

func TestAdminLoginTakesTheTokenAndNothingElse(t *testing.T) {
	withAdminToken(t, "the-owners-secret")

	if _, code := login(t, "not-it"); code != http.StatusUnauthorized {
		t.Fatalf("a wrong token: got %v, want 401", code)
	}
	if _, code := login(t, ""); code != http.StatusUnauthorized {
		t.Fatalf("an empty token: got %v, want 401", code)
	}

	cookie, code := login(t, "the-owners-secret")
	if code != http.StatusOK {
		t.Fatalf("the right token: got %v, want 200", code)
	}
	if cookie == nil {
		t.Fatal("the login handed out no session cookie")
	}
	if !cookie.HttpOnly || cookie.SameSite != http.SameSiteStrictMode {
		t.Errorf("the session cookie is not HttpOnly and strict: %+v", cookie)
	}

	// The cookie is the whole of the answer to "who is this".
	me := func(with *http.Cookie) bool {
		req := httptest.NewRequest(http.MethodGet, apiPrefix+"/admin/me", nil)
		if with != nil {
			req.AddCookie(with)
		}
		rec := httptest.NewRecorder()
		serveAdmin(rec, req, "/admin/me")
		var answer adminMeJSON
		if err := json.Unmarshal(rec.Body.Bytes(), &answer); err != nil {
			t.Fatal(err)
		}
		return answer.Admin
	}
	if !me(cookie) {
		t.Error("the session cookie does not say admin")
	}
	if me(nil) {
		t.Error("a request with no cookie says admin")
	}

	// Logging out ends the session, so the copy somebody kept is worthless.
	req := httptest.NewRequest(http.MethodPost, apiPrefix+"/admin/logout", nil)
	req.AddCookie(cookie)
	rec := httptest.NewRecorder()
	serveAdmin(rec, req, "/admin/logout")
	if rec.Code != http.StatusOK {
		t.Fatalf("logout: got %v", rec.Code)
	}
	if me(cookie) {
		t.Error("the session survived the logout")
	}
}

// adminDB opens a database for one test and puts the registry back after it.
func adminDB(t *testing.T) {
	t.Helper()
	handle, err := openDB(filepath.Join(t.TempDir(), "test.db"))
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
}

func TestAdminDeleteTakesTheGameAndEverythingUnderIt(t *testing.T) {
	withAdminToken(t, "the-owners-secret")
	adminDB(t)

	f, err := newFlow(defaultSettings(), classical.ClassicalVariant)
	if err != nil {
		t.Fatal(err)
	}
	g, id, err := games.create("classical", classical.ClassicalVariant, f)
	if err != nil {
		t.Fatal(err)
	}
	g.persist(id)

	seats := func() int {
		var count int
		if err := db.QueryRow(`SELECT count(*) FROM seat WHERE game_id = ?`, id).Scan(&count); err != nil {
			t.Fatal(err)
		}
		return count
	}
	if seats() == 0 {
		t.Fatal("the created game wrote no seats, so this test proves nothing")
	}

	remove := func(target string, with *http.Cookie) int {
		path := "/admin/games/" + target
		req := httptest.NewRequest(http.MethodDelete, apiPrefix+path, nil)
		if with != nil {
			req.AddCookie(with)
		}
		rec := httptest.NewRecorder()
		serveAdmin(rec, req, path)
		return rec.Code
	}

	// Nobody deletes anything without the cookie.
	if code := remove(id, nil); code != http.StatusForbidden {
		t.Fatalf("delete with no session: got %v, want 403", code)
	}
	if _, found := games.lookup(id); !found {
		t.Fatal("a request with no session deleted the game anyway")
	}

	cookie, code := login(t, "the-owners-secret")
	if code != http.StatusOK || cookie == nil {
		t.Fatalf("login: got %v", code)
	}

	if code := remove("no-such-game", cookie); code != http.StatusNotFound {
		t.Fatalf("delete of an unknown id: got %v, want 404", code)
	}
	if code := remove(id, cookie); code != http.StatusOK {
		t.Fatalf("delete: got %v, want 200", code)
	}

	if _, found := games.lookup(id); found {
		t.Error("the deleted game is still in the registry")
	}
	var rows int
	if err := db.QueryRow(`SELECT count(*) FROM game WHERE id = ?`, id).Scan(&rows); err != nil {
		t.Fatal(err)
	}
	if rows != 0 {
		t.Error("the game row survived the delete")
	}
	// The cascade is the point: a seat left behind is a row nothing can
	// reach and a name in a database that was supposed to be empty.
	if left := seats(); left != 0 {
		t.Errorf("the delete left %v seat row(s) behind", left)
	}

	// It is gone for good: a second delete finds nothing.
	if code := remove(id, cookie); code != http.StatusNotFound {
		t.Errorf("deleting it twice: got %v, want 404", code)
	}
}
