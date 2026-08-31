// Approved placement tables: where a variant's unit markers actually go.
//
// A map's own `<abbr>Center` anchors are a starting point and no more (ADR-003).
// They put markers on province names, on supply centre glyphs, and half
// outside their own province, and on a coast they can put "stp/nc" three map
// units from "stp", where neither reads as anything. tools/placement measures
// all of that on real browser geometry, proposes a better table, and hands it
// to a person to correct by hand.
//
// The file convention, and the whole of it:
//
//	variants/generated/<key>/placements.json  the approved table, which travels
//	                                          with the variant and is the only
//	                                          one this server reads (generated.go)
//	placements/<key>.hand.json                a hand-corrected table, an INPUT to
//	                                          tools/placement and never read here
//
// A variant with no file falls back to the map's anchors, which is what every
// unverified variant does and what classical did before this table existed.
// The fallback is per province, not per variant: a table missing one key
// leaves that one province on its anchor and serves the rest.
package main

import (
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// placementJSON is one province's marker, in map units — the SVG's own user
// coordinates, which is the space the board draws in.
type placementJSON struct {
	// Unit is the centre of the unit marker.
	Unit [2]float64 `json:"unit"`
	// Scale is the marker's size as a fraction of the board's normal radius.
	// A province too narrow for a full marker gets a smaller one rather than
	// a misplaced one; the board multiplies its radius by this.
	Scale float64 `json:"scale"`
	// Dislodged is where the marker of a unit thrown out of this province
	// goes. It stands beside the unit that threw it out until the retreat
	// resolves, so the two must not overlap.
	Dislodged [2]float64 `json:"dislodged"`
	// Brief is where the province's three-letter code goes when the board is
	// in brief-label mode. Brief mode hides the full names, so the code is
	// placed clear of the unit markers near it, of its own dislodged ring and
	// of the supply centre glyph, and of nothing else. Absent on a coast key,
	// because the board draws one code per base province, and absent on a map
	// that draws its own brief labels; the board falls back to its offset
	// heuristic wherever it is missing.
	Brief *[2]float64 `json:"brief,omitempty"`
	// Overhang records that this marker was deliberately allowed out over its
	// own border because the province takes no marker at any size. It is
	// carried so a later audit can tell a decision from a defect.
	Overhang *overhangJSON `json:"overhang,omitempty"`
	// Label is the province's full name: the box the placement search
	// reserved for it, which every marker near it was then kept clear of
	// (ADR-038). Absent where the map draws no name for this province, which is
	// not the same as the map drawing its own names.
	Label *labelJSON `json:"label,omitempty"`
	// LabelRuns are the lines a name broken across several elements is drawn
	// in, when the map's author broke it. Label stays the union of them: the
	// box the search reserved. A run's text wins for drawing and for nothing
	// else.
	LabelRuns []labelRunJSON `json:"labelRuns,omitempty"`
	// Centre is the middle of the supply centre glyph. CentreRadius is the
	// radius of the circle's path and CentreStroke the width of its outline.
	// Both are stored because the glyph is an obstacle as well as a drawing:
	// a stroke straddles the path it is drawn on, so the ink reaches
	// CentreRadius + CentreStroke/2, and that is the circle the names and the
	// markers were fitted around. The stroke is a line weight in map units,
	// not a fraction of the radius: a fraction makes a small province's
	// centre a smudge and a large one's a doughnut.
	Centre       *[2]float64 `json:"centre,omitempty"`
	CentreRadius float64     `json:"centreRadius,omitempty"`
	CentreStroke float64     `json:"centreStroke,omitempty"`
}

// labelJSON is one name's ink box, in map units.
//
// At is the CENTRE of that box, across and down. It is not the baseline. SVG
// text sits on its baseline, so a reader draws at At.y + Height/2 with
// text-anchor:middle. Height is stated rather than derived from Size, because
// the cap-height fraction that relates them lives in the exporter, in another
// language and another repository, and a constant copied across a boundary
// drifts.
type labelJSON struct {
	At    [2]float64 `json:"at"`
	Size  float64    `json:"size"`
	Width float64    `json:"width"`
	// Height is the ink height, which is what turns At into a baseline.
	Height float64 `json:"height"`
	// Rot is the rotation in degrees about At, omitted when zero. Classical
	// rotates 73 of its 90 names; Portugal drawn flat runs across Spain.
	Rot float64 `json:"rot,omitempty"`
}

// labelRunJSON is one line of a name the map's author broke across lines. It
// carries its own box for the same reason the label does, and the string,
// because the line breaks are the author's and cannot be worked out from the
// province's long name.
type labelRunJSON struct {
	At     [2]float64 `json:"at"`
	Size   float64    `json:"size"`
	Width  float64    `json:"width"`
	Height float64    `json:"height"`
	Text   string     `json:"text"`
}

type overhangJSON struct {
	Land float64 `json:"land"`
	Sea  float64 `json:"sea"`
	Open float64 `json:"open"`
}

// placementTable is one variant's table: province abbreviation to marker.
type placementTable map[string]placementJSON

// placementDir can be pointed elsewhere with PLACEMENTS, which is what the
// tests and a run from another working directory need.
func placementDir() string {
	if p := os.Getenv("PLACEMENTS"); p != "" {
		return p
	}
	return "placements"
}

// placements holds every table found at startup, by variant key. It is
// written once before any request is served and only read afterwards, so it
// needs no lock.
var placements = map[string]placementTable{}

// loadPlacements reads any table still kept in the placements directory.
//
// A variant's own table arrives with the variant, so this normally finds
// nothing but the hand files it skips. It stays because the directory is where
// a table for something that is not a variant directory would go.
//
// A missing directory is not an error: a checkout with no approved table is a
// working server, it just draws on the map's own anchors. A malformed file IS
// an error worth failing on, because serving half a table silently would put
// markers in two different coordinate systems on the same board.
func loadPlacements() error {
	dir := placementDir()
	entries, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return fmt.Errorf("read %v: %w", dir, err)
	}
	loaded := make([]string, 0, len(entries))
	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() || !strings.HasSuffix(name, ".json") {
			continue
		}
		key := strings.TrimSuffix(name, ".json")
		// The hand-corrected files are the tool's input, not the server's.
		if strings.HasSuffix(key, ".hand") {
			continue
		}
		b, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			return fmt.Errorf("read %v: %w", name, err)
		}
		var table placementTable
		if err := json.Unmarshal(b, &table); err != nil {
			return fmt.Errorf("parse %v: %w", name, err)
		}
		for prov, spot := range table {
			// A scale of zero is an absent field, not a request for an
			// invisible marker.
			if spot.Scale <= 0 {
				spot.Scale = 1
				table[prov] = spot
			}
		}
		placements[key] = table
		loaded = append(loaded, fmt.Sprintf("%v (%d provinces)", key, len(table)))
	}
	sort.Strings(loaded)
	if len(loaded) > 0 {
		log.Printf("placement tables: %v", strings.Join(loaded, ", "))
	}
	return nil
}

// placementFor returns the approved table for a variant, or nil when it has
// none. Nil is meaningful and is serialised as JSON null: the board reads it
// as "no table, use the map's anchors".
func placementFor(key string) placementTable {
	return placements[key]
}

func (self *game) placements() placementTable {
	return placementFor(self.variantKey)
}
