// A game in memory: the board, the orders on it, and what a province is
// called.
//
// Everything here is one game's own state. Who is allowed to touch it is a
// question for the flow (flow.go); how it survives a restart is a question
// for the store (save.go, load.go).

package server

import (
	"fmt"
	"sort"
	"strings"
	"sync"

	"github.com/zond/godip"
	"github.com/zond/godip/state"
	"github.com/zond/godip/variants/common"
)

// game holds one in-memory game and guards it against concurrent requests.
type game struct {
	mu    sync.Mutex
	state *state.State
	// events wakes public and role-authenticated views after a mutation. Its
	// frames are invalidations only; each view fetches its own filtered state.
	events         *gameEvents
	notifiedEvents int
	// parts keeps the raw order bits per province, for readable order strings.
	parts map[godip.Province][]string
	// owner records which power entered the order, so seat views can be
	// filtered without inspecting the board.
	owner map[godip.Province]godip.Nation
	// illegal marks the provinces whose stored order the engine refuses
	// (ADR-029). The order is kept as the player wrote it and is shown back
	// to them, but it is never in the engine's order set, so the phase's
	// ordinary invalid-order consequence applies and the review marks it.
	illegal map[godip.Province]bool
	// flow carries the GM, seat, and phase state.
	flow *flow
	// watch is one entry per resolved phase: the public per-phase history
	// the /watch URLs serve (ADR-013). It is rebuilt by replay(), so a
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
		events:     newGameEvents(),
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
// (ADR-029). It is on by default; a game whose flow is not built yet is
// strict, which is what every internal caller wants.
func (self *game) allowsIllegal() bool {
	return self.flow != nil && self.flow.settings.IllegalMoves
}

/*
setOrder stores one order, replacing any earlier order for the same province.
The caller must hold g.mu.

There are three outcomes, and the middle one is ADR-029.

An order that does not PARSE is refused. Nothing coherent can be stored from
it: the parser is what turns a list of words into an order at all, so a
failure there means the client sent something that names no order type, no
province, or the wrong number of parts. There is no player intent to keep.

An order that parses but does not VALIDATE is a misorder — Vienna ordered to
Paris, a support for a move nobody is making. Bluffing by misordering is part
of Diplomacy, so with illegalMoves on it is stored as the player wrote it and
marked illegal: it never enters the engine's order set, so at adjudication
the phase's ordinary invalid-order consequence applies and the review shows
the order struck (ADR-029). With the
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

// storeIllegal keeps a misorder as written, outside the engine (ADR-029).
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
