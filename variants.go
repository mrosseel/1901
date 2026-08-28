// The variant registry: godip's variants exposed by a URL-safe key, with
// the metadata the create-game gallery needs.
//
// Only classical is supported (D-014). The rest are playable but their
// map placement anchors are unverified, so they are marked experimental.
package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"

	"github.com/zond/godip"
	"github.com/zond/godip/variants"
	"github.com/zond/godip/variants/common"

	"spring1901/spike/variants1901/jdip1900"
	"spring1901/spike/variants1901/sailho"
	"spring1901/spike/variants1901/sailhocrowded"
)

// localVariants are the ones translated from jDip by tools/jdip-import.
// They sit beside godip's own and are served exactly the same way.
var localVariants = []common.Variant{
	jdip1900.Nineteen00Variant,
	sailho.SailHoVariant,
	sailhocrowded.SailHoCrowdedVariant,
}

// allVariants is every variant this server can play.
func allVariants() []common.Variant {
	out := make([]common.Variant, 0, len(variants.OrderedVariants)+len(localVariants))
	out = append(out, variants.OrderedVariants...)
	out = append(out, localVariants...)
	return out
}

// defaultVariant is what a game gets when none is named.
const defaultVariant = "classical"

// supportedVariants are the ones whose board art is verified (D-014).
var supportedVariants = map[string]bool{defaultVariant: true}

// variantKey turns a godip variant name into a URL-safe key:
// "Ancient Mediterranean" becomes "ancientmediterranean".
func variantKey(name string) string {
	key := strings.Builder{}
	for _, r := range strings.ToLower(name) {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
			key.WriteRune(r)
		}
	}
	return key.String()
}

var (
	byKey     = map[string]common.Variant{}
	byKeyOnce sync.Once
)

// lookupVariant resolves a key to its godip variant.
func lookupVariant(key string) (common.Variant, bool) {
	byKeyOnce.Do(func() {
		for _, v := range allVariants() {
			byKey[variantKey(v.Name)] = v
		}
	})
	v, found := byKey[key]
	return v, found
}

// variantJSON is one card in the create-game gallery.
type variantJSON struct {
	Key          string   `json:"key"`
	Name         string   `json:"name"`
	Powers       []string `json:"powers"`
	PowerCount   int      `json:"powerCount"`
	SoloSCCount  int      `json:"soloSCCount"`
	TotalSCCount int      `json:"totalSCCount"`
	StartYear    int      `json:"startYear"`
	Description  string   `json:"description"`
	Rules        string   `json:"rules"`
	CreatedBy    string   `json:"createdBy"`
	Supported    bool     `json:"supported"`
	MapURL       string   `json:"mapUrl"`
}

var (
	catalogue     []variantJSON
	catalogueOnce sync.Once
)

// variantCatalogue builds the metadata list once. It starts each variant
// and reads its map, so it is deliberately lazy: the cost lands on the
// first request for the gallery, not on every server start.
func variantCatalogue() []variantJSON {
	catalogueOnce.Do(func() {
		for _, v := range allVariants() {
			// A variant without map art cannot be shown or played here.
			if v.SVGMap == nil {
				continue
			}
			if b, err := v.SVGMap(); err != nil || len(b) == 0 {
				continue
			}
			s, err := v.Start()
			if err != nil {
				continue
			}
			key := variantKey(v.Name)
			card := variantJSON{
				Key:          key,
				Name:         v.Name,
				PowerCount:   len(v.Nations),
				TotalSCCount: len(s.Graph().AllSCs()),
				StartYear:    s.Phase().Year(),
				Description:  v.Description,
				Rules:        v.Rules,
				CreatedBy:    v.CreatedBy,
				Supported:    supportedVariants[key],
				MapURL:       "/variants/" + key + "/map.svg",
			}
			for _, n := range v.Nations {
				card.Powers = append(card.Powers, string(n))
			}
			if v.SoloSCCount != nil {
				card.SoloSCCount = v.SoloSCCount(s)
			}
			catalogue = append(catalogue, card)
		}
		sort.Slice(catalogue, func(i, j int) bool {
			// Supported first, then alphabetical.
			if catalogue[i].Supported != catalogue[j].Supported {
				return catalogue[i].Supported
			}
			return catalogue[i].Name < catalogue[j].Name
		})
	})
	return catalogue
}

