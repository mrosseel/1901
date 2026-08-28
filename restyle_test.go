package main

import (
	"fmt"
	"regexp"
	"sort"
	"strings"
	"testing"
)

// The promise a restyle makes, checked rather than assumed.
//
// A styled map is served to the same board, hit-tested by the same code and
// placed against the same anchor table as the original. If the composition
// moved one coordinate or renamed one id, every one of those breaks quietly:
// a province stops being clickable, or a marker sits somewhere nothing
// measured it for. So the two documents are compared element by element.
//
// Geometry is compared as raw attribute text. Presentation attributes are
// expected to differ and are ignored.
var geometryAttributes = []string{
	"d", "points", "x", "y", "x1", "y1", "x2", "y2",
	"cx", "cy", "r", "rx", "ry", "width", "height",
	"transform", "viewBox", "patternUnits", "gradientUnits",
}

var elementRe = regexp.MustCompile(`<([A-Za-z_][\w:.-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>`)

type structure struct {
	tags     []string
	ids      []string
	geometry map[string]string
}

// summarise scans tags rather than parsing XML. A DOM parser normalises as it
// goes — attribute order, self-closing forms, entity spelling — and a check
// that compares two normalised documents cannot see a change the parser
// smoothed over. Reading the raw tags compares what will actually be served.
func summarise(svg string) structure {
	out := structure{geometry: map[string]string{}}
	ordinal := 0
	for _, m := range elementRe.FindAllStringSubmatch(svg, -1) {
		tag, body := m[1], m[2]
		if tag == "?xml" || strings.HasPrefix(tag, "!") {
			continue
		}
		out.tags = append(out.tags, tag)
		key := fmt.Sprintf("@%d", ordinal)
		if id := attrOf(body, "id"); id != "" {
			key = "#" + id
			out.ids = append(out.ids, id)
		}
		parts := []string{}
		for _, name := range geometryAttributes {
			if value := attrOf(body, name); value != "" {
				parts = append(parts, name+"="+value)
			}
		}
		out.geometry[key] = strings.Join(parts, "|")
		ordinal++
	}
	sort.Strings(out.ids)
	return out
}

func attrOf(body, name string) string {
	m := regexp.MustCompile(`\b` + regexp.QuoteMeta(name) + `="([^"]*)"`).FindStringSubmatch(body)
	if m == nil {
		return ""
	}
	return m[1]
}

// withoutDefs is the document with its definitions cut out. A definition
// draws nothing by itself, and a style that paints impassable ground with its
// own hatch swaps the insides of the map's pattern for its own — which is not
// the same shape. Everything that IS drawn is elsewhere.
var (
	defsBlockRe    = regexp.MustCompile(`(?s)<defs\b[^>]*>.*?</defs>`)
	patternBlockRe = regexp.MustCompile(`(?s)<pattern\b[^>]*>.*?</pattern>`)
)

func withoutDefs(svg string) string {
	svg = defsBlockRe.ReplaceAllString(svg, "<defs/>")
	return patternBlockRe.ReplaceAllString(svg, "<pattern/>")
}

// lockedLayers are the layers the rest of the system reads: what the board
// hit-tests a tap against, the anchor table every marker is placed from, and
// the labels every placement was measured against.
var lockedLayers = []string{
	"provinces", "province-centers", "supply-centers",
	"MapLayer", "FullLabelLayer", "BriefLabelLayer",
}

func layerText(svg, name string) (string, bool) {
	start, end, found := layerSpan(svg, name)
	if !found {
		return "", false
	}
	return svg[start:end], true
}

