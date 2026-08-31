/*
The two HTTP surfaces (ADR-050), and which addresses belong to which.

Everything here is JSON over HTTP, so "the API" meant two unrelated things:
this app talking to itself, and data published to people who are not in the
room. They need opposite promises, so they get different addresses.

	/api/v1/…            the app's transport. No promises to anybody outside
	                     the build that ships with it.
	/game/{id}/public    published, citable, kept working
	/game/{id}/watch     the same (ADR-013, ADR-028)
	/variants, /styles   the catalogue and the art, the same for everyone

The version in the path is not ceremony. It is what makes "no promises" safe:
a breaking change becomes /api/v2 and every tab still open on a table keeps
working until the person holding it reloads. Without it, freedom to change the
transport is a promise to break somebody's phone mid-phase.

The page addresses are neither surface. They serve the app shell, and
parseRoute() in web/src/api.ts is their definition.
*/
package main

import (
	"net/http"
	"strings"
)

// apiPrefix is where the app's own transport lives. One place, because the
// client builds every URL from the same constant on its side.
const apiPrefix = "/api/v1"

/*
serveAPI is the front door of the transport surface.

It strips the prefix and hands what is left to the same handlers the bare
addresses used to reach. Nothing about a game's routing changed except where
it is answered from.
*/
func (self *server) serveAPI(w http.ResponseWriter, r *http.Request) {
	rest := strings.TrimPrefix(r.URL.Path, apiPrefix)
	if rest == r.URL.Path {
		http.NotFound(w, r)
		return
	}
	switch {
	case rest == "/games":
		// The list and the create, which are the two things a collection
		// answers. The page that shows the list is /games and is the shell.
		if r.Method == http.MethodGet {
			handleListGames(w, r)
			return
		}
		handleCreateGame(w, r)
	case rest == "/build":
		handleBuild(w, r)
	case strings.HasPrefix(rest, "/game/"):
		self.serveFlowAPI(w, r, rest)
	default:
		http.NotFound(w, r)
	}
}

/*
handleBuild says which build of the client this server is serving (ADR-050).

An open tab is running the JavaScript it was sent, against whatever server is
answering now. A deploy leaves the two out of step and the tab has no way to
know: at a table that is a phone that has been on one page for forty minutes
and is about to be told nothing works. So every state answer carries this
stamp, and a client that sees it change says so.

The stamp tracks the client build and not the server binary, which is the
question actually being asked. A server-only change leaves every tab correct.
*/
func handleBuild(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, struct {
		Build string `json:"build"`
	}{Build: buildStamp()})
}
