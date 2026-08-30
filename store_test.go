package main

import (
	"database/sql"
	"path/filepath"
	"strings"
	"testing"

	"github.com/zond/godip/variants/classical"

	_ "modernc.org/sqlite"
)

// TestMigrationRenamesTheFinalizedColumn runs against a file that really
// carries the pre-rename schema, not a fresh one: the 17 games on the live
// server were written with seat.finalized, and the rename has to carry their
// locks across rather than default them away.
func TestMigrationRenamesTheFinalizedColumn(t *testing.T) {
	path := filepath.Join(t.TempDir(), "old.db")

	handle, err := openDB(path)
	if err != nil {
		t.Fatalf("openDB: %v", err)
	}
	saved := db
	db = handle
	t.Cleanup(func() {
		db = saved
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
	f.seats["England"].locked = true
	g.persist(id)
	handle.Close()

	// Put the file back the way the old server wrote it.
	raw, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := raw.Exec(`ALTER TABLE seat RENAME COLUMN locked TO finalized`); err != nil {
		t.Fatalf("could not build the old schema: %v", err)
	}
	var stored int
	if err := raw.QueryRow(
		`SELECT finalized FROM seat WHERE game_id = ? AND power = 'England'`, id).Scan(&stored); err != nil {
		t.Fatalf("reading the old column: %v", err)
	}
	if stored != 1 {
		t.Fatalf("the old database should hold finalized=1, got %v", stored)
	}
	raw.Close()

	migrated, err := openDB(path)
	if err != nil {
		t.Fatalf("openDB on the old database: %v", err)
	}
	db = migrated
	t.Cleanup(func() { migrated.Close() })

	present, err := columnNames(migrated, "seat")
	if err != nil {
		t.Fatal(err)
	}
	if present["finalized"] {
		t.Error("seat.finalized is still there after the migration")
	}
	if !present["locked"] {
		t.Fatal("seat.locked is missing after the migration")
	}

	games.mu.Lock()
	games.games = map[string]*game{}
	games.mu.Unlock()
	if err := loadAll(); err != nil {
		t.Fatalf("loadAll: %v", err)
	}
	restored, found := games.lookup(id)
	if !found {
		t.Fatal("the game written before the rename did not come back")
	}
	if !restored.flow.seats["England"].locked {
		t.Error("England was locked before the rename and is not after it")
	}
	if restored.flow.seats["France"].locked {
		t.Error("France was never locked and came back locked")
	}
	if got := len(restored.flow.powers); got != len(f.powers) {
		t.Errorf("restored %v powers, want %v", got, len(f.powers))
	}
}

// TestMigrationIsIdempotent: a database already carrying the new name must
// pass through migrate untouched, and openDB runs on every start.
func TestMigrationIsIdempotent(t *testing.T) {
	path := filepath.Join(t.TempDir(), "new.db")
	for i := 0; i < 3; i++ {
		handle, err := openDB(path)
		if err != nil {
			t.Fatalf("openDB pass %v: %v", i, err)
		}
		present, err := columnNames(handle, "seat")
		if err != nil {
			t.Fatal(err)
		}
		if !present["locked"] || present["finalized"] {
			t.Fatalf("pass %v left the seat columns as %v", i, present)
		}
		handle.Close()
	}
}

// TestMigrationAddsTheGameName runs against a file whose game table really
// lacks the column: a game created before names existed must still load, and
// must load unnamed rather than not at all.
func TestMigrationAddsTheGameName(t *testing.T) {
	path := filepath.Join(t.TempDir(), "unnamed.db")

	handle, err := openDB(path)
	if err != nil {
		t.Fatalf("openDB: %v", err)
	}
	saved := db
	db = handle
	t.Cleanup(func() {
		db = saved
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
	g.persist(id)
	handle.Close()

	// Put the file back the way a server without names wrote it.
	raw, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := raw.Exec(`ALTER TABLE game DROP COLUMN name`); err != nil {
		t.Fatalf("could not build the old schema: %v", err)
	}
	present, err := columnNames(raw, "game")
	if err != nil {
		t.Fatal(err)
	}
	if present["name"] {
		t.Fatal("the old database still has game.name")
	}
	raw.Close()

	migrated, err := openDB(path)
	if err != nil {
		t.Fatalf("openDB on the old database: %v", err)
	}
	db = migrated
	t.Cleanup(func() { migrated.Close() })

	present, err = columnNames(migrated, "game")
	if err != nil {
		t.Fatal(err)
	}
	if !present["name"] {
		t.Fatal("game.name is missing after the migration")
	}

	games.mu.Lock()
	games.games = map[string]*game{}
	games.mu.Unlock()
	if err := loadAll(); err != nil {
		t.Fatalf("loadAll: %v", err)
	}
	restored, found := games.lookup(id)
	if !found {
		t.Fatal("the game written before names did not come back")
	}
	if restored.flow.settings.Name != "" {
		t.Errorf("an unnamed game came back as %q", restored.flow.settings.Name)
	}

	// And the migrated database takes a name and gives it back.
	restored.mu.Lock()
	restored.flow.settings.Name = "Thursday table"
	restored.persist(id)
	restored.mu.Unlock()

	games.mu.Lock()
	games.games = map[string]*game{}
	games.mu.Unlock()
	if err := loadAll(); err != nil {
		t.Fatalf("loadAll after naming: %v", err)
	}
	again, found := games.lookup(id)
	if !found {
		t.Fatal("the named game did not come back")
	}
	if again.flow.settings.Name != "Thursday table" {
		t.Errorf("name came back as %q", again.flow.settings.Name)
	}
}

func TestTidyName(t *testing.T) {
	long := strings.Repeat("x", 80)
	cases := []struct{ in, want string }{
		{"", ""},
		{"  Thursday   table  ", "Thursday table"},
		{"a\tb\nc", "a b c"},
		{long, long[:maxNameRunes]},
	}
	for _, c := range cases {
		if got := tidyName(c.in); got != c.want {
			t.Errorf("tidyName(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}
