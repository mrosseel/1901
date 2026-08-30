package variantjson

import (
	"errors"
	"fmt"
	"slices"
	"sort"
	"strings"

	"github.com/zond/godip/variants/classical"
)

// ValidationError collects every problem found, rather than stopping at the
// first. A generated map with three bad borders should report three bad
// borders, not one.
type ValidationError struct {
	Problems []string
}

func (e *ValidationError) Error() string {
	if len(e.Problems) == 1 {
		return "invalid variant: " + e.Problems[0]
	}
	return fmt.Sprintf("invalid variant: %d problems:\n  - %s",
		len(e.Problems), strings.Join(e.Problems, "\n  - "))
}

// Validate checks a descriptor before it becomes a variant.
//
// These are the defects a generated Go package accepts silently and discovers
// at boot, or in front of a player, or never.
func Validate(d Descriptor) error {
	var problems []string
	report := func(format string, args ...any) {
		problems = append(problems, fmt.Sprintf(format, args...))
	}

	if d.Schema != SchemaVersion {
		report("schema is %d, this loader understands %d", d.Schema, SchemaVersion)
	}
	prof, knownProfile := profiles[d.Rules.Profile]
	if !knownProfile {
		report("unknown rules profile %q (known: %s)",
			d.Rules.Profile, strings.Join(sortedKeys(profiles), ", "))
	}

	// A map reference selects a sibling directory, so it has to be a bare key.
	// Anything else is refused here rather than sanitised, because a reference
	// that has to be cleaned up before it is safe is a reference nobody can
	// read and be sure of.
	if d.Map != "" && !IsVariantKey(d.Map) {
		report("map %q is not a variant key; a variant is drawn on another "+
			"variant by key, never by path", d.Map)
	}
	if d.Map != "" && d.Map == d.Key {
		report("map %q names this variant, so its art has no source", d.Map)
	}

	// The opening phase has to be one the profile's cycle can reach. A season
	// the phase generator never produces would leave the game in a phase it
	// could never return to.
	if knownProfile {
		_, season, phaseType := d.Start.startPhase()
		seasons := orDefault(prof.seasons, classical.Seasons)
		if !slices.Contains(seasons, season) {
			report("start season %q is not one of this profile's seasons (%v)",
				season, seasons)
		}
		phaseTypes := orDefault(prof.phaseTypes, classical.PhaseTypes)
		if !slices.Contains(phaseTypes, phaseType) {
			report("start phase %q is not one of this profile's phase types (%v)",
				phaseType, phaseTypes)
		}
	}

	nations := map[string]bool{}
	for _, n := range d.Nations {
		if nations[n] {
			report("nation %q listed twice", n)
		}
		nations[n] = true
	}
	if len(d.Nations) == 0 {
		report("no nations declared")
	}

	// Provinces.
	provinces := map[string]bool{}
	for i, row := range d.Provinces {
		if len(row) < 3 {
			report("provinces[%d] needs 3 fields, got %d", i, len(row))
			continue
		}
		key, ok := row[0].(string)
		if !ok || key == "" {
			report("provinces[%d] key must be a non-empty string", i)
			continue
		}
		if provinces[key] {
			report("province %q declared twice", key)
		}
		provinces[key] = true

		if row[2] == nil {
			continue
		}
		if _, ok := row[2].(string); !ok {
			report("province %q supply centre must be a string or null", key)
		}
	}

	// Regions.
	regions := map[string]bool{}
	for i, row := range d.Regions {
		name, err := regionName(row)
		if err != nil {
			report("regions[%d]: %v", i, err)
			continue
		}
		base, _ := row[0].(string)
		if !provinces[base] {
			report("region %q belongs to unknown province %q", name, base)
		}
		flag, ok := row[2].(string)
		if !ok {
			report("region %q flag must be a string", name)
			continue
		}
		if _, known := flagsByName[flag]; !known {
			report("region %q has unknown terrain %q (known: %s)", name, flag,
				strings.Join(sortedKeys(flagsByName), ", "))
		}
		if regions[name] {
			report("region %q declared twice", name)
		}
		regions[name] = true
	}
	for key := range provinces {
		if !regions[key] {
			report("province %q has no base region", key)
		}
	}

	// Borders. A border is one row, so asymmetry is unrepresentable; what is
	// still possible is naming a region that does not exist, or duplicating a
	// pair with two different terrains.
	seen := map[string]string{}
	degree := map[string]int{}
	for i, row := range d.Borders {
		if len(row) != 3 {
			report("borders[%d] needs 3 fields, got %d", i, len(row))
			continue
		}
		a, b, terrain := row[0], row[1], row[2]
		if a == b {
			report("border %d joins %q to itself", i, a)
			continue
		}
		if !regions[a] {
			report("border %q-%q names unknown region %q", a, b, a)
		}
		if !regions[b] {
			report("border %q-%q names unknown region %q", a, b, b)
		}
		if _, known := flagsByName[terrain]; !known {
			report("border %q-%q has unknown terrain %q", a, b, terrain)
		}

		pair := a + "|" + b
		if a > b {
			pair = b + "|" + a
		}
		if prev, dup := seen[pair]; dup {
			if prev != terrain {
				report("border %q-%q declared twice, as %q and %q", a, b, prev, terrain)
			} else {
				report("border %q-%q declared twice", a, b)
			}
		}
		seen[pair] = terrain
		degree[a]++
		degree[b]++
	}

	// One-way edges. Direction is the point of them, so the pair is not
	// normalised: a->b and b->a are two different rows and both may be present
	// with different terrain.
	directed := map[string]bool{}
	for i, row := range d.OneWayBorders {
		if len(row) != 3 {
			report("onewayBorders[%d] needs 3 fields, got %d", i, len(row))
			continue
		}
		from, to, terrain := row[0], row[1], row[2]
		if from == to {
			report("one-way border %d joins %q to itself", i, from)
			continue
		}
		if !regions[from] {
			report("one-way border %q->%q names unknown region %q", from, to, from)
		}
		if !regions[to] {
			report("one-way border %q->%q names unknown region %q", from, to, to)
		}
		if _, known := flagsByName[terrain]; !known {
			report("one-way border %q->%q has unknown terrain %q", from, to, terrain)
		}
		pair := from + "|" + to
		if directed[pair] {
			report("one-way border %q->%q declared twice", from, to)
		}
		directed[pair] = true

		normalised := pair
		if from > to {
			normalised = to + "|" + from
		}
		if _, mutual := seen[normalised]; mutual {
			report("%q-%q is declared as a border and again as a one-way border",
				from, to)
		}
		degree[from]++
		degree[to]++
	}

	// Starting position.
	for prov, spec := range d.Start.Units {
		if !regions[prov] {
			report("starting unit on unknown region %q", prov)
			continue
		}
		if len(spec) != 2 {
			report("starting unit on %q needs [type, nation]", prov)
			continue
		}
		if unitType, known := unitTypesByName[spec[0]]; !known {
			report("starting unit on %q has unknown type %q", prov, spec[0])
		} else if knownProfile &&
			!slices.Contains(orDefault(prof.unitTypes, classical.UnitTypes), unitType) {
			report("starting unit on %q is a %v, which this profile does not have",
				prov, spec[0])
		}
		// A unit can start unowned: Europe 1939 puts one in Serbia for whoever
		// takes it.
		if !nations[spec[1]] && !isNeutral(spec[1]) {
			report("starting unit on %q belongs to unknown nation %q", prov, spec[1])
		}
		if owner, held := d.Start.SupplyCenters[prov]; held && owner != spec[1] {
			report("starting unit on %q belongs to %q but the centre is %q's",
				prov, spec[1], owner)
		}
	}
	for prov, nation := range d.Start.SupplyCenters {
		if !provinces[prov] {
			report("starting supply centre on unknown province %q", prov)
		}
		if !nations[nation] && !isNeutral(nation) {
			report("starting supply centre %q belongs to unknown nation %q", prov, nation)
		}
	}

	// Win condition.
	totalSCs := 0
	for _, row := range d.Provinces {
		if len(row) >= 3 && row[2] != nil {
			totalSCs++
		}
	}
	if d.SoloSupplyCenters <= 0 {
		report("soloSupplyCenters must be positive, got %d", d.SoloSupplyCenters)
	} else if d.SoloSupplyCenters > totalSCs {
		report("soloSupplyCenters is %d but the map has %d supply centres, so nobody can win",
			d.SoloSupplyCenters, totalSCs)
	}

	if len(problems) > 0 {
		sort.Strings(problems)
		return &ValidationError{Problems: problems}
	}
	return nil
}

