package variant

// Loading a variant off disk, end to end, against a map dipmap actually
// generated (testdata/generated/demo7).

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/zond/godip"
)

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
	WithGeneratedDir(t, filepath.Join("testdata", "generated"))
	if err := LoadGenerated(); err != nil {
		t.Fatalf("LoadGenerated: %v", err)
	}

	gen, ok := Generated["demo7"]
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
	WithGeneratedDir(t, filepath.Join("testdata", "generated"))
	if err := LoadGenerated(); err != nil {
		t.Fatalf("LoadGenerated: %v", err)
	}

	state, err := Generated["demo7"].Variant.Start()
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	if err := state.Next(); err != nil {
		t.Fatalf("Next: %v", err)
	}
}

func TestGeneratedNationsStartEqual(t *testing.T) {
	WithGeneratedDir(t, filepath.Join("testdata", "generated"))
	if err := LoadGenerated(); err != nil {
		t.Fatalf("LoadGenerated: %v", err)
	}
	variant := Generated["demo7"].Variant
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
	WithGeneratedDir(t, filepath.Join("testdata", "generated"))
	if err := LoadGenerated(); err != nil {
		t.Fatalf("LoadGenerated: %v", err)
	}

	found := false
	for _, v := range All() {
		if Key(v.Name) == "demo7" {
			found = true
		}
	}
	if !found {
		t.Error("a loaded generated variant must appear in All()")
	}
}

// TestLookupFindsAGeneratedVariant guards a bug that reached the tree: the key
// index was built once, and loading generated variants consulted it before
// registering them. The index then never contained them, so every saved game
// on a generated map failed to load with "unknown variant".
func TestLookupFindsAGeneratedVariant(t *testing.T) {
	WithGeneratedDir(t, filepath.Join("testdata", "generated"))
	if err := LoadGenerated(); err != nil {
		t.Fatalf("LoadGenerated: %v", err)
	}

	v, found := Lookup("demo7")
	if !found {
		t.Fatal("Lookup must find a generated variant")
	}
	if Key(v.Name) != "demo7" {
		t.Errorf("Lookup returned %q", v.Name)
	}
}

