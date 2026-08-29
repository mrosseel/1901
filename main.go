// Command 1901 serves in-memory Diplomacy games.
//
// A game is created with POST /games and is then reachable through its GM
// token, its one shared invite, and one token per seat. The React frontend
// in web/ is served as a single page application shell; the client routes
// itself from location.pathname.
package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/zond/godip"
	"github.com/zond/godip/state"
	"github.com/zond/godip/variants/common"
)

// defaultAddr can be overridden with the ADDR environment variable, e.g.
// ADDR=:8000 to use a port the host firewall already allows.
const defaultAddr = ":8190"

func listenAddr() string {
	if a := os.Getenv("ADDR"); a != "" {
		return a
	}
	return defaultAddr
}

// game holds one in-memory game and guards it against concurrent requests.
type game struct {
	mu    sync.Mutex
	state *state.State
	// parts keeps the raw order bits per province, for readable order strings.
	parts map[godip.Province][]string
	// owner records which power entered the order, so seat views can be
	// filtered without inspecting the board.
	owner map[godip.Province]godip.Nation
	// illegal marks the provinces whose stored order the engine refuses
	// (D-029). The order is kept as the player wrote it and is shown back
	// to them, but it is never in the engine's order set, so the unit holds
	// and the review shows the order struck.
	illegal map[godip.Province]bool
	// flow carries the GM, seat, and phase state.
	flow *flow
	// watch is one entry per resolved phase: the public per-phase history
	// the /watch URLs serve (D-013). It is rebuilt by replay(), so a
	// historical link survives a restart.
	watch []*watchSnapshot
	// previousPhase is the review of the phase that resolved most
	// recently, nil until the first adjudication.
	previousPhase *phaseReviewJSON
	// variant is the godip variant this game is played on. Every engine
	// call goes through it; nothing here is classical-specific.
	variant    common.Variant
	variantKey string
}

func newGame(key string, v common.Variant) (*game, error) {
	s, err := v.Start()
	if err != nil {
		return nil, err
	}
	return &game{
		state:      s,
		parts:      map[godip.Province][]string{},
		owner:      map[godip.Province]godip.Nation{},
		illegal:    map[godip.Province]bool{},
		variant:    v,
		variantKey: key,
	}, nil
}

// clearOrder removes any order for the province. The caller must hold g.mu.
func (self *game) clearOrder(prov godip.Province) {
	next := map[godip.Province]godip.Adjudicator{}
	for p, o := range self.state.Orders() {
		if p.Super() != prov.Super() {
			next[p] = o
		}
	}
	self.state.SetOrders(next)
	for p := range self.parts {
		if p.Super() == prov.Super() {
			delete(self.parts, p)
			delete(self.owner, p)
			delete(self.illegal, p)
		}
	}
}

// orderParts drops the repeated source province the Options tree puts after
// the order type. The parser does not want it, and clients keep it.
func orderParts(prov godip.Province, rawParts []string) []string {
	if len(rawParts) >= 2 && rawParts[1] == string(prov) {
		return append([]string{rawParts[0]}, rawParts[2:]...)
	}
	return rawParts
}

// allowsIllegal reports whether this game takes orders the engine refuses
// (D-029). It is on by default; a game whose flow is not built yet is
// strict, which is what every internal caller wants.
func (self *game) allowsIllegal() bool {
	return self.flow != nil && self.flow.settings.IllegalMoves
}

/*
setOrder stores one order, replacing any earlier order for the same province.
The caller must hold g.mu.

There are three outcomes, and the middle one is D-029.

An order that does not PARSE is refused. Nothing coherent can be stored from
it: the parser is what turns a list of words into an order at all, so a
failure there means the client sent something that names no order type, no
province, or the wrong number of parts. There is no player intent to keep.

An order that parses but does not VALIDATE is a misorder — Vienna ordered to
Paris, a support for a move nobody is making. Bluffing by misordering is part
of Diplomacy, so with illegalMoves on it is stored as the player wrote it and
marked illegal: it never enters the engine's order set, so at adjudication
the unit holds and the review shows the order struck (D-029). With the
setting off it is refused, which is the strict behaviour this server had.

An order that validates goes into the engine, as always.
*/
func (self *game) setOrder(prov godip.Province, rawParts []string) error {
	return self.storeOrder(prov, rawParts, self.allowsIllegal())
}

// setOrderStrict stores an order only if the engine accepts it, whatever the
// game's setting says. Replay uses it: a stored row that is not marked
// illegal and no longer validates is a row that has drifted from the board,
// and turning it into a misorder would invent a move nobody made.
func (self *game) setOrderStrict(prov godip.Province, rawParts []string) error {
	return self.storeOrder(prov, rawParts, false)
}

