//go:build !standalone

// The built frontend, left on the disk.
//
// A development build reads web/dist from the working directory, so a
// frontend change needs a reload and not a recompile. embed.go is the other
// half, and it is what a release carries.
package web

import "io/fs"

// Dist reports that this build carries no frontend of its own.
func Dist() (fs.FS, bool) { return nil, false }
