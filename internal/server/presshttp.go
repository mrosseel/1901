// The press endpoints, and the two adapters that reach them.
//
// seatRoutes and gmRoutes have different signatures, and none of these
// handlers takes either: they take an actor. seatPress and gmPress are the
// only place the two meet.

package server

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"strconv"
	"time"

	"github.com/zond/godip"

	"spring1901/spike/internal/httpx"
)

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
		The room as its opener made it (ADR-056).

		The id and the time come from the device, not from here, because the
		opener's signature covers them and a value this server chose could not
		be signed before it was sent. This server checks their shape, refuses
		an id a room already has, and stores what it was given.
	*/
	Thread       string `json:"thread"`
	OpenedAt     string `json:"openedAt"`
	OpenerBoxPub string `json:"openerBoxPub"`
	Sig          string `json:"sig"`
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

	if reason := f.checkRoomShape(body); reason != "" {
		httpx.WriteErr(w, http.StatusBadRequest, "%v", reason)
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

	t := &pressThread{
		id:            body.Thread,
		openedBy:      actor.holder,
		members:       members,
		openedAt:      body.OpenedAt,
		openerBoxPub:  body.OpenerBoxPub,
		openerSignPub: f.openerSignPub(actor),
		manifestSig:   body.Sig,
		keys:          map[string]string{},
		read:          map[string]int{},
	}
	for holder, wrapped := range body.Keys {
		t.keys[holder] = wrapped
	}
	/*
		Checked here for consistency and nowhere near the security boundary.

		The reading device is what decides whether a room is the opener's own,
		because a server that wanted to hand out a room it made up would simply
		not run this. What refusing here buys is that a client bug shows up at
		the moment it happens rather than as a room nobody can open.
	*/
	if t.openerSignPub != "" && !checkPressManifest(id, t) {
		httpx.WriteErr(w, http.StatusBadRequest, "the room's signature does not match what it says")
		return
	}
	f.press = append(f.press, t)
	f.pressByID[t.id] = t
	/*
		Nothing is logged. The event log is read back whole by the game master
		view (gm.go), which is a view a playing game master holds, so a line
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

/*
checkRoomShape is everything this server can say about a room being opened
without holding any key to it.

The id, the time and the opener's press key are the opener's to choose and this
server's to store, so what is checked is that they are the right shape and that
the id is not one a room already has. Two rooms sharing an id would let a wrap
signed for one be presented as the other's.
*/
func (f *flow) checkRoomShape(body pressOpenRequest) string {
	raw, err := base64.RawURLEncoding.DecodeString(body.Thread)
	if err != nil || len(raw) != pressThreadIDBytes {
		return "a room id is 16 base64url bytes"
	}
	if f.pressByID[body.Thread] != nil {
		return "that room id is taken"
	}
	if !checkBoxPub(body.OpenerBoxPub) {
		return "openerBoxPub must be 32 base64url bytes"
	}
	at, err := time.Parse(time.RFC3339, body.OpenedAt)
	if err != nil {
		return "openedAt must be an RFC3339 time"
	}
	if body.OpenedAt != at.UTC().Format(time.RFC3339) {
		return "openedAt must be UTC with no fractional seconds, as 2026-09-02T10:00:00Z"
	}
	if skew := time.Since(at); skew > pressClockSkew || skew < -pressClockSkew {
		return "openedAt is too far from this server's clock"
	}
	return ""
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
	/*
		The one thing this server may say about a message it cannot read: that
		it is one of the lengths press pads to (ADR-057). Refusing an unpadded
		one keeps a client that skipped the padding from spending the evening
		telling this server how long every sentence was.
	*/
	raw, err := base64.RawURLEncoding.DecodeString(body.Box)
	if err != nil || !pressBucketed(len(raw)) {
		httpx.WriteErr(w, http.StatusBadRequest, "a message must be boxed and padded")
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
