// Removing the definitions in map art that nothing on the board points at.
//
// godip's boards carry their paper texture as a PNG inside a <pattern>, and the
// export they came from left several generations of that texture behind: on
// classical, three of the four patterns are orphans, and only one is ever
// painted. Base64 is expensive — 1.4 MB across the maps here sits in patterns
// no shape names — and none of it draws a pixel.
//
// A definition is not part of the picture until something references it, so the
// question this package answers is reachability, not tidiness. It starts from
// the elements that actually paint, follows every url(#id) and every reference
// href they carry, and follows the chain onwards: a pattern may inherit from
// another pattern, a gradient from another gradient, a use may name a shape
// that itself carries a clip-path. Only a definition that no chain arrives at
// is dropped.
//
// The bias throughout is to keep. An element whose kind this package does not
// recognise as a definition survives, an element with no id survives (nothing
// could have pointed at it, but nothing proves it was meant as a definition
// either), and a <style>, <title> or <desc> survives wherever it sits, because
// a stylesheet paints without being named. Keeping a dead pattern costs bytes.
// Dropping a live one costs the map.
package svgprune

import (
	"bytes"
	"encoding/xml"
	"io"
	"regexp"
	"strings"
)

// definitionElements are the elements that render only when something
// references them. They paint nothing where they stand, wherever they stand.
var definitionElements = map[string]bool{
	"pattern": true, "linearGradient": true, "radialGradient": true,
	"marker": true, "symbol": true, "clipPath": true, "mask": true,
	"filter": true,
}

// alwaysKeep are the elements that act without being named, so their being
// unreferenced says nothing. A stylesheet inside <defs> styles the whole
// document; a title is what a screen reader reads.
var alwaysKeep = map[string]bool{
	"style": true, "title": true, "desc": true, "metadata": true,
	"font": true, "font-face": true, "color-profile": true,
	"script": true, "defs": true,
}

// referenceRe finds a same-document reference in an attribute value or in CSS:
// `url(#id)`, `url("#id")` and `url('#id')` are all the same reference.
var referenceRe = regexp.MustCompile(`url\(\s*['"]?\s*#([^)'"\s]+)`)

// node is one element of the parsed document, with the byte span it occupies
// so that a removal can cut the original bytes rather than reprint them.
type node struct {
	name   string
	id     string
	parent int
	start  int
	end    int
	refs   []string
	// inert marks an element that paints nothing where it stands: a definition
	// element, or anything sitting inside <defs>.
	inert bool
	// reached marks an element some chain arrives at, directly or through an
	// ancestor that was itself reached.
	reached bool
}

// Art removes the unreachable definitions from one SVG and returns the new
// bytes together with the ids it dropped, in document order.
//
// roots are ids reached from outside the file. A style plan names the hatch it
// repaints and the paper grain it fades, and those are held by a plan rather
// than by any shape in the art, so a reachability walk over the document alone
// would not see them.
//
// Art on art it cannot parse returns the input unchanged and no ids: this
// package never guesses at markup it did not understand.
func Art(svg []byte, roots []string) ([]byte, []string) {
	nodes, ok := parse(svg)
	if !ok {
		return svg, nil
	}
	byID := map[string]int{}
	for index, n := range nodes {
		// A duplicated id is the document's problem, not this package's. The
		// first wins, which is what a browser's getElementById does.
		if n.id != "" {
			if _, seen := byID[n.id]; !seen {
				byID[n.id] = index
			}
		}
	}

	markReachable(nodes, byID, roots)

	var drop []int
	var dropped []string
	for index, n := range nodes {
		if !removable(nodes, index) {
			continue
		}
		drop = append(drop, index)
		dropped = append(dropped, n.id)
	}
	if len(drop) == 0 {
		return svg, nil
	}
	return cut(svg, nodes, drop), dropped
}

// markReachable walks out from everything that paints.
//
// The seed is every element that is not inert: those draw wherever they sit, so
// the references they carry are live. Reaching a definition makes its whole
// subtree live too — a pattern's <image> child paints because the pattern does.
func markReachable(nodes []node, byID map[string]int, roots []string) {
	queue := append([]string{}, roots...)
	push := func(refs []string) { queue = append(queue, refs...) }

	for index := range nodes {
		if !nodes[index].inert {
			nodes[index].reached = true
			push(nodes[index].refs)
		}
	}
	for len(queue) > 0 {
		id := queue[len(queue)-1]
		queue = queue[:len(queue)-1]
		index, found := byID[id]
		if !found || nodes[index].reached {
			continue
		}
		// The whole subtree of a reached definition is reached: it is drawn as
		// one thing, and its children's own references go with it.
		end := nodes[index].end
		for i := index; i < len(nodes) && nodes[i].start < end; i++ {
			if nodes[i].reached {
				continue
			}
			nodes[i].reached = true
			push(nodes[i].refs)
		}
	}
}

