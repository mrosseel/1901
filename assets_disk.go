//go:build !standalone

// The two asset directories, read from the working directory.
//
// This is the file a development build compiles: `npm run build` writes
// web/dist and the running server picks it up, and a corrected placement
// table is one restart away. assets_embed.go is the other half, and it is
// what a release carries (ADR-051).
package main

import (
	"io/fs"
	"os"
)

func spaFS() fs.FS       { return os.DirFS(spaDirPath()) }
func generatedFS() fs.FS { return os.DirFS(generatedDir()) }

// spaSource is what the start-up line says the app is being served from.
func spaSource() string { return absPath(spaDirPath()) }
