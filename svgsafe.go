// Sanitising map art before it is served.
//
// A variant's board is SVG, and SVG is a scripting host: a `<script>` element,
// an `onload=` attribute, or an `xlink:href` to a remote document all execute
// in the page's origin. The compiled variants embed art that arrived through
// a code review, so they were never a concern. A generated variant's art
// arrives as a file in a directory, and this is where that file stops being
// trusted.
//
// The approach is an allowlist, not a blocklist. Anything this file does not
// name is dropped, so a construct nobody thought of is dropped too. The cost
// is that art using an element we forgot loses it, which is a visible bug
// rather than a silent hole.
package main

import (
	"bytes"
	"encoding/xml"
	"fmt"
	"io"
	"strings"
)

// safeSVGElements is every element a board may contain. Shapes, grouping,
// text, and the marker plumbing arrows need.
//
// Absent on purpose: script and handler (execute), foreignObject (embeds
// HTML), image (fetches), animate, animateTransform, set and animateMotion
// (can rewrite any attribute after the sanitiser has seen it), style (its
// text is CSS the parser here does not read, and CSS fetches), and a
// (navigates).
var safeSVGElements = map[string]bool{
	"svg": true, "g": true, "defs": true, "title": true, "desc": true,
	"path": true, "polygon": true, "polyline": true, "line": true,
	"rect": true, "circle": true, "ellipse": true,
	"text": true, "tspan": true,
	"marker": true, "symbol": true, "use": true,
	"linearGradient": true, "radialGradient": true, "stop": true,
	"clipPath": true, "mask": true, "pattern": true,
}

// safeSVGAttributes is every attribute that may survive. Geometry,
// presentation, and identity.
//
// Every `on*` handler is absent, and so is `style`: an inline style can carry
// `url(...)`, which fetches.
var safeSVGAttributes = map[string]bool{
	"id": true, "class": true, "transform": true, "viewBox": true,
	"width": true, "height": true, "x": true, "y": true, "x1": true,
	"y1": true, "x2": true, "y2": true, "cx": true, "cy": true, "r": true,
	"rx": true, "ry": true, "d": true, "points": true, "dx": true, "dy": true,
	"fill": true, "fill-opacity": true, "fill-rule": true,
	"stroke": true, "stroke-width": true, "stroke-opacity": true,
	"stroke-linecap": true, "stroke-linejoin": true, "stroke-dasharray": true,
	"stroke-dashoffset": true, "stroke-miterlimit": true,
	"opacity": true, "color": true, "display": true, "visibility": true,
	"font-family": true, "font-size": true, "font-weight": true,
	"font-style": true, "text-anchor": true, "dominant-baseline": true,
	"letter-spacing": true, "paint-order": true,
	"marker-start": true, "marker-mid": true, "marker-end": true,
	"markerWidth": true, "markerHeight": true, "refX": true, "refY": true,
	"orient": true, "markerUnits": true,
	"offset": true, "stop-color": true, "stop-opacity": true,
	"gradientUnits": true, "gradientTransform": true, "spreadMethod": true,
	"clip-path": true, "clip-rule": true, "mask": true,
	"patternUnits": true, "preserveAspectRatio": true,
	"xmlns": true, "version": true,
}

// svgSanitizeResult reports what a pass removed, so an operator can see that
// their art lost something rather than wondering why it renders oddly.
type svgSanitizeResult struct {
	Clean            []byte
	DroppedElements  []string
	DroppedAttrs     []string
	droppedElemSeen  map[string]bool
	droppedAttrsSeen map[string]bool
}

