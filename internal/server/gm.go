// The game master's view and the five things it can do.
//
// The view is secret-free and safe for a shared screen (ADR-013): it says who
// has joined and who is waiting, never what anybody ordered. The powers are
// enumerated and every use is logged (ADR-007).

package server

import (
	"encoding/json"
	"net/http"
	"time"

	"spring1901/spike/internal/assets"
	"spring1901/spike/internal/httpx"
	"spring1901/spike/internal/variant"
)

// gmSeatJSON is one seat, as the game master's screen may show it. Booleans
// only: no device, no identity, and in a sealed game no order (ADR-013).
type gmSeatJSON struct {
	Power   string `json:"power"`
	Joined  bool   `json:"joined"`
	Locked  bool   `json:"locked"`
	IsGM    bool   `json:"isGm"`
	Centres int    `json:"centres"`
	// Revealed says this seat has released the orders behind its lock
	// (ADR-004). False on every seat of an unsealed game.
	Revealed bool `json:"revealed"`
}

type gmStateJSON struct {
	GameID          string                 `json:"gameId"`
	Settings        settings               `json:"settings"`
	SettingsVersion int                    `json:"settingsVersion"`
	Started         bool                   `json:"started"`
	Phase           phaseJSON              `json:"phase"`
	Seats           []gmSeatJSON           `json:"seats"`
	JoinedCount     int                    `json:"joinedCount"`
	TotalSeats      int                    `json:"totalSeats"`
	GMPower         *string                `json:"gmPower"`
	InviteURL       string                 `json:"inviteUrl"`
	DeadlineAt      interface{}            `json:"deadlineAt"`
	GraceUntil      interface{}            `json:"graceUntil"`
	PhaseMinutes    int                    `json:"phaseMinutes"`
	CanForce        bool                   `json:"canForce"`
	GMSeatURL       *string                `json:"gmSeatUrl"`
	Events          []string               `json:"events"`
	Variant         variant.RefJSON        `json:"variant"`
	ProvinceNames   map[string]string      `json:"provinceNames"`
	Placements      variant.PlacementTable `json:"placements"`
	Labels          *variant.LabelPlan     `json:"labels,omitempty"`
	Dislodged       map[string]unitJSON    `json:"dislodged"`
	PreviousPhase   *phaseReviewJSON       `json:"previousPhase"`
	// Result is how the game ended, null while it runs (ADR-044).
	Result       *gameResult   `json:"result"`
	DrawProposal *drawProposal `json:"drawProposal,omitempty"`
	// Sealed says this game keeps its orders on the phones until every power
	// has locked in (ADR-004). RevealOpen says that moment has come, and
	// AwaitingReveal names the seats that have not sent theirs — the flag
	// ADR-009 asks for, and the only thing the game master can act on here.
	Sealed         bool     `json:"sealed"`
	RevealOpen     bool     `json:"revealOpen"`
	AwaitingReveal []string `json:"awaitingReveal"`
	Now            string   `json:"now"`
	// Whether this game has a recovery key (ADR-048). A boolean and not the
	// key: the page needs to know which card to draw, not what the server
	// holds.
	HasGMKey bool `json:"hasGmKey"`
	// Press, and only for a game master who does not play (ADR-054). Off,
	// these are false and zero, which is the whole truth this view is
	// allowed: who is talking to whom is the game.
	PressEnabled bool `json:"pressEnabled"`
	PressReads   bool `json:"pressReads"`
	PressUnread  int  `json:"pressUnread"`
	// Which phase this is, counting resolved phases from zero. A message is
	// sealed against the phase it was written in (ADR-053), and the mailbox
	// has no other way to know which that is.
	PhaseIndex int `json:"phaseIndex"`
	// Which client build this server is serving (ADR-050). A page that sees
	// it change is running JavaScript the server has moved on from.
	Build string `json:"build"`
}

