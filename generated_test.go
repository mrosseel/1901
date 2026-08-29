package main

// Loading a variant off disk, end to end, against a map dipmap actually
// generated (testdata/generated/demo7).

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/zond/godip"
)

// withGeneratedDir points the loader at a directory and resets the registry
// afterwards, so tests do not leak variants into each other.
func withGeneratedDir(t *testing.T, dir string) {
	t.Helper()
	t.Setenv("GENERATED_VARIANTS", dir)

	savedVariants := generatedVariants
	savedPlacements := placements
	generatedVariants = map[string]generatedVariant{}
	placements = map[string]placementTable{}

	t.Cleanup(func() {
		generatedVariants = savedVariants
		placements = savedPlacements
		// The key index caches whatever was loaded, so it has to follow.
		rebuildVariantIndex()
	})
}

// copyVariant puts the sample variant in a writable directory so a test can
// corrupt one file without touching the checkout.
func copyVariant(t *testing.T, key string) string {
	t.Helper()
	dir := t.TempDir()
	target := filepath.Join(dir, key)
	if err := os.MkdirAll(target, 0o755); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"variant.json", "map.svg", "placements.json"} {
		b, err := os.ReadFile(filepath.Join("testdata", "generated", "demo7", name))
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

func TestLoadsAGeneratedVariant(t *testing.T) {
	withGeneratedDir(t, filepath.Join("testdata", "generated"))
	if err := loadGeneratedVariants(); err != nil {
		t.Fatalf("loadGeneratedVariants: %v", err)
	}

	gen, ok := generatedVariants["demo7"]
	if !ok {
		t.Fatal("demo7 was not loaded")
	}
	if len(gen.Hash) != 64 {
		t.Errorf("expected a sha256 hex hash, got %q", gen.Hash)
	}
	if got := len(gen.Variant.Nations); got != 7 {
		t.Errorf("expected 7 nations, got %d", got)
	}
	if got := len(gen.Variant.Graph().Provinces()); got == 0 {
		t.Error("variant has no provinces")
	}
}

func TestAGeneratedVariantStartsAndAdjudicates(t *testing.T) {
	withGeneratedDir(t, filepath.Join("testdata", "generated"))
	if err := loadGeneratedVariants(); err != nil {
		t.Fatalf("loadGeneratedVariants: %v", err)
	}

	state, err := generatedVariants["demo7"].Variant.Start()
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	if err := state.Next(); err != nil {
		t.Fatalf("Next: %v", err)
	}
}

func TestGeneratedNationsStartEqual(t *testing.T) {
	withGeneratedDir(t, filepath.Join("testdata", "generated"))
	if err := loadGeneratedVariants(); err != nil {
		t.Fatalf("loadGeneratedVariants: %v", err)
	}
	variant := generatedVariants["demo7"].Variant
	state, err := variant.Start()
	if err != nil {
		t.Fatalf("Start: %v", err)
	}

	units := map[godip.Nation]int{}
	for _, u := range state.Units() {
		units[u.Nation]++
	}
	first := units[variant.Nations[0]]
	for _, nation := range variant.Nations {
		if units[nation] != first {
			t.Errorf("%v starts with %d units, %v with %d",
				nation, units[nation], variant.Nations[0], first)
		}
	}
}

func TestGeneratedVariantJoinsTheRegistry(t *testing.T) {
	withGeneratedDir(t, filepath.Join("testdata", "generated"))
	if err := loadGeneratedVariants(); err != nil {
		t.Fatalf("loadGeneratedVariants: %v", err)
	}

	found := false
	for _, v := range allVariants() {
		if variantKey(v.Name) == "demo7" {
			found = true
		}
	}
	if !found {
		t.Error("a loaded generated variant must appear in allVariants()")
	}
}

// TestLookupFindsAGeneratedVariant guards a bug that reached the tree: the key
// index was built once, and loading generated variants consulted it before
// registering them. The index then never contained them, so every saved game
// on a generated map failed to load with "unknown variant".
func TestLookupFindsAGeneratedVariant(t *testing.T) {
	withGeneratedDir(t, filepath.Join("testdata", "generated"))
	if err := loadGeneratedVariants(); err != nil {
		t.Fatalf("loadGeneratedVariants: %v", err)
	}

	v, found := lookupVariant("demo7")
	if !found {
		t.Fatal("lookupVariant must find a generated variant")
	}
	if variantKey(v.Name) != "demo7" {
		t.Errorf("lookupVariant returned %q", v.Name)
	}
}

func TestGeneratedVariantBringsItsPlacements(t *testing.T) {
	withGeneratedDir(t, filepath.Join("testdata", "generated"))
	if err := loadGeneratedVariants(); err != nil {
		t.Fatalf("loadGeneratedVariants: %v", err)
	}
	if table := placementFor("demo7"); len(table) == 0 {
		t.Error("expected the variant's placement table to load with it")
	}
}

func TestArtIsSanitisedOnLoad(t *testing.T) {
	dir := copyVariant(t, "demo7")
	svgPath := filepath.Join(dir, "demo7", "map.svg")
	raw, err := os.ReadFile(svgPath)
	if err != nil {
		t.Fatal(err)
	}
	poisoned := strings.Replace(string(raw), "<g id=\"provinces\"",
		"<script>fetch('/steal')</script><g id=\"provinces\"", 1)
	if err := os.WriteFile(svgPath, []byte(poisoned), 0o644); err != nil {
		t.Fatal(err)
	}

	withGeneratedDir(t, dir)
	if err := loadGeneratedVariants(); err != nil {
		t.Fatalf("loadGeneratedVariants: %v", err)
	}

	art, err := generatedVariants["demo7"].Variant.SVGMap()
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(art), "script") || strings.Contains(string(art), "steal") {
		t.Error("served art still carries the script")
	}
}

