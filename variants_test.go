package main

import (
	"errors"
	"net/http/httptest"
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
	// classical has no generated styles: its land is one baked path with no
	// per-province classes, so there is nothing for a restyle to paint.
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
