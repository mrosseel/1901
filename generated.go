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
	"fmt"
	"log"
	"os"
	"path/filepath"
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

// generatedDir is where the variants live. The environment variable exists so
// a test can point at a temporary directory.
func generatedDir() string {
	if p := os.Getenv("GENERATED_VARIANTS"); p != "" {
		return p
	}
	return filepath.Join("variants", "generated")
}

// loadGeneratedVariants reads every subdirectory of the generated directory.
//
// A missing directory is not an error: a checkout with no generated maps is a
// working server. A malformed one IS an error worth failing on. Serving a
// variant whose descriptor half-parsed would mean games played on a board
// nobody described.
func loadGeneratedVariants() error {
	dir := generatedDir()
	entries, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return fmt.Errorf("read %v: %w", dir, err)
	}

	loaded := []string{}
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		key := entry.Name()
		if variantKey(key) != key {
			return fmt.Errorf(
				"generated variant directory %q is not a URL-safe key", key)
		}
		gen, err := loadGeneratedVariant(filepath.Join(dir, key), key)
		if err != nil {
			return err
		}
		generatedVariants[key] = gen
		loaded = append(loaded, fmt.Sprintf("%v (%d provinces, %v)",
			key, len(gen.Variant.Graph().Provinces()), gen.Hash[:12]))
	}

	// The index every game load consults must now include these.
	rebuildVariantIndex()

	sort.Strings(loaded)
	if len(loaded) > 0 {
		log.Printf("generated variants: %v", strings.Join(loaded, ", "))
	}
	return nil
}

// loadGeneratedVariant reads one variant directory.
func loadGeneratedVariant(dir, key string) (generatedVariant, error) {
	descriptorPath := filepath.Join(dir, "variant.json")
	raw, err := os.ReadFile(descriptorPath)
	if err != nil {
		return generatedVariant{}, fmt.Errorf("read %v: %w", descriptorPath, err)
	}

	var descriptor variantjson.Descriptor
	if err := json.Unmarshal(raw, &descriptor); err != nil {
		return generatedVariant{}, fmt.Errorf("parse %v: %w", descriptorPath, err)
	}
	// The directory name is the key a game stores, so the descriptor may not
	// disagree with it.
	if descriptor.Key != "" && descriptor.Key != key {
		return generatedVariant{}, fmt.Errorf(
			"%v: descriptor key %q does not match directory %q",
			descriptorPath, descriptor.Key, key)
	}

	variant, err := variantjson.Build(descriptor)
	if err != nil {
		return generatedVariant{}, fmt.Errorf("%v: %w", descriptorPath, err)
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

	svgPath := filepath.Join(dir, "map.svg")
	rawSVG, err := os.ReadFile(svgPath)
	if err != nil {
		return generatedVariant{}, fmt.Errorf("read %v: %w", svgPath, err)
	}
	sanitized, err := sanitizeSVG(rawSVG)
	if err != nil {
		return generatedVariant{}, fmt.Errorf("%v: %w", svgPath, err)
	}
	if sanitized.Dropped() {
		log.Printf("generated variant %v: removed unsafe svg %v",
			key, sanitized.Summary())
	}
	if err := requireBoardLayers(sanitized.Clean); err != nil {
		return generatedVariant{}, fmt.Errorf("%v: %w", svgPath, err)
	}
	if missingCenterAnchors(sanitized.Clean) {
		log.Printf("generated variant %v: art has no province-centers layer, so "+
			"markers fall back to the placement table alone", key)
	}

	art := sanitized.Clean
	variant.SVGMap = func() ([]byte, error) { return art, nil }
	variant.SVGVersion = "1"

	// Marker positions are optional, exactly as they are for a compiled
	// variant: without a table the board falls back to the map's own anchors.
	placementPath := filepath.Join(dir, "placements.json")
	if b, err := os.ReadFile(placementPath); err == nil {
		var table placementTable
		if err := json.Unmarshal(b, &table); err != nil {
			return generatedVariant{}, fmt.Errorf("parse %v: %w", placementPath, err)
		}
		for prov, spot := range table {
			if spot.Scale <= 0 {
				spot.Scale = 1
				table[prov] = spot
			}
		}
		placements[key] = table
	} else if !os.IsNotExist(err) {
		return generatedVariant{}, fmt.Errorf("read %v: %w", placementPath, err)
	}

	return generatedVariant{
		Key:     key,
		Variant: variant,
		SVG:     art,
		Hash:    variantjson.GameHash(descriptor),
	}, nil
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

// variantHash returns the descriptor hash for a generated variant, or "" for
// a compiled one. A compiled variant changes only when the binary does, so it
// needs no hash to detect drift.
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
		// A game created before this column existed, or on a compiled variant
		// that has since become generated. Nothing to compare against.
		return nil
	case current != recorded:
		return fmt.Errorf(
			"game %v started on generated variant %q at %v, but the descriptor "+
				"on disk is now %v; restore the original descriptor or archive "+
				"the game", gameID, key, recorded[:12], current[:12])
	}
	return nil
}
