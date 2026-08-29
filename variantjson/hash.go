package variantjson

// The identity of a variant, for games that have to replay against it.
//
// A game replays its whole order history against the variant's starting
// position, so it has to know the map has not changed underneath it. Hashing
// the file would answer a different question: it would change when somebody
// reflows the JSON, corrects a typo in the description, or bumps a version
// string, none of which move a single unit.
//
// So the hash covers only what decides how a game plays. Rename the variant
// and every game survives. Move one border and they all refuse to load.

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"sort"
)

// gameFacts is the descriptor reduced to the parts that decide play, in a
// canonical order so the same map always hashes the same.
type gameFacts struct {
	Nations   []string          `json:"nations"`
	Provinces [][]string        `json:"provinces"`
	Regions   [][]string        `json:"regions"`
	Borders   [][]string        `json:"borders"`
	Units     map[string]string `json:"units"`
	Centers   map[string]string `json:"centers"`
	Solo      int               `json:"solo"`
	Profile   string            `json:"profile"`
	Orders    []string          `json:"orders"`
	// StartPhase is empty for a variant that opens in Spring 1901, whether it
	// says so or leaves the fields out. Saying the default and omitting it
	// describe the same board, so they hash the same.
	StartPhase string `json:"startPhase,omitempty"`
}

// cell renders one descriptor field as a string, so a row compares and sorts
// the same whether it arrived as JSON null, a string, or a number.
func cell(v any) string {
	if v == nil {
		return ""
	}
	if s, ok := v.(string); ok {
		return s
	}
	return fmt.Sprint(v)
}

func sortRows(rows [][]string) {
	sort.Slice(rows, func(i, j int) bool {
		a, b := rows[i], rows[j]
		for k := 0; k < len(a) && k < len(b); k++ {
			if a[k] != b[k] {
				return a[k] < b[k]
			}
		}
		return len(a) < len(b)
	})
}

// GameHash returns the identity of the map a game is played on.
//
// Two descriptors hash the same exactly when they produce the same board: the
// same provinces and regions, the same borders, the same opening position, the
// same win condition and the same rules. Names, descriptions, authorship,
// version strings and formatting are all absent on purpose.
func GameHash(d Descriptor) string {
	facts := gameFacts{
		Nations: append([]string(nil), d.Nations...),
		Units:   map[string]string{},
		Centers: map[string]string{},
		Solo:    d.SoloSupplyCenters,
		Profile: d.Rules.Profile,
		Orders:  append([]string(nil), d.Rules.Orders...),
	}
	sort.Strings(facts.Nations)
	sort.Strings(facts.Orders)

	year, season, phaseType := d.Start.startPhase()
	if year != defaultStartYear || season != defaultStartSeason || phaseType != defaultStartPhase {
		facts.StartPhase = fmt.Sprintf("%d %v %v", year, season, phaseType)
	}

	// A province's long name is a label, so only its key and its supply centre
	// count. A region and a border are load-bearing in full.
	for _, row := range d.Provinces {
		if len(row) >= 3 {
			facts.Provinces = append(facts.Provinces,
				[]string{cell(row[0]), cell(row[2])})
		}
	}
	for _, row := range d.Regions {
		if len(row) >= 3 {
			facts.Regions = append(facts.Regions,
				[]string{cell(row[0]), cell(row[1]), cell(row[2])})
		}
	}
	for _, row := range d.Borders {
		if len(row) == 3 {
			a, b := row[0], row[1]
			// A border is undirected, so its two ends sort into one order.
			if a > b {
				a, b = b, a
			}
			facts.Borders = append(facts.Borders, []string{a, b, row[2]})
		}
	}
	sortRows(facts.Provinces)
	sortRows(facts.Regions)
	sortRows(facts.Borders)

	for province, spec := range d.Start.Units {
		if len(spec) == 2 {
			facts.Units[province] = spec[0] + " " + spec[1]
		}
	}
	for province, nation := range d.Start.SupplyCenters {
		facts.Centers[province] = nation
	}

	// encoding/json sorts map keys, and every slice above is sorted, so this
	// is canonical.
	body, err := json.Marshal(facts)
	if err != nil {
		// gameFacts holds only strings, ints and maps of strings.
		panic(fmt.Sprintf("hashing variant: %v", err))
	}
	return fmt.Sprintf("%x", sha256.Sum256(body))
}
