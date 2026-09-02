// The supply-centre rings a converted map does not draw (ADR-032).
//
// jDip put the centres in a separate layer that the conversion does not
// carry, so a converted board would show no centres at all. They are drawn
// here, at the anchors the art does carry.

package variant

import (
	"regexp"
	"sort"
	"strings"

	"spring1901/spike/internal/svgsafe"
)

// A converted jDip map ships SupplyCenterLayer empty. jDip marks no supply
// centre at all, and nothing downstream draws one, so a player cannot see
// which provinces are worth taking. The ring is drawn here at serve time
// rather than baked into the art, because ?style=original serves the art's
// own bytes and ADR-032 promises those stay a faithful copy of jDip's.
//
// The glyph and the paint are godip's, quoted against its own 1524-unit
// classical: a stroked circle of radius 10 in a stroke of 2.25273, black at
// 0.470588. Both lengths are fractions of the map's width, because a converted
// map is drawn at whatever width jDip chose and the glyph has to read the same
// on all of them. The stroke is stated rather than taken as a fraction of the
// radius: it is a line weight, so deriving it makes a small map's ring a
// smudge and a large one's a doughnut.
const (
	supplyCentreRadiusFraction = 10.0 / 1524.0
	supplyCentreStrokeFraction = 2.25273 / 1524.0
	supplyCentreInk            = "#000000"
	supplyCentreOpacity        = "0.470588"
	supplyCentreRingClass      = "sc-ring"
)

// supplyCentreLength quotes one of the glyph's two lengths on a map of the
// given width, rounded as carryLength rounds: three decimals is finer than
// any of this art is drawn to, and an exact binary fraction printed in full
// is noise in the served bytes.
func supplyCentreLength(fraction, width float64) string {
	return num(jsRound(fraction*width*1000) / 1000)
}

var (
	// Both spellings of the empty layer: the art ships <g/>, and a document
	// that has been through an XML round trip carries <g></g>.
	emptyCentreLayerRe = regexp.MustCompile(
		`<g\b[^>]*\bid="SupplyCenterLayer"[^>]*?(?:/>|>\s*</g>)`)
	// A unit anchor, which the converted art keeps in a hidden layer of its
	// own, as a path whose whole geometry is one moveto.
	unitAnchorRe = regexp.MustCompile(
		`<path\b[^>]*\bid="([^"]+)Center"[^>]*\bd="[Mm]\s*(-?[\d.]+)[\s,]+(-?[\d.]+)\s*"`)
)

// drawSupplyCentreRings fills a converted map's empty supply-centre layer with
// one ring per supply centre, and reports how many it drew.
//
// The position is the province's unit anchor, which is jDip's own coordinate
// for the province and the only one that survives the conversion. Anchors are
// in the root viewport space, which is the space this layer draws in, so no
// length is carried onto a layer scale here.
//
// A ring is `sc-<key>` and never `<key>Center`: the board matches
// [id$="Center"] to find unit anchors, and a ring answering that selector
// would be read as one.
func drawSupplyCentreRings(svg string, centres []string) (string, int) {
	layer := emptyCentreLayerRe.FindStringIndex(svg)
	if layer == nil || len(centres) == 0 {
		return svg, 0
	}
	width, err := viewBoxWidth(svg)
	if err != nil || width <= 0 {
		return svg, 0
	}
	anchors := map[string][2]string{}
	for _, hit := range unitAnchorRe.FindAllStringSubmatch(svg, -1) {
		anchors[hit[1]] = [2]string{hit[2], hit[3]}
	}
	wanted := append([]string{}, centres...)
	sort.Strings(wanted)

	rings := strings.Builder{}
	rings.WriteString(`<g id="SupplyCenterLayer">`)
	drawn := 0
	for _, province := range wanted {
		at, found := anchors[province]
		if !found {
			continue
		}
		rings.WriteString("\n\t\t" + `<circle class="` + supplyCentreRingClass +
			`" id="sc-` + svgsafe.EscapeAttr(province) + `" cx="` + at[0] + `" cy="` + at[1] +
			`" r="` + supplyCentreLength(supplyCentreRadiusFraction, width) + `"/>`)
		drawn++
	}
	if drawn == 0 {
		return svg, 0
	}
	rings.WriteString("\n\t</g>")
	return svg[:layer[0]] + rings.String() + svg[layer[1]:], drawn
}

// replaceFirst replaces the first match only, which is what a JavaScript
// String.replace with an unflagged pattern does.
func replaceFirst(s string, re *regexp.Regexp, with string) string {
	m := re.FindStringIndex(s)
	if m == nil {
		return s
	}
	return s[:m[0]] + with + s[m[1]:]
}