func TestRejectsArtWithoutBoardLayers(t *testing.T) {
	dir := copyVariant(t, "demo7")
	svgPath := filepath.Join(dir, "demo7", "map.svg")
	if err := os.WriteFile(svgPath, []byte(`<svg><g id="nope"/></svg>`), 0o644); err != nil {
		t.Fatal(err)
	}

	withGeneratedDir(t, dir)
	err := loadGeneratedVariants()
	if err == nil {
		t.Fatal("art with no provinces layer must be refused")
	}
	if !strings.Contains(err.Error(), "provinces") {
		t.Errorf("error should name the missing layer, got: %v", err)
	}
}

func TestRejectsAnInvalidDescriptor(t *testing.T) {
	dir := copyVariant(t, "demo7")
	path := filepath.Join(dir, "demo7", "variant.json")

	var descriptor map[string]any
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(raw, &descriptor); err != nil {
		t.Fatal(err)
	}
	// A win condition nobody can reach.
	descriptor["soloSupplyCenters"] = 9999
	out, err := json.Marshal(descriptor)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, out, 0o644); err != nil {
		t.Fatal(err)
	}

	withGeneratedDir(t, dir)
	err = loadGeneratedVariants()
	if err == nil {
		t.Fatal("an invalid descriptor must be refused, not served")
	}
	if !strings.Contains(err.Error(), "nobody can win") {
		t.Errorf("error should say what is wrong, got: %v", err)
	}
}

func TestRejectsDescriptorKeyThatDisagreesWithItsDirectory(t *testing.T) {
	dir := copyVariant(t, "demo7")
	path := filepath.Join(dir, "demo7", "variant.json")
	raw, _ := os.ReadFile(path)
	swapped := strings.Replace(string(raw), `"key": "demo7"`, `"key": "somethingelse"`, 1)
	if err := os.WriteFile(path, []byte(swapped), 0o644); err != nil {
		t.Fatal(err)
	}

	withGeneratedDir(t, dir)
	if err := loadGeneratedVariants(); err == nil {
		t.Fatal("a descriptor whose key contradicts its directory must be refused")
	}
}

func TestMissingDirectoryIsNotAnError(t *testing.T) {
	withGeneratedDir(t, filepath.Join(t.TempDir(), "absent"))
	if err := loadGeneratedVariants(); err != nil {
		t.Errorf("a checkout with no generated maps is a working server: %v", err)
	}
}

// ---- content hashing -------------------------------------------------------

func TestHashChangesWhenTheDescriptorDoes(t *testing.T) {
	dir := copyVariant(t, "demo7")
	withGeneratedDir(t, dir)
	if err := loadGeneratedVariants(); err != nil {
		t.Fatal(err)
	}
	before := generatedVariants["demo7"].Hash

	breakTheBoard(t, filepath.Join(dir, "demo7", "variant.json"))

	generatedVariants = map[string]generatedVariant{}
	if err := loadGeneratedVariants(); err != nil {
		t.Fatal(err)
	}
	if generatedVariants["demo7"].Hash == before {
		t.Error("changing the board must change its hash")
	}
}

