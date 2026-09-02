/*
Press: messages between powers, which this server cannot read (ADR-053).

The rules this file enforces come from two places. The rulebook says
negotiation is open: players may talk in twos, threes or all seven, in secret
or in the open. So a press thread is a **room** with a member list fixed when
it opens, and every message in it goes to every member. There is no CC and no
BCC, because a corridor has neither.

The WDC 2019 house rules add the gates, and every one of them is enforced here
rather than asked of the client:

	3b    no negotiation during retreats and adjustments  -> pressMode rulebook
	3c    an eliminated player may not negotiate          -> eliminated()
	4b2   the writing minute is silent                    -> pressSilenceSeconds
	4d    the silence is enforced, not advised            -> the same

What the server holds is ciphertext, a member list, a sender and a time. The
room key is made on a phone and wrapped once per member under that member's
public box key, so the process that stores the messages holds no key to any of
them (ADR-054). That matters here for the same reason it matters for orders:
the server is usually the game master's laptop, and the game master usually
plays.

A game master who does NOT play may be read into every room, and only then
(settings.gmReadsPress). The sender wraps the room key for the game master as
well, so the referee is a member of every room and needs a mailbox. The server
refuses an open that leaves the wrap out. It cannot check that the wrap is a
correct one, and does not pretend to: a modified client can send noise, and the
mailbox shows that room as unreadable.
*/
package app

