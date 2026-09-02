// Reading and rewriting SVG as text.
//
// A restyle is string substitution, so every number it writes has to round
// the way the browser that measured the plan rounded — otherwise a length
// quoted against one map lands a fraction off on another. That is what num
// and jsRound are for, and it is why they are the first thing here.

package variant

import (
	"fmt"
	"math"
	"regexp"
	"strconv"
	"strings"
)

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
