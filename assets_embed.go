//go:build standalone

// The three asset directories, compiled into the binary (ADR-051).
//
// A release is built with `-tags standalone` and is one file: the game master
// downloads it, runs it, and seven phones join. Nothing here is reachable in a
// normal build, which is why web/dist may stay out of the repository and
// `go build ./...` still works on a fresh clone.
//
// An environment variable still wins. Whoever sets one is telling the server
// where the files are, and the copy in the binary is the fallback.
package main

import (
	"embed"
	"io/fs"
	"log"
	"os"
)

//go:embed all:web/dist
var webDistFiles embed.FS

//go:embed variants/generated
var generatedFiles embed.FS

//go:embed placements
var placementFiles embed.FS

func spaFS() fs.FS {
	if fsys, set := envDirFS("SPADIR"); set {
		return fsys
	}
	return under(webDistFiles, "web/dist")
}

func generatedFS() fs.FS {
	if fsys, set := envDirFS("GENERATED_VARIANTS"); set {
		return fsys
	}
	return under(generatedFiles, "variants/generated")
}

func placementFS() fs.FS {
	if fsys, set := envDirFS("PLACEMENTS"); set {
		return fsys
	}
	return under(placementFiles, "placements")
}

func spaSource() string {
	if p := os.Getenv("SPADIR"); p != "" {
		return absPath(p)
	}
	return "the binary"
}

// under strips the leading directory an embed keeps, so every reader sees the
// same root it sees on the disk. A failure here is a build that embedded the
// wrong path, not anything a run can recover from.
func under(fsys embed.FS, dir string) fs.FS {
	out, err := fs.Sub(fsys, dir)
	if err != nil {
		log.Fatalf("embedded %v: %v", dir, err)
	}
	return out
}