import (
	"encoding/base64"
	"encoding/json"
	"log"
	"net/http"
	"sort"
	"spring1901/spike/internal/httpx"
	"strconv"
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
	members  []godip.Nation
	openedAt time.Time
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

// ---------------------------------------------------------------------------
// The wire
// ---------------------------------------------------------------------------

type pressThreadJSON struct {
	ID       string   `json:"id"`
	Members  []string `json:"members"`
	OpenedBy string   `json:"openedBy"`
	OpenedAt string   `json:"openedAt"`
	// Wrapped is this reader's own copy of the room key and nobody else's.
	Wrapped string `json:"wrapped"`
	// Notes marks the reader's own single-member room, which the panel pins.
	Notes    bool           `json:"notes"`
	Unread   int            `json:"unread"`
	LastSeq  int            `json:"lastSeq"`
	LastAt   string         `json:"lastAt"`
	Messages []pressMessage `json:"messages,omitempty"`
}

type pressStateJSON struct {
	Enabled bool `json:"enabled"`
	// Open says a message may be sent right now, and Reason says why not.
	Open   bool   `json:"open"`
	Reason string `json:"reason,omitempty"`
	/*
		Whether this power's own notepad takes writing. It is a different
		question from Open: the notepad survives the writing minute, a retreat
		phase and elimination (ADR-055), and it closes only when the game does.
	*/
	NotesOpen   bool   `json:"notesOpen"`
	NotesReason string `json:"notesReason,omitempty"`
	// SilenceAt is when the writing time starts, so the panel can count
	// down to it rather than only refuse afterwards.
	SilenceAt interface{}       `json:"silenceAt"`
	Mode      string            `json:"mode"`
	You       string            `json:"you"`
	GMReads   bool              `json:"gmReads"`
	Keys      map[string]string `json:"keys"`
	// Each published box key's signature, by holder (ADR-054).
	KeySigs map[string]string `json:"keySigs"`
	// SignKeys are the seats' Ed25519 public halves, so a reader can check
	// that a line really came from the power it names. A public key is not
	// a secret, and the server checking signatures instead would be the
	// server deciding who said what.
	SignKeys   map[string]string `json:"signKeys"`
	Eliminated []string          `json:"eliminated"`
	Threads    []pressThreadJSON `json:"threads"`
	Unread     int               `json:"unread"`
}

// pressView is the whole press state one actor may see: the rooms, this
// reader's wrapped key for each, and the public box keys it needs to open a
// new room. Message bodies come from the thread route, not from here.
func (self *game) pressView(actor pressActor) pressStateJSON {
	f := self.flow
	out := pressStateJSON{
		Enabled:    f.pressEnabled(),
		Mode:       f.settings.PressMode,
		You:        actor.holder,
		GMReads:    f.settings.GMReadsPress,
		Keys:       map[string]string{},
		KeySigs:    map[string]string{},
		SignKeys:   map[string]string{},
		Eliminated: []string{},
		Threads:    []pressThreadJSON{},
		SilenceAt:  rfc3339(f.pressSilenceAt()),
	}
	if !out.Enabled {
		out.Reason = "this game carries no messages"
		return out
	}
	// Every power that has published a box key, so a room can be opened
	// with any of them. A public key is not a secret; what it protects is.
	for _, p := range f.powers {
		s := f.seats[p]
		if s == nil {
			continue
		}
		if s.boxPub != "" {
			out.Keys[string(p)] = s.boxPub
			out.KeySigs[string(p)] = s.boxSig
		}
		if s.signPub != "" {
			out.SignKeys[string(p)] = s.signPub
		}
	}
	if f.settings.GMReadsPress {
		if f.gmBoxPub != "" {
			out.Keys[gmHolder] = f.gmBoxPub
			out.KeySigs[gmHolder] = f.gmBoxSig
		}
		// The referee signs what it says with the key of ADR-048, so the
		// same public half that recovers a game also checks a ruling.
		if f.gmPublicKey != "" {
			out.SignKeys[gmHolder] = f.gmPublicKey
		}
	}
	if f.started {
		for p, gone := range self.eliminated() {
			if gone {
				out.Eliminated = append(out.Eliminated, string(p))
			}
		}
		sort.Strings(out.Eliminated)
	}
	// Whether anything at all may be said now, before a room is chosen. The
	// per-room answer comes from pressWritable at the moment of sending.
	out.Open, out.Reason = self.pressWritableNow(actor)
	out.NotesOpen, out.NotesReason = self.pressNotesWritable()

	for _, t := range f.press {
		if !f.actorReads(actor, t) {
			continue
		}
		out.Threads = append(out.Threads, t.summary(actor))
	}
	out.Unread = f.pressUnread(actor)
	return out
}

func (t *pressThread) summary(actor pressActor) pressThreadJSON {
	row := pressThreadJSON{
		ID:       t.id,
		Members:  nations(t.members),
		OpenedBy: t.openedBy,
		OpenedAt: t.openedAt.UTC().Format(time.RFC3339),
		Wrapped:  t.keys[actor.holder],
		Notes:    isNotes(actor, t.openedBy, t.members),
	}
	seen := t.read[actor.holder]
	for _, m := range t.messages {
		if m.Seq > seen && m.Sender != actor.holder {
			row.Unread++
		}
	}
	if n := len(t.messages); n > 0 {
		row.LastSeq = t.messages[n-1].Seq
		row.LastAt = t.messages[n-1].At
	}
	return row
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// handlePress is GET: the rooms this actor may see, with no message bodies.
func handlePress(g *game, id string, actor pressActor, w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		httpx.WriteErr(w, http.StatusMethodNotAllowed, "GET only")
		return
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	if !g.flow.pressEnabled() {
		http.NotFound(w, r)
		return
	}
	if actor.isGM && !g.flow.settings.GMReadsPress {
		http.NotFound(w, r)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, g.pressView(actor))
}

type pressKeyJSON struct {
	BoxPub string `json:"boxPub"`
	/*
		The seat's own signature over its box key (ADR-054). The server hands
		these out and could hand out its own instead, so the readers check them
		against the signing key the seat authenticates with. That does not make
		an actively lying server harmless — it can lie about both halves at once,
		and ADR-054 says so — but it does mean a device that has ever seen a
		power's real signing key can tell when the pair stops matching.
	*/
	Sig string `json:"sig"`
}

// checkBoxPub says whether these bytes are an X25519 public key at all.
func checkBoxPub(encoded string) bool {
	raw, err := base64.RawURLEncoding.DecodeString(encoded)
	return err == nil && len(raw) == pressKeyBytes
}

/*
handlePressKey publishes this holder's public box key.

It is posted rather than carried in the join body because a seat may have been
claimed long before press was ever opened, and because a seat holding a token
has no seed to derive from and makes its key the first time it needs one. The
holder may replace its own key: a handover gives the seat new bytes, and the
rooms the previous player was in stop opening, which is the point.
*/
func handlePressKey(g *game, id string, actor pressActor, w http.ResponseWriter, r *http.Request) {
	g.mu.Lock()
	defer g.mu.Unlock()
	f := g.flow
	if !f.pressEnabled() {
		http.NotFound(w, r)
		return
	}
	if actor.isGM && !f.settings.GMReadsPress {
		http.NotFound(w, r)
		return
	}
	switch r.Method {
	case http.MethodGet:
		if actor.isGM {
			httpx.WriteJSON(w, http.StatusOK, pressKeyJSON{BoxPub: f.gmBoxPub, Sig: f.gmBoxSig})
			return
		}
		httpx.WriteJSON(w, http.StatusOK, pressKeyJSON{
			BoxPub: f.seats[actor.power].boxPub,
			Sig:    f.seats[actor.power].boxSig,
		})
	case http.MethodPost:
		var body pressKeyJSON
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxPressBody)).Decode(&body); err != nil {
			httpx.WriteErr(w, http.StatusBadRequest, "bad body: %v", err)
			return
		}
		if !checkBoxPub(body.BoxPub) {
			httpx.WriteErr(w, http.StatusBadRequest, "boxPub must be 32 base64url bytes")
			return
		}
		if actor.isGM {
			f.gmBoxPub, f.gmBoxSig = body.BoxPub, body.Sig
		} else {
			f.seats[actor.power].boxPub = body.BoxPub
			f.seats[actor.power].boxSig = body.Sig
		}
		g.persist(id)
		httpx.WriteJSON(w, http.StatusOK, body)
	default:
		httpx.WriteErr(w, http.StatusMethodNotAllowed, "GET or POST")
	}
}

