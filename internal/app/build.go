/*
Which build of the client this server is serving (ADR-050).

A phone at a table has been on one page for forty minutes. A deploy replaces
the server under it, and the tab has no way to know: it is running the
JavaScript it was sent, against a server that may have moved on. Every state
answer carries this stamp so the client can say "this has been updated" rather
than fail at whatever it happens to touch first.

It stamps the CLIENT build, not the server binary, because that is the question
being asked. The vite build gives every asset a content hash and writes those
names into index.html, so hashing index.html changes exactly when the
JavaScript a tab is running has changed — and stays put when only the server
did. A server-only change leaves every open tab correct, and should not ask
anybody to reload.
*/
package app

import (
	"crypto/sha256"
	"encoding/base64"
	"io/fs"
	"strconv"
	"sync"
	"time"
)

var (
	buildOnce  sync.Once
	buildValue string
)

// buildStamp is read once. The shell cannot change under a running process:
// the frontend is inside the binary in a release build and a directory nobody
// rebuilds mid-run in development.
func buildStamp() string {
	buildOnce.Do(func() { buildValue = readBuildStamp(spaFS()) })
	return buildValue
}

func readBuildStamp(fsys fs.FS) string {
	shell, err := fs.ReadFile(fsys, "index.html")
	if err != nil {
		// No shell to hash — a server run without a frontend build. The
		// start time is a stamp that at least changes per restart, which
		// is the honest answer when nothing better is available.
		return "t" + strconv.FormatInt(time.Now().Unix(), 36)
	}
	sum := sha256.Sum256(shell)
	return base64.RawURLEncoding.EncodeToString(sum[:])[:12]
}
