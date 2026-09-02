package main

// TestMain boots the parts of startup that shape the variant registry, so the
// suite runs against the same set of variants the server serves.
//
// This matters since 1901's own variants became descriptors: without loading
// variants/generated, sailho and 1900 would simply not exist during tests, and
// anything that looks them up would fail for the wrong reason.

import (
	"log"
	"os"
	"testing"
)

func TestMain(m *testing.M) {
	if err := loadGeneratedVariants(); err != nil {
		log.Fatalf("load generated variants: %v", err)
	}
	os.Exit(m.Run())
}
