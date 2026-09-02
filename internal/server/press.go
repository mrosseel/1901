// Press: the rooms, and the rules the server keeps for them (ADR-053..055).
//
// A room is the unit, not a message (ADR-053). The server cannot read what is
// said in one (ADR-054): it holds ciphertext and wrapped keys, and the
// decision it does make is who may open a room, who may write into it, and
// when. That is what is here. The wire shapes are in pressview.go, the
// endpoints in presshttp.go, and the rows in pressstore.go.

package server

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"sort"
	"strings"
	"time"

	"github.com/zond/godip"
)

/*
gmHolder is the game master in a member list and a wrap table.

A power's name is a plain word, so a star cannot collide with one, and every
place that stores a holder stores this same string. The game master is never
in `members`: membership is what a power consents to, and the referee's
presence is a game setting the whole table was told about before it joined.
*/
const gmHolder = "*gm"

// pressKeyBytes is the length of a public box key, X25519, base64url.
const pressKeyBytes = 32

// pressThreadIDBytes is the length of a room id. The opener makes it and signs
// it (ADR-056), so this server checks its shape and never its value.
const pressThreadIDBytes = 16

// maxPressBody is the biggest envelope a message may carry. A boxed sentence
// is a few hundred bytes; this is room for a long one and a bound on what a
// single POST can put in memory.
const maxPressBody = 16 << 10

// maxPressThreads bounds one game. A seven-power board has 127 possible
// rooms; anything past this is a client in a loop, not a table talking.
const maxPressThreads = 512

// defaultPressSilenceSeconds is WDC 4b2's writing minute: the last minute of
// a phase is for writing orders, and negotiation is not allowed in it.
const defaultPressSilenceSeconds = 60

// maxPressSilenceSeconds keeps a typo from closing press for a whole phase.
const maxPressSilenceSeconds = 3600

// pressMessage is one boxed, signed message. Nothing here is readable by this
// process: Box is the ciphertext and Sig is the sender's Ed25519 signature
// over it, checked on the reading device and never here.
type pressMessage struct {
	Seq int `json:"seq"`
	// Sender is a power's name, or gmHolder.
	Sender string `json:"sender"`
	// PhaseIndex is where in the game this was said, so a thread can draw a
	// line at each adjudication instead of running the seasons together.
	PhaseIndex int    `json:"phaseIndex"`
	Box        string `json:"box"`
	Sig        string `json:"sig"`
	At         string `json:"at"`
}

// pressThread is one room.
type pressThread struct {
	id string
	// openedBy is a power's name or gmHolder. It is who made the room key.
	openedBy string
	// members are the powers in the room, sorted, and never the game
	// master. A room with one member is that power's own notes.
	members []godip.Nation
	// openedAt is the time the opener stamped and signed, kept exactly as it
	// was written. Reformatting it would leave a manifest nothing can check.
	openedAt string
	// openerBoxPub is the opener's press key at the moment the room opened,
	// which is what every reader derives the wrap key from (ADR-056).
	openerBoxPub string
	// openerSignPub is the opener's signing key then, so a room opened before
	// a handover is still checked against the key that opened it.
	openerSignPub string
	// manifestSig is the opener's signature over the whole room. This server
	// checks it for consistency; the reading device is what decides.
	manifestSig string
	// keys is the room key wrapped once per holder: each member, plus
	// gmHolder when the game master reads press.
	keys map[string]string
	// read is how far each holder has read.
	read     map[string]int
	messages []pressMessage
}

// memberSet is the room's members as a lookup.
func (t *pressThread) has(power godip.Nation) bool {
	for _, m := range t.members {
		if m == power {
			return true
		}
	}
	return false
}

// key is the member list as one string, sorted. Two rooms with the same
// members are the same room (§4.2 of the plan), and this is the comparison.
func memberKey(members []godip.Nation) string {
	return strings.Join(nations(members), ",")
}

func (t *pressThread) memberKey() string {
	return memberKey(t.members)
}

/*
pressActor is who is asking. A seat asks as its power; the game master asks as
gmHolder and holds no power.

Every route below takes one of these and nothing else, so there is no path
where a power is read from a request body.
*/
type pressActor struct {
	holder string
	power  godip.Nation
	isGM   bool
}

func seatActor(power godip.Nation) pressActor {
	return pressActor{holder: string(power), power: power}
}

