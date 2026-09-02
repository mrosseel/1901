// The application half of a restyle (ADR-026).
//
// dipmap detects; this applies. Given the original art, the style plan
// measured from it, and a style's tokens, the two functions here compose the
// styled map as a string substitution — no browser, no coordinate touched.
// What changes is a fill value, a pattern's insides, a stroke, a text's
// typography and, on a converted jDip map, the stylesheet. What does not
// change is one drawn element, one id or one coordinate, which
// restyle_test.go checks rather than assumes.
//
// The one element that does go is a definition the styled map no longer
// points at, which svgprune reads the document to find. That is the only
// parse here, and it draws nothing either way.
//
// The two appliers exist because the two kinds of map are drawn differently
// (ADR-024). A converted jDip map paints every province through a semantic
// class, so replacing its stylesheet restyles the whole board. No godip map
// has a class of any kind — classical paints its landmass as one path with a
// literal fill over a sea-coloured rect — so there the substitution is by
// VALUE, on the palette the plan measured.
package app

import (
	"fmt"
	"math"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"spring1901/spike/internal/svgsafe"
	"spring1901/spike/svgprune"
)

// --- numbers ---------------------------------------------------------------

// num formats a number the way JavaScript's String() does, because these
// values are compared against art that the detector wrote.
func num(value float64) string {
	return strconv.FormatFloat(value, 'f', -1, 64)
}

// jsRound rounds half UP, as Math.round does, rather than half away from zero.
func jsRound(value float64) float64 {
	return math.Floor(value + 0.5)
}

// carryLength moves a length quoted against one map's width onto another's.
//
// A style's numbers are quoted in its reference units, and those mean nothing
// on a map drawn eight times larger: a border that reads as a hairline on a
// 1524-unit map has to be 4.8 units on a 7300-unit one to look the same, and
// 48 units inside a layer the map then scales by a tenth. So every length
// crosses as a fraction of the width, divided by the scale of the layer it
// lands in. This is the only arithmetic in a restyle, and it touches
// presentation lengths only — never a coordinate.
func carryLength(value, from, to, layerScale float64) float64 {
	if layerScale == 0 {
		layerScale = 1
	}
	scaled := (value / from) * to / layerScale
	return jsRound(scaled*1000) / 1000
}

// --- colour ----------------------------------------------------------------

var (
	shortHexRe = regexp.MustCompile(`^#([0-9a-f])([0-9a-f])([0-9a-f])$`)
	longHexRe  = regexp.MustCompile(`^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$`)
	rgbRe      = regexp.MustCompile(`^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)`)
)

// parseColour reads #rgb, #rrggbb or rgb(r, g, b) as three 0-255 channels.
func parseColour(value string) ([3]float64, bool) {
	text := strings.ToLower(strings.TrimSpace(value))
	if m := shortHexRe.FindStringSubmatch(text); m != nil {
		out := [3]float64{}
		for i := 0; i < 3; i++ {
			n, _ := strconv.ParseInt(m[i+1]+m[i+1], 16, 32)
			out[i] = float64(n)
		}
		return out, true
	}
	if m := longHexRe.FindStringSubmatch(text); m != nil {
		out := [3]float64{}
		for i := 0; i < 3; i++ {
			n, _ := strconv.ParseInt(m[i+1], 16, 32)
			out[i] = float64(n)
		}
		return out, true
	}
	if m := rgbRe.FindStringSubmatch(text); m != nil {
		out := [3]float64{}
		for i := 0; i < 3; i++ {
			f, _ := strconv.ParseFloat(m[i+1], 64)
			out[i] = jsRound(f)
		}
		return out, true
	}
	return [3]float64{}, false
}

func toHex(rgb [3]float64) string {
	out := "#"
	for _, one := range rgb {
		v := int(jsRound(one))
		if v < 0 {
			v = 0
		}
		if v > 255 {
			v = 255
		}
		out += fmt.Sprintf("%02x", v)
	}
	return out
}

// luma is Rec. 601 luma, 0 for black and 1 for white.
func luma(value string) float64 {
	rgb, ok := parseColour(value)
	if !ok {
		return 0.5
	}
	return (0.299*rgb[0] + 0.587*rgb[1] + 0.114*rgb[2]) / 255
}

