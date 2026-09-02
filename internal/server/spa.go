// Serving the frontend, the map, and the cap on what a request may carry.
//
// The shell is served at every page route because the client routes itself
// from location.pathname; an asset that does not exist is a 404 rather than
// the shell, because a script tag answered with HTML fails somewhere else.

package server

import (
	"errors"
	"io/fs"
	"net/http"
	"path"
	"strings"

	"spring1901/spike/internal/assets"
	"spring1901/spike/internal/httpx"
	"spring1901/spike/internal/variant"
)

// handleMap serves this game's variant map. It is board art, the same for
// every game on that variant, and carries no game state.
//
// This is the route the board actually loads its map from, so it has to make
// the same styled-or-original choice /variants/{key}/map.svg makes — sharing
// variant.ServeMapArt is what stops a restyle from reaching the gallery and never
// reaching a board.
func handleMap(g *game, id string, w http.ResponseWriter, r *http.Request) {
	err := variant.ServeMapArt(w, r, g.variantKey, g.variant)
	if errors.Is(err, variant.ErrUnknownStyle) {
		http.NotFound(w, r)
		return
	}
	if err != nil {
		httpx.WriteErr(w, http.StatusInternalServerError, "svg map: %v", err)
	}
}

type gameHandler func(g *game, id string, w http.ResponseWriter, r *http.Request)

// server holds what the request handlers need beyond the registry.
type server struct {
	// spa is the built frontend (web/dist), a vite build. It is a directory
	// on disk in a development build and the copy inside the binary in a
	// release build (ADR-051), and nothing here can tell the difference.
	spa fs.FS
}

// serveSPA serves the built single page application shell. The client
// routes itself from location.pathname, so every page gets this file.
func (self *server) serveSPA(w http.ResponseWriter, r *http.Request) {
	if !assets.IsFileIn(self.spa, "index.html") {
		http.Error(w,
			"the frontend is not built yet — run `npm install && npm run build` in web/ to create web/dist",
			http.StatusServiceUnavailable)
		return
	}
	// The shell must not be cached; the hashed assets beside it may be.
	w.Header().Set("Cache-Control", "no-store")
	http.ServeFileFS(w, r, self.spa, "index.html")
}

// serveSPAAsset serves one file from the build output, by URL path.
func (self *server) serveSPAAsset(w http.ResponseWriter, r *http.Request) {
	name := path.Clean(strings.TrimPrefix(r.URL.Path, "/"))
	if !fs.ValidPath(name) || name == "." {
		http.NotFound(w, r)
		return
	}
	if !assets.IsFileIn(self.spa, name) {
		http.NotFound(w, r)
		return
	}
	http.ServeFileFS(w, r, self.spa, name)
}

// serveRoot serves the game list at the bare root and resolves the files
// vite emits at the build root (favicon, manifest, and friends).
func (self *server) serveRoot(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path == "/" {
		self.serveSPA(w, r)
		return
	}
	self.serveSPAAsset(w, r)
}

// maxBodyBytes caps every request body. The largest body the app expects
// is a settings patch or a few orders — bytes, not megabytes — and the
// cap is what stops one request from costing the server its memory.
const maxBodyBytes = 64 << 10

// largeBodies names the few paths that are allowed a bigger body than the cap
// above, with the cap each one gets. It is empty, and has been since the map
// editor moved to dipmap (ADR-051): every route this server has now posts a
// handful of orders, not a whole placement table.
var largeBodies = map[string]int64{}

// limitBody wraps a handler so every request body is size-capped. The
// JSON decoders then fail with "request body too large" instead of
// reading forever.
func limitBody(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		limit := int64(maxBodyBytes)
		if own, found := largeBodies[r.URL.Path]; found {
			limit = own
		}
		r.Body = http.MaxBytesReader(w, r.Body, limit)
		next.ServeHTTP(w, r)
	})
}
