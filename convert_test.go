package main

// A one-time migration: turn a compiled variant into a descriptor on disk.
//
// It lives as a test because it needs the compiled variants, which only this
// package can see, and because a migration has no business in the server's
// production surface. Run it with CONVERT_VARIANTS set to the keys to convert:
//
//	CONVERT_VARIANTS="1900 sailho sailhocrowded" \
//	CONVERT_OUT=variants/generated go test -run TestConvertVariants .
//
// TestConvertedVariantsMatchTheirSource then proves the descriptor builds the
// same graph and the same opening position as the package it replaced.

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/zond/godip"
	"github.com/zond/godip/variants/common"

	"spring1901/spike/variantjson"
)

// flagWord names a flag set the way a descriptor spells it.
func flagWord(flags map[godip.Flag]bool) (string, error) {
	land, sea := flags[godip.Land], flags[godip.Sea]
	switch {
	case land && sea:
		return "coast", nil
	case land:
		return "land", nil
	case sea:
		return "sea", nil
	}
	return "", fmt.Errorf("flag set %v is neither land nor sea", flags)
}

// splitCoast turns "hes/nc" into ("hes", "nc").
func splitCoast(name string) (string, any) {
	if base, coast, found := strings.Cut(name, "/"); found {
		return base, coast
	}
	return name, nil
}

// descriptorFor reads a compiled variant and returns the descriptor that
// describes it.
func descriptorFor(t *testing.T, key string, v common.Variant) map[string]any {
	t.Helper()
	g := v.Graph()

	state, err := v.Start()
	if err != nil {
		t.Fatalf("%v: Start: %v", key, err)
	}

	nodes := []string{}
	for _, p := range g.Provinces() {
		nodes = append(nodes, string(p))
	}
	sort.Strings(nodes)

	// Regions are the graph's nodes. Provinces are the bases among them.
	regions := [][]any{}
	bases := []string{}
	for _, name := range nodes {
		word, err := flagWord(g.Flags(godip.Province(name)))
		if err != nil {
			t.Fatalf("%v: province %v: %v", key, name, err)
		}
		base, coast := splitCoast(name)
		regions = append(regions, []any{base, coast, word})
		if coast == nil {
			bases = append(bases, base)
		}
	}

	provinces := [][]any{}
	for _, base := range bases {
		var sc any
		if owner := g.SC(godip.Province(base)); owner != nil {
			if *owner == godip.Neutral {
				sc = "neutral"
			} else {
				sc = string(*owner)
			}
		}
		name := base
		if long, ok := v.ProvinceLongNames[godip.Province(base)]; ok && long != "" {
			name = long
		}
		provinces = append(provinces, []any{base, name, sc})
	}

	// One row per border. godip stores both directions, so take each pair once.
	seen := map[string]bool{}
	borders := [][]string{}
	for _, name := range nodes {
		for dest, flags := range g.Edges(godip.Province(name), false) {
			a, b := name, string(dest)
			if a > b {
				a, b = b, a
			}
			if seen[a+"|"+b] {
				continue
			}
			word, err := flagWord(flags)
			if err != nil {
				t.Fatalf("%v: border %v-%v: %v", key, a, b, err)
			}
			seen[a+"|"+b] = true
			borders = append(borders, []string{a, b, word})
		}
	}
	sort.Slice(borders, func(i, j int) bool {
		if borders[i][0] != borders[j][0] {
			return borders[i][0] < borders[j][0]
		}
		return borders[i][1] < borders[j][1]
	})

	units := map[string][]string{}
	for province, unit := range state.Units() {
		word := "army"
		if unit.Type == godip.Fleet {
			word = "fleet"
		}
		units[string(province)] = []string{word, string(unit.Nation)}
	}
	centers := map[string]string{}
	for province, nation := range state.SupplyCenters() {
		centers[string(province)] = string(nation)
	}

	nations := []string{}
	for _, n := range v.Nations {
		nations = append(nations, string(n))
	}

	return map[string]any{
		"schema":            1,
		"key":               key,
		"name":              v.Name,
		"createdBy":         v.CreatedBy,
		"version":           v.Version,
		"description":       v.Description,
		"soloSupplyCenters": v.SoloSCCount(state),
		"nations":           nations,
		"provinces":         provinces,
		"regions":           regions,
		"borders":           borders,
		"start": map[string]any{
			"units":         units,
			"supplyCenters": centers,
		},
		"rules": map[string]any{
			"profile": "classical",
			"orders": []string{
				"move", "moveViaConvoy", "hold", "support", "convoy",
				"build", "disband",
			},
		},
	}
}

