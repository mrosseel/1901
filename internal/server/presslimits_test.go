package server

import (
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestPressQuotaAndRateAreAcrossRooms(t *testing.T) {
	g := pressGame(t, "fullpress")
	a := openRoom(t, g, "limits", "France", "France", "Italy")
	b := openRoom(t, g, "limits", "France", "France", "England")
	for i := 0; i < pressBurst; i++ {
		if w := sendPress(g, "limits", seatActor("France"), a.ID, "hello"); w.Code != 200 {
			t.Fatal(w.Code)
		}
	}
	if w := sendPress(g, "limits", seatActor("France"), b.ID, "hello"); w.Code != 429 || w.Header().Get("Retry-After") == "" {
		t.Fatalf("cross-room rate: %d", w.Code)
	}
	if w := sendPress(g, "limits", seatActor("Italy"), a.ID, "hello"); w.Code != 200 {
		t.Fatal("one sender throttled another")
	}
	before := g.flow.pressByID[a.ID].lastSeq()
	g.flow.pressSenderBytes["Italy"] = g.flow.pressSenderQuota()
	if w := sendPress(g, "limits", seatActor("Italy"), a.ID, "hello"); w.Code != 409 {
		t.Fatal("quota ignored")
	}
	if g.flow.pressByID[a.ID].lastSeq() != before {
		t.Fatal("quota refusal advanced sequence")
	}
	if w := sendPress(g, "limits", seatActor("England"), b.ID, "hello"); w.Code != 200 {
		t.Fatal("one sender's full share silenced another")
	}
	g.flow.pressBytes = maxPressStoredBytes
	if w := sendPress(g, "limits", seatActor("England"), b.ID, "hello"); w.Code != 409 {
		t.Fatal("game quota ignored")
	}
	w := httptest.NewRecorder()
	r := httptest.NewRequest("GET", "/press/thread?thread="+a.ID, nil)
	handlePressThread(g, "limits", seatActor("Italy"), w, r)
	if w.Code != 200 {
		t.Fatal("quota hid existing history")
	}
	rate := g.flow.pressRates["France"]
	rate.at = time.Now().Add(-pressRefill)
	g.flow.pressRates["France"] = rate
	if !g.flow.takePressRate("France", time.Now()) {
		t.Fatal("rate did not refill")
	}
}

func TestPressPaginationRestartAndMemoryBound(t *testing.T) {
	handle, err := openDB(filepath.Join(t.TempDir(), "press.db"))
	if err != nil {
		t.Fatal(err)
	}
	saved := db
	db = handle
	t.Cleanup(func() { db = saved; handle.Close() })
	const id = "page-test"
	g := pressGame(t, "fullpress")
	g.persist(id)
	room := openRoom(t, g, id, "France", "France", "Italy")
	held := g.flow.pressByID[room.ID]
	for i := 1; i <= 225; i++ {
		// Simulate separate rate windows; the independent rate test exercises bursts.
		g.flow.pressRates = nil
		w := sendPress(g, id, seatActor("France"), room.ID, "message "+strings.Repeat("x", i%20))
		if w.Code != http.StatusOK {
			t.Fatalf("message %d: %d %s", i, w.Code, w.Body.String())
		}
		if len(held.messages) > 1 {
			t.Fatal("ciphertext accumulated in memory")
		}
	}
	byteCount := g.flow.pressBytes
	back := &flow{pressByID: map[string]*pressThread{}}
	if err := loadPress(id, back); err != nil {
		t.Fatal(err)
	}
	held = back.pressByID[room.ID]
	if back.pressBytes != byteCount || back.pressSenderBytes["France"] != byteCount || held.lastSeq() != 225 || len(held.messages) != 1 {
		t.Fatal("restart lost totals or loaded history into memory")
	}
	if held.unreadFor("Italy") != 225 || held.unreadFor("France") != 0 {
		t.Fatal("restart lost unread counts")
	}
	for _, tc := range []struct{ since, before, first, last int }{{-1, 0, 126, 225}, {-1, 126, 26, 125}, {-1, 26, 1, 25}, {0, 0, 1, 100}, {100, 0, 101, 200}} {
		page, err := held.messagePage(tc.since, tc.before)
		if err != nil || len(page) == 0 || len(page) > pressPageSize || page[0].Seq != tc.first || page[len(page)-1].Seq != tc.last {
			t.Fatalf("page %+v: %d messages, %v", tc, len(page), err)
		}
		for i, m := range page {
			if m.Seq != tc.first+i || m.Box != pressBox("message "+strings.Repeat("x", m.Seq%20)) {
				t.Fatal("pagination changed signed message data")
			}
		}
	}
	n, err := held.countUnread("Italy", 125)
	if err != nil || n != 100 {
		t.Fatalf("unread after cursor: %d %v", n, err)
	}
}

func TestLoadRejectsDuplicateSeatKeys(t *testing.T) {
	handle, err := openDB(filepath.Join(t.TempDir(), "keys.db"))
	if err != nil {
		t.Fatal(err)
	}
	saved := db
	db = handle
	t.Cleanup(func() { db = saved; handle.Close() })
	id := makeGame(t)
	g, _ := games.lookup(id)
	_, _, _ = joinWithKey(t, g, id)
	var pub string
	for key := range g.flow.bySignPub {
		pub = key
	}
	if _, err := db.Exec(`UPDATE seat SET sign_pub=?, seat_token='' WHERE game_id=?`, pub, id); err != nil {
		t.Fatal(err)
	}
	if err := loadAll(); err == nil || !strings.Contains(err.Error(), "conflicting signing key") {
		t.Fatalf("duplicate database keys: %v", err)
	}
}
