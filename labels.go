// Name styling for a map that draws its names from records (D-038).
//
// An art-mode map has its names rewritten in the style's typography before
// the SVG is sent (restyle.go, setNames). A data-mode map has no names layer
// to rewrite, so the same three decisions have to reach the board instead:
// which face each name takes, what the two inks are, and how wide the halo is
// under them. The board draws; it does not choose.
//
// The land-or-sea verdict is derived here, from godip's own graph, and never
// read out of the style plan. A version-1 plan states it as one entry per
// <text> in document order, which a map with no names layer has nothing to
// align to; a version-2 plan states it per province, which the graph already
// knows and which would be a second copy free to drift. A province is a sea
// name when the graph says water and only water. A coast carries both flags
// and takes the land face, which is what the layer it replaces did.
package main

import (
	"sort"
	"sync"

	"github.com/zond/godip"
)

// labelHaloJSON is the pale stroke laid under a name with paint-order, or
// absent. Width is in map units: the style quotes it against its own
// reference width and the server carries it onto this map's.
type labelHaloJSON struct {
	Color string  `json:"color"`
	Width float64 `json:"width"`
}

// labelFaceJSON is how one kind of name is set. LetterSpacing is in map units
// for the same reason the halo width is.
type labelFaceJSON struct {
	Family        string         `json:"family"`
	Weight        string         `json:"weight"`
	Style         string         `json:"style"`
	LetterSpacing float64        `json:"letterSpacing"`
	Fill          string         `json:"fill"`
	Halo          *labelHaloJSON `json:"halo"`
}

type labelFacesJSON struct {
	Land labelFaceJSON `json:"land"`
	Sea  labelFaceJSON `json:"sea"`
}

// labelPlanJSON is what the board needs to draw a data-mode map's names.
//
// It is absent on an art-mode map, which is every map today: the art draws its
// own names and the board must not draw a second set over them.
type labelPlanJSON struct {
	// Mode is "records" and nothing else. It exists so a board reading a
	// state from a newer server can tell a mode it does not know from the
	// mode it does, rather than drawing on a guess.
	Mode string `json:"mode"`
	// Sea lists the provinces whose name takes the sea face, sorted. Land is
	// the default because most names are land names, and because a land face
	// on a sea name is a wrong face rather than an unreadable one.
	Sea []string `json:"sea"`
	// Typography is keyed by style name. The style is a device preference —
	// it is chosen in the map URL, not in the game — so the server resolves
	// every style it serves and the board takes the one it is showing.
	Typography map[string]labelFacesJSON `json:"typography"`
	// Original is the typography the art itself drew its names in, from the
	// plan, for ?style=original. That route serves the art's own bytes, and on
	// a map authored without a names layer there is no original to be faithful
	// to; this is the nearest thing there is. Absent when the plan states
	// none, and then the default style's faces are used.
	Original *labelFacesJSON `json:"original,omitempty"`
	// DefaultStyle names the entry to use for a map asked for in no style, and
	// for ?style=original on a plan carrying no typography of its own.
	DefaultStyle string `json:"defaultStyle"`
}

// labelPlans caches one plan per variant key. The graph, the style plan and
// the styles are all fixed for the life of the process, so a plan is built
// once. Absent from the map means not built yet; a nil value means built and
// this variant has no plan, which is the common answer.
//
// It is filled from request handlers, each holding its own game's lock and
// not this one, so it carries a lock of its own.
var labelPlans = struct {
	mu sync.Mutex
	by map[string]*labelPlanJSON
}{by: map[string]*labelPlanJSON{}}

// seaNames returns the provinces whose name is set in the sea face: the ones
// godip's graph marks as water and not also as land.
func seaNames(graph godip.Graph) []string {
	out := []string{}
	for _, prov := range graph.Provinces() {
		// A name belongs to a province, never to one of its coasts.
		if prov.Super() != prov {
			continue
		}
		flags := graph.Flags(prov)
		if flags[godip.Sea] && !flags[godip.Land] {
			out = append(out, string(prov))
		}
	}
	sort.Strings(out)
	return out
}

func labelFace(face styleTypography, carry func(float64) float64) labelFaceJSON {
	out := labelFaceJSON{
		Family:        face.Family,
		Weight:        face.Weight,
		Style:         face.Style,
		LetterSpacing: carry(face.LetterSpacing),
		Fill:          face.Fill,
	}
	if face.Halo != nil {
		out.Halo = &labelHaloJSON{Color: face.Halo.Color, Width: carry(face.Halo.Width)}
	}
	return out
}

// labelPlanFor builds one variant's plan, or nil when its art still draws its
// own names.
func labelPlanFor(key string, graph godip.Graph) *labelPlanJSON {
	plan, found := plans[key]
	if !found || !plan.DataMode {
		return nil
	}
	width := plan.Map.ViewBoxWidth
	out := &labelPlanJSON{
		Mode:         "records",
		Sea:          seaNames(graph),
		Typography:   map[string]labelFacesJSON{},
		DefaultStyle: defaultMapStyle,
	}
	if plan.Godip != nil {
		out.Original = plan.Godip.Names.Typography
	}
	for name, style := range styles {
		carry := func(value float64) float64 {
			return carryLength(value, style.ReferenceWidth, width, 1)
		}
		out.Typography[name] = labelFacesJSON{
			Land: labelFace(style.Typography.Land, carry),
			Sea:  labelFace(style.Typography.Sea, carry),
		}
	}
	return out
}

func (self *game) labels() *labelPlanJSON {
	key := self.variantKey
	labelPlans.mu.Lock()
	defer labelPlans.mu.Unlock()
	if plan, built := labelPlans.by[key]; built {
		return plan
	}
	plan := labelPlanFor(key, self.state.Graph())
	labelPlans.by[key] = plan
	return plan
}
