package app

// TestMain boots the parts of startup that shape the variant registry, so the
// suite runs against the same set of variants the server serves.
//
// This matters since 1901's own variants became descriptors: without loading
// variants/generated, sailho and 1900 would simply not exist during tests, and
// anything that looks them up would fail for the wrong reason.
//
// The server finds that directory relative to the working directory, which is
// the top of the repository when it runs and this package's directory when a
// test runs. Naming it here is what closes the gap.

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
	if err := loadGeneratedVariants(); err != nil {
		log.Fatalf("load generated variants: %v", err)
	}
	os.Exit(m.Run())
}
