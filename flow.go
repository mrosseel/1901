// M1 game flow: GM setup, one shared invite, random anonymous seats,
// per-seat order scoping, lock, and adjudication.
//
// See M1-CONTRACT.md and DESIGN.md D-020, D-021, D-022, D-011, D-010, D-008.
package main

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"math/big"
	"net"
	"net/http"
	"sort"
	"strings"
	"time"
	"unicode"

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
//
// Everything but the variant may be changed later; every change bumps
// settingsVersion, lands in the event log and is broadcast to every seat.
type settings struct {
	DeadlineMinutes int    `json:"deadlineMinutes"`
	GMPlays         bool   `json:"gmPlays"`
	Variant         string `json:"variant"`

	// Name is what the table calls this game. Optional: an unnamed game is
	// identified by its id, as every game was before this field existed.
	// It names the table, never a person — nothing binds it to a seat, so
	// D-020's anonymity is untouched and every screen may show it.
	Name string `json:"name"`

	// RetreatBuildPercent is what share of the movement clock a retreat or
	// build phase gets. Backstabbr's default is 50, and it is right: those
	// phases are not negotiation phases. Nobody is talking, the orders are
	// forced or nearly so, and a table waiting the full clock for two
	// disbands is a table doing nothing.
	RetreatBuildPercent int `json:"retreatBuildPercent"`

	// GraceMinutes is how long after the deadline orders are still taken.
	// The deadline the clock shows is unchanged; what moves is the moment
	// the GM may force the phase. A player mid-sentence with the referee is
	// the ordinary case at a table, not an exception.
	GraceMinutes int `json:"graceMinutes"`

	// FirstTurnExtraMinutes is added to the first movement phase only.
	// Spring 1901 is the one turn where everybody has to talk to everybody,
	// and every platform that has run real games gives it longer.
	FirstTurnExtraMinutes int `json:"firstTurnExtraMinutes"`

	// IllegalMoves lets a player enter an order the engine refuses (D-029).
	// Bluffing by misordering is part of Diplomacy, so this is ON by
	// default, in every press mode. The order is stored and shown as
	// written; at adjudication it is left out of the engine's order set,
	// the unit holds, and the review shows it struck.
	IllegalMoves bool `json:"illegalMoves"`

	// PressMode is how negotiation happens (D-023). Data only for now: no
	// behaviour is attached to it, and the app carries no messages in any
	// mode. Declaring it is the point — a gunboat table wants its rules
	// written down, and seat anonymity (D-020) is load-bearing there rather
	// than incidental.
	PressMode string `json:"pressMode"`
}

// The press modes a game may declare (D-023).
//
//   - ftf: negotiation is verbal at the table. The default.
//   - gunboat: no negotiation at all.
//   - fullpress: in-app messaging. Post-v1; the setting exists so the model
//     is established in data now.
//   - rulebook: press during movement phases, none during retreat and build.
//     webDiplomacy's fourth mode, and it says this is how face-to-face
//     Diplomacy is played (research/platforms.md, steal 7).
var pressModes = map[string]bool{
	"ftf":       true,
	"gunboat":   true,
	"fullpress": true,
	"rulebook":  true,
}

const defaultPressMode = "ftf"

// defaultRetreatBuildPercent is Backstabbr's: half the movement clock.
const defaultRetreatBuildPercent = 50

// defaultSettings is what a game gets when the GM says nothing at all.
//
// It exists because two of the defaults are not the zero value: the retreat
// clock is half the movement clock, and illegal orders are allowed (D-029).
// Building the defaults in one place is what keeps a caller from inventing a
// game that is strict because nobody said otherwise.
func defaultSettings() settings {
	return settings{
		Variant:             defaultVariant,
		RetreatBuildPercent: defaultRetreatBuildPercent,
		PressMode:           defaultPressMode,
		IllegalMoves:        true,
	}
}

// seat is one power in one game together with its claim state.
// It deliberately carries no player name (D-020).
type seat struct {
	power godip.Nation
	// token is the old credential: the secret in the address, which is
	// also the secret in the database. A seat has this or a key, never
	// both (D-049), and no game is migrated from one to the other.
	token string // seatToken, empty until claimed
	// signPub is the public half of the key the joining phone made
	// (D-049), base64url. The server can open nothing with it.
	signPub string
	device  string // device secret, empty until claimed
	isGM   bool
	locked bool

	// epoch is the handover counter (D-041). Every link ever minted for
	// this seat is signed for one epoch, so taking the seat and raising it
	// kills the rest — including the phone that just gave the power away.
	epoch int

	// autoLocked marks a seat the server locked because its power has no
	// legal order this phase (D-034). It is derived from the resolved
	// position, so it is recomputed on restore rather than stored.
	autoLocked bool
}

// claimed says whether somebody holds this seat. A seat is held by a token
// or by a key, never both (D-049), so no count anywhere may look at one of
// them alone.
func (s *seat) claimed() bool {
	return s.token != "" || s.signPub != ""
}

