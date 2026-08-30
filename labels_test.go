package main

// The label plan the server hands the board, against the map the exporter
// actually wrote (testdata/generated/demo7).

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"testing"
)

var nameTextRe = regexp.MustCompile(`<text id="(\w+)Name"`)

// The verdict is derived from godip's graph and never stored (D-038), so the
// only way to know the derivation is right is to check it against the answer
// the art itself gives: the style plan's kinds, one per <text> in document
// order, measured in a browser from what each name stands on.
func TestSeaVerdictMatchesTheArtsOwnMeasurement(t *testing.T) {
	withGeneratedDir(t, filepath.Join("testdata", "generated"))
	if err := loadGeneratedVariants(); err != nil {
		t.Fatalf("loadGeneratedVariants: %v", err)
	}
	state, err := generatedVariants["demo7"].Variant.Start()
	if err != nil {
		t.Fatalf("Start: %v", err)
	}

	art, err := os.ReadFile(filepath.Join("testdata", "generated", "demo7", "map.svg"))
	if err != nil {
		t.Fatal(err)
	}
	order := []string{}
	for _, m := range nameTextRe.FindAllStringSubmatch(string(art), -1) {
		order = append(order, m[1])
	}

	b, err := os.ReadFile(filepath.Join("testdata", "generated", "demo7", "styleplan.json"))
	if err != nil {
		t.Fatal(err)
	}
	measured := &stylePlan{}
	if err := json.Unmarshal(b, measured); err != nil {
		t.Fatal(err)
	}
	kinds := measured.Godip.Names.Kinds.InOrder
	if len(kinds) != len(order) || len(order) == 0 {
		t.Fatalf("%d names drawn, %d verdicts measured", len(order), len(kinds))
	}

	sea := map[string]bool{}
	for _, prov := range seaNames(state.Graph()) {
		sea[prov] = true
	}
	for i, prov := range order {
		if want := kinds[i] == "sea"; sea[prov] != want {
			t.Errorf("%v: graph says sea=%v, the art was measured as %q", prov, sea[prov], kinds[i])
		}
	}
}

// The flag is the mode, and nothing else is (D-038). A map full of records
// whose art still draws its names must hand the board no plan at all, or the
// board draws a second set of names over the first.
func TestLabelPlanFollowsTheFlagAndNotTheRecords(t *testing.T) {
	withGeneratedDir(t, filepath.Join("testdata", "generated"))
	if err := loadGeneratedVariants(); err != nil {
		t.Fatalf("loadGeneratedVariants: %v", err)
	}
	if err := loadStyles(); err != nil {
		t.Fatalf("loadStyles: %v", err)
	}
	state, err := generatedVariants["demo7"].Variant.Start()
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	if table := placementFor("demo7"); table["dod"].Label == nil {
		t.Fatal("the fixture is meant to carry label records")
	}

	held := plans["demo7"]
	t.Cleanup(func() {
		if held == nil {
			delete(plans, "demo7")
			return
		}
		plans["demo7"] = held
	})

	art := &stylePlan{Key: "demo7", Kind: "godip"}
	art.Map.ViewBoxWidth = 1000
	plans["demo7"] = art
	if plan := labelPlanFor("demo7", state.Graph()); plan != nil {
		t.Error("a map whose art draws its own names must hand over no label plan")
	}

	art.DataMode = true
	plan := labelPlanFor("demo7", state.Graph())
	if plan == nil {
		t.Fatal("the flag is set and no plan came back")
	}
	if plan.Mode != "records" || plan.DefaultStyle != defaultMapStyle {
		t.Errorf("plan came back as %+v", plan)
	}
	if len(plan.Sea) == 0 {
		t.Error("no sea names, on a map with 22 of them")
	}
	for _, name := range styleNames {
		if _, found := plan.Typography[name]; !found {
			t.Errorf("style %v has no typography in the plan", name)
		}
	}

	// The halo is quoted against the style's reference width and the map is
	// two thirds of it, so the width the board draws is not the width the
	// style names. Getting this wrong draws a halo that swallows the letters.
	face := plan.Typography["flat"].Land
	if face.Halo == nil {
		t.Fatal("the flat style's land names have a halo")
	}
	want := carryLength(styles["flat"].Typography.Land.Halo.Width, styles["flat"].ReferenceWidth, 1000, 1)
	if face.Halo.Width != want {
		t.Errorf("halo width %v, wanted %v carried onto a 1000-unit map", face.Halo.Width, want)
	}
}

// Every map served today is an art-mode map, so every state served today must
// be the state that was served before this field existed — to the byte.
func TestAnArtModeStateCarriesNoLabelField(t *testing.T) {
	b, err := json.Marshal(publicStateJSON{})
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(b, []byte(`"labels"`)) {
		t.Errorf("a map that draws its own names still pays for the field: %v", string(b))
	}
	b, err = json.Marshal(publicStateJSON{Labels: &labelPlanJSON{Mode: "records"}})
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(b, []byte(`"labels":{"mode":"records"`)) {
		t.Errorf("the plan did not reach the wire: %v", string(b))
	}
}
