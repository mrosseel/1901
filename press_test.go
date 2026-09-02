// Press: the rooms, and the rules the server keeps for them (ADR-053..055).
package main

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/zond/godip"
	"github.com/zond/godip/variants/classical"
)

// pressGame is a started classical game that carries messages, with every
// seat holding a token and a published box key.
func pressGame(t *testing.T, mode string) *game {
	t.Helper()
	s := settings{PressMode: mode, PressSilenceSeconds: defaultPressSilenceSeconds}.normalised()
	f, err := newFlow(s, classical.ClassicalVariant)
	if err != nil {
		t.Fatal(err)
	}
	g, err := newGame("classical", classical.ClassicalVariant)
	if err != nil {
		t.Fatal(err)
	}
	g.flow = f
	for i, power := range f.powers {
		seat := f.seats[power]
		seat.token = string(rune('a'+i)) + "-token"
		f.bySeatToken[seat.token] = power
		seat.boxPub = fakeBoxPub(string(power))
	}
	f.started = true
	return g
}

// fakeBoxPub is 32 bytes that look like a public key. Nothing on this side
// ever does arithmetic with one, which is the property being tested.
func fakeBoxPub(name string) string {
	raw := make([]byte, pressKeyBytes)
	copy(raw, "box-"+name)
	return base64.RawURLEncoding.EncodeToString(raw)
}

func postPress(g *game, id string, actor pressActor, h pressHandler, body string) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	h(g, id, actor, rec, httptest.NewRequest(http.MethodPost, "/", strings.NewReader(body)))
	return rec
}

func getPress(g *game, id string, actor pressActor, h pressHandler, query string) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	h(g, id, actor, rec, httptest.NewRequest(http.MethodGet, "/?"+query, nil))
	return rec
}

// openRoom opens a room between these powers, wrapping a key for each. The
// wraps are nonsense on purpose: the server must never look inside one.
func openRoom(t *testing.T, g *game, id string, opener godip.Nation, members ...godip.Nation) pressThreadJSON {
	t.Helper()
	names := []string{}
	keys := map[string]string{}
	for _, m := range members {
		names = append(names, string(m))
		keys[string(m)] = "wrapped-for-" + string(m)
	}
	if g.flow.settings.GMReadsPress {
		keys[gmHolder] = "wrapped-for-the-referee"
	}
	body, err := json.Marshal(pressOpenRequest{Members: names, Keys: keys})
	if err != nil {
		t.Fatal(err)
	}
	rec := postPress(g, id, seatActor(opener), handlePressOpen, string(body))
	if rec.Code != http.StatusOK {
		t.Fatalf("open room: %v %v", rec.Code, rec.Body.String())
	}
	out := pressThreadJSON{}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	return out
}

/*
sendPress writes into a room the way a device does: sealed against the place
it believes it is writing into, which the server then checks.
*/
func sendPress(g *game, id string, actor pressActor, threadID, box string) *httptest.ResponseRecorder {
	seq := 1
	if t := g.flow.pressByID[threadID]; t != nil {
		seq = len(t.messages) + 1
	}
	return sendPressAt(g, id, actor, threadID, box, seq, g.flow.phaseIndex, time.Now())
}

func sendPressAt(
	g *game, id string, actor pressActor, threadID, box string,
	seq, phaseIndex int, at time.Time,
) *httptest.ResponseRecorder {
	body, _ := json.Marshal(pressSendRequest{
		Thread:     threadID,
		Seq:        seq,
		PhaseIndex: phaseIndex,
		At:         at.UTC().Format(time.RFC3339),
		Box:        box,
		Sig:        "signature",
	})
	return postPress(g, id, actor, handlePressSend, string(body))
}

