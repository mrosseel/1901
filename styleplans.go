// Style plans: what a browser measured about one map, so the server never
// has to (D-026).
//
// Restyling a map is two halves. The expensive half is DETECTION — loading
// the art in a real rendering engine and asking what is painted under each
// province, what each label stands on, how much of the board each tone
// covers. The cheap half is APPLICATION: a handful of string substitutions.
//
// tools/restyle/plans.ts writes the first half out as styleplans/<key>.json,
// a few kilobytes per map. This file reads them; restyle.go applies them.
// Before that split, every map in every style was checked in as SVG: 156 MB
// of generated art that a `git clone` had to carry and a style change had to
// regenerate.
//
// A plan names the SHA-256 of the art it was measured on. A godip upgrade
// that redraws a map therefore invalidates its plan loudly, and the map is
// served in its own colours until the plan is rebuilt, rather than being
// styled from measurements of a picture that no longer exists.
package main

import (
	"embed"
	"encoding/json"
	"fmt"
	"io/fs"
	"log"
	"path"
	"strings"
	"sync"
)

//go:embed styleplans
var planFS embed.FS

// planVersion is the schema this server understands. plans.ts writes it.
const planVersion = 1

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
		Found bool `json:"found"`
		// Kinds is one verdict per <text> in the names layer, in document
		// order: the terrain the label was found standing on.
		Kinds []string `json:"kinds"`
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

var (
	plans     = map[string]*stylePlan{}
	plansOnce sync.Once
	plansErr  error
)

// loadPlans reads every plan once.
func loadPlans() error {
	plansOnce.Do(func() {
		entries, err := fs.ReadDir(planFS, "styleplans")
		if err != nil {
			plansErr = err
			return
		}
		styleable := 0
		for _, entry := range entries {
			if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
				continue
			}
			b, err := planFS.ReadFile(path.Join("styleplans", entry.Name()))
			if err != nil {
				plansErr = err
				return
			}
			plan := &stylePlan{}
			if err := json.Unmarshal(b, plan); err != nil {
				plansErr = fmt.Errorf("parse styleplans/%v: %w", entry.Name(), err)
				return
			}
			if plan.Version != planVersion {
				plansErr = fmt.Errorf("styleplans/%v is version %v, this server reads %v",
					entry.Name(), plan.Version, planVersion)
				return
			}
			plans[plan.Key] = plan
			if plan.styleable() {
				styleable++
			}
		}
		log.Printf("style plans: %v map(s), %v styleable, in %v style(s)",
			len(plans), styleable, len(styleNames))
	})
	return plansErr
}