// flow holds the M1 state that sits on top of the godip board.
// Every field is guarded by the enclosing game's mutex.
type flow struct {
	gmToken string
	// gmEpoch is the handover counter for the role (D-041). The role and a
	// power are separate acts and fail differently, so they count
	// separately: a game master who gives the role away still plays.
	gmEpoch int
	// gmPublicKey is the Ed25519 public half the game master's browser
	// registered (D-048), base64url. Empty means the game has no key and
	// cannot be recovered by its words, which is every game made before
	// this existed and every one whose game master declined.
	gmPublicKey string
	inviteToken string
	// gmDevice is the referee cookie secret: the browser that created the
	// game holds it, and it is what /game/{id}/referee/ answers to. It
	// keeps the GM link off the creation screen and out of every share.
	gmDevice string

	settings        settings
	settingsVersion int

	started    bool
	deadlineAt *time.Time

	seats       map[godip.Nation]*seat
	bySeatToken map[string]godip.Nation
	bySignPub   map[string]godip.Nation
	byDevice    map[string]godip.Nation
	// sessions are open seat sessions, cookie value to power (D-049).
	// They live in memory on purpose: a restart signs every phone back in
	// without asking, because the seed is on the device, and nothing that
	// opens a seat is left in a file that could be copied.
	sessions map[string]godip.Nation
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
	gmDevice, err := newToken()
	if err != nil {
		return nil, err
	}
	f := &flow{
		gmToken:     gmToken,
		inviteToken: inviteToken,
		gmDevice:    gmDevice,
		settings:    s,
		createdAt:   time.Now().UTC(),
		powers:      sortedNations(v),
		seats:       map[godip.Nation]*seat{},
		bySeatToken: map[string]godip.Nation{},
		bySignPub:   map[string]godip.Nation{},
		byDevice:    map[string]godip.Nation{},
		sessions:    map[string]godip.Nation{},
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
		if s.claimed() && !s.isGM {
			n++
		}
	}
	return n
}

func (self *flow) lockedCount() int {
	n := 0
	for _, s := range self.seats {
		if s.locked {
			n++
		}
	}
	return n
}

// activeSeats is how many seats must lock before the phase resolves.
func (self *flow) activeSeats() int {
	n := 0
	for _, s := range self.seats {
		if s.claimed() {
			n++
		}
	}
	return n
}

func (self *flow) lockedMap() map[string]bool {
	out := map[string]bool{}
	for _, p := range self.powers {
		out[string(p)] = self.seats[p].locked
	}
	return out
}

// pendingCounts is how many claimed seats this phase actually asked a player
// for, and how many of those have locked.
func (self *flow) pendingCounts() (asked, in int) {
	for _, s := range self.seats {
		if !s.claimed() || s.autoLocked {
			continue
		}
		asked++
		if s.locked {
			in++
		}
	}
	return asked, in
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
	done := self.lockedCount()
	if done >= active {
		// Auto-adjudication already covers this case (D-008).
		return false
	}
	// All but one player is in and the table is waiting on the straggler.
	// A seat the server locked was never something the table waited for, so
	// it is left out of both counts here (D-034) — otherwise a retreat phase
	// with a single dislodged unit would arm the button the instant it
	// opened, before its one player had read the screen.
	asked, in := self.pendingCounts()
	if in > 0 && in >= asked-1 {
		return true
	}
	// The grace period, where the settings allow one: orders are still taken
	// after the deadline, so the GM may not force the phase until it ends.
	until := self.graceEndsAt()
	return until != nil && time.Now().After(*until)
}

// maxAutoPhases bounds the run of phases the auto-lock may resolve on its
// own. Only a table where every remaining power is eliminated can produce an
// unbroken run, and that table would otherwise spin forever.
const maxAutoPhases = 8

// nothingToOrder reports whether a power has no legal order at all this
// phase. godip's option tree is nation-scoped, and it is fixed the moment
// the position resolved: an empty tree cannot fill in later in the phase.
func (self *game) nothingToOrder(power godip.Nation) bool {
	return len(self.state.Phase().Options(self.state, power)) == 0
}

// anyoneCouldOrder reports whether the phase now on the board asks any
// claimed seat for an order. A phase that asks nobody is one the table never
// saw, so its empty review must not displace the review of the phase the
// players did play (D-034). The public per-phase history keeps it either way.
func (self *game) anyoneCouldOrder() bool {
	for _, s := range self.flow.seats {
		if s.claimed() && !self.nothingToOrder(s.power) {
			return true
		}
	}
	return false
}

// autoLock locks every claimed seat whose power has no legal order in
// the phase now on the board, and returns the powers it locked (D-034).
// The caller must hold g.mu.
func (self *game) autoLock() []godip.Nation {
	f := self.flow
	locked := []godip.Nation{}
	for _, p := range f.powers {
		s := f.seats[p]
		if !s.claimed() || s.autoLocked || !self.nothingToOrder(p) {
			continue
		}
		s.locked = true
		s.autoLocked = true
		locked = append(locked, p)
	}
	return locked
}

/*
enterPhase settles the phase now on the board: it auto-locks the seats with
nothing to order and, when that leaves the whole table in, adjudicates on.

The cascade is what keeps auto-lock inside the two existing resolution paths
(D-008, D-010) instead of adding a third. A phase nobody can order is not a
phase the GM should be asked to force — canForce reads the table as complete,
so without this the game would sit on a screen with no button that does
anything. The caller must hold g.mu.
*/
func (self *game) enterPhase(id string) error {
	f := self.flow
	for i := 0; i < maxAutoPhases; i++ {
		locked := self.autoLock()
		for _, p := range locked {
			f.logEvent(id, "%v has no order to give this phase — locked automatically", p)
		}
		active := f.activeSeats()
		if active == 0 || f.lockedCount() < active {
			if len(locked) > 0 {
				self.persist(id)
			}
			return nil
		}
		f.logEvent(id, "no power has an order to give this phase — adjudicating")
		if err := self.advance(id, false); err != nil {
			return err
		}
	}
	f.logEvent(id, "auto-lock stopped after %v phases with nothing to order", maxAutoPhases)
	return nil
}

// unassignedPowers lists the powers the invite may still hand out.
func (self *flow) unassignedPowers() []godip.Nation {
	out := []godip.Nation{}
	for _, p := range self.powers {
		if !self.seats[p].claimed() {
			out = append(out, p)
		}
	}
	return out
}

// DEADLINE ARITHMETIC (D-008, D-010, D-022; research/platforms.md, steal 8)
//
// A deadline is one number in the settings and three rules on top of it, all
// of them stolen from platforms that have run real games for years:
//
//   - a retreat or build phase runs at retreatBuildPercent of the movement
//     clock, because it is not a negotiation phase;
//   - the first movement phase gets firstTurnExtraMinutes on top, because
//     Spring 1901 is the one turn where everyone must talk to everyone;
//   - resolving early never shortens the next phase for anybody, which is
//     the anti-rush rule below.