// gmState renders the GM view. The caller must hold g.mu. It contains
// booleans only — no device secrets, no orders (§ no-leak discipline).
func (self *game) gmState(id string, r *http.Request) gmStateJSON {
	f := self.flow
	out := gmStateJSON{
		GameID:          id,
		Settings:        f.settings,
		SettingsVersion: f.settingsVersion,
		Started:         f.started,
		Phase: phaseJSON{
			Season: string(self.state.Phase().Season()),
			Year:   self.state.Phase().Year(),
			Type:   string(self.state.Phase().Type()),
		},
		JoinedCount:    f.joinedCount(),
		TotalSeats:     f.joinerSeats(),
		InviteURL:      inviteURL(r, id, f.inviteToken),
		DeadlineAt:     rfc3339(f.deadlineAt),
		GraceUntil:     rfc3339(f.graceEndsAt()),
		PhaseMinutes:   f.phaseMinutes(self.state.Phase()),
		CanForce:       f.canForce(),
		Events:         f.events,
		Variant:        self.variantRef(),
		ProvinceNames:  self.provinceNames(),
		Placements:     self.placements(),
		Labels:         self.labels(),
		Dislodged:      self.dislodgedMap(),
		PreviousPhase:  self.previousPhase,
		Now:            serverNow(),
		HasGMKey:       f.gmPublicKey != "",
		PressEnabled:   f.pressEnabled(),
		PressReads:     f.settings.GMReadsPress,
		PhaseIndex:     f.phaseIndex,
		Result:         f.result,
		DrawProposal:   f.drawProposal,
		Sealed:         f.sealed,
		RevealOpen:     f.revealOpen(),
		AwaitingReveal: nations(f.awaitingReveal()),
		Build:          assets.BuildStamp(),
	}
	for _, p := range f.powers {
		s := f.seats[p]
		out.Seats = append(out.Seats, gmSeatJSON{
			Power:    string(p),
			Joined:   s.claimed(),
			Locked:   s.locked,
			IsGM:     s.isGM,
			Centres:  self.centreCounts()[string(p)],
			Revealed: s.revealed,
		})
	}
	if f.settings.GMReadsPress {
		out.PressUnread = f.pressUnread(gmActor())
	}
	if f.gmPower != "" {
		power := string(f.gmPower)
		out.GMPower = &power
		if s := f.seats[f.gmPower]; s.token != "" {
			url := seatURL(r, id, s.token)
			out.GMSeatURL = &url
		}
	}
	return out
}

func handleGMState(g *game, id string, w http.ResponseWriter, r *http.Request) {
	g.mu.Lock()
	defer g.mu.Unlock()
	httpx.WriteJSON(w, http.StatusOK, g.gmState(id, r))
}

func handleGMSettings(g *game, id string, w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		httpx.WriteErr(w, http.StatusMethodNotAllowed, "POST only")
		return
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	f := g.flow

	old := f.settings
	neu, err := decodeSettings(r, old)
	if err != nil {
		httpx.WriteErr(w, http.StatusBadRequest, "bad body: %v", err)
		return
	}
	if f.started && neu.GMPlays != old.GMPlays {
		httpx.WriteErr(w, http.StatusConflict, "gmPlays cannot change after the game has started")
		return
	}
	// The press mode is part of the rules the table agreed to play under
	// (ADR-023), so it is fixed at start the way gmPlays is.
	if f.started && neu.PressMode != old.PressMode {
		httpx.WriteErr(w, http.StatusConflict, "the press mode cannot change after the game has started")
		return
	}
	// Whether the game master reads press is fixed at start for a harder
	// reason than agreement (ADR-054): every room key already handed out was
	// wrapped for the holders this setting names. Turning it on later would
	// promise a mailbox that no existing room has a key for, and turning it
	// off would not take back the keys already sent.
	if f.started && neu.GMReadsPress != old.GMReadsPress {
		httpx.WriteErr(w, http.StatusConflict,
			"whether the game master reads press cannot change after the game has started")
		return
	}
	// The mailbox is opened with the game master's own key (ADR-048, ADR-054).
	// Without one there is nothing to wrap a room key for, and every room in
	// the game would be refused for a setting nobody could still change.
	if neu.GMReadsPress && !old.GMReadsPress && f.gmPublicKey == "" {
		httpx.WriteErr(w, http.StatusConflict,
			"make the game master key first — the mailbox is opened with it")
		return
	}
	if neu.Variant != old.Variant {
		httpx.WriteErr(w, http.StatusConflict, "the variant is fixed when the game is created")
		return
	}
	// The name is not a rule. It changes nothing about how the game is
	// played, so it does not bump the settings version and no seat is told
	// "the rules changed" over it. It is still a game master act, so it is
	// logged (ADR-007).
	renamed := neu.Name != old.Name
	if renamed {
		f.settings.Name = neu.Name
		if neu.Name == "" {
			f.logEvent(id, "game name cleared")
		} else {
			f.logEvent(id, "game renamed to %q", neu.Name)
		}
	}
	old.Name = neu.Name
	if neu == old {
		if renamed {
			g.persist(id)
		}
		httpx.WriteJSON(w, http.StatusOK, g.gmState(id, r))
		return
	}
	f.settings = neu
	f.settingsVersion++
	f.logEvent(id, "settings changed to deadlineMinutes=%v gmPlays=%v "+
		"retreatBuildPercent=%v graceMinutes=%v firstTurnExtraMinutes=%v endYear=%v "+
		"pressMode=%v pressSilenceSeconds=%v gmReadsPress=%v illegalMoves=%v (version %v)",
		neu.DeadlineMinutes, neu.GMPlays, neu.RetreatBuildPercent, neu.GraceMinutes,
		neu.FirstTurnExtraMinutes, neu.EndYear, neu.PressMode, neu.PressSilenceSeconds,
		neu.GMReadsPress, neu.IllegalMoves, f.settingsVersion)
	// A change to the clock takes effect on the phase now running, so the
	// table sees the rule it was just told about rather than the next one.
	if f.started && !f.over() && (neu.DeadlineMinutes != old.DeadlineMinutes ||
		neu.RetreatBuildPercent != old.RetreatBuildPercent ||
		neu.FirstTurnExtraMinutes != old.FirstTurnExtraMinutes) {
		f.resetDeadline(g.state.Phase(), 0)
		f.logEvent(id, "deadline reset to %v under the new clock", rfc3339(f.deadlineAt))
	}
	g.persist(id)
	httpx.WriteJSON(w, http.StatusOK, g.gmState(id, r))
}

