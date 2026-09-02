// svg-round rewrites the geometry of map art to two decimals, in place.
//
//	go run ./tools/svg-round variants/generated/*/map.svg
//	go run ./tools/svg-round --dir variants/generated
//
// It exists because not every board in variants/generated comes from
// tools/variant-export: the converted jDip maps arrive by another road, and
// art that is already checked in has to be brought down to two decimals once
// without being re-exported. The rounding itself is svground.Art, the same
// function variant-export applies on its way out, so running this on a file
// that is already rounded rewrites the same bytes.
package main

import (
	"bytes"
	"flag"
	"fmt"
	"log"
	"os"
	"path/filepath"

	"spring1901/spike/internal/svground"
)

func main() {
	dir := flag.String("dir", "", "round every <dir>/*/map.svg instead of named files")
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
		was, is, err := round(path)
		if err != nil {
			log.Fatalf("%v: %v", path, err)
		}
		before += was
		after += is
	}
	fmt.Printf("%d file(s): %d bytes -> %d bytes\n", len(paths), before, after)
}

func round(path string) (int, int, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return 0, 0, err
	}
	out := svground.Art(raw)
	if !bytes.Equal(out, raw) {
		if err := os.WriteFile(path, out, 0o644); err != nil {
			return 0, 0, err
		}
	}
	return len(raw), len(out), nil
}
