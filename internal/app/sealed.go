/*
Order secrecy via commit-reveal (ADR-004, ADR-009, ADR-011).

The threat is not a stranger on the network. It is the person whose laptop the
server is running on: at a table the game master owns the machine, reads the
SQLite file, and often plays a power. Every other platform answers that by
taking the game away from the game master — Backstabbr strips a creator who
takes a seat of every game master power, and says the risk of abuse is too
high. This answers it by not having the orders.

	draft     the orders live on the phone. Nothing is sent.
	commit    locking sends the orders encrypted under a key the phone keeps.
	reveal    once every seat has committed, every phone sends its key. The
	          server decrypts, applies them all, and adjudicates.

So between the first lock and the last there is nothing on the server to read.
A game master who opens the database mid-phase finds seven envelopes and no
key to any of them.

**Why an envelope and not a digest.** A digest was the first build. It kept the
orders off the server, and it lost them: a phone that locked and then went flat
held the only copy, so its power was an NMR and its orders were gone. An
envelope is on the server from the lock, and the only thing missing is 32
bytes. Where the key comes from the seat seed (ADR-049), any device holding
that seed can make it again, so a player who kept their seat link can open the
seat on a second phone and release it.

**The commit is the lock** (ADR-011). It is one act with one word in front of
the player, and it is replaceable: locking again replaces the envelope, and
unlocking deletes it, right up until the reveal window opens.

**The reveal is automatic** (ADR-009). No player presses anything. The phone
sees the window open on its next poll and sends. What that buys is the answer
to the obvious failure: a phone that committed and then died holds the only
key to its envelope, so the server flags the seat and the game master decides —
wait, extend, or force, in which case that power is an NMR and the phase's
ordinary no-order rules apply.
No timer races a human, which is ADR-010's rule as well.

**What binds an envelope.** XChaCha20-Poly1305, with the game, the phase and
the power as associated data:

	<gameId>|<phaseIndex>|<power>

Associated data is not encrypted. It is covered by the tag, so decryption fails
if any of the three differs. An envelope therefore cannot be lifted from one
phase or one seat to another, which is what the digest used the same three
fields for.

The wire form is base64url of the 24-byte nonce followed by the ciphertext and
its tag. The plaintext is the order list as JSON, sorted by province.

**A sealed game is a game, not a setting.** `sealed` is decided when the game
is made and never changes, the way a seat holds a token or a key and never
both (ADR-049). Every game made from now on is sealed; every game made before
this existed keeps writing its drafts to the server, because migrating a game
that is mid-phase at a table would lose the orders on the table.
*/
package app

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"time"

	"golang.org/x/crypto/chacha20poly1305"

	"github.com/zond/godip"
)

// revealedOrder is one order as its phone releases it.
type revealedOrder struct {
	Province string   `json:"province"`
	Parts    []string `json:"parts"`
}

/*
sealAAD is what an envelope is bound to and what is never encrypted.

The three fields are exactly the ones that could otherwise let an envelope be
moved: another phase, another seat, another game. The tag covers them, so
decryption fails rather than quietly producing somebody else's orders.
*/
func sealAAD(id string, phaseIndex int, power godip.Nation) []byte {
	return []byte(fmt.Sprintf("%s|%d|%s", id, phaseIndex, power))
}

/*
canonicalOrders is the plaintext inside an envelope: the order list as JSON,
sorted by province.

Sorted because the phone may have built them in any order, and two envelopes of
the same orders should differ only by their nonce and their key. Nothing
depends on that today. It costs one sort and it keeps the plaintext a function
of the orders alone.
*/
func canonicalOrders(orders []revealedOrder) ([]byte, error) {
	sorted := append([]revealedOrder(nil), orders...)
	sort.Slice(sorted, func(a, b int) bool { return sorted[a].Province < sorted[b].Province })
	if sorted == nil {
		sorted = []revealedOrder{}
	}
	return json.Marshal(sorted)
}

// sealOrders encrypts an order list. The server never calls it in a real game
// — the phone does the sealing — but the tests and the reference client need
// exactly the same bytes, so the one implementation lives here.
func sealOrders(id string, phaseIndex int, power godip.Nation, key []byte, orders []revealedOrder) (string, error) {
	plain, err := canonicalOrders(orders)
	if err != nil {
		return "", err
	}
	box, err := chacha20poly1305.NewX(key)
	if err != nil {
		return "", err
	}
	nonce := make([]byte, chacha20poly1305.NonceSizeX)
	if _, err := rand.Read(nonce); err != nil {
		return "", err
	}
	sealed := box.Seal(nonce, nonce, plain, sealAAD(id, phaseIndex, power))
	return base64.RawURLEncoding.EncodeToString(sealed), nil
}