// TestHashSurvivesCosmeticEdits is the other half: a game must not die because
// somebody corrected a description.
func TestHashSurvivesCosmeticEdits(t *testing.T) {
	dir := copyVariant(t, "demo7")
	withGeneratedDir(t, dir)
	if err := loadGeneratedVariants(); err != nil {
		t.Fatal(err)
	}
	before := generatedVariants["demo7"].Hash

	path := filepath.Join(dir, "demo7", "variant.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var d map[string]any
	if err := json.Unmarshal(raw, &d); err != nil {
		t.Fatal(err)
	}
	d["description"] = "a corrected description"
	d["name"] = "A Renamed Map"
	d["version"] = "9"
	// Reflow it too: indentation must not matter either.
	out, err := json.MarshalIndent(d, "", "    ")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, out, 0o644); err != nil {
		t.Fatal(err)
	}

	generatedVariants = map[string]generatedVariant{}
	if err := loadGeneratedVariants(); err != nil {
		t.Fatal(err)
	}
	if got := generatedVariants["demo7"].Hash; got != before {
		t.Errorf("a cosmetic edit changed the hash, so every game on this map "+
			"would refuse to load\n  before %v\n  after  %v", before, got)
	}
}

func TestGameRefusesToLoadOnAChangedDescriptor(t *testing.T) {
	withGeneratedDir(t, filepath.Join("testdata", "generated"))
	if err := loadGeneratedVariants(); err != nil {
		t.Fatal(err)
	}
	current := variantHash("demo7")

	if err := checkVariantHash("g1", "demo7", current); err != nil {
		t.Errorf("a matching hash must load: %v", err)
	}

	err := checkVariantHash("g1", "demo7", strings.Repeat("a", 64))
	if err == nil {
		t.Fatal("a changed descriptor must stop the game loading")
	}
	for _, want := range []string{"g1", "demo7", "archive"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error should mention %q, got: %v", want, err)
		}
	}
}

// A key nothing loaded has no hash, and a game recording none against it
// predates the column and still loads.
func TestAnAbsentVariantHasNoHash(t *testing.T) {
	withGeneratedDir(t, filepath.Join("testdata", "generated"))
	if err := loadGeneratedVariants(); err != nil {
		t.Fatal(err)
	}
	if got := variantHash("nosuchvariant"); got != "" {
		t.Errorf("a variant nothing loaded has no descriptor to hash, got %q", got)
	}
	if err := checkVariantHash("g1", "nosuchvariant", ""); err != nil {
		t.Errorf("a game recording no hash must load: %v", err)
	}
}

func TestGameOnAVanishedGeneratedVariantIsRefused(t *testing.T) {
	withGeneratedDir(t, filepath.Join(t.TempDir(), "absent"))
	if err := loadGeneratedVariants(); err != nil {
		t.Fatal(err)
	}
	err := checkVariantHash("g1", "demo7", strings.Repeat("b", 64))
	if err == nil {
		t.Fatal("a game whose generated variant is gone must be refused")
	}
	if !strings.Contains(err.Error(), "no longer loaded") {
		t.Errorf("error should say the variant is gone, got: %v", err)
	}
}

func TestPreExistingGamesWithoutAHashStillLoad(t *testing.T) {
	withGeneratedDir(t, filepath.Join("testdata", "generated"))
	if err := loadGeneratedVariants(); err != nil {
		t.Fatal(err)
	}
	// A row written before the column existed records "".
	if err := checkVariantHash("old", "demo7", ""); err != nil {
		t.Errorf("a game from before the column existed must still load: %v", err)
	}
}