// carryTone moves target by the lightness difference between variant and base.
//
// A map whose land is two tones should still be two tones after a restyle.
// The style names one land colour, so the second is made by giving it the
// same lightness step the map gave its own. The step is capped, or a very
// dark second tone would drive the result to black.
func carryTone(target, base, variant string) string {
	step := math.Max(-0.35, math.Min(0.35, luma(variant)-luma(base)))
	rgb, ok := parseColour(target)
	if !ok {
		return target
	}
	shift := step * 255
	return toHex([3]float64{rgb[0] + shift, rgb[1] + shift, rgb[2] + shift})
}

// --- small readers over the raw text ---------------------------------------

var viewBoxRe = regexp.MustCompile(`<svg\b[^>]*\bviewBox="([^"]+)"`)

// viewBoxWidth is the map's own width in its own units.
func viewBoxWidth(svg string) (float64, error) {
	m := viewBoxRe.FindStringSubmatch(svg)
	if m == nil {
		return 0, fmt.Errorf("this map has no viewBox")
	}
	parts := strings.FieldsFunc(strings.TrimSpace(m[1]), func(r rune) bool {
		return r == ' ' || r == ',' || r == '\t' || r == '\n'
	})
	if len(parts) < 3 {
		return 0, fmt.Errorf("this map's viewBox has no width")
	}
	width, err := strconv.ParseFloat(parts[2], 64)
	if err != nil || width == 0 {
		return 0, fmt.Errorf("this map's viewBox has no width")
	}
	return width, nil
}

// urlPatternRe matches a url(#id) fill, which names a pattern.
var urlPatternRe = regexp.MustCompile(`^url\(["']?#([^)"']+)["']?\)`)

func patternID(fill string) string {
	m := urlPatternRe.FindStringSubmatch(strings.TrimSpace(fill))
	if m == nil {
		return ""
	}
	return m[1]
}

// normaliseFill spells a colour written any of the ways SVG allows one way.
func normaliseFill(value string) string {
	text := strings.ToLower(strings.Join(strings.Fields(value), " "))
	if rgb, ok := parseColour(text); ok {
		return toHex(rgb)
	}
	text = strings.NewReplacer(`"`, "", "'", "").Replace(text)
	text = regexp.MustCompile(`\(\s*`).ReplaceAllString(text, "(")
	text = regexp.MustCompile(`\s*\)`).ReplaceAllString(text, ")")
	return text
}

// prop is one presentation declaration. They are an ordered list rather than
// a map because the output is compared byte for byte against the art the
// TypeScript applier wrote, and a map would reorder them.
type prop struct {
	name  string
	value string
}

// setStyleProps sets each declaration on an inline style attribute, replacing
// any the attribute already had and keeping the rest in place.
func setStyleProps(style string, props []prop) string {
	kept := []string{}
	for _, part := range strings.Split(style, ";") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		name := part
		if i := strings.Index(part, ":"); i >= 0 {
			name = part[:i]
		}
		name = strings.TrimSpace(name)
		replaced := false
		for _, one := range props {
			if one.name == name {
				replaced = true
				break
			}
		}
		if !replaced {
			kept = append(kept, part)
		}
	}
	for _, one := range props {
		kept = append(kept, one.name+":"+one.value)
	}
	return strings.Join(kept, ";")
}

var styleAttrRe = regexp.MustCompile(`\bstyle="([^"]*)"`)
var tagCloseRe = regexp.MustCompile(`(/?)>$`)

// withStyle returns one element's opening tag with the declarations set.
func withStyle(tag string, props []prop) string {
	if m := styleAttrRe.FindStringSubmatchIndex(tag); m != nil {
		next := setStyleProps(tag[m[2]:m[3]], props)
		return tag[:m[0]] + `style="` + next + `"` + tag[m[1]:]
	}
	next := setStyleProps("", props)
	return tagCloseRe.ReplaceAllString(tag, ` style="`+next+`"$1>`)
}

