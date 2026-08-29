// The variant registry: every variant this server can play, by URL-safe key,
// with the metadata the create-game gallery needs.
//
// Two sources feed it. godip ships its own variants as a Go library. Everything
// else is a descriptor under variants/generated, read at startup (generated.go).
//
// Only classical is supported (D-014). The rest are playable but their
// map placement anchors are unverified, so they are marked experimental.
package main

import (
	"crypto/sha256"
	"errors"
	"fmt"
	"log"
	"net/http"
	"sort"
	"strings"
	"sync"

	"github.com/zond/godip"
	"github.com/zond/godip/variants"
	"github.com/zond/godip/variants/common"
)

// compiledVariants is godip's own variants, which arrive as a library.
//
// 1901's own translated variants used to sit beside them as Go packages. They
// are descriptors now, under variants/generated, so this list is godip's and
// nothing else.
func compiledVariants() []common.Variant {
	out := make([]common.Variant, 0, len(variants.OrderedVariants))
	out = append(out, variants.OrderedVariants...)
	return out
}

// allVariants is every variant this server can play: the compiled ones and any
// loaded from disk at startup (generated.go).
func allVariants() []common.Variant {
	generated := generatedVariantList()
	out := make([]common.Variant, 0, len(compiledVariants())+len(generated))
	out = append(out, compiledVariants()...)
	out = append(out, generated...)
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
	byKeyMu sync.Mutex
	byKey   map[string]common.Variant
)

// rebuildVariantIndex rebuilds the key index from scratch.
//
// It has to be a rebuild rather than a one-time build: generated variants
// arrive from disk after the process starts, and an index built before they
// load would never contain them. A game saved on one would then fail to load
// with "unknown variant".
func rebuildVariantIndex() {
	byKeyMu.Lock()
	defer byKeyMu.Unlock()
	index := map[string]common.Variant{}
	for _, v := range allVariants() {
		index[variantKey(v.Name)] = v
	}
	byKey = index
}

// lookupVariant resolves a key to its godip variant.
func lookupVariant(key string) (common.Variant, bool) {
	byKeyMu.Lock()
	if byKey == nil {
		byKeyMu.Unlock()
		rebuildVariantIndex()
		byKeyMu.Lock()
	}
	v, found := byKey[key]
	byKeyMu.Unlock()
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

// STYLED MAP SERVING (D-023, D-024, D-026)
//
// A converted jDip map is correct and unlovely: flat blue water, flat yellow
// land, a black backdrop. godip's own maps are handsome but come in one
// palette. A named style — the styles are data, one JSON file each in
// mapstyles/ — puts either into another one. A restyle touches fills, strokes
// and text presentation only: the province shapes, their ids, the #provinces
// layer and the #province-centers anchors come through byte-identical, which
// restyle_test.go checks.
//
// So a styled map is what is served by default, in defaultMapStyle: the same
// map, drawn better. The original stays reachable at ?style=original, because
// a faithful copy of the source art is worth being able to look at when a
// conversion is in question.
//
// The styled art used to be generated ahead of time and checked in — every
// map in every style, 156 MB of SVG that a clone had to carry. It is now
// composed here, on demand, out of three things: the original art, the style
// plan the browser tool measured from it (styleplans/<key>.json), and the
// style's own tokens. Both are embedded in the binary; the composition is
// string substitution and takes milliseconds. See restyle.go and D-026.

// defaultMapStyle is the style a map is served in when nobody asks for one.
const defaultMapStyle = "parchment"

// errUnknownStyle is what a request for a style this variant has no art in
// answers with. It is a 404 rather than a fallback to the default, because a
// silent fallback would let a typo in a saved preference look like a style.
var errUnknownStyle = errors.New("unknown style")

// handleStyles serves /styles: the named styles a map can be asked for.
func handleStyles(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, styleCards())
}

// styledArt is the composed styled maps, keyed by variant key and style name.
//
// Composition is deterministic and the inputs never change while the process
// runs, so a map is composed once and then only ever read. The cache is
// unbounded on purpose: it can hold at most one entry per variant per style,
// and it only fills with what someone actually asked to look at.
var styledArt = struct {
	mu sync.RWMutex
	by map[string][]byte
}{by: map[string][]byte{}}

// stalePlans names the maps whose art no longer matches the plan measured
// from it, so the warning is logged once rather than per request.
var stalePlans = struct {
	mu sync.Mutex
	by map[string]bool
}{by: map[string]bool{}}

