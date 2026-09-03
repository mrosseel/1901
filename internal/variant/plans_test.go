package variant

// The two shapes a style plan comes in (ADR-038). Version 1 is every plan
// checked in here; version 2 is what the exporter writes for a map whose names
// have left the art. Both load, and the difference between them is where the
// land-or-sea verdicts live.

import (
	"encoding/json"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// A version-1 plan: names in the art, verdicts as a list in document order.
const planVersion1 = `{
  "version": 1, "key": "demo7", "kind": "godip",
  "map": {"bytes": 1, "sha256": "", "viewBoxWidth": 1000.0},
  "godip": {"styleable": true, "names": {"found": true, "kinds": ["land", "sea", "land"]}}
}`

// A version-2 plan: no names layer, verdicts keyed by province, the mode flag
// and the typography the art drew its names in.
const planVersion2 = `{
  "version": 2, "key": "demo7", "kind": "godip",
  "dataMode": true,
  "map": {"bytes": 1, "sha256": "", "viewBoxWidth": 1000.0},
  "godip": {"styleable": true, "names": {
    "found": false,
    "kinds": {"adr": "sea", "att": "land", "aeg": "sea"},
    "typography": {
      "land": {"family": "Junction, sans-serif", "weight": "normal", "style": "normal",
               "letterSpacing": 0, "fill": "#000000",
               "halo": {"color": "#ffffff", "width": 1.2}},
      "sea": {"family": "Junction, sans-serif", "weight": "normal", "style": "italic",
              "letterSpacing": 0, "fill": "#1f4e79", "halo": null}
    }}}
}`

func parsePlan(t *testing.T, raw string) *stylePlan {
	t.Helper()
	plan := &stylePlan{}
	if err := json.Unmarshal([]byte(raw), plan); err != nil {
		t.Fatalf("parsing the plan: %v", err)
	}
	if !plan.versionSupported() {
		t.Fatalf("version %v was refused", plan.Version)
	}
	return plan
}

func TestBothPlanShapesLoadAndKeepTheirOwnKinds(t *testing.T) {
	one := parsePlan(t, planVersion1)
	if got := one.Godip.Names.Kinds.InOrder; !reflect.DeepEqual(got, []string{"land", "sea", "land"}) {
		t.Errorf("version 1 verdicts came back as %v", got)
	}
	if one.Godip.Names.Kinds.ByProvince != nil {
		t.Error("a list of verdicts was turned into a map, which cannot be keyed without the art")
	}
	if one.DataMode {
		t.Error("a version-1 plan has no dataMode and must not read as true")
	}

	two := parsePlan(t, planVersion2)
	if got := two.Godip.Names.Kinds.ByProvince["aeg"]; got != "sea" {
		t.Errorf("version 2 verdict for aeg came back as %q", got)
	}
	if two.Godip.Names.Kinds.InOrder != nil {
		t.Error("a map of verdicts was turned into a list, which has no document order to take")
	}

	// Each shape answers only the question it can answer. Position keys one,
	// province keys the other, and neither is reconstructed from the other.
	if got := one.Godip.Names.Kinds.kindOf("adr", 1); got != "sea" {
		t.Errorf("version 1: position 1 came back as %q", got)
	}
	if got := one.Godip.Names.Kinds.kindOf("adr", 9); got != "" {
		t.Errorf("version 1: a position past the end came back as %q", got)
	}
	if got := two.Godip.Names.Kinds.kindOf("adr", 1); got != "sea" {
		t.Errorf("version 2: adr came back as %q", got)
	}
	if got := two.Godip.Names.Kinds.kindOf("nowhere", 0); got != "" {
		t.Errorf("version 2: an unknown province came back as %q", got)
	}
}

func TestOnlyTheTwoKnownPlanVersionsAreRead(t *testing.T) {
	for version, want := range map[int]bool{0: false, 1: true, 2: true, 3: false} {
		plan := &stylePlan{Version: version}
		if plan.versionSupported() != want {
			t.Errorf("version %v: supported=%v, wanted %v", version, !want, want)
		}
	}
}

// A plan says which of the two kinds of map it describes, and its art has to
// agree with it (ADR-038).
//
// This was "every plan is version 1", written when no map here had been
// re-authored. Fourteen have been since, so the pin moved to the thing that is
// actually invariant: a version-2 plan in data mode goes with art that draws
// no text, and a version-1 plan whose art claims a names layer goes with art
// that draws one. A plan that disagrees with its art is the failure the old
// pin stood in for.
func TestEveryPlanAgreesWithItsArt(t *testing.T) {
	if err := ReportPlans(); err != nil {
		t.Fatalf("ReportPlans: %v", err)
	}
	for key, plan := range plans {
		if !plan.versionSupported() {
			t.Errorf("%v is version %v", key, plan.Version)
			continue
		}
		if plan.DataMode != (plan.Version == 2) {
			t.Errorf("%v is version %v and dataMode %v; the two go together",
				key, plan.Version, plan.DataMode)
		}
		gen, found := Generated[key]
		if !found {
			continue
		}
		/* Only one direction is an invariant. Data mode means the board
		   draws the names, so a `<text>` left in the art would be a second
		   set on top of the first. Art mode does not imply text: Gateway
		   West, North Sea Wars, Sengoku and Vietnam War draw their names as
		   outlined shapes carrying no string, and Ancient Mediterranean and
		   Unconstitutional draw none at all (ADR-038). */
		if plan.DataMode && strings.Contains(string(gen.SVG), "<text") {
			t.Errorf("%v is in data mode and its art still draws text", key)
		}
	}
}

// The pair that reads wrong and is right.
//
// A version-2 plan states `found: false` and `dataMode: true` at once. Those
// are not a contradiction and they are not the same fact: `found` says the ART
// draws no names layer, and `dataMode` says the BOARD draws the names from the
// records. The map has 73 names either way. Reading `found: false` as "this
// map has no names" would hand the board no label plan and the map would be
// served with nothing written on it at all.
func TestFoundFalseAndDataModeTrueMeanTheMapHasNames(t *testing.T) {
	WithGeneratedDir(t, filepath.Join("testdata", "generated"))
	if err := LoadGenerated(); err != nil {
		t.Fatalf("LoadGenerated: %v", err)
	}
	if err := LoadStyles(); err != nil {
		t.Fatalf("LoadStyles: %v", err)
	}
	state, err := Generated["demo7"].Variant.Start()
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	graph := state.Graph()

	two := parsePlan(t, planVersion2)
	if two.Godip.Names.Found {
		t.Fatal("this plan is meant to say the art draws no names")
	}
	if !two.DataMode {
		t.Fatal("this plan is meant to be in data mode")
	}

	held, was := plans["demo7"]
	t.Cleanup(func() {
		if !was {
			delete(plans, "demo7")
			return
		}
		plans["demo7"] = held
	})
	plans["demo7"] = two

	// found is false, and the server still says this map has names: it hands
	// the board a plan, and the plan names the sea provinces to set in the sea
	// face. A map with no names would get no plan and no verdicts.
	labels := labelPlanFor("demo7", graph)
	if labels == nil {
		t.Fatal("found:false was read as 'this map has no names' and the board got no plan")
	}
	if len(labels.Sea) == 0 {
		t.Error("no sea names on a map that has 22 of them")
	}
	named := 0
	for _, spot := range PlacementFor("demo7") {
		if spot.Label != nil {
			named++
		}
	}
	if named != 73 {
		t.Errorf("%v name records on the map the art draws no names for, wanted 73", named)
	}

	// found is not read as the mode either way round. Turning it on changes
	// nothing, because the flag is the mode and found is not.
	two.Godip.Names.Found = true
	if drawn := labelPlanFor("demo7", graph); !reflect.DeepEqual(drawn, labels) {
		t.Error("found changed the label plan, so something is reading it as the mode")
	}

	// The flag alone decides. With it off the board is handed nothing, even
	// though found is still false and the records are still there.
	two.DataMode = false
	two.Godip.Names.Found = false
	if labelPlanFor("demo7", graph) != nil {
		t.Error("the mode came from something other than the flag")
	}
}

// ?style=original serves the art's own bytes, and a map authored without a
// names layer has no original names in them. The plan's own typography is what
// the board is given instead; the default style's faces stay the answer for a
// plan that carries none.
func TestTheArtsOwnTypographyReachesTheBoard(t *testing.T) {
	WithGeneratedDir(t, filepath.Join("testdata", "generated"))
	if err := LoadGenerated(); err != nil {
		t.Fatalf("LoadGenerated: %v", err)
	}
	if err := LoadStyles(); err != nil {
		t.Fatalf("LoadStyles: %v", err)
	}
	state, err := Generated["demo7"].Variant.Start()
	if err != nil {
		t.Fatalf("Start: %v", err)
	}

	held, was := plans["demo7"]
	t.Cleanup(func() {
		if !was {
			delete(plans, "demo7")
			return
		}
		plans["demo7"] = held
	})

	two := parsePlan(t, planVersion2)
	plans["demo7"] = two
	labels := labelPlanFor("demo7", state.Graph())
	if labels == nil || labels.Original == nil {
		t.Fatal("the plan states a typography and it did not reach the board")
	}
	if labels.Original.Land.Family != "Junction, sans-serif" ||
		labels.Original.Sea.Style != "italic" ||
		labels.Original.Sea.Fill != "#1f4e79" {
		t.Errorf("the art's typography arrived as %+v", *labels.Original)
	}
	if labels.Original.Land.Halo == nil || labels.Original.Land.Halo.Width != 1.2 {
		t.Error("the halo the art drew under its land names did not survive")
	}
	if labels.Original.Sea.Halo != nil {
		t.Error("a halo was invented for a face the art drew without one")
	}

	// A plan carrying no typography leaves the field out, and the board falls
	// back to the default style as it always did.
	one := parsePlan(t, planVersion1)
	one.DataMode = true
	plans["demo7"] = one
	bare := labelPlanFor("demo7", state.Graph())
	if bare == nil || bare.Original != nil {
		t.Fatal("a plan with no typography must state none")
	}
	b, err := json.Marshal(bare)
	if err != nil {
		t.Fatal(err)
	}
	if want := `"defaultStyle":"` + DefaultStyle + `"`; !strings.Contains(string(b), want) {
		t.Errorf("the default style is what the board falls back to: %v", string(b))
	}
	if strings.Contains(string(b), `"original"`) {
		t.Errorf("an absent typography still reached the wire: %v", string(b))
	}
}
