//go:build mapeditordev

// The map editor's save endpoint (D-030), compiled only under
// `-tags mapeditordev`.
//
// The editor is a tool for whoever is correcting a variant's placement table,
// and that person is sitting at the checkout. Saving straight to disk is the
// difference between a correction session and a session followed by twenty
// downloads dragged into place by hand, so it exists — behind a build tag, so
// that a server built the normal way has no such route at all and cannot be
// talked into writing files. mapeditor_off.go is the other half.
//
// What it writes, and why those three names:
//
//	placements/<key>.hand.json  the hand-corrected table. This is the file
//	                            name tools/placement already reserves for a
//	                            person's corrections (see placements.go): it
//	                            is an INPUT to the optimizer and the server
//	                            never loads it, so a save can never put a
//	                            half-finished table on a board.
//	names/<key>.json            the display-name overrides, which the server
//	                            DOES read, at its next start (names.go).
//	mapeditor/<key>.drags.json  the drag log — every hand correction with the
//	                            violation count before and after it. It is the
//	                            evidence D-030 asks for: each entry is a
//	                            scoring rule the optimizer is missing.
package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

const editorSavePath = "/mapeditor/save"

// A whole placement table for the largest variant is a few hundred kilobytes
// once the drag log is beside it, well over the cap every other route lives
// under. This is a local tool writing to a local disk, so the bound is only
// there to stop an unbounded read.
const editorSaveMaxBytes = 8 << 20

// editorSaveRequest is what the editor posts: the whole amended state, not a
// patch. The editor holds the truth while it is open, and a whole-table write
// is the one shape that cannot half-apply.
type editorSaveRequest struct {
	Variant string `json:"variant"`
	// Placements is written verbatim, because the browser already sorted the
	// keys and rounded the numbers into the file's own shape. Re-encoding it
	// here through a Go map would reorder every key and make every save a
	// whole-file diff.
	Placements json.RawMessage `json:"placements"`
	Names      json.RawMessage `json:"names"`
	Drags      json.RawMessage `json:"drags"`
}

func registerEditorSave(mux *http.ServeMux) {
	largeBodies[editorSavePath] = editorSaveMaxBytes
	mux.HandleFunc(editorSavePath, handleEditorSave)
}

// safeVariantKey refuses anything that is not a variant this server knows.
// The key becomes a file name, so "known variant" is also the whole of the
// path check: no separators, no dots, no traversal.
func safeVariantKey(key string) bool {
	if key == "" || strings.ContainsAny(key, "/\\.") {
		return false
	}
	_, found := lookupVariant(key)
	return found
}

func handleEditorSave(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeErr(w, http.StatusMethodNotAllowed, "post the editor's export to save it")
		return
	}
	var req editorSaveRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "bad save: %v", err)
		return
	}
	if !safeVariantKey(req.Variant) {
		writeErr(w, http.StatusBadRequest, "unknown variant %q", req.Variant)
		return
	}
	written, err := saveEditorBundle(req)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "save: %v", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"written": written})
}

// saveEditorBundle writes the three files and answers with their paths, in
// the order they were written.
func saveEditorBundle(req editorSaveRequest) ([]string, error) {
	written := []string{}
	files := []struct {
		dir  string
		name string
		body json.RawMessage
	}{
		{placementDir(), req.Variant + ".hand.json", req.Placements},
		{nameDir(), req.Variant + ".json", req.Names},
		{"mapeditor", req.Variant + ".drags.json", req.Drags},
	}
	for _, file := range files {
		if len(file.body) == 0 {
			continue
		}
		if err := os.MkdirAll(file.dir, 0o755); err != nil {
			return written, fmt.Errorf("mkdir %v: %w", file.dir, err)
		}
		path := filepath.Join(file.dir, file.name)
		body := append([]byte(nil), file.body...)
		if len(body) == 0 || body[len(body)-1] != '\n' {
			body = append(body, '\n')
		}
		if err := os.WriteFile(path, body, 0o644); err != nil {
			return written, fmt.Errorf("write %v: %w", path, err)
		}
		written = append(written, path)
	}
	sort.Strings(written)
	return written, nil
}