// phaseMinutes is how long the phase now on the board gets.
func (self *flow) phaseMinutes(phase godip.Phase) int {
	base := self.settings.DeadlineMinutes
	if base <= 0 {
		return 0
	}
	minutes := base
	switch phase.Type() {
	case godip.Retreat, godip.Adjustment:
		percent := self.settings.RetreatBuildPercent
		if percent <= 0 {
			percent = defaultRetreatBuildPercent
		}
		// Rounded up, so a short clock cannot round a phase away entirely.
		minutes = (base*percent + 99) / 100
		if minutes < 1 {
			minutes = 1
		}
	}
	// The first movement phase of the game, and only that one.
	if self.phaseIndex == 0 && phase.Type() == godip.Movement {
		minutes += self.settings.FirstTurnExtraMinutes
	}
	return minutes
}

/*
resetDeadline restarts the clock for the phase now on the board.

`carry` is the time that was still on the clock when the previous phase
resolved, and it is the anti-rush rule (Backstabbr's, copied exactly): with
period T and remaining R, if R < T the next deadline is R + T; otherwise it is
R. Both are at least T, so a table that locks early never costs the next
table its turn. A phase that ran its clock out carries nothing.
*/
func (self *flow) resetDeadline(phase godip.Phase, carry time.Duration) {
	minutes := self.phaseMinutes(phase)
	if minutes <= 0 {
		self.deadlineAt = nil
		return
	}
	period := time.Duration(minutes) * time.Minute
	length := period
	if carry > 0 {
		if carry < period {
			length = carry + period
		} else {
			length = carry
		}
	}
	at := time.Now().Add(length)
	self.deadlineAt = &at
}

// carryNote says, in the event log, that a phase resolved early and what the
// table got back for it.
func carryNote(carry time.Duration) string {
	if carry <= 0 {
		return ""
	}
	return fmt.Sprintf(" plus %v carried from an early finish (anti-rush)",
		carry.Round(time.Second))
}

// remaining is what is left on the clock, or zero when it has run out or
// there is no clock at all.
func (self *flow) remaining() time.Duration {
	if self.deadlineAt == nil {
		return 0
	}
	left := time.Until(*self.deadlineAt)
	if left < 0 {
		return 0
	}
	return left
}

// graceEndsAt is the moment the GM may force the phase: the deadline plus
// whatever grace the settings allow. The deadline the clock shows does not
// move, because a grace period that is announced is not a grace period.
func (self *flow) graceEndsAt() *time.Time {
	if self.deadlineAt == nil {
		return nil
	}
	if self.settings.GraceMinutes <= 0 {
		return self.deadlineAt
	}
	at := self.deadlineAt.Add(time.Duration(self.settings.GraceMinutes) * time.Minute)
	return &at
}

// serverNow is the clock the client should measure deadlines against.
// Phones at a table are not reliably in sync.
func serverNow() string {
	return time.Now().UTC().Format(time.RFC3339)
}

func rfc3339(t *time.Time) interface{} {
	if t == nil {
		return nil
	}
	return t.UTC().Format(time.RFC3339)
}

// baseURLFixed is the pinned origin from BASE_URL, read once at startup.
var baseURLFixed string

// lanHost is this machine's address on the table's network, found once at
// startup by pinLANHost. It is empty when there is no single answer.
var lanHost string

// baseURL is the origin the invite, seat, and GM links point at.
//
// BASE_URL pins it at startup. Without it the origin comes from the
// request: r.Host. That value is attacker-chosen everywhere except a
// direct browser connection — a man in the middle on the table's network
// can make the GM's next state poll hand back an invite URL that points
// at their own machine. Forwarded headers are not read at all; behind a
// reverse proxy, BASE_URL is the setting.
//
// A loopback host is the exception, because a loopback link is useless to
// everyone at the table: the GM opens localhost on the laptop, and the QR
// code carries a name no phone can resolve. There the host becomes lanHost,
// which the server read from its own interfaces. Nothing in the request
// decides it, so this trusts no more than it did before. The port and the
// scheme are the request's, because that is what the GM reached.
func baseURL(r *http.Request) string {
	if baseURLFixed != "" {
		return baseURLFixed
	}
	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	}
	return scheme + "://" + reachableHost(r.Host)
}

// reachableHost swaps a loopback host for the LAN address, keeping the port.
func reachableHost(hostPort string) string {
	if lanHost == "" || !isLoopbackHost(hostPort) {
		return hostPort
	}
	_, port, err := net.SplitHostPort(hostPort)
	if err != nil || port == "" {
		return lanHost
	}
	return net.JoinHostPort(lanHost, port)
}

