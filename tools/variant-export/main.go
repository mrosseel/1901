// variant-export turns godip's compiled variants into descriptors.
//
// godip ships each of its variants as a Go package: a graph built by method
// chaining, a start function, and a struct of metadata. This server reads
// variants from disk instead (variants/generated), so every one of them has to
// cross over exactly once, and this is the crossing.
//
//	go run ./tools/variant-export --out variants/generated
//
// It is not a one-way conversion tool that anybody has to trust. Everything it
// writes is checked against the package it came from by variants_equivalence_test.go,
// province by province and border by border. This program's job is to be
// exhaustive and to refuse anything it cannot state faithfully.
package main

import (
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/zond/godip"
	"github.com/zond/godip/variants"
	"github.com/zond/godip/variants/common"

	"spring1901/spike/variantjson"
)

// profileByVariant says which compiled rule set each godip variant plays by.
//
// A variant absent from this table is a variant nobody has decided about, and
// exporting it would guess at how it plays, so it is an error rather than a
// default.
var profileByVariant = map[string]string{
	"1800: Empires And Coalitions": "classical",
	"1908: Fall of Europe":         "classical",
	"Ancient Mediterranean":        "classical",
	"Canton":                       "classical",
	"Chaos":                        "chaos",
	"Classical":                    "classical",
	"Classical - Crowded":          "classical",
	"Cold War":                     "classical",
	"Europe 1939":                  "classical",
	"Fleet Rome":                   "classical",
	"France vs Austria":            "classical",
	"Gateway West":                 "classical-buildanywhere",
	"Hundred":                      "hundred",
	"Italy vs Germany":             "classical",
	"North Sea Wars":               "classical",
	"Pure":                         "pure",
	"Sengoku":                      "buildanywhere-neutrals",
	"Three Kingdoms":               "buildanywhere",
	"Twenty Twenty":                "twentytwenty",
	"Unconstitutional":             "buildanywhere",
	"Vietnam War":                  "classical",
	"Western World 901":            "buildanywhere-neutrals",
	"Youngstown Redux":             "classical",
}

func main() {
	out := flag.String("out", filepath.Join("variants", "generated"),
		"directory to write one subdirectory per variant into")
	placements := flag.String("placements", "placements",
		"directory holding the approved placement tables to carry across")
	only := flag.String("only", "", "export just this variant key")
	flag.Parse()

	if err := run(*out, *placements, *only); err != nil {
		log.Fatal(err)
	}
}

func run(out, placementDir, only string) error {
	known := map[string]bool{}
	for _, v := range variants.OrderedVariants {
		known[v.Name] = true
	}
	for name := range profileByVariant {
		if !known[name] {
			return fmt.Errorf("this build of godip has no variant called %q", name)
		}
	}

	exported := 0
	for _, v := range variants.OrderedVariants {
		key := variantKey(v.Name)
		if only != "" && key != only {
			continue
		}
		if err := export(v, key, out, placementDir); err != nil {
			return fmt.Errorf("%v: %w", key, err)
		}
		exported++
	}
	if exported == 0 {
		return fmt.Errorf("no variant matched %q", only)
	}
	log.Printf("exported %d variants to %v", exported, out)
	return nil
}

func export(v common.Variant, key, out, placementDir string) error {
	descriptor, err := describe(v, key)
	if err != nil {
		return err
	}
	if err := variantjson.Validate(descriptor); err != nil {
		return err
	}
	for _, warning := range variantjson.Warnings(descriptor) {
		log.Printf("%v: %v", key, warning)
	}

	dir := filepath.Join(out, key)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}

	body, err := encode(descriptor)
	if err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(dir, "variant.json"), body, 0o644); err != nil {
		return err
	}

	if v.SVGMap == nil {
		return fmt.Errorf("has no map art")
	}
	art, err := v.SVGMap()
	if err != nil {
		return fmt.Errorf("reading map art: %w", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "map.svg"), art, 0o644); err != nil {
		return err
	}

	// The approved placement table moves in beside the map it was measured
	// on. A variant without one falls back to the map's own anchors, exactly
	// as it did before.
	table, err := os.ReadFile(filepath.Join(placementDir, key+".json"))
	if err == nil {
		err = os.WriteFile(filepath.Join(dir, "placements.json"), table, 0o644)
	} else if os.IsNotExist(err) {
		err = nil
	}
	return err
}