// layerOpenRe matches one layer's opening tag. godip's maps are Inkscape
// files whose drawing layers carry their name as a label and their id as
// whatever the editor last generated, so either spelling is accepted.
func layerOpenRe(name string) *regexp.Regexp {
	return regexp.MustCompile(
		`<g\b[^>]*\b(?:id|inkscape:label)="` + regexp.QuoteMeta(name) + `"[^>]*?(/)?>`)
}

// layerSpan finds one layer's text, from its opening tag to its matching
// close.
func layerSpan(svg, name string) (start, end int, found bool) {
	open := layerOpenRe(name)
	m := open.FindStringSubmatchIndex(svg)
	if m == nil {
		return 0, 0, false
	}
	if m[2] >= 0 {
		// Self-closing: the layer is its own opening tag.
		return m[0], m[1], true
	}
	depth := 1
	scan := regexp.MustCompile(`<g\b[^>]*?(/)?>|</g>`)
	for _, step := range scan.FindAllStringSubmatchIndex(svg[m[1]:], -1) {
		at := m[1] + step[0]
		text := svg[at : m[1]+step[1]]
		if text == "</g>" {
			depth--
		} else if step[2] < 0 {
			depth++
		}
		if depth == 0 {
			return m[0], m[1] + step[1], true
		}
	}
	return m[0], len(svg), true
}

var (
	transformAttrRe = regexp.MustCompile(`\btransform="([^"]*)"`)
	scaleFuncRe     = regexp.MustCompile(`\bscale\(\s*(-?[0-9.]+)`)
	matrixFuncRe    = regexp.MustCompile(`\bmatrix\(\s*(-?[0-9.]+)`)
)

// transformScale reads how much a transform list magnifies what it draws.
//
// Only the horizontal factor is read, because a map drawn at different
// horizontal and vertical scales would have no single unit for a length to
// be quoted in. A translation magnifies nothing and is ignored.
func transformScale(transform string) float64 {
	scale := 1.0
	for _, re := range []*regexp.Regexp{scaleFuncRe, matrixFuncRe} {
		for _, m := range re.FindAllStringSubmatch(transform, -1) {
			one, err := strconv.ParseFloat(m[1], 64)
			if err != nil || one == 0 {
				continue
			}
			scale *= math.Abs(one)
		}
	}
	return scale
}

// labelLayerScale is the scale a jDip map draws its NAMES at, which is not
// the scale it draws its art at (ADR-026).
//
// jDip writes its art under a transform and its two name layers as siblings
// of it, so a length in a label rule and a length in a terrain rule are
// quoted in different units. The art is what decides this, so a plan that
// states no label scale gets it from here rather than from the art scale. A
// name layer that carries no transform of its own is drawn at 1.
func labelLayerScale(svg string) float64 {
	for _, name := range []string{"FullLabelLayer", "BriefLabelLayer"} {
		tag := layerOpenRe(name).FindString(svg)
		if tag == "" {
			continue
		}
		if m := transformAttrRe.FindStringSubmatch(tag); m != nil {
			return transformScale(m[1])
		}
		return 1
	}
	return 1
}

// --- fill substitution ------------------------------------------------------

// protectedRanges are the <defs> and <style> blocks, which fill substitution
// skips: the definitions are rewritten whole by the pattern pass, and the
// map's stylesheet is an embedded font.
func protectedRanges(svg string) [][2]int {
	ranges := [][2]int{}
	for _, name := range []string{"defs", "style"} {
		open := regexp.MustCompile(`<` + name + `\b[^>]*>`)
		for _, m := range open.FindAllStringIndex(svg, -1) {
			close := strings.Index(svg[m[0]:], "</"+name+">")
			if close < 0 {
				ranges = append(ranges, [2]int{m[0], len(svg)})
				continue
			}
			ranges = append(ranges, [2]int{m[0], m[0] + close + len(name) + 3})
		}
	}
	return ranges
}

var (
	fillAttrRe = regexp.MustCompile(`(\bfill=")([^"]*)(")`)
	fillPropRe = regexp.MustCompile(`(fill\s*:\s*)([^;"'}]+)([;"'}])`)
)

