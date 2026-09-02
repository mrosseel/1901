// The variant registry: every variant this server can play, by URL-safe key,
// with the metadata the create-game gallery needs.
//
// One source feeds it. Every variant is a descriptor under variants/generated,
// read at startup (generated.go) — godip's own maps included, converted once by
// tools/variant-export and held against their Go packages by
// variants_equivalence_test.go. godip remains the adjudicator and the source of
// the rule profiles a descriptor names; it is no longer a second way for a
// board to reach a game.
//
// Only classical is supported (ADR-014). The rest are playable but their
// map placement anchors are unverified, so they are marked experimental.
package variant

import (
	"crypto/sha256"
	"errors"
	"fmt"
	"log"
	"net/http"
	"sort"
	"strings"
	"sync"

	"spring1901/spike/internal/httpx"

	"github.com/zond/godip"
	"github.com/zond/godip/variants/common"
)

// All is every variant this server can play, all of them loaded from
// disk at startup (generated.go).
func All() []common.Variant {
	return generatedVariantList()
}

// DefaultKey is what a game gets when none is named.
const DefaultKey = "classical"

// Supported are the ones whose board art is verified (ADR-014).
var Supported = map[string]bool{DefaultKey: true}

// Key turns a godip variant name into a URL-safe key:
// "Ancient Mediterranean" becomes "ancientmediterranean".
func Key(name string) string {
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

// rebuildIndex rebuilds the key index from scratch.
//
// It has to be a rebuild rather than a one-time build: generated variants
// arrive from disk after the process starts, and an index built before they
// load would never contain them. A game saved on one would then fail to load
// with "unknown variant".
func rebuildIndex() {
	byKeyMu.Lock()
	defer byKeyMu.Unlock()
	index := map[string]common.Variant{}
	for _, v := range All() {
		index[Key(v.Name)] = v
	}
	byKey = index
}

// Lookup resolves a key to its godip variant.
func Lookup(key string) (common.Variant, bool) {
	byKeyMu.Lock()
	if byKey == nil {
		byKeyMu.Unlock()
		rebuildIndex()
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
	Catalogue     []variantJSON
	catalogueOnce sync.Once
)

// variantCatalogue builds the metadata list once. It starts each variant
// and reads its map, so it is deliberately lazy: the cost lands on the
// first request for the gallery, not on every server start.
func variantCatalogue() []variantJSON {
	catalogueOnce.Do(func() {
		for _, v := range All() {
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
			key := Key(v.Name)
			card := variantJSON{
				Key:          key,
				Name:         v.Name,
				PowerCount:   len(v.Nations),
				TotalSCCount: len(s.Graph().AllSCs()),
				StartYear:    s.Phase().Year(),
				Description:  v.Description,
				Rules:        v.Rules,
				CreatedBy:    v.CreatedBy,
				Supported:    Supported[key],
				MapURL:       "/variants/" + key + "/map.svg",
			}
			for _, n := range v.Nations {
				card.Powers = append(card.Powers, string(n))
			}
			if v.SoloSCCount != nil {
				card.SoloSCCount = v.SoloSCCount(s)
			}
			Catalogue = append(Catalogue, card)
		}
		sort.Slice(Catalogue, func(i, j int) bool {
			// Supported first, then alphabetical.
			if Catalogue[i].Supported != Catalogue[j].Supported {
				return Catalogue[i].Supported
			}
			return Catalogue[i].Name < Catalogue[j].Name
		})
	})
	return Catalogue
}

func HandleVariants(w http.ResponseWriter, r *http.Request) {
	httpx.WriteJSON(w, http.StatusOK, variantCatalogue())
}

// STYLED MAP SERVING (ADR-033, ADR-024, ADR-026)
//
// A converted jDip map is correct and unlovely: flat blue water, flat yellow
// land, a black backdrop. godip's own maps are handsome but come in one
// palette. A named style — the styles are data, one JSON file each in
// mapstyles/ — puts either into another one. A restyle touches fills, strokes
// and text presentation only: the province shapes, their ids, the #provinces
// layer and the #province-centers anchors come through byte-identical, which
// restyle_test.go checks.
//
// So a styled map is what is served by default, in the default style: the same
// map, drawn better. The original stays reachable at ?style=original, because
// a faithful copy of the source art is worth being able to look at when a
// conversion is in question.
//
// The styled art used to be generated ahead of time and checked in — every
// map in every style, 156 MB of SVG that a clone had to carry. It is now
// composed here, on demand, out of three things: the original art, the style
// plan the browser tool measured from it (styleplans/<key>.json), and the
// style's own tokens. Both are embedded in the binary; the composition is
// string substitution and takes milliseconds. See restyle.go and ADR-026.

// ErrUnknownStyle is what a request for a style this variant has no art in
// answers with. It is a 404 rather than a fallback to the default, because a
// silent fallback would let a typo in a saved preference look like a style.
var ErrUnknownStyle = errors.New("unknown style")

// HandleStyles serves /styles: the named styles a map can be asked for.
func HandleStyles(w http.ResponseWriter, r *http.Request) {
	httpx.WriteJSON(w, http.StatusOK, styleCards())
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

// SupplyCentreKeys names every province that is a supply centre, from the
// variant's own graph, which is the only place that knows: a converted jDip
// map carries no mark of one (ADR-032). A variant with no graph reports none,
// so a map that would have been styled still is.
func SupplyCentreKeys(v common.Variant) []string {
	if v.Graph == nil {
		return nil
	}
	graph := v.Graph()
	if graph == nil {
		return nil
	}
	out := []string{}
	for _, province := range graph.AllSCs() {
		out = append(out, string(province))
	}
	return out
}

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
		return nil, fmt.Errorf("%q: %w", style, ErrUnknownStyle)
	}
	tokens, found := styles[style]
	if !found {
		return nil, fmt.Errorf("%q: %w", style, ErrUnknownStyle)
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
				"serving godip's own colours until dipmap writes it a plan",
				key, plan.Map.SHA256[:12], sum[:12])
		}
		stalePlans.mu.Unlock()
		return nil, fmt.Errorf("%q: %w", style, ErrUnknownStyle)
	}

	composed, err := applyStyle(string(original), plan, tokens, SupplyCentreKeys(v))
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
// drawn this variant in answers ErrUnknownStyle, which both routes turn into
// a 404. Both routes that serve map art go through here —
// /variants/{key}/map.svg for the gallery and the tooling,
// /game/{id}/map.svg for a board — so the two can never disagree about which
// map a variant has.
func variantMapBytes(key string, v common.Variant, r *http.Request) ([]byte, error) {
	b, _, err := variantMapArt(key, v, r)
	return b, err
}

