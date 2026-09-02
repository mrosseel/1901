/*
Package assets is where the server reads its own files (ADR-051).

Two directories are not code and are not the database:

	web/dist              the vite build              SPADIR
	variants/generated    descriptors, art, tables    GENERATED_VARIANTS

A third, placements, was here until ADR-051 moved map authoring to dipmap. A
variant's table travels with its art now, so nothing looked in that directory
any more and it went with the tools that wrote it.

A development build reads both from the working directory, so a frontend
change needs a reload and not a recompile. A release build is compiled with
`-tags standalone` and carries them inside the binary, because the thing a game
master downloads has to run in a room with no toolchain and no internet
(ADR-006, ADR-018). The two halves live beside the files themselves, in the
web and variants packages; everything here reads an fs.FS and cannot tell
which one it got.

The environment variables win in both builds. That is what lets a test point at
a temporary directory, and what lets a packaged install be handed its own
files.
*/
package assets

import (
	"io/fs"
	"os"
	"path"
	"path/filepath"

	"spring1901/spike/variants"
	"spring1901/spike/web"
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

// GeneratedDir is where the generated variants live. The environment variable
// exists so a test can point at a temporary directory.
func GeneratedDir() string {
	if p := os.Getenv("GENERATED_VARIANTS"); p != "" {
		return p
	}
	return filepath.Join("variants", "generated")
}

// GeneratedPath names a file for an error message. The reader has a path
// relative to the root of one filesystem; a person wants the path they would
// type, and it is the same layout in the binary as on the disk.
func GeneratedPath(rel string) string {
	return path.Join(GeneratedDir(), rel)
}

// SPA is the built frontend: the directory an operator named, else the copy
// this build carries, else the working directory.
func SPA() fs.FS {
	if fsys, set := envDirFS("SPADIR"); set {
		return fsys
	}
	if fsys, ok := web.Dist(); ok {
		return fsys
	}
	return os.DirFS(spaDirPath())
}

// GeneratedFS is the variant directory, chosen the same way.
func GeneratedFS() fs.FS {
	if fsys, set := envDirFS("GENERATED_VARIANTS"); set {
		return fsys
	}
	if fsys, ok := variants.Generated(); ok {
		return fsys
	}
	return os.DirFS(GeneratedDir())
}

// SPASource is what the start-up line says the app is being served from.
func SPASource() string {
	if p := os.Getenv("SPADIR"); p != "" {
		return AbsPath(p)
	}
	if _, ok := web.Dist(); ok {
		return "the binary"
	}
	return AbsPath(spaDirPath())
}

// AbsPath resolves a path against the working directory, leaving it as
// given when that fails. What a start-up line prints has to be a path the
// operator can act on.
func AbsPath(path string) string {
	if abs, err := filepath.Abs(path); err == nil {
		return abs
	}
	return path
}

// envDirFS returns the directory named by the variable, and false when the
// variable is unset. An operator who sets one means it, so it is consulted
// before anything this build carries.
func envDirFS(name string) (fs.FS, bool) {
	p := os.Getenv(name)
	if p == "" {
		return nil, false
	}
	return os.DirFS(p), true
}

// IsFileIn reports whether name is a regular file in fsys.
func IsFileIn(fsys fs.FS, name string) bool {
	info, err := fs.Stat(fsys, name)
	return err == nil && info.Mode().IsRegular()
}
