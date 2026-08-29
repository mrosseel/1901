// Package variantjson loads a Diplomacy variant from a JSON descriptor at
// runtime, instead of requiring a generated Go package and a rebuild.
//
// This is the only implementation of the format. dipmap writes descriptors and
// this package reads them, so a change here is a change to the format itself.
//
// It exists because a procedurally generated map cannot be committed as Go at
// any useful rate: a fresh map per game would mean a recompile per game.
//
// The descriptor normalises a map into provinces, regions and borders, so each
// border is written exactly once. The loader adds both directions itself,
// which is why the two halves of a border cannot disagree here the way they
// can in hand-written or generated Go.
//
// Behaviour that genuinely needs code stays code: `rules.profile` names a
// compiled profile. Everything else in the descriptor is data.
package variantjson

import (
	"encoding/json"
	"fmt"
	"io"
	"sort"

	"github.com/zond/godip"
	"github.com/zond/godip/graph"
	"github.com/zond/godip/orders"
	"github.com/zond/godip/state"
	"github.com/zond/godip/variants/classical"
	"github.com/zond/godip/variants/common"
)

// SchemaVersion is the descriptor version this loader understands.
const SchemaVersion = 1

// Descriptor is the on-disk shape of a variant.
//
// The table-shaped fields are arrays rather than objects: a large map is mostly
// border rows, and a row reads as a row.
type Descriptor struct {
	Schema            int    `json:"schema"`
	Key               string `json:"key"`
	Name              string `json:"name"`
	CreatedBy         string `json:"createdBy"`
	Version           string `json:"version"`
	Description       string `json:"description"`
	Rules             Rules  `json:"rules"`
	SoloSupplyCenters int    `json:"soloSupplyCenters"`

	Nations []string `json:"nations"`

	// [key, longName, supplyCenter] where supplyCenter is null, "neutral", or
	// a nation name.
	Provinces [][]any `json:"provinces"`
	// [province, coast, flag] where coast is null for the base region.
	Regions [][]any `json:"regions"`
	// [regionA, regionB, terrain]
	Borders [][]string `json:"borders"`

	Start Start `json:"start"`
}

// Rules selects behaviour. Profile names a compiled rule set; the rest is data.
type Rules struct {
	Profile string   `json:"profile"`
	Orders  []string `json:"orders"`
}

// Start is the opening position.
type Start struct {
	// province -> [unitType, nation]
	Units map[string][]string `json:"units"`
	// province -> nation
	SupplyCenters map[string]string `json:"supplyCenters"`
}

// profile is the compiled half of a variant: the behaviour a descriptor can
// name but not express. A descriptor selects one by name.
type profile struct {
	newPhase   func(int, godip.Season, godip.PhaseType) godip.Phase
	parser     orders.Parser
	backupRule godip.BackupRule
}

var profiles = map[string]profile{
	"classical": {
		newPhase:   classical.NewPhase,
		parser:     classical.Parser,
		backupRule: classical.BackupRule,
	},
}

var flagsByName = map[string][]godip.Flag{
	"land":  {godip.Land},
	"sea":   {godip.Sea},
	"coast": godip.Coast,
}

// Load parses a descriptor and returns a variant ready to register.
func Load(r io.Reader) (common.Variant, error) {
	var d Descriptor
	if err := json.NewDecoder(r).Decode(&d); err != nil {
		return common.Variant{}, fmt.Errorf("parsing descriptor: %w", err)
	}
	return Build(d)
}

// Build turns a parsed descriptor into a variant, validating as it goes.
func Build(d Descriptor) (common.Variant, error) {
	if err := Validate(d); err != nil {
		return common.Variant{}, err
	}

	g := graph.New()

	// Regions become graph nodes. A named coast is its own node, spelled
	// "prov/nc" the way godip expects.
	for _, row := range d.Regions {
		name, _ := regionName(row)
		flag, _ := row[2].(string)
		g.Prov(godip.Province(name)).Flag(flagsByName[flag]...)
	}

	// Supply centres hang off the base province, never off a coast.
	for _, row := range d.Provinces {
		key, _ := row[0].(string)
		if len(row) < 3 || row[2] == nil {
			continue
		}
		owner, _ := row[2].(string)
		if owner == "neutral" {
			g.Prov(godip.Province(key)).SC(godip.Neutral)
		} else {
			g.Prov(godip.Province(key)).SC(godip.Nation(owner))
		}
	}

	// One row, two directed edges. This is the whole point of the format.
	for _, row := range d.Borders {
		a, b, terrain := godip.Province(row[0]), godip.Province(row[1]), row[2]
		flags := flagsByName[terrain]
		g.Prov(a).Conn(b, flags...)
		g.Prov(b).Conn(a, flags...)
	}

	built := g
	prof := profiles[d.Rules.Profile]

	nations := make([]godip.Nation, 0, len(d.Nations))
	for _, n := range d.Nations {
		nations = append(nations, godip.Nation(n))
	}

	longNames := map[godip.Province]string{}
	for _, row := range d.Provinces {
		key, _ := row[0].(string)
		name, _ := row[1].(string)
		longNames[godip.Province(key)] = name
	}

	blank := func(phase godip.Phase) *state.State {
		return state.New(built, phase, prof.backupRule, nil, nil)
	}

	start := func() (*state.State, error) {
		result := blank(prof.newPhase(1901, godip.Spring, godip.Movement))
		units := map[godip.Province]godip.Unit{}
		for prov, spec := range d.Start.Units {
			unitType := godip.Army
			if spec[0] == "fleet" {
				unitType = godip.Fleet
			}
			units[godip.Province(prov)] = godip.Unit{
				Type:   unitType,
				Nation: godip.Nation(spec[1]),
			}
		}
		if err := result.SetUnits(units); err != nil {
			return nil, err
		}
		centers := map[godip.Province]godip.Nation{}
		for prov, nation := range d.Start.SupplyCenters {
			centers[godip.Province(prov)] = godip.Nation(nation)
		}
		result.SetSupplyCenters(centers)
		return result, nil
	}

	return common.Variant{
		Name:              d.Name,
		Graph:             func() godip.Graph { return built },
		Start:             start,
		Blank:             blank,
		Phase:             prof.newPhase,
		Parser:            prof.parser,
		Nations:           nations,
		PhaseTypes:        classical.PhaseTypes,
		Seasons:           classical.Seasons,
		UnitTypes:         classical.UnitTypes,
		SoloWinner:        common.SCCountWinner(d.SoloSupplyCenters),
		SoloSCCount:       func(*state.State) int { return d.SoloSupplyCenters },
		ProvinceLongNames: longNames,
		CreatedBy:         d.CreatedBy,
		Version:           d.Version,
		Description:       d.Description,
		Rules:             fmt.Sprintf("First to %d supply centers wins.", d.SoloSupplyCenters),
	}, nil
}

// regionName renders a region row as a godip province name.
func regionName(row []any) (string, error) {
	if len(row) < 3 {
		return "", fmt.Errorf("region row needs 3 fields, got %d", len(row))
	}
	province, ok := row[0].(string)
	if !ok {
		return "", fmt.Errorf("region province must be a string")
	}
	if row[1] == nil {
		return province, nil
	}
	coast, ok := row[1].(string)
	if !ok {
		return "", fmt.Errorf("region coast must be a string or null")
	}
	return province + "/" + coast, nil
}

// sortedKeys keeps iteration deterministic where map order would otherwise
// leak into output.
func sortedKeys[V any](m map[string]V) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}
