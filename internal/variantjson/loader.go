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
	"github.com/zond/godip/phase"
	"github.com/zond/godip/state"
	"github.com/zond/godip/variants/chaos"
	"github.com/zond/godip/variants/classical"
	"github.com/zond/godip/variants/common"
	"github.com/zond/godip/variants/hundred"
	"github.com/zond/godip/variants/twentytwenty"
	"github.com/zond/godip/variants/westernworld901"
)

// SchemaVersion is the descriptor version this loader understands.
const SchemaVersion = 1

// Descriptor is the on-disk shape of a variant.
//
// The table-shaped fields are arrays rather than objects: a large map is mostly
// border rows, and a row reads as a row.
type Descriptor struct {
	Schema      int    `json:"schema"`
	Key         string `json:"key"`
	Name        string `json:"name"`
	CreatedBy   string `json:"createdBy"`
	Version     string `json:"version"`
	Description string `json:"description"`
	// Map names another variant this one is drawn on, by key. Empty means the
	// variant's own directory holds the art.
	//
	// It is a key and never a path. A descriptor may not reach outside the
	// directory the variants live in, so anything that is not a bare key is
	// refused rather than cleaned up.
	//
	// Art is not part of the board, so this field is absent from GameHash: a
	// variant that stops carrying its own copy of a picture it shared byte for
	// byte is the same variant, and its games still load.
	Map string `json:"map,omitempty"`

	Rules             Rules `json:"rules"`
	SoloSupplyCenters int   `json:"soloSupplyCenters"`

	Nations []string `json:"nations"`

	// [key, longName, supplyCenter] where supplyCenter is null, "neutral", or
	// a nation name.
	Provinces [][]any `json:"provinces"`
	// [province, coast, flag] where coast is null for the base region.
	Regions [][]any `json:"regions"`
	// [regionA, regionB, terrain]
	Borders [][]string `json:"borders"`
	// [from, to, terrain] for the edges that exist in one direction only.
	//
	// A border is normally mutual, and Borders states each one once so its two
	// halves cannot disagree. godip's maps are not all mutual: a sea often
	// names a multi-coast province it is not named back by, and Unconstitutional
	// gives one province a coastal edge inbound and a land edge outbound. Those
	// edges decide what a fleet may be ordered to do, so they are written down
	// here rather than quietly made mutual.
	OneWayBorders [][]string `json:"onewayBorders"`

	Start Start `json:"start"`
}

// Rules selects behaviour. Profile names a compiled rule set; the rest is data.
type Rules struct {
	Profile string   `json:"profile"`
	Orders  []string `json:"orders"`
	// Text is the variant's own rules prose, as its author wrote it. Empty
	// means the win condition is the only rule worth stating.
	Text string `json:"text"`
}

// Start is the opening position, and the phase it stands in.
//
// A variant does not have to begin in Spring 1901: Cold War opens in 1960,
// North Sea Wars in year 0, and Chaos opens in an adjustment phase with no
// units at all. Zero values mean 1901, Spring, Movement.
type Start struct {
	Year   int    `json:"year"`
	Season string `json:"season"`
	Phase  string `json:"phase"`
	// province -> [unitType, nation]
	Units map[string][]string `json:"units"`
	// province -> nation
	SupplyCenters map[string]string `json:"supplyCenters"`
}

// The opening phase a descriptor gets when it says nothing.
const (
	defaultStartYear   = 1901
	defaultStartSeason = godip.Spring
	defaultStartPhase  = godip.Movement
)

// startPhase resolves the opening phase, filling in the default for each field
// the descriptor leaves out.
func (s Start) startPhase() (int, godip.Season, godip.PhaseType) {
	year, season, phaseType := s.Year, godip.Season(s.Season), godip.PhaseType(s.Phase)
	if year == 0 && s.Season == "" && s.Phase == "" {
		year = defaultStartYear
	}
	if season == "" {
		season = defaultStartSeason
	}
	if phaseType == "" {
		phaseType = defaultStartPhase
	}
	return year, season, phaseType
}

