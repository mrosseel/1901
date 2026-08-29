package variantjson

import (
	"errors"
	"fmt"
	"sort"
	"strings"
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
	if _, ok := profiles[d.Rules.Profile]; !ok {
		report("unknown rules profile %q (known: %s)",
			d.Rules.Profile, strings.Join(sortedKeys(profiles), ", "))
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
		owner, ok := row[2].(string)
		if !ok {
			report("province %q supply centre must be a string or null", key)
			continue
		}
		if owner != "neutral" && !nations[owner] {
			report("province %q is a home centre for unknown nation %q", key, owner)
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
			report("region %q has unknown flag %q (want land, sea or coast)", name, flag)
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
	for name := range regions {
		if degree[name] == 0 {
			report("region %q has no borders, so no unit can ever reach it", name)
		}
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
		if spec[0] != "army" && spec[0] != "fleet" {
			report("starting unit on %q has unknown type %q", prov, spec[0])
		}
		if !nations[spec[1]] {
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
		if !nations[nation] {
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
	} else if d.SoloSupplyCenters <= totalSCs/2 {
		report("soloSupplyCenters is %d of %d, so several nations could win at once",
			d.SoloSupplyCenters, totalSCs)
	}

	// Equal starts. A generated map is meant to be balanced; an uneven start
	// means the generator or the export is wrong.
	homesPer := map[string]int{}
	for _, nation := range d.Start.SupplyCenters {
		homesPer[nation]++
	}
	unitsPer := map[string]int{}
	for _, spec := range d.Start.Units {
		if len(spec) == 2 {
			unitsPer[spec[1]]++
		}
	}
	if spread := spreadOf(homesPer, d.Nations); spread > 0 {
		report("nations start with unequal home centres (spread %d)", spread)
	}
	if spread := spreadOf(unitsPer, d.Nations); spread > 0 {
		report("nations start with unequal unit counts (spread %d)", spread)
	}

	if len(problems) > 0 {
		sort.Strings(problems)
		return &ValidationError{Problems: problems}
	}
	return nil
}

// spreadOf returns max minus min across the named nations.
func spreadOf(counts map[string]int, nations []string) int {
	if len(nations) == 0 {
		return 0
	}
	min, max := -1, 0
	for _, n := range nations {
		c := counts[n]
		if min < 0 || c < min {
			min = c
		}
		if c > max {
			max = c
		}
	}
	return max - min
}

// ErrNoProfile is returned when a descriptor names a rules profile that this
// build does not carry.
var ErrNoProfile = errors.New("unknown rules profile")
