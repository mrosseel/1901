package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// A table on disk has to reach the board unchanged. The server does not read
// a single field of it — it is the placement tool's answer, handed through —
// so the only thing worth testing is that nothing is dropped on the way.
func TestPlacementsLoadAndPassThrough(t *testing.T) {
	dir := t.TempDir()
	written := `{
	  "vie": {"unit": [712, 812], "scale": 1, "dislodged": [750, 780], "brief": [640, 770]},
	  "bud": {"unit": [812, 812], "dislodged": [850, 780]}
	}`
	if err := os.WriteFile(filepath.Join(dir, "toy.json"), []byte(written), 0o600); err != nil {
		t.Fatal(err)
	}
	// The hand file is the placement tool's input and must never be served.
	if err := os.WriteFile(filepath.Join(dir, "toy.hand.json"), []byte(`{"vie": {}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PLACEMENTS", dir)
	// The loaded tables are process-wide and written once at startup, so a
	// test that reloads them has to put back what it found.
	held := placements
	t.Cleanup(func() { placements = held })
	placements = map[string]placementTable{}
	if err := loadPlacements(); err != nil {
		t.Fatalf("loadPlacements: %v", err)
	}

	table := placementFor("toy")
	if len(table) != 2 {
		t.Fatalf("loaded %d provinces, wanted 2 — the hand file must be skipped", len(table))
	}
	if placementFor("nosuch") != nil {
		t.Error("a variant with no table must answer nil, which serialises as null")
	}

	vie := table["vie"]
	if vie.Brief == nil {
		t.Fatal("vie lost its brief position")
	}
	if *vie.Brief != [2]float64{640, 770} {
		t.Errorf("brief came back as %v", *vie.Brief)
	}
	// A missing scale is an absent field, not a request for an invisible
	// marker, and a province with no code is not a defect.
	if bud := table["bud"]; bud.Scale != 1 || bud.Brief != nil {
		t.Errorf("bud came back as %+v", bud)
	}

	b, err := json.Marshal(table)
	if err != nil {
		t.Fatal(err)
	}
	var again placementTable
	if err := json.Unmarshal(b, &again); err != nil {
		t.Fatal(err)
	}
	if again["vie"].Brief == nil || *again["vie"].Brief != *vie.Brief {
		t.Errorf("brief did not survive the wire: %v", string(b))
	}
	// omitempty, so a province with no code costs the board nothing to read.
	if got := again["bud"]; got.Brief != nil {
		t.Errorf("bud gained a brief position on the wire: %v", string(b))
	}
}

// A label record is the box the placement search reserved, and the board's
// whole guarantee is that it draws that box and no other (D-038). So every
// number in it has to survive the trip unchanged, and a province that has no
// name must not gain an empty one.
func TestPlacementLabelsPassThrough(t *testing.T) {
	written := `{
	  "dal": {"unit": [546.62, 209.58], "scale": 1, "dislodged": [559.35, 196.85],
	          "brief": [563.11, 209.76],
	          "label": {"at": [563.11, 171.85], "size": 19.93, "width": 71.4,
	                    "height": 14.35, "rot": -62},
	          "centre": [561.4, 180.2], "centreRadius": 10.97},
	  "vil": {"unit": [100, 100], "scale": 1, "dislodged": [110, 90],
	          "label": {"at": [100, 60], "size": 12, "width": 80, "height": 9},
	          "labelRuns": [
	            {"at": [100, 55], "size": 12, "width": 80, "height": 9, "text": "Village of"},
	            {"at": [100, 66], "size": 12, "width": 46, "height": 9, "text": "Aeolus"}]},
	  "bud": {"unit": [812, 812], "dislodged": [850, 780]}
	}`
	var table placementTable
	if err := json.Unmarshal([]byte(written), &table); err != nil {
		t.Fatal(err)
	}
	b, err := json.Marshal(table)
	if err != nil {
		t.Fatal(err)
	}
	var again placementTable
	if err := json.Unmarshal(b, &again); err != nil {
		t.Fatal(err)
	}

	dal := again["dal"]
	if dal.Label == nil {
		t.Fatal("dal lost its label")
	}
	want := labelJSON{At: [2]float64{563.11, 171.85}, Size: 19.93, Width: 71.4, Height: 14.35, Rot: -62}
	if *dal.Label != want {
		t.Errorf("label came back as %+v, wanted %+v", *dal.Label, want)
	}
	if dal.Centre == nil || *dal.Centre != [2]float64{561.4, 180.2} || dal.CentreRadius != 10.97 {
		t.Errorf("centre came back as %v r=%v", dal.Centre, dal.CentreRadius)
	}

	// A wrapped name keeps its label — the union box the search reserved —
	// and gains the runs beside it. The runs carry the strings, because the
	// line breaks are the map author's and cannot be worked out from the
	// province's long name.
	vil := again["vil"]
	if len(vil.LabelRuns) != 2 {
		t.Fatalf("vil came back with %d runs", len(vil.LabelRuns))
	}
	if vil.LabelRuns[1].Text != "Aeolus" || vil.LabelRuns[1].Width != 46 {
		t.Errorf("second run came back as %+v", vil.LabelRuns[1])
	}
	if vil.Label == nil || vil.Label.Width != 80 {
		t.Errorf("the union box did not survive: %v", vil.Label)
	}
	if vil.Label.Rot != 0 {
		t.Errorf("vil gained a rotation: %v", vil.Label.Rot)
	}

	// A province that draws no name, no ring and no code costs the board
	// four absent fields rather than four empty ones.
	if got := again["bud"]; got.Label != nil || got.LabelRuns != nil || got.Centre != nil || got.CentreRadius != 0 {
		t.Errorf("bud gained records it never had: %+v", got)
	}
	if strings.Contains(string(b), `"rot":0`) || strings.Contains(string(b), `"labelRuns":null`) {
		t.Errorf("an absent field was written anyway: %v", string(b))
	}
}
