package datc

// Where the repository's own files are, from inside a test.
//
// The server reads variants/generated and web/dist by the paths a person
// would type, relative to the top of the repository. A test binary runs in
// its own package directory instead, so a test that wants the real files has
// to say where they are. This is the one place that knows.

import (
	"path/filepath"
	"runtime"
	"testing"
)

// repoPath turns a path relative to the top of the repository into an
// absolute one. It is anchored to this file, so moving the package moves the
// anchor with it and nothing else has to be told.
func repoPath(t *testing.T, rel string) string {
	t.Helper()
	return filepath.Join(repoRoot(), rel)
}

// repoRoot is the top of the repository, found from this file's own location.
func repoRoot() string {
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		panic("no caller information: cannot find the repository root")
	}
	return filepath.Join(filepath.Dir(file), "..", "..")
}