// profile is the compiled half of a variant: the behaviour a descriptor can
// name but not express. A descriptor selects one by name.
//
// Everything here is a function or a rule set. A number, a name or a position
// belongs in the descriptor instead; if it appears in this struct, it is
// because no arrangement of data could produce it.
type profile struct {
	newPhase   func(int, godip.Season, godip.PhaseType) godip.Phase
	parser     orders.Parser
	backupRule godip.BackupRule
	// stateFlags and neutralOrders are the last two arguments godip's state
	// constructor takes. They decide where units may be built and who moves
	// the unowned ones, so a variant that sets them plays differently.
	stateFlags    map[godip.Flag]bool
	neutralOrders func(state.State) map[godip.Province]godip.Adjudicator
	// The three vocabularies a phase cycles through. Empty means classical's.
	phaseTypes []godip.PhaseType
	seasons    []godip.Season
	unitTypes  []godip.UnitType
	// soloWinner and soloSCCount override the count-to-N win condition for the
	// one variant whose victory depends on the year.
	soloWinner  func(*state.State) godip.Nation
	soloSCCount func(*state.State) int
}

// buildAnywherePhase is the phase cycle godip gives every variant that lets a
// power build on any centre it owns.
var buildAnywherePhase = phase.Generator(hundred.BuildAnywhereParser, classical.AdjustSCs)

// pureParser is Pure's order set. godip keeps its copy unexported, and it is
// the classical set minus convoys, which a map of seven landlocked provinces
// has no water for.
var pureParser = orders.NewParser([]godip.Order{
	orders.BuildOrder,
	orders.DisbandOrder,
	orders.HoldOrder,
	orders.MoveOrder,
	orders.SupportOrder,
})

// profiles is every rule set a descriptor may name.
//
// The names describe behaviour rather than variants, because several variants
// share one: Sengoku and Western World 901 differ in their maps and in nothing
// else that the adjudicator can see.
var profiles = map[string]profile{
	"classical": {
		newPhase:   classical.NewPhase,
		parser:     classical.Parser,
		backupRule: classical.BackupRule,
	},
	// Classical's phase cycle, but a power may build on any centre it owns.
	// godip's Gateway West sets the parser without the phase generator that
	// goes with it, so its build options are classical's and its typed orders
	// are not.
	"classical-buildanywhere": {
		newPhase:   classical.NewPhase,
		parser:     hundred.BuildAnywhereParser,
		backupRule: classical.BackupRule,
	},
	"buildanywhere": {
		newPhase:   buildAnywherePhase,
		parser:     hundred.BuildAnywhereParser,
		backupRule: classical.BackupRule,
	},
	// The same, plus the two things a map full of unowned centres needs: the
	// flag that lets a build land anywhere, and orders for the neutrals.
	"buildanywhere-neutrals": {
		newPhase:      buildAnywherePhase,
		parser:        hundred.BuildAnywhereParser,
		backupRule:    classical.BackupRule,
		stateFlags:    map[godip.Flag]bool{godip.Anywhere: true},
		neutralOrders: westernworld901.NeutralOrders,
	},
	// Chaos opens in an adjustment phase where every centre without an order
	// builds an army, so that a board of 34 powers starts even when most of
	// them are absent.
	"chaos": {
		newPhase:   chaos.Phase,
		parser:     hundred.BuildAnywhereParser,
		backupRule: classical.BackupRule,
		stateFlags: map[godip.Flag]bool{godip.Anywhere: true},
	},
	// One season per turn, five years to the turn.
	"hundred": {
		newPhase:   hundred.Phase,
		parser:     hundred.BuildAnywhereParser,
		backupRule: classical.BackupRule,
		stateFlags: map[godip.Flag]bool{godip.Anywhere: true},
		seasons:    []godip.Season{hundred.YearSeason},
	},
	// Victory is a lead over the second power, and the lead needed shrinks by
	// one every year, so no fixed number of centres can express it.
	"twentytwenty": {
		newPhase:    twentytwenty.Phase,
		parser:      twentytwenty.BuildAnyHomeCenterParser,
		backupRule:  classical.BackupRule,
		stateFlags:  map[godip.Flag]bool{godip.AnyHomeCenter: true},
		soloWinner:  twentytwenty.TwentyTwentyWinner,
		soloSCCount: twentytwenty.TwentyTwentyVariant.SoloSCCount,
	},
	// Seven provinces, one each, armies only.
	"pure": {
		newPhase:   phase.Generator(pureParser, classical.AdjustSCs),
		parser:     pureParser,
		backupRule: classical.BackupRule,
		unitTypes:  []godip.UnitType{godip.Army},
	},
}

