package main

import (
	"encoding/json"
	"errors"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/zond/godip/variants/common"
)

// fakeVariant stands in for a godip variant that has its own map art.
func fakeVariant(art string) common.Variant {
	return common.Variant{
		Name:   "Test Variant",
		SVGMap: func() ([]byte, error) { return []byte(art), nil },
	}
}

func withStyledMaps(t *testing.T, maps map[string]map[string][]byte) {
	t.Helper()
	saved := styledMaps
	styledMaps = maps
	t.Cleanup(func() { styledMaps = saved })
}

func TestVariantMapBytesPicksAStyle(t *testing.T) {
	withStyledMaps(t, map[string]map[string][]byte{
		"testvariant": {
			"parchment": []byte("<svg>parchment</svg>"),
			"midnight":  []byte("<svg>midnight</svg>"),
		},
	})
	v := fakeVariant("<svg>original</svg>")

	cases := []struct {
		query string
		want  string
	}{
		// No style at all is the default style, which is the whole point of
		// the restyle: a board that asks for nothing gets the good map.
		{"", "<svg>parchment</svg>"},
		{"?style=parchment", "<svg>parchment</svg>"},
		{"?style=midnight", "<svg>midnight</svg>"},
		// The faithful conversion stays reachable, for looking at when a
		// conversion is in question.
		{"?style=original", "<svg>original</svg>"},
	}
	for _, one := range cases {
		r := httptest.NewRequest("GET", "/variants/testvariant/map.svg"+one.query, nil)
		b, err := variantMapBytes("testvariant", v, r)
		if err != nil {
			t.Fatalf("%q: %v", one.query, err)
		}
		if string(b) != one.want {
			t.Errorf("%q: got %q, want %q", one.query, b, one.want)
		}
	}
}

func TestVariantMapBytesRefusesAStyleNobodyDrew(t *testing.T) {
	// A silent fallback to the default would make a typo in a saved device
	// preference look exactly like a style that exists.
	withStyledMaps(t, map[string]map[string][]byte{
		"testvariant": {"parchment": []byte("<svg>parchment</svg>")},
	})
	r := httptest.NewRequest("GET", "/variants/testvariant/map.svg?style=sepia", nil)
	if _, err := variantMapBytes("testvariant", fakeVariant("<svg/>"), r); !errors.Is(err, errUnknownStyle) {
		t.Fatalf("got %v, want errUnknownStyle", err)
	}
}

func TestVariantMapBytesFallsBackToTheVariantsOwnArt(t *testing.T) {
	// A variant with no styled art on disk is served exactly as godip draws
	// it. That is what a checkout with an empty styledmaps/ gets, and it must
	// be a working board rather than a 404.
	withStyledMaps(t, map[string]map[string][]byte{})
	r := httptest.NewRequest("GET", "/variants/classical/map.svg", nil)
	b, err := variantMapBytes("classical", fakeVariant("<svg>classical</svg>"), r)
	if err != nil {
		t.Fatal(err)
	}
	if string(b) != "<svg>classical</svg>" {
		t.Errorf("got %q", b)
	}
}

func TestUnknownStyleIsA404(t *testing.T) {
	withStyledMaps(t, map[string]map[string][]byte{
		"classical": {"parchment": []byte("<svg/>")},
	})
	w := httptest.NewRecorder()
	handleVariantMap(w, httptest.NewRequest("GET", "/variants/classical/map.svg?style=sepia", nil))
	if w.Code != 404 {
		t.Fatalf("got %v, want 404", w.Code)
	}
}

func TestKeyForPackageDir(t *testing.T) {
	// A Go package name may not start with a digit, so the directory that
	// holds the variant served as "1900" is called jdip1900.
	for dir, want := range map[string]string{
		"sailho":        "sailho",
		"sailhocrowded": "sailhocrowded",
		"jdip1900":      "1900",
	} {
		key, found := keyForPackageDir(dir)
		if !found || key != want {
			t.Errorf("%v: got %q %v, want %q", dir, key, found, want)
		}
	}
	if _, found := keyForPackageDir("leftovers"); found {
		t.Error("a directory that matches no variant must be skipped, not guessed at")
	}
}

func TestStyledGodipMapsAreKeyedByURLKey(t *testing.T) {
	// godip's own maps have no package in this checkout to name a directory
	// after, so styledmaps/<key>/ is named by the URL key and the registry
	// only has to confirm the key is served.
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, "classical"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(dir, "notavariant"), 0o755); err != nil {
		t.Fatal(err)
	}
	art := []byte("<svg>midnight classical</svg>")
	if err := os.WriteFile(filepath.Join(dir, "classical", "map-midnight.svg"), art, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "notavariant", "map-midnight.svg"), art, 0o644); err != nil {
		t.Fatal(err)
	}
	withStyledMaps(t, map[string]map[string][]byte{})
	loaded, err := loadStyledMapsFrom(dir, func(name string) (string, bool) {
		_, found := lookupVariant(name)
		return name, found
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(loaded) != 1 {
		t.Fatalf("got %v, want only classical: a directory naming no variant is skipped", loaded)
	}
	if got := string(styledMaps["classical"]["midnight"]); got != string(art) {
		t.Errorf("got %q, want the file's contents", got)
	}
}

func TestVariantProvincesSaysWhatEachProvinceIs(t *testing.T) {
	// The restyle tool works out which colour a godip map paints sea in by
	// asking the adjudicator which provinces are sea and then looking at the
	// art under each. This is that answer.
	v, found := lookupVariant("classical")
	if !found {
		t.Fatal("classical is not registered")
	}
	provinces, err := variantProvinces(v)
	if err != nil {
		t.Fatal(err)
	}
	kinds := map[string]string{}
	for _, one := range provinces {
		kinds[one.Key] = one.Type
	}
	for province, want := range map[string]string{
		"nth":    "sea",   // the North Sea
		"mun":    "land",  // Munich, landlocked
		"lon":    "coast", // London: land a fleet may sit on
		"spa/nc": "sea",   // a named coast, which the map paints as land
	} {
		if kinds[province] != want {
			t.Errorf("%v: got %q, want %q", province, kinds[province], want)
		}
	}
}

func TestProvincesJSONIsServed(t *testing.T) {
	w := httptest.NewRecorder()
	handleVariantMap(w, httptest.NewRequest("GET", "/variants/classical/provinces.json", nil))
	if w.Code != 200 {
		t.Fatalf("got %v, want 200", w.Code)
	}
	var out []provinceJSON
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if len(out) < 70 {
		t.Errorf("got %v provinces, want classical's whole board", len(out))
	}
}