// TestConvertVariants writes descriptors for the named compiled variants.
func TestConvertVariants(t *testing.T) {
	keys := strings.Fields(os.Getenv("CONVERT_VARIANTS"))
	if len(keys) == 0 {
		t.Skip("set CONVERT_VARIANTS to a list of variant keys")
	}
	out := os.Getenv("CONVERT_OUT")
	if out == "" {
		out = filepath.Join("variants", "generated")
	}

	for _, key := range keys {
		v, ok := lookupVariant(key)
		if !ok {
			t.Fatalf("no compiled variant %q", key)
		}

		dir := filepath.Join(out, key)
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}

		descriptor := descriptorFor(t, key, v)
		body, err := json.MarshalIndent(descriptor, "", "  ")
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, "variant.json"), append(body, '\n'), 0o644); err != nil {
			t.Fatal(err)
		}

		art, err := v.SVGMap()
		if err != nil {
			t.Fatalf("%v: SVGMap: %v", key, err)
		}
		if err := os.WriteFile(filepath.Join(dir, "map.svg"), art, 0o644); err != nil {
			t.Fatal(err)
		}

		// The approved placement table moves in beside the map it belongs to.
		if table, err := os.ReadFile(filepath.Join(placementDir(), key+".json")); err == nil {
			if err := os.WriteFile(filepath.Join(dir, "placements.json"), table, 0o644); err != nil {
				t.Fatal(err)
			}
		}

		t.Logf("%v: %d provinces, %d nations -> %v",
			key, len(v.Graph().Provinces()), len(v.Nations), dir)
	}
}

// fingerprintGraph reduces a graph to a comparable form: per province, its
// flags, its supply centre owner, and every edge with the flags that cross it.
func fingerprintGraph(g godip.Graph) map[string]string {
	out := map[string]string{}
	for _, prov := range g.Provinces() {
		sc := "-"
		if owner := g.SC(prov); owner != nil {
			sc = string(*owner)
		}
		edges := []string{}
		for dest, flags := range g.Edges(prov, false) {
			word, _ := flagWord(flags)
			edges = append(edges, fmt.Sprintf("%s:%s", dest, word))
		}
		sort.Strings(edges)
		word, _ := flagWord(g.Flags(prov))
		out[string(prov)] = fmt.Sprintf("flags=%s sc=%s edges=%v", word, sc, edges)
	}
	return out
}

func fingerprintStart(t *testing.T, v common.Variant) (map[string]string, map[string]string) {
	t.Helper()
	state, err := v.Start()
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	units := map[string]string{}
	for province, unit := range state.Units() {
		units[string(province)] = fmt.Sprintf("%v %v", unit.Type, unit.Nation)
	}
	centers := map[string]string{}
	for province, nation := range state.SupplyCenters() {
		centers[string(province)] = string(nation)
	}
	return units, centers
}

// TestConvertedVariantsMatchTheirSource is the check that makes the migration
// safe. For every converted variant, the descriptor on disk must build exactly
// the graph and opening position of the package it replaced.
//
// It reads the compiled variant from the registry, so it only means something
// while both exist. Once the packages are deleted it falls back to skipping.
func TestConvertedVariantsMatchTheirSource(t *testing.T) {
	// The descriptor is read straight from disk, not through the registry:
	// during the migration both the package and the descriptor exist, and the
	// registry refuses that on purpose.
	for _, key := range []string{"1900", "sailho", "sailhocrowded"} {
		t.Run(key, func(t *testing.T) {
			path := filepath.Join("variants", "generated", key, "variant.json")
			f, err := os.Open(path)
			if err != nil {
				t.Skipf("%v has not been converted", key)
			}
			loaded, err := variantjson.Load(f)
			f.Close()
			if err != nil {
				t.Fatalf("%v: %v", path, err)
			}

			var source common.Variant
			found := false
			for _, v := range compiledVariants() {
				if variantKey(v.Name) == key {
					source, found = v, true
				}
			}
			if !found {
				t.Skipf("%v is no longer compiled in, nothing to compare", key)
			}

			want := fingerprintGraph(source.Graph())
			got := fingerprintGraph(loaded.Graph())
			if len(want) != len(got) {
				t.Errorf("province count: compiled %d, descriptor %d", len(want), len(got))
			}
			names := []string{}
			for name := range want {
				names = append(names, name)
			}
			sort.Strings(names)
			mismatches := 0
			for _, name := range names {
				if got[name] != want[name] {
					t.Errorf("province %s differs:\n  compiled:   %s\n  descriptor: %s",
						name, want[name], got[name])
					if mismatches++; mismatches > 5 {
						t.Fatal("too many mismatches")
					}
				}
			}
			for name := range got {
				if _, ok := want[name]; !ok {
					t.Errorf("descriptor has province %s that the package does not", name)
				}
			}

			wantUnits, wantCenters := fingerprintStart(t, source)
			gotUnits, gotCenters := fingerprintStart(t, loaded)
			if fmt.Sprint(wantUnits) != fmt.Sprint(gotUnits) {
				t.Errorf("starting units differ:\n  compiled:   %v\n  descriptor: %v",
					wantUnits, gotUnits)
			}
			if fmt.Sprint(wantCenters) != fmt.Sprint(gotCenters) {
				t.Errorf("starting centres differ:\n  compiled:   %v\n  descriptor: %v",
					wantCenters, gotCenters)
			}
			if source.SoloSCCount(nil) != loaded.SoloSCCount(nil) {
				t.Errorf("solo count: compiled %d, descriptor %d",
					source.SoloSCCount(nil), loaded.SoloSCCount(nil))
			}
		})
	}
}
