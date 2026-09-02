// Restyling a converted jDip map.
//
// A converted map has no per-province fills to replace, so the style arrives
// as a stylesheet laid over it. The label floor is the one thing that cannot
// be quoted: these maps were drawn for a screen twice this size, and a name
// carried down verbatim would be unreadable.

package variant

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

// The classes a jDip map paints its terrain through. These are the only
// distinctions classical draws: paper, water, and ground nobody can enter.
var (
	landClasses       = []string{"nopower"}
	seaClasses        = []string{"water", "seapoly"}
	impassableClasses = []string{"neutral", "impassable"}
)

// labelScope qualifies every label rule, so the map's stylesheet cannot reach
// past the map when the board injects it inline into the app's document.
const labelScope = "#FullLabelLayer text, #BriefLabelLayer text"

// labelFloorFraction is the smallest a name may be drawn, as a fraction of
// the map's own width. The board fits a map to a pane about 1070px wide, so
// a name this size lands at roughly 12 screen pixels before any zoom, which
// is the point below which a province name stops being readable.
//
// The fraction is a floor and nothing else. A class already above it keeps
// exactly the size jDip chose, because every placement was measured against
// the label boxes those sizes produce, and growing a name that already fits
// only crowds the dense parts of the board.
const labelFloorFraction = 0.0115

// labelFloor is the floor in the units a label rule is QUOTED in, which is
// the label layer's units and not the map's: a name layer drawn at a scale
// renders a length by that scale before it reaches the map.
func labelFloor(width, labelScale float64) float64 {
	if labelScale == 0 {
		labelScale = 1
	}
	return jsRound(labelFloorFraction*width/labelScale*1000) / 1000
}

var fontSizeRe = regexp.MustCompile(`(?i)font-size\s*:\s*([0-9]*\.?[0-9]+)\s*(?:px)?`)

// liftLabelSize raises one label class to the floor and returns every other
// declaration untouched.
func liftLabelSize(declarations string, floor float64) string {
	m := fontSizeRe.FindStringSubmatchIndex(declarations)
	if m == nil {
		return declarations
	}
	value, err := strconv.ParseFloat(declarations[m[2]:m[3]], 64)
	if err != nil || value >= floor {
		return declarations
	}
	return declarations[:m[0]] + "font-size:" + num(floor) + "px" + declarations[m[1]:]
}

