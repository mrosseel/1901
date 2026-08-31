// Generated variants: maps loaded from disk at startup rather than compiled in.
//
// Every other variant on this server is a Go package in a compile-time slice
// (see variants.go). That is the right shape for a curated set: 25 maps that
// arrive through code review. It is the wrong shape for a procedurally
// generated map, because a fresh map per game would mean a recompile per game.
//
// So this reads a directory instead. Each subdirectory is one variant:
//
//	variants/generated/<key>/variant.json     the province graph and start
//	variants/generated/<key>/map.svg          the board art
//	variants/generated/<key>/placements.json  marker positions, optional
//
// The art may instead be another variant's, named by the descriptor's `map`
// field. Five of godip's variants are played on the classical board and shipped
// five byte-identical copies of it. A reference is a key, never a path, and it
// is resolved here because this is the only place that knows which variants
// exist.
//
// Two things separate a file on disk from a package in the binary, and both
// are handled here rather than assumed away.
//
// The art is sanitised (svgsafe.go). Compiled art passed through code review;
// this did not, and SVG executes.
//
// The descriptor is hashed, and the hash is recorded on every game that uses
// it. A game replays its whole order history against the variant's starting
// position, so a descriptor edited under a running game would replay onto a
// different board. Rather than corrupt the game quietly, a changed descriptor
// makes that game refuse to load and says so.
package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"path"
	"slices"
	"sort"
	"strings"

	"github.com/zond/godip/variants/common"

	"spring1901/spike/variantjson"
)

// generatedVariant is one loaded descriptor with the art and identity that go
// with it.
type generatedVariant struct {
	Key     string
	Variant common.Variant
	SVG     []byte
	// Hash identifies the board a game is played on: provinces, borders,
	// opening position, win condition and rules. Renaming the variant or
	// reflowing its JSON leaves it unchanged.
	Hash string
}

// generatedVariants holds everything loaded at startup, by key. Written once
// before any request is served and read-only afterwards, like placements.
var generatedVariants = map[string]generatedVariant{}

// loadGeneratedVariants reads every subdirectory of the generated directory.
//
// A missing directory is not an error: a checkout with no generated maps is a
// working server. A malformed one IS an error worth failing on. Serving a
// variant whose descriptor half-parsed would mean games played on a board
// nobody described.
func loadGeneratedVariants() error {
	fsys := generatedFS()
	entries, err := fs.ReadDir(fsys, ".")
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil
		}
		return fmt.Errorf("read %v: %w", generatedDir(), err)
	}

	// Descriptors first, art second. A variant may be drawn on another
	// variant's art, and which variants exist is only known once every
	// directory has been read.
	pending := []pendingVariant{}
	drawnOn := map[string]string{}
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		key := entry.Name()
		if variantKey(key) != key {
			return fmt.Errorf(
				"generated variant directory %q is not a URL-safe key", key)
		}
		one, err := loadGeneratedVariant(fsys, key)
		if err != nil {
			return err
		}
		pending = append(pending, one)
		drawnOn[key] = one.drawnOn
	}

	loaded := []string{}
	art := map[string][]byte{}
	for _, one := range pending {
		owner, err := resolveArtKey(one.key, drawnOn)
		if err != nil {
			return err
		}
		if _, done := art[owner]; !done {
			b, err := loadVariantArt(fsys, owner)
			if err != nil {
				return err
			}
			art[owner] = b
		}
		drawn := art[owner]
		gen := one.gen
		gen.SVG = drawn
		gen.Variant.SVGMap = func() ([]byte, error) { return drawn, nil }
		generatedVariants[one.key] = gen

		where := ""
		if owner != one.key {
			where = ", drawn on " + owner
		}
		loaded = append(loaded, fmt.Sprintf("%v (%d provinces, %v%v)",
			one.key, len(gen.Variant.Graph().Provinces()), gen.Hash[:12], where))
	}

	// The index every game load consults must now include these.
	rebuildVariantIndex()

	sort.Strings(loaded)
	if len(loaded) > 0 {
		log.Printf("generated variants: %v", strings.Join(loaded, ", "))
	}
	return nil
}