// removable decides one element.
//
// It has to be a definition — a definition element anywhere, or a child of
// <defs> — that carries an id nothing used, and no ancestor may already have
// been removed or reached: a subtree is cut at its top, and an element under a
// live definition is part of that definition.
func removable(nodes []node, index int) bool {
	n := nodes[index]
	if n.reached || n.id == "" || alwaysKeep[n.name] {
		return false
	}
	if !definitionElements[n.name] && !(n.parent >= 0 && nodes[n.parent].name == "defs") {
		return false
	}
	for parent := n.parent; parent >= 0; parent = nodes[parent].parent {
		if removable(nodes, parent) {
			return false
		}
	}
	return true
}

// parse reads the document into a flat list of elements in document order,
// each with the byte span it occupies.
func parse(svg []byte) ([]node, bool) {
	decoder := xml.NewDecoder(bytes.NewReader(svg))
	decoder.Strict = false
	decoder.Entity = xml.HTMLEntity

	var nodes []node
	var open []int
	// styleOf is the element a run of character data belongs to, so that the
	// url(#id) inside a stylesheet counts as a reference from it.
	for {
		before := int(decoder.InputOffset())
		token, err := decoder.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, false
		}
		after := int(decoder.InputOffset())

		switch t := token.(type) {
		case xml.StartElement:
			parent := -1
			if len(open) > 0 {
				parent = open[len(open)-1]
			}
			n := node{name: t.Name.Local, parent: parent, start: before, end: after}
			n.inert = definitionElements[n.name] ||
				(parent >= 0 && (nodes[parent].name == "defs" || nodes[parent].inert))
			for _, attr := range t.Attr {
				if attr.Name.Local == "id" && attr.Name.Space == "" {
					n.id = attr.Value
				}
				n.refs = append(n.refs, referencesIn(attr)...)
			}
			nodes = append(nodes, n)
			open = append(open, len(nodes)-1)

		case xml.EndElement:
			if len(open) == 0 {
				return nil, false
			}
			nodes[open[len(open)-1]].end = after
			open = open[:len(open)-1]

		case xml.CharData:
			// A stylesheet's url(#id) is a reference from the element it is
			// written in, which is the <style> the sanitiser keeps whole.
			if len(open) > 0 && nodes[open[len(open)-1]].name == "style" {
				owner := open[len(open)-1]
				nodes[owner].refs = append(nodes[owner].refs, referencesInText(string(t))...)
			}
		}
	}
	if len(open) != 0 {
		return nil, false
	}
	return nodes, true
}

// referencesIn reads the same-document references out of one attribute.
//
// A url(#id) may appear in any painting attribute or in an inline style. An
// href whose value is a fragment is the other spelling: it is how a use names
// its shape, a pattern the pattern it inherits from, and a gradient the
// gradient it takes its stops from.
func referencesIn(attr xml.Attr) []string {
	refs := referencesInText(attr.Value)
	if attr.Name.Local == "href" {
		if id, found := strings.CutPrefix(strings.TrimSpace(attr.Value), "#"); found && id != "" {
			refs = append(refs, id)
		}
	}
	return refs
}

func referencesInText(text string) []string {
	var refs []string
	for _, match := range referenceRe.FindAllStringSubmatch(text, -1) {
		refs = append(refs, match[1])
	}
	return refs
}

// cut removes the named spans from the original bytes, taking the run of
// horizontal whitespace before each one and the newline after it so that the
// file keeps the shape it had.
func cut(svg []byte, nodes []node, drop []int) []byte {
	var out bytes.Buffer
	at := 0
	for _, index := range drop {
		start, end := nodes[index].start, nodes[index].end
		for start > at && (svg[start-1] == ' ' || svg[start-1] == '\t') {
			start--
		}
		if end < len(svg) && svg[end] == '\r' {
			end++
		}
		if end < len(svg) && svg[end] == '\n' {
			end++
		} else {
			// No line to take: put back the indentation, so the element that
			// follows is not pulled onto the previous line's column.
			start = nodes[index].start
		}
		if start < at {
			continue
		}
		out.Write(svg[at:start])
		at = end
	}
	out.Write(svg[at:])
	return out.Bytes()
}