// replaceFills rewrites every fill the plan names, wherever the map paints
// it. Both spellings are handled — fill="#f4d7b5" and style="…;fill:…;…" —
// because godip's maps use both, sometimes on the same element.
func replaceFills(svg string, lookup map[string]string) string {
	skip := protectedRanges(svg)
	guarded := func(index int) bool {
		for _, one := range skip {
			if index >= one[0] && index < one[1] {
				return true
			}
		}
		return false
	}
	swap := func(s string, re *regexp.Regexp) string {
		out := strings.Builder{}
		last := 0
		for _, m := range re.FindAllStringSubmatchIndex(s, -1) {
			if guarded(m[0]) {
				continue
			}
			target, found := lookup[normaliseFill(s[m[4]:m[5]])]
			if !found {
				continue
			}
			out.WriteString(s[last:m[0]])
			out.WriteString(s[m[2]:m[3]])
			out.WriteString(target)
			out.WriteString(s[m[6]:m[7]])
			last = m[1]
		}
		out.WriteString(s[last:])
		return out.String()
	}
	return swap(swap(svg, fillAttrRe), fillPropRe)
}

// replacePattern swaps the insides of one <pattern id="…"> for another's,
// keeping the id, so every reference to it still resolves and no id is added
// or lost.
func replacePattern(svg, id, definition string) (string, bool) {
	open := regexp.MustCompile(`<pattern\b[^>]*\bid="` + regexp.QuoteMeta(id) + `"[^>]*?(/)?>`)
	m := open.FindStringSubmatchIndex(svg)
	if m == nil {
		return svg, false
	}
	end := m[1]
	if m[2] < 0 {
		at := strings.Index(svg[m[0]:], "</pattern>")
		if at < 0 {
			return svg, false
		}
		end = m[0] + at + len("</pattern>")
	}
	// The style's own pattern, renamed to the id this map already points at.
	// Only the first id in the definition is the pattern's own.
	renamed := definition
	if idm := regexp.MustCompile(`\bid="[^"]*"`).FindStringIndex(definition); idm != nil {
		renamed = definition[:idm[0]] + `id="` + id + `"` + definition[idm[1]:]
	}
	return svg[:m[0]] + renamed + svg[end:], true
}

// --- godip's own maps -------------------------------------------------------

var shapeRe = regexp.MustCompile(`<(path|polygon|polyline|rect|circle|ellipse)\b([^>]*)>`)

var (
	filterPropRe = regexp.MustCompile(`filter\s*:`)
	filterAttrRe = regexp.MustCompile(`\bfilter="`)
	strokePropRe = regexp.MustCompile(`(?:^|;)\s*stroke\s*:\s*([^;]+)`)
	strokeAttrRe = regexp.MustCompile(`\bstroke="([^"]+)"`)
)

// isBorderStroke reports whether a shape is a dark hairline — a province
// border — rather than a drop shadow, a frame or part of a name.
func isBorderStroke(body string) bool {
	declared := ""
	if m := styleAttrRe.FindStringSubmatch(body); m != nil {
		declared = m[1]
	}
	if filterPropRe.MatchString(declared) || filterAttrRe.MatchString(body) {
		return false
	}
	stroke := strokePropRe.FindStringSubmatch(declared)
	if stroke == nil {
		stroke = strokeAttrRe.FindStringSubmatch(body)
	}
	if stroke == nil {
		return false
	}
	colour := strings.TrimSpace(stroke[1])
	return colour != "none" && luma(colour) <= 0.4
}

// substitutions is every fill value this map paints and what the style paints
// it with instead.
//
// The two base tones go to the style's two. An extra tone goes to the style's
// base tone shifted by the lightness step it had from the map's own. A hatch
// is left to the pattern rewrite, which needs the definition rather than the
// value — unless the style paints impassable ground as a flat colour, in
// which case the value goes here after all.
func substitutions(plan *godipPlan, style *loadedStyle) map[string]string {
	out := map[string]string{}
	out[normaliseFill(plan.Sea)] = style.Terrain.Sea
	out[normaliseFill(plan.Land)] = style.Terrain.Land
	for _, extra := range plan.Extras {
		base, target := plan.Land, style.Terrain.Land
		if extra.Near == "sea" {
			base, target = plan.Sea, style.Terrain.Sea
		}
		out[normaliseFill(extra.Fill)] = carryTone(target, base, extra.Fill)
	}
	if plan.ImpassablePattern != "" && patternID(style.Terrain.Impassable) == "" {
		out[normaliseFill("url(#"+plan.ImpassablePattern+")")] = style.Terrain.Impassable
	}
	return out
}

