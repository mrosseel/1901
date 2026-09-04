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

//go:embed notes.json
var notes []byte

// Notes returns the hand-kept review notes this build carries. They sit beside
// the generated directory rather than inside it, because a person writes them
// and the tool that writes the descriptors would overwrite anything it found
// there.
func Notes() ([]byte, bool) { return notes, true }