func isLoopbackHost(hostPort string) bool {
	host := hostPort
	if h, _, err := net.SplitHostPort(hostPort); err == nil {
		host = h
	}
	host = strings.Trim(host, "[]")
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// pinLANHost finds the address a phone on the same network can reach, and
// is a no-op once BASE_URL has pinned the origin.
//
// It takes IPv4 only. A QR code is read by a human eye as often as by a
// camera, and an IPv6 address in a URL is bracketed, long, and hard to
// retype.
//
// The kernel's own routing table answers this best, so routedIPv4 asks it
// first. Reading the interfaces instead gives a laptop with docker three
// answers and no way to rank them.
func pinLANHost() {
	if baseURLFixed != "" {
		return
	}
	if ip := routedIPv4(); ip != "" {
		lanHost = ip
		return
	}
	lanHost = scannedIPv4()
}

// routedIPv4 asks the kernel which of this machine's addresses it would
// send from. A UDP "connection" sends nothing; it only fixes a route. The
// destination is TEST-NET-1, which is reserved and never routed anywhere,
// so nothing leaves the machine even if the address were used. This fails
// when there is no default route, which is the case on a table with a
// switch and no uplink.
func routedIPv4() string {
	c, err := net.Dial("udp4", "192.0.2.1:9")
	if err != nil {
		return ""
	}
	defer c.Close()
	a, ok := c.LocalAddr().(*net.UDPAddr)
	if !ok || a.IP == nil || a.IP.IsLoopback() || a.IP.IsUnspecified() {
		return ""
	}
	ip := a.IP.To4()
	if ip == nil {
		return ""
	}
	return ip.String()
}

// scannedIPv4 is the fallback for a machine with no default route: read the
// interfaces and take the one address that qualifies. Interfaces that are
// down, loopback, or point-to-point are skipped; a link-local address
// (169.254/16) means DHCP failed, so it is skipped too. Two candidates left
// is not a tie the server can settle, so it declines and says so.
func scannedIPv4() string {
	found := []string{}
	ifaces, err := net.Interfaces()
	if err != nil {
		log.Printf("no LAN address: %v — set BASE_URL if the links must leave this machine", err)
		return ""
	}
	for _, iface := range ifaces {
		if iface.Flags&net.FlagUp == 0 {
			continue
		}
		if iface.Flags&(net.FlagLoopback|net.FlagPointToPoint) != 0 {
			continue
		}
		addrs, err := iface.Addrs()
		if err != nil {
			continue
		}
		for _, a := range addrs {
			n, ok := a.(*net.IPNet)
			if !ok {
				continue
			}
			ip := n.IP.To4()
			if ip == nil || ip.IsLoopback() || ip.IsLinkLocalUnicast() {
				continue
			}
			found = append(found, ip.String())
		}
	}
	switch len(found) {
	case 0:
		log.Printf("no LAN address found — a link to localhost will not open on a phone; set BASE_URL")
	case 1:
		return found[0]
	default:
		log.Printf("%v LAN addresses (%v) and no default route to rank them — set BASE_URL",
			len(found), strings.Join(found, ", "))
	}
	return ""
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

// refereeCookieName marks the browser that created the game. It answers
// /game/{id}/referee/, which is how the GM reaches the GM view without the
// link ever being displayed anywhere.
func refereeCookieName(id string) string {
	return "r1901_" + id
}

// refereeCookieValue reads the referee cookie, empty when absent.
func refereeCookieValue(r *http.Request, id string) string {
	c, err := r.Cookie(refereeCookieName(id))
	if err != nil {
		return ""
	}
	return c.Value
}

// settingsEnvelope accepts both {"deadlineMinutes":..,"gmPlays":..} and
// the wrapped {"settings":{...}} shape.
// settingsPatch is a settings object where every field is optional. A GM who
// sends one setting changes one setting, and a setting nobody mentions keeps
// the value it had. That matters most for a boolean whose default is true:
// illegalMoves (D-029) must not turn itself off because a client left it out.
type settingsPatch struct {
	DeadlineMinutes       *int    `json:"deadlineMinutes"`
	GMPlays               *bool   `json:"gmPlays"`
	Variant               *string `json:"variant"`
	Name                  *string `json:"name"`
	RetreatBuildPercent   *int    `json:"retreatBuildPercent"`
	GraceMinutes          *int    `json:"graceMinutes"`
	FirstTurnExtraMinutes *int    `json:"firstTurnExtraMinutes"`
	PressMode             *string `json:"pressMode"`
	IllegalMoves          *bool   `json:"illegalMoves"`
}

func (self settingsPatch) apply(base settings) settings {
	if self.DeadlineMinutes != nil {
		base.DeadlineMinutes = *self.DeadlineMinutes
	}
	if self.GMPlays != nil {
		base.GMPlays = *self.GMPlays
	}
	if self.Variant != nil {
		base.Variant = *self.Variant
	}
	if self.Name != nil {
		base.Name = *self.Name
	}
	if self.RetreatBuildPercent != nil {
		base.RetreatBuildPercent = *self.RetreatBuildPercent
	}
	if self.GraceMinutes != nil {
		base.GraceMinutes = *self.GraceMinutes
	}
	if self.FirstTurnExtraMinutes != nil {
		base.FirstTurnExtraMinutes = *self.FirstTurnExtraMinutes
	}
	if self.PressMode != nil {
		base.PressMode = *self.PressMode
	}
	if self.IllegalMoves != nil {
		base.IllegalMoves = *self.IllegalMoves
	}
	return base
}

// settingsEnvelope accepts a bare {"deadlineMinutes":…} body and the wrapped
// {"settings":{…}} shape, and both are patches.
type settingsEnvelope struct {
	Settings *settingsPatch `json:"settings"`
	settingsPatch
}

// merge applies the envelope on top of the given settings.
func (self settingsEnvelope) merge(base settings) settings {
	if self.Settings != nil {
		base = self.Settings.apply(base)
	}
	return self.settingsPatch.apply(base).normalised()
}

// normalised fills in the defaults and refuses the impossible. A negative
// clock is zero — no deadline — and a retreat clock of nought per cent would
// be a phase that is over before it starts.
func (self settings) normalised() settings {
	if self.DeadlineMinutes < 0 {
		self.DeadlineMinutes = 0
	}
	if self.GraceMinutes < 0 {
		self.GraceMinutes = 0
	}
	if self.FirstTurnExtraMinutes < 0 {
		self.FirstTurnExtraMinutes = 0
	}
	if self.RetreatBuildPercent <= 0 {
		self.RetreatBuildPercent = defaultRetreatBuildPercent
	}
	if self.RetreatBuildPercent > 100 {
		self.RetreatBuildPercent = 100
	}
	if self.Variant == "" {
		self.Variant = defaultVariant
	}
	if self.PressMode == "" {
		self.PressMode = defaultPressMode
	}
	self.Name = tidyName(self.Name)
	return self
}

// maxNameRunes caps the game name. It is a line on a list and a heading on a
// page, not a paragraph, and the cap is what keeps it one.
const maxNameRunes = 60

// tidyName folds every run of whitespace to one space, trims the ends, and
// cuts the result to maxNameRunes. Control characters go: the name is drawn
// as one line, in a list beside other names.
func tidyName(name string) string {
	clean := strings.Map(func(r rune) rune {
		if r == '\t' || r == '\n' || r == '\r' {
			return ' '
		}
		if unicode.IsControl(r) {
			return -1
		}
		return r
	}, name)
	clean = strings.Join(strings.Fields(clean), " ")
	runes := []rune(clean)
	if len(runes) > maxNameRunes {
		clean = strings.TrimSpace(string(runes[:maxNameRunes]))
	}
	return clean
}

func decodeSettings(r *http.Request, base settings) (settings, error) {
	env := settingsEnvelope{}
	if r.Body == nil {
		return base, nil
	}
	if err := json.NewDecoder(r.Body).Decode(&env); err != nil {
		return base, err
	}
	neu := env.merge(base)
	if !pressModes[neu.PressMode] {
		return base, fmt.Errorf("unknown press mode %q: it is one of ftf, gunboat, fullpress, rulebook",
			neu.PressMode)
	}
	return neu, nil
}

// ---------------------------------------------------------------- creation

type createResponse struct {
	GameID    string         `json:"gameId"`
	InviteURL string         `json:"inviteUrl"`
	Variant   variantRefJSON `json:"variant"`
}

// The create response carries no GM secret on purpose. The creating browser
// gets the referee view through the cookie set below, and the GM token
// itself reaches only two places: the GM pages behind /game/{id}/gm/, and
// the seat state of the GM's own power once the game has started.
func handleCreateGame(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeErr(w, http.StatusMethodNotAllowed, "POST only")
		return
	}
	s, err := decodeSettings(r, defaultSettings())
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
		if errors.Is(err, errGameLimit) {
			writeErr(w, http.StatusServiceUnavailable,
				"the server holds its maximum of %v game(s) — raise MAX_GAMES to make room", games.limit)
			return
		}
		writeErr(w, http.StatusInternalServerError, "create game: %v", err)
		return
	}
	g.mu.Lock()
	if s.Name != "" {
		f.logEvent(id, "game named %q", s.Name)
	}
	f.logEvent(id, "game created on %v, deadlineMinutes=%v gmPlays=%v "+
		"retreatBuildPercent=%v graceMinutes=%v firstTurnExtraMinutes=%v pressMode=%v "+
		"illegalMoves=%v",
		v.Name, s.DeadlineMinutes, s.GMPlays, s.RetreatBuildPercent, s.GraceMinutes,
		s.FirstTurnExtraMinutes, s.PressMode, s.IllegalMoves)
	if !supportedVariants[s.Variant] {
		f.logEvent(id, "%v is experimental — unit placement on the map is not verified", v.Name)
	}
	g.persist(id)
	g.mu.Unlock()

	http.SetCookie(w, &http.Cookie{
		Name:     refereeCookieName(id),
		Value:    f.gmDevice,
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   60 * 60 * 24 * 30,
	})
	writeJSON(w, http.StatusOK, createResponse{
		GameID:    id,
		InviteURL: inviteURL(r, id, f.inviteToken),
		Variant:   g.variantRef(),
	})
}

