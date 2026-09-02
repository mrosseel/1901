package variant

// TestMain loads the variants the server ships, so the suite runs against the
// same registry a running server holds. Without it classical, sailho and 1900
// would simply not exist during tests, and anything that looks them up would
// fail for the wrong reason.
//
// The loader finds the directory relative to the working directory, which is
// the top of the repository when the server runs and this package's directory
// when a test runs. Naming it here is what closes the gap.

import (
	"log"
	"os"
	"path/filepath"
	"testing"
)

func TestMain(m *testing.M) {
	if err := os.Setenv("GENERATED_VARIANTS", filepath.Join(repoRoot(), "variants", "generated")); err != nil {
		log.Fatalf("naming the generated variants: %v", err)
	}
	if err := LoadGenerated(); err != nil {
		log.Fatalf("load generated variants: %v", err)
	}
	if err := LoadStyles(); err != nil {
		log.Fatalf("load map styles: %v", err)
	}
	os.Exit(m.Run())
}