/*
openOrders is the whole of what the server does with a key.

A failure here is not an error to explain in detail. It means the key does not
open this envelope, and the three reasons — a wrong key, a tampered envelope,
an envelope from another phase or seat — are indistinguishable by design.
*/
func openOrders(id string, phaseIndex int, power godip.Nation, key []byte, envelope string) ([]revealedOrder, error) {
	raw, err := base64.RawURLEncoding.DecodeString(envelope)
	if err != nil {
		return nil, fmt.Errorf("the envelope is not base64url")
	}
	if len(raw) < chacha20poly1305.NonceSizeX {
		return nil, fmt.Errorf("the envelope is too short")
	}
	box, err := chacha20poly1305.NewX(key)
	if err != nil {
		return nil, fmt.Errorf("the key is not %v bytes", chacha20poly1305.KeySize)
	}
	nonce, body := raw[:chacha20poly1305.NonceSizeX], raw[chacha20poly1305.NonceSizeX:]
	plain, err := box.Open(nil, nonce, body, sealAAD(id, phaseIndex, power))
	if err != nil {
		return nil, fmt.Errorf("this key does not open what %v locked in", power)
	}
	orders := []revealedOrder{}
	if err := json.Unmarshal(plain, &orders); err != nil {
		return nil, fmt.Errorf("the envelope does not hold an order list")
	}
	return orders, nil
}

// maxEnvelope bounds what a client may send. A movement phase is a handful of
// short orders, so anything past this is not one.
const maxEnvelope = 8192

/*
revealOpen reports whether the phones should release their orders.

Two ways in, both from ADR-009. Every seat the phase asked for an order has
committed, which is the ordinary one; or the deadline and its grace have run
out with at least one seat committed, which is how a table gets past a player
who never locks in. Without the second, one silent phone would keep every
other phone's orders on its own phone and leave the game master nothing to
force but a table of NMRs.

A seat the server locked because its power has nothing to order (ADR-034) is
not asked, so it neither opens the window nor holds it shut. Nobody committed
means nothing to release, and a forced phase from there is every seat an NMR.

The caller must hold g.mu.
*/
func (self *flow) revealOpen() bool {
	if !self.started || self.over() {
		return false
	}
	committed, missing := 0, 0
	for _, s := range self.seats {
		if !s.claimed() || s.autoLocked {
			continue
		}
		if s.sealed == "" {
			missing++
			continue
		}
		committed++
	}
	if committed == 0 {
		// Nothing has been locked in, so there is nothing to release. A
		// forced phase from here is every seat an NMR, which is what a table
		// that ran out of clock with nobody ready looks like.
		return false
	}
	if missing == 0 {
		return true
	}
	// The deadline is the other way in (ADR-009). Without it a single seat
	// that never locks would keep every other phone's orders on its own
	// phone, and the game master would have nothing to force but NMRs.
	until := self.graceEndsAt()
	return until != nil && time.Now().After(*until)
}

// awaitingReveal lists the powers that committed and have not released their
// orders. It is empty until the window opens. The caller must hold g.mu.
func (self *flow) awaitingReveal() []godip.Nation {
	out := []godip.Nation{}
	if !self.revealOpen() {
		return out
	}
	for _, p := range self.powers {
		s := self.seats[p]
		if s.claimed() && !s.autoLocked && !s.revealed {
			out = append(out, p)
		}
	}
	return out
}

/*
clearCommits forgets every hash and every reveal, which is what a new phase
starts from. It runs beside the lock reset in advance(). The caller must hold
g.mu.
*/
func (self *flow) clearCommits() {
	for _, s := range self.seats {
		s.sealed = ""
		s.revealed = false
	}
}

/*
handleSeatCommit is the lock, for a sealed game.

The body carries the envelope and nothing else. Locking again replaces it
(ADR-011); the event log records that a commitment changed and never what is
in it. Once the window is open the envelopes are what the keys are checked
against, so they stop being replaceable — a seat that could re-seal then could
read the others' reveals and change its mind, which is the whole thing this
exists to prevent.
*/
func handleSeatCommit(g *game, id string, power godip.Nation, w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeErr(w, http.StatusMethodNotAllowed, "POST only")
		return
	}
	// Decoded leniently, and checked after the state is. A lock on a game
	// that has ended or is already revealing is a 409 whatever the body
	// says, and answering 400 first would tell a phone to fix the wrong
	// thing.
	body := struct {
		Sealed string `json:"sealed"`
	}{}
	json.NewDecoder(r.Body).Decode(&body)

	g.mu.Lock()
	defer g.mu.Unlock()
	f := g.flow

	if !f.started {
		writeErr(w, http.StatusConflict, "the game has not started")
		return
	}
	if f.over() {
		writeErr(w, http.StatusConflict, "the game is over")
		return
	}
	if f.revealOpen() {
		writeErr(w, http.StatusConflict,
			"every power has locked in — this phase is being revealed")
		return
	}

	s := f.seats[power]
	if s.autoLocked {
		writeErr(w, http.StatusConflict,
			"%v has no order to give this phase, so this seat stays locked", power)
		return
	}
	if body.Sealed == "" || len(body.Sealed) > maxEnvelope {
		writeErr(w, http.StatusBadRequest, "a sealed order list is required")
		return
	}
	again := s.sealed != ""
	s.sealed = body.Sealed
	s.revealed = false
	s.locked = true
	if again {
		f.logEvent(id, "%v changed its locked orders", power)
	} else {
		f.logEvent(id, "%v locked", power)
	}
	g.persist(id)
	writeJSON(w, http.StatusOK, g.seatState(id, power, r))
}

