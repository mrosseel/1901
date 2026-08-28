// Map conversion: a jDip map SVG becomes one our board can read.
//
// The board needs two things the jDip map does not offer directly:
//
//   - a "#provinces" layer whose direct children carry godip province keys,
//     used for hit testing and highlighting. jDip's MouseLayer is exactly
//     that geometry, down to the per-coast shapes the visible art lacks, so
//     it becomes the provinces layer; ids "stp-sc" become "stp/sc".
//   - a "<abbr>Center" anchor per province, which jDip does not draw at all.
//     Its PROVINCE_DATA block carries the coordinates where jDip places a
//     unit, in the root viewport space, so the anchors are generated from
//     those and put in an untransformed, hidden layer.
//
// Everything else is left alone. Restyling is a separate job.
package main

import (
	"fmt"
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

var (
	provinceDataPattern = regexp.MustCompile(`(?s)<jdipNS:PROVINCE_DATA.*?</jdipNS:PROVINCE_DATA>`)
	provinceEntry       = regexp.MustCompile(`(?s)<jdipNS:PROVINCE\s+name="([^"]*)"\s*>(.*?)</jdipNS:PROVINCE>`)
	unitCoords          = regexp.MustCompile(`<jdipNS:UNIT\s+x="\s*([-\d.]+)\s*"\s+y="\s*([-\d.]+)\s*"\s*/>`)
	jdipBlock           = regexp.MustCompile(`(?s)<jdipNS:[A-Z_]+.*?</jdipNS:[A-Z_]+>`)
	jdipEmpty           = regexp.MustCompile(`<jdipNS:[A-Z_]+[^>]*/>`)
	jdipNamespace       = regexp.MustCompile(`\s+xmlns:jdipNS="[^"]*"`)
	mouseLayerOpen      = regexp.MustCompile(`<g\s+id="MouseLayer"([^>]*)>`)
	idAttr              = regexp.MustCompile(`id="([A-Za-z0-9_-]+)"`)
	hiddenLabelLayer    = regexp.MustCompile(`(<g\s+id="FullLabelLayer"[^>]*?)\s+visibility="hidden"`)
	externalImage       = regexp.MustCompile(`<image[^>]*xlink:href="([^"]*)"`)
)

// anchor is one province's unit placement coordinate.
type anchor struct {
	province string
	x, y     string
}

// convertSVG rewrites the jDip map and returns it with a list of notes
// worth reporting.
func convertSVG(path string, m *model) (string, []string, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return "", nil, err
	}
	body := string(raw)
	report := []string{}

	// An external raster reference would not survive being served on its
	// own, so refuse rather than ship a map with a hole in it.
	if hit := externalImage.FindStringSubmatch(body); hit != nil {
		return "", nil, fmt.Errorf("%v references the external image %v; use the vector map instead", path, hit[1])
	}

	anchors, missing, err := readAnchors(body, m)
	if err != nil {
		return "", nil, err
	}
	if len(missing) > 0 {
		report = append(report, fmt.Sprintf("no PROVINCE_DATA unit coordinate for %v — those provinces get no center anchor", strings.Join(missing, ", ")))
	}

	body = stripDoctype(body)
	body = provinceDataPattern.ReplaceAllString(body, "")
	body = jdipBlock.ReplaceAllString(body, "")
	body = jdipEmpty.ReplaceAllString(body, "")
	body = jdipNamespace.ReplaceAllString(body, "")

	// The label layer ships hidden in jDip because jDip draws its own.
	before := body
	body = hiddenLabelLayer.ReplaceAllString(body, "$1")
	if body == before {
		report = append(report, "no hidden FullLabelLayer found to unhide")
	}

	body, shapes, unknown, err := renameMouseLayer(body, m)
	if err != nil {
		return "", nil, err
	}
	if len(unknown) > 0 {
		report = append(report, fmt.Sprintf("hit shapes with no province in the adjacency graph, left as they are: %v", strings.Join(unknown, ", ")))
	}
	if missingShapes := missingShapes(m, shapes); len(missingShapes) > 0 {
		report = append(report, fmt.Sprintf("no hit shape for %v — those provinces cannot be tapped", strings.Join(missingShapes, ", ")))
	}

	body, err = appendCenters(body, anchors)
	if err != nil {
		return "", nil, err
	}
	return body, report, nil
}