type pressOpenRequest struct {
	Members []string `json:"members"`
	/*
		Do not hand back the room these members already have.

		A handover gives a seat new bytes (ADR-049), so every room the previous
		player was in stops opening for the new one. Without this the reuse rule
		would hand that unreadable room back for ever and those powers could
		never talk again. Only the device knows it cannot open a room, so only
		the device can ask.
	*/
	Fresh bool `json:"fresh"`
	// Keys is the room key wrapped once per holder. The server checks that
	// the set of holders is exactly right and never what is inside them.
	Keys map[string]string `json:"keys"`
}

/*
handlePressOpen makes a room, or hands back the one that already has these
members.

Reusing an existing room is what stops a game ending with forty threads that
are all the same three people. It is also why the member list is the room's
identity: at a table you do not open a second conversation with the same two
people, you keep talking.
*/
func handlePressOpen(g *game, id string, actor pressActor, w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		httpx.WriteErr(w, http.StatusMethodNotAllowed, "POST only")
		return
	}
	var body pressOpenRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxPressBody)).Decode(&body); err != nil {
		httpx.WriteErr(w, http.StatusBadRequest, "bad body: %v", err)
		return
	}

	g.mu.Lock()
	defer g.mu.Unlock()
	f := g.flow
	if !f.pressEnabled() {
		http.NotFound(w, r)
		return
	}
	if actor.isGM && !f.settings.GMReadsPress {
		http.NotFound(w, r)
		return
	}

	members, err := f.parseMembers(body.Members)
	if err != "" {
		httpx.WriteErr(w, http.StatusBadRequest, "%v", err)
		return
	}
	if len(members) == 0 {
		httpx.WriteErr(w, http.StatusBadRequest, "a room needs at least one power in it")
		return
	}
	// A power is always in its own rooms. Saying otherwise would be a room
	// opened in somebody else's name.
	if !actor.isGM {
		found := false
		for _, m := range members {
			if m == actor.power {
				found = true
			}
		}
		if !found {
			httpx.WriteErr(w, http.StatusForbidden, "you are not in that room")
			return
		}
	}
	if actor.isGM && len(members) == 0 {
		httpx.WriteErr(w, http.StatusBadRequest, "a room needs at least one power in it")
		return
	}

	if ok, reason := g.pressWritable(actor, "", members); !ok {
		httpx.WriteErr(w, http.StatusConflict, "%v", reason)
		return
	}

	/*
		The same members is the same room, so three players who keep talking keep
		one conversation. A room the game master opened is not one of those: it
		is a ruling addressed to those powers, and a power's own notepad must not
		turn out to be a room the referee opened with that power in it.
	*/
	want := memberKey(members)
	if !body.Fresh {
		// The newest, so a room opened after a handover is the one those
		// members keep talking in rather than the one nobody can open.
		for i := len(f.press) - 1; i >= 0; i-- {
			t := f.press[i]
			if t.memberKey() != want || (t.openedBy == gmHolder) != actor.isGM {
				continue
			}
			if !f.actorReads(actor, t) {
				continue
			}
			httpx.WriteJSON(w, http.StatusOK, t.summary(actor))
			return
		}
	}
	if len(f.press) >= maxPressThreads {
		httpx.WriteErr(w, http.StatusConflict, "this game has too many rooms open")
		return
	}

	// Exactly one wrapped key per holder: every member, plus the game
	// master when the game master reads press. Missing one would leave a
	// member unable to read the room they are in; an extra one would be a
	// key handed to somebody the members did not agree to.
	holders := map[string]bool{}
	for _, m := range members {
		holders[string(m)] = true
	}
	if f.settings.GMReadsPress {
		if f.gmBoxPub == "" {
			httpx.WriteErr(w, http.StatusConflict,
				"the game master reads press in this game but has published no key")
			return
		}
		holders[gmHolder] = true
	}
	if actor.isGM {
		holders[gmHolder] = true
	}
	for holder := range holders {
		if body.Keys[holder] == "" {
			httpx.WriteErr(w, http.StatusBadRequest, "no room key wrapped for %v", holder)
			return
		}
	}
	for holder := range body.Keys {
		if !holders[holder] {
			httpx.WriteErr(w, http.StatusBadRequest, "%v is not in that room", holder)
			return
		}
	}

	threadID, err2 := newToken()
	if err2 != nil {
		httpx.WriteErr(w, http.StatusInternalServerError, "random: %v", err2)
		return
	}
	t := &pressThread{
		id:       threadID,
		openedBy: actor.holder,
		members:  members,
		openedAt: time.Now().UTC(),
		keys:     map[string]string{},
		read:     map[string]int{},
	}
	for holder, wrapped := range body.Keys {
		t.keys[holder] = wrapped
	}
	f.press = append(f.press, t)
	f.pressByID[t.id] = t
	/*
		Nothing is logged. The event log is read back whole by the game master
		view (flow.go), which is a view a playing game master holds, so a line
		naming a room's members would hand that player the one fact press exists
		to keep: who is talking to whom. ADR-007 audits the game master's powers,
		and opening a room is not one of them.
	*/
	if err := persistPressThread(id, t); err != nil {
		// Unlike a message, a half-written room is unusable: a member whose
		// wrap is missing can never open it. So this one is refused rather
		// than logged and carried on with.
		delete(f.pressByID, t.id)
		f.press = f.press[:len(f.press)-1]
		httpx.WriteErr(w, http.StatusInternalServerError, "could not open the room: %v", err)
		return
	}
	g.persist(id)
	httpx.WriteJSON(w, http.StatusOK, t.summary(actor))
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