// variantMapArt is variantMapBytes and the name the answer is cached under.
//
// The name is what ServeMapArt keys the compressed copy by, so it has to say
// which art came back rather than which style was asked for: a request with no
// style that falls back to the unrestyled file must not be cached as the
// default style's.
func variantMapArt(key string, v common.Variant, r *http.Request) ([]byte, string, error) {
	original := func() ([]byte, string, error) {
		b, err := v.SVGMap()
		return b, key + "/original", err
	}
	style := r.URL.Query().Get("style")
	if style == "original" {
		return original()
	}
	if style == "" {
		if b, err := styledMapBytes(key, v, DefaultStyle); err == nil {
			return b, key + "/" + DefaultStyle, nil
		} else if !errors.Is(err, ErrUnknownStyle) {
			return nil, "", err
		}
		// A map with no plan, or one whose plan no longer matches the art, is
		// served as it was drawn. It is the right map; it is not restyled.
		return original()
	}
	b, err := styledMapBytes(key, v, style)
	return b, key + "/" + style, err
}

// compressedArt is the gzipped map art, keyed exactly as styledArt is.
//
// A map is compressed once per style and then only read. That is worth doing
// rather than compressing per request: classical's parchment SVG is 1.8 MB and
// takes 63 ms to deflate, which is longer than composing the styled map in the
// first place, and it would be spent again on every board load. Compressing
// once and keeping the 976 KB result costs a fraction of what the uncompressed
// copy beside it already costs.
//
// The default compression level is the right one here for the same reason.
// Level 1 would finish in 9 ms and produce 1055 KB; over a cached entry the
// 63 ms is paid once and the 79 KB is saved on every request after.
var compressedArt = struct {
	mu sync.RWMutex
	by map[string][]byte
}{by: map[string][]byte{}}

