package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

// An override file is a correction, and a correction is only worth having if
// it reaches the board. So the test is the whole path: a file on disk, laid
// over godip's own names, out through the endpoint the map editor reads.
func TestNameOverridesLayerOverGodip(t *testing.T) {
	dir := t.TempDir()
	written := `{"bur": "Bourgogne", "lyo": "Gulf of Lyon", "par": "   "}`
	if err := os.WriteFile(filepath.Join(dir, "classical.json"), []byte(written), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("NAMES", dir)
	// The loaded overrides are process-wide and written once at startup, so a
	// test that reloads them has to put back what it found.
	held := nameOverrides
	t.Cleanup(func() { nameOverrides = held })
	nameOverrides = map[string]map[string]string{}
	if err := loadNameOverrides(); err != nil {
		t.Fatalf("loadNameOverrides: %v", err)
	}

	names := namesFor("classical")
	if names["bur"] != "Bourgogne" {
		t.Errorf("bur came back as %q, wanted the override", names["bur"])
	}
	// A name nobody corrected still has to be there: the overrides are a
	// layer, not a replacement.
	if names["vie"] == "" {
		t.Error("vie lost its godip name")
	}
	// A blank override is an absent one. A board with no name for a province
	// is unreadable, so an empty string must never win.
	if names["par"] == "" {
		t.Error("a blank override erased par's name")
	}

	if plain := namesFor("nosuch"); len(plain) != 0 {
		t.Errorf("an unknown variant answered %d names", len(plain))
	}
}

// The three variant-level files the map editor loads (D-030). It edits a
// variant rather than a game, so each of these has to answer without one.
func TestVariantFilesServeWithoutAGame(t *testing.T) {
	// The tables are read once at startup in main(); a test process has to
	// ask for them itself.
	held := placements
	t.Cleanup(func() { placements = held })
	placements = map[string]placementTable{}
	if err := loadPlacements(); err != nil {
		t.Fatalf("loadPlacements: %v", err)
	}

	cases := []struct {
		path  string
		check func(t *testing.T, body []byte)
	}{
		{"/variants/classical/placement.json", func(t *testing.T, body []byte) {
			var table placementTable
			if err := json.Unmarshal(body, &table); err != nil {
				t.Fatalf("parse: %v", err)
			}
			if len(table) == 0 {
				t.Error("classical served an empty placement table")
			}
		}},
		{"/variants/classical/names.json", func(t *testing.T, body []byte) {
			var names map[string]string
			if err := json.Unmarshal(body, &names); err != nil {
				t.Fatalf("parse: %v", err)
			}
			if names["vie"] == "" {
				t.Error("names.json served no name for vie")
			}
		}},
		{"/variants/classical/provinces.json", func(t *testing.T, body []byte) {
			var provinces []provinceJSON
			if err := json.Unmarshal(body, &provinces); err != nil {
				t.Fatalf("parse: %v", err)
			}
			if len(provinces) == 0 {
				t.Error("provinces.json served nothing")
			}
		}},
	}
	for _, one := range cases {
		w := httptest.NewRecorder()
		handleVariantMap(w, httptest.NewRequest(http.MethodGet, one.path, nil))
		if w.Code != http.StatusOK {
			t.Fatalf("%v answered %d", one.path, w.Code)
		}
		one.check(t, w.Body.Bytes())
	}

	// A variant with no approved table answers null rather than an error: the
	// editor reads that as "start from the map's own anchors".
	w := httptest.NewRecorder()
	handleVariantMap(w, httptest.NewRequest(http.MethodGet, "/variants/nosuchvariant/placement.json", nil))
	if w.Code != http.StatusNotFound {
		t.Errorf("an unknown variant answered %d, wanted 404", w.Code)
	}
}
