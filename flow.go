// M1 game flow: GM setup, one shared invite, random anonymous seats,
// per-seat order scoping, finalize, and adjudication.
//
// See M1-CONTRACT.md and DESIGN.md D-020, D-021, D-022, D-011, D-010, D-008.
package main

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"log"
	"math/big"
	"net/http"
	"strings"
	"time"

	"github.com/zond/godip"
	"github.com/zond/godip/variants/common"
)

// tokenBytes is the entropy per token. The contract requires at least 16.
const tokenBytes = 24

// newToken returns a URL-safe random token.
func newToken() (string, error) {
	b := make([]byte, tokenBytes)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

// newGameID returns a short random id that satisfies idPattern.
const idAlphabet = "abcdefghijkmnpqrstuvwxyz23456789"

func newGameID() (string, error) {
	b := make([]byte, 10)
	for i := range b {
		n, err := rand.Int(rand.Reader, big.NewInt(int64(len(idAlphabet))))
		if err != nil {
			return "", err
		}
		b[i] = idAlphabet[n.Int64()]
	}
	return string(b), nil
}

// settings are the game rules the GM fixes before inviting (D-022).
type settings struct {
	DeadlineMinutes int    `json:"deadlineMinutes"`
	GMPlays         bool   `json:"gmPlays"`
	Variant         string `json:"variant"`
}

// seat is one power in one game together with its claim state.
// It deliberately carries no player name (D-020).
type seat struct {
	power     godip.Nation
	token     string // seatToken, empty until claimed
	device    string // device secret, empty until claimed
	isGM      bool
	finalized bool
}

// flow holds the M1 state that sits on top of the godip board.
// Every field is guarded by the enclosing game's mutex.
type flow struct {
	gmToken     string
	inviteToken string

	settings        settings
	settingsVersion int

	started    bool
	deadlineAt *time.Time

	seats       map[godip.Nation]*seat
	bySeatToken map[string]godip.Nation
	byDevice    map[string]godip.Nation
	gmPower     godip.Nation // empty until start, and always empty when !gmPlays

	// powers are this variant's powers, in a stable order. The seat count
	// follows the variant, so nothing here assumes seven.
	powers []godip.Nation

	// phaseIndex counts completed adjudications. It keys the stored order
	// history that replay() feeds back into godip.
	phaseIndex int
	createdAt  time.Time

	events []string
	// persistedEvents is how many events are already in the database.
	persistedEvents int
}

func newFlow(s settings, v common.Variant) (*flow, error) {
	gmToken, err := newToken()
	if err != nil {
		return nil, err
	}
	inviteToken, err := newToken()
	if err != nil {
		return nil, err
	}
	f := &flow{
		gmToken:     gmToken,
		inviteToken: inviteToken,
		settings:    s,
		createdAt:   time.Now().UTC(),
		powers:      sortedNations(v),
		seats:       map[godip.Nation]*seat{},
		bySeatToken: map[string]godip.Nation{},
		byDevice:    map[string]godip.Nation{},
	}
	for _, power := range f.powers {
		f.seats[power] = &seat{power: power}
	}
	return f, nil
}

// logEvent appends to the append-only event log (D-007).
func (self *flow) logEvent(id, format string, args ...interface{}) {
	line := fmt.Sprintf("%v %v", time.Now().UTC().Format(time.RFC3339), fmt.Sprintf(format, args...))
	self.events = append(self.events, line)
	log.Printf("game %v: %v", id, line)
}

// joinerSeats is how many powers the invite may hand out. When the GM
// plays, one power stays behind as the leftover (D-021).
func (self *flow) joinerSeats() int {
	if self.settings.GMPlays {
		return len(self.powers) - 1
	}
	return len(self.powers)
}

func (self *flow) joinedCount() int {
	n := 0
	for _, s := range self.seats {
		if s.token != "" && !s.isGM {
			n++
		}
	}
	return n
}

func (self *flow) finalizedCount() int {
	n := 0
	for _, s := range self.seats {
		if s.finalized {
			n++
		}
	}
	return n
}

// activeSeats is how many seats must finalize before the phase resolves.
func (self *flow) activeSeats() int {
	n := 0
	for _, s := range self.seats {
		if s.token != "" {
			n++
		}
	}
	return n
}

func (self *flow) finalizedMap() map[string]bool {
	out := map[string]bool{}
	for _, p := range self.powers {
		out[string(p)] = self.seats[p].finalized
	}
	return out
}

// canForce reports whether the GM may force adjudication (D-007, D-010).
func (self *flow) canForce() bool {
	if !self.started {
		return false
	}
	active := self.activeSeats()
	if active == 0 {
		return false
	}
	done := self.finalizedCount()
	if done >= active {
		// Auto-adjudication already covers this case (D-008).
		return false
	}
	if done >= active-1 {
		return true
	}
	return self.deadlineAt != nil && time.Now().After(*self.deadlineAt)
}

// unassignedPowers lists the powers the invite may still hand out.
func (self *flow) unassignedPowers() []godip.Nation {
	out := []godip.Nation{}
	for _, p := range self.powers {
		if self.seats[p].token == "" {
			out = append(out, p)
		}
	}
	return out
}

// resetDeadline restarts the clock for a new phase.
func (self *flow) resetDeadline() {
	if self.settings.DeadlineMinutes <= 0 {
		self.deadlineAt = nil
		return
	}
	at := time.Now().Add(time.Duration(self.settings.DeadlineMinutes) * time.Minute)
	self.deadlineAt = &at
}

func rfc3339(t *time.Time) interface{} {
	if t == nil {
		return nil
	}
	return t.UTC().Format(time.RFC3339)
}

// baseURL rebuilds the absolute origin of the request.
func baseURL(r *http.Request) string {
	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	}
	if forwarded := r.Header.Get("X-Forwarded-Proto"); forwarded != "" {
		scheme = forwarded
	}
	return scheme + "://" + r.Host
}

