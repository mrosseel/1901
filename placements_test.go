package main

import (
	"encoding/json"
	"os"
	"path/filepath"
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
