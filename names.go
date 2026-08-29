// Province display names, and the per-variant file that corrects them.
//
// godip carries a ProvinceLongNames table per variant and it is the only
// source of names the app has. It is also, on the translated variants, the
// name whoever wrote the jDip file happened to type: "Gulf of Lyon" against
// "Gulf of Lyons", a code where a name should be, an English name on a map
// drawn in another language.
//
// Rather than patch godip or the translator, a variant may carry an overrides
// file — names/<key>.json, `{"lyo": "Gulf of Lyon"}` — that is layered over
// godip's table wherever it has an entry. The map editor at /mapeditor writes
// these (D-030); the server reads them and every board that asks for names
// gets the corrected set, so the correction lands in one place.
//
// A variant with no file is served godip's names unchanged, which is what
// every variant did before this file existed.
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

// nameDir can be pointed elsewhere with NAMES, which is what the tests and a
// run from another working directory need.
func nameDir() string {
	if p := os.Getenv("NAMES"); p != "" {
		return p
	}
	return "names"
}

// nameOverrides holds every overrides file found at startup, by variant key.
// It is written once before any request is served and only read afterwards,
// so it needs no lock.
var nameOverrides = map[string]map[string]string{}

// loadNameOverrides reads every names/<key>.json into memory.
//
// A missing directory is not an error: a checkout with no overrides is a
// working server, it just serves godip's own names. A malformed file IS an
// error worth failing on, for the same reason a malformed placement table is:
// half a correction applied silently would be worse than none.
func loadNameOverrides() error {
	dir := nameDir()
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
		b, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			return fmt.Errorf("read %v: %w", name, err)
		}
		var table map[string]string
		if err := json.Unmarshal(b, &table); err != nil {
			return fmt.Errorf("parse %v: %w", name, err)
		}
		// An empty string is an absent override, not a request for a blank
		// label: a board with no name for a province is unreadable.
		for prov, long := range table {
			if strings.TrimSpace(long) == "" {
				delete(table, prov)
			}
		}
		nameOverrides[key] = table
		loaded = append(loaded, fmt.Sprintf("%v (%d names)", key, len(table)))
	}
	sort.Strings(loaded)
	if len(loaded) > 0 {
		log.Printf("name overrides: %v", strings.Join(loaded, ", "))
	}
	return nil
}

// namesFor returns one variant's display names: godip's long names with the
// variant's overrides layered on top.
func namesFor(key string) map[string]string {
	out := map[string]string{}
	if v, found := lookupVariant(key); found {
		for prov, long := range v.ProvinceLongNames {
			out[string(prov)] = long
		}
	}
	for prov, long := range nameOverrides[key] {
		out[prov] = long
	}
	return out
}