func handleGMStart(g *game, id string, w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		httpx.WriteErr(w, http.StatusMethodNotAllowed, "POST only")
		return
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	f := g.flow

	if f.started {
		httpx.WriteErr(w, http.StatusConflict, "the game has already started")
		return
	}
	if f.joinedCount() < f.joinerSeats() {
		httpx.WriteErr(w, http.StatusConflict, "only %v of %v seats are claimed",
			f.joinedCount(), f.joinerSeats())
		return
	}
	// The setting cannot change after this moment (handleGMSettings), so a
	// game that starts without the key its mailbox is opened with is a game
	// whose rooms are all refused for the rest of the evening.
	if f.settings.GMReadsPress && f.gmPublicKey == "" {
		httpx.WriteErr(w, http.StatusConflict,
			"this game master reads press but has no key — make it before starting")
		return
	}

	if f.settings.GMPlays {
		free := f.unassignedPowers()
		if len(free) != 1 {
			httpx.WriteErr(w, http.StatusInternalServerError, "expected one leftover power, found %v", len(free))
			return
		}
		// The leftover, never drawn from the pool (ADR-021).
		power := free[0]
		token, err := newToken()
		if err != nil {
			httpx.WriteErr(w, http.StatusInternalServerError, "tokens: %v", err)
			return
		}
		s := f.seats[power]
		s.token = token
		s.isGM = true
		f.bySeatToken[token] = power
		f.gmPower = power
		f.logEvent(id, "GM takes the leftover power %v", power)
	}

	f.started = true
	f.resetDeadline(g.state.Phase(), 0)
	f.logEvent(id, "game started, %v has %v minute(s) until %v",
		g.state.Phase().Type(), f.phaseMinutes(g.state.Phase()), rfc3339(f.deadlineAt))
	if err := g.enterPhase(id); err != nil {
		httpx.WriteErr(w, http.StatusInternalServerError, "adjudicate: %v", err)
		return
	}
	g.persist(id)
	httpx.WriteJSON(w, http.StatusOK, g.gmState(id, r))
}

func handleGMForce(g *game, id string, w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		httpx.WriteErr(w, http.StatusMethodNotAllowed, "POST only")
		return
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	f := g.flow

	if !f.started {
		httpx.WriteErr(w, http.StatusConflict, "the game has not started")
		return
	}
	if f.over() {
		httpx.WriteErr(w, http.StatusConflict, "the game is over")
		return
	}
	if !f.canForce() {
		httpx.WriteErr(w, http.StatusConflict,
			"force adjudication is locked until the deadline and grace period have passed")
		return
	}
	if err := g.adjudicate(id, true); err != nil {
		httpx.WriteErr(w, http.StatusInternalServerError, "adjudicate: %v", err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, g.gmState(id, r))
}

func handleGMExtend(g *game, id string, w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		httpx.WriteErr(w, http.StatusMethodNotAllowed, "POST only")
		return
	}
	body := struct {
		Minutes int `json:"minutes"`
	}{}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		httpx.WriteErr(w, http.StatusBadRequest, "bad body: %v", err)
		return
	}
	if body.Minutes < 1 {
		// A negative value would move the deadline into the past and open
		// force adjudication early (SECURITY.md, open findings).
		httpx.WriteErr(w, http.StatusBadRequest, "minutes must be a positive number")
		return
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	f := g.flow

	if f.over() {
		httpx.WriteErr(w, http.StatusConflict, "the game is over")
		return
	}
	from := time.Now()
	if f.deadlineAt != nil && f.deadlineAt.After(from) {
		from = *f.deadlineAt
	}
	at := from.Add(time.Duration(body.Minutes) * time.Minute)
	f.deadlineAt = &at
	f.logEvent(id, "deadline extended by %v minutes to %v", body.Minutes, at.UTC().Format(time.RFC3339))
	g.persist(id)
	httpx.WriteJSON(w, http.StatusOK, g.gmState(id, r))
}