// sanitizeSVG rewrites map art keeping only allowlisted elements and
// attributes. It returns an error only when the input is not parseable XML.
func sanitizeSVG(raw []byte) (*svgSanitizeResult, error) {
	result := &svgSanitizeResult{
		droppedElemSeen:  map[string]bool{},
		droppedAttrsSeen: map[string]bool{},
	}

	decoder := xml.NewDecoder(bytes.NewReader(raw))
	// Map art is standalone; a DTD or external entity reference is an attempt
	// to read a file off the server, so no entities are resolved.
	decoder.Strict = false
	decoder.Entity = xml.HTMLEntity

	var out bytes.Buffer
	// depth of the subtree currently being discarded, 0 when emitting.
	skipDepth := 0

	for {
		token, err := decoder.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("parsing svg: %w", err)
		}

		switch t := token.(type) {
		case xml.StartElement:
			name := t.Name.Local
			if skipDepth > 0 {
				skipDepth++
				continue
			}
			if !safeSVGElements[name] {
				result.noteElement(name)
				skipDepth = 1
				continue
			}
			out.WriteString("<" + name)
			for _, attr := range t.Attr {
				if !svgAttrAllowed(attr) {
					result.noteAttr(attrName(attr))
					continue
				}
				out.WriteString(fmt.Sprintf(" %s=%q", attrName(attr), attr.Value))
			}
			out.WriteString(">")

		case xml.EndElement:
			if skipDepth > 0 {
				skipDepth--
				continue
			}
			out.WriteString("</" + t.Name.Local + ">")

		case xml.CharData:
			if skipDepth > 0 {
				continue
			}
			xml.EscapeText(&out, t)

		case xml.Comment, xml.ProcInst, xml.Directive:
			// Comments carry nothing the board reads. A processing
			// instruction or a DOCTYPE can, so all three are dropped.
		}
	}

	result.Clean = out.Bytes()
	return result, nil
}

// attrName renders an attribute name including its namespace prefix, so a
// dropped `xlink:href` is reported as `xlink:href`.
func attrName(attr xml.Attr) string {
	if attr.Name.Space == "" {
		return attr.Name.Local
	}
	return attr.Name.Space + ":" + attr.Name.Local
}

// svgAttrAllowed decides one attribute.
func svgAttrAllowed(attr xml.Attr) bool {
	name := attr.Name.Local
	lower := strings.ToLower(name)

	// Handlers are the whole point of this function.
	if strings.HasPrefix(lower, "on") {
		return false
	}
	// A namespaced attribute is either xlink (which is how remote references
	// are spelled) or a namespace declaration; neither is needed here.
	if attr.Name.Space != "" && attr.Name.Space != "xmlns" {
		return false
	}
	if !safeSVGAttributes[name] {
		return false
	}
	// A value can still carry a fetch or a script even under a safe name:
	// `fill="url(http://...)"`, `clip-path="url(javascript:...)"`.
	value := strings.ToLower(attr.Value)
	if strings.Contains(value, "javascript:") || strings.Contains(value, "data:") {
		return false
	}
	if strings.Contains(value, "url(") && !strings.Contains(value, "url(#") {
		return false
	}
	return true
}

func (self *svgSanitizeResult) noteElement(name string) {
	if !self.droppedElemSeen[name] {
		self.droppedElemSeen[name] = true
		self.DroppedElements = append(self.DroppedElements, name)
	}
}

func (self *svgSanitizeResult) noteAttr(name string) {
	if !self.droppedAttrsSeen[name] {
		self.droppedAttrsSeen[name] = true
		self.DroppedAttrs = append(self.DroppedAttrs, name)
	}
}

// Dropped reports whether the pass removed anything.
func (self *svgSanitizeResult) Dropped() bool {
	return len(self.DroppedElements) > 0 || len(self.DroppedAttrs) > 0
}

// Summary describes what was removed, for a log line.
func (self *svgSanitizeResult) Summary() string {
	parts := []string{}
	if len(self.DroppedElements) > 0 {
		parts = append(parts, "elements "+strings.Join(self.DroppedElements, ", "))
	}
	if len(self.DroppedAttrs) > 0 {
		parts = append(parts, "attributes "+strings.Join(self.DroppedAttrs, ", "))
	}
	return strings.Join(parts, "; ")
}

// requireBoardLayers checks the two layers board.ts depends on. It throws
// without `#provinces`, and it reads move anchors from `#province-centers`,
// so art missing them is a blank board rather than a broken one.
func requireBoardLayers(svg []byte) error {
	text := string(svg)
	for _, layer := range []string{`id="provinces"`, `id="province-centers"`} {
		if !strings.Contains(text, layer) {
			return fmt.Errorf("map art has no %v layer", strings.Trim(layer, `id="`))
		}
	}
	return nil
}