func inviteURL(r *http.Request, id, token string) string {
	return fmt.Sprintf("%v/join/%v/%v", baseURL(r), id, token)
}

func seatURL(r *http.Request, id, token string) string {
	return fmt.Sprintf("%v/game/%v/seat/%v/", baseURL(r), id, token)
}

func gmURL(r *http.Request, id, token string) string {
	return fmt.Sprintf("%v/game/%v/gm/%v/", baseURL(r), id, token)
}

// deviceCookieName keeps one device secret per game, so one browser can
// hold seats in several games.
func deviceCookieName(id string) string {
	return "d1901_" + id
}

// settingsEnvelope accepts both {"deadlineMinutes":..,"gmPlays":..} and
// the wrapped {"settings":{...}} shape.
type settingsEnvelope struct {
	Settings        *settings `json:"settings"`
	DeadlineMinutes *int      `json:"deadlineMinutes"`
	GMPlays         *bool     `json:"gmPlays"`
	Variant         *string   `json:"variant"`
}

// merge applies the envelope on top of the given settings.
func (self settingsEnvelope) merge(base settings) settings {
	if self.Settings != nil {
		base = *self.Settings
	}
	if self.DeadlineMinutes != nil {
		base.DeadlineMinutes = *self.DeadlineMinutes
	}
	if self.GMPlays != nil {
		base.GMPlays = *self.GMPlays
	}
	if self.Variant != nil {
		base.Variant = *self.Variant
	}
	if base.DeadlineMinutes < 0 {
		base.DeadlineMinutes = 0
	}
	if base.Variant == "" {
		base.Variant = defaultVariant
	}
	return base
}

func decodeSettings(r *http.Request, base settings) (settings, error) {
	env := settingsEnvelope{}
	if r.Body == nil {
		return base, nil
	}
	if err := json.NewDecoder(r.Body).Decode(&env); err != nil {
		return base, err
	}
	return env.merge(base), nil
}

// ---------------------------------------------------------------- creation

type createResponse struct {
	GameID    string         `json:"gameId"`
	GMToken   string         `json:"gmToken"`
	InviteURL string         `json:"inviteUrl"`
	GMURL     string         `json:"gmUrl"`
	Variant   variantRefJSON `json:"variant"`
}

