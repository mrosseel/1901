// Command spike serves one hardcoded in-memory classical Diplomacy game.
package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
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

// game holds the single in-memory game and guards it against concurrent requests.
type game struct {
	mu    sync.Mutex
	state *state.State
	// parts keeps the raw order bits per province, for readable order strings.
	parts map[godip.Province][]string
}

var g = &game{parts: map[godip.Province][]string{}}

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
	Phase         phaseJSON           `json:"phase"`
	Units         map[string]unitJSON `json:"units"`
	Orders        map[string]string   `json:"orders"`
	Resolutions   map[string]string   `json:"resolutions"`
	SupplyCenters map[string]string   `json:"supplyCenters"`
	Nations       []string            `json:"nations"`
}

// snapshot renders the current state as JSON. The caller must hold g.mu.
func (self *game) snapshot() stateJSON {
	s := self.state
	out := stateJSON{
		Phase: phaseJSON{
			Season: string(s.Phase().Season()),
			Year:   s.Phase().Year(),
			Type:   string(s.Phase().Type()),
		},
		Units:         map[string]unitJSON{},
		Orders:        map[string]string{},
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

func handleState(w http.ResponseWriter, r *http.Request) {
	g.mu.Lock()
	defer g.mu.Unlock()
	writeJSON(w, http.StatusOK, g.snapshot())
}

func handleMap(w http.ResponseWriter, r *http.Request) {
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

func handleOptions(w http.ResponseWriter, r *http.Request) {
	prov := godip.Province(r.URL.Query().Get("province"))
	if prov == "" {
		writeErr(w, http.StatusBadRequest, "province query parameter is required")
		return
	}
	g.mu.Lock()
	defer g.mu.Unlock()

	nation := godip.Nation(r.URL.Query().Get("nation"))
	if nation == "" {
		found, ok := nationFor(g.state, prov)
		if !ok {
			writeErr(w, http.StatusNotFound, "no unit or supply center owner at %v", prov)
			return
		}
		nation = found
	}
	all := g.state.Phase().Options(g.state, nation)
	opts, found := all[prov.Super()]
	if !found {
		opts = godip.Options{}
	}
	writeJSON(w, http.StatusOK, opts)
}

type orderRequest struct {
	Province string   `json:"province"`
	Parts    []string `json:"parts"`
}

func handleOrder(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeErr(w, http.StatusMethodNotAllowed, "POST only")
		return
	}
	req := orderRequest{}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "bad body: %v", err)
		return
	}
	if req.Province == "" {
		writeErr(w, http.StatusBadRequest, "province is required")
		return
	}
	prov := godip.Province(req.Province)

	g.mu.Lock()
	defer g.mu.Unlock()

	// The Options tree repeats the source province after the order type.
	// The parser does not want it, so drop it if the client kept it.
	parts := req.Parts
	if len(parts) >= 2 && parts[1] == string(prov) {
		parts = append([]string{parts[0]}, parts[2:]...)
	}
	bits := append([]string{string(prov)}, parts...)
	order, err := classical.Parser.Parse(bits)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "cannot parse %v: %v", bits, err)
		return
	}
	if _, err := order.Validate(g.state); err != nil {
		writeErr(w, http.StatusBadRequest, "illegal order %v: %v", bits, err)
		return
	}

	// SetOrder refuses to overwrite, so rebuild the whole order map.
	next := map[godip.Province]godip.Adjudicator{}
	for p, o := range g.state.Orders() {
		if p.Super() != prov.Super() {
			next[p] = o
		}
	}
	next[prov] = order
	g.state.SetOrders(next)

	for p := range g.parts {
		if p.Super() == prov.Super() {
			delete(g.parts, p)
		}
	}
	g.parts[prov] = parts

	writeJSON(w, http.StatusOK, g.snapshot())
}

func handleAdjudicate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeErr(w, http.StatusMethodNotAllowed, "POST only")
		return
	}
	g.mu.Lock()
	defer g.mu.Unlock()

	if err := g.state.Next(); err != nil {
		writeErr(w, http.StatusInternalServerError, "adjudicate: %v", err)
		return
	}
	g.parts = map[godip.Province][]string{}
	writeJSON(w, http.StatusOK, g.snapshot())
}

// staticHandler serves the static directory, or a placeholder while it is missing.
func staticHandler(dir string) http.Handler {
	fs := http.FileServer(http.Dir(dir))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if _, err := os.Stat(dir); err != nil {
			http.Error(w, "static directory not present yet", http.StatusNotFound)
			return
		}
		fs.ServeHTTP(w, r)
	})
}

func main() {
	s, err := classical.Start()
	if err != nil {
		log.Fatalf("classical start: %v", err)
	}
	g.state = s

	dir := "static"
	if abs, err := filepath.Abs(dir); err == nil {
		dir = abs
	}
	static := staticHandler(dir)

	mux := http.NewServeMux()
	mux.Handle("/static/", http.StripPrefix("/static/", static))
	mux.Handle("/", static)
	mux.HandleFunc("/map.svg", handleMap)
	mux.HandleFunc("/state", handleState)
	mux.HandleFunc("/options", handleOptions)
	mux.HandleFunc("/order", handleOrder)
	mux.HandleFunc("/adjudicate", handleAdjudicate)

	addr := listenAddr()
	log.Printf("listening on http://localhost%v (static from %v)", addr, dir)
	log.Fatal(http.ListenAndServe(addr, mux))
}
