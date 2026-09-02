// Package mapstyles carries the named map styles into the binary.
//
// The styles are data, not code: a JSON file per style with its pattern and
// font assets beside it. They stay at the top of the repository because
// dipmap's style detector reads the same directory, so this file is the only
// Go in it — the embed, and nothing else. The reader is internal/mapstyle.
package mapstyles

import "embed"

// FS is the style directory as the build found it.
//
//go:embed *.json assets
var FS embed.FS
