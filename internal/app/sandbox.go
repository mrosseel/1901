/*
The sandbox: a board with no players (ADR-047).

A sandbox is a Diplomacy board you play alone, with no other players, so you
can set up any position and try things out. It is a flag on an ordinary game
rather than a second kind of object: the same variants, the same map and
styles, the same adjudication, the same review, and the same public addresses
(ADR-028). What is taken off is the seat layer. Nobody joins, no deadline
runs, nothing is sealed, and one person orders every power and adjudicates.

One token in the URL is the whole of the authorisation. The holder of the link
drives the board; the bare game id stays read-only for everybody, exactly as a
real game's watch address is. It is a link and not a cookie because a
tournament hands the laptop to the next round's operator, and a director wants
to give the job away without giving away their browser.

There are no secrets here, and that is deliberate. ADR-004's commit-reveal and
the no-leak discipline exist to stop one player reading another's orders; a
sandbox has one driver and nobody to hide from. Nothing here weakens a real
game: this scope rejects a game whose flag is off, and the seat and game
master scopes reject a sandbox, so the two authorization paths never meet.
sandbox_test.go is where that is written down.
*/
package app

import (
	"encoding/json"
	"net/http"
	"spring1901/spike/internal/assets"
	"spring1901/spike/internal/httpx"
	"spring1901/spike/internal/variant"
	"strings"
	"time"

	"github.com/zond/godip"
)

// sandboxStateJSON is the whole board, for the one person driving it.
//
// It is the seat state with the filtering taken out: every power's drafted
// orders are here, keyed by province, with orderPowers saying whose each one
// is. That is not a leak of anything — the reader of this answer is the
// author of every order in it.
type sandboxStateJSON struct {
	stateJSON
	// OrderPowers says which power entered each drafted order. A seat never
	// needs it: every order in a seat's answer is that seat's own.
	OrderPowers     map[string]string `json:"orderPowers"`
	Settings        settings          `json:"settings"`
	SettingsVersion int               `json:"settingsVersion"`
	// PhaseIndex is which phase this is, counting resolved phases from zero.
	PhaseIndex    int                    `json:"phaseIndex"`
	Turns         int                    `json:"turns"`
	CreatedAt     string                 `json:"createdAt"`
	Variant       variant.RefJSON        `json:"variant"`
	ProvinceNames map[string]string      `json:"provinceNames"`
	Placements    variant.PlacementTable `json:"placements"`
	Labels        *variant.LabelPlan     `json:"labels,omitempty"`
	PreviousPhase *phaseReviewJSON       `json:"previousPhase"`
	// Result is how the game ended, null while it runs (ADR-044). A sandbox
	// declares a solo like any other board, which is what a director
	// replaying a finished round wants to see.
	Result *gameResult `json:"result"`
	// NothingToOrder names the powers this phase asks nothing of, so the
	// power switcher can say so before the driver taps one and finds an
	// empty board. In a retreat phase that is usually six of the seven.
	NothingToOrder []string `json:"nothingToOrder"`
	Now            string   `json:"now"`
	Build          string   `json:"build"`
}

// sandboxState renders the board for its driver. The caller must hold g.mu.
func (self *game) sandboxState(id string) sandboxStateJSON {
	f := self.flow
	powers := map[string]string{}
	for prov, power := range self.owner {
		powers[string(prov)] = string(power)
	}
	idle := []string{}
	for _, p := range f.powers {
		if self.nothingToOrder(p) {
			idle = append(idle, string(p))
		}
	}
	return sandboxStateJSON{
		stateJSON:       self.snapshot(id),
		OrderPowers:     powers,
		Settings:        f.settings,
		SettingsVersion: f.settingsVersion,
		PhaseIndex:      f.phaseIndex,
		Turns:           f.phaseIndex,
		CreatedAt:       f.createdAt.UTC().Format(time.RFC3339),
		Variant:         self.variantRef(),
		ProvinceNames:   self.provinceNames(),
		Placements:      self.placements(),
		Labels:          self.labels(),
		PreviousPhase:   self.previousPhase,
		Result:          f.result,
		NothingToOrder:  idle,
		Now:             serverNow(),
		Build:           assets.BuildStamp(),
	}
}

func handleSandboxState(g *game, id string, w http.ResponseWriter, r *http.Request) {
	g.mu.Lock()
	defer g.mu.Unlock()
	httpx.WriteJSON(w, http.StatusOK, g.sandboxState(id))
}

