// Restyling one of godip's own maps.
//
// These are drawn as one shape per province with a stroke for the border, so
// a style reaches them by palette substitution (ADR-024): every fill the plan
// named is replaced, and the names are reset in the style's typography.

package variant

import (
	"regexp"
	"strings"

	"spring1901/spike/internal/svgprune"
)

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