func handleCreateGame(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeErr(w, http.StatusMethodNotAllowed, "POST only")
		return
	}
	s, err := decodeSettings(r, settings{DeadlineMinutes: 0, GMPlays: false, Variant: defaultVariant})
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad body: %v", err)
		return
	}
	v, found := lookupVariant(s.Variant)
	if !found {
		writeErr(w, http.StatusBadRequest, "unknown variant %q", s.Variant)
		return
	}
	f, err := newFlow(s, v)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "tokens: %v", err)
		return
	}
	g, id, err := games.create(s.Variant, v, f)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "create game: %v", err)
		return
	}
	g.mu.Lock()
	f.logEvent(id, "game created on %v, deadlineMinutes=%v gmPlays=%v",
		v.Name, s.DeadlineMinutes, s.GMPlays)
	if !supportedVariants[s.Variant] {
		f.logEvent(id, "%v is experimental — unit placement on the map is not verified", v.Name)
	}
	g.persist(id)
	g.mu.Unlock()

	writeJSON(w, http.StatusOK, createResponse{
		GameID:    id,
		GMToken:   f.gmToken,
		InviteURL: inviteURL(r, id, f.inviteToken),
		GMURL:     gmURL(r, id, f.gmToken),
		Variant:   g.variantRef(),
	})
}

// -------------------------------------------------------------------- join

type joinResponse struct {
	SeatURL string `json:"seatUrl"`
}

func handleJoin(g *game, id, token string, w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeErr(w, http.StatusMethodNotAllowed, "POST only")
		return
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	f := g.flow

	if token != f.inviteToken {
		http.NotFound(w, r)
		return
	}

	// Everything below runs under the game lock, so two simultaneous
	// scans can never draw the same power (D-020).
	device := ""
	if c, err := r.Cookie(deviceCookieName(id)); err == nil {
		device = c.Value
	}
	if device != "" {
		if power, found := f.byDevice[device]; found {
			writeJSON(w, http.StatusOK, joinResponse{SeatURL: seatURL(r, id, f.seats[power].token)})
			return
		}
	}

	free := f.unassignedPowers()
	if f.settings.GMPlays {
		// Hold one power back for the GM; it is never drawn (D-021).
		if len(free) <= 1 {
			free = nil
		}
	}
	if len(free) == 0 {
		writeErr(w, http.StatusConflict, "every power is taken — ask the GM for a seat")
		return
	}

	pick, err := rand.Int(rand.Reader, big.NewInt(int64(len(free))))
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "random: %v", err)
		return
	}
	power := free[pick.Int64()]

	seatToken, err := newToken()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "tokens: %v", err)
		return
	}
	if device == "" {
		device, err = newToken()
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "tokens: %v", err)
			return
		}
	}

	s := f.seats[power]
	s.token = seatToken
	s.device = device
	f.bySeatToken[seatToken] = power
	f.byDevice[device] = power
	f.logEvent(id, "seat claimed (%v of %v)", f.joinedCount(), f.joinerSeats())
	g.persist(id)

	http.SetCookie(w, &http.Cookie{
		Name:     deviceCookieName(id),
		Value:    device,
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   60 * 60 * 24 * 30,
	})
	writeJSON(w, http.StatusOK, joinResponse{SeatURL: seatURL(r, id, seatToken)})
}

// ---------------------------------------------------------------------- GM

type gmSeatJSON struct {
	Power     string `json:"power"`
	Joined    bool   `json:"joined"`
	Finalized bool   `json:"finalized"`
	IsGM      bool   `json:"isGm"`
}

type gmStateJSON struct {
	GameID          string              `json:"gameId"`
	Settings        settings            `json:"settings"`
	SettingsVersion int                 `json:"settingsVersion"`
	Started         bool                `json:"started"`
	Phase           phaseJSON           `json:"phase"`
	Seats           []gmSeatJSON        `json:"seats"`
	JoinedCount     int                 `json:"joinedCount"`
	TotalSeats      int                 `json:"totalSeats"`
	GMPower         *string             `json:"gmPower"`
	InviteURL       string              `json:"inviteUrl"`
	DeadlineAt      interface{}         `json:"deadlineAt"`
	CanForce        bool                `json:"canForce"`
	GMSeatURL       *string             `json:"gmSeatUrl"`
	Events          []string            `json:"events"`
	Variant         variantRefJSON      `json:"variant"`
	ProvinceNames   map[string]string   `json:"provinceNames"`
	Dislodged       map[string]unitJSON `json:"dislodged"`
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
		JoinedCount:   f.joinedCount(),
		TotalSeats:    f.joinerSeats(),
		InviteURL:     inviteURL(r, id, f.inviteToken),
		DeadlineAt:    rfc3339(f.deadlineAt),
		CanForce:      f.canForce(),
		Events:        f.events,
		Variant:       self.variantRef(),
		ProvinceNames: self.provinceNames(),
		Dislodged:     self.dislodgedMap(),
	}
	for _, p := range f.powers {
		s := f.seats[p]
		out.Seats = append(out.Seats, gmSeatJSON{
			Power:     string(p),
			Joined:    s.token != "",
			Finalized: s.finalized,
			IsGM:      s.isGM,
		})
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
	writeJSON(w, http.StatusOK, g.gmState(id, r))
}

