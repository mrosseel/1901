package app

import (
	"bytes"
	"encoding/json"
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

// styledTestVariant is a real variant with a real plan: classical, which
// every one of these checks needs, because the composition is what is being
// tested and it needs the art the plan was measured on.
func styledTestVariant(t *testing.T) common.Variant {
	t.Helper()
	if err := loadStyles(); err != nil {
		t.Fatal(err)
	}
	if err := loadPlans(); err != nil {
		t.Fatal(err)
	}
	v, found := lookupVariant("classical")
	if !found {
		t.Fatal("classical is not registered")
	}
	return v
}

func TestVariantMapBytesPicksAStyle(t *testing.T) {
	v := styledTestVariant(t)
	original, err := v.SVGMap()
	if err != nil {
		t.Fatal(err)
	}
	parchment, err := styledMapBytes("classical", v, "parchment")
	if err != nil {
		t.Fatal(err)
	}
	midnight, err := styledMapBytes("classical", v, "midnight")
	if err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		query string
		want  []byte
	}{
		// No style at all is the default style, which is the whole point of
		// the restyle: a board that asks for nothing gets the good map.
		{"", parchment},
		{"?style=parchment", parchment},
		{"?style=midnight", midnight},
		// The faithful original stays reachable, for looking at when a
		// conversion is in question.
		{"?style=original", original},
	}
	for _, one := range cases {
		r := httptest.NewRequest("GET", "/variants/classical/map.svg"+one.query, nil)
		b, err := variantMapBytes("classical", v, r)
		if err != nil {
			t.Fatalf("%q: %v", one.query, err)
		}
		if !bytes.Equal(b, one.want) {
			t.Errorf("%q: got %v bytes, want the %v-byte map", one.query, len(b), len(one.want))
		}
	}
	if bytes.Equal(parchment, midnight) {
		t.Error("two styles produced the same map")
	}
	if bytes.Equal(parchment, original) {
		t.Error("the styled map is the original: nothing was applied")
	}
}

func TestStyledMapsAreCachedAndByteStable(t *testing.T) {
	// A board reloads the map on every phase and every device asks for the
	// same one. Composing it twice must produce the same bytes, and the
	// second ask must come out of the cache rather than be composed again.
	v := styledTestVariant(t)
	first, err := styledMapBytes("classical", v, "midnight")
	if err != nil {
		t.Fatal(err)
	}
	second, err := styledMapBytes("classical", v, "midnight")
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(first, second) {
		t.Fatal("the same map composed twice came out differently")
	}
	if &first[0] != &second[0] {
		t.Error("the second ask composed the map again instead of reading the cache")
	}
}

func TestVariantMapBytesRefusesAStyleNobodyDrew(t *testing.T) {
	// A silent fallback to the default would make a typo in a saved device
	// preference look exactly like a style that exists.
	v := styledTestVariant(t)
	r := httptest.NewRequest("GET", "/variants/classical/map.svg?style=sepia", nil)
	if _, err := variantMapBytes("classical", v, r); !errors.Is(err, errUnknownStyle) {
		t.Fatalf("got %v, want errUnknownStyle", err)
	}
}

func TestVariantMapBytesFallsBackToTheVariantsOwnArt(t *testing.T) {
	// A variant with no style plan is served exactly as it was drawn. That
	// must be a working board rather than a 404.
	r := httptest.NewRequest("GET", "/variants/testvariant/map.svg", nil)
	b, err := variantMapBytes("testvariant", fakeVariant("<svg>unplanned</svg>"), r)
	if err != nil {
		t.Fatal(err)
	}
	if string(b) != "<svg>unplanned</svg>" {
		t.Errorf("got %q", b)
	}
}

func TestStalePlanIsNotApplied(t *testing.T) {
	// The plan names the SHA-256 of the art it was measured on. Art that no
	// longer matches it is served in its own colours: a fill value measured
	// on a picture that has been redrawn may now paint something else.
	if err := loadPlans(); err != nil {
		t.Fatal(err)
	}
	// The cache is keyed by variant, and in a running server one variant has
	// one map. Here the art is swapped under it, so the entry has to go.
	styledArt.mu.Lock()
	delete(styledArt.by, "classical/midnight")
	styledArt.mu.Unlock()
	t.Cleanup(func() {
		styledArt.mu.Lock()
		delete(styledArt.by, "classical/midnight")
		styledArt.mu.Unlock()
	})
	if _, err := styledMapBytes("classical", fakeVariant("<svg>redrawn</svg>"), "midnight"); !errors.Is(err, errUnknownStyle) {
		t.Fatalf("got %v, want errUnknownStyle", err)
	}
}

func TestUnknownStyleIsA404(t *testing.T) {
	w := httptest.NewRecorder()
	handleVariantMap(w, httptest.NewRequest("GET", "/variants/classical/map.svg?style=sepia", nil))
	if w.Code != 404 {
		t.Fatalf("got %v, want 404", w.Code)
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
