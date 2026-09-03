package variantjson

// These tests run against a descriptor dipmap actually wrote, in
// testdata/generated. dipmap writes the format and this package reads it, so
// this is where the two meet. A change to either side that breaks the other
// shows up here rather than in a game.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// sampleDescriptor is the map dipmap generated for the server's own tests.
func sampleDescriptor(t *testing.T) Descriptor {
	t.Helper()
	path := filepath.Join("..", "variant", "testdata", "generated", "demo7", "variant.json")
	f, err := os.Open(path)
	if err != nil {
		t.Skipf("no sample descriptor at %v", path)
	}
	defer f.Close()

	variant, err := Load(f)
	if err != nil {
		t.Fatalf("loading %v: %v", path, err)
	}
	if variant.Name == "" {
		t.Fatal("loaded variant has no name")
	}

	// Re-read for the raw descriptor, so a caller can mutate and re-validate.
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var d Descriptor
	if err := json.Unmarshal(raw, &d); err != nil {
		t.Fatalf("parsing %v: %v", path, err)
	}
	return d
}

func TestSampleDescriptorValidates(t *testing.T) {
	if err := Validate(sampleDescriptor(t)); err != nil {
		t.Fatalf("the sample descriptor must validate: %v", err)
	}
}

func TestSampleDescriptorBuildsAndStarts(t *testing.T) {
	variant, err := Build(sampleDescriptor(t))
	if err != nil {
		t.Fatalf("Build: %v", err)
	}
	state, err := variant.Start()
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	if err := state.Next(); err != nil {
		t.Fatalf("Next: %v", err)
	}
	if len(variant.Graph().Provinces()) == 0 {
		t.Error("the built graph has no provinces")
	}
}

// TestBordersLoadBothWays is the property the format exists for. The
// descriptor states each border once, so the loader must add both directions.
func TestBordersLoadBothWays(t *testing.T) {
	variant, err := Build(sampleDescriptor(t))
	if err != nil {
		t.Fatalf("Build: %v", err)
	}
	g := variant.Graph()

	for _, prov := range g.Provinces() {
		for dest := range g.Edges(prov, false) {
			if _, ok := g.Edges(dest, false)[prov]; !ok {
				t.Errorf("%v reaches %v, but %v does not reach back", prov, dest, dest)
			}
		}
	}
}

func TestValidateRejectsABrokenDescriptor(t *testing.T) {
	d := sampleDescriptor(t)
	d.SoloSupplyCenters = 9999

	err := Validate(d)
	if err == nil {
		t.Fatal("an unreachable win condition must be rejected")
	}
	if !strings.Contains(err.Error(), "nobody can win") {
		t.Errorf("the error should say what is wrong, got: %v", err)
	}
}

// ---- what a descriptor can say that godip's maps need ----------------------

// oneWay is the smallest map with an edge that exists in one direction: two
// land provinces joined mutually, and a sea that reaches one of them without
// being reachable back.
func oneWay() Descriptor {
	return Descriptor{
		Schema:            SchemaVersion,
		Key:               "oneway",
		Name:              "One Way",
		Rules:             Rules{Profile: "classical"},
		SoloSupplyCenters: 1,
		Nations:           []string{"Red", "Blue"},
		Provinces: [][]any{
			{"aaa", "Aaa", "Red"},
			{"bbb", "Bbb", "Blue"},
			{"sea", "The Sea", nil},
		},
		Regions: [][]any{
			{"aaa", nil, "coast"},
			{"bbb", nil, "coast"},
			{"sea", nil, "sea"},
		},
		Borders:       [][]string{{"aaa", "bbb", "land"}, {"sea", "aaa", "sea"}},
		OneWayBorders: [][]string{{"sea", "bbb", "sea"}},
		Start: Start{
			Units:         map[string][]string{"aaa": {"army", "Red"}, "bbb": {"army", "Blue"}},
			SupplyCenters: map[string]string{"aaa": "Red", "bbb": "Blue"},
		},
	}
}

func TestAOneWayBorderLoadsOneWay(t *testing.T) {
	variant, err := Build(oneWay())
	if err != nil {
		t.Fatalf("Build: %v", err)
	}
	g := variant.Graph()
	if _, ok := g.Edges("sea", false)["bbb"]; !ok {
		t.Error("the stated direction is missing")
	}
	if _, ok := g.Edges("bbb", false)["sea"]; ok {
		t.Error("a one-way border must not become mutual")
	}
	// The mutual table still works both ways.
	if _, ok := g.Edges("aaa", false)["sea"]; !ok {
		t.Error("a border in the mutual table must load both ways")
	}
}

func TestAOneWayBorderChangesTheHash(t *testing.T) {
	d := oneWay()
	before := GameHash(d)
	d.OneWayBorders = [][]string{{"bbb", "sea", "sea"}}
	if GameHash(d) == before {
		t.Error("reversing a one-way border must change the board's identity")
	}
	d.OneWayBorders = nil
	if GameHash(d) == before {
		t.Error("removing a one-way border must change the board's identity")
	}
}