func handleVariants(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, variantCatalogue())
}

// styledMaps holds the restyled art for the variants that have any: variant
// key, then style name, then the file.
//
// A converted jDip map is correct and unlovely: flat blue water, flat yellow
// land, a black backdrop. tools/restyle puts it into a named style — the
// styles are data, one JSON file each — and writes the result beside the
// original as map-<style>.svg (D-016, D-017). A restyle touches fills,
// strokes and text presentation only: the province shapes, their ids, the
// #provinces layer and the #province-centers anchors are byte-identical,
// which the tool checks and refuses to write without.
//
// So a styled file is what is served by default, in defaultMapStyle: it is
// the same map, drawn better. The original stays reachable at ?style=original,
// because a faithful copy of the source art is worth being able to look at
// when a conversion is in question.
var styledMaps = map[string]map[string][]byte{}

// defaultMapStyle is the style a map is served in when nobody asks for one.
const defaultMapStyle = "parchment"

// errUnknownStyle is what a request for a style this variant has no art in
// answers with. It is a 404 rather than a fallback to the default, because a
// silent fallback would let a typo in a saved preference look like a style.
var errUnknownStyle = errors.New("unknown style")

// styleCard is one entry in the style picker: what tools/restyle wrote into
// variants1901/styles.json. The server does not read the style definitions —
// it serves art that is already drawn — so the tool leaves it this list.
type styleCard struct {
	Name        string `json:"name"`
	Title       string `json:"title"`
	Description string `json:"description"`
}

var styleCards = []styleCard{}

// loadStyleCards reads the manifest tools/restyle wrote beside the maps. A
// checkout with no manifest serves no picker, which is right: there is then
// nothing to pick between.
func loadStyleCards() error {
	path := filepath.Join(styledMapDir(), "styles.json")
	b, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return fmt.Errorf("read %v: %w", path, err)
	}
	if err := json.Unmarshal(b, &styleCards); err != nil {
		return fmt.Errorf("parse %v: %w", path, err)
	}
	return nil
}

// handleStyles serves /styles: the named styles a map can be asked for.
func handleStyles(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, styleCards)
}

// styledMapDir can be pointed elsewhere with VARIANTS1901, which is what a
// run from another working directory needs.
func styledMapDir() string {
	if p := os.Getenv("VARIANTS1901"); p != "" {
		return p
	}
	return "variants1901"
}

// loadStyledMaps reads every variants1901/*/map-<style>.svg into memory.
//
// The directory name is the Go package's, which is not always the URL key —
// "1900" is served from jdip1900/ — so each variant is matched by asking the
// registry for the key of the variant whose package lives there. A directory
// that matches nothing is skipped and named, since it can only be a leftover.
func loadStyledMaps() error {
	dir := styledMapDir()
	entries, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return fmt.Errorf("read %v: %w", dir, err)
	}
	loaded := make([]string, 0, len(entries))
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		files, err := filepath.Glob(filepath.Join(dir, entry.Name(), "map-*.svg"))
		if err != nil {
			return fmt.Errorf("glob %v: %w", entry.Name(), err)
		}
		if len(files) == 0 {
			continue
		}
		key, found := keyForPackageDir(entry.Name())
		if !found {
			log.Printf("styled map: %v matches no served variant, skipped", entry.Name())
			continue
		}
		names := make([]string, 0, len(files))
		for _, path := range files {
			style := strings.TrimSuffix(strings.TrimPrefix(filepath.Base(path), "map-"), ".svg")
			b, err := os.ReadFile(path)
			if err != nil {
				return fmt.Errorf("read %v: %w", path, err)
			}
			if styledMaps[key] == nil {
				styledMaps[key] = map[string][]byte{}
			}
			styledMaps[key][style] = b
			names = append(names, fmt.Sprintf("%v %dKB", style, len(b)/1024))
		}
		sort.Strings(names)
		loaded = append(loaded, fmt.Sprintf("%v [%v]", key, strings.Join(names, ", ")))
	}
	sort.Strings(loaded)
	if len(loaded) > 0 {
		log.Printf("styled maps: %v", strings.Join(loaded, "; "))
	}
	return nil
}

