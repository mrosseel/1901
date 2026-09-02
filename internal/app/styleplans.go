// Style plans: what a browser measured about one map, so the server never
// has to (ADR-026).
//
// Restyling a map is two halves. The expensive half is DETECTION — loading
// the art in a real rendering engine and asking what is painted under each
// province, what each label stands on, how much of the board each tone
// covers. The cheap half is APPLICATION: a handful of string substitutions.
//
// dipmap writes the first half into the variant package as styleplan.json,
// a few kilobytes per map. This file reads them; restyle.go applies them.
// Before that split, every map in every style was checked in as SVG: 156 MB
// of generated art that a `git clone` had to carry and a style change had to
// regenerate.
//
// A plan names the SHA-256 of the art it was measured on. A godip upgrade
// that redraws a map therefore invalidates its plan loudly, and the map is
// served in its own colours until the plan is rebuilt, rather than being
// styled from measurements of a picture that no longer exists.
package app

import (
	"encoding/json"
	"log"
	"strings"
)

// The plan schema versions this server reads. plans.ts writes the number.
//
// Version 1 draws the names in the art and records one land-or-sea verdict per
// drawn name, as a list in document order. Version 2 draws no names layer, so
// the verdicts become a map keyed by province and the plan carries `dataMode`
// and the typography the art was drawn in (ADR-038). Both shapes load: every
// plan checked in here is version 1 and stays version 1 until its map is
// re-authored, one map at a time (ADR-039).
const (
	minPlanVersion = 1
	maxPlanVersion = 2
)

// nameKinds is the plan's land-or-sea verdict for each province name.
//
// The two versions state it in two shapes and both are read. A version-1 plan
// writes a LIST, one entry per <text> in the names layer in document order, so
// position in the list is the key and only the art can supply it. A version-2
// plan has no names layer to align a list to, so it writes a MAP from province
// key to verdict.
//
// Neither shape is converted into the other. A list cannot be keyed without
// the art it was measured against, and a map cannot be put in document order
// without it either. Each reader takes the shape it can use: the styling pass
// walks the art and wants the list, and anything asking about one province
// wants the map.
type nameKinds struct {
	InOrder    []string
	ByProvince map[string]string
}

func (self *nameKinds) UnmarshalJSON(b []byte) error {
	self.InOrder = nil
	self.ByProvince = nil
	trimmed := strings.TrimSpace(string(b))
	if trimmed == "" || trimmed == "null" {
		return nil
	}
	if trimmed[0] == '{' {
		return json.Unmarshal(b, &self.ByProvince)
	}
	return json.Unmarshal(b, &self.InOrder)
}

// kindOf is the verdict for one province and one position in the names layer,
// or "" when the plan states none. Only one of the two shapes can answer, and
// which one it is was decided by the plan's version.
func (self *nameKinds) kindOf(province string, index int) string {
	if self.ByProvince != nil {
		return self.ByProvince[province]
	}
	if index >= 0 && index < len(self.InOrder) {
		return self.InOrder[index]
	}
	return ""
}

// godipPlan is how a godip map is styled: by substituting fill VALUES.
//
// godip's own maps carry no class of any kind — classical paints its landmass
// as one path with style="fill:#f4d7b5" over a sea-coloured rect — so there
// is nothing to select on. What there is, is a palette, and this is it: the
// two terrain values the palette vote settled on, whatever else the art
// paints in quantity, and the two pattern ids that are insertion points.
type godipPlan struct {
	// Styleable is false when the palette vote was not decisive. Such a map
	// is served in godip's own colours and says why.
	Styleable      bool    `json:"styleable"`
	Reason         string  `json:"reason"`
	Sea            string  `json:"sea"`
	Land           string  `json:"land"`
	SeaConfidence  float64 `json:"seaConfidence"`
	LandConfidence float64 `json:"landConfidence"`
	// Extras are the other tones the art paints in quantity — a second land,
	// an inland lake. Each is carried onto the style's base tone by the
	// lightness step it had from the map's own, so a map that draws two
	// shades of land still draws two.
	Extras []struct {
		Fill string `json:"fill"`
		Near string `json:"near"`
	} `json:"extras"`
	// ImpassablePattern is the hatch the map paints unplayable ground with,
	// by pattern id. The style swaps its insides and keeps the id, so no
	// reference changes and no id is added or lost.
	ImpassablePattern string `json:"impassablePattern"`
	// GrainPattern and GrainOverlayID are the paper noise laid over the
	// finished art, and the element that lays it. Only its strength changes:
	// the texture is a photograph of paper, not a style decision.
	GrainPattern   string `json:"grainPattern"`
	GrainOverlayID string `json:"grainOverlayId"`
	Borders        struct {
		Found         bool `json:"found"`
		Candidates    int  `json:"candidates"`
		ProvinceCount int  `json:"provinceCount"`
		// Decoration marks a foreground layer that is drawing rather than
		// borders — North Sea Wars draws a celtic knot round its board — and
		// is left exactly as drawn.
		Decoration bool `json:"decoration"`
	} `json:"borders"`
	Names struct {
		// Found says whether the art draws a names layer, and nothing more.
		// It is not the mode flag: a data-mode map has it false and still has
		// names, and six art-mode maps have it false with no records to draw
		// from (ADR-038). DataMode on the plan is the flag.
		Found bool `json:"found"`
		// Kinds is the terrain each name was found standing on.
		Kinds nameKinds `json:"kinds"`
		// Typography is the face and the inks the art drew its names in,
		// measured before the layer was dropped. It lets ?style=original stay
		// faithful on a map that no longer carries an original names layer to
		// be faithful to. Lengths are in this map's own units, already: they
		// were read off this art, not quoted against a style's reference
		// width. Absent on a plan that carries none, and then the default
		// style's faces are used.
		Typography *labelFacesJSON `json:"typography"`
	} `json:"names"`
}

