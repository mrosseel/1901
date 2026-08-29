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
// `style` is here because real map art uses it: sailho is restyled by
// replacing its stylesheet, and layers carry `style="fill:none"`. Its text and
// the style attribute are both scrubbed by safeCSS, which is what makes them
// safe rather than the element name.
//
// Absent on purpose: script and handler (execute), foreignObject (embeds
// HTML), image (fetches), animate, animateTransform, set and animateMotion
// (can rewrite any attribute after the sanitiser has seen it), and a
// (navigates).
var safeSVGElements = map[string]bool{
	"svg": true, "g": true, "defs": true, "title": true, "desc": true,
	"path": true, "polygon": true, "polyline": true, "line": true,
	"rect": true, "circle": true, "ellipse": true,
	"text": true, "tspan": true,
	"marker": true, "symbol": true, "use": true,
	"linearGradient": true, "radialGradient": true, "stop": true,
	"clipPath": true, "mask": true, "pattern": true,
	"style": true,
	// `image` is here only for the raster a map paints its paper texture
	// with. It is the one element allowed to carry a `data:` URL, and only a
	// bitmap one: see safeRasterHref.
	"image": true,
}

// rasterImageTypes are the media types an <image> may embed. SVG is absent:
// an embedded SVG document is markup this sanitiser would never see, and it
// can carry a script.
var rasterImageTypes = map[string]bool{
	"png": true, "jpeg": true, "jpg": true, "gif": true, "webp": true,
}

// safeSVGAttributes is every attribute that may survive. Geometry,
// presentation, and identity.
//
// Every `on*` handler is absent. `style` is present but its value goes through
// safeCSS first.
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
	"style": true, "type": true,
	// Rendering hints: inert, and real map art carries them.
	"color-rendering": true, "shape-rendering": true, "text-rendering": true,
	"image-rendering": true, "vector-effect": true, "overflow": true,
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
	// inStyle marks CSS text, which is scrubbed rather than escaped.
	inStyle := false
	// depth of open elements. Text outside the root is not allowed in XML, and
	// an SVG that is not well-formed will not render in an <img> at all.
	depth := 0

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
			if name == "style" {
				inStyle = true
			}
			depth++
			out.WriteString("<" + name)
			for _, attr := range t.Attr {
				if !svgAttrAllowed(name, attr) {
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
			if t.Name.Local == "style" {
				inStyle = false
			}
			depth--
			out.WriteString("</" + t.Name.Local + ">")

		case xml.CharData:
			if skipDepth > 0 || depth == 0 {
				// Whitespace around the root element is not character data the
				// document may carry, and emitting it makes the SVG unparseable.
				continue
			}
			if inStyle {
				// A stylesheet is CSS, not markup: it is checked whole and
				// written unescaped, or dropped whole.
				if safeCSS(string(t)) {
					out.Write(t)
				} else {
					result.noteElement("style (unsafe css)")
				}
				continue
			}
			out.WriteString(escapeText(string(t)))

		case xml.Comment, xml.ProcInst, xml.Directive:
			// Comments carry nothing the board reads. A processing
			// instruction or a DOCTYPE can, so all three are dropped.
		}
	}

	result.Clean = out.Bytes()
	return result, nil
}

// escapeText escapes the three characters that would end an element or start
// an entity, and leaves everything else alone.
//
// encoding/xml's own EscapeText also turns newlines and tabs into numeric
// references. That is legal but it rewrites every line of the art into
// `&#xA;`, which is unreadable and, outside the root element, unparseable.
func escapeText(text string) string {
	replacer := strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;")
	return replacer.Replace(text)
}

// attrName renders an attribute name including its namespace prefix, so a
// dropped `xlink:href` is reported as `xlink:href`.
func attrName(attr xml.Attr) string {
	if attr.Name.Space == "" {
		return attr.Name.Local
	}
	// encoding/xml resolves a declared prefix to its URI, which is not a name
	// any document may carry. xlink is the only prefix that reaches the
	// output, on the href of an embedded bitmap.
	if attr.Name.Space == xlinkNamespace {
		return "xlink:" + attr.Name.Local
	}
	return attr.Name.Space + ":" + attr.Name.Local
}

