// Command 1901 serves in-memory classical Diplomacy games.
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
	"strings"
	"sync"

	"github.com/zond/godip"
	"github.com/zond/godip/state"
	"github.com/zond/godip/variants/classical"
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
	// flow carries the GM, seat, and phase state.
	flow *flow
}

func newGame() (*game, error) {
	s, err := classical.Start()
	if err != nil {
		return nil, err
	}
	return &game{
		state: s,
		parts: map[godip.Province][]string{},
		owner: map[godip.Province]godip.Nation{},
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
		}
	}
}

// setOrder validates and stores one order, replacing any earlier order for
// the same province. The caller must hold g.mu.
func (self *game) setOrder(prov godip.Province, rawParts []string) error {
	// The Options tree repeats the source province after the order type.
	// The parser does not want it, so drop it if the client kept it.
	parts := rawParts
	if len(parts) >= 2 && parts[1] == string(prov) {
		parts = append([]string{parts[0]}, parts[2:]...)
	}
	bits := append([]string{string(prov)}, parts...)
	order, err := classical.Parser.Parse(bits)
	if err != nil {
		return fmt.Errorf("cannot parse %v: %v", bits, err)
	}
	if _, err := order.Validate(self.state); err != nil {
		return fmt.Errorf("illegal order %v: %v", bits, err)
	}
	power, _ := nationFor(self.state, prov)

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

// registry holds every live game, keyed by id.
type registry struct {
	mu    sync.Mutex
	games map[string]*game
}

var games = &registry{games: map[string]*game{}}

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
func (self *registry) create(f *flow) (*game, string, error) {
	g, err := newGame()
	if err != nil {
		return nil, "", err
	}
	g.flow = f

	self.mu.Lock()
	defer self.mu.Unlock()
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
	Orders        map[string]string   `json:"orders"`
	OrderParts    map[string][]string `json:"orderParts"`
	Resolutions   map[string]string   `json:"resolutions"`
	SupplyCenters map[string]string   `json:"supplyCenters"`
	Nations       []string            `json:"nations"`
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
	for _, nation := range classical.Nations {
		out.Nations = append(out.Nations, string(nation))
	}
	sort.Strings(out.Nations)
	return out
}

// describe builds a human-readable order string such as "Army Vienna Move Trieste".
func (self *game) describe(prov godip.Province, bits []string) string {
	words := []string{}
	if unit, _, ok := self.state.Unit(prov); ok {
		words = append(words, string(unit.Type))
	}
	words = append(words, longName(prov))
	for _, bit := range bits {
		words = append(words, longName(godip.Province(bit)))
	}
	return strings.Join(words, " ")
}

// longName maps a province abbreviation to its long name, and leaves
// anything else (order types, unit types) untouched.
func longName(p godip.Province) string {
	if name, found := classical.ClassicalVariant.ProvinceLongNames[p]; found {
		return name
	}
	sup, sub := p.Split()
	if name, found := classical.ClassicalVariant.ProvinceLongNames[sup]; found && sub != "" {
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

// handleMap serves the classical map. It is board art, the same for every
// game, and carries no game state.
func handleMap(g *game, id string, w http.ResponseWriter, r *http.Request) {
	b, err := classical.ClassicalVariant.SVGMap()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "svg map: %v", err)
		return
	}
	w.Header().Set("Content-Type", "image/svg+xml")
	w.Write(b)
}

// nationFor finds the nation that may order the given province.
func nationFor(s *state.State, prov godip.Province) (godip.Nation, bool) {
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

// serveRoot sends the bare root to the game-creation page and resolves the
// files vite emits at the build root (favicon, manifest, and friends).
func (self *server) serveRoot(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path == "/" {
		http.Redirect(w, r, "/new", http.StatusFound)
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

func main() {
	handle, err := openDB(dbPath())
	if err != nil {
		log.Fatalf("open %v: %v", dbPath(), err)
	}
	defer handle.Close()
	db = handle
	if err := loadAll(); err != nil {
		log.Fatalf("load games: %v", err)
	}

	spaDir := absPath(filepath.Join("web", "dist"))
	srv := &server{spaDir: spaDir}

	mux := http.NewServeMux()
	mux.HandleFunc("/", srv.serveRoot)
	mux.HandleFunc("/assets/", srv.serveSPAAsset)
	mux.HandleFunc("/new", srv.serveSPA)
	mux.HandleFunc("/games", handleCreateGame)
	mux.HandleFunc("/game/", srv.serveFlow)
	mux.HandleFunc("/join/", srv.serveJoinPage)

	addr := listenAddr()
	log.Printf("listening on http://localhost%v (app from %v, database %v)", addr, spaDir, dbPath())
	log.Fatal(http.ListenAndServe(addr, mux))
}
