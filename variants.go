// The variant registry: godip's variants exposed by a URL-safe key, with
// the metadata the create-game gallery needs.
//
// Only classical is supported (D-014). The rest are playable but their
// map placement anchors are unverified, so they are marked experimental.
package main

import (
	"net/http"
	"sort"
	"strings"
	"sync"

	"github.com/zond/godip"
	"github.com/zond/godip/variants"
	"github.com/zond/godip/variants/common"
)

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
		for _, v := range variants.OrderedVariants {
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
		for _, v := range variants.OrderedVariants {
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
	b, err := v.SVGMap()
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