// readAnchors pulls the unit placement coordinates out of PROVINCE_DATA.
func readAnchors(body string, m *model) ([]anchor, []string, error) {
	block := provinceDataPattern.FindString(body)
	if block == "" {
		return nil, nil, fmt.Errorf("the map carries no jdipNS:PROVINCE_DATA block")
	}
	found := map[string]anchor{}
	for _, entry := range provinceEntry.FindAllStringSubmatch(block, -1) {
		name := strings.TrimSpace(entry[1])
		coords := unitCoords.FindStringSubmatch(entry[2])
		if coords == nil {
			continue
		}
		key := godipRef(name)
		found[key] = anchor{province: key, x: coords[1], y: coords[2]}
	}

	// Every province and every named coast wants an anchor.
	wanted := []string{}
	for _, key := range m.order {
		wanted = append(wanted, key)
		for code := range m.provinces[key].coasts {
			wanted = append(wanted, key+"/"+code)
		}
	}
	sort.Strings(wanted)

	anchors := []anchor{}
	missing := []string{}
	for _, key := range wanted {
		if a, ok := found[key]; ok {
			anchors = append(anchors, a)
			continue
		}
		// A coast with no anchor of its own sits on its province's.
		if base, coast := splitProvinceCoast(key); coast != "" {
			if a, ok := found[base]; ok {
				anchors = append(anchors, anchor{province: key, x: a.x, y: a.y})
				continue
			}
		}
		missing = append(missing, key)
	}
	return anchors, missing, nil
}

// splitProvinceCoast splits a godip key: "stp/sc" becomes ("stp", "sc").
func splitProvinceCoast(key string) (string, string) {
	cut := strings.Index(key, "/")
	if cut < 0 {
		return key, ""
	}
	return key[:cut], key[cut+1:]
}

// renameMouseLayer turns jDip's MouseLayer into our provinces layer and
// rewrites the ids inside it. It returns the shape ids it produced.
func renameMouseLayer(body string, m *model) (string, map[string]bool, []string, error) {
	open := mouseLayerOpen.FindStringSubmatchIndex(body)
	if open == nil {
		return "", nil, nil, fmt.Errorf("the map carries no MouseLayer")
	}
	end := strings.Index(body[open[1]:], "</g>\n")
	// The layer's own closing tag is the last one in the file, because the
	// mouse layer is by convention the final layer jDip renders.
	closing := strings.LastIndex(body, "</g>")
	if closing < open[1] {
		return "", nil, nil, fmt.Errorf("the MouseLayer is not closed")
	}
	_ = end

	attrs := body[open[2]:open[3]]
	// The invisible class is jDip's way of hiding the layer; our stylesheet
	// takes that job over and needs the layer left alone.
	attrs = strings.ReplaceAll(attrs, ` class="invisible"`, "")
	head := `<g id="provinces"` + attrs + `>`

	inner := body[open[1]:closing]
	shapes := map[string]bool{}
	unknownSet := map[string]bool{}
	inner = idAttr.ReplaceAllStringFunc(inner, func(match string) string {
		id := idAttr.FindStringSubmatch(match)[1]
		key := godipRef(id)
		base, coast := splitProvinceCoast(key)
		p, known := m.provinces[base]
		if !known || (coast != "" && p.coasts[coast] == nil) {
			unknownSet[id] = true
			return match
		}
		shapes[key] = true
		return `id="` + key + `"`
	})

	unknown := []string{}
	for id := range unknownSet {
		unknown = append(unknown, id)
	}
	sort.Strings(unknown)
	return body[:open[0]] + head + inner + body[closing:], shapes, unknown, nil
}

// missingShapes lists provinces the map cannot show a hit area for.
func missingShapes(m *model, shapes map[string]bool) []string {
	missing := []string{}
	for _, key := range m.order {
		if !shapes[key] {
			missing = append(missing, key)
		}
		for code := range m.provinces[key].coasts {
			if !shapes[key+"/"+code] {
				missing = append(missing, key+"/"+code)
			}
		}
	}
	sort.Strings(missing)
	return missing
}

// appendCenters adds the generated anchor layer just before </svg>. The
// layer carries no transform, because PROVINCE_DATA coordinates are in the
// root viewport space — the same space jDip's own unit layer uses.
func appendCenters(body string, anchors []anchor) (string, error) {
	cut := strings.LastIndex(body, "</svg>")
	if cut < 0 {
		return "", fmt.Errorf("the map has no closing svg tag")
	}
	layer := strings.Builder{}
	layer.WriteString("\n\t<!-- Unit anchors generated from jDip's PROVINCE_DATA. -->\n")
	layer.WriteString("\t<g id=\"province-centers\" style=\"display:none\">\n")
	for _, a := range anchors {
		layer.WriteString(fmt.Sprintf("\t\t<path id=%q d=\"m %v,%v\"/>\n",
			a.province+"Center", trimNumber(a.x), trimNumber(a.y)))
	}
	layer.WriteString("\t</g>\n")
	return body[:cut] + layer.String() + body[cut:], nil
}

// trimNumber normalizes a coordinate for the generated path data.
func trimNumber(raw string) string {
	value, err := strconv.ParseFloat(strings.TrimSpace(raw), 64)
	if err != nil {
		return strings.TrimSpace(raw)
	}
	return strconv.FormatFloat(value, 'f', -1, 64)
}