func gmActor() pressActor {
	return pressActor{holder: gmHolder, isGM: true}
}

// reads says whether this actor may see a thread at all. The game master sees
// every room and only when the setting says so; a power sees the rooms it is
// in. There is no third case, which is what keeps a leak from being a filter
// bug (DESIGN.md, endpoint discipline).
func (f *flow) actorReads(actor pressActor, t *pressThread) bool {
	if actor.isGM {
		return f.settings.GMReadsPress
	}
	return t.has(actor.power)
}

// pressEnabled says whether this game carries messages at all (ADR-023).
// A sandbox never does: it has no seats to send between (ADR-047).
func (f *flow) pressEnabled() bool {
	if f.settings.Sandbox {
		return false
	}
	return f.settings.PressMode == "fullpress" || f.settings.PressMode == "rulebook"
}

// pressSilenceSeconds is the writing time this game gives, with the default
// applied. A game written before the setting existed gets WDC's minute.
func (f *flow) pressSilence() time.Duration {
	if f.settings.PressSilenceSeconds < 0 {
		return 0
	}
	return time.Duration(f.settings.PressSilenceSeconds) * time.Second
}

// pressSilenceAt is when press closes for this phase, or nil when nothing
// closes it: no deadline, or no silence asked for.
func (f *flow) pressSilenceAt() *time.Time {
	if f.deadlineAt == nil {
		return nil
	}
	silence := f.pressSilence()
	if silence <= 0 {
		return nil
	}
	at := f.deadlineAt.Add(-silence)
	return &at
}

/*
pressWritable says whether this actor may say something into this room now,
and why not when it may not.

The refusals are in the order a player meets them, and the reason is written
to be shown: it replaces the message box in the panel, so it says what the
table is doing, not what the request did wrong.

A power's own notes are not negotiation, so the rulebook gate, the writing
minute and elimination all leave them alone. Only the game ending closes them.

`opener` is who made the room, empty when the room is being made now. It is
part of the test because a room's member list alone does not say whose room it
is: the game master may open a room holding one power, and that is a ruling
addressed to that power, not that power's notepad. Reading the exemption off
the member list alone let a power answer a game master's room during the
writing minute, in a retreat phase, and after elimination.
*/
func (self *game) pressWritable(actor pressActor, opener string, members []godip.Nation) (bool, string) {
	if isNotes(actor, opener, members) {
		return self.pressNotesWritable()
	}
	if ok, reason := self.pressWritableNow(actor); !ok {
		return false, reason
	}
	// WDC 3c: nobody may negotiate with a player who has no centre left.
	out := self.eliminated()
	for _, m := range members {
		if out[m] {
			return false, string(m) + " is eliminated and may not negotiate"
		}
	}
	return true, ""
}

/*
isNotes says whether this is the actor's own notepad: one member, that member,
and opened by them. An empty opener is a room being opened now, whose opener is
the actor by definition.
*/
func isNotes(actor pressActor, opener string, members []godip.Nation) bool {
	if actor.isGM || len(members) != 1 || members[0] != actor.power {
		return false
	}
	return opener == "" || opener == actor.holder
}

// pressNotesWritable is the gate on a power's own notepad: only whether there
// is a game to write about. Notes are not negotiation, so the rulebook gate,
// the writing minute and elimination all leave them alone.
func (self *game) pressNotesWritable() (bool, string) {
	f := self.flow
	if !f.pressEnabled() {
		return false, "this game carries no messages"
	}
	if !f.started {
		return false, "the game has not started"
	}
	if f.over() {
		return false, "the game is over"
	}
	return true, ""
}

/*
pressWritableNow is every gate that does not depend on who is in the room.

It is what the panel shows before a room is chosen, and the first half of the
per-room answer above.
*/
func (self *game) pressWritableNow(actor pressActor) (bool, string) {
	f := self.flow
	if ok, reason := self.pressNotesWritable(); !ok {
		return false, reason
	}
	if f.settings.PressMode == "rulebook" && self.state.Phase().Type() != godip.Movement {
		// WDC 3b, and the rulebook it cites.
		return false, "no negotiation during retreats and builds"
	}
	if at := f.pressSilenceAt(); at != nil && !time.Now().Before(*at) {
		// WDC 4b2 and 4d. This moment is before the deadline, so a phase in
		// its grace period is silent too.
		return false, "writing time, no negotiation"
	}
	if !actor.isGM && self.eliminated()[actor.power] {
		// WDC 3c.
		return false, "you are eliminated and may not negotiate"
	}
	return true, ""
}