// handlePressThread is GET: one room's messages, optionally only what is new.
func handlePressThread(g *game, id string, actor pressActor, w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		httpx.WriteErr(w, http.StatusMethodNotAllowed, "GET only")
		return
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	t, ok := g.pressThreadFor(actor, r.URL.Query().Get("thread"))
	if !ok {
		// Not a member, no such room, and press off all answer the same
		// way. A 403 here would say a room exists.
		http.NotFound(w, r)
		return
	}
	since := 0
	if raw := r.URL.Query().Get("since"); raw != "" {
		if n, err := strconv.Atoi(raw); err == nil {
			since = n
		}
	}
	row := t.summary(actor)
	for _, m := range t.messages {
		if m.Seq > since {
			row.Messages = append(row.Messages, m)
		}
	}
	httpx.WriteJSON(w, http.StatusOK, row)
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

type pressSendRequest struct {
	Thread string `json:"thread"`
	/*
		Where this message sits, as the sender believed it. All three are covered
		by the sender's signature and by the box's associated data, so the server
		cannot move a message in the order, into another phase, or to another
		time without every reader noticing.

		Seq is also a concurrency check. Two members writing at once would each
		seal against the sequence they last saw; the second to arrive is refused
		rather than stored under a number nothing can open.
	*/
	Seq        int    `json:"seq"`
	PhaseIndex int    `json:"phaseIndex"`
	At         string `json:"at"`
	Box        string `json:"box"`
	Sig        string `json:"sig"`
}

// pressClockSkew is how far a sender's stated time may be from the server's.
// A phone at a table is minutes out at worst, and a message stamped an hour
// early would sort itself above a conversation it answered.
const pressClockSkew = 5 * time.Minute

/*
handlePressSend appends one boxed message.

The game master may not write into a room the powers opened. A referee who
could would be a referee able to speak as the room, and the room has no way to
tell. It may write into a room it opened itself, which is what a ruling is.
*/
func handlePressSend(g *game, id string, actor pressActor, w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		httpx.WriteErr(w, http.StatusMethodNotAllowed, "POST only")
		return
	}
	var body pressSendRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxPressBody)).Decode(&body); err != nil {
		httpx.WriteErr(w, http.StatusBadRequest, "bad body: %v", err)
		return
	}
	if body.Box == "" {
		httpx.WriteErr(w, http.StatusBadRequest, "box is required")
		return
	}
	at, err := time.Parse(time.RFC3339, body.At)
	if err != nil {
		httpx.WriteErr(w, http.StatusBadRequest, "at must be an RFC3339 time")
		return
	}
	if skew := time.Since(at); skew > pressClockSkew || skew < -pressClockSkew {
		httpx.WriteErr(w, http.StatusBadRequest, "at is too far from this server's clock")
		return
	}
	/*
		Stored as the sender wrote it, not as this server would write it.

		RFC3339 has more than one spelling of the same instant — an offset rather
		than Z, fractional seconds — and the sender sealed the spelling, not the
		instant. Reformatting would leave a message that parses, verifies against
		nothing, and opens for nobody.
	*/
	if body.At != at.UTC().Format(time.RFC3339) {
		httpx.WriteErr(w, http.StatusBadRequest,
			"at must be UTC with no fractional seconds, as 2026-09-02T10:00:00Z")
		return
	}

	g.mu.Lock()
	defer g.mu.Unlock()
	t, ok := g.pressThreadFor(actor, body.Thread)
	if !ok {
		http.NotFound(w, r)
		return
	}
	if actor.isGM && t.openedBy != gmHolder {
		httpx.WriteErr(w, http.StatusForbidden,
			"the game master reads this room and does not speak in it")
		return
	}
	if ok, reason := g.pressWritable(actor, t.openedBy, t.members); !ok {
		httpx.WriteErr(w, http.StatusConflict, "%v", reason)
		return
	}
	// Somebody else spoke between this sender reading the room and writing
	// into it. Their envelope is sealed against the number they saw, so
	// storing it under another would make it unreadable to everybody.
	if body.Seq != len(t.messages)+1 {
		httpx.WriteErr(w, http.StatusConflict,
			"somebody else spoke first — read the room again and send it once more")
		return
	}
	if body.PhaseIndex != g.flow.phaseIndex {
		httpx.WriteErr(w, http.StatusConflict, "the phase moved on while this was being written")
		return
	}

	m := pressMessage{
		Seq:        body.Seq,
		Sender:     actor.holder,
		PhaseIndex: body.PhaseIndex,
		Box:        body.Box,
		Sig:        body.Sig,
		At:         body.At,
	}
	/*
		Written to the database first, and kept in memory only if that lands.

		The rest of this app treats the in-memory board as authoritative and logs
		a failed write, because refusing a move that already happened at a table
		is worse than a stale row. A message is the other way round: nothing has
		happened at the table yet, and a message the server acknowledged and then
		lost would leave the room's sequence with a hole in it that the next
		message silently overwrites.
	*/
	if err := persistPressMessage(id, t.id, m); err != nil {
		httpx.WriteErr(w, http.StatusInternalServerError, "the message was not stored: %v", err)
		return
	}
	t.messages = append(t.messages, m)
	/*
		No socket event. The live socket carries a version to every view of the
		game, and the public one is unauthenticated (events.go), so a bump on
		every message would let anybody holding the game's address watch private
		conversations happen: not what was said, or by whom, but that somebody is
		talking, and exactly when. The panel polls for its own messages instead.
	*/
	httpx.WriteJSON(w, http.StatusOK, m)
}

