package variant

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

// pointAtNotes writes a notes file, loads it, and puts the registry back.
// Every test here shares one process with the rest of the package, so a note
// left behind would decorate cards other tests read.
func pointAtNotes(t *testing.T, body string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "notes.json")
	if body != "" {
		if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
			t.Fatalf("write notes: %v", err)
		}
	}
	t.Setenv("VARIANT_NOTES", path)
	t.Cleanup(func() {
		notes = map[string]string{}
		resetCatalogue()
	})
	if err := LoadNotes(); err != nil {
		t.Fatalf("load notes: %v", err)
	}
}

// cards asks the catalogue endpoint the way the gallery does.
func cards(t *testing.T) []map[string]any {
	t.Helper()
	rec := httptest.NewRecorder()
	HandleVariants(rec, httptest.NewRequest(http.MethodGet, "/api/v1/variants", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /api/v1/variants: %v", rec.Code)
	}
	var out []map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode catalogue: %v", err)
	}
	if len(out) == 0 {
		t.Fatal("the catalogue is empty")
	}
	return out
}

func TestNotesReachTheCatalogue(t *testing.T) {
	pointAtNotes(t, `{"classical": "Placement checked.", "hundred": "   "}`)

	if got := Note("classical"); got != "Placement checked." {
		t.Errorf("Note(classical) = %q", got)
	}
	// A blank note is no note, so nothing downstream has to trim it again.
	if got := Note("hundred"); got != "" {
		t.Errorf("Note(hundred) = %q, want nothing", got)
	}

	seen := false
	for _, card := range cards(t) {
		if card["key"] != "classical" {
			// A card with nothing written about it carries no field at all,
			// so the frontend has one shape to read and not two.
			if _, has := card["note"]; has {
				t.Errorf("%v carries a note it was never given", card["key"])
			}
			continue
		}
		seen = true
		if card["note"] != "Placement checked." {
			t.Errorf("classical note = %v", card["note"])
		}
	}
	if !seen {
		t.Error("classical is not in the catalogue")
	}
}

// A checkout with no notes file is a working server. It says nothing about any
// board, which is what it said before notes existed.
func TestMissingNotesFileIsNotAnError(t *testing.T) {
	pointAtNotes(t, "")

	if got := Note("classical"); got != "" {
		t.Errorf("Note(classical) = %q, want nothing", got)
	}
	for _, card := range cards(t) {
		if _, has := card["note"]; has {
			t.Errorf("%v carries a note with no notes file", card["key"])
		}
	}
}

// The note travels with the variant a game names, beside the supported flag.
func TestRefCarriesTheNote(t *testing.T) {
	pointAtNotes(t, `{"classical": "Placement checked."}`)

	ref := Ref("classical", "Classical")
	if ref.Note != "Placement checked." {
		t.Errorf("ref note = %q", ref.Note)
	}
	if !ref.Supported {
		t.Error("the note replaced the supported flag rather than joining it")
	}
	if other := Ref("hundred", "Hundred"); other.Note != "" {
		t.Errorf("hundred ref note = %q, want nothing", other.Note)
	}
}

// The file this repository ships is the one the server reads, so a typo in it
// is a failing test rather than a wrong sentence on a card.
func TestShippedNotesParse(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join(repoRoot(), "variants", "notes.json"))
	if err != nil {
		t.Fatalf("read the shipped notes: %v", err)
	}
	read := map[string]string{}
	if err := json.Unmarshal(raw, &read); err != nil {
		t.Fatalf("parse the shipped notes: %v", err)
	}
	for key := range read {
		if _, found := Lookup(key); !found {
			t.Errorf("notes.json writes about %q, which is not a variant", key)
		}
	}
}