// ServeMapArt writes one variant's map art, compressed when the client offered
// gzip. Both routes that serve a board go through it.
func ServeMapArt(w http.ResponseWriter, r *http.Request, key string, v common.Variant) error {
	body, name, err := variantMapArt(key, v, r)
	if err != nil {
		return err
	}
	w.Header().Set("Content-Type", "image/svg+xml")
	w.Header().Set("Vary", "Accept-Encoding")
	if !httpx.AcceptsGzip(r) || len(body) < httpx.MinCompressBytes {
		w.Write(body)
		return nil
	}

	compressedArt.mu.RLock()
	packed, hit := compressedArt.by[name]
	compressedArt.mu.RUnlock()
	if !hit {
		packed = httpx.GzipBytes(body)
		compressedArt.mu.Lock()
		if first, raced := compressedArt.by[name]; raced {
			packed = first
		} else {
			compressedArt.by[name] = packed
		}
		compressedArt.mu.Unlock()
	}
	w.Header().Set("Content-Encoding", "gzip")
	w.Write(packed)
	return nil
}

// ProvinceJSON says what one province IS: the terrain a unit may stand on.
//
// It is published because the map tooling has to know, and the adjudicator is
// the only thing that does. A godip map paints its terrain as bare fill
// values with no class to read, so dipmap decides which colour is sea
// by asking here which provinces are sea and then looking at what the map
// paints under each one (ADR-024). Guessing from the tone would be a guess.
type ProvinceJSON struct {
	Key  string `json:"key"`
	Type string `json:"type"`
}

// Provinces lists every province of a variant with its terrain.
func Provinces(v common.Variant) ([]ProvinceJSON, error) {
	s, err := v.Start()
	if err != nil {
		return nil, err
	}
	graph := s.Graph()
	out := []ProvinceJSON{}
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
		out = append(out, ProvinceJSON{Key: string(prov), Type: kind})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Key < out[j].Key })
	return out, nil
}

// HandleVariantMap serves the three things a variant has that need no game:
// /variants/{key}/map.svg, /provinces.json and /placement.json.
//
// They describe a variant rather than a game, so they are reachable without
// one. dipmap reads them when it audits a map somebody else drew (ADR-051).
func HandleVariantMap(w http.ResponseWriter, r *http.Request) {
	rest := strings.TrimPrefix(r.URL.Path, "/variants/")
	key, sub, _ := strings.Cut(rest, "/")
	switch sub {
	case "map.svg", "provinces.json", "placement.json":
	default:
		http.NotFound(w, r)
		return
	}
	v, found := Lookup(key)
	if !found || v.SVGMap == nil {
		http.NotFound(w, r)
		return
	}
	if sub == "placement.json" {
		// nil is meaningful and serialises as null: no approved table, so the
		// editor starts from the map's own anchors.
		httpx.WriteJSON(w, http.StatusOK, PlacementFor(key))
		return
	}
	if sub == "provinces.json" {
		provinces, err := Provinces(v)
		if err != nil {
			httpx.WriteErr(w, http.StatusInternalServerError, "provinces: %v", err)
			return
		}
		httpx.WriteJSON(w, http.StatusOK, provinces)
		return
	}
	err := ServeMapArt(w, r, key, v)
	if errors.Is(err, ErrUnknownStyle) {
		http.NotFound(w, r)
		return
	}
	if err != nil {
		httpx.WriteErr(w, http.StatusInternalServerError, "svg map: %v", err)
	}
}

// RefJSON identifies the variant a game is played on.
type RefJSON struct {
	Key       string `json:"key"`
	Name      string `json:"name"`
	Supported bool   `json:"supported"`
}

// Ref identifies the variant a game is played on. The game knows its key and
// the name godip gave it; whether this server supports the variant is a fact
// about the registry.
func Ref(key, name string) RefJSON {
	return RefJSON{
		Key:       key,
		Name:      name,
		Supported: Supported[key],
	}
}

/*
ProvinceNames is the abbreviation-to-long-name table for this variant.

The frontend labels the board from it. It is godip's own table, which for a
generated variant is the one in variant.json — so a name corrected in dipmap
travels in the package and reaches every board.

An overrides file used to be layered on top, written by a map editor that
lived here. Both moved to dipmap on 2026-08-31, and the name now belongs to
the descriptor (MAP_FORMAT.md).
*/
func ProvinceNames(key string) map[string]string {
	names := map[string]string{}
	v, found := Lookup(key)
	if !found {
		return names
	}
	for prov, long := range v.ProvinceLongNames {
		names[string(prov)] = long
	}
	return names
}

// SortedNations returns the variant's powers in a stable order.
func SortedNations(v common.Variant) []godip.Nation {
	out := make([]godip.Nation, len(v.Nations))
	copy(out, v.Nations)
	sort.Slice(out, func(i, j int) bool { return out[i] < out[j] })
	return out
}
