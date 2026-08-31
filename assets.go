/*
Where the server reads its own files (ADR-051).

Three directories are not code and are not the database:

	web/dist              the vite build              SPADIR
	variants/generated    descriptors, art, tables    GENERATED_VARIANTS
	placements            the approved tables         PLACEMENTS

A development build reads all three from the working directory, so a frontend
change needs a reload and not a recompile. A release build is compiled with
`-tags standalone` and carries them inside the binary, because the thing a game
master downloads has to run in a room with no toolchain and no internet
(ADR-006, ADR-018). assets_disk.go and assets_embed.go are the two halves;
everything else here reads an fs.FS and cannot tell which one it got.

The environment variables win in both builds. That is what lets a test point at
a temporary directory, and what lets a packaged install be handed its own
files.
*/
package main

import (
	"io/fs"
	"os"
	"path"
	"path/filepath"
)

// spaDirPath is where the built frontend lives on disk. SPADIR overrides the
// default, so a packaged binary can point at the directory its installer
// chose.
func spaDirPath() string {
	if p := os.Getenv("SPADIR"); p != "" {
		return p
	}
	return filepath.Join("web", "dist")
}

// generatedDir is where the generated variants live. The environment variable
// exists so a test can point at a temporary directory.
func generatedDir() string {
	if p := os.Getenv("GENERATED_VARIANTS"); p != "" {
		return p
	}
	return filepath.Join("variants", "generated")
}

// placementDir can be pointed elsewhere with PLACEMENTS, which is what the
// tests and a run from another working directory need.
func placementDir() string {
	if p := os.Getenv("PLACEMENTS"); p != "" {
		return p
	}
	return "placements"
}

// generatedPath names a file for an error message. The reader has a path
// relative to the root of one filesystem; a person wants the path they would
// type, and it is the same layout in the binary as on the disk.
func generatedPath(rel string) string {
	return path.Join(generatedDir(), rel)
}

// envDirFS returns the directory named by the variable, and false when the
// variable is unset. An embedded build consults this first: an operator who
// sets the variable means it.
func envDirFS(name string) (fs.FS, bool) {
	p := os.Getenv(name)
	if p == "" {
		return nil, false
	}
	return os.DirFS(p), true
}

// isFileIn reports whether name is a regular file in fsys.
func isFileIn(fsys fs.FS, name string) bool {
	info, err := fs.Stat(fsys, name)
	return err == nil && info.Mode().IsRegular()
}