// keyForPackageDir resolves a variants1901 directory name to the URL key the
// variant is served under. The directory holds a package whose variant name
// the registry knows; "sailho" is served as "sailho", "jdip1900" as "1900".
func keyForPackageDir(dir string) (string, bool) {
	for _, v := range localVariants {
		key := variantKey(v.Name)
		if key == dir {
			return key, true
		}
		// "jdip1900" holds the variant served as "1900": a Go package name
		// may not start with a digit, so the directory carries a prefix.
		if strings.HasSuffix(dir, key) {
			return key, true
		}
	}
	return "", false
}

// variantMapBytes returns the art to serve for one variant: the map in the
// style asked for, in the default style when none is asked for, and the
// variant's own file when there is no styled art at all.
//
// ?style=original always answers with the unrestyled file. A style nobody has
// drawn this variant in answers errUnknownStyle, which both routes turn into
// a 404. Both routes that serve map art go through here —
// /variants/{key}/map.svg for the gallery and the tooling,
// /game/{id}/map.svg for a board — so the two can never disagree about which
// map a variant has.
func variantMapBytes(key string, v common.Variant, r *http.Request) ([]byte, error) {
	style := r.URL.Query().Get("style")
	if style == "original" {
		return v.SVGMap()
	}
	drawn := styledMaps[key]
	if style == "" {
		if b, ok := drawn[defaultMapStyle]; ok {
			return b, nil
		}
		return v.SVGMap()
	}
	if b, ok := drawn[style]; ok {
		return b, nil
	}
	return nil, fmt.Errorf("%q: %w", style, errUnknownStyle)
}

// handleVariantMap serves /variants/{key}/map.svg.
func handleVariantMap(w http.ResponseWriter, r *http.Request) {
	rest := strings.TrimPrefix(r.URL.Path, "/variants/")
	key, sub, _ := strings.Cut(rest, "/")
	if sub != "map.svg" {
		http.NotFound(w, r)
		return
	}
	v, found := lookupVariant(key)
	if !found || v.SVGMap == nil {
		http.NotFound(w, r)
		return
	}
	b, err := variantMapBytes(key, v, r)
	if errors.Is(err, errUnknownStyle) {
		http.NotFound(w, r)
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "svg map: %v", err)
		return
	}
	w.Header().Set("Content-Type", "image/svg+xml")
	w.Write(b)
}

// variantRefJSON identifies the variant a game is played on.
type variantRefJSON struct {
	Key       string `json:"key"`
	Name      string `json:"name"`
	Supported bool   `json:"supported"`
}

func (self *game) variantRef() variantRefJSON {
	return variantRefJSON{
		Key:       self.variantKey,
		Name:      self.variant.Name,
		Supported: supportedVariants[self.variantKey],
	}
}

// provinceNames is the abbreviation-to-long-name table for this variant.
// The frontend labels the board from it.
func (self *game) provinceNames() map[string]string {
	out := map[string]string{}
	for prov, name := range self.variant.ProvinceLongNames {
		out[string(prov)] = name
	}
	return out
}

// sortedNations returns the variant's powers in a stable order.
func sortedNations(v common.Variant) []godip.Nation {
	out := make([]godip.Nation, len(v.Nations))
	copy(out, v.Nations)
	sort.Slice(out, func(i, j int) bool { return out[i] < out[j] })
	return out
}