// pendingVariant is a variant read from disk but not yet given its art,
// because the art may belong to a variant that has not been read yet.
type pendingVariant struct {
	key string
	gen generatedVariant
	// drawnOn is the key of the variant holding this one's art, or "" when
	// this directory holds its own.
	drawnOn string
}

// resolveArtKey follows a chain of map references to the variant that actually
// holds the art.
//
// Both ways a chain can fail are errors, never a fallback: a variant served
// with the wrong board, or with no board, is worse than a server that will not
// start and says which descriptor is wrong.
func resolveArtKey(key string, drawnOn map[string]string) (string, error) {
	seen := []string{key}
	at := key
	for {
		ref, loaded := drawnOn[at]
		if !loaded {
			return "", fmt.Errorf(
				"generated variant %v is drawn on %q, which is not a loaded variant "+
					"(chain: %v)", key, at, strings.Join(seen, " -> "))
		}
		if ref == "" {
			return at, nil
		}
		if slices.Contains(seen, ref) {
			return "", fmt.Errorf(
				"generated variant %v is drawn on itself through a cycle: %v",
				key, strings.Join(append(seen, ref), " -> "))
		}
		seen = append(seen, ref)
		at = ref
	}
}

// loadGeneratedVariant reads one variant directory, except its art.
func loadGeneratedVariant(fsys fs.FS, key string) (pendingVariant, error) {
	descriptorPath := generatedPath(path.Join(key, "variant.json"))
	raw, err := fs.ReadFile(fsys, path.Join(key, "variant.json"))
	if err != nil {
		return pendingVariant{}, fmt.Errorf("read %v: %w", descriptorPath, err)
	}

	var descriptor variantjson.Descriptor
	if err := json.Unmarshal(raw, &descriptor); err != nil {
		return pendingVariant{}, fmt.Errorf("parse %v: %w", descriptorPath, err)
	}
	// The directory name is the key a game stores, so the descriptor may not
	// disagree with it.
	if descriptor.Key != "" && descriptor.Key != key {
		return pendingVariant{}, fmt.Errorf(
			"%v: descriptor key %q does not match directory %q",
			descriptorPath, descriptor.Key, key)
	}
	// Validate refuses a map reference that is not a bare key, so by here the
	// value can only ever name a sibling directory. Checked again because this
	// is the function that joins it to a path.
	if descriptor.Map != "" && !variantjson.IsVariantKey(descriptor.Map) {
		return pendingVariant{}, fmt.Errorf(
			"%v: map %q is not a variant key", descriptorPath, descriptor.Map)
	}

	variant, err := variantjson.Build(descriptor)
	if err != nil {
		return pendingVariant{}, fmt.Errorf("%v: %w", descriptorPath, err)
	}
	// Legal but usually a mistake. Real variants do all of these on purpose,
	// so they are said out loud rather than refused.
	for _, warning := range variantjson.Warnings(descriptor) {
		log.Printf("generated variant %v: %v", key, warning)
	}
	// The gallery and every game look a variant up by the key derived from its
	// name, so the name has to produce this directory's key.
	if variantKey(variant.Name) != key {
		variant.Name = key
	}

	// SVGMap is attached once the art has been resolved, which cannot happen
	// until every descriptor has been read.
	variant.SVGVersion = "1"

	// Marker positions are optional, exactly as they are for a compiled
	// variant: without a table the board falls back to the map's own anchors.
	placementPath := generatedPath(path.Join(key, "placements.json"))
	if b, err := fs.ReadFile(fsys, path.Join(key, "placements.json")); err == nil {
		var table placementTable
		if err := json.Unmarshal(b, &table); err != nil {
			return pendingVariant{}, fmt.Errorf("parse %v: %w", placementPath, err)
		}
		for prov, spot := range table {
			if spot.Scale <= 0 {
				spot.Scale = 1
				table[prov] = spot
			}
		}
		placements[key] = table
	}

	/*
		The style plan, beside the art it describes (ADR-050 order, ADR-026).

		It used to live in a styleplans/ directory of its own, because the tool
		that wrote it lived in this repository and wrote there. dipmap writes the
		four files of a map together — variant.json, map.svg, placements.json,
		styleplan.json — so the plan travels with the art it measured, and a
		variant cannot arrive with a plan for a different map.

		Optional, like the placements: a map with no plan is served in its own
		colours.
	*/
	planPath := generatedPath(path.Join(key, "styleplan.json"))
	if b, err := fs.ReadFile(fsys, path.Join(key, "styleplan.json")); err == nil {
		plan := &stylePlan{}
		if err := json.Unmarshal(b, plan); err != nil {
			return pendingVariant{}, fmt.Errorf("parse %v: %w", planPath, err)
		}
		if !plan.versionSupported() {
			return pendingVariant{}, fmt.Errorf("%v is version %v, this server reads %v to %v",
				planPath, plan.Version, minPlanVersion, maxPlanVersion)
		}
		if plan.Key == "" {
			plan.Key = key
		}
		plans[plan.Key] = plan
	} else if !errors.Is(err, fs.ErrNotExist) {
		return pendingVariant{}, fmt.Errorf("read %v: %w", placementPath, err)
	}

	return pendingVariant{
		key:     key,
		drawnOn: descriptor.Map,
		gen: generatedVariant{
			Key:     key,
			Variant: variant,
			Hash:    variantjson.GameHash(descriptor),
		},
	}, nil
}