// gameSummaryJSON is one row of the main-page list. It holds what the
// public watch view holds and nothing more: the id opens the public pages
// only, and every secret stays behind its token.
type gameSummaryJSON struct {
	GameID string `json:"gameId"`
	// Name is what the table calls this game, empty when nobody named it.
	// It belongs to the game, not to any seat, so it is as public as the id.
	Name        string         `json:"name"`
	Variant     variantRefJSON `json:"variant"`
	Started     bool           `json:"started"`
	Phase       phaseJSON      `json:"phase"`
	JoinedCount int            `json:"joinedCount"`
	TotalSeats  int            `json:"totalSeats"`
	Turns       int            `json:"turns"`
	DeadlineAt  interface{}    `json:"deadlineAt"`
	CreatedAt   string         `json:"createdAt"`
	// Referee is true only for the browser that created the game: its
	// cookie matched. It is what puts the referee link on the main page
	// for the GM and nobody else.
	Referee bool `json:"referee"`
}

// handleListGames answers GET /games with every game on the server, newest
// first. Publishing the ids is a deliberate trade: an id opens the public
// watch view, and nothing else — the seat, invite, and GM tokens stay
// unread.
func handleListGames(w http.ResponseWriter, r *http.Request) {
	games.mu.Lock()
	ids := make([]string, 0, len(games.games))
	for id := range games.games {
		ids = append(ids, id)
	}
	games.mu.Unlock()

	out := make([]gameSummaryJSON, 0, len(ids))
	for _, id := range ids {
		g, found := games.lookup(id)
		if !found {
			continue
		}
		g.mu.Lock()
		f := g.flow
		out = append(out, gameSummaryJSON{
			GameID:  id,
			Name:    f.settings.Name,
			Variant: g.variantRef(),
			Started: f.started,
			Phase: phaseJSON{
				Season: string(g.state.Phase().Season()),
				Year:   g.state.Phase().Year(),
				Type:   string(g.state.Phase().Type()),
			},
			JoinedCount: f.joinedCount(),
			TotalSeats:  f.joinerSeats(),
			Turns:       f.phaseIndex,
			DeadlineAt:  rfc3339(f.deadlineAt),
			CreatedAt:   f.createdAt.UTC().Format(time.RFC3339),
			Referee:     f.gmDevice != "" && subtleEqual(refereeCookieValue(r, id), f.gmDevice),
		})
		g.mu.Unlock()
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt > out[j].CreatedAt })
	writeJSON(w, http.StatusOK, out)
}

