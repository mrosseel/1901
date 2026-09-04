/*
The review note a person keeps about each variant.

`Supported` says one thing, in one bit, about one variant: classical's opening
position was checked (ADR-014). Every other board is silent, and silence
cannot say WHY a board is not vouched for, or how far anyone got. A tick could
never carry "the coasts are unverified" or "checked against the 2023 rulebook
map", and those are the sentences a game master actually wants.

So the note is free text, one line per variant, in variants/notes.json. It
sits beside the generated directory rather than inside it because dipmap
writes that directory and would overwrite anything hand-written there
(ADR-061).

The file is optional. A checkout with no notes is a working server that says
nothing about any board, which is what it said before this existed.
*/
package variant

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"strings"
	"sync"

	"spring1901/spike/internal/assets"
)

// notes is written once at startup and read-only afterwards, like the
// generated registry beside it.
var notes = map[string]string{}

// LoadNotes reads the notes file, if there is one.
func LoadNotes() error {
	raw, err := assets.Notes()
	if errors.Is(err, fs.ErrNotExist) {
		notes = map[string]string{}
		resetCatalogue()
		return nil
	}
	if err != nil {
		return fmt.Errorf("read %v: %w", assets.NotesPath(), err)
	}
	read := map[string]string{}
	if err := json.Unmarshal(raw, &read); err != nil {
		return fmt.Errorf("parse %v: %w", assets.NotesPath(), err)
	}
	// A blank note and a missing one mean the same thing, so only one of them
	// reaches the rest of the server.
	kept := map[string]string{}
	for key, note := range read {
		if trimmed := strings.TrimSpace(note); trimmed != "" {
			kept[key] = trimmed
		}
	}
	notes = kept
	resetCatalogue()
	return nil
}

// Note returns the review note for a variant, or "" when nobody wrote one.
func Note(key string) string { return notes[key] }

// resetCatalogue drops the built gallery so the next request rebuilds it.
//
// The catalogue carries the notes, and it is built once. Loading notes after
// it was built would otherwise serve the cards without them, which is exactly
// what a test that points the loader at its own file would see.
func resetCatalogue() {
	catalogueOnce = sync.Once{}
	Catalogue = nil
}