/*
handleSeatUncommit takes a lock back, before the window opens.

It deletes the hash rather than keeping it beside a false flag, because a
commitment the seat has withdrawn is not a commitment: leaving it would let a
phone reveal against a hash it had already abandoned.
*/
func handleSeatUncommit(g *game, id string, power godip.Nation, w http.ResponseWriter, r *http.Request) {
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
	if f.over() {
		writeErr(w, http.StatusConflict, "the game is over")
		return
	}
	s := f.seats[power]
	if s.autoLocked {
		writeErr(w, http.StatusConflict,
			"%v has no order to give this phase, so this seat stays locked", power)
		return
	}
	if f.revealOpen() {
		writeErr(w, http.StatusConflict,
			"every power has locked in — this phase can no longer be unlocked")
		return
	}
	s.sealed = ""
	s.revealed = false
	s.locked = false
	f.logEvent(id, "%v withdrew its lock", power)
	g.persist(id)
	writeJSON(w, http.StatusOK, g.seatState(id, power, r))
}

/*
handleSeatReveal takes one seat's key and opens its envelope.

It is the first moment this server sees an order in a sealed game, and it
happens for every seat inside the same window, so there is nothing left to gain
by reading them. A key that does not open the envelope is refused and logged.
The tag does the checking, so a wrong key, a tampered envelope and an envelope
from another phase all fail the same way, which is what an AEAD is for.

The orders are applied through the same setOrder path a live request used to
take, so validation, the illegal mark (ADR-029) and the stored rows replay
reads back are all exactly what they were.

The last reveal adjudicates, which is where ADR-008's auto-advance now lives
for a sealed game.
*/
func handleSeatReveal(g *game, id string, power godip.Nation, w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeErr(w, http.StatusMethodNotAllowed, "POST only")
		return
	}
	body := struct {
		Key string `json:"key"`
	}{}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "bad body: %v", err)
		return
	}

	g.mu.Lock()
	defer g.mu.Unlock()
	f := g.flow

	if !f.started || f.over() {
		writeErr(w, http.StatusConflict, "the game is not taking orders")
		return
	}
	if !f.revealOpen() {
		writeErr(w, http.StatusConflict, "not every power has locked in yet")
		return
	}
	s := f.seats[power]
	if s.sealed == "" {
		writeErr(w, http.StatusConflict, "%v committed nothing this phase", power)
		return
	}
	if s.revealed {
		// Already in. Answering with the state rather than an error keeps a
		// phone that polled twice from showing the player a failure.
		writeJSON(w, http.StatusOK, g.seatState(id, power, r))
		return
	}

	key, err := base64.RawURLEncoding.DecodeString(body.Key)
	if err != nil || len(key) != chacha20poly1305.KeySize {
		writeErr(w, http.StatusBadRequest, "a key is %v base64url bytes",
			chacha20poly1305.KeySize)
		return
	}
	orders, err := openOrders(id, f.phaseIndex, power, key, s.sealed)
	if err != nil {
		f.logEvent(id, "%v sent a key that does not open what it locked in", power)
		writeErr(w, http.StatusConflict, "%v", err)
		return
	}

	for _, one := range orders {
		prov := godip.Province(one.Province)
		if !g.ownsProvince(power, prov) {
			writeErr(w, http.StatusForbidden, "%v is not yours to order", prov)
			return
		}
		if len(one.Parts) == 0 {
			continue
		}
		if err := g.setOrder(prov, one.Parts); err != nil {
			// The hash matched, so these are the orders the seat meant. One
			// the parser cannot read at all is a client bug, and refusing it
			// here leaves the seat unrevealed for the game master to force.
			writeErr(w, http.StatusBadRequest, "%v: %v", prov, err)
			return
		}
	}
	s.revealed = true
	f.logEvent(id, "%v revealed %v order(s)", power, len(orders))

	if len(f.awaitingReveal()) == 0 {
		f.logEvent(id, "every power revealed — adjudicating")
		if err := g.adjudicate(id, false); err != nil {
			writeErr(w, http.StatusInternalServerError, "adjudicate: %v", err)
			return
		}
	} else {
		g.persist(id)
	}
	writeJSON(w, http.StatusOK, g.seatState(id, power, r))
}