// buildStylesheet writes the stylesheet that replaces a jDip map's own.
//
// jDip's rules are kept for everything the board draws itself — order
// strokes, unit colours, the invisible click rectangles — because those are
// behaviour, not style. What is replaced is every rule that paints the map.
//
// A length is carried onto the scale of the LAYER it lands in, not the map's:
// the art layer and the name layers are drawn at different scales, so the two
// carries below are not interchangeable.
func buildStylesheet(plan *jdipPlan, style *loadedStyle, width, labelScale float64, rings bool) string {
	carry := func(value float64) string {
		return num(carryLength(value, style.ReferenceWidth, width, plan.ArtScale))
	}
	carryLabel := func(value float64) string {
		return num(carryLength(value, style.ReferenceWidth, width, labelScale))
	}
	lines := []string{}
	lines = append(lines,
		"/* Style: "+style.Name+" — "+style.Title+".",
		"   "+style.Description,
		"   Applied from mapstyles/"+style.Name+".json (ADR-016, ADR-023, ADR-026).",
		"   Terrain, borders and names follow the style; everything the board",
		"   draws for itself is left as jDip wrote it. */")
	if style.FontFaces != "" {
		lines = append(lines, style.FontFaces)
	}
	lines = append(lines, "")

	// The border, once. Every terrain rule draws the same line, because a
	// province edge is a province edge whichever side of it you are on.
	edge := "stroke:" + style.Border.Stroke +
		"; stroke-width:" + carry(style.Border.Width) +
		"; stroke-opacity:" + num(style.Border.Opacity) +
		"; stroke-linejoin:" + style.Border.Linejoin
	if style.Border.Dash != nil {
		dashes := make([]string, len(style.Border.Dash))
		for i, one := range style.Border.Dash {
			dashes[i] = carry(one)
		}
		edge += "; stroke-dasharray:" + strings.Join(dashes, ",")
	}
	// Qualified by the art layer, so a class name as ordinary as ".water"
	// cannot reach into the app that embeds this map.
	terrain := func(selector, fill string) string {
		return "#MapLayer " + selector + " { fill:" + fill + "; " + edge + "; }"
	}

	lines = append(lines, "/* terrain — two tones and whatever the style paints impassable with */")
	for _, name := range landClasses {
		lines = append(lines, terrain("."+name, style.Terrain.Land))
	}
	for _, name := range seaClasses {
		lines = append(lines, terrain("."+name, style.Terrain.Sea))
	}
	for _, name := range impassableClasses {
		lines = append(lines, terrain("."+name, style.Terrain.Impassable))
	}
	lines = append(lines, "")

	if len(plan.PowerClasses) > 0 {
		lines = append(lines, "/* power colours: the board draws ownership, so the map does not */")
		for _, name := range plan.PowerClasses {
			lines = append(lines, terrain("."+name, style.Terrain.Land))
		}
		lines = append(lines, "")
	}

	// The ground. jDip paints a black rectangle behind the art, which under a
	// parchment palette reads as a hole; and on sailho it does not quite
	// reach the edge of the viewBox, so the page showed through in a thin
	// frame. Painting the root as well closes the gap without adding an
	// element — and it is the INLAND ground that goes here, because what
	// shows in the hairline gaps between two province polygons must not read
	// as a channel of water.
	lines = append(lines,
		"/* the ground and the backdrop behind the art */",
		"svg:has(#MapLayer) { background:"+style.Terrain.GroundInland+"; }",
		"#MapLayer > rect:first-of-type { fill:"+style.Terrain.GroundInland+"; stroke:none; }",
		"")

	// Names. Sizes are jDip's own, except where a class falls under the
	// legibility floor: those are lifted TO the floor and no further, so a
	// class that already fits keeps the box its placement was measured
	// against. What else changes is the face, the weight and the tracking.
	floor := labelFloor(width, labelScale)
	land := style.Typography.Land
	sea := style.Typography.Sea
	lines = append(lines,
		"/* names: the style's typography on jDip's own sizes and positions */",
		labelScope+" { font-family:"+land.Family+"; fill:"+land.Fill+"; stroke:none; }")
	for _, metric := range plan.LabelMetrics {
		// Two forms, because jDip puts the size class in two places: on the
		// text itself, and on the label LAYER for every text that does not
		// carry one. The layer form sets the size on the group and lets it
		// inherit, which is what keeps it weaker than a text's own class.
		declarations := liftLabelSize(metric.Declarations, floor)
		lines = append(lines,
			"#FullLabelLayer ."+metric.Class+", #BriefLabelLayer ."+metric.Class+" { "+declarations+" }",
			"#FullLabelLayer."+metric.Class+", #BriefLabelLayer."+metric.Class+" { "+declarations+" }")
	}

	// The halo, which is the whole of the legibility budget. paint-order
	// draws the stroke UNDER the glyph, so it widens nothing and moves
	// nothing: the label box the placements were measured against is the
	// same box.
	halo := func(one styleTypography) string {
		if one.Halo == nil {
			return "; stroke:none"
		}
		return "; paint-order:stroke; stroke:" + one.Halo.Color +
			"; stroke-width:" + carryLabel(one.Halo.Width) +
			"; stroke-linejoin:round; stroke-linecap:round"
	}
	lines = append(lines,
		".map-landname { font-family:"+land.Family+"; font-weight:"+land.Weight+
			"; font-style:"+land.Style+"; letter-spacing:"+carryLabel(land.LetterSpacing)+
			"; fill:"+land.Fill+halo(land)+"; }",
		".map-seaname { font-family:"+sea.Family+"; font-weight:"+sea.Weight+
			"; font-style:"+sea.Style+"; letter-spacing:"+
			carryLabel(style.Typography.SeaAbbrevLetterSpacing)+
			"; fill:"+sea.Fill+halo(sea)+"; }",
		".map-seaname.map-longname { letter-spacing:"+carryLabel(sea.LetterSpacing)+"; }",
		"")

	// Supply-centre glyphs, for a map that draws its own. jDip's converted
	// maps ship SupplyCenterLayer empty and the board draws ownership itself,
	// so on those this rule matches nothing.
	lines = append(lines,
		"/* supply-centre glyphs, for a map that draws its own */",
		"#SupplyCenterLayer path, #SupplyCenterLayer circle, #SupplyCenterLayer polygon,"+
			" #SupplyCenterLayer rect, #SupplyCenterLayer use { fill:"+style.SupplyCentre.Fill+
			"; stroke:"+style.SupplyCentre.Stroke+
			"; stroke-width:"+carry(style.SupplyCentre.StrokeWidth)+
			"; opacity:"+num(style.SupplyCentre.Opacity)+"; }",
		"")

	// The rings laid into a layer that ships empty (ADR-032). The selector is
	// one class more specific than the rule above, which would otherwise fill
	// them from the style's token and swallow the name a ring is drawn around.
	//
	// The paint is godip's own and not the style's, the same paint the board
	// uses when it draws a glyph from a record (ADR-038). A ring says only that
	// a province is a supply centre; who owns it is the board's to draw, and
	// it draws that in the style's colours over the top.
	if rings {
		lines = append(lines,
			"/* rings drawn into a converted map's empty supply-centre layer */",
			"#SupplyCenterLayer circle."+supplyCentreRingClass+" { fill:none; stroke:"+
				supplyCentreInk+"; stroke-opacity:"+supplyCentreOpacity+
				"; stroke-width:"+supplyCentreLength(supplyCentreStrokeFraction, width)+"; opacity:1; }",
			"")
	}

	if style.Grain != nil {
		lines = append(lines,
			"/* the style's grain, laid over the finished map */",
			"#paper-grain { fill:url(#"+style.Grain.PatternID+"); fill-opacity:"+
				num(style.Grain.Opacity)+"; stroke:none; pointer-events:none; }",
			"")
	}

	lines = append(lines,
		"/* kept from jDip: these are the board's business, not the map's */",
		".invisible { stroke:#000000; fill:#000000; fill-opacity:0.0; opacity:0.0; }")
	return strings.Join(lines, "\n")
}

