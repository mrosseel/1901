//go:build !mapeditordev

// The map editor's save endpoint, absent.
//
// This is the file a normal build compiles, and it registers nothing: the
// route does not exist, so a deployed server has no way to be told to write
// files into its own working directory. The editor route itself still serves
// — the page loads, drags, audits and exports through the browser's own
// download — it simply has nowhere to save (ADR-030).
//
// The other half is mapeditor_dev.go, behind `-tags mapeditordev`.
package main

import "net/http"

func registerEditorSave(mux *http.ServeMux) {}
