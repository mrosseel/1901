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

	path := filepath.Join(dir, "demo7", "variant.json")
	raw, _ := os.ReadFile(path)
	edited := strings.Replace(string(raw), `"version": "1"`, `"version": "2"`, 1)
	if edited == string(raw) {
		t.Skip("sample descriptor has no version field to edit")
	}
	if err := os.WriteFile(path, []byte(edited), 0o644); err != nil {
		t.Fatal(err)
	}

	generatedVariants = map[string]generatedVariant{}
	if err := loadGeneratedVariants(); err != nil {
		t.Fatal(err)
	}
	if generatedVariants["demo7"].Hash == before {
		t.Error("editing the descriptor must change its hash")
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

func TestCompiledVariantsNeedNoHash(t *testing.T) {
	if got := variantHash("classical"); got != "" {
		t.Errorf("a compiled variant has no descriptor to hash, got %q", got)
	}
	if err := checkVariantHash("g1", "classical", ""); err != nil {
		t.Errorf("a compiled variant must load: %v", err)
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