func (self *game) storeOrder(prov godip.Province, rawParts []string, allowIllegal bool) error {
	parts := orderParts(prov, rawParts)
	bits := append([]string{string(prov)}, parts...)
	order, err := self.variant.Parser.Parse(bits)
	if err != nil {
		return fmt.Errorf("cannot parse %v: %v", bits, err)
	}
	power, _ := nationFor(self.state, prov)
	if _, err := order.Validate(self.state); err != nil {
		if !allowIllegal {
			return fmt.Errorf("illegal order %v: %v", bits, err)
		}
		self.storeIllegal(prov, parts, power)
		return nil
	}

	self.clearOrder(prov)
	next := map[godip.Province]godip.Adjudicator{}
	for p, o := range self.state.Orders() {
		next[p] = o
	}
	next[prov] = order
	self.state.SetOrders(next)
	self.parts[prov] = parts
	self.owner[prov] = power
	return nil
}

// storeIllegal keeps a misorder as written, outside the engine (D-029).
// The caller must hold g.mu.
func (self *game) storeIllegal(prov godip.Province, parts []string, power godip.Nation) {
	self.clearOrder(prov)
	self.parts[prov] = parts
	self.owner[prov] = power
	self.illegal[prov] = true
}

// illegalProvinces lists the provinces holding an illegal order, sorted.
func (self *game) illegalProvinces() []string {
	out := []string{}
	for prov := range self.illegal {
		out = append(out, string(prov))
	}
	sort.Strings(out)
	return out
}

// registry holds every live game, keyed by id.
type registry struct {
	mu    sync.Mutex
	games map[string]*game
	// limit caps how many games the registry may hold. Games never expire,
	// so this is what stops an anonymous loop of creates from eating the
	// box. Set once at startup, from MAX_GAMES.
	limit int
}

var games = &registry{games: map[string]*game{}}

// errGameLimit says create() refused a new game because the registry is at
// its cap.
var errGameLimit = errors.New("game limit reached")

// defaultMaxGames is the cap on live games when MAX_GAMES is unset. A table
// runs a handful of games; the cap exists for the hostile case, not the
// busy one.
const defaultMaxGames = 100