func handleGMSettings(g *game, id string, w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeErr(w, http.StatusMethodNotAllowed, "POST only")
		return
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	f := g.flow

	old := f.settings
	neu, err := decodeSettings(r, old)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad body: %v", err)
		return
	}
	if f.started && neu.GMPlays != old.GMPlays {
		writeErr(w, http.StatusConflict, "gmPlays cannot change after the game has started")
		return
	}
	if neu.Variant != old.Variant {
		writeErr(w, http.StatusConflict, "the variant is fixed when the game is created")
		return
	}
	if neu == old {
		writeJSON(w, http.StatusOK, g.gmState(id, r))
		return
	}
	f.settings = neu
	f.settingsVersion++
	f.logEvent(id, "settings changed to deadlineMinutes=%v gmPlays=%v (version %v)",
		neu.DeadlineMinutes, neu.GMPlays, f.settingsVersion)
	if f.started && neu.DeadlineMinutes != old.DeadlineMinutes {
		f.resetDeadline()
	}
	g.persist(id)
	writeJSON(w, http.StatusOK, g.gmState(id, r))
}

func handleGMStart(g *game, id string, w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeErr(w, http.StatusMethodNotAllowed, "POST only")
		return
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	f := g.flow

	if f.started {
		writeErr(w, http.StatusConflict, "the game has already started")
		return
	}
	if f.joinedCount() < f.joinerSeats() {
		writeErr(w, http.StatusConflict, "only %v of %v seats are claimed",
			f.joinedCount(), f.joinerSeats())
		return
	}

	if f.settings.GMPlays {
		free := f.unassignedPowers()
		if len(free) != 1 {
			writeErr(w, http.StatusInternalServerError, "expected one leftover power, found %v", len(free))
			return
		}
		// The leftover, never drawn from the pool (D-021).
		power := free[0]
		token, err := newToken()
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "tokens: %v", err)
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
	f.resetDeadline()
	f.logEvent(id, "game started")
	g.persist(id)
	writeJSON(w, http.StatusOK, g.gmState(id, r))
}

func handleGMForce(g *game, id string, w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeErr(w, http.StatusMethodNotAllowed, "POST only")
		return
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	f := g.flow

	if !f.started {
		writeErr(w, http.StatusConflict, "the game has not started")
		return
	}
	if !f.canForce() {
		writeErr(w, http.StatusConflict,
			"force adjudication is locked until the deadline passes or all but one power has finalized")
		return
	}
	if err := g.adjudicate(id, true); err != nil {
		writeErr(w, http.StatusInternalServerError, "adjudicate: %v", err)
		return
	}
	writeJSON(w, http.StatusOK, g.gmState(id, r))
}

func handleGMExtend(g *game, id string, w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeErr(w, http.StatusMethodNotAllowed, "POST only")
		return
	}
	body := struct {
		Minutes int `json:"minutes"`
	}{}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "bad body: %v", err)
		return
	}
	if body.Minutes == 0 {
		writeErr(w, http.StatusBadRequest, "minutes is required")
		return
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	f := g.flow

	from := time.Now()
	if f.deadlineAt != nil && f.deadlineAt.After(from) {
		from = *f.deadlineAt
	}
	at := from.Add(time.Duration(body.Minutes) * time.Minute)
	f.deadlineAt = &at
	f.logEvent(id, "deadline extended by %v minutes to %v", body.Minutes, at.UTC().Format(time.RFC3339))
	g.persist(id)
	writeJSON(w, http.StatusOK, g.gmState(id, r))
}