// ownsVictory reports whether the profile brings its own win condition, which
// makes the descriptor's soloSupplyCenters a number nothing reads. Twenty
// Twenty is the one: victory there is a lead over the second power, and the
// lead shrinks by a centre every year.
func ownsVictory(d Descriptor) bool {
	prof, known := profiles[d.Rules.Profile]
	return known && prof.soloWinner != nil
}

// Profiles names every rule set this build carries, in sorted order.
func Profiles() []string {
	return sortedKeys(profiles)
}

var unitTypesByName = map[string]godip.UnitType{
	"army":  godip.Army,
	"fleet": godip.Fleet,
}

// flagsByName is the terrain vocabulary. An archipelago is land a fleet may
// hold and an army may be convoyed through, which is neither a coast nor a
// sea and adjudicates as neither.
var flagsByName = map[string][]godip.Flag{
	"land":        {godip.Land},
	"sea":         {godip.Sea},
	"coast":       godip.Coast,
	"archipelago": godip.Archipelago,
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
		if isNeutral(owner) {
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
	for _, row := range d.OneWayBorders {
		from, to, terrain := godip.Province(row[0]), godip.Province(row[1]), row[2]
		g.Prov(from).Conn(to, flagsByName[terrain]...)
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
		// An empty name is not a name. Left in, it would label the board with
		// a blank where the abbreviation should be.
		if name != "" {
			longNames[godip.Province(key)] = name
		}
	}

	blank := func(phase godip.Phase) *state.State {
		return state.New(built, phase, prof.backupRule, prof.stateFlags, prof.neutralOrders)
	}

	startYear, startSeason, startPhaseType := d.Start.startPhase()
	start := func() (*state.State, error) {
		result := blank(prof.newPhase(startYear, startSeason, startPhaseType))
		units := map[godip.Province]godip.Unit{}
		for prov, spec := range d.Start.Units {
			units[godip.Province(prov)] = godip.Unit{
				Type:   unitTypesByName[spec[0]],
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

	soloWinner := prof.soloWinner
	if soloWinner == nil {
		soloWinner = common.SCCountWinner(d.SoloSupplyCenters)
	}
	soloSCCount := prof.soloSCCount
	if soloSCCount == nil {
		soloSCCount = func(*state.State) int { return d.SoloSupplyCenters }
	}
	rules := d.Rules.Text
	if rules == "" {
		rules = fmt.Sprintf("First to %d supply centers wins.", d.SoloSupplyCenters)
	}

	return common.Variant{
		Name:              d.Name,
		Graph:             func() godip.Graph { return built },
		Start:             start,
		Blank:             blank,
		Phase:             prof.newPhase,
		Parser:            prof.parser,
		Nations:           nations,
		PhaseTypes:        orDefault(prof.phaseTypes, classical.PhaseTypes),
		Seasons:           orDefault(prof.seasons, classical.Seasons),
		UnitTypes:         orDefault(prof.unitTypes, classical.UnitTypes),
		SoloWinner:        soloWinner,
		SoloSCCount:       soloSCCount,
		ProvinceLongNames: longNames,
		CreatedBy:         d.CreatedBy,
		Version:           d.Version,
		Description:       d.Description,
		Rules:             rules,
	}, nil
}

// orDefault picks the profile's vocabulary, or classical's where it has none.
func orDefault[T any](chosen, fallback []T) []T {
	if len(chosen) > 0 {
		return chosen
	}
	return fallback
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
