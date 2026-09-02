// One seat's view, and the four things a player does from it.
//
// A seat sees its own orders and nobody else's until the phase resolves
// (ADR-004). Locking is a replaceable finalize: a locked seat may unlock and
// order again for as long as the phase is open (ADR-011).

package server

import (
	"encoding/json"
	"net/http"
	"sort"
	"time"

	"github.com/zond/godip"

	"spring1901/spike/internal/httpx"
	"spring1901/spike/internal/variant"
)

type youJSON struct {
	Power string `json:"power"`
}

type seatStateJSON struct {
	stateJSON
	You             youJSON         `json:"you"`
	Settings        settings        `json:"settings"`
	SettingsVersion int             `json:"settingsVersion"`
	Started         bool            `json:"started"`
	DeadlineAt      interface{}     `json:"deadlineAt"`
	GraceUntil      interface{}     `json:"graceUntil"`
	PhaseMinutes    int             `json:"phaseMinutes"`
	Locked          map[string]bool `json:"locked"`
	YouLocked       bool            `json:"youLocked"`
	// YouAreGM says this seat is the game master's own (ADR-021). The seat
	// menu shows two handovers rather than one when it is: the role and the
	// power are different acts and this device holds both.
	YouAreGM bool `json:"youAreGm"`
	// What the seat menu says about the game it belongs to (ADR-041): how
	// many turns have been played, and when the game was made.
	Turns     int    `json:"turns"`
	CreatedAt string `json:"createdAt"`
	// NothingToOrder says this seat was locked by the server because its
	// power has no legal order this phase (ADR-034). The screen must say so;
	// a seat that finds itself locked with no explanation reads as a bug.
	NothingToOrder bool `json:"nothingToOrder"`
	LockedCount    int  `json:"lockedCount"`
	TotalSeats     int  `json:"totalSeats"`
	// JoinedCount and SeatsOnOffer are the table filling up, for the screen a
	// player sits on before the start. TotalSeats cannot say it: it counts the
	// seats that must lock, which is the wrong denominator before a phase
	// exists and, when the GM plays, excludes a seat that is not handed out.
	// Both numbers are already public on /public, and neither says WHICH
	// powers are taken — that stays unsaid (ADR-020, ADR-021).
	JoinedCount      int                    `json:"joinedCount"`
	SeatsOnOffer     int                    `json:"seatsOnOffer"`
	PhaseResolutions map[string]string      `json:"phaseResolutions"`
	CanForce         bool                   `json:"canForce"`
	Variant          variant.RefJSON        `json:"variant"`
	ProvinceNames    map[string]string      `json:"provinceNames"`
	Placements       variant.PlacementTable `json:"placements"`
	Labels           *variant.LabelPlan     `json:"labels,omitempty"`
	PreviousPhase    *phaseReviewJSON       `json:"previousPhase"`
	// Result is how the game ended, null while it runs (ADR-044).
	Result *gameResult `json:"result"`
	// A non-DIAS proposal is visible to every seat; excluded survivors answer
	// it from their own authenticated board.
	DrawProposal *drawProposal `json:"drawProposal,omitempty"`
	// PhaseIndex is which phase this is, counting resolved phases from zero.
	// A phone needs it to hash a commitment, because a hash is bound to the
	// phase it was made in (ADR-004).
	PhaseIndex int `json:"phaseIndex"`
	// How this game takes orders (ADR-004). Sealed means this phone holds the
	// draft and sends a hash; RevealOpen means every power has locked in and
	// this phone should send what is behind its own hash; YouRevealed says it
	// already has. AwaitingReveal is public — it names seats, never orders.
	Sealed         bool     `json:"sealed"`
	RevealOpen     bool     `json:"revealOpen"`
	YouRevealed    bool     `json:"youRevealed"`
	AwaitingReveal []string `json:"awaitingReveal"`
	Now            string   `json:"now"`
	// Press, in the smallest form that keeps the bar honest (ADR-053). The
	// unread count and whether a message may be sent right now ride on the
	// state the seat already polls, so the bar costs no request of its own.
	// Message bodies come from the press routes and never from here.
	PressEnabled   bool        `json:"pressEnabled"`
	PressUnread    int         `json:"pressUnread"`
	PressOpen      bool        `json:"pressOpen"`
	PressReason    string      `json:"pressReason,omitempty"`
	PressSilenceAt interface{} `json:"pressSilenceAt"`
	// RefereeURL is set only for the GM's own seat: the seat that holds
	// the GM rights may link back to the GM view. It is how the GM
	// switches between the board and the controls.
	RefereeURL string `json:"refereeUrl,omitempty"`
}