type pressReadRequest struct {
	Thread string `json:"thread"`
	Seq    int    `json:"seq"`
}

// handlePressRead moves this holder's read marker. It only ever goes forward.
func handlePressRead(g *game, id string, actor pressActor, w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		httpx.WriteErr(w, http.StatusMethodNotAllowed, "POST only")
		return
	}
	var body pressReadRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxPressBody)).Decode(&body); err != nil {
		httpx.WriteErr(w, http.StatusBadRequest, "bad body: %v", err)
		return
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	t, ok := g.pressThreadFor(actor, body.Thread)
	if !ok {
		http.NotFound(w, r)
		return
	}
	// Forward only, and never past the room: a marker beyond the last message
	// would mark everything said afterwards as already read.
	seq := body.Seq
	if seq > len(t.messages) {
		seq = len(t.messages)
	}
	if seq > t.read[actor.holder] {
		t.read[actor.holder] = seq
		persistPressRead(id, t.id, actor.holder, seq)
	}
	httpx.WriteJSON(w, http.StatusOK, t.summary(actor))
}

// ---------------------------------------------------------------------------
// Route adapters
//
// seatRoutes and gmRoutes have different signatures, and the handlers above
// take neither: they take an actor. These are the only place the two meet.
// ---------------------------------------------------------------------------