// A descriptor that says nothing about when it starts, and one that spells out
// the default, are the same board and must not part a game from its variant.
func TestSpellingOutTheDefaultStartDoesNotChangeTheHash(t *testing.T) {
	silent := oneWay()
	explicit := oneWay()
	explicit.Start.Year = 1901
	explicit.Start.Season = "Spring"
	explicit.Start.Phase = "Movement"
	if GameHash(silent) != GameHash(explicit) {
		t.Error("the default start phase must contribute nothing to the hash")
	}
}

func TestAnotherOpeningPhaseIsHonouredAndHashed(t *testing.T) {
	d := oneWay()
	d.Start.Year = 1960
	d.Start.Season = "Fall"
	d.Start.Phase = "Movement"

	variant, err := Build(d)
	if err != nil {
		t.Fatalf("Build: %v", err)
	}
	state, err := variant.Start()
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	phase := state.Phase()
	if phase.Year() != 1960 || string(phase.Season()) != "Fall" {
		t.Errorf("opened in %v %v", phase.Year(), phase.Season())
	}
	if GameHash(d) == GameHash(oneWay()) {
		t.Error("opening in another phase is another board")
	}
}

func TestAnOpeningPhaseTheProfileCannotReachIsRefused(t *testing.T) {
	d := oneWay()
	d.Start.Season = "Monsoon"
	err := Validate(d)
	if err == nil {
		t.Fatal("a season the phase cycle never produces must be refused")
	}
	if !strings.Contains(err.Error(), "Monsoon") {
		t.Errorf("the error should name the season, got: %v", err)
	}
}

func TestAnUnknownProfileIsRefusedAndTheKnownOnesNamed(t *testing.T) {
	d := oneWay()
	d.Rules.Profile = "housetourney"
	err := Validate(d)
	if err == nil {
		t.Fatal("a profile this build does not carry must be refused")
	}
	for _, want := range []string{"housetourney", "classical"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("the error should mention %q, got: %v", want, err)
		}
	}
	if len(Profiles()) < 2 {
		t.Errorf("expected several rule profiles, got %v", Profiles())
	}
}

// A variant may be drawn on another variant's art, named by key. The key is
// the whole of what a descriptor may say about where its art lives: a path
// would let a descriptor read a file outside the directory variants live in.

func TestAMapReferenceMustBeABareKey(t *testing.T) {
	for _, reference := range []string{
		"../classical", "../../etc/passwd", "/etc/passwd", "classical/map.svg",
		"./classical", "classical/../classical", "Classical", "class ical",
		"class.ical", "class-ical", "class_ical",
	} {
		d := sampleDescriptor(t)
		d.Map = reference
		err := Validate(d)
		if err == nil {
			t.Errorf("map %q was accepted; it is not a variant key", reference)
			continue
		}
		if !strings.Contains(err.Error(), reference) {
			t.Errorf("map %q: the error does not name what it refused: %v",
				reference, err)
		}
	}
}

func TestAMapReferenceToAPlainKeyIsAccepted(t *testing.T) {
	for _, reference := range []string{"classical", "1900", "westernworld901"} {
		d := sampleDescriptor(t)
		d.Map = reference
		if err := Validate(d); err != nil {
			t.Errorf("map %q was refused: %v", reference, err)
		}
	}
}

func TestAVariantMayNotBeDrawnOnItself(t *testing.T) {
	d := sampleDescriptor(t)
	d.Map = d.Key
	if err := Validate(d); err == nil {
		t.Error("a variant naming itself as its own art was accepted")
	}
}

func TestBeingDrawnOnAnotherVariantDoesNotChangeTheHash(t *testing.T) {
	d := sampleDescriptor(t)
	before := GameHash(d)
	d.Map = "classical"
	if after := GameHash(d); after != before {
		t.Errorf("the hash moved when the art moved: %v -> %v", before, after)
	}
}

// Impassable ground is a province with no borders, and it is not a fault.
//
// jDip says so with an adjacency that names only the province itself:
// Switzerland on three maps and Cori Celesti on Octarine. godip drops such a
// province from its graph instead, so the format has no word for it. A warning
// on every boot for four maps that are right trains a reader to skip the line.
//
// The same province holding a supply centre IS a fault, because the centre
// counts toward the total a solo is measured against and nobody can take it.
func TestImpassableGroundIsQuietAndAnUnreachableCentreIsNot(t *testing.T) {
	t.Helper()
	base := func(centre any) Descriptor {
		d := sampleDescriptor(t)
		d.Provinces = append(d.Provinces, []any{"swi", "Switzerland", centre})
		d.Regions = append(d.Regions, []any{"swi", nil, "land"})
		return d
	}
	mentions := func(warnings []string) bool {
		for _, w := range warnings {
			if strings.Contains(w, "swi") {
				return true
			}
		}
		return false
	}
	if mentions(Warnings(base(nil))) {
		t.Error("impassable ground was reported")
	}
	if !mentions(Warnings(base("neutral"))) {
		t.Error("an unreachable supply centre was not reported")
	}
}
