package main

// A style plan is measurements taken from one exact picture, and it names that
// picture's SHA-256. When the art changes, the fills the plan points at may
// paint something else, so a stale plan is refused and the map is served in
// its own colours instead. That refusal is silent by design — the board still
// draws — which is exactly why it needs a test.
//
// Run with REPIN_PLANS=1 to write the current art's digest back into every
// plan, after a change that alters the bytes of a map on purpose.

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

func TestEveryStylePlanMatchesTheArtItWasMeasuredOn(t *testing.T) {
	if err := loadPlans(); err != nil {
		t.Fatalf("loadPlans: %v", err)
	}
	withGeneratedDir(t, filepath.Join("variants", "generated"))
	if err := loadGeneratedVariants(); err != nil {
		t.Fatalf("loading the variants: %v", err)
	}

	repin := os.Getenv("REPIN_PLANS") != ""
	stale := []string{}

	for key, gen := range generatedVariants {
		plan, found := plans[key]
		if !found {
			t.Errorf("%v has no style plan, so its map is served unstyled", key)
			continue
		}
		art, err := gen.Variant.SVGMap()
		if err != nil {
			t.Fatalf("%v: reading art: %v", key, err)
		}
		sum := fmt.Sprintf("%x", sha256.Sum256(art))
		if sum == plan.Map.SHA256 && len(art) == plan.Map.Bytes {
			continue
		}
		if !repin {
			stale = append(stale, key)
			continue
		}
		if err := repinPlan(key, len(art), sum); err != nil {
			t.Fatalf("%v: %v", key, err)
		}
	}

	sort.Strings(stale)
	if len(stale) > 0 {
		t.Errorf("these maps are served in godip's own colours because their "+
			"plans were measured on other art: %v\n"+
			"re-run with REPIN_PLANS=1 if the art changed on purpose", stale)
	}
}

// repinPlan rewrites one plan's art digest and nothing else.
//
// It edits the two lines rather than re-encoding the file. A plan is a few
// hundred lines of measurements written by a browser, and re-encoding it here
// would reorder and reindent all of them, burying the two values that changed.
func repinPlan(key string, size int, sum string) error {
	path := filepath.Join("styleplans", key+".json")
	raw, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	lines := strings.Split(string(raw), "\n")
	replaced := 0
	for i, line := range lines {
		indent := line[:len(line)-len(strings.TrimLeft(line, " \t"))]
		switch {
		case strings.HasPrefix(strings.TrimSpace(line), `"bytes":`):
			lines[i] = fmt.Sprintf(`%s"bytes": %d,`, indent, size)
			replaced++
		case strings.HasPrefix(strings.TrimSpace(line), `"sha256":`):
			lines[i] = fmt.Sprintf(`%s"sha256": %q,`, indent, sum)
			replaced++
		}
	}
	if replaced != 2 {
		return fmt.Errorf("%v: expected one bytes and one sha256 line, found %d",
			path, replaced)
	}
	out := []byte(strings.Join(lines, "\n"))
	var check stylePlan
	if err := json.Unmarshal(out, &check); err != nil {
		return fmt.Errorf("%v: the edit did not leave valid JSON: %w", path, err)
	}
	return os.WriteFile(path, out, 0o644)
}
