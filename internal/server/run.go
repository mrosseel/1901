// Starting the server: what it reads before it listens, and where.
//
// The order in loadState is load-bearing, so it is a function rather than a
// run of statements in Main: a test can call it and check the result.

package server

import (
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"strings"
	"time"

	"spring1901/spike/internal/assets"
	"spring1901/spike/internal/datc"
	"spring1901/spike/internal/httpx"
	"spring1901/spike/internal/variant"
)

// version is the release this binary was built from. A release sets it with
// -ldflags "-X .../internal/server.version=..." (ADR-051); a build from a
// checkout says so, because a bug report from a table has to name the build
// it came from.
var version = "dev"

// defaultAddr can be overridden with the ADDR environment variable, e.g.
// ADDR=:8000 to use a port the host firewall already allows.
const defaultAddr = ":8190"

func listenAddr() string {
	if a := os.Getenv("ADDR"); a != "" {
		return a
	}
	return defaultAddr
}

func localOpenURL(addr string) string {
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		if strings.HasPrefix(addr, ":") {
			return "http://localhost" + addr
		}
		return "http://" + addr
	}
	if host == "" || host == "0.0.0.0" || host == "::" {
		host = "localhost"
	}
	return "http://" + net.JoinHostPort(host, port)
}

// pinBaseURL reads BASE_URL once and pins the origin the generated links
// point at. See baseURL for why.
func pinBaseURL() {
	base := strings.TrimSuffix(os.Getenv("BASE_URL"), "/")
	if base == "" {
		return
	}
	if !strings.HasPrefix(base, "http://") && !strings.HasPrefix(base, "https://") {
		log.Fatalf("BASE_URL %q: it must start with http:// or https://", base)
	}
	baseURLFixed = base
}

// loadState reads everything the server needs before it serves a request.
//
// The order is load-bearing, which is why this is a function rather than a run
// of statements in main: a test can call it and check the result.
//
//  1. Placement tables for the compiled variants.
//  2. Generated variants, which register themselves and their own placement
//     tables.
//  3. Games. A saved game names its variant by key and resolves it through the
//     registry, so every variant has to exist by now. Loading games earlier
//     failed every game played on a map that lives in a directory.
//  4. Name overrides, styles and style plans, which decorate what is already
//     registered.
//
// Every step is fatal on failure. Serving half a placement table, or a variant
// whose descriptor only half parsed, is worse than not starting.
func loadState() error {
	if err := variant.LoadGenerated(); err != nil {
		return fmt.Errorf("load generated variants: %w", err)
	}
	if err := loadAll(); err != nil {
		return fmt.Errorf("load games: %w", err)
	}
	if err := variant.LoadStyles(); err != nil {
		return fmt.Errorf("load map styles: %w", err)
	}
	if err := variant.ReportPlans(); err != nil {
		return fmt.Errorf("load style plans: %w", err)
	}
	return nil
}

func Main() {
	pinBaseURL()
	pinLANHost()
	games.limit = gameLimit()
	handle, err := openDB(dbPath())
	if err != nil {
		// The usual cause on a downloaded binary is a folder the game master
		// cannot write to, and the sqlite error alone does not say so.
		log.Fatalf("open %v: %v\nThe database is made in the current directory. "+
			"Start the server from a folder you can write to, or set DB to a file path.",
			dbPath(), err)
	}
	defer handle.Close()
	db = handle
	if err := loadState(); err != nil {
		log.Fatal(err)
	}

	srv := &server{spa: assets.SPA()}

	mux := http.NewServeMux()
	mux.HandleFunc("/", srv.serveRoot)
	mux.HandleFunc("/assets/", srv.serveSPAAsset)
	mux.HandleFunc("/new", srv.serveSPA)
	// The create form asked for a board with no players (ADR-047). One more
	// route of the same shell; the create it posts lives under /api/v1.
	mux.HandleFunc("/sandbox", srv.serveSPA)
	// The questions page, and one more route of the same shell (ADR-043).
	mux.HandleFunc("/faq", srv.serveSPA)
	// The design gallery. Whether it exists is decided in the frontend build,
	// not here: a build made without SCREENS=1 carries no gallery, and this
	// address then serves a shell that answers "nothing here". Serving the
	// shell either way keeps the decision in one place.
	mux.HandleFunc("/dev/screens", srv.serveSPA)
	// The game list page (ADR-043). The list itself and the create moved to
	// /api/v1/games with everything else the app says to itself (ADR-050),
	// so this address is a page and only a page.
	mux.HandleFunc("/games", srv.serveSPA)
	// The app's own transport, all of it (ADR-050).
	mux.HandleFunc(apiPrefix+"/", srv.serveAPI)
	// What this build scored against DATC (ADR-045). The JSON is published
	// data and the page is one more route of the same shell.
	mux.HandleFunc("/datc.json", datc.Handle)
	mux.HandleFunc("/datc", srv.serveSPA)
	mux.HandleFunc("/variants", variant.HandleVariants)
	mux.HandleFunc("/styles", variant.HandleStyles)
	mux.HandleFunc("/variants/", variant.HandleVariantMap)
	mux.HandleFunc("/game/", srv.serveFlow)
	mux.HandleFunc("/join/", srv.serveJoinPage)
	mux.HandleFunc("/watch/", srv.serveWatchPage)
	// The page the next person opens from a QR code (ADR-041). It is one more
	// route of the same shell; the claim it posts to lives under /game/.
	mux.HandleFunc("/handover/", srv.serveSPA)
	mux.HandleFunc("/handover-gm/", srv.serveSPA)
	// Where a game master types their twelve words (ADR-048). Another route
	// of the same shell; the challenge and the answer live under /game/.
	mux.HandleFunc("/recover/", srv.serveSPA)
	mux.HandleFunc("/recover", srv.serveSPA)

	addr := listenAddr()
	origin := baseURLFixed
	switch {
	case origin != "":
	case lanHost != "":
		origin = "each request, with localhost swapped for " + lanHost
	default:
		origin = "each request — set BASE_URL to pin it"
	}
	log.Printf("1901 %v listening (app from %v, database %v, cap %v game(s))",
		version, assets.SPASource(), dbPath(), games.limit)
	log.Printf("open on this computer: %v", localOpenURL(addr))
	log.Printf("phone invite links: %v", origin)
	if baseURLFixed == "" && lanHost == "" {
		log.Printf("WARNING: no unambiguous phone-reachable address was found; set BASE_URL and test one invite from a phone before seating the table")
	} else {
		log.Printf("test one invite from a phone before seating the table")
	}
	// Timeouts, so a slow or stalled client holds one connection, not the
	// server. Requests here are small JSON and a few megabytes of SVG at
	// most, so these bounds are generous.
	httpSrv := &http.Server{
		Addr:              addr,
		Handler:           httpx.Compress(limitBody(mux)),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      60 * time.Second,
		IdleTimeout:       2 * time.Minute,
	}
	log.Fatal(httpSrv.ListenAndServe())
}