func TestGeneratedVariantBringsItsPlacements(t *testing.T) {
	WithGeneratedDir(t, filepath.Join("testdata", "generated"))
	if err := LoadGenerated(); err != nil {
		t.Fatalf("LoadGenerated: %v", err)
	}
	if table := PlacementFor("demo7"); len(table) == 0 {
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

	WithGeneratedDir(t, dir)
	if err := LoadGenerated(); err != nil {
		t.Fatalf("LoadGenerated: %v", err)
	}

	art, err := Generated["demo7"].Variant.SVGMap()
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

	WithGeneratedDir(t, dir)
	err := LoadGenerated()
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

	WithGeneratedDir(t, dir)
	err = LoadGenerated()
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

	WithGeneratedDir(t, dir)
	if err := LoadGenerated(); err == nil {
		t.Fatal("a descriptor whose key contradicts its directory must be refused")
	}
}

func TestMissingDirectoryIsNotAnError(t *testing.T) {
	WithGeneratedDir(t, filepath.Join(t.TempDir(), "absent"))
	if err := LoadGenerated(); err != nil {
		t.Errorf("a checkout with no generated maps is a working server: %v", err)
	}
}

// ---- content hashing -------------------------------------------------------

func TestHashChangesWhenTheDescriptorDoes(t *testing.T) {
	dir := copyVariant(t, "demo7")
	WithGeneratedDir(t, dir)
	if err := LoadGenerated(); err != nil {
		t.Fatal(err)
	}
	before := Generated["demo7"].Hash

	breakTheBoard(t, filepath.Join(dir, "demo7", "variant.json"))

	Generated = map[string]GeneratedVariant{}
	if err := LoadGenerated(); err != nil {
		t.Fatal(err)
	}
	if Generated["demo7"].Hash == before {
		t.Error("changing the board must change its hash")
	}
}

// TestHashSurvivesCosmeticEdits is the other half: a game must not die because
// somebody corrected a description.
func TestHashSurvivesCosmeticEdits(t *testing.T) {
	dir := copyVariant(t, "demo7")
	WithGeneratedDir(t, dir)
	if err := LoadGenerated(); err != nil {
		t.Fatal(err)
	}
	before := Generated["demo7"].Hash

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

	Generated = map[string]GeneratedVariant{}
	if err := LoadGenerated(); err != nil {
		t.Fatal(err)
	}
	if got := Generated["demo7"].Hash; got != before {
		t.Errorf("a cosmetic edit changed the hash, so every game on this map "+
			"would refuse to load\n  before %v\n  after  %v", before, got)
	}
}

func TestGameRefusesToLoadOnAChangedDescriptor(t *testing.T) {
	WithGeneratedDir(t, filepath.Join("testdata", "generated"))
	if err := LoadGenerated(); err != nil {
		t.Fatal(err)
	}
	current := Hash("demo7")

	if err := CheckHash("g1", "demo7", current); err != nil {
		t.Errorf("a matching hash must load: %v", err)
	}

	err := CheckHash("g1", "demo7", strings.Repeat("a", 64))
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
	WithGeneratedDir(t, filepath.Join("testdata", "generated"))
	if err := LoadGenerated(); err != nil {
		t.Fatal(err)
	}
	if got := Hash("nosuchvariant"); got != "" {
		t.Errorf("a variant nothing loaded has no descriptor to hash, got %q", got)
	}
	if err := CheckHash("g1", "nosuchvariant", ""); err != nil {
		t.Errorf("a game recording no hash must load: %v", err)
	}
}

func TestGameOnAVanishedGeneratedVariantIsRefused(t *testing.T) {
	WithGeneratedDir(t, filepath.Join(t.TempDir(), "absent"))
	if err := LoadGenerated(); err != nil {
		t.Fatal(err)
	}
	err := CheckHash("g1", "demo7", strings.Repeat("b", 64))
	if err == nil {
		t.Fatal("a game whose generated variant is gone must be refused")
	}
	if !strings.Contains(err.Error(), "no longer loaded") {
		t.Errorf("error should say the variant is gone, got: %v", err)
	}
}

func TestPreExistingGamesWithoutAHashStillLoad(t *testing.T) {
	WithGeneratedDir(t, filepath.Join("testdata", "generated"))
	if err := LoadGenerated(); err != nil {
		t.Fatal(err)
	}
	// A row written before the column existed records "".
	if err := CheckHash("old", "demo7", ""); err != nil {
		t.Errorf("a game from before the column existed must still load: %v", err)
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
	WithGeneratedDir(t, dir)
	if err := LoadGenerated(); err != nil {
		t.Fatalf("LoadGenerated: %v", err)
	}
	if len(Generated) == 0 {
		t.Fatalf("no variants found in %v", dir)
	}

	for key, gen := range Generated {
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

// ---- the variants the server actually ships -------------------------------
//
// Everything below runs against variants/generated, the directory a real
// server reads, rather than the sample map the tests above use.

func TestEveryShippedVariantResolves(t *testing.T) {
	WithGeneratedDir(t, repoPath(t, filepath.Join("variants", "generated")))
	if err := LoadGenerated(); err != nil {
		t.Fatal(err)
	}
	if len(Generated) < 26 {
		t.Errorf("only %d variants loaded from the checkout", len(Generated))
	}

	for key, gen := range Generated {
		found, ok := Lookup(key)
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
	WithGeneratedDir(t, repoPath(t, filepath.Join("variants", "generated")))
	if err := LoadGenerated(); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"classical", "sailho", "1900", "pure", "chaos", "hundred"} {
		t.Run(key, func(t *testing.T) {
			v, ok := Lookup(key)
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

// A variant may be drawn on another variant's art instead of carrying its own
// copy. Five of godip's variants are played on the classical board, and shipped
// five byte-identical copies of it.
//
// The reference is a KEY, so it can only ever name a sibling directory. These
// tests hold that boundary, and hold the two ways a chain of references can
// fail: a key nothing loaded, and a chain that comes back to where it started.

// plantVariant writes one copy of the sample variant under key, optionally
// drawn on another variant's art rather than its own.
func plantVariant(t *testing.T, root, key, drawnOn string) {
	t.Helper()
	target := filepath.Join(root, key)
	if err := os.MkdirAll(target, 0o755); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(filepath.Join("testdata", "generated", "demo7", "variant.json"))
	if err != nil {
		t.Fatal(err)
	}
	var d map[string]any
	if err := json.Unmarshal(raw, &d); err != nil {
		t.Fatal(err)
	}
	d["key"] = key
	d["name"] = key
	if drawnOn != "" {
		d["map"] = drawnOn
	}
	out, err := json.Marshal(d)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(target, "variant.json"), out, 0o644); err != nil {
		t.Fatal(err)
	}
	// A variant drawn on another one has no map.svg of its own. That absence is
	// the whole point of the field.
	if drawnOn != "" {
		return
	}
	art, err := os.ReadFile(filepath.Join("testdata", "generated", "demo7", "map.svg"))
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(target, "map.svg"), art, 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestAVariantDrawnOnAnotherServesTheSameBytes(t *testing.T) {
	root := t.TempDir()
	plantVariant(t, root, "owner", "")
	plantVariant(t, root, "borrower", "owner")

	WithGeneratedDir(t, root)
	if err := LoadGenerated(); err != nil {
		t.Fatalf("LoadGenerated: %v", err)
	}

	owner, err := Generated["owner"].Variant.SVGMap()
	if err != nil {
		t.Fatalf("owner art: %v", err)
	}
	borrower, err := Generated["borrower"].Variant.SVGMap()
	if err != nil {
		t.Fatalf("borrower art: %v", err)
	}
	if !bytes.Equal(owner, borrower) {
		t.Errorf("borrower was served %d bytes, owner %d; they must be the same art",
			len(borrower), len(owner))
	}
}

func TestAMapReferenceMayNotLeaveTheVariantsDirectory(t *testing.T) {
	for _, reference := range []string{
		"../classical",
		"../../etc",
		"/etc/passwd",
		"owner/../owner",
		"owner/map.svg",
		"./owner",
		"OWNER",
		"own er",
		"own.er",
	} {
		t.Run(reference, func(t *testing.T) {
			root := t.TempDir()
			plantVariant(t, root, "owner", "")
			plantVariant(t, root, "borrower", reference)

			WithGeneratedDir(t, root)
			err := LoadGenerated()
			if err == nil {
				t.Fatalf("map %q was accepted; it is not a variant key", reference)
			}
			if !strings.Contains(err.Error(), reference) {
				t.Errorf("the error does not name the reference it refused: %v", err)
			}
		})
	}
}

func TestAMapReferenceToNothingIsRefused(t *testing.T) {
	root := t.TempDir()
	plantVariant(t, root, "borrower", "nosuchvariant")

	WithGeneratedDir(t, root)
	err := LoadGenerated()
	if err == nil {
		t.Fatal("a variant drawn on a key nothing loaded was accepted")
	}
	if !strings.Contains(err.Error(), "nosuchvariant") {
		t.Errorf("the error does not name the missing variant: %v", err)
	}
}

func TestACycleOfMapReferencesIsRefused(t *testing.T) {
	root := t.TempDir()
	plantVariant(t, root, "first", "second")
	plantVariant(t, root, "second", "first")

	WithGeneratedDir(t, root)
	err := LoadGenerated()
	if err == nil {
		t.Fatal("two variants drawn on each other were accepted")
	}
	if !strings.Contains(err.Error(), "cycle") {
		t.Errorf("the error does not say the references form a cycle: %v", err)
	}
}

func TestAVariantMayNotBeDrawnOnItself(t *testing.T) {
	root := t.TempDir()
	plantVariant(t, root, "loner", "loner")

	WithGeneratedDir(t, root)
	if err := LoadGenerated(); err == nil {
		t.Fatal("a variant drawn on itself was accepted")
	}
}

func TestNoTwoCheckedInVariantsCarryTheSameArt(t *testing.T) {
	dir := repoPath(t, filepath.Join("variants", "generated"))
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("read %v: %v", dir, err)
	}
	owners := map[string]string{}
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		art, err := os.ReadFile(filepath.Join(dir, entry.Name(), "map.svg"))
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			t.Fatal(err)
		}
		sum := fmt.Sprintf("%x", sha256.Sum256(art))
		if first, dup := owners[sum]; dup {
			t.Errorf("%v and %v carry byte-identical map.svg files; one of them "+
				"should say \"map\": %q in its descriptor instead",
				first, entry.Name(), first)
			continue
		}
		owners[sum] = entry.Name()
	}
}

func TestTheClassicalBoardIsDrawnOnce(t *testing.T) {
	WithGeneratedDir(t, repoPath(t, filepath.Join("variants", "generated")))
	if err := LoadGenerated(); err != nil {
		t.Fatalf("LoadGenerated: %v", err)
	}
	classical, err := Generated["classical"].Variant.SVGMap()
	if err != nil {
		t.Fatalf("classical art: %v", err)
	}
	for _, key := range []string{"chaos", "fleetrome", "francevsaustria", "italyvsgermany"} {
		art, err := Generated[key].Variant.SVGMap()
		if err != nil {
			t.Fatalf("%v art: %v", key, err)
		}
		if !bytes.Equal(art, classical) {
			t.Errorf("%v is played on the classical board but is served %d bytes "+
				"where classical is served %d", key, len(art), len(classical))
		}
	}
}