const xlinkNamespace = "http://www.w3.org/1999/xlink"

// safeCSS reports whether a stylesheet or inline style is free of the things
// that make CSS fetch or execute.
//
// A same-document reference like `url(#gradient)` stays: it is how a shape
// points at a gradient in its own defs, and it reaches nothing outside.
func safeCSS(text string) bool {
	lower := strings.ToLower(text)
	for _, banned := range []string{
		"@import", "javascript:", "expression(", "behavior:", "-moz-binding",
		"</style", "<!--",
	} {
		if strings.Contains(lower, banned) {
			return false
		}
	}
	for index := 0; ; {
		at := strings.Index(lower[index:], "url(")
		if at < 0 {
			return true
		}
		index += at + len("url(")
		rest := strings.TrimLeft(lower[index:], " \t'\"")
		if !strings.HasPrefix(rest, "#") {
			return false
		}
	}
}

// safeRasterHref reports whether a value is an embedded bitmap and nothing
// else. A bitmap is pixels: it fetches nothing and executes nothing.
func safeRasterHref(value string) bool {
	rest, found := strings.CutPrefix(strings.ToLower(strings.TrimSpace(value)),
		"data:image/")
	if !found {
		return false
	}
	mediaType, rest, found := strings.Cut(rest, ";")
	if !found || !rasterImageTypes[mediaType] {
		return false
	}
	return strings.HasPrefix(rest, "base64,")
}

// svgAttrAllowed decides one attribute of one element.
func svgAttrAllowed(element string, attr xml.Attr) bool {
	name := attr.Name.Local
	lower := strings.ToLower(name)

	// Handlers are the whole point of this function.
	if strings.HasPrefix(lower, "on") {
		return false
	}
	// The one reference a board may carry: the bitmap an <image> paints. Real
	// map art draws its paper on one, and dropping it leaves a board that
	// renders but no longer looks like the map people played on.
	if element == "image" && lower == "href" &&
		(attr.Name.Space == "" || attr.Name.Space == "xlink" ||
			attr.Name.Space == xlinkNamespace) {
		return safeRasterHref(attr.Value)
	}
	// A namespace declaration is inert: it binds a prefix, and no attribute
	// carrying a prefix is allowed through. Anything else namespaced is xlink,
	// which is how a remote reference is spelled.
	if attr.Name.Space != "" && attr.Name.Space != "xmlns" {
		return false
	}
	if attr.Name.Space == "xmlns" {
		return true
	}
	// data-* is inert metadata, and the restyle tooling writes it (data-shrunk
	// records that a label was scaled). Dropping it would throw away the
	// tooling's own notes.
	if !safeSVGAttributes[name] && !strings.HasPrefix(lower, "data-") {
		return false
	}
	// A value can still carry a fetch or a script even under a safe name:
	// `fill="url(http://...)"`, `clip-path="url(javascript:...)"`.
	value := strings.ToLower(attr.Value)
	if strings.Contains(value, "data:") {
		return false
	}
	return safeCSS(attr.Value)
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

// requireBoardLayers checks the layer board.ts throws without. Art with no
// `#provinces` is not a board: nothing on it can be clicked or coloured.
func requireBoardLayers(svg []byte) error {
	if !bytes.Contains(svg, []byte(`id="provinces"`)) {
		return fmt.Errorf("map art has no provinces layer")
	}
	return nil
}

// missingCenterAnchors reports art with no `#province-centers` layer.
//
// It is not fatal. The layer is where the board reads a marker position when
// the variant has no approved placement table, and godip's Pure map ships
// without one, so refusing it would drop a playable variant over a fallback.
func missingCenterAnchors(svg []byte) bool {
	return !bytes.Contains(svg, []byte(`id="province-centers"`))
}