// ------------------------------------------------------------------ public

type publicStateJSON struct {
	GameID          string              `json:"gameId"`
	Phase           phaseJSON           `json:"phase"`
	Started         bool                `json:"started"`
	JoinedCount     int                 `json:"joinedCount"`
	TotalSeats      int                 `json:"totalSeats"`
	Finalized       map[string]bool     `json:"finalized"`
	Settings        settings            `json:"settings"`
	SettingsVersion int                 `json:"settingsVersion"`
	DeadlineAt      interface{}         `json:"deadlineAt"`
	Variant         variantRefJSON      `json:"variant"`
	ProvinceNames   map[string]string   `json:"provinceNames"`
	Dislodged       map[string]unitJSON `json:"dislodged"`
}

func handlePublic(g *game, id string, w http.ResponseWriter, r *http.Request) {
	g.mu.Lock()
	defer g.mu.Unlock()
	f := g.flow
	writeJSON(w, http.StatusOK, publicStateJSON{
		GameID: id,
		Phase: phaseJSON{
			Season: string(g.state.Phase().Season()),
			Year:   g.state.Phase().Year(),
			Type:   string(g.state.Phase().Type()),
		},
		Started:         f.started,
		JoinedCount:     f.joinedCount(),
		TotalSeats:      f.joinerSeats(),
		Finalized:       f.finalizedMap(),
		Settings:        f.settings,
		SettingsVersion: f.settingsVersion,
		DeadlineAt:      rfc3339(f.deadlineAt),
		Variant:         g.variantRef(),
		ProvinceNames:   g.provinceNames(),
		Dislodged:       g.dislodgedMap(),
	})
}

// -------------------------------------------------------------------- seat

type youJSON struct {
	Power string `json:"power"`
}

type seatStateJSON struct {
	stateJSON
	You              youJSON           `json:"you"`
	Settings         settings          `json:"settings"`
	SettingsVersion  int               `json:"settingsVersion"`
	Started          bool              `json:"started"`
	DeadlineAt       interface{}       `json:"deadlineAt"`
	Finalized        map[string]bool   `json:"finalized"`
	YouFinalized     bool              `json:"youFinalized"`
	FinalizedCount   int               `json:"finalizedCount"`
	TotalSeats       int               `json:"totalSeats"`
	PhaseResolutions map[string]string `json:"phaseResolutions"`
	CanForce         bool              `json:"canForce"`
	Variant          variantRefJSON    `json:"variant"`
	ProvinceNames    map[string]string `json:"provinceNames"`
}

// seatState renders the board for one seat. The caller must hold g.mu.
// Orders are filtered to the seat's own power; nothing here can expose
// another power's current-phase orders (§ no-leak discipline).
func (self *game) seatState(id string, power godip.Nation) seatStateJSON {
	f := self.flow
	base := self.snapshot(id)

	own := map[string]string{}
	ownParts := map[string][]string{}
	for prov, bits := range self.parts {
		if self.owner[prov] != power {
			continue
		}
		own[string(prov)] = self.describe(prov, bits)
		ownParts[string(prov)] = bits
	}
	base.Orders = own
	base.OrderParts = ownParts

	return seatStateJSON{
		stateJSON:        base,
		You:              youJSON{Power: string(power)},
		Settings:         f.settings,
		SettingsVersion:  f.settingsVersion,
		Started:          f.started,
		DeadlineAt:       rfc3339(f.deadlineAt),
		Finalized:        f.finalizedMap(),
		YouFinalized:     f.seats[power].finalized,
		FinalizedCount:   f.finalizedCount(),
		TotalSeats:       f.activeSeats(),
		PhaseResolutions: base.Resolutions,
		CanForce:         f.canForce(),
		Variant:          self.variantRef(),
		ProvinceNames:    self.provinceNames(),
	}
}

type seatHandler func(g *game, id string, power godip.Nation, w http.ResponseWriter, r *http.Request)

