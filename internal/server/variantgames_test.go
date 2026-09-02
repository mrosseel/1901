// What a saved game does when its variant's descriptor moves under it.
//
// The rules being checked belong to the store: a game records the hash of the
// board it was played on, and a replay onto a different board is refused.
// They read the real descriptors, so they live beside the games and not
// beside the variants.
package server

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"spring1901/spike/internal/variant"
)

// copyVariant puts the sample variant in a writable directory so a test can
// corrupt one file without touching the checkout. The sample belongs to the
// variant package, which is where the descriptors are read.
func copyVariant(t *testing.T, key string) string {
	t.Helper()
	dir := t.TempDir()
	target := filepath.Join(dir, key)
	if err := os.MkdirAll(target, 0o755); err != nil {
		t.Fatal(err)
	}
	source := repoPath(t, filepath.Join("internal", "variant", "testdata", "generated", "demo7"))
	for _, name := range []string{"variant.json", "map.svg", "placements.json"} {
		b, err := os.ReadFile(filepath.Join(source, name))
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(target, name), b, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

// breakTheBoard edits a descriptor so it describes a different board: it
// deletes a border. Editing metadata would not do, and must not: the hash
// covers what decides play, not what the file says about itself.
func breakTheBoard(t *testing.T, path string) {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var d map[string]any
	if err := json.Unmarshal(raw, &d); err != nil {
		t.Fatal(err)
	}
	borders, ok := d["borders"].([]any)
	if !ok || len(borders) < 2 {
		t.Fatal("descriptor has no borders to remove")
	}
	d["borders"] = borders[1:]
	out, err := json.Marshal(d)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, out, 0o644); err != nil {
		t.Fatal(err)
	}
}

// TestHashRoundTripsThroughTheDatabase is the check the whole hashing story
// rests on: the hash written when a game is created must be the one read back
// when the server restarts.
func TestHashRoundTripsThroughTheDatabase(t *testing.T) {
	variant.WithGeneratedDir(t, repoPath(t, filepath.Join("internal", "variant", "testdata", "generated")))
	if err := variant.LoadGenerated(); err != nil {
		t.Fatal(err)
	}

	handle, err := openDB(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatalf("openDB: %v", err)
	}
	saved := db
	db = handle
	t.Cleanup(func() {
		db = saved
		handle.Close()
	})

	demo := variant.Generated["demo7"].Variant
	g, err := newGame("demo7", demo)
	if err != nil {
		t.Fatalf("newGame: %v", err)
	}
	f, err := newFlow(settings{Variant: "demo7"}.normalised(), demo)
	if err != nil {
		t.Fatalf("newFlow: %v", err)
	}
	g.flow = f
	if err := g.persistErr("game-1"); err != nil {
		t.Fatalf("persistErr: %v", err)
	}

	var stored string
	if err := db.QueryRow(
		`SELECT variant_hash FROM game WHERE id = ?`, "game-1",
	).Scan(&stored); err != nil {
		t.Fatalf("reading the hash back: %v", err)
	}

	want := variant.Hash("demo7")
	if stored != want {
		t.Errorf("stored hash %q, expected %q", stored, want)
	}
	if stored == "" {
		t.Error("a generated variant must record a hash")
	}
}

// TestSavedGameRefusesAChangedMap is the check the whole hashing story rests
// on, taken through the real load path rather than the helper.
//
// A game replays its order history against the variant's starting position. If
// the descriptor changed since the game began, that replay lands on a board the
// players never saw, so loadAll must refuse rather than restore it.
func TestSavedGameRefusesAChangedMap(t *testing.T) {
	dir := copyVariant(t, "demo7")
	variant.WithGeneratedDir(t, dir)
	if err := variant.LoadGenerated(); err != nil {
		t.Fatal(err)
	}

	handle, err := openDB(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatalf("openDB: %v", err)
	}
	savedDB := db
	savedGames := games.games
	db = handle
	games.games = map[string]*game{}
	t.Cleanup(func() {
		db = savedDB
		games.games = savedGames
		handle.Close()
	})

	demo := variant.Generated["demo7"].Variant
	g, err := newGame("demo7", demo)
	if err != nil {
		t.Fatalf("newGame: %v", err)
	}
	f, err := newFlow(settings{Variant: "demo7"}.normalised(), demo)
	if err != nil {
		t.Fatalf("newFlow: %v", err)
	}
	g.flow = f
	if err := g.persistErr("game-1"); err != nil {
		t.Fatalf("persistErr: %v", err)
	}

	// The same descriptor still loads.
	games.games = map[string]*game{}
	if err := loadAll(); err != nil {
		t.Fatalf("an unchanged descriptor must still load the game: %v", err)
	}
	if _, ok := games.games["game-1"]; !ok {
		t.Fatal("the game did not come back")
	}

	// Now somebody moves a border under the running game.
	breakTheBoard(t, filepath.Join(dir, "demo7", "variant.json"))

	variant.Generated = map[string]variant.GeneratedVariant{}
	if err := variant.LoadGenerated(); err != nil {
		t.Fatal(err)
	}

	games.games = map[string]*game{}
	err = loadAll()
	if err == nil {
		t.Fatal("a changed descriptor must stop the saved game loading")
	}
	for _, want := range []string{"game-1", "demo7"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("the error should name %q, got: %v", want, err)
		}
	}
	if len(games.games) != 0 {
		t.Error("no game may be restored once the map has changed")
	}
}

