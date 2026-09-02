//go:build standalone

// Package web carries the built frontend into the binary.
//
// Nothing here is reachable in a normal build, which is why web/dist may stay
// out of the repository and `go build ./...` still works on a fresh clone.
// disk.go is the other half. The reader is internal/assets.
package web

import (
	"embed"
	"io/fs"
)

//go:embed all:dist
var files embed.FS

// Dist returns the embedded frontend, and false in a build that carries none.
func Dist() (fs.FS, bool) {
	sub, err := fs.Sub(files, "dist")
	if err != nil {
		return nil, false
	}
	return sub, true
}
