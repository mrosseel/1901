//go:build mapeditordev

package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The editor posts a whole table and gets three files. The one thing worth
// checking beyond that is WHICH three: the amended table must land in the
// .hand.json the server never loads, so a half-finished session can never
// reach a board.
func TestEditorSaveWritesTheHandFile(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("PLACEMENTS", filepath.Join(dir, "placements"))
	t.Setenv("NAMES", filepath.Join(dir, "names"))
	wd, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chdir(dir); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.Chdir(wd) })

	body := `{"variant":"classical",` +
		`"placements":{"vie":{"unit":[1,2],"scale":1,"dislodged":[3,4]}},` +
		`"names":{"bur":"Bourgogne"},` +
		`"drags":[{"province":"vie","field":"unit","from":[0,0],"to":[1,2],` +
		`"violationsBefore":3,"violationsAfter":2}]}`
	w := httptest.NewRecorder()
	handleEditorSave(w, httptest.NewRequest(http.MethodPost, editorSavePath, strings.NewReader(body)))
	if w.Code != http.StatusOK {
		t.Fatalf("save answered %d: %v", w.Code, w.Body.String())
	}

	var answer struct {
		Written []string `json:"written"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &answer); err != nil {
		t.Fatal(err)
	}
	if len(answer.Written) != 3 {
		t.Fatalf("wrote %v, wanted three files", answer.Written)
	}

	hand := filepath.Join(dir, "placements", "classical.hand.json")
	written, err := os.ReadFile(hand)
	if err != nil {
		t.Fatalf("the amended table did not land in the hand file: %v", err)
	}
	// Written verbatim: the browser already sorted the keys and rounded the
	// numbers into the file's shape, and re-encoding here would reorder it.
	if !strings.HasPrefix(string(written), `{"vie":`) || !strings.HasSuffix(string(written), "\n") {
		t.Errorf("the table was rewritten on the way in: %q", string(written))
	}
	if _, err := os.Stat(filepath.Join(dir, "placements", "classical.json")); !os.IsNotExist(err) {
		t.Error("a save touched the approved table, which the server loads")
	}
	if _, err := os.Stat(filepath.Join(dir, "mapeditor", "classical.drags.json")); err != nil {
		t.Errorf("the drag log was not written: %v", err)
	}
}

func TestEditorSaveRefusesAnUnknownVariant(t *testing.T) {
	for _, key := range []string{"", "nosuchvariant", "../etc/passwd", "classical.hand"} {
		w := httptest.NewRecorder()
		body := `{"variant":` + quoted(key) + `,"placements":{}}`
		handleEditorSave(w, httptest.NewRequest(http.MethodPost, editorSavePath, strings.NewReader(body)))
		if w.Code != http.StatusBadRequest {
			t.Errorf("variant %q answered %d, wanted 400", key, w.Code)
		}
	}
}

// quoted renders a string as JSON, which is all this file needs.
func quoted(value string) string {
	b, _ := json.Marshal(value)
	return string(b)
}