func handleSeatState(g *game, id string, power godip.Nation, w http.ResponseWriter, r *http.Request) {
	g.mu.Lock()
	defer g.mu.Unlock()
	writeJSON(w, http.StatusOK, g.seatState(id, power))
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
		writeErr(w, http.StatusForbidden, "a seat may only read its own power's options")
		return
	}
	prov := godip.Province(r.URL.Query().Get("province"))
	if prov == "" {
		writeErr(w, http.StatusBadRequest, "province query parameter is required")
		return
	}
	g.mu.Lock()
	defer g.mu.Unlock()

	if !g.ownsProvince(power, prov) {
		writeErr(w, http.StatusForbidden, "%v is not yours to order", prov)
		return
	}
	all := g.state.Phase().Options(g.state, power)
	opts, found := all[prov.Super()]
	if !found {
		opts = godip.Options{}
	}
	writeJSON(w, http.StatusOK, opts)
}

func handleSeatOrder(g *game, id string, power godip.Nation, w http.ResponseWriter, r *http.Request) {
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

	if !g.flow.started {
		writeErr(w, http.StatusConflict, "the game has not started")
		return
	}
	if !g.ownsProvince(power, prov) {
		writeErr(w, http.StatusForbidden, "%v is not yours to order", prov)
		return
	}
	if len(req.Parts) == 0 {
		g.clearOrder(prov)
		g.persist(id)
		writeJSON(w, http.StatusOK, g.seatState(id, power))
		return
	}
	if err := g.setOrder(prov, req.Parts); err != nil {
		writeErr(w, http.StatusBadRequest, "%v", err)
		return
	}
	g.persist(id)
	writeJSON(w, http.StatusOK, g.seatState(id, power))
}

func handleSeatFinalize(g *game, id string, power godip.Nation, w http.ResponseWriter, r *http.Request) {
	g.seatFinalize(id, power, true, w, r)
}

func handleSeatUnfinalize(g *game, id string, power godip.Nation, w http.ResponseWriter, r *http.Request) {
	g.seatFinalize(id, power, false, w, r)
}

func (self *game) seatFinalize(id string, power godip.Nation, want bool, w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeErr(w, http.StatusMethodNotAllowed, "POST only")
		return
	}
	self.mu.Lock()
	defer self.mu.Unlock()
	f := self.flow

	if !f.started {
		writeErr(w, http.StatusConflict, "the game has not started")
		return
	}
	f.seats[power].finalized = want
	if want {
		f.logEvent(id, "%v finalized", power)
	} else {
		f.logEvent(id, "%v withdrew its finalize", power)
	}

	// Every power finalized: resolve at once (D-008).
	if want && f.finalizedCount() >= f.activeSeats() {
		if err := self.adjudicate(id, false); err != nil {
			writeErr(w, http.StatusInternalServerError, "adjudicate: %v", err)
			return
		}
	} else {
		self.persist(id)
	}
	writeJSON(w, http.StatusOK, self.seatState(id, power))
}

// adjudicate resolves the phase. With dropUnfinalized set, powers that
// have not finalized lose their orders and their units hold — an NMR
// (D-010). The caller must hold g.mu.
func (self *game) adjudicate(id string, dropUnfinalized bool) error {
	f := self.flow

	if dropUnfinalized {
		for _, p := range f.powers {
			s := f.seats[p]
			if s.token == "" || s.finalized {
				continue
			}
			dropped := 0
			for prov := range self.parts {
				if self.owner[prov] == p {
					self.clearOrder(prov)
					dropped++
				}
			}
			f.logEvent(id, "NMR for %v — no finalize, %v draft order(s) dropped, units hold", p, dropped)
		}
		f.logEvent(id, "GM forced adjudication")
	} else {
		f.logEvent(id, "every power finalized — adjudicating")
	}

	// Freeze this phase's order rows as they will actually be applied,
	// NMR drops included. Replay reads them back exactly like this.
	self.persist(id)

	if err := self.state.Next(); err != nil {
		return err
	}
	self.parts = map[godip.Province][]string{}
	self.owner = map[godip.Province]godip.Nation{}
	for _, s := range f.seats {
		s.finalized = false
	}
	f.phaseIndex++
	f.resetDeadline()
	f.logEvent(id, "phase is now %v %v %v",
		self.state.Phase().Season(), self.state.Phase().Year(), self.state.Phase().Type())
	self.persist(id)
	return nil
}