// isNeutral reports whether a supply-centre owner names no nation. godip
// spells it "Neutral"; a descriptor written by hand is likely to say
// "neutral".
func isNeutral(owner string) bool {
	return strings.EqualFold(owner, "neutral")
}

// Warnings lists things that are legal but usually mistakes.
//
// These are not format errors. Real variants break every one of them on
// purpose: classical gives Russia a fourth home centre, 1900 sets a solo
// threshold two nations could both reach, and 1900 carries an isolated
// province called Dummy. A generator should avoid them; a loader has no
// business refusing a map over them.
func Warnings(d Descriptor) []string {
	var out []string

	// A home centre may name a nation that is not playing. France vs Austria
	// is the classical map with five of its seven powers removed, and their
	// centres still say whose home they were.
	nations := map[string]bool{}
	for _, n := range d.Nations {
		nations[n] = true
	}
	absent := map[string]bool{}
	for _, row := range d.Provinces {
		if len(row) < 3 || row[2] == nil {
			continue
		}
		if owner, ok := row[2].(string); ok && !nations[owner] && !isNeutral(owner) {
			absent[owner] = true
		}
	}
	if len(absent) > 0 {
		out = append(out, fmt.Sprintf(
			"home centres belong to nations that are not playing: %s",
			strings.Join(sortedKeys(absent), ", ")))
	}

	degree := map[string]int{}
	for _, rows := range [][][]string{d.Borders, d.OneWayBorders} {
		for _, row := range rows {
			if len(row) == 3 {
				degree[row[0]]++
				degree[row[1]]++
			}
		}
	}
	for _, row := range d.Regions {
		name, err := regionName(row)
		if err == nil && degree[name] == 0 {
			out = append(out, fmt.Sprintf(
				"region %q has no borders, so no unit can reach it", name))
		}
	}

	totalSCs := 0
	for _, row := range d.Provinces {
		if len(row) >= 3 && row[2] != nil {
			totalSCs++
		}
	}
	if d.SoloSupplyCenters > 0 && d.SoloSupplyCenters <= totalSCs/2 {
		out = append(out, fmt.Sprintf(
			"soloSupplyCenters is %d of %d, so several nations could win at once",
			d.SoloSupplyCenters, totalSCs))
	}

	homes := map[string]int{}
	for _, nation := range d.Start.SupplyCenters {
		homes[nation]++
	}
	if len(homes) > 1 {
		min, max := -1, 0
		for _, n := range d.Nations {
			c := homes[n]
			if min < 0 || c < min {
				min = c
			}
			if c > max {
				max = c
			}
		}
		if max-min > 0 {
			out = append(out, fmt.Sprintf(
				"nations start with unequal home centres (spread %d)", max-min))
		}
	}

	sort.Strings(out)
	return out
}

// ErrNoProfile is returned when a descriptor names a rules profile that this
// build does not carry.
var ErrNoProfile = errors.New("unknown rules profile")

// IsVariantKey reports whether s is a bare variant key: lower-case letters and
// digits, nothing else.
//
// This is the path-traversal boundary for the map reference. A key joined to
// the variants directory can only ever name a child of it, because a key holds
// no separator, no dot and no drive letter. Callers refuse whatever this
// rejects; none of them repair it.
func IsVariantKey(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
			continue
		}
		return false
	}
	return true
}