func TestStyledMapsKeepEveryElementWhereItWas(t *testing.T) {
	if err := loadStyles(); err != nil {
		t.Fatal(err)
	}
	if err := loadPlans(); err != nil {
		t.Fatal(err)
	}
	// One map of each kind: classical is godip's own art, restyled by
	// substituting fill values; sailho is converted from jDip and restyled by
	// replacing its stylesheet. They exercise the two appliers.
	for _, key := range []string{"classical", "sailho"} {
		v, found := lookupVariant(key)
		if !found {
			t.Fatalf("%v is not registered", key)
		}
		original, err := v.SVGMap()
		if err != nil {
			t.Fatal(err)
		}
		before := summarise(withoutDefs(string(original)))
		for _, style := range styleNames {
			styled, err := styledMapBytes(key, v, style)
			if err != nil {
				t.Fatalf("%v in %v: %v", key, style, err)
			}
			after := summarise(withoutDefs(string(styled)))

			// What each applier is allowed to add. The godip applier adds
			// nothing at all and is held to the stricter promise: every
			// element in the file, in order. The jDip applier lays the
			// style's grain into a drawing layer that ships empty, which is
			// one rect with a known id and nothing else.
			allowed := map[string]bool{}
			if plans[key].Kind == "jdip" {
				allowed["paper-grain"] = true
			}
			if len(after.tags)-len(before.tags) > len(allowed) {
				t.Errorf("%v in %v: element count changed, %v -> %v",
					key, style, len(before.tags), len(after.tags))
				continue
			}
			for _, id := range before.ids {
				if _, present := after.geometry["#"+id]; !present {
					t.Errorf("%v in %v: element #%v is gone from the document", key, style, id)
					break
				}
			}
			for _, id := range after.ids {
				if _, present := before.geometry["#"+id]; !present && !allowed[id] {
					t.Errorf("%v in %v: the restyle added #%v", key, style, id)
				}
			}
			for id, geometry := range before.geometry {
				// An element with no id of its own is keyed by its position
				// in the document, so those keys only line up when nothing
				// was added. Where something was, the locked-layer check
				// below is what holds them: nothing is added inside those.
				if len(allowed) > 0 && strings.HasPrefix(id, "@") {
					continue
				}
				other, present := after.geometry[id]
				if !present {
					continue
				}
				if other != geometry {
					t.Errorf("%v in %v: element %v moved — %.80v -> %.80v",
						key, style, id, geometry, other)
					break
				}
			}

			// And the locked layers on their own, so a failure names the
			// layer the board depends on.
			for _, layer := range lockedLayers {
				a, hasBefore := layerText(string(original), layer)
				b, hasAfter := layerText(string(styled), layer)
				if hasBefore != hasAfter {
					t.Errorf("%v in %v: layer %v appeared or vanished", key, style, layer)
					continue
				}
				if !hasBefore {
					continue
				}
				one, two := summarise(a), summarise(b)
				if len(one.tags) != len(two.tags) {
					t.Errorf("%v in %v: #%v element count changed, %v -> %v",
						key, style, layer, len(one.tags), len(two.tags))
					continue
				}
				for id, geometry := range one.geometry {
					if two.geometry[id] != geometry {
						t.Errorf("%v in %v: #%v element %v moved", key, style, layer, id)
						break
					}
				}
			}
		}
	}
}

func TestStyledMapsActuallyCarryTheStyle(t *testing.T) {
	// The structural check above passes trivially on a map that was not
	// styled at all, so the other half is checked too: the style's own
	// terrain tones have to be in the file, and the map's must be gone.
	if err := loadStyles(); err != nil {
		t.Fatal(err)
	}
	if err := loadPlans(); err != nil {
		t.Fatal(err)
	}
	v, _ := lookupVariant("classical")
	plan := plans["classical"]
	for _, style := range []string{"midnight", "flat"} {
		styled, err := styledMapBytes("classical", v, style)
		if err != nil {
			t.Fatal(err)
		}
		text := string(styled)
		if !strings.Contains(text, styles[style].Terrain.Sea) {
			t.Errorf("%v: the style's sea tone %v is nowhere in the map",
				style, styles[style].Terrain.Sea)
		}
		if strings.Contains(text, plan.Godip.Sea) {
			t.Errorf("%v: godip's own sea tone %v survived the restyle",
				style, plan.Godip.Sea)
		}
	}
}

func TestCarryLengthQuotesALengthAgainstTheMapItLandsOn(t *testing.T) {
	// A hairline on a 1524-unit map has to be wider on a 7300-unit one to
	// read as a hairline, and narrower again inside a layer the map scales.
	if got := carryLength(1, 1524, 1524, 1); got != 1 {
		t.Errorf("same width: got %v, want 1", got)
	}
	if got := carryLength(1, 1524, 3048, 1); got != 2 {
		t.Errorf("twice as wide: got %v, want 2", got)
	}
	if got := carryLength(1, 1524, 3048, 2); got != 1 {
		t.Errorf("twice as wide inside a doubled layer: got %v, want 1", got)
	}
}

func TestSetStylePropsReplacesRatherThanRepeats(t *testing.T) {
	got := setStyleProps("fill:#000;stroke:#fff", []prop{{"stroke", "#123456"}})
	if got != "fill:#000;stroke:#123456" {
		t.Errorf("got %q", got)
	}
}
