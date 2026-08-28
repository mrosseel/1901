// The variant registry: godip's variants exposed by a URL-safe key, with
// the metadata the create-game gallery needs.
//
// Only classical is supported (D-014). The rest are playable but their
// map placement anchors are unverified, so they are marked experimental.
package main

import (
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

// styledMaps holds the restyled art for the variants that have any, by key.
//
// A converted jDip map is correct and unlovely: flat blue water, flat yellow
// land, a black backdrop. tools/restyle reads godip's classical parchment
// style off classical's own map and writes the result beside the original as
// map-styled.svg (D-016). The restyle touches fills, strokes and text
// presentation only — the province shapes, their ids, the #provinces layer
// and the #province-centers anchors are all byte-identical, which the tool
// checks and refuses to write without.
//
// So the styled file is the one served by default: it is the same map, drawn
// better. The original stays reachable at ?style=original, because a faithful
// copy of the source art is worth being able to look at when a conversion is
// in question.
var styledMaps = map[string][]byte{}

// styledMapDir can be pointed elsewhere with VARIANTS1901, which is what a
// run from another working directory needs.
func styledMapDir() string {
	if p := os.Getenv("VARIANTS1901"); p != "" {
		return p
	}
	return "variants1901"
}

// loadStyledMaps reads every variants1901/*/map-styled.svg into memory.
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
		path := filepath.Join(dir, entry.Name(), "map-styled.svg")
		b, err := os.ReadFile(path)
		if err != nil {
			if os.IsNotExist(err) {
				continue
			}
			return fmt.Errorf("read %v: %w", path, err)
		}
		key, found := keyForPackageDir(entry.Name())
		if !found {
			log.Printf("styled map: %v matches no served variant, skipped", path)
			continue
		}
		styledMaps[key] = b
		loaded = append(loaded, fmt.Sprintf("%v (%d KB)", key, len(b)/1024))
	}
	sort.Strings(loaded)
	if len(loaded) > 0 {
		log.Printf("styled maps: %v", strings.Join(loaded, ", "))
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

// variantMapBytes returns the art to serve for one variant: the restyled map
// where there is one, the variant's own otherwise.
//
// ?style=original always answers with the unrestyled file. Both routes that
// serve map art go through here — /variants/{key}/map.svg for the gallery and
// the tooling, /game/{id}/map.svg for a board — so the two can never disagree
// about which map a variant has.
func variantMapBytes(key string, v common.Variant, r *http.Request) ([]byte, error) {
	if styled, ok := styledMaps[key]; ok && r.URL.Query().Get("style") != "original" {
		return styled, nil
	}
	return v.SVGMap()
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