// -------------------------------------------------------------------- join

type joinResponse struct {
	SeatURL string `json:"seatUrl"`
	// Whether this seat is held by a key rather than by a token in its
	// address (D-049). The page needs to know: a keyed seat's seed has to
	// be written to this device's storage before the board is opened.
	Keyed bool `json:"keyed,omitempty"`
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

	// The joining phone made a key and sends its public half (D-049). A
	// body without one still claims a seat the old way, so a link opened
	// by something that is not this app is not left with a dead page.
	var body struct {
		SignPub string `json:"signPub"`
	}
	json.NewDecoder(r.Body).Decode(&body)
	if body.SignPub != "" && !checkSignPub(body.SignPub) {
		writeErr(w, http.StatusBadRequest, "signPub must be 32 base64url bytes")
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
			// This phone already holds a power. A keyed seat is handed
			// back its own address and nothing else: the seed is on the
			// device and the session is opened by signing, never by a
			// cookie that merely says which phone this is.
			s := f.seats[power]
			if s.signPub != "" {
				writeJSON(w, http.StatusOK, joinResponse{
					SeatURL: keyedSeatURL(r, id),
					Keyed:   true,
				})
				return
			}
			writeJSON(w, http.StatusOK, joinResponse{SeatURL: seatURL(r, id, s.token)})
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

	if device == "" {
		device, err = newToken()
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "tokens: %v", err)
			return
		}
	}

	s := f.seats[power]
	s.device = device
	f.byDevice[device] = power

	// One or the other, never both (D-049).
	session := ""
	if body.SignPub != "" {
		f.bindSeatKey(s, body.SignPub)
		session, err = f.openSession(power)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "tokens: %v", err)
			return
		}
	} else {
		seatToken, err := newToken()
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "tokens: %v", err)
			return
		}
		s.token = seatToken
		f.bySeatToken[seatToken] = power
	}
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
	if session != "" {
		setSessionCookie(w, id, session)
		writeJSON(w, http.StatusOK, joinResponse{SeatURL: keyedSeatURL(r, id), Keyed: true})
		return
	}
	writeJSON(w, http.StatusOK, joinResponse{SeatURL: seatURL(r, id, s.token)})
}

// ---------------------------------------------------------------------- GM

type gmSeatJSON struct {
	Power  string `json:"power"`
	Joined bool   `json:"joined"`
	Locked bool   `json:"locked"`
	IsGM   bool   `json:"isGm"`
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
	GraceUntil      interface{}         `json:"graceUntil"`
	PhaseMinutes    int                 `json:"phaseMinutes"`
	CanForce        bool                `json:"canForce"`
	GMSeatURL       *string             `json:"gmSeatUrl"`
	Events          []string            `json:"events"`
	Variant         variantRefJSON      `json:"variant"`
	ProvinceNames   map[string]string   `json:"provinceNames"`
	Placements      placementTable      `json:"placements"`
	Labels          *labelPlanJSON      `json:"labels,omitempty"`
	Dislodged       map[string]unitJSON `json:"dislodged"`
	PreviousPhase   *phaseReviewJSON    `json:"previousPhase"`
	Now             string              `json:"now"`
	// Whether this game has a recovery key (D-048). A boolean and not the
	// key: the page needs to know which card to draw, not what the server
	// holds.
	HasGMKey bool `json:"hasGmKey"`
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
		GraceUntil:    rfc3339(f.graceEndsAt()),
		PhaseMinutes:  f.phaseMinutes(self.state.Phase()),
		CanForce:      f.canForce(),
		Events:        f.events,
		Variant:       self.variantRef(),
		ProvinceNames: self.provinceNames(),
		Placements:    self.placements(),
		Labels:        self.labels(),
		Dislodged:     self.dislodgedMap(),
		PreviousPhase: self.previousPhase,
		Now:           serverNow(),
		HasGMKey:      f.gmPublicKey != "",
	}
	for _, p := range f.powers {
		s := f.seats[p]
		out.Seats = append(out.Seats, gmSeatJSON{
			Power:  string(p),
			Joined: s.claimed(),
			Locked: s.locked,
			IsGM:   s.isGM,
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
	// The press mode is part of the rules the table agreed to play under
	// (D-023), so it is fixed at start the way gmPlays is.
	if f.started && neu.PressMode != old.PressMode {
		writeErr(w, http.StatusConflict, "the press mode cannot change after the game has started")
		return
	}
	if neu.Variant != old.Variant {
		writeErr(w, http.StatusConflict, "the variant is fixed when the game is created")
		return
	}
	// The name is not a rule. It changes nothing about how the game is
	// played, so it does not bump the settings version and no seat is told
	// "the rules changed" over it. It is still a game master act, so it is
	// logged (D-007).
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
		writeJSON(w, http.StatusOK, g.gmState(id, r))
		return
	}
	f.settings = neu
	f.settingsVersion++
	f.logEvent(id, "settings changed to deadlineMinutes=%v gmPlays=%v "+
		"retreatBuildPercent=%v graceMinutes=%v firstTurnExtraMinutes=%v pressMode=%v "+
		"illegalMoves=%v (version %v)",
		neu.DeadlineMinutes, neu.GMPlays, neu.RetreatBuildPercent, neu.GraceMinutes,
		neu.FirstTurnExtraMinutes, neu.PressMode, neu.IllegalMoves, f.settingsVersion)
	// A change to the clock takes effect on the phase now running, so the
	// table sees the rule it was just told about rather than the next one.
	if f.started && (neu.DeadlineMinutes != old.DeadlineMinutes ||
		neu.RetreatBuildPercent != old.RetreatBuildPercent ||
		neu.FirstTurnExtraMinutes != old.FirstTurnExtraMinutes) {
		f.resetDeadline(g.state.Phase(), 0)
		f.logEvent(id, "deadline reset to %v under the new clock", rfc3339(f.deadlineAt))
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
	f.resetDeadline(g.state.Phase(), 0)
	f.logEvent(id, "game started, %v has %v minute(s) until %v",
		g.state.Phase().Type(), f.phaseMinutes(g.state.Phase()), rfc3339(f.deadlineAt))
	if err := g.enterPhase(id); err != nil {
		writeErr(w, http.StatusInternalServerError, "adjudicate: %v", err)
		return
	}
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
			"force adjudication is locked until the deadline passes or all but one power has locked")
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
	if body.Minutes < 1 {
		// A negative value would move the deadline into the past and open
		// force adjudication early (SECURITY.md, open findings).
		writeErr(w, http.StatusBadRequest, "minutes must be a positive number")
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
	Locked          map[string]bool     `json:"locked"`
	Settings        settings            `json:"settings"`
	SettingsVersion int                 `json:"settingsVersion"`
	DeadlineAt      interface{}         `json:"deadlineAt"`
	GraceUntil      interface{}         `json:"graceUntil"`
	PhaseMinutes    int                 `json:"phaseMinutes"`
	Variant         variantRefJSON      `json:"variant"`
	ProvinceNames   map[string]string   `json:"provinceNames"`
	Placements      placementTable      `json:"placements"`
	Labels          *labelPlanJSON      `json:"labels,omitempty"`
	Dislodged       map[string]unitJSON `json:"dislodged"`
	PreviousPhase   *phaseReviewJSON    `json:"previousPhase"`
	Now             string              `json:"now"`
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
		Locked:          f.lockedMap(),
		Settings:        f.settings,
		SettingsVersion: f.settingsVersion,
		DeadlineAt:      rfc3339(f.deadlineAt),
		GraceUntil:      rfc3339(f.graceEndsAt()),
		PhaseMinutes:    f.phaseMinutes(g.state.Phase()),
		Variant:         g.variantRef(),
		ProvinceNames:   g.provinceNames(),
		Placements:      g.placements(),
		Labels:          g.labels(),
		Dislodged:       g.dislodgedMap(),
		PreviousPhase:   g.previousPhase,
		Now:             serverNow(),
	})
}