// gameLimit reads MAX_GAMES. A value that is not a positive number is a
// startup error, not a silent default.
func gameLimit() int {
	v := os.Getenv("MAX_GAMES")
	if v == "" {
		return defaultMaxGames
	}
	n, err := strconv.Atoi(v)
	if err != nil || n < 1 {
		log.Fatalf("MAX_GAMES %q: it must be a positive number", v)
	}
	return n
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

var idPattern = regexp.MustCompile(`^[a-z0-9-]{1,32}$`)

func validID(id string) bool {
	return idPattern.MatchString(id)
}

// lookup returns an existing game. Games exist only once POST /games has
// created them.
func (self *registry) lookup(id string) (*game, bool) {
	self.mu.Lock()
	defer self.mu.Unlock()
	g, found := self.games[id]
	return g, found
}

// create registers a new game under a fresh random id.
func (self *registry) create(key string, v common.Variant, f *flow) (*game, string, error) {
	g, err := newGame(key, v)
	if err != nil {
		return nil, "", err
	}
	g.flow = f

	self.mu.Lock()
	defer self.mu.Unlock()
	if self.limit > 0 && len(self.games) >= self.limit {
		return nil, "", errGameLimit
	}
	for attempt := 0; attempt < 10; attempt++ {
		id, err := newGameID()
		if err != nil {
			return nil, "", err
		}
		if _, taken := self.games[id]; taken {
			continue
		}
		self.games[id] = g
		return g, id, nil
	}
	return nil, "", errors.New("could not find a free game id")
}

type phaseJSON struct {
	Season string `json:"season"`
	Year   int    `json:"year"`
	Type   string `json:"type"`
}

type unitJSON struct {
	Type   string `json:"type"`
	Nation string `json:"nation"`
}

type stateJSON struct {
	GameID        string              `json:"gameId"`
	Phase         phaseJSON           `json:"phase"`
	Units         map[string]unitJSON `json:"units"`
	Dislodged     map[string]unitJSON `json:"dislodged"`
	Orders        map[string]string   `json:"orders"`
	OrderParts    map[string][]string `json:"orderParts"`
	Resolutions   map[string]string   `json:"resolutions"`
	SupplyCenters map[string]string   `json:"supplyCenters"`
	Nations       []string            `json:"nations"`
	// Illegal names the provinces whose order the engine refuses (D-029).
	// The order is in Orders like any other, as the player wrote it; this
	// is what tells a board to strike it through.
	Illegal []string `json:"illegal"`
}

// snapshot renders the current board as JSON. The caller must hold self.mu.
// It contains every order; only seatState, which filters it, is exposed.
func (self *game) snapshot(id string) stateJSON {
	s := self.state
	out := stateJSON{
		GameID: id,
		Phase: phaseJSON{
			Season: string(s.Phase().Season()),
			Year:   s.Phase().Year(),
			Type:   string(s.Phase().Type()),
		},
		Units:         map[string]unitJSON{},
		Dislodged:     map[string]unitJSON{},
		Orders:        map[string]string{},
		OrderParts:    map[string][]string{},
		Resolutions:   map[string]string{},
		SupplyCenters: map[string]string{},
	}
	for prov, unit := range s.Units() {
		out.Units[string(prov)] = unitJSON{
			Type:   string(unit.Type),
			Nation: string(unit.Nation),
		}
	}
	// Dislodgement is public knowledge: everyone at the table sees which
	// unit was pushed out and has to retreat.
	for prov, unit := range s.Dislodgeds() {
		out.Dislodged[string(prov)] = unitJSON{
			Type:   string(unit.Type),
			Nation: string(unit.Nation),
		}
	}
	for prov, bits := range self.parts {
		out.Orders[string(prov)] = self.describe(prov, bits)
		out.OrderParts[string(prov)] = bits
	}
	for prov, err := range s.Resolutions() {
		if err == nil {
			out.Resolutions[string(prov)] = "OK"
		} else {
			out.Resolutions[string(prov)] = err.Error()
		}
	}
	for prov, nation := range s.SupplyCenters() {
		out.SupplyCenters[string(prov)] = string(nation)
	}
	out.Illegal = self.illegalProvinces()
	for _, nation := range self.variant.Nations {
		out.Nations = append(out.Nations, string(nation))
	}
	sort.Strings(out.Nations)
	return out
}

// phaseReviewJSON is the record of a resolved phase: every order that was
// actually applied, who gave it, and how it turned out. Past orders become
// public once the phase resolves, so this is safe for every view.
type phaseReviewJSON struct {
	Phase       phaseJSON           `json:"phase"`
	Orders      map[string]string   `json:"orders"`
	OrderParts  map[string][]string `json:"orderParts"`
	Powers      map[string]string   `json:"powers"`
	Resolutions map[string]string   `json:"resolutions"`
	Dislodged   map[string]unitJSON `json:"dislodged"`
	NMR         []string            `json:"nmr"`
	// Illegal names the provinces whose order never reached the engine
	// (D-029). Their resolution is "IllegalOrder", which is not something
	// godip can say: an engine failure names the rule that beat the order,
	// and this one says the order was never in the fight.
	Illegal []string `json:"illegal"`
}

// illegalResolution is the resolution an illegal order is given. It is not a
// godip error string, and it cannot collide with one.
const illegalResolution = "IllegalOrder"

// beginReview records the phase and its applied orders. It must run after
// any NMR drops and before state.Next(), because the order text is read
// off the board as it stands during the phase.
func (self *game) beginReview(nmr []string) *phaseReviewJSON {
	review := &phaseReviewJSON{
		Phase: phaseJSON{
			Season: string(self.state.Phase().Season()),
			Year:   self.state.Phase().Year(),
			Type:   string(self.state.Phase().Type()),
		},
		Orders:      map[string]string{},
		OrderParts:  map[string][]string{},
		Powers:      map[string]string{},
		Resolutions: map[string]string{},
		Dislodged:   map[string]unitJSON{},
		NMR:         []string{},
		Illegal:     self.illegalProvinces(),
	}
	for prov, bits := range self.parts {
		review.Orders[string(prov)] = self.describe(prov, bits)
		review.OrderParts[string(prov)] = bits
		review.Powers[string(prov)] = string(self.owner[prov])
	}
	if nmr != nil {
		review.NMR = nmr
	}
	return review
}

// endReview fills in the outcome. It must run after state.Next().
func (self *game) endReview(review *phaseReviewJSON) {
	for prov, err := range self.state.Resolutions() {
		if err == nil {
			review.Resolutions[string(prov)] = "OK"
		} else {
			review.Resolutions[string(prov)] = err.Error()
		}
	}
	// An illegal order has no resolution of the engine's, because it was
	// never in the engine (D-029). It gets one of ours, so a reader can tell
	// "this order was struck and the unit held" from "this order was tried
	// and lost".
	for _, prov := range review.Illegal {
		review.Resolutions[prov] = illegalResolution
	}
	review.Dislodged = self.dislodgedMap()
}

// dislodgedMap renders the dislodged units for the views that carry no
// full board snapshot.
func (self *game) dislodgedMap() map[string]unitJSON {
	out := map[string]unitJSON{}
	for prov, unit := range self.state.Dislodgeds() {
		out[string(prov)] = unitJSON{
			Type:   string(unit.Type),
			Nation: string(unit.Nation),
		}
	}
	return out
}

// describe builds a human-readable order string such as "Army Vienna Move Trieste".
func (self *game) describe(prov godip.Province, bits []string) string {
	words := []string{}
	if unit, ok := self.orderableUnit(prov); ok {
		words = append(words, string(unit.Type))
	}
	words = append(words, self.longName(prov))
	for _, bit := range bits {
		words = append(words, self.longName(godip.Province(bit)))
	}
	return strings.Join(words, " ")
}

// orderableUnit returns the unit whose orders belong to this province. In
// a retreat phase that is the dislodged unit, not whoever took the space.
func (self *game) orderableUnit(prov godip.Province) (godip.Unit, bool) {
	if self.state.Phase().Type() == godip.Retreat {
		if unit, _, ok := self.state.Dislodged(prov); ok {
			return unit, true
		}
	}
	unit, _, ok := self.state.Unit(prov)
	return unit, ok
}

// longName maps a province abbreviation to its long name in this game's
// variant, and leaves anything else (order types, unit types) untouched.
func (self *game) longName(p godip.Province) string {
	names := self.variant.ProvinceLongNames
	if name, found := names[p]; found {
		return name
	}
	sup, sub := p.Split()
	if name, found := names[sup]; found && sub != "" {
		return fmt.Sprintf("%v (%v)", name, sub)
	}
	return string(p)
}

func writeJSON(w http.ResponseWriter, code int, body interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	if err := json.NewEncoder(w).Encode(body); err != nil {
		log.Printf("encode: %v", err)
	}
}

func writeErr(w http.ResponseWriter, code int, format string, args ...interface{}) {
	writeJSON(w, code, map[string]string{"error": fmt.Sprintf(format, args...)})
}

// handleMap serves this game's variant map. It is board art, the same for
// every game on that variant, and carries no game state.
//
// This is the route the board actually loads its map from, so it has to make
// the same styled-or-original choice /variants/{key}/map.svg makes — sharing
// variantMapBytes is what stops a restyle from reaching the gallery and never
// reaching a board.
func handleMap(g *game, id string, w http.ResponseWriter, r *http.Request) {
	b, err := variantMapBytes(g.variantKey, g.variant, r)
	if errors.Is(err, errUnknownStyle) {
		http.NotFound(w, r)
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "svg map: %v", err)
		return
	}
	w.Header().Set("Content-Type", "image/svg+xml")
	w.Write(b)
}