// TestHashRoundTripsThroughTheDatabase is the check the whole hashing story
// rests on: the hash written when a game is created must be the one read back
// when the server restarts.
func TestHashRoundTripsThroughTheDatabase(t *testing.T) {
	withGeneratedDir(t, filepath.Join("testdata", "generated"))
	if err := loadGeneratedVariants(); err != nil {
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

	variant := generatedVariants["demo7"].Variant
	g, err := newGame("demo7", variant)
	if err != nil {
		t.Fatalf("newGame: %v", err)
	}
	f, err := newFlow(settings{Variant: "demo7"}.normalised(), variant)
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

	want := variantHash("demo7")
	if stored != want {
		t.Errorf("stored hash %q, expected %q", stored, want)
	}
	if stored == "" {
		t.Error("a generated variant must record a hash")
	}
}

// TestEveryLoadedVariantPlays walks whatever is in GENERATED_VARIANTS and
// checks each one start to finish. Point it at a directory of exports to
// confirm a batch survived.
func TestEveryLoadedVariantPlays(t *testing.T) {
	dir := os.Getenv("VARIANT_BATCH")
	if dir == "" {
		dir = filepath.Join("testdata", "generated")
	}
	withGeneratedDir(t, dir)
	if err := loadGeneratedVariants(); err != nil {
		t.Fatalf("loadGeneratedVariants: %v", err)
	}
	if len(generatedVariants) == 0 {
		t.Fatalf("no variants found in %v", dir)
	}

	for key, gen := range generatedVariants {
		t.Run(key, func(t *testing.T) {
			state, err := gen.Variant.Start()
			if err != nil {
				t.Fatalf("Start: %v", err)
			}

			units := map[godip.Nation]int{}
			for _, u := range state.Units() {
				units[u.Nation]++
			}
			if len(units) != len(gen.Variant.Nations) {
				t.Errorf("%d nations declared but %d have units",
					len(gen.Variant.Nations), len(units))
			}
			first := units[gen.Variant.Nations[0]]
			for _, nation := range gen.Variant.Nations {
				if units[nation] != first {
					t.Errorf("%v starts with %d units, %v with %d",
						nation, units[nation], gen.Variant.Nations[0], first)
				}
			}

			// Three phases exercises movement, retreat and build.
			for i := 0; i < 3; i++ {
				if err := state.Next(); err != nil {
					t.Fatalf("phase %d: %v", i+1, err)
				}
			}
			t.Logf("%d provinces, %d nations, reached %v",
				len(gen.Variant.Graph().Provinces()), len(gen.Variant.Nations),
				state.Phase())
		})
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
	withGeneratedDir(t, dir)
	if err := loadGeneratedVariants(); err != nil {
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

	variant := generatedVariants["demo7"].Variant
	g, err := newGame("demo7", variant)
	if err != nil {
		t.Fatalf("newGame: %v", err)
	}
	f, err := newFlow(settings{Variant: "demo7"}.normalised(), variant)
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

	generatedVariants = map[string]generatedVariant{}
	if err := loadGeneratedVariants(); err != nil {
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

// ---- the variants the server actually ships -------------------------------
//
// Everything below runs against variants/generated, the directory a real
// server reads, rather than the sample map the tests above use.

func TestEveryShippedVariantResolves(t *testing.T) {
	withGeneratedDir(t, filepath.Join("variants", "generated"))
	if err := loadGeneratedVariants(); err != nil {
		t.Fatal(err)
	}
	if len(generatedVariants) < 26 {
		t.Errorf("only %d variants loaded from the checkout", len(generatedVariants))
	}

	for key, gen := range generatedVariants {
		found, ok := lookupVariant(key)
		if !ok {
			t.Errorf("variant %q does not resolve", key)
			continue
		}
		if found.Name != gen.Variant.Name {
			t.Errorf("key %q resolved to %q", key, found.Name)
		}
	}
}

func TestShippedVariantsStartAndPlay(t *testing.T) {
	withGeneratedDir(t, filepath.Join("variants", "generated"))
	if err := loadGeneratedVariants(); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"classical", "sailho", "1900", "pure", "chaos", "hundred"} {
		t.Run(key, func(t *testing.T) {
			v, ok := lookupVariant(key)
			if !ok {
				t.Fatalf("%v is not in this build", key)
			}
			state, err := v.Start()
			if err != nil {
				t.Fatalf("Start: %v", err)
			}
			for i := 0; i < 3; i++ {
				if err := state.Next(); err != nil {
					t.Fatalf("phase %d: %v", i+1, err)
				}
			}
		})
	}
}

// TestASavedClassicalGameStillRoundTrips is the one that matters for existing
// games. The hash column and the INSERT both changed underneath them.
func TestASavedClassicalGameStillRoundTrips(t *testing.T) {
	withGeneratedDir(t, filepath.Join("variants", "generated"))
	if err := loadGeneratedVariants(); err != nil {
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

	v, ok := lookupVariant("classical")
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
	if want := variantHash("classical"); hash != want {
		t.Errorf("recorded hash %q, expected %q", hash, want)
	}
	if hash == "" {
		t.Error("classical is a descriptor now, so a game on it records a hash")
	}
}

// TestAGameFromBeforeTheColumnLoads simulates a database written by the old
// binary: the row exists, the column does not.
func TestAGameFromBeforeTheColumnLoads(t *testing.T) {
	withGeneratedDir(t, filepath.Join("variants", "generated"))
	if err := loadGeneratedVariants(); err != nil {
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

	v, _ := lookupVariant("classical")
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
	withGeneratedDir(t, filepath.Join("testdata", "generated"))

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
	if err := loadGeneratedVariants(); err != nil {
		t.Fatal(err)
	}
	v, ok := lookupVariant("demo7")
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
	generatedVariants = map[string]generatedVariant{}
	games.games = map[string]*game{}
	rebuildVariantIndex()

	if err := loadState(); err != nil {
		t.Fatalf("cold start must restore a game on a generated variant: %v", err)
	}
	if _, ok := games.games["gen-1"]; !ok {
		t.Error("the game did not come back after a cold start")
	}
}
