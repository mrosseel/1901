//go:build standalone

// Package variants carries the generated variant descriptors into the binary.
//
// A release is built with `-tags standalone` and is one file: the game master
// downloads it, runs it, and seven phones join (ADR-006, ADR-018). This is the
// half that holds the descriptors, the art and the placement tables; disk.go
// is the half a development build compiles. The reader is internal/assets.
package variants

import (
	"embed"
	"io/fs"
)

//go:embed generated
var files embed.FS

// Generated returns the embedded descriptors, and false in a build that
// carries none.
func Generated() (fs.FS, bool) {
	sub, err := fs.Sub(files, "generated")
	if err != nil {
		return nil, false
	}
	return sub, true
}