// nationFor finds the nation that may order the given province. During a
// retreat phase the dislodged unit is the one with orders to give, and it
// may share the province with the unit that pushed it out — so it is
// checked first.
func nationFor(s *state.State, prov godip.Province) (godip.Nation, bool) {
	if s.Phase().Type() == godip.Retreat {
		if unit, _, ok := s.Dislodged(prov); ok {
			return unit.Nation, true
		}
	}
	if unit, _, ok := s.Unit(prov); ok {
		return unit.Nation, true
	}
	if nation, _, ok := s.SupplyCenter(prov); ok {
		return nation, true
	}
	return "", false
}

type orderRequest struct {
	Province string   `json:"province"`
	Parts    []string `json:"parts"`
}

type gameHandler func(g *game, id string, w http.ResponseWriter, r *http.Request)

// server holds what the request handlers need beyond the registry.
type server struct {
	// spaDir is the built frontend (web/dist), a vite build.
	spaDir string
}

// isFile reports whether the path exists and is a regular file.
func isFile(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.Mode().IsRegular()
}

// serveSPA serves the built single page application shell. The client
// routes itself from location.pathname, so every page gets this file.
func (self *server) serveSPA(w http.ResponseWriter, r *http.Request) {
	index := filepath.Join(self.spaDir, "index.html")
	if !isFile(index) {
		http.Error(w,
			"the frontend is not built yet — run `npm install && npm run build` in web/ to create web/dist",
			http.StatusServiceUnavailable)
		return
	}
	// The shell must not be cached; the hashed assets beside it may be.
	w.Header().Set("Cache-Control", "no-store")
	http.ServeFile(w, r, index)
}