// pruneUnreferenced drops the definitions the styled art no longer reaches.
//
// It is called once the grain overlay has stopped naming its pattern, which
// is what leaves that pattern — and the photograph of paper inside it —
// unreferenced. The impassable hatch is passed as a root because a style may
// paint impassable ground as a flat colour, and the pattern is then held by
// the plan rather than by any shape.
func pruneUnreferenced(svg []byte, impassablePattern string) []byte {
	var roots []string
	if impassablePattern != "" {
		roots = append(roots, impassablePattern)
	}
	out, _ := svgprune.Art(svg, roots)
	return out
}

// applyGodipStyle puts one of godip's own maps into a style.
//
// Nothing here adds or moves an element, and nothing that draws is removed.
// The five things it does are each one property: a fill value, a pattern's
// insides, the grain's strength, a border stroke, a name's typography. The
// definitions a grainless style orphans are then pruned.
func applyGodipStyle(original string, plan *godipPlan, style *loadedStyle) (string, error) {
	width, err := viewBoxWidth(original)
	if err != nil {
		return "", err
	}
	carry := func(value float64) string {
		return num(carryLength(value, style.ReferenceWidth, width, 1))
	}
	svg := original

	// 1. The terrain, by value.
	svg = replaceFills(svg, substitutions(plan, style))

	// 2. The impassable hatch. The map already points at a pattern by id, so
	// the definition is swapped and the id kept.
	if hatch := patternID(style.Terrain.Impassable); plan.ImpassablePattern != "" && hatch != "" {
		for _, definition := range style.LoadedDefs {
			if !strings.Contains(definition, `id="`+hatch+`"`) {
				continue
			}
			if replaced, ok := replacePattern(svg, plan.ImpassablePattern, definition); ok {
				svg = replaced
			}
			break
		}
	}

	// 3. The grain. Every one of these maps lays a paper noise over the
	// finished art; a style either wants it at its own strength or does not
	// want it. The texture stays the map's own — it is a photograph of paper,
	// not a style decision — and only its strength changes.
	//
	// A style that wants none does not dim the overlay, it stops naming the
	// paper: the pattern is then reachable from nothing, and the prune below
	// takes it away with the photograph inside it. The overlay element itself
	// has to stay. On seven of the ten maps that carry one it also carries a
	// stroke, and that hairline frame is the map's own, not the grain's.
	if plan.GrainOverlayID != "" {
		fill := prop{"fill", "none"}
		if style.Grain != nil {
			fill = prop{"fill-opacity", num(style.Grain.Opacity)}
		}
		tag := regexp.MustCompile(
			`<[a-z]+\b[^>]*\bid="` + regexp.QuoteMeta(plan.GrainOverlayID) + `"[^>]*?>`)
		if m := tag.FindStringIndex(svg); m != nil {
			svg = svg[:m[0]] + withStyle(svg[m[0]:m[1]], []prop{fill}) + svg[m[1]:]
		}
		if style.Grain == nil {
			svg = string(pruneUnreferenced([]byte(svg), plan.ImpassablePattern))
		}
	}

	// 4. The province borders: the dark strokes in the foreground layer,
	// where a godip map keeps its province edges. The coastline's drop shadow
	// is in the background layer, under the land, and is left alone — a soft
	// dark edge under a coast is the drawing, not the styling.
	if plan.Borders.Found && !plan.Borders.Decoration {
		if start, end, ok := layerSpan(svg, "foreground"); ok {
			text := svg[start:end]
			out := strings.Builder{}
			last := 0
			for _, m := range shapeRe.FindAllStringSubmatchIndex(text, -1) {
				if !isBorderStroke(text[m[4]:m[5]]) {
					continue
				}
				out.WriteString(text[last:m[0]])
				out.WriteString(withStyle(text[m[0]:m[1]], []prop{
					{"stroke", style.Border.Stroke},
					{"stroke-width", carry(style.Border.Width)},
					{"stroke-opacity", num(style.Border.Opacity)},
					{"stroke-linejoin", style.Border.Linejoin},
				}))
				last = m[1]
			}
			out.WriteString(text[last:])
			svg = svg[:start] + out.String() + svg[end:]
		}
	}

	// 5. The names. Which face a name is set in follows what it stands on,
	// which the plan settled once. Sizes are not touched: godip's names are
	// hand-set to fit their provinces, and the placement tables were measured
	// against the boxes they make.
	if plan.Names.Found {
		if start, end, ok := layerSpan(svg, "names"); ok {
			svg = svg[:start] + setNames(svg[start:end], plan, style, carry) + svg[end:]
			// The faces, where the style embeds any and the map does not
			// already carry them. They go into the map's own <style> block,
			// which every godip map has for exactly this purpose.
			if style.FontFaces != "" && !strings.Contains(svg, "@font-face") {
				if m := regexp.MustCompile(`<style\b[^>]*>`).FindStringIndex(svg); m != nil {
					svg = svg[:m[1]] + "\n" + style.FontFaces + "\n" + svg[m[1]:]
				}
			}
		}
	}
	return svg, nil
}