// ------------------------------------------------------------------ routing

var gmRoutes = map[string]gameHandler{
	"state":      handleGMState,
	"settings":   handleGMSettings,
	"start":      handleGMStart,
	"adjudicate": handleGMForce,
	"extend":     handleGMExtend,
	"map.svg":    handleMap,
}

var seatRoutes = map[string]seatHandler{
	"state":      handleSeatState,
	"options":    handleSeatOptions,
	"order":      handleSeatOrder,
	"finalize":   handleSeatFinalize,
	"unfinalize": handleSeatUnfinalize,
}

// serveFlow routes everything under /game/{id}/.
func (self *server) serveFlow(w http.ResponseWriter, r *http.Request) {
	rest := strings.TrimPrefix(r.URL.Path, "/game/")
	segments := strings.Split(rest, "/")
	if len(segments) < 2 || !validID(segments[0]) {
		http.NotFound(w, r)
		return
	}
	id := segments[0]
	g, found := games.lookup(id)
	if !found {
		http.NotFound(w, r)
		return
	}

	switch segments[1] {
	case "public":
		handlePublic(g, id, w, r)
	case "map.svg":
		handleMap(g, id, w, r)
	case "join":
		if len(segments) != 3 {
			http.NotFound(w, r)
			return
		}
		handleJoin(g, id, segments[2], w, r)
	case "gm", "seat":
		self.serveTokenScope(g, id, segments, w, r)
	default:
		http.NotFound(w, r)
	}
}

// serveTokenScope handles /game/{id}/{gm|seat}/{token}[/{action}].
func (self *server) serveTokenScope(g *game, id string, segments []string, w http.ResponseWriter, r *http.Request) {
	kind := segments[1]
	if len(segments) < 3 {
		http.NotFound(w, r)
		return
	}
	token := segments[2]
	if len(segments) == 3 {
		// Normalize to the trailing-slash form the pages live at.
		target := "/game/" + id + "/" + kind + "/" + token + "/"
		if r.URL.RawQuery != "" {
			target += "?" + r.URL.RawQuery
		}
		http.Redirect(w, r, target, http.StatusFound)
		return
	}
	action := strings.Join(segments[3:], "/")

	g.mu.Lock()
	f := g.flow
	var power godip.Nation
	authorized := false
	if kind == "gm" {
		authorized = subtleEqual(token, f.gmToken)
	} else {
		if p, ok := f.bySeatToken[token]; ok {
			power = p
			authorized = true
		}
	}
	g.mu.Unlock()

	if !authorized {
		http.NotFound(w, r)
		return
	}

	if action == "" {
		// Both pages are routes inside the same SPA shell.
		self.serveSPA(w, r)
		return
	}
	if kind == "gm" {
		if h, ok := gmRoutes[action]; ok {
			h(g, id, w, r)
			return
		}
		http.NotFound(w, r)
		return
	}
	if action == "map.svg" {
		handleMap(g, id, w, r)
		return
	}
	if h, ok := seatRoutes[action]; ok {
		h(g, id, power, w, r)
		return
	}
	http.NotFound(w, r)
}

// subtleEqual compares two tokens in constant time.
func subtleEqual(a, b string) bool {
	if len(a) != len(b) {
		return false
	}
	diff := byte(0)
	for i := 0; i < len(a); i++ {
		diff |= a[i] ^ b[i]
	}
	return diff == 0
}

// serveJoinPage handles GET /join/{id}/{inviteToken}.
func (self *server) serveJoinPage(w http.ResponseWriter, r *http.Request) {
	rest := strings.TrimPrefix(r.URL.Path, "/join/")
	segments := strings.Split(strings.TrimSuffix(rest, "/"), "/")
	if len(segments) != 2 || !validID(segments[0]) {
		http.NotFound(w, r)
		return
	}
	g, found := games.lookup(segments[0])
	if !found {
		http.NotFound(w, r)
		return
	}
	g.mu.Lock()
	ok := subtleEqual(segments[1], g.flow.inviteToken)
	g.mu.Unlock()
	if !ok {
		http.NotFound(w, r)
		return
	}
	self.serveSPA(w, r)
}
