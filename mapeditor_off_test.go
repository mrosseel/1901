//go:build !mapeditordev

package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

// The save endpoint is compiled in only under -tags mapeditordev. A server
// built the ordinary way must have no such route at all, or a deployed
// instance could be told to write files into its own working directory.
func TestEditorSaveIsAbsentFromAnOrdinaryBuild(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusTeapot)
	})
	registerEditorSave(mux)

	w := httptest.NewRecorder()
	mux.ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/mapeditor/save", nil))
	if w.Code != http.StatusTeapot {
		t.Errorf("/mapeditor/save was handled (%d) in a build without the tag", w.Code)
	}
	if len(largeBodies) != 0 {
		t.Errorf("an ordinary build raised the body cap for %v", largeBodies)
	}
}
