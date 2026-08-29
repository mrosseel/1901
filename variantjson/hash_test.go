package variantjson

// What the hash must ignore, and what it must catch.
//
// A game replays against the variant's opening position, so the hash decides
// whether that game may still load. Too sensitive and a typo fix kills every
// game in progress; too blunt and a game silently replays onto a different
// board.

import "testing"

func base() Descriptor {
	return Descriptor{
		Schema:            1,
		Key:               "tiny",
		Name:              "Tiny",
		Description:       "a small map",
		CreatedBy:         "someone",
		Version:           "1",
		Rules:             Rules{Profile: "classical", Orders: []string{"move", "hold"}},
		SoloSupplyCenters: 3,
		Nations:           []string{"Aurelia", "Borea"},
		Provinces: [][]any{
			{"aaa", "Aaa", "Aurelia"},
			{"bbb", "Bbb", "Borea"},
			{"ccc", "Ccc", "neutral"},
			{"sss", "Sss", nil},
		},
		Regions: [][]any{
			{"aaa", nil, "coast"},
			{"bbb", nil, "coast"},
			{"ccc", nil, "coast"},
			{"sss", nil, "sea"},
		},
		Borders: [][]string{
			{"aaa", "sss", "sea"},
			{"bbb", "sss", "sea"},
			{"ccc", "sss", "sea"},
			{"aaa", "ccc", "land"},
			{"bbb", "ccc", "land"},
		},
		Start: Start{
			Units:         map[string][]string{"aaa": {"army", "Aurelia"}, "bbb": {"army", "Borea"}},
			SupplyCenters: map[string]string{"aaa": "Aurelia", "bbb": "Borea"},
		},
	}
}

func sameHash(t *testing.T, change string, mutate func(*Descriptor)) {
	t.Helper()
	d := base()
	mutate(&d)
	if GameHash(d) != GameHash(base()) {
		t.Errorf("%s must not change the hash: no game is played differently", change)
	}
}

func differentHash(t *testing.T, change string, mutate func(*Descriptor)) {
	t.Helper()
	d := base()
	mutate(&d)
	if GameHash(d) == GameHash(base()) {
		t.Errorf("%s must change the hash: a game would replay onto a different board", change)
	}
}

func TestHashIsStable(t *testing.T) {
	if GameHash(base()) != GameHash(base()) {
		t.Fatal("the same descriptor must hash the same twice")
	}
	if len(GameHash(base())) != 64 {
		t.Errorf("expected a sha256 hex digest, got %q", GameHash(base()))
	}
}

// ---- presentation must not matter -----------------------------------------

func TestHashIgnoresPresentation(t *testing.T) {
	sameHash(t, "renaming the variant", func(d *Descriptor) { d.Name = "Something Else" })
	sameHash(t, "fixing a typo in the description", func(d *Descriptor) { d.Description = "corrected" })
	sameHash(t, "crediting a different author", func(d *Descriptor) { d.CreatedBy = "someone else" })
	sameHash(t, "bumping the version", func(d *Descriptor) { d.Version = "7" })
	sameHash(t, "changing the key", func(d *Descriptor) { d.Key = "renamed" })
	sameHash(t, "renaming a province label", func(d *Descriptor) {
		d.Provinces[0] = []any{"aaa", "A Much Longer Name", "Aurelia"}
	})
}

func TestHashIgnoresOrdering(t *testing.T) {
	sameHash(t, "listing borders in another order", func(d *Descriptor) {
		d.Borders = [][]string{
			{"bbb", "ccc", "land"}, {"aaa", "ccc", "land"}, {"ccc", "sss", "sea"},
			{"bbb", "sss", "sea"}, {"aaa", "sss", "sea"},
		}
	})
	sameHash(t, "writing a border from the other end", func(d *Descriptor) {
		d.Borders[0] = []string{"sss", "aaa", "sea"}
	})
	sameHash(t, "listing nations in another order", func(d *Descriptor) {
		d.Nations = []string{"Borea", "Aurelia"}
	})
	sameHash(t, "listing provinces in another order", func(d *Descriptor) {
		d.Provinces = [][]any{
			{"sss", "Sss", nil}, {"ccc", "Ccc", "neutral"},
			{"bbb", "Bbb", "Borea"}, {"aaa", "Aaa", "Aurelia"},
		}
	})
	sameHash(t, "listing allowed orders in another order", func(d *Descriptor) {
		d.Rules.Orders = []string{"hold", "move"}
	})
}

// ---- the board must matter -------------------------------------------------

func TestHashCatchesBoardChanges(t *testing.T) {
	differentHash(t, "moving a border", func(d *Descriptor) {
		d.Borders[0] = []string{"aaa", "bbb", "land"}
	})
	differentHash(t, "removing a border", func(d *Descriptor) {
		d.Borders = d.Borders[1:]
	})
	differentHash(t, "changing what may cross a border", func(d *Descriptor) {
		d.Borders[3] = []string{"aaa", "ccc", "coast"}
	})
	differentHash(t, "adding a province", func(d *Descriptor) {
		d.Provinces = append(d.Provinces, []any{"ddd", "Ddd", nil})
	})
	differentHash(t, "moving a supply centre", func(d *Descriptor) {
		d.Provinces[3] = []any{"sss", "Sss", "neutral"}
	})
	differentHash(t, "reassigning a home centre", func(d *Descriptor) {
		d.Provinces[0] = []any{"aaa", "Aaa", "Borea"}
	})
	differentHash(t, "changing a region's terrain", func(d *Descriptor) {
		d.Regions[0] = []any{"aaa", nil, "land"}
	})
	differentHash(t, "adding a named coast", func(d *Descriptor) {
		d.Regions = append(d.Regions, []any{"aaa", "nc", "sea"})
	})
	differentHash(t, "moving a starting unit", func(d *Descriptor) {
		d.Start.Units = map[string][]string{"ccc": {"army", "Aurelia"}, "bbb": {"army", "Borea"}}
	})
	differentHash(t, "changing a starting unit's type", func(d *Descriptor) {
		d.Start.Units["aaa"] = []string{"fleet", "Aurelia"}
	})
	differentHash(t, "changing who owns a centre at the start", func(d *Descriptor) {
		d.Start.SupplyCenters["aaa"] = "Borea"
	})
	differentHash(t, "changing the win condition", func(d *Descriptor) {
		d.SoloSupplyCenters = 4
	})
	differentHash(t, "changing the rules profile", func(d *Descriptor) {
		d.Rules.Profile = "something"
	})
	differentHash(t, "allowing a different order type", func(d *Descriptor) {
		d.Rules.Orders = []string{"move", "hold", "convoy"}
	})
	differentHash(t, "adding a nation", func(d *Descriptor) {
		d.Nations = append(d.Nations, "Cyrene")
	})
}