// eliminated is every power holding no supply centre. Before the first
// adjudication nobody is out, which is what the starting position says.
func (self *game) eliminated() map[godip.Nation]bool {
	counts := self.centreCounts()
	out := map[godip.Nation]bool{}
	for _, p := range self.flow.powers {
		out[p] = counts[string(p)] == 0
	}
	return out
}

// pressUnread is how many messages this actor has not read, across every room
// it can see.
func (f *flow) pressUnread(actor pressActor) int {
	total := 0
	for _, t := range f.press {
		if !f.actorReads(actor, t) {
			continue
		}
		seen := t.read[actor.holder]
		for _, m := range t.messages {
			if m.Seq > seen && m.Sender != actor.holder {
				total++
			}
		}
	}
	return total
}

// openerSignPub is the signing key the opener holds right now, kept on the
// room so that a handover later does not leave the room unverifiable
// (ADR-056). A game master opener signs with the key of ADR-048.
func (f *flow) openerSignPub(actor pressActor) string {
	if actor.isGM {
		return f.gmPublicKey
	}
	if s := f.seats[actor.power]; s != nil {
		return s.signPub
	}
	return ""
}

/*
pressManifestBody is the sentence the opener signs over a room.

It is the room's whole immutable description plus a digest of every wrap in it,
so a wrap that was replaced, moved to another holder or lifted out of another
room with the same members changes the sentence and breaks the signature. The
same string is built in web/src/press.ts, and the two must not drift.
*/
func pressManifestBody(id string, t *pressThread) string {
	holders := make([]string, 0, len(t.keys))
	for holder := range t.keys {
		holders = append(holders, holder)
	}
	sort.Strings(holders)
	digests := make([]string, 0, len(holders))
	for _, holder := range holders {
		sum := sha256.Sum256([]byte(t.keys[holder]))
		digests = append(digests,
			holder+"="+base64.RawURLEncoding.EncodeToString(sum[:]))
	}
	return "1901 press room v1|" + strings.Join([]string{
		id,
		t.id,
		t.openedBy,
		t.openerBoxPub,
		t.openedAt,
		t.memberKey(),
		strings.Join(digests, ","),
	}, "|")
}

// checkPressManifest verifies the opener's signature over a room. It is a
// consistency check and not the security boundary: the reading device runs the
// same check against the key it pinned, which is the one that counts.
func checkPressManifest(id string, t *pressThread) bool {
	key, err := base64.RawURLEncoding.DecodeString(t.openerSignPub)
	if err != nil || len(key) != ed25519.PublicKeySize {
		return false
	}
	sig, err := base64.RawURLEncoding.DecodeString(t.manifestSig)
	if err != nil || len(sig) != ed25519.SignatureSize {
		return false
	}
	return ed25519.Verify(ed25519.PublicKey(key), []byte(pressManifestBody(id, t)), sig)
}

// parseMembers turns names from a request into powers of this variant,
// sorted and deduplicated. The error is the message the caller shows.
func (f *flow) parseMembers(names []string) ([]godip.Nation, string) {
	known := map[godip.Nation]bool{}
	for _, p := range f.powers {
		known[p] = true
	}
	seen := map[godip.Nation]bool{}
	out := []godip.Nation{}
	for _, name := range names {
		p := godip.Nation(name)
		if !known[p] {
			return nil, name + " is not a power in this game"
		}
		if seen[p] {
			continue
		}
		seen[p] = true
		out = append(out, p)
	}
	sort.Slice(out, func(i, j int) bool { return out[i] < out[j] })
	return out, ""
}

// pressThreadFor finds a room this actor may read. The caller must hold the
// game lock.
func (self *game) pressThreadFor(actor pressActor, threadID string) (*pressThread, bool) {
	f := self.flow
	if !f.pressEnabled() || threadID == "" {
		return nil, false
	}
	if actor.isGM && !f.settings.GMReadsPress {
		return nil, false
	}
	t, found := f.pressByID[threadID]
	if !found || !f.actorReads(actor, t) {
		return nil, false
	}
	return t, true
}
