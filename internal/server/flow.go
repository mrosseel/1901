// The flow: the seats a game has, who is in them, and what the table is
// waiting for.
//
// A game is created by a GM, joined through one shared invite, and played by
// seats that are anonymous to each other (ADR-020). The flow is that half of
// a game: the board it plays on is game.go, and the two are joined at
// game.flow.
//
// Nothing here answers a request. The handlers are in create.go, join.go,
// gm.go, seat.go and public.go, and they all read this.

package server

import (
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"log"
	"math/big"
	"time"

	"github.com/zond/godip"
	"github.com/zond/godip/variants/common"

	"spring1901/spike/internal/variant"
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

// seat is one power in one game together with its claim state.
// It deliberately carries no player name (ADR-020).
type seat struct {
	power godip.Nation
	// token is the old credential: the secret in the address, which is
	// also the secret in the database. A seat has this or a key, never
	// both (ADR-049), and no game is migrated from one to the other.
	token string // seatToken, empty until claimed
	// signPub is the public half of the key the joining phone made
	// (ADR-049), base64url. The server can open nothing with it.
	signPub string
	// boxPub is the public half of this seat's press key (ADR-054),
	// base64url X25519. Empty until the seat first opens the press panel,
	// because a seat claimed before press existed never made one, and a
	// seat holding a token has no seed to derive one from.
	boxPub string
	// boxSig is this seat's own signature over its box key, so a reader can
	// check that the key the server handed out is the key the seat
	// published. Empty on a seat that holds a token and has no signing key.
	boxSig string
	device string // device secret, empty until claimed
	isGM   bool
	locked bool

	// epoch is the handover counter (ADR-041). Every link ever minted for
	// this seat is signed for one epoch, so taking the seat and raising it
	// kills the rest — including the phone that just gave the power away.
	epoch int

	// sealed is the envelope this seat locked in, empty until it does and
	// cleared by every adjudication (ADR-004). In a sealed game it is the
	// only thing the server holds about a power's orders until the reveal,
	// and it holds no key to it.
	sealed string
	// revealed says this seat has sent the key to its envelope and the
	// orders are on the board. Only a sealed game uses it.
	revealed bool

	// autoLocked marks a seat the server locked because its power has no
	// legal order this phase (ADR-034). It is derived from the resolved
	// position, so it is recomputed on restore rather than stored.
	autoLocked bool
}

// claimed says whether somebody holds this seat. A seat is held by a token
// or by a key, never both (ADR-049), so no count anywhere may look at one of
// them alone.
func (s *seat) claimed() bool {
	return s.token != "" || s.signPub != ""
}

// flow holds the M1 state that sits on top of the godip board.
// Every field is guarded by the enclosing game's mutex.
type flow struct {
	gmToken string
	// gmEpoch is the handover counter for the role (ADR-041). The role and a
	// power are separate acts and fail differently, so they count
	// separately: a game master who gives the role away still plays.
	gmEpoch int
	// gmPublicKey is the Ed25519 public half the game master's browser
	// registered (ADR-048), base64url. Empty means the game has no key and
	// cannot be recovered by its words, which is every game made before
	// this existed and every one whose game master declined.
	gmPublicKey string
	// gmBoxPub is the public half of the game master's press key (ADR-054),
	// derived from the same secret the twelve words recover. Empty unless
	// this game has a game master who reads press.
	gmBoxPub string
	// gmBoxSig is the game master's own signature over it, checked against
	// gmPublicKey (ADR-048) the way a seat's is checked against its own.
	gmBoxSig    string
	inviteToken string
	// gmDevice is the referee cookie secret: the browser that created the
	// game holds it, and it is what /game/{id}/referee/ answers to. It
	// keeps the GM link off the creation screen and out of every share.
	gmDevice string
	// sandboxToken is the whole credential of a sandbox (ADR-047), minted at
	// creation and empty in every other game. Whoever holds the link drives
	// every power; the bare game id stays read-only for everybody, exactly
	// as a real game's watch address is. A link and not a cookie, because a
	// tournament hands the laptop to the next round's operator.
	sandboxToken string

	settings        settings
	settingsVersion int

	started    bool
	deadlineAt *time.Time
	// sealed says this game keeps its drafts on the phones and takes a hash
	// at the lock (ADR-004). It is decided when the game is made and never
	// changes: a game that predates commit-reveal keeps writing its drafts
	// to the server, because migrating a game mid-phase at a table would
	// lose the orders on the table.
	sealed bool
	// result is how the game ended, nil while it runs (ADR-044). Everything
	// that could move the board reads flow.over() before it does.
	result *gameResult
	// A non-DIAS draw needs the explicit consent of every survivor it would
	// exclude (ADR-052). It remains pending until all reply or play moves on.
	drawProposal *drawProposal

	seats       map[godip.Nation]*seat
	bySeatToken map[string]godip.Nation
	bySignPub   map[string]godip.Nation
	byDevice    map[string]godip.Nation
	// sessions are open seat sessions, cookie value to power (ADR-049).
	// They live in memory on purpose: a restart signs every phone back in
	// without asking, because the seed is on the device, and nothing that
	// opens a seat is left in a file that could be copied.
	sessions map[string]godip.Nation
	gmPower  godip.Nation // empty until start, and always empty when !gmPlays

	// powers are this variant's powers, in a stable order. The seat count
	// follows the variant, so nothing here assumes seven.
	powers []godip.Nation

	// phaseIndex counts completed adjudications. It keys the stored order
	// history that replay() feeds back into godip.
	phaseIndex int
	createdAt  time.Time

	// press are the rooms of this game in the order they were opened, and
	// the index by id (ADR-053). The server holds ciphertext and a member
	// list; it holds no key to any of it.
	press     []*pressThread
	pressByID map[string]*pressThread
	// keyChains are the signed steps from a seat's old signing key to its new
	// one, one per handover that carried the outgoing player's link
	// (ADR-056). They let a reader's pin follow a real handover without
	// asking, and they cannot be made up by this server.
	keyChains []keyChain

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
	sandboxToken := ""
	if s.Sandbox {
		if sandboxToken, err = newToken(); err != nil {
			return nil, err
		}
	}
	f := &flow{
		gmToken:      gmToken,
		inviteToken:  inviteToken,
		gmDevice:     gmDevice,
		sandboxToken: sandboxToken,
		settings:     s,
		// Every game made from here on (ADR-004). Nothing turns it off:
		// it is how the app works, not a rule the table agrees.
		//
		// A sandbox is the exception, and not because it is newer: there is
		// one driver and no other player, so there is nobody to hide from
		// (ADR-047). Sealing it would seal orders against their own author.
		sealed:      !s.Sandbox,
		createdAt:   time.Now().UTC(),
		powers:      variant.SortedNations(v),
		seats:       map[godip.Nation]*seat{},
		bySeatToken: map[string]godip.Nation{},
		bySignPub:   map[string]godip.Nation{},
		byDevice:    map[string]godip.Nation{},
		sessions:    map[string]godip.Nation{},
		pressByID:   map[string]*pressThread{},
	}
	for _, power := range f.powers {
		f.seats[power] = &seat{power: power}
	}
	return f, nil
}

// logEvent appends to the append-only event log (ADR-007).
func (self *flow) logEvent(id, format string, args ...interface{}) {
	line := fmt.Sprintf("%v %v", time.Now().UTC().Format(time.RFC3339), fmt.Sprintf(format, args...))
	self.events = append(self.events, line)
	log.Printf("game %v: %v", id, line)
}

// joinerSeats is how many powers the invite may hand out. When the GM
// plays, one power stays behind as the leftover (ADR-021).
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

// nations renders a list of powers as the strings a JSON answer carries.
func nations(powers []godip.Nation) []string {
	out := make([]string, 0, len(powers))
	for _, p := range powers {
		out = append(out, string(p))
	}
	return out
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

// canForce reports whether the GM may force adjudication (ADR-007, ADR-010).
func (self *flow) canForce() bool {
	if !self.started || self.over() {
		return false
	}
	active := self.activeSeats()
	if active == 0 {
		return false
	}
	// A sealed game that is waiting on a reveal (ADR-009). It comes first
	// because every power being locked in is exactly that state: the phase
	// is settled and what is missing is a phone that has not sent its
	// orders. The game master decides between waiting for it and resolving
	// without it, and no timer gates the button, the way no timer fires a
	// deadline (ADR-010).
	if self.sealed && self.revealOpen() && len(self.awaitingReveal()) > 0 {
		return true
	}
	done := self.lockedCount()
	if done >= active {
		// Auto-adjudication already covers this case (ADR-008).
		return false
	}
	// The grace period, where the settings allow one: orders are still taken
	// after the deadline, so the GM may not force the phase until it ends.
	until := self.graceEndsAt()
	return until != nil && time.Now().After(*until)
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