// -------------------------------------------------------------------- seat

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
	// YouAreGM says this seat is the game master's own (D-021). The seat
	// menu shows two handovers rather than one when it is: the role and the
	// power are different acts and this device holds both.
	YouAreGM bool `json:"youAreGm"`
	// What the seat menu says about the game it belongs to (D-041): how
	// many turns have been played, and when the game was made.
	Turns     int    `json:"turns"`
	CreatedAt string `json:"createdAt"`
	// NothingToOrder says this seat was locked by the server because its
	// power has no legal order this phase (D-034). The screen must say so;
	// a seat that finds itself locked with no explanation reads as a bug.
	NothingToOrder bool `json:"nothingToOrder"`
	LockedCount    int  `json:"lockedCount"`
	TotalSeats     int  `json:"totalSeats"`
	// JoinedCount and SeatsOnOffer are the table filling up, for the screen a
	// player sits on before the start. TotalSeats cannot say it: it counts the
	// seats that must lock, which is the wrong denominator before a phase
	// exists and, when the GM plays, excludes a seat that is not handed out.
	// Both numbers are already public on /public, and neither says WHICH
	// powers are taken — that stays unsaid (D-020, D-021).
	JoinedCount      int               `json:"joinedCount"`
	SeatsOnOffer     int               `json:"seatsOnOffer"`
	PhaseResolutions map[string]string `json:"phaseResolutions"`
	CanForce         bool              `json:"canForce"`
	Variant          variantRefJSON    `json:"variant"`
	ProvinceNames    map[string]string `json:"provinceNames"`
	Placements       placementTable    `json:"placements"`
	Labels           *labelPlanJSON    `json:"labels,omitempty"`
	PreviousPhase    *phaseReviewJSON  `json:"previousPhase"`
	Now              string            `json:"now"`
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
		Now:              serverNow(),
		RefereeURL:       referee,
	}
}

type seatHandler func(g *game, id string, power godip.Nation, w http.ResponseWriter, r *http.Request)

func handleSeatState(g *game, id string, power godip.Nation, w http.ResponseWriter, r *http.Request) {
	g.mu.Lock()
	defer g.mu.Unlock()
	writeJSON(w, http.StatusOK, g.seatState(id, power, r))
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
		writeJSON(w, http.StatusOK, g.seatState(id, power, r))
		return
	}
	if err := g.setOrder(prov, req.Parts); err != nil {
		writeErr(w, http.StatusBadRequest, "%v", err)
		return
	}
	g.persist(id)
	writeJSON(w, http.StatusOK, g.seatState(id, power, r))
}

func handleSeatLock(g *game, id string, power godip.Nation, w http.ResponseWriter, r *http.Request) {
	g.seatLock(id, power, true, w, r)
}

func handleSeatUnlock(g *game, id string, power godip.Nation, w http.ResponseWriter, r *http.Request) {
	g.seatLock(id, power, false, w, r)
}

func (self *game) seatLock(id string, power godip.Nation, want bool, w http.ResponseWriter, r *http.Request) {
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
	if !want && f.seats[power].autoLocked {
		writeErr(w, http.StatusConflict,
			"%v has no order to give this phase, so this seat stays locked", power)
		return
	}
	f.seats[power].locked = want
	if want {
		f.logEvent(id, "%v locked", power)
	} else {
		f.logEvent(id, "%v withdrew its lock", power)
	}

	// Every power locked: resolve at once (D-008).
	if want && f.lockedCount() >= f.activeSeats() {
		if err := self.adjudicate(id, false); err != nil {
			writeErr(w, http.StatusInternalServerError, "adjudicate: %v", err)
			return
		}
	} else {
		self.persist(id)
	}
	writeJSON(w, http.StatusOK, self.seatState(id, power, r))
}