/*
handleSandboxOptions answers the option tree for one province.

Unlike the seat route it takes a power, because the driver is every power. The
province must still belong to the power named, so a typo answers with a
sentence rather than with somebody else's options.
*/
func handleSandboxOptions(g *game, id string, w http.ResponseWriter, r *http.Request) {
	prov := godip.Province(r.URL.Query().Get("province"))
	if prov == "" {
		httpx.WriteErr(w, http.StatusBadRequest, "province query parameter is required")
		return
	}
	g.mu.Lock()
	defer g.mu.Unlock()

	power, ok := g.sandboxPower(r.URL.Query().Get("power"))
	if !ok {
		httpx.WriteErr(w, http.StatusBadRequest, "unknown power %q", r.URL.Query().Get("power"))
		return
	}
	if !g.ownsProvince(power, prov) {
		httpx.WriteErr(w, http.StatusForbidden, "%v is not %v's to order", prov, power)
		return
	}
	all := g.state.Phase().Options(g.state, power)
	opts, found := all[prov.Super()]
	if !found {
		opts = godip.Options{}
	}
	httpx.WriteJSON(w, http.StatusOK, opts)
}

// sandboxOrderRequest is orderRequest plus the power giving the order. The
// caller is every power, so nothing here can be inferred from a credential.
type sandboxOrderRequest struct {
	orderRequest
	Power string `json:"power"`
}

func handleSandboxOrder(g *game, id string, w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		httpx.WriteErr(w, http.StatusMethodNotAllowed, "POST only")
		return
	}
	req := sandboxOrderRequest{}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httpx.WriteErr(w, http.StatusBadRequest, "bad body: %v", err)
		return
	}
	if req.Province == "" {
		httpx.WriteErr(w, http.StatusBadRequest, "province is required")
		return
	}
	prov := godip.Province(req.Province)

	g.mu.Lock()
	defer g.mu.Unlock()

	if g.flow.over() {
		httpx.WriteErr(w, http.StatusConflict, "the game is over")
		return
	}
	power, ok := g.sandboxPower(req.Power)
	if !ok {
		httpx.WriteErr(w, http.StatusBadRequest, "unknown power %q", req.Power)
		return
	}
	if !g.ownsProvince(power, prov) {
		httpx.WriteErr(w, http.StatusForbidden, "%v is not %v's to order", prov, power)
		return
	}
	if len(req.Parts) == 0 {
		g.clearOrder(prov)
		g.persist(id)
		httpx.WriteJSON(w, http.StatusOK, g.sandboxState(id))
		return
	}
	// ADR-029 applies here as everywhere: an illegal order is stored and
	// struck rather than refused. The sandbox is where somebody checks what
	// a move does, and refusing to draw the bad one defeats that.
	if err := g.setOrder(prov, req.Parts); err != nil {
		httpx.WriteErr(w, http.StatusBadRequest, "%v", err)
		return
	}
	g.persist(id)
	httpx.WriteJSON(w, http.StatusOK, g.sandboxState(id))
}

/*
handleSandboxAdjudicate resolves the phase.

It is the ordinary resolution path with nothing dropped: there are no seats,
so there is no lock to have missed and no NMR to write. A power the driver
left unordered holds, which is the phase's own rule for a unit with no order.
*/
func handleSandboxAdjudicate(g *game, id string, w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		httpx.WriteErr(w, http.StatusMethodNotAllowed, "POST only")
		return
	}
	g.mu.Lock()
	defer g.mu.Unlock()

	if g.flow.over() {
		httpx.WriteErr(w, http.StatusConflict, "the game is over")
		return
	}
	if err := g.adjudicate(id, false); err != nil {
		httpx.WriteErr(w, http.StatusInternalServerError, "adjudicate: %v", err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, g.sandboxState(id))
}

// sandboxPower resolves a power name from the request against the variant's
// own list. The caller must hold g.mu.
func (self *game) sandboxPower(name string) (godip.Nation, bool) {
	for _, p := range self.flow.powers {
		if string(p) == name {
			return p, true
		}
	}
	return "", false
}

var sandboxRoutes = map[string]gameHandler{
	"state":      handleSandboxState,
	"options":    handleSandboxOptions,
	"order":      handleSandboxOrder,
	"adjudicate": handleSandboxAdjudicate,
	"map.svg":    handleMap,
}

/*
serveSandboxScope answers the driver's actions, under
/api/v1/game/{id}/sandbox/{token}/{action}.

The token in the address is the whole credential, and it opens nothing that is
not a sandbox: a game with the flag off is a 404 here whatever token is sent.
*/
func (self *server) serveSandboxScope(g *game, id string, segments []string, w http.ResponseWriter, r *http.Request) {
	if len(segments) < 4 {
		http.NotFound(w, r)
		return
	}
	token := segments[2]
	action := strings.Join(segments[3:], "/")

	g.mu.Lock()
	f := g.flow
	authorized := f.settings.Sandbox && f.sandboxToken != "" && subtleEqual(token, f.sandboxToken)
	g.mu.Unlock()

	if !authorized {
		http.NotFound(w, r)
		return
	}
	if h, found := sandboxRoutes[action]; found {
		h(g, id, w, r)
		return
	}
	http.NotFound(w, r)
}