// styledMapBytes composes one variant's map in one style, or reports that it
// cannot be styled.
//
// A plan is keyed to the art it was measured on by SHA-256. When a godip
// upgrade redraws a map, the plan is stale — the fill values it names may
// paint something else now — and the map is served in its own colours rather
// than styled from measurements of a picture that no longer exists. That is
// the same treatment a map with no plan at all gets, because it is the same
// situation: nothing here knows how to style this map.
func styledMapBytes(key string, v common.Variant, style string) ([]byte, error) {
	plan, found := plans[key]
	if !found || !plan.styleable() {
		return nil, fmt.Errorf("%q: %w", style, errUnknownStyle)
	}
	tokens, found := styles[style]
	if !found {
		return nil, fmt.Errorf("%q: %w", style, errUnknownStyle)
	}
	cacheKey := key + "/" + style

	styledArt.mu.RLock()
	cached, hit := styledArt.by[cacheKey]
	styledArt.mu.RUnlock()
	if hit {
		return cached, nil
	}

	original, err := v.SVGMap()
	if err != nil {
		return nil, err
	}
	sum := fmt.Sprintf("%x", sha256.Sum256(original))
	if sum != plan.Map.SHA256 {
		stalePlans.mu.Lock()
		if !stalePlans.by[key] {
			stalePlans.by[key] = true
			log.Printf("style plan: %v was measured on different art (%v, now %v) — "+
				"serving godip's own colours until tools/restyle/plans.ts is re-run",
				key, plan.Map.SHA256[:12], sum[:12])
		}
		stalePlans.mu.Unlock()
		return nil, fmt.Errorf("%q: %w", style, errUnknownStyle)
	}

	composed, err := applyStyle(string(original), plan, tokens)
	if err != nil {
		return nil, fmt.Errorf("style %v for %v: %w", style, key, err)
	}
	out := []byte(composed)
	styledArt.mu.Lock()
	// Another request may have composed the same map first; its bytes are
	// the same bytes, and keeping one of the two keeps the cache stable.
	if first, raced := styledArt.by[cacheKey]; raced {
		out = first
	} else {
		styledArt.by[cacheKey] = out
	}
	styledArt.mu.Unlock()
	return out, nil
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
	if style == "" {
		if b, err := styledMapBytes(key, v, defaultMapStyle); err == nil {
			return b, nil
		} else if !errors.Is(err, errUnknownStyle) {
			return nil, err
		}
		// A map with no plan, or one whose plan no longer matches the art, is
		// served as it was drawn. It is the right map; it is not restyled.
		return v.SVGMap()
	}
	return styledMapBytes(key, v, style)
}

// provinceJSON says what one province IS: the terrain a unit may stand on.
//
// It is published because the map tooling has to know, and the adjudicator is
// the only thing that does. A godip map paints its terrain as bare fill
// values with no class to read, so tools/restyle decides which colour is sea
// by asking here which provinces are sea and then looking at what the map
// paints under each one (D-024). Guessing from the tone would be a guess.
type provinceJSON struct {
	Key  string `json:"key"`
	Type string `json:"type"`
}

// variantProvinces lists every province of a variant with its terrain.
func variantProvinces(v common.Variant) ([]provinceJSON, error) {
	s, err := v.Start()
	if err != nil {
		return nil, err
	}
	graph := s.Graph()
	out := []provinceJSON{}
	for _, prov := range graph.Provinces() {
		flags := graph.Flags(prov)
		kind := "other"
		switch {
		case flags[godip.Sea] && flags[godip.Land]:
			// A coast: land a fleet may also sit on. It is painted as land.
			kind = "coast"
		case flags[godip.Sea]:
			kind = "sea"
		case flags[godip.Land]:
			kind = "land"
		}
		out = append(out, provinceJSON{Key: string(prov), Type: kind})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Key < out[j].Key })
	return out, nil
}

// handleVariantMap serves the four things a variant has that need no game:
// /variants/{key}/map.svg, /provinces.json, /placement.json and /names.json.
//
// The last two are what the map editor loads (D-030). It edits a variant, not
// a game, so everything it reads has to be reachable without one.
func handleVariantMap(w http.ResponseWriter, r *http.Request) {
	rest := strings.TrimPrefix(r.URL.Path, "/variants/")
	key, sub, _ := strings.Cut(rest, "/")
	switch sub {
	case "map.svg", "provinces.json", "placement.json", "names.json":
	default:
		http.NotFound(w, r)
		return
	}
	v, found := lookupVariant(key)
	if !found || v.SVGMap == nil {
		http.NotFound(w, r)
		return
	}
	if sub == "placement.json" {
		// nil is meaningful and serialises as null: no approved table, so the
		// editor starts from the map's own anchors.
		writeJSON(w, http.StatusOK, placementFor(key))
		return
	}
	if sub == "names.json" {
		writeJSON(w, http.StatusOK, namesFor(key))
		return
	}
	if sub == "provinces.json" {
		provinces, err := variantProvinces(v)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "provinces: %v", err)
			return
		}
		writeJSON(w, http.StatusOK, provinces)
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
// The frontend labels the board from it. It is godip's own table with the
// variant's name overrides layered on top (names.go, D-030), so a name
// corrected in the map editor reaches every board.
func (self *game) provinceNames() map[string]string {
	return namesFor(self.variantKey)
}

// sortedNations returns the variant's powers in a stable order.
func sortedNations(v common.Variant) []godip.Nation {
	out := make([]godip.Nation, len(v.Nations))
	copy(out, v.Nations)
	sort.Slice(out, func(i, j int) bool { return out[i] < out[j] })
	return out
}