// describe reads everything a descriptor needs out of a compiled variant.
func describe(v common.Variant, key string) (variantjson.Descriptor, error) {
	var d variantjson.Descriptor

	profile, found := profileByVariant[v.Name]
	if !found {
		return d, fmt.Errorf("no rules profile is recorded for %q", v.Name)
	}

	start, err := v.Start()
	if err != nil {
		return d, fmt.Errorf("starting: %w", err)
	}
	g := start.Graph()

	d.Schema = variantjson.SchemaVersion
	d.Key = key
	d.Name = v.Name
	d.CreatedBy = v.CreatedBy
	d.Version = v.Version
	d.Description = v.Description
	d.Rules = variantjson.Rules{Profile: profile, Text: v.Rules}
	if v.SoloSCCount != nil {
		d.SoloSupplyCenters = v.SoloSCCount(start)
	}
	for _, nation := range v.Nations {
		d.Nations = append(d.Nations, string(nation))
	}

	// Regions are godip's nodes: a province and, separately, each of its named
	// coasts. The base province is the one whose name has no slash.
	regions := append([]godip.Province(nil), g.Provinces()...)
	sort.Slice(regions, func(i, j int) bool { return regions[i] < regions[j] })

	bases := []godip.Province{}
	for _, region := range regions {
		flag, err := terrainName(g.Flags(region))
		if err != nil {
			return d, fmt.Errorf("region %v: %w", region, err)
		}
		province, coast := split(region)
		if coast == "" {
			bases = append(bases, region)
			d.Regions = append(d.Regions, []any{province, nil, flag})
		} else {
			// A supply centre hangs off the base province in godip too: its
			// graph answers for a coast with whatever the province owns.
			d.Regions = append(d.Regions, []any{province, coast, flag})
		}
	}

	for _, province := range bases {
		var owner any
		if sc := g.SC(province); sc != nil {
			owner = string(*sc)
		}
		d.Provinces = append(d.Provinces,
			[]any{string(province), v.ProvinceLongNames[province], owner})
	}

	// One row per border. godip stores two directed edges, so a map whose two
	// halves disagree cannot be written down here at all.
	seen := map[string]bool{}
	for _, from := range regions {
		for to, flags := range g.Edges(from, false) {
			pair := string(from) + "|" + string(to)
			if from > to {
				pair = string(to) + "|" + string(from)
			}
			if seen[pair] {
				continue
			}
			seen[pair] = true

			terrain, err := terrainName(flags)
			if err != nil {
				return d, fmt.Errorf("border %v-%v: %w", from, to, err)
			}
			back, connected := g.Edges(to, false)[from]
			backTerrain := ""
			if connected {
				if backTerrain, err = terrainName(back); err != nil {
					return d, fmt.Errorf("border %v-%v: %w", to, from, err)
				}
			}
			// Mutual and agreed: one row. Anything else keeps its direction,
			// because that is what godip's graph says and what the adjudicator
			// will read.
			if backTerrain == terrain {
				d.Borders = append(d.Borders,
					[]string{string(from), string(to), terrain})
				continue
			}
			d.OneWayBorders = append(d.OneWayBorders,
				[]string{string(from), string(to), terrain})
			if connected {
				d.OneWayBorders = append(d.OneWayBorders,
					[]string{string(to), string(from), backTerrain})
			}
		}
	}
	sortRows(d.Borders)
	sortRows(d.OneWayBorders)

	phase := start.Phase()
	d.Start = variantjson.Start{
		Year:          phase.Year(),
		Season:        string(phase.Season()),
		Phase:         string(phase.Type()),
		Units:         map[string][]string{},
		SupplyCenters: map[string]string{},
	}
	for province, unit := range start.Units() {
		name, err := unitTypeName(unit.Type)
		if err != nil {
			return d, fmt.Errorf("unit on %v: %w", province, err)
		}
		d.Start.Units[string(province)] = []string{name, string(unit.Nation)}
	}
	for province, nation := range start.SupplyCenters() {
		d.Start.SupplyCenters[string(province)] = string(nation)
	}
	return d, nil
}

// terrainName renders a flag set as the descriptor's one-word terrain.
//
// godip flags are an open set and a map may carry one this format has no word
// for, so anything but the three known combinations is refused rather than
// rounded to the nearest.
func terrainName(flags map[godip.Flag]bool) (string, error) {
	set := map[godip.Flag]bool{}
	for flag, on := range flags {
		if on {
			set[flag] = true
		}
	}
	switch {
	case len(set) == 1 && set[godip.Land]:
		return "land", nil
	case len(set) == 1 && set[godip.Sea]:
		return "sea", nil
	case len(set) == 2 && set[godip.Land] && set[godip.Sea]:
		return "coast", nil
	case len(set) == 3 && set[godip.Land] && set[godip.Sea] && set[godip.Convoyable]:
		return "archipelago", nil
	}
	names := []string{}
	for flag := range set {
		names = append(names, string(flag))
	}
	sort.Strings(names)
	return "", fmt.Errorf("terrain %v has no name in this format",
		"["+strings.Join(names, " ")+"]")
}

