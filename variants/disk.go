//go:build !standalone

// The generated variants, left on the disk.
//
// A development build reads them from the working directory, so a corrected
// placement table is one restart away rather than one recompile. embed.go is
// the other half, and it is what a release carries.
package variants

import "io/fs"

// Generated reports that this build carries no descriptors of its own.
func Generated() (fs.FS, bool) { return nil, false }