// serveSPAAsset serves one file from the build output, by URL path.
func (self *server) serveSPAAsset(w http.ResponseWriter, r *http.Request) {
	name := filepath.Clean(strings.TrimPrefix(r.URL.Path, "/"))
	if name == "." || strings.HasPrefix(name, "..") {
		http.NotFound(w, r)
		return
	}
	path := filepath.Join(self.spaDir, name)
	if !isFile(path) {
		http.NotFound(w, r)
		return
	}
	http.ServeFile(w, r, path)
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

// absPath resolves a path against the working directory, leaving it as
// given when that fails.
func absPath(path string) string {
	if abs, err := filepath.Abs(path); err == nil {
		return abs
	}
	return path
}

// spaDirPath is where the built frontend lives. SPADIR overrides the
// default, so a packaged binary can point at the directory its installer
// chose.
func spaDirPath() string {
	if p := os.Getenv("SPADIR"); p != "" {
		return p
	}
	return filepath.Join("web", "dist")
}

// maxBodyBytes caps every request body. The largest body the app expects
// is a settings patch or a few orders — bytes, not megabytes — and the
// cap is what stops one request from costing the server its memory.
const maxBodyBytes = 64 << 10

// largeBodies names the few paths that are allowed a bigger body than the
// cap above, with the cap each one gets. It is empty in a normal build; the
// map editor's dev-only save route is the one thing that fills it, because it
// posts a whole placement table rather than a handful of orders (D-030).
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

func main() {
	pinBaseURL()
	games.limit = gameLimit()
	handle, err := openDB(dbPath())
	if err != nil {
		log.Fatalf("open %v: %v", dbPath(), err)
	}
	defer handle.Close()
	db = handle
	if err := loadAll(); err != nil {
		log.Fatalf("load games: %v", err)
	}
	// The approved placement tables are read once, before anything is served:
	// they never change while the process runs, and a board drawn from half a
	// table would be worse than one drawn from none.
	if err := loadPlacements(); err != nil {
		log.Fatalf("load placements: %v", err)
	}
	// Generated variants come off disk rather than out of the binary. They
	// register their own placement tables, so they load after the compiled
	// tables and before anything resolves a variant key.
	if err := loadGeneratedVariants(); err != nil {
		log.Fatalf("load generated variants: %v", err)
	}
	// The display-name overrides that ride on top of godip's own names, for
	// the same reason and on the same terms.
	if err := loadNameOverrides(); err != nil {
		log.Fatalf("load name overrides: %v", err)
	}
	// The map styles and the plans that apply them, likewise. A broken style
	// or a plan from a schema this server does not read is a startup error:
	// serving three styles of four, silently, would be worse.
	if err := loadStyles(); err != nil {
		log.Fatalf("load map styles: %v", err)
	}
	if err := loadPlans(); err != nil {
		log.Fatalf("load style plans: %v", err)
	}

	spaDir := absPath(spaDirPath())
	srv := &server{spaDir: spaDir}

	mux := http.NewServeMux()
	mux.HandleFunc("/", srv.serveRoot)
	mux.HandleFunc("/assets/", srv.serveSPAAsset)
	mux.HandleFunc("/new", srv.serveSPA)
	// The map editor is one more page of the same shell (D-030). It carries
	// no game and no token, so it needs nothing but the shell; whether it can
	// save is decided by the build, in mapeditor_dev.go.
	mux.HandleFunc("/mapeditor", srv.serveSPA)
	registerEditorSave(mux)
	mux.HandleFunc("/games", handleCreateGame)
	mux.HandleFunc("/variants", handleVariants)
	mux.HandleFunc("/styles", handleStyles)
	mux.HandleFunc("/variants/", handleVariantMap)
	mux.HandleFunc("/game/", srv.serveFlow)
	mux.HandleFunc("/join/", srv.serveJoinPage)
	mux.HandleFunc("/watch/", srv.serveWatchPage)

	addr := listenAddr()
	origin := baseURLFixed
	if origin == "" {
		origin = "each request — set BASE_URL to pin it"
	}
	log.Printf("listening on http://localhost%v (app from %v, database %v, links %v, cap %v game(s))",
		addr, spaDir, dbPath(), origin, games.limit)
	// Timeouts, so a slow or stalled client holds one connection, not the
	// server. Requests here are small JSON and a few megabytes of SVG at
	// most, so these bounds are generous.
	httpSrv := &http.Server{
		Addr:              addr,
		Handler:           limitBody(mux),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      60 * time.Second,
		IdleTimeout:       2 * time.Minute,
	}
	log.Fatal(httpSrv.ListenAndServe())
}