// jdipPlan is how a converted jDip map is styled: by replacing its
// stylesheet. Those maps paint every province through a semantic class, so
// there are no values to find — what detection has to supply is the label
// sizes jDip wrote without a CSS unit, the classes that paint power-owned
// ground, and which labels stand over water.
type jdipPlan struct {
	Styleable bool    `json:"styleable"`
	Reason    string  `json:"reason"`
	ArtScale  float64 `json:"artScale"`
	// LabelScale is the scale the two name layers are drawn at, which is not
	// the scale the art layer is drawn at: jDip writes its names outside the
	// transform it writes its art under. A length belongs to the layer it
	// lands in, so a label rule and a terrain rule are carried onto different
	// scales. Absent or zero, the scale is read from the art itself.
	LabelScale float64 `json:"labelScale"`
	// PowerClasses are painted as plain land: the board draws ownership from
	// the game state, so a power colour baked into the map can only ever
	// contradict it.
	PowerClasses []string `json:"powerClasses"`
	// LabelMetrics is each label class's own font-size and text-anchor, in
	// sorted order. These are a LAYOUT decision, not a style one: every
	// placement was measured against the label boxes they produce.
	LabelMetrics []struct {
		Class        string `json:"class"`
		Declarations string `json:"declarations"`
	} `json:"labelMetrics"`
	// LabelClasses is the class to append to each <text>, in document order.
	LabelClasses  []string `json:"labelClasses"`
	RepairedSizes []string `json:"repairedSizes"`
}

type stylePlan struct {
	Version int    `json:"version"`
	Key     string `json:"key"`
	Name    string `json:"name"`
	Kind    string `json:"kind"`
	Map     struct {
		Bytes        int     `json:"bytes"`
		SHA256       string  `json:"sha256"`
		ViewBoxWidth float64 `json:"viewBoxWidth"`
	} `json:"map"`
	Godip *godipPlan `json:"godip"`
	JDip  *jdipPlan  `json:"jdip"`
	// DataMode says the art no longer draws the province names or the supply
	// centre glyphs, so the board draws both from the placement records
	// (ADR-038). It is per map and it is a flag, not an inference: while the
	// exporter writes records AND still draws the layers, a server that read
	// "has records, therefore hide the layer" would change every map's
	// picture on a release that changed nothing. It is not the same fact as
	// Names.Found either — a map that never drew names, and one whose names
	// are outlined shapes carrying no string, both have Found false and
	// neither has records to draw from.
	DataMode bool `json:"dataMode"`
}

// versionSupported reports whether this server reads the schema the plan was
// written in.
func (self *stylePlan) versionSupported() bool {
	return self.Version >= minPlanVersion && self.Version <= maxPlanVersion
}

// styleable reports whether this plan can put its map into any style at all.
func (self *stylePlan) styleable() bool {
	switch {
	case self.Kind == "godip":
		return self.Godip != nil && self.Godip.Styleable
	case self.Kind == "jdip":
		return self.JDip != nil && self.JDip.Styleable
	}
	return false
}

/*
Every plan this server holds, filled as the variants load (generated.go).

A plan used to be a file in a styleplans/ directory that this binary embedded,
because the tool that measured it lived here. It moved to dipmap, and a plan
now travels in the variant package beside the art it measured, so the two
cannot disagree about which map they describe.
*/
var plans = map[string]*stylePlan{}

/*
loadPlans makes sure the plans are in memory, and says what is there.

A plan arrives with its variant now (generated.go), so this loads the
variants and then counts. It stays a function of its own because a plan is
optional — a variant with no plan is served in its own colours — and because
the count is worth a line in the startup log.
*/
func loadPlans() error {
	if err := loadGeneratedVariants(); err != nil {
		return err
	}
	styleable := 0
	for _, plan := range plans {
		if plan.styleable() {
			styleable++
		}
	}
	log.Printf("style plans: %v map(s), %v styleable, in %v style(s)",
		len(plans), styleable, len(styleNames))
	return nil
}