// TestASavedClassicalGameStillRoundTrips is the one that matters for existing
// games. The hash column and the INSERT both changed underneath them.
func TestASavedClassicalGameStillRoundTrips(t *testing.T) {
	variant.WithGeneratedDir(t, repoPath(t, filepath.Join("variants", "generated")))
	if err := variant.LoadGenerated(); err != nil {
		t.Fatal(err)
	}

	handle, err := openDB(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatalf("openDB: %v", err)
	}
	savedDB, savedGames := db, games.games
	db = handle
	games.games = map[string]*game{}
	t.Cleanup(func() {
		db = savedDB
		games.games = savedGames
		handle.Close()
	})

	v, ok := variant.Lookup("classical")
	if !ok {
		t.Fatal("classical must resolve")
	}
	g, err := newGame("classical", v)
	if err != nil {
		t.Fatalf("newGame: %v", err)
	}
	// A setting that the broken INSERT used to discard.
	s := settings{Variant: "classical", IllegalMoves: false}.normalised()
	f, err := newFlow(s, v)
	if err != nil {
		t.Fatalf("newFlow: %v", err)
	}
	g.flow = f
	if err := g.persistErr("classic-1"); err != nil {
		t.Fatalf("persistErr: %v", err)
	}

	games.games = map[string]*game{}
	if err := loadAll(); err != nil {
		t.Fatalf("an existing classical game must still load: %v", err)
	}
	restored, ok := games.games["classic-1"]
	if !ok {
		t.Fatal("the classical game did not come back")
	}
	if restored.variantKey != "classical" {
		t.Errorf("restored on variant %q", restored.variantKey)
	}
	if restored.flow.settings.IllegalMoves != false {
		t.Error("illegal_moves did not survive the round trip; the INSERT is dropping it")
	}

	var hash string
	if err := db.QueryRow(
		`SELECT variant_hash FROM game WHERE id = ?`, "classic-1",
	).Scan(&hash); err != nil {
		t.Fatalf("reading variant_hash: %v", err)
	}
	if want := variant.Hash("classical"); hash != want {
		t.Errorf("recorded hash %q, expected %q", hash, want)
	}
	if hash == "" {
		t.Error("classical is a descriptor now, so a game on it records a hash")
	}
}

// TestAGameFromBeforeTheColumnLoads is what happens to a live database when a
// variant crosses from compiled to descriptor.
//
// A game started on the compiled classical recorded no hash, because a
// compiled variant had none to record. Classical is a descriptor now and does
// have one, so that game's blank hash no longer matches. It still loads: a
// blank means "started before this variant had an identity", and the board it
// replays onto is the same board, which variants_equivalence_test.go is the
// proof of. A game started on the descriptor records the hash and is held to
// it from then on.
func TestAGameFromBeforeTheColumnLoads(t *testing.T) {
	variant.WithGeneratedDir(t, repoPath(t, filepath.Join("variants", "generated")))
	if err := variant.LoadGenerated(); err != nil {
		t.Fatal(err)
	}

	handle, err := openDB(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatalf("openDB: %v", err)
	}
	savedDB, savedGames := db, games.games
	db = handle
	games.games = map[string]*game{}
	t.Cleanup(func() {
		db = savedDB
		games.games = savedGames
		handle.Close()
	})

	v, _ := variant.Lookup("classical")
	g, err := newGame("classical", v)
	if err != nil {
		t.Fatal(err)
	}
	f, err := newFlow(settings{Variant: "classical"}.normalised(), v)
	if err != nil {
		t.Fatal(err)
	}
	g.flow = f
	if err := g.persistErr("old-1"); err != nil {
		t.Fatal(err)
	}
	// Blank it, the way a row written before the column would read.
	if _, err := db.Exec(`UPDATE game SET variant_hash = '' WHERE id = ?`, "old-1"); err != nil {
		t.Fatal(err)
	}

	games.games = map[string]*game{}
	if err := loadAll(); err != nil {
		t.Fatalf("a game predating the column must still load: %v", err)
	}
	if _, ok := games.games["old-1"]; !ok {
		t.Error("the old game did not come back")
	}
}

// TestLoadStateRestoresAGameOnAGeneratedVariant guards the startup order.
//
// A saved game resolves its variant through the registry, so the generated
// variants have to be loaded before the games are. They were not: loadAll ran
// first, and every game played on a map from a directory failed to load with
// "unknown variant". Nothing caught it, because the tests loaded the variants
// themselves before anything else ran.
func TestLoadStateRestoresAGameOnAGeneratedVariant(t *testing.T) {
	variant.WithGeneratedDir(t, repoPath(t, filepath.Join("internal", "variant", "testdata", "generated")))

	handle, err := openDB(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatalf("openDB: %v", err)
	}
	savedDB, savedGames := db, games.games
	db = handle
	games.games = map[string]*game{}
	t.Cleanup(func() {
		db = savedDB
		games.games = savedGames
		handle.Close()
	})

	// Save a game the way a running server would.
	if err := variant.LoadGenerated(); err != nil {
		t.Fatal(err)
	}
	v, ok := variant.Lookup("demo7")
	if !ok {
		t.Fatal("demo7 must resolve")
	}
	g, err := newGame("demo7", v)
	if err != nil {
		t.Fatal(err)
	}
	f, err := newFlow(settings{Variant: "demo7"}.normalised(), v)
	if err != nil {
		t.Fatal(err)
	}
	g.flow = f
	if err := g.persistErr("gen-1"); err != nil {
		t.Fatal(err)
	}

	// Now boot from cold, exactly as main does.
	variant.Forget()
	games.games = map[string]*game{}

	if err := loadState(); err != nil {
		t.Fatalf("cold start must restore a game on a generated variant: %v", err)
	}
	if _, ok := games.games["gen-1"]; !ok {
		t.Error("the game did not come back after a cold start")
	}
}