var (
	styleBlockRe = regexp.MustCompile(`(?s)<style\b[^>]*>(.*?)</style>`)
	defsOpenRe   = regexp.MustCompile(`<defs\b[^>]*>`)
	backdropRe   = regexp.MustCompile(`(<rect\b[^>]*\bfill=")black("[^>]*>)`)
	textOpenRe   = regexp.MustCompile(`<text\b([^>]*)>`)
	classAttrRe  = regexp.MustCompile(`\bclass="([^"]*)"`)
	emptyGrainRe = regexp.MustCompile(`<g\b[^>]*\bid="HighestOrderLayer"[^>]*/>`)
	cdataOpenRe  = regexp.MustCompile(`<!\[CDATA\[\s*<!\[CDATA\[`)
	cdataCloseRe = regexp.MustCompile(`\]\]>\s*\]\]>`)
)

// applyJDipStyle puts a converted jDip map into a style.
//
// Almost all of the work is replacing the stylesheet, and not one drawing
// element is touched by it. The exceptions are few and each is deliberate:
// patterns and font faces are added to <defs>, the grain overlay and the
// supply-centre rings go into layers that ship empty, the black backdrop rect
// has its fill attribute rewritten because it carries it inline where no
// stylesheet can reach, and each label <text> gains a class saying whether it
// names land or water.
func applyJDipStyle(original string, plan *jdipPlan, style *loadedStyle, centres []string) (string, error) {
	width, err := viewBoxWidth(original)
	if err != nil {
		return "", err
	}
	svg := original

	// 1. The supply-centre rings, into a drawing layer that ships empty. They
	// go in before the stylesheet so it can say whether it has any to paint.
	svg, rings := drawSupplyCentreRings(svg, centres)

	// 2. The stylesheet. jDip wraps it in CDATA, which is kept.
	block := styleBlockRe.FindStringSubmatchIndex(svg)
	if block == nil {
		return "", fmt.Errorf("this map has no <style> block to replace")
	}
	labelScale := plan.LabelScale
	if labelScale <= 0 {
		labelScale = labelLayerScale(original)
	}
	sheet := buildStylesheet(plan, style, width, labelScale, rings > 0)
	replaced := svg[block[0]:block[2]] + "\n<![CDATA[\n" + sheet + "\n]]>\n" + svg[block[3]:block[1]]
	// The map's own CDATA wrapper, where it had one, would otherwise be
	// nested inside the new one.
	replaced = replaceFirst(replaced, cdataOpenRe, "<![CDATA[")
	replaced = replaceFirst(replaced, cdataCloseRe, "]]>")
	svg = svg[:block[0]] + replaced + svg[block[1]:]

	// 3. Patterns and faces into <defs>. Nothing outside defs is added here.
	defs := defsOpenRe.FindStringIndex(svg)
	if defs == nil {
		return "", fmt.Errorf("this map has no <defs> to put patterns in")
	}
	additions := append([]string{}, style.LoadedDefs...)
	if style.GrainSVG != "" {
		additions = append(additions, style.GrainSVG)
	}
	svg = svg[:defs[1]] +
		"\n<!-- " + style.Name + " style, added by tools/restyle -->\n" +
		strings.Join(additions, "\n") + "\n" +
		svg[defs[1]:]

	// 4. The backdrop rect, which carries its fill inline.
	if m := backdropRe.FindStringSubmatchIndex(svg); m != nil {
		svg = svg[:m[0]] + svg[m[2]:m[3]] + style.Terrain.GroundInland + svg[m[4]:m[5]] + svg[m[1]:]
	}

	// 5. Label classes. A <text> is told whether it names land or water so
	// the stylesheet can set it accordingly; it keeps its own class, which is
	// what carries its size.
	out := strings.Builder{}
	last := 0
	index := 0
	for _, m := range textOpenRe.FindAllStringSubmatchIndex(svg, -1) {
		if index >= len(plan.LabelClasses) {
			break
		}
		classes := plan.LabelClasses[index]
		index++
		body := svg[m[2]:m[3]]
		out.WriteString(svg[last:m[0]])
		if existing := classAttrRe.FindStringSubmatchIndex(body); existing != nil {
			out.WriteString("<text" + body[:existing[0]] +
				`class="` + body[existing[2]:existing[3]] + " " + classes + `"` +
				body[existing[1]:] + ">")
		} else {
			out.WriteString("<text" + body + ` class="` + classes + `">`)
		}
		last = m[1]
	}
	out.WriteString(svg[last:])
	svg = out.String()

	// 6. The grain overlay, into a drawing layer that ships empty.
	if style.Grain != nil {
		if m := emptyGrainRe.FindStringIndex(svg); m != nil {
			box := viewBoxRe.FindStringSubmatch(svg)
			parts := []string{"0", "0", "0", "0"}
			if box != nil {
				parts = strings.Fields(strings.ReplaceAll(strings.TrimSpace(box[1]), ",", " "))
			}
			rect := `<rect id="paper-grain" x="` + parts[0] + `" y="` + parts[1] +
				`" width="` + parts[2] + `" height="` + parts[3] + `"/>`
			svg = svg[:m[0]] + `<g id="HighestOrderLayer">` + rect + "</g>" + svg[m[1]:]
		}
	}
	return svg, nil
}