var textOrTspanRe = regexp.MustCompile(`<(text|tspan)\b([^>]*)>`)

var nameIDRe = regexp.MustCompile(`\bid="([^"]*)Name"`)

// setNames sets one names layer in the style's typography. A tspan inherits
// the kind of the text it belongs to, and the two are walked in document
// order, so the last verdict is carried.
//
// The position in the layer keys a version-1 plan's verdicts; a version-2 plan
// keys them by province, which is read off the `<key>Name` id godip's exporter
// writes. A version-2 map draws no names layer, so that second path is only
// reached by a map caught mid-migration.
func setNames(text string, plan *godipPlan, style *loadedStyle, carry func(float64) string) string {
	out := strings.Builder{}
	last := 0
	index := 0
	lastKind := "land"
	for _, m := range textOrTspanRe.FindAllStringSubmatchIndex(text, -1) {
		kind := lastKind
		if text[m[2]:m[3]] == "text" {
			province := ""
			if id := nameIDRe.FindStringSubmatch(text[m[0]:m[1]]); id != nil {
				province = id[1]
			}
			kind = "land"
			if stated := plan.Names.Kinds.kindOf(province, index); stated != "" {
				kind = stated
			}
			index++
			lastKind = kind
		}
		face := style.Typography.Land
		if kind == "sea" {
			face = style.Typography.Sea
		}
		props := []prop{
			{"font-family", face.Family},
			{"font-weight", face.Weight},
			{"font-style", face.Style},
			{"letter-spacing", carry(face.LetterSpacing)},
			{"fill", face.Fill},
		}
		if face.Halo != nil {
			props = append(props,
				prop{"paint-order", "stroke"},
				prop{"stroke", face.Halo.Color},
				prop{"stroke-width", carry(face.Halo.Width)},
				prop{"stroke-linejoin", "round"},
				prop{"stroke-linecap", "round"})
		} else {
			props = append(props, prop{"stroke", "none"})
		}
		out.WriteString(text[last:m[0]])
		out.WriteString(withStyle(text[m[0]:m[1]], props))
		last = m[1]
	}
	out.WriteString(text[last:])
	return out.String()
}

// --- converted jDip maps ----------------------------------------------------

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

// --- supply-centre rings -----------------------------------------------------

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

// replaceFirst replaces the first match only, which is what a JavaScript
// String.replace with an unflagged pattern does.
func replaceFirst(s string, re *regexp.Regexp, with string) string {
	m := re.FindStringIndex(s)
	if m == nil {
		return s
	}
	return s[:m[0]] + with + s[m[1]:]
}

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

// applyStyle composes one styled map out of the original art, the plan
// measured from it, and the style's tokens.
func applyStyle(original string, plan *stylePlan, style *loadedStyle, centres []string) (string, error) {
	switch plan.Kind {
	case "godip":
		return applyGodipStyle(original, plan.Godip, style)
	case "jdip":
		return applyJDipStyle(original, plan.JDip, style, centres)
	}
	return "", fmt.Errorf("style plan for %v names no applier kind", plan.Key)
}