func unitTypeName(t godip.UnitType) (string, error) {
	switch t {
	case godip.Army:
		return "army", nil
	case godip.Fleet:
		return "fleet", nil
	}
	return "", fmt.Errorf("unit type %q has no name in this format", t)
}

// split separates "spa/nc" into a province and a coast.
func split(region godip.Province) (string, string) {
	province, coast, found := strings.Cut(string(region), "/")
	if !found {
		return province, ""
	}
	return province, coast
}

// variantKey turns a godip variant name into the URL-safe key the server and
// the directory name use. It matches the server's own function; a difference
// would put a variant in a directory nothing looks in.
func variantKey(name string) string {
	key := strings.Builder{}
	for _, r := range strings.ToLower(name) {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
			key.WriteRune(r)
		}
	}
	return key.String()
}

// encode writes a descriptor as JSON with one table row per line.
//
// encoding/json would put each of a border's three fields on a line of its
// own, which turns a map into forty thousand lines nobody can read or review.
func encode(d variantjson.Descriptor) ([]byte, error) {
	buf := &bytes.Buffer{}
	var fail error
	field := func(name string, value any) {
		raw, err := json.Marshal(value)
		if err != nil && fail == nil {
			fail = err
		}
		fmt.Fprintf(buf, "  %q: %s,\n", name, raw)
	}
	rows := func(name string, values []any) {
		fmt.Fprintf(buf, "  %q: [\n", name)
		for i, value := range values {
			raw, err := json.Marshal(value)
			if err != nil && fail == nil {
				fail = err
			}
			comma := ","
			if i == len(values)-1 {
				comma = ""
			}
			fmt.Fprintf(buf, "    %s%s\n", raw, comma)
		}
		fmt.Fprint(buf, "  ],\n")
	}

	buf.WriteString("{\n")
	field("schema", d.Schema)
	field("key", d.Key)
	field("name", d.Name)
	field("createdBy", d.CreatedBy)
	field("version", d.Version)
	field("description", d.Description)
	field("rules", d.Rules)
	field("soloSupplyCenters", d.SoloSupplyCenters)
	field("nations", d.Nations)

	provinces := make([]any, len(d.Provinces))
	for i, row := range d.Provinces {
		provinces[i] = row
	}
	rows("provinces", provinces)

	regions := make([]any, len(d.Regions))
	for i, row := range d.Regions {
		regions[i] = row
	}
	rows("regions", regions)

	borders := make([]any, len(d.Borders))
	for i, row := range d.Borders {
		borders[i] = row
	}
	rows("borders", borders)

	oneway := make([]any, len(d.OneWayBorders))
	for i, row := range d.OneWayBorders {
		oneway[i] = row
	}
	rows("onewayBorders", oneway)

	fmt.Fprint(buf, "  \"start\": {\n")
	fmt.Fprintf(buf, "    \"year\": %d,\n", d.Start.Year)
	fmt.Fprintf(buf, "    \"season\": %q,\n", d.Start.Season)
	fmt.Fprintf(buf, "    \"phase\": %q,\n", d.Start.Phase)
	writeMap := func(name string, keys []string, value func(string) any, last bool) {
		fmt.Fprintf(buf, "    %q: {\n", name)
		for i, key := range keys {
			raw, err := json.Marshal(value(key))
			if err != nil && fail == nil {
				fail = err
			}
			comma := ","
			if i == len(keys)-1 {
				comma = ""
			}
			fmt.Fprintf(buf, "      %q: %s%s\n", key, raw, comma)
		}
		if last {
			fmt.Fprint(buf, "    }\n")
		} else {
			fmt.Fprint(buf, "    },\n")
		}
	}
	writeMap("units", sortedKeys(d.Start.Units),
		func(k string) any { return d.Start.Units[k] }, false)
	writeMap("supplyCenters", sortedKeys(d.Start.SupplyCenters),
		func(k string) any { return d.Start.SupplyCenters[k] }, true)
	fmt.Fprint(buf, "  }\n}\n")

	if fail != nil {
		return nil, fail
	}
	// The writer above is hand-rolled, so the result is parsed back before it
	// reaches a file. A descriptor that does not round trip is not a
	// descriptor.
	var check variantjson.Descriptor
	if err := json.Unmarshal(buf.Bytes(), &check); err != nil {
		return nil, fmt.Errorf("the encoder wrote JSON it cannot read back: %w", err)
	}
	return buf.Bytes(), nil
}

// sortRows puts a table in a fixed order, so re-exporting an unchanged variant
// rewrites the same bytes.
func sortRows(rows [][]string) {
	sort.Slice(rows, func(i, j int) bool {
		for k := range rows[i] {
			if rows[i][k] != rows[j][k] {
				return rows[i][k] < rows[j][k]
			}
		}
		return false
	})
}

func sortedKeys[V any](m map[string]V) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}