type pressHandler func(g *game, id string, actor pressActor, w http.ResponseWriter, r *http.Request)

func seatPress(h pressHandler) seatHandler {
	return func(g *game, id string, power godip.Nation, w http.ResponseWriter, r *http.Request) {
		h(g, id, seatActor(power), w, r)
	}
}

func gmPress(h pressHandler) gameHandler {
	return func(g *game, id string, w http.ResponseWriter, r *http.Request) {
		h(g, id, gmActor(), w, r)
	}
}

// ---------------------------------------------------------------------------
// Storage
//
// Press is written row by row as it happens, like the NMR table and unlike
// the game row: a message is append-only and there is nothing to rewrite.
// Every function here is a no-op without a database, which is what lets the
// tests run the whole flow in memory.
// ---------------------------------------------------------------------------

/*
persistPressThread writes a room and every wrapped key it holds, together.

Unlike a message, a half-written room is unusable rather than merely
incomplete: a member whose wrap did not land can never open it, and nothing
later will notice. So this one is a transaction and it returns its error,
which the handler turns into a refusal.
*/
func persistPressThread(id string, t *pressThread) error {
	if db == nil {
		return nil
	}
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`
        INSERT OR IGNORE INTO press_thread (game_id, thread_id, opened_by, members, opened_at)
        VALUES (?, ?, ?, ?, ?)`,
		id, t.id, t.openedBy, t.memberKey(), t.openedAt.UTC().Format(time.RFC3339Nano)); err != nil {
		return err
	}
	for holder, wrapped := range t.keys {
		if _, err := tx.Exec(`
            INSERT OR REPLACE INTO press_key (game_id, thread_id, power, wrapped)
            VALUES (?, ?, ?, ?)`, id, t.id, holder, wrapped); err != nil {
			return err
		}
	}
	return tx.Commit()
}

