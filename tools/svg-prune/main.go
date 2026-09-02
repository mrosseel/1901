// svg-prune removes the unreachable definitions from map art, in place.
//
//	go run ./tools/svg-prune variants/generated/*/map.svg
//	go run ./tools/svg-prune --dir variants/generated
//
// It is the counterpart of tools/svg-round, and exists for the same reason:
// not every board in variants/generated comes from tools/variant-export, and
// art that is already checked in has to be pruned once without being
// re-exported. The pruning itself is svgprune.Art, the same function
// variant-export applies on its way out, so running it twice changes nothing
// the second time.
package main

import (
	"bytes"
	"flag"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"

	"spring1901/spike/internal/svgprune"
)

func main() {
	dir := flag.String("dir", "", "prune every <dir>/*/map.svg instead of named files")
	plans := flag.String("plans", "styleplans", "directory of style plans, whose ids are kept")
	flag.Parse()

	paths := flag.Args()
	if *dir != "" {
		found, err := filepath.Glob(filepath.Join(*dir, "*", "map.svg"))
		if err != nil {
			log.Fatal(err)
		}
		paths = append(paths, found...)
	}
	if len(paths) == 0 {
		log.Fatal("name at least one file, or pass --dir")
	}

	before, after := 0, 0
	for _, path := range paths {
		// The art of variant <key> lives in <key>/map.svg, and its plan under
		// the same key.
		key := filepath.Base(filepath.Dir(path))
		roots, err := svgprune.PlanRoots(filepath.Join(*plans, key+".json"))
		if err != nil {
			log.Fatalf("%v: %v", path, err)
		}
		was, is, dropped, err := prune(path, roots)
		if err != nil {
			log.Fatalf("%v: %v", path, err)
		}
		if len(dropped) > 0 {
			fmt.Printf("%v: %v\n", path, strings.Join(dropped, ", "))
		}
		before += was
		after += is
	}
	fmt.Printf("%d file(s): %d bytes -> %d bytes\n", len(paths), before, after)
}

func prune(path string, roots []string) (int, int, []string, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return 0, 0, nil, err
	}
	out, dropped := svgprune.Art(raw, roots)
	if !bytes.Equal(out, raw) {
		if err := os.WriteFile(path, out, 0o644); err != nil {
			return 0, 0, nil, err
		}
	}
	return len(raw), len(out), dropped, nil
}