// loadVariantArt reads and sanitises one variant's map.svg.
//
// It is called once per picture, not once per variant: several variants may be
// drawn on the same art, and they must be served the same bytes rather than
// two sanitiser runs that happen to agree.
func loadVariantArt(fsys fs.FS, key string) ([]byte, error) {
	svgPath := generatedPath(path.Join(key, "map.svg"))
	rawSVG, err := fs.ReadFile(fsys, path.Join(key, "map.svg"))
	if err != nil {
		return nil, fmt.Errorf("read %v: %w", svgPath, err)
	}
	sanitized, err := sanitizeSVG(rawSVG)
	if err != nil {
		return nil, fmt.Errorf("%v: %w", svgPath, err)
	}
	if sanitized.Dropped() {
		log.Printf("generated variant %v: removed unsafe svg %v",
			key, sanitized.Summary())
	}
	if err := requireBoardLayers(sanitized.Clean); err != nil {
		return nil, fmt.Errorf("%v: %w", svgPath, err)
	}
	if missingCenterAnchors(sanitized.Clean) {
		log.Printf("generated variant %v: art has no province-centers layer, so "+
			"markers fall back to the placement table alone", key)
	}
	return sanitized.Clean, nil
}

// generatedVariantList returns the loaded variants in key order, for the
// registry to append to the compiled ones.
func generatedVariantList() []common.Variant {
	keys := make([]string, 0, len(generatedVariants))
	for key := range generatedVariants {
		keys = append(keys, key)
	}
	sort.Strings(keys)

	out := make([]common.Variant, 0, len(keys))
	for _, key := range keys {
		out = append(out, generatedVariants[key].Variant)
	}
	return out
}

// variantHash returns the descriptor hash for a loaded variant, or "" for a
// key nothing loaded.
func variantHash(key string) string {
	return generatedVariants[key].Hash
}

// checkVariantHash reports whether a game may still be loaded.
//
// A game records the hash of the variant it started under. If the descriptor
// on disk has changed since, replaying that game's orders would produce a
// board the players never saw, so it refuses rather than corrupts.
func checkVariantHash(gameID, key, recorded string) error {
	current := variantHash(key)
	switch {
	case current == "" && recorded == "":
		return nil
	case current == "" && recorded != "":
		return fmt.Errorf(
			"game %v started on generated variant %q, which is no longer loaded",
			gameID, key)
	case recorded == "":
		// A game created before this column existed, or on a variant that was
		// compiled when the game began and had no identity to record. Nothing
		// to compare against, and the board is the one it always was.
		return nil
	case current != recorded:
		return fmt.Errorf(
			"game %v started on generated variant %q at %v, but the descriptor "+
				"on disk is now %v; restore the original descriptor or archive "+
				"the game", gameID, key, recorded[:12], current[:12])
	}
	return nil
}