// adjudicate resolves the phase and settles the one that follows it. With
// dropUnlocked set, powers that have not locked lose their orders and
// their units hold — an NMR (D-010). The caller must hold g.mu.
func (self *game) adjudicate(id string, dropUnlocked bool) error {
	if err := self.advance(id, dropUnlocked); err != nil {
		return err
	}
	return self.enterPhase(id)
}

// advance resolves the phase and puts the next one on the board, without
// auto-locking it. Only adjudicate and enterPhase may call it: every other
// caller wants the auto-lock that goes with a new phase.
func (self *game) advance(id string, dropUnlocked bool) error {
	f := self.flow

	// What is still on the clock as this phase resolves. When every power
	// locked early it is carried onto the next phase, so resolving early
	// never shortens the next turn for anybody (the anti-rush rule). A phase
	// the GM forced carries nothing: its clock had run out, or the GM chose
	// to spend it.
	carry := time.Duration(0)
	if !dropUnlocked {
		carry = f.remaining()
	}

	nmr := []string{}
	if dropUnlocked {
		for _, p := range f.powers {
			s := f.seats[p]
			if !s.claimed() || s.locked {
				continue
			}
			dropped := 0
			for prov := range self.parts {
				if self.owner[prov] == p {
					self.clearOrder(prov)
					dropped++
				}
			}
			nmr = append(nmr, string(p))
			f.logEvent(id, "NMR for %v — no lock, %v draft order(s) dropped, units hold", p, dropped)
		}
		f.logEvent(id, "GM forced adjudication")
	} else {
		f.logEvent(id, "every power locked — adjudicating")
	}

	// Freeze this phase's order rows as they will actually be applied,
	// NMR drops included. Replay reads them back exactly like this.
	self.persist(id)
	persistNMR(id, f.phaseIndex, nmr)

	// The position this phase was played from, for the public per-phase URL
	// (D-013). It is read before the board moves.
	position := self.positionNow()
	asked := self.anyoneCouldOrder()
	review := self.beginReview(nmr)
	if err := self.state.Next(); err != nil {
		return err
	}
	self.endReview(review)
	if asked {
		self.previousPhase = review
	}
	self.recordWatch(f.phaseIndex, position, review)
	self.parts = map[godip.Province][]string{}
	self.owner = map[godip.Province]godip.Nation{}
	for _, s := range f.seats {
		s.locked = false
		s.autoLocked = false
	}
	f.phaseIndex++
	f.resetDeadline(self.state.Phase(), carry)
	f.logEvent(id, "phase is now %v %v %v, %v minute(s) of clock%v, deadline %v",
		self.state.Phase().Season(), self.state.Phase().Year(), self.state.Phase().Type(),
		f.phaseMinutes(self.state.Phase()),
		carryNote(carry), rfc3339(f.deadlineAt))
	self.persist(id)
	return nil
}

// ------------------------------------------------------------------ routing

var gmRoutes = map[string]gameHandler{
	"state":         handleGMState,
	"handover":      handleGMHandover,
	"handover-role": handleGMRoleHandover,
	"key":           handleGMKey,
	"settings":      handleGMSettings,
	"start":         handleGMStart,
	"adjudicate":    handleGMForce,
	"extend":        handleGMExtend,
	"map.svg":       handleMap,
}

var seatRoutes = map[string]seatHandler{
	"state":         handleSeatState,
	"handover":      handleSeatHandover,
	"handover-role": handleSeatRoleHandover,
	"options":       handleSeatOptions,
	"order":         handleSeatOrder,
	"lock":          handleSeatLock,
	"unlock":        handleSeatUnlock,

	// The names these two carried until 2026-08-30. A phone that loaded the
	// seat page before the rename shipped still posts to them, and a game at
	// the table cannot be asked to reload mid-phase. Delete both once no
	// session that predates the rename can still be open.
	"finalize":   handleSeatLock,
	"unfinalize": handleSeatUnlock,
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
	case "watch":
		// Public and unauthenticated by design (D-013).
		handleWatch(g, id, segments[2:], w, r)
	case "map.svg":
		handleMap(g, id, w, r)
	case "referee":
		// Token-free on purpose: the referee cookie set at creation is
		// the credential. For anyone else the address is a 404.
		handleRefereeEntry(g, id, w, r)
	case "join":
		if len(segments) != 3 {
			http.NotFound(w, r)
			return
		}
		handleJoin(g, id, segments[2], w, r)
	case "handover":
		// The signature in the path is the whole credential (D-041), so
		// this sits beside join rather than inside a token scope.
		handleHandoverClaim(g, id, segments[2:], w, r)
	case "handover-gm":
		handleGMRoleClaim(g, id, segments[2:], w, r)
	case "session":
		// Token-free: a keyed seat has none (D-049). The signature the
		// phone sends back is the credential.
		handleSeatSession(g, id, w, r)
	case "recover":
		// Token-free for the reason it exists (D-048): the person asking
		// has lost every token they had. The signature they send back is
		// the credential.
		handleRecover(g, id, w, r)
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
	} else if token == "me" {
		// A keyed seat (D-049). The address carries no secret, so the
		// session cookie is what says which power this is.
		power, authorized = f.sessionPower(id, r)
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

// handleRefereeEntry sends the browser that created the game to the GM
// view. The URL carries no secret, so it may sit on the main page for
// every game; it opens the controls only for the browser holding the
// referee cookie.
func handleRefereeEntry(g *game, id string, w http.ResponseWriter, r *http.Request) {
	g.mu.Lock()
	device := refereeCookieValue(r, id)
	ok := g.flow.gmDevice != "" && subtleEqual(device, g.flow.gmDevice)
	target := gmURL(r, id, g.flow.gmToken)
	g.mu.Unlock()
	if !ok {
		http.NotFound(w, r)
		return
	}
	http.Redirect(w, r, target, http.StatusFound)
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