/*
TestPressIsARoomAndEverybodyInItGetsEverything is the shape decision of
ADR-053. The rulebook lets three players talk in a corner; all three hear all
three. So there is one member list, and no way to address part of it.
*/
func TestPressIsARoomAndEverybodyInItGetsEverything(t *testing.T) {
	g := pressGame(t, "fullpress")
	room := openRoom(t, g, "game", "France", "France", "Italy", "Austria")

	if rec := sendPress(g, "game", seatActor("France"), room.ID, "box-one"); rec.Code != http.StatusOK {
		t.Fatalf("France send: %v %v", rec.Code, rec.Body.String())
	}
	for _, member := range []godip.Nation{"Italy", "Austria"} {
		rec := getPress(g, "game", seatActor(member), handlePressThread, "thread="+room.ID)
		if rec.Code != http.StatusOK {
			t.Fatalf("%v read: %v", member, rec.Code)
		}
		out := pressThreadJSON{}
		if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
			t.Fatal(err)
		}
		if len(out.Messages) != 1 || out.Messages[0].Box != "box-one" {
			t.Fatalf("%v got %#v, want the one message", member, out.Messages)
		}
		if out.Unread != 1 {
			t.Errorf("%v unread: got %v, want 1", member, out.Unread)
		}
	}

	// And the power that was not in the corner hears none of it, at every
	// address that could carry it.
	rec := getPress(g, "game", seatActor("England"), handlePressThread, "thread="+room.ID)
	if rec.Code != http.StatusNotFound {
		t.Errorf("England reading a room it is not in: got %v, want 404", rec.Code)
	}
	if rec := sendPress(g, "game", seatActor("England"), room.ID, "box"); rec.Code != http.StatusNotFound {
		t.Errorf("England sending into a room it is not in: got %v, want 404", rec.Code)
	}
	list := pressStateJSON{}
	body := getPress(g, "game", seatActor("England"), handlePress, "")
	if err := json.Unmarshal(body.Body.Bytes(), &list); err != nil {
		t.Fatal(err)
	}
	if len(list.Threads) != 0 {
		t.Errorf("England sees %v rooms, want none", len(list.Threads))
	}
}

// The same three people do not open a second conversation, they keep talking.
func TestTheSameMembersAreTheSameRoom(t *testing.T) {
	g := pressGame(t, "fullpress")
	first := openRoom(t, g, "game", "France", "France", "Italy")
	// Opened from the other side, and named in the other order.
	second := openRoom(t, g, "game", "Italy", "Italy", "France")
	if first.ID != second.ID {
		t.Fatalf("two rooms for the same members: %v and %v", first.ID, second.ID)
	}
	if len(g.flow.press) != 1 {
		t.Fatalf("game holds %v rooms, want 1", len(g.flow.press))
	}
}

// A power may not open a room it is not in: that would be a conversation
// started in somebody else's name.
func TestAPowerIsAlwaysInItsOwnRooms(t *testing.T) {
	g := pressGame(t, "fullpress")
	body, _ := json.Marshal(pressOpenRequest{
		Members: []string{"Italy", "Austria"},
		Keys:    map[string]string{"Italy": "a", "Austria": "b"},
	})
	rec := postPress(g, "game", seatActor("France"), handlePressOpen, string(body))
	if rec.Code != http.StatusForbidden {
		t.Fatalf("got %v %v, want 403", rec.Code, rec.Body.String())
	}
}

// Every member needs a key, and nobody else may be given one.
func TestARoomKeyIsWrappedForItsMembersAndNobodyElse(t *testing.T) {
	g := pressGame(t, "fullpress")
	missing, _ := json.Marshal(pressOpenRequest{
		Members: []string{"France", "Italy"},
		Keys:    map[string]string{"France": "a"},
	})
	if rec := postPress(g, "game", seatActor("France"), handlePressOpen, string(missing)); rec.Code != http.StatusBadRequest {
		t.Errorf("a member with no key: got %v, want 400", rec.Code)
	}
	extra, _ := json.Marshal(pressOpenRequest{
		Members: []string{"France", "Italy"},
		Keys:    map[string]string{"France": "a", "Italy": "b", "Austria": "c"},
	})
	if rec := postPress(g, "game", seatActor("France"), handlePressOpen, string(extra)); rec.Code != http.StatusBadRequest {
		t.Errorf("a key for somebody outside the room: got %v, want 400", rec.Code)
	}
}

