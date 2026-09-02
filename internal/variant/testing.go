// Pointing the loader at another directory, for a test.
//
// This is exported, and it is not in a _test.go file, because the tests that
// need it are in more than one package: a saved game refusing a changed
// descriptor is a store rule, and it is checked where the games are.

package variant

// TB is the part of testing.TB this package needs. Naming it here rather than
// importing testing keeps the test package out of the server binary.
type TB interface {
	Helper()
	Setenv(key, value string)
	Cleanup(func())
}

// WithGeneratedDir points the loader at a directory and puts the registry
// back afterwards, so tests do not leak variants into each other.
func WithGeneratedDir(t TB, dir string) {
	t.Helper()
	t.Setenv("GENERATED_VARIANTS", dir)

	savedVariants := Generated
	savedPlacements := placements
	// The style plans load from the same directory and were the one global
	// this helper did not put back. A test that read testdata left demo7's
	// version-2 plan in the map for every test after it, and which tests
	// those were depended on the file names in this package.
	savedPlans := plans
	Generated = map[string]GeneratedVariant{}
	placements = map[string]PlacementTable{}
	plans = map[string]*stylePlan{}

	t.Cleanup(func() {
		Generated = savedVariants
		placements = savedPlacements
		plans = savedPlans
		// The key index caches whatever was loaded, so it has to follow.
		rebuildIndex()
	})
}

// Forget empties the generated registry and rebuilds the key index, so a test
// can boot the server from cold the way a fresh process does.
func Forget() {
	Generated = map[string]GeneratedVariant{}
	rebuildIndex()
}