/*
persistPressMessage writes one message, and says whether it landed.

INSERT rather than INSERT OR REPLACE: a sequence that is already taken is a
bug somewhere above, and overwriting what a room already holds would destroy a
message rather than report the bug.
*/
func persistPressMessage(id, threadID string, m pressMessage) error {
	if db == nil {
		return nil
	}
	_, err := db.Exec(`
        INSERT INTO press_message
            (game_id, thread_id, seq, sender, phase_index, box, sig, at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		id, threadID, m.Seq, m.Sender, m.PhaseIndex, m.Box, m.Sig, m.At)
	if err != nil {
		log.Printf("game %v: PERSIST FAILED (press message): %v", id, err)
	}
	return err
}

func persistPressRead(id, threadID, holder string, seq int) {
	if db == nil {
		return
	}
	if _, err := db.Exec(`
        INSERT OR REPLACE INTO press_read (game_id, thread_id, power, last_seq)
        VALUES (?, ?, ?, ?)`, id, threadID, holder, seq); err != nil {
		log.Printf("game %v: PERSIST FAILED (press read): %v", id, err)
	}
}

// loadPress reads one game's rooms back. The caller holds no lock: this runs
// while the game is being built and before anybody can reach it.
func loadPress(id string, f *flow) error {
	rows, err := db.Query(`
        SELECT thread_id, opened_by, members, opened_at
        FROM press_thread WHERE game_id = ? ORDER BY rowid`, id)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var threadID, openedBy, members, openedAt string
		if err := rows.Scan(&threadID, &openedBy, &members, &openedAt); err != nil {
			return err
		}
		t := &pressThread{
			id:       threadID,
			openedBy: openedBy,
			keys:     map[string]string{},
			read:     map[string]int{},
		}
		for _, name := range strings.Split(members, ",") {
			if name != "" {
				t.members = append(t.members, godip.Nation(name))
			}
		}
		if at, err := time.Parse(time.RFC3339Nano, openedAt); err == nil {
			t.openedAt = at
		}
		f.press = append(f.press, t)
		f.pressByID[t.id] = t
	}
	if err := rows.Err(); err != nil {
		return err
	}
	if err := loadPressKeys(id, f); err != nil {
		return err
	}
	if err := loadPressMessages(id, f); err != nil {
		return err
	}
	return loadPressRead(id, f)
}

func loadPressKeys(id string, f *flow) error {
	rows, err := db.Query(
		`SELECT thread_id, power, wrapped FROM press_key WHERE game_id = ?`, id)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var threadID, holder, wrapped string
		if err := rows.Scan(&threadID, &holder, &wrapped); err != nil {
			return err
		}
		if t := f.pressByID[threadID]; t != nil {
			t.keys[holder] = wrapped
		}
	}
	return rows.Err()
}

func loadPressMessages(id string, f *flow) error {
	rows, err := db.Query(`
        SELECT thread_id, seq, sender, phase_index, box, sig, at
        FROM press_message WHERE game_id = ? ORDER BY thread_id, seq`, id)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var threadID string
		var m pressMessage
		if err := rows.Scan(&threadID, &m.Seq, &m.Sender, &m.PhaseIndex,
			&m.Box, &m.Sig, &m.At); err != nil {
			return err
		}
		if t := f.pressByID[threadID]; t != nil {
			t.messages = append(t.messages, m)
		}
	}
	return rows.Err()
}

func loadPressRead(id string, f *flow) error {
	rows, err := db.Query(
		`SELECT thread_id, power, last_seq FROM press_read WHERE game_id = ?`, id)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var threadID, holder string
		var seq int
		if err := rows.Scan(&threadID, &holder, &seq); err != nil {
			return err
		}
		if t := f.pressByID[threadID]; t != nil {
			t.read[holder] = seq
		}
	}
	return rows.Err()
}