// seatState renders the board for one seat. The caller must hold g.mu.
// Orders are filtered to the seat's own power; nothing here can expose
// another power's current-phase orders (§ no-leak discipline).
func (self *game) seatState(id string, power godip.Nation, r *http.Request) seatStateJSON {
	f := self.flow
	base := self.snapshot(id)

	own := map[string]string{}
	ownParts := map[string][]string{}
	ownIllegal := []string{}
	for prov, bits := range self.parts {
		if self.owner[prov] != power {
			continue
		}
		own[string(prov)] = self.describe(prov, bits)
		ownParts[string(prov)] = bits
		if self.illegal[prov] {
			ownIllegal = append(ownIllegal, string(prov))
		}
	}
	sort.Strings(ownIllegal)
	base.Orders = own
	base.OrderParts = ownParts
	// Which of the seat's OWN orders are illegal. The whole-board list would
	// say which provinces another power has misordered, which is a draft
	// order by another name (§ no-leak discipline).
	base.Illegal = ownIllegal

	referee := ""
	// The GM view URL goes to the GM's seat and to no other seat. It is
	// the same rule the GM state follows: the token reaches the GM only.
	if f.gmPower != "" && f.gmPower == power {
		referee = gmURL(r, id, f.gmToken)
	}

	pressOpen, pressReason := false, ""
	if f.pressEnabled() {
		pressOpen, pressReason = self.pressWritableNow(seatActor(power))
	}

	return seatStateJSON{
		stateJSON:        base,
		You:              youJSON{Power: string(power)},
		Settings:         f.settings,
		SettingsVersion:  f.settingsVersion,
		Started:          f.started,
		DeadlineAt:       rfc3339(f.deadlineAt),
		GraceUntil:       rfc3339(f.graceEndsAt()),
		PhaseMinutes:     f.phaseMinutes(self.state.Phase()),
		Locked:           f.lockedMap(),
		YouLocked:        f.seats[power].locked,
		YouAreGM:         f.seats[power].isGM,
		Turns:            f.phaseIndex,
		CreatedAt:        f.createdAt.UTC().Format(time.RFC3339),
		NothingToOrder:   f.seats[power].autoLocked,
		LockedCount:      f.lockedCount(),
		TotalSeats:       f.activeSeats(),
		JoinedCount:      f.joinedCount(),
		SeatsOnOffer:     f.joinerSeats(),
		PhaseResolutions: base.Resolutions,
		CanForce:         f.canForce(),
		Variant:          self.variantRef(),
		ProvinceNames:    self.provinceNames(),
		Placements:       self.placements(),
		Labels:           self.labels(),
		PreviousPhase:    self.previousPhase,
		Result:           f.result,
		DrawProposal:     f.drawProposal,
		PhaseIndex:       f.phaseIndex,
		Sealed:           f.sealed,
		RevealOpen:       f.revealOpen(),
		YouRevealed:      f.seats[power].revealed,
		AwaitingReveal:   nations(f.awaitingReveal()),
		Now:              serverNow(),
		RefereeURL:       referee,
		PressEnabled:     f.pressEnabled(),
		PressUnread:      f.pressUnread(seatActor(power)),
		PressOpen:        pressOpen,
		PressReason:      pressReason,
		PressSilenceAt:   rfc3339(f.pressSilenceAt()),
	}
}

type seatHandler func(g *game, id string, power godip.Nation, w http.ResponseWriter, r *http.Request)

func handleSeatState(g *game, id string, power godip.Nation, w http.ResponseWriter, r *http.Request) {
	g.mu.Lock()
	defer g.mu.Unlock()
	httpx.WriteJSON(w, http.StatusOK, g.seatState(id, power, r))
}

// ownsProvince reports whether the seat's power may order the given province.
func (self *game) ownsProvince(power godip.Nation, prov godip.Province) bool {
	found, ok := nationFor(self.state, prov)
	return ok && found == power
}

