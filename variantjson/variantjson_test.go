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
	path := filepath.Join("..", "testdata", "generated", "demo7", "variant.json")
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