// ADR-023: a table that agreed to talk out loud carries no messages, and the
// routes do not exist rather than refusing politely.
func TestAnFtfGameHasNoPressRoutesAtAll(t *testing.T) {
	for _, mode := range []string{"ftf", "gunboat"} {
		g := pressGame(t, mode)
		if rec := getPress(g, "game", seatActor("France"), handlePress, ""); rec.Code != http.StatusNotFound {
			t.Errorf("%v press list: got %v, want 404", mode, rec.Code)
		}
		body, _ := json.Marshal(pressOpenRequest{
			Members: []string{"France", "Italy"},
			Keys:    map[string]string{"France": "a", "Italy": "b"},
		})
		if rec := postPress(g, "game", seatActor("France"), handlePressOpen, string(body)); rec.Code != http.StatusNotFound {
			t.Errorf("%v press open: got %v, want 404", mode, rec.Code)
		}
		if rec := postPress(g, "game", seatActor("France"), handlePressKey,
			`{"boxPub":"`+fakeBoxPub("France")+`"}`); rec.Code != http.StatusNotFound {
			t.Errorf("%v press key: got %v, want 404", mode, rec.Code)
		}
	}
}

/*
WDC 3b: "it is forbidden to negotiate during the retreats and adjustments."
That is the rulebook press mode, and the server keeps it rather than trusting
the panel to hide a button.
*/
func TestRulebookPressClosesInRetreatAndBuildPhases(t *testing.T) {
	g := pressGame(t, "rulebook")
	room := openRoom(t, g, "game", "France", "France", "Italy")
	if rec := sendPress(g, "game", seatActor("France"), room.ID, "spring"); rec.Code != http.StatusOK {
		t.Fatalf("movement phase: got %v %v", rec.Code, rec.Body.String())
	}

	// A phase nobody owes an order in adjudicates itself (ADR-034), so the
	// board only stops outside a movement phase when somebody must act.
	// dislodgedRetreat leaves Italy with a unit to move.
	dislodgedRetreat(t, g, "game")
	rec := sendPress(g, "game", seatActor("France"), room.ID, "winter")
	if rec.Code != http.StatusConflict {
		t.Fatalf("got %v %v, want 409", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "retreats and builds") {
		t.Errorf("the refusal must say why: %v", rec.Body.String())
	}

	// Full press is the other answer to the same question, and gives it.
	open := pressGame(t, "fullpress")
	room2 := openRoom(t, open, "game", "France", "France", "Italy")
	dislodgedRetreat(t, open, "game")
	if rec := sendPress(open, "game", seatActor("France"), room2.ID, "in the retreat"); rec.Code != http.StatusOK {
		t.Errorf("full press in a retreat phase: got %v %v", rec.Code, rec.Body.String())
	}
}

/*
WDC 4b2 and 4d: the last minute of a phase is writing time, negotiation is not
allowed in it, and the silence carries a sanction. So the app closes press
rather than asking the table to keep quiet.
*/
func TestPressClosesForTheWritingMinute(t *testing.T) {
	g := pressGame(t, "fullpress")
	room := openRoom(t, g, "game", "France", "France", "Italy")

	far := time.Now().Add(10 * time.Minute)
	g.flow.deadlineAt = &far
	if rec := sendPress(g, "game", seatActor("France"), room.ID, "early"); rec.Code != http.StatusOK {
		t.Fatalf("ten minutes out: got %v %v", rec.Code, rec.Body.String())
	}

	// Thirty seconds left, and the game gives its players a minute to write.
	soon := time.Now().Add(30 * time.Second)
	g.flow.deadlineAt = &soon
	rec := sendPress(g, "game", seatActor("France"), room.ID, "late")
	if rec.Code != http.StatusConflict {
		t.Fatalf("inside the writing minute: got %v %v", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "writing time") {
		t.Errorf("the refusal must name the writing time: %v", rec.Body.String())
	}

	// A game that asks for no silence keeps talking to the last second.
	g.flow.settings.PressSilenceSeconds = 0
	if rec := sendPress(g, "game", seatActor("France"), room.ID, "still talking"); rec.Code != http.StatusOK {
		t.Errorf("with no writing time: got %v %v", rec.Code, rec.Body.String())
	}
}

// A power's own notepad is not negotiation, so the writing minute leaves it
// alone. Writing your plan down is exactly what that minute is for.
func TestNotesToYourselfSurviveTheWritingMinute(t *testing.T) {
	g := pressGame(t, "rulebook")
	notes := openRoom(t, g, "game", "France", "France")
	if !notes.Notes {
		t.Error("a room with one member is that power's notes")
	}
	soon := time.Now().Add(5 * time.Second)
	g.flow.deadlineAt = &soon
	if rec := sendPress(g, "game", seatActor("France"), notes.ID, "hold everywhere"); rec.Code != http.StatusOK {
		t.Fatalf("notes in the writing minute: got %v %v", rec.Code, rec.Body.String())
	}
	// And nobody else can read them, which is what makes them notes.
	if rec := getPress(g, "game", seatActor("Italy"), handlePressThread, "thread="+notes.ID); rec.Code != http.StatusNotFound {
		t.Errorf("Italy reading France's notes: got %v, want 404", rec.Code)
	}
}

/*
WDC 3c: "A player who is eliminated is not allowed to negotiate with the other
players of the board." It cuts both ways, so nobody may negotiate with them
either.
*/
func TestAnEliminatedPowerMayNotNegotiate(t *testing.T) {
	g := pressGame(t, "fullpress")
	room := openRoom(t, g, "game", "France", "France", "Austria")

	// Take every centre away from Austria without touching the rest.
	for _, province := range g.state.Graph().Provinces() {
		if nation, _, ok := g.state.SupplyCenter(province); ok && nation == "Austria" {
			g.state.SetSC(province, "Italy")
		}
	}
	if !g.eliminated()["Austria"] {
		t.Fatal("Austria should hold no centre now")
	}

	rec := sendPress(g, "game", seatActor("Austria"), room.ID, "let me back in")
	if rec.Code != http.StatusConflict || !strings.Contains(rec.Body.String(), "eliminated") {
		t.Errorf("an eliminated power sending: got %v %v", rec.Code, rec.Body.String())
	}
	rec = sendPress(g, "game", seatActor("France"), room.ID, "bad luck")
	if rec.Code != http.StatusConflict || !strings.Contains(rec.Body.String(), "eliminated") {
		t.Errorf("sending to an eliminated power: got %v %v", rec.Code, rec.Body.String())
	}
	// Their own notes are theirs. Nothing is being negotiated.
	notes := openRoom(t, g, "game", "Austria", "Austria")
	if rec := sendPress(g, "game", seatActor("Austria"), notes.ID, "what went wrong"); rec.Code != http.StatusOK {
		t.Errorf("an eliminated power writing its own notes: got %v %v", rec.Code, rec.Body.String())
	}
}

// The game master reads nothing unless the game was declared that way, and a
// game master who plays can never be declared that way.
func TestTheGameMasterReadsPressOnlyWhenDeclaredAndNotPlaying(t *testing.T) {
	g := pressGame(t, "fullpress")
	room := openRoom(t, g, "game", "France", "France", "Italy")
	sendPress(g, "game", seatActor("France"), room.ID, "a secret")

	for _, get := range []struct {
		name string
		rec  *httptest.ResponseRecorder
	}{
		{"list", getPress(g, "game", gmActor(), handlePress, "")},
		{"thread", getPress(g, "game", gmActor(), handlePressThread, "thread="+room.ID)},
	} {
		if get.rec.Code != http.StatusNotFound {
			t.Errorf("game master %v with the setting off: got %v, want 404", get.name, get.rec.Code)
		}
	}

	// A game master who plays cannot be given it, whatever the body says.
	playing := settings{PressMode: "fullpress", GMPlays: true, GMReadsPress: true}.normalised()
	if playing.GMReadsPress {
		t.Error("a game master who plays must never read press")
	}
}

// With the setting on, the referee is in every room and speaks in none of the
// players' rooms.
func TestTheRefereeReadsEveryRoomAndSpeaksInNoneOfThem(t *testing.T) {
	g := pressGame(t, "fullpress")
	g.flow.settings.GMReadsPress = true
	g.flow.gmBoxPub = fakeBoxPub("referee")

	room := openRoom(t, g, "game", "France", "France", "Italy")
	if room.Wrapped != "" {
		// The opener's own view of the room carries the opener's key.
		_ = room.Wrapped
	}
	sendPress(g, "game", seatActor("France"), room.ID, "a secret")

	rec := getPress(g, "game", gmActor(), handlePressThread, "thread="+room.ID)
	if rec.Code != http.StatusOK {
		t.Fatalf("referee reading: got %v %v", rec.Code, rec.Body.String())
	}
	seen := pressThreadJSON{}
	if err := json.Unmarshal(rec.Body.Bytes(), &seen); err != nil {
		t.Fatal(err)
	}
	if len(seen.Messages) != 1 {
		t.Fatalf("referee sees %v messages, want 1", len(seen.Messages))
	}
	if seen.Wrapped != "wrapped-for-the-referee" {
		t.Errorf("referee's own wrapped key: got %q", seen.Wrapped)
	}

	if rec := sendPress(g, "game", gmActor(), room.ID, "as the room"); rec.Code != http.StatusForbidden {
		t.Errorf("referee speaking in a players' room: got %v %v", rec.Code, rec.Body.String())
	}

	// A room the referee opened is the referee's to speak in.
	body, _ := json.Marshal(pressOpenRequest{
		Members: []string{"France"},
		Keys:    map[string]string{"France": "a", gmHolder: "b"},
	})
	made := postPress(g, "game", gmActor(), handlePressOpen, string(body))
	if made.Code != http.StatusOK {
		t.Fatalf("referee opening a room: got %v %v", made.Code, made.Body.String())
	}
	ruling := pressThreadJSON{}
	if err := json.Unmarshal(made.Body.Bytes(), &ruling); err != nil {
		t.Fatal(err)
	}
	if rec := sendPress(g, "game", gmActor(), ruling.ID, "a ruling"); rec.Code != http.StatusOK {
		t.Errorf("referee speaking in its own room: got %v %v", rec.Code, rec.Body.String())
	}
}

// The setting promises the referee a key to every room, so a room opened
// without one is refused rather than silently unreadable.
func TestARoomMustCarryTheRefereesKeyWhenTheRefereeReads(t *testing.T) {
	g := pressGame(t, "fullpress")
	g.flow.settings.GMReadsPress = true
	g.flow.gmBoxPub = fakeBoxPub("referee")

	body, _ := json.Marshal(pressOpenRequest{
		Members: []string{"France", "Italy"},
		Keys:    map[string]string{"France": "a", "Italy": "b"},
	})
	rec := postPress(g, "game", seatActor("France"), handlePressOpen, string(body))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("got %v %v, want 400", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), gmHolder) {
		t.Errorf("the refusal must name the missing holder: %v", rec.Body.String())
	}
}

// The unread count is what the top bar shows, so it must not count a seat's
// own words back at it.
func TestUnreadCountsWhatSomebodyElseSaid(t *testing.T) {
	g := pressGame(t, "fullpress")
	room := openRoom(t, g, "game", "France", "France", "Italy")
	sendPress(g, "game", seatActor("France"), room.ID, "one")
	sendPress(g, "game", seatActor("Italy"), room.ID, "two")
	sendPress(g, "game", seatActor("Italy"), room.ID, "three")

	if got := g.flow.pressUnread(seatActor("France")); got != 2 {
		t.Errorf("France unread: got %v, want 2", got)
	}
	if got := g.flow.pressUnread(seatActor("Italy")); got != 1 {
		t.Errorf("Italy unread: got %v, want 1", got)
	}
	body, _ := json.Marshal(pressReadRequest{Thread: room.ID, Seq: 3})
	if rec := postPress(g, "game", seatActor("France"), handlePressRead, string(body)); rec.Code != http.StatusOK {
		t.Fatalf("marking read: %v", rec.Code)
	}
	if got := g.flow.pressUnread(seatActor("France")); got != 0 {
		t.Errorf("France after reading: got %v, want 0", got)
	}
	// The marker only goes forward: a stale phone must not unread a message.
	back, _ := json.Marshal(pressReadRequest{Thread: room.ID, Seq: 1})
	postPress(g, "game", seatActor("France"), handlePressRead, string(back))
	if got := g.flow.pressUnread(seatActor("France")); got != 0 {
		t.Errorf("after a stale marker: got %v, want 0", got)
	}
}

// The seat state carries the two numbers the bar needs and no message.
func TestSeatStateCarriesTheUnreadCountAndNoMessage(t *testing.T) {
	g := pressGame(t, "fullpress")
	room := openRoom(t, g, "game", "France", "France", "Italy")
	sendPress(g, "game", seatActor("Italy"), room.ID, "the-secret-body")

	rec := httptest.NewRecorder()
	handleSeatState(g, "game", "France", rec, httptest.NewRequest(http.MethodGet, "/", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("seat state: %v", rec.Code)
	}
	if strings.Contains(rec.Body.String(), "the-secret-body") {
		t.Fatal("the seat state must carry no message body")
	}
	out := struct {
		PressEnabled bool `json:"pressEnabled"`
		PressUnread  int  `json:"pressUnread"`
		PressOpen    bool `json:"pressOpen"`
	}{}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if !out.PressEnabled || out.PressUnread != 1 || !out.PressOpen {
		t.Errorf("got %#v, want press on, one unread, open", out)
	}
}

// A sandbox has one driver and no seats (ADR-047), so there is nobody to send
// anything to whatever the press mode says.
func TestASandboxCarriesNoPress(t *testing.T) {
	s := settings{PressMode: "fullpress", Sandbox: true}.normalised()
	f, err := newFlow(s, classical.ClassicalVariant)
	if err != nil {
		t.Fatal(err)
	}
	if f.pressEnabled() {
		t.Error("a sandbox must carry no press")
	}
}

// A phone publishes its own public key and nobody else's.
func TestASeatPublishesItsOwnBoxKey(t *testing.T) {
	g := pressGame(t, "fullpress")
	g.flow.seats["France"].boxPub = ""

	if rec := postPress(g, "game", seatActor("France"), handlePressKey,
		`{"boxPub":"not-a-key"}`); rec.Code != http.StatusBadRequest {
		t.Errorf("a key that is not 32 bytes: got %v", rec.Code)
	}
	key := fakeBoxPub("France-again")
	if rec := postPress(g, "game", seatActor("France"), handlePressKey,
		`{"boxPub":"`+key+`"}`); rec.Code != http.StatusOK {
		t.Fatalf("publishing: %v", rec.Code)
	}
	if got := g.flow.seats["France"].boxPub; got != key {
		t.Errorf("stored %q, want %q", got, key)
	}

	// Every published key is readable: a public key is not a secret, and a
	// room cannot be opened without the keys of the powers in it.
	rec := getPress(g, "game", seatActor("Italy"), handlePress, "")
	view := pressStateJSON{}
	if err := json.Unmarshal(rec.Body.Bytes(), &view); err != nil {
		t.Fatal(err)
	}
	if view.Keys["France"] != key {
		t.Errorf("Italy cannot see France's public key: %#v", view.Keys)
	}
}

// Press before the start, and after the end, has nothing to be about.
func TestPressNeedsAGameThatIsRunning(t *testing.T) {
	g := pressGame(t, "fullpress")
	g.flow.started = false
	if ok, reason := g.pressWritableNow(seatActor("France")); ok || !strings.Contains(reason, "not started") {
		t.Errorf("before the start: %v %q", ok, reason)
	}
	g.flow.started = true
	g.endGame("game", "solo", []godip.Nation{"France"}, 1905)
	if ok, reason := g.pressWritableNow(seatActor("France")); ok || !strings.Contains(reason, "over") {
		t.Errorf("after the end: %v %q", ok, reason)
	}
}

/*
A message is sealed against where it sits, so the server may not move it.

Two members writing at once each seal against the sequence they last read.
Storing the second under a number it was not sealed against would make it
unreadable to every member, so it is refused and the sender is told to read
the room and send again.
*/
func TestAMessageIsSealedAgainstWhereItSits(t *testing.T) {
	g := pressGame(t, "fullpress")
	room := openRoom(t, g, "game", "France", "France", "Italy")

	if rec := sendPress(g, "game", seatActor("France"), room.ID, "first"); rec.Code != http.StatusOK {
		t.Fatalf("first: %v %v", rec.Code, rec.Body.String())
	}
	// Italy read the room before France wrote, and seals against seq 1.
	rec := sendPressAt(g, "game", seatActor("Italy"), room.ID, "stale", 1, 0, time.Now())
	if rec.Code != http.StatusConflict {
		t.Errorf("a stale sequence: got %v %v, want 409", rec.Code, rec.Body.String())
	}
	// A phase that moved on under the writer is refused for the same reason.
	rec = sendPressAt(g, "game", seatActor("Italy"), room.ID, "old phase", 2, 7, time.Now())
	if rec.Code != http.StatusConflict {
		t.Errorf("a stale phase: got %v %v, want 409", rec.Code, rec.Body.String())
	}
	// And a time the server cannot believe, which would sort a message above
	// the conversation it answered.
	rec = sendPressAt(g, "game", seatActor("Italy"), room.ID, "yesterday", 2, 0,
		time.Now().Add(-2*time.Hour))
	if rec.Code != http.StatusBadRequest {
		t.Errorf("a false time: got %v %v, want 400", rec.Code, rec.Body.String())
	}
}

/*
The audit log says nothing about who is talking to whom.

The game master view returns the whole event log, and a game master who plays
holds that view. A line naming a room's members would hand that player the one
fact press exists to keep.
*/
func TestTheEventLogNamesNoRoomAndNoMember(t *testing.T) {
	g := pressGame(t, "fullpress")
	room := openRoom(t, g, "game", "France", "France", "Italy", "Austria")
	sendPress(g, "game", seatActor("France"), room.ID, "a secret")

	whole := strings.Join(g.flow.events, "\n")
	for _, word := range []string{"press", "room", room.ID, "Italy", "Austria"} {
		if strings.Contains(whole, word) {
			t.Errorf("the event log mentions %q:\n%v", word, whole)
		}
	}
}

/*
A room the game master opened with one power in it is a ruling, not that
power's notepad, so the ordinary gates apply to it.

Reading the exemption off the member list alone let a power answer the game
master during the writing minute, in a retreat phase, and after elimination.
*/
func TestARefereesRoomIsNotAPowersNotepad(t *testing.T) {
	g := pressGame(t, "fullpress")
	g.flow.settings.GMReadsPress = true
	g.flow.gmBoxPub = fakeBoxPub("referee")

	body, _ := json.Marshal(pressOpenRequest{
		Members: []string{"France"},
		Keys:    map[string]string{"France": "a", gmHolder: "b"},
	})
	made := postPress(g, "game", gmActor(), handlePressOpen, string(body))
	if made.Code != http.StatusOK {
		t.Fatalf("referee opening a room: %v %v", made.Code, made.Body.String())
	}
	ruling := pressThreadJSON{}
	if err := json.Unmarshal(made.Body.Bytes(), &ruling); err != nil {
		t.Fatal(err)
	}

	soon := time.Now().Add(5 * time.Second)
	g.flow.deadlineAt = &soon
	rec := sendPress(g, "game", seatActor("France"), ruling.ID, "during the writing minute")
	if rec.Code != http.StatusConflict {
		t.Fatalf("got %v %v, want 409", rec.Code, rec.Body.String())
	}
	// And France's own notepad is still France's, and still open.
	notes := openRoom(t, g, "game", "France", "France")
	if !notes.Notes {
		t.Error("a room France opened for itself is France's notepad")
	}
	if rec := sendPress(g, "game", seatActor("France"), notes.ID, "mine"); rec.Code != http.StatusOK {
		t.Errorf("France's own notes: got %v %v", rec.Code, rec.Body.String())
	}
}

// A read marker cannot run past the room, or everything said afterwards would
// arrive already read.
func TestAReadMarkerStopsAtTheLastMessage(t *testing.T) {
	g := pressGame(t, "fullpress")
	room := openRoom(t, g, "game", "France", "France", "Italy")
	sendPress(g, "game", seatActor("Italy"), room.ID, "one")

	ahead, _ := json.Marshal(pressReadRequest{Thread: room.ID, Seq: 1000})
	postPress(g, "game", seatActor("France"), handlePressRead, string(ahead))
	sendPress(g, "game", seatActor("Italy"), room.ID, "two")
	if got := g.flow.pressUnread(seatActor("France")); got != 1 {
		t.Errorf("after a marker past the end: got %v unread, want 1", got)
	}
}

/*
A room, its keys, its messages and its read markers all come back.

Press is written row by row as it happens rather than with the rest of the
game, so nothing else in the suite would notice it going missing. A restart
mid-game is the ordinary case at a table with one laptop.
*/
func TestPressSurvivesARestart(t *testing.T) {
	handle, err := openDB(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatalf("openDB: %v", err)
	}
	saved := db
	db = handle
	t.Cleanup(func() {
		db = saved
		handle.Close()
	})

	g := pressGame(t, "fullpress")
	g.persist("press-restart")
	room := openRoom(t, g, "press-restart", "France", "France", "Italy")
	if rec := sendPress(g, "press-restart", seatActor("France"), room.ID, "an envelope"); rec.Code != http.StatusOK {
		t.Fatalf("send: %v %v", rec.Code, rec.Body.String())
	}
	body, _ := json.Marshal(pressReadRequest{Thread: room.ID, Seq: 1})
	postPress(g, "press-restart", seatActor("Italy"), handlePressRead, string(body))
	if rec := postPress(g, "press-restart", seatActor("France"), handlePressKey,
		`{"boxPub":"`+fakeBoxPub("France-published")+`","sig":"a-signature"}`); rec.Code != http.StatusOK {
		t.Fatalf("publish: %v %v", rec.Code, rec.Body.String())
	}

	// What a restart does: a fresh flow, filled from the database alone.
	back := &flow{
		seats:       map[godip.Nation]*seat{},
		bySeatToken: map[string]godip.Nation{},
		bySignPub:   map[string]godip.Nation{},
		byDevice:    map[string]godip.Nation{},
		sessions:    map[string]godip.Nation{},
		pressByID:   map[string]*pressThread{},
	}
	if err := loadPress("press-restart", back); err != nil {
		t.Fatalf("loadPress: %v", err)
	}
	if len(back.press) != 1 {
		t.Fatalf("got %v rooms back, want 1", len(back.press))
	}
	t2 := back.pressByID[room.ID]
	if t2 == nil {
		t.Fatal("the room came back under another id")
	}
	if got := nations(t2.members); len(got) != 2 || got[0] != "France" || got[1] != "Italy" {
		t.Errorf("members came back as %v", got)
	}
	if t2.openedBy != "France" {
		t.Errorf("openedBy came back as %q", t2.openedBy)
	}
	for _, holder := range []string{"France", "Italy"} {
		if t2.keys[holder] != "wrapped-for-"+holder {
			t.Errorf("%v's wrapped key came back as %q", holder, t2.keys[holder])
		}
	}
	if len(t2.messages) != 1 || t2.messages[0].Box != "an envelope" {
		t.Errorf("messages came back as %#v", t2.messages)
	}
	if t2.read["Italy"] != 1 {
		t.Errorf("Italy's read marker came back as %v, want 1", t2.read["Italy"])
	}

	// And the published key, which lives on the seat row rather than in a
	// press table, so it is only tested by looking.
	var boxPub, boxSig string
	if err := db.QueryRow(
		`SELECT box_pub, box_sig FROM seat WHERE game_id = ? AND power = 'France'`,
		"press-restart").Scan(&boxPub, &boxSig); err != nil {
		t.Fatalf("seat row: %v", err)
	}
	if boxPub != fakeBoxPub("France-published") || boxSig != "a-signature" {
		t.Errorf("the published key came back as %q %q", boxPub, boxSig)
	}
}

/*
A handover leaves a room nobody in it can open, and those powers can start
again.

The reuse rule hands back the room these members already have. After a
handover the new holder's device cannot open it, and handing it back for ever
would end that conversation. So a device that cannot open one asks for a fresh
room, and the newest is what the rule finds afterwards.
*/
func TestARoomCanBeStartedAgainAfterAHandover(t *testing.T) {
	g := pressGame(t, "fullpress")
	first := openRoom(t, g, "game", "France", "France", "Italy")

	body, _ := json.Marshal(pressOpenRequest{
		Members: []string{"France", "Italy"},
		Keys:    map[string]string{"France": "new-a", "Italy": "new-b"},
		Fresh:   true,
	})
	rec := postPress(g, "game", seatActor("France"), handlePressOpen, string(body))
	if rec.Code != http.StatusOK {
		t.Fatalf("a fresh room: %v %v", rec.Code, rec.Body.String())
	}
	second := pressThreadJSON{}
	if err := json.Unmarshal(rec.Body.Bytes(), &second); err != nil {
		t.Fatal(err)
	}
	if second.ID == first.ID {
		t.Fatal("a fresh room must not be the room that could not be opened")
	}
	// And from now on the reuse rule finds the new one, not the dead one.
	again := openRoom(t, g, "game", "Italy", "Italy", "France")
	if again.ID != second.ID {
		t.Errorf("reuse found %v, want the newest room %v", again.ID, second.ID)
	}
}