func handleSeatOptions(g *game, id string, power godip.Nation, w http.ResponseWriter, r *http.Request) {
	// There is no nation parameter on this endpoint by design. Rejecting
	// it loudly keeps a stale client from believing it worked.
	if r.URL.Query().Get("nation") != "" || r.URL.Query().Get("power") != "" {
		httpx.WriteErr(w, http.StatusForbidden, "a seat may only read its own power's options")
		return
	}
	prov := godip.Province(r.URL.Query().Get("province"))
	if prov == "" {
		httpx.WriteErr(w, http.StatusBadRequest, "province query parameter is required")
		return
	}
	g.mu.Lock()
	defer g.mu.Unlock()

	if !g.ownsProvince(power, prov) {
		httpx.WriteErr(w, http.StatusForbidden, "%v is not yours to order", prov)
		return
	}
	all := g.state.Phase().Options(g.state, power)
	opts, found := all[prov.Super()]
	if !found {
		opts = godip.Options{}
	}
	httpx.WriteJSON(w, http.StatusOK, opts)
}

func handleSeatOrder(g *game, id string, power godip.Nation, w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		httpx.WriteErr(w, http.StatusMethodNotAllowed, "POST only")
		return
	}
	req := orderRequest{}
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

	if !g.flow.started {
		httpx.WriteErr(w, http.StatusConflict, "the game has not started")
		return
	}
	if g.flow.over() {
		httpx.WriteErr(w, http.StatusConflict, "the game is over")
		return
	}
	if g.flow.sealed {
		// A sealed game has no server-side draft to write to (ADR-004,
		// ADR-011). The orders are on the phone until the reveal.
		httpx.WriteErr(w, http.StatusConflict,
			"this game keeps its orders on the phone until every power has locked in")
		return
	}
	if !g.ownsProvince(power, prov) {
		httpx.WriteErr(w, http.StatusForbidden, "%v is not yours to order", prov)
		return
	}
	if len(req.Parts) == 0 {
		g.clearOrder(prov)
		g.persist(id)
		httpx.WriteJSON(w, http.StatusOK, g.seatState(id, power, r))
		return
	}
	if err := g.setOrder(prov, req.Parts); err != nil {
		httpx.WriteErr(w, http.StatusBadRequest, "%v", err)
		return
	}
	g.persist(id)
	httpx.WriteJSON(w, http.StatusOK, g.seatState(id, power, r))
}

func handleSeatLock(g *game, id string, power godip.Nation, w http.ResponseWriter, r *http.Request) {
	g.seatLock(id, power, true, w, r)
}

func handleSeatUnlock(g *game, id string, power godip.Nation, w http.ResponseWriter, r *http.Request) {
	g.seatLock(id, power, false, w, r)
}

func (self *game) seatLock(id string, power godip.Nation, want bool, w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		httpx.WriteErr(w, http.StatusMethodNotAllowed, "POST only")
		return
	}
	// In a sealed game the lock IS the commit (ADR-011), so the same two
	// addresses answer with the same word in front of the player and a hash
	// behind it. One act, one button, two implementations.
	if self.flow.sealed {
		if want {
			handleSeatCommit(self, id, power, w, r)
		} else {
			handleSeatUncommit(self, id, power, w, r)
		}
		return
	}
	self.mu.Lock()
	defer self.mu.Unlock()
	f := self.flow

	if !f.started {
		httpx.WriteErr(w, http.StatusConflict, "the game has not started")
		return
	}
	if f.over() {
		httpx.WriteErr(w, http.StatusConflict, "the game is over")
		return
	}
	if !want && f.seats[power].autoLocked {
		httpx.WriteErr(w, http.StatusConflict,
			"%v has no order to give this phase, so this seat stays locked", power)
		return
	}
	f.seats[power].locked = want
	if want {
		f.logEvent(id, "%v locked", power)
	} else {
		f.logEvent(id, "%v withdrew its lock", power)
	}

	// Every power locked: resolve at once (ADR-008).
	if want && f.lockedCount() >= f.activeSeats() {
		if err := self.adjudicate(id, false); err != nil {
			httpx.WriteErr(w, http.StatusInternalServerError, "adjudicate: %v", err)
			return
		}
	} else {
		self.persist(id)
	}
	httpx.WriteJSON(w, http.StatusOK, self.seatState(id, power, r))
}
