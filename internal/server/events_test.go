package server

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"spring1901/spike/internal/httpx"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
	"github.com/zond/godip/variants/classical"
)

// resetLiveSockets clears the server-wide accounting between tests, which is
// the one piece of this that outlives a single hub.
func resetLiveSockets() {
	liveSockets.mu.Lock()
	liveSockets.total = 0
	liveSockets.bySource = map[string]int{}
	liveSockets.mu.Unlock()
}

func TestGameEventsCoalesceForASlowPhone(t *testing.T) {
	defer resetLiveSockets()
	hub := newGameEvents()
	initial, events, _, unsubscribe, refused := hub.subscribe(eventAudiencePublic, "", "10.0.0.1")
	if refused != "" {
		t.Fatalf("first subscriber was refused: %v", refused)
	}
	defer unsubscribe()
	if initial.Version != 0 {
		t.Fatalf("initial version is %v, want 0", initial.Version)
	}

	hub.publish()
	hub.publish()
	select {
	case event := <-events:
		if event.Type != "state" || event.Version != 2 {
			t.Fatalf("event is %#v, want newest state version 2", event)
		}
	case <-time.After(time.Second):
		t.Fatal("the subscriber was not notified")
	}
}

/*
The watchers and the table have separate pools (SR-5).

The public events route carries no credential, so anybody holding a game's
address can open sockets on it. One shared pool meant a raw client could take
every slot and push every phone at the table back onto polling.
*/
func TestAFullPublicPoolStillLetsTheTableIn(t *testing.T) {
	defer resetLiveSockets()
	hub := newGameEvents()
	for i := range maxPublicSubscribers {
		// One source may hold only a few, so the watchers come from many.
		_, _, _, _, refused := hub.subscribe(eventAudiencePublic, "", fmt.Sprintf("10.0.0.%v", i))
		if refused != "" {
			t.Fatalf("watcher %v was refused below the public quota: %v", i, refused)
		}
	}
	if _, _, _, _, refused := hub.subscribe(eventAudiencePublic, "", "10.9.9.9"); refused == "" {
		t.Fatal("a watcher past the public quota was accepted")
	}

	// A full board and a referee, with nothing in the public pool free.
	for _, power := range classical.ClassicalVariant.Nations {
		if _, _, _, _, refused := hub.subscribe(eventAudienceSeat, power, "10.1.1.1"); refused != "" {
			t.Fatalf("%v was refused while the public pool was full: %v", power, refused)
		}
	}
	if _, _, _, _, refused := hub.subscribe(eventAudienceGM, "", "10.1.1.1"); refused != "" {
		t.Fatalf("the game master was refused while the public pool was full: %v", refused)
	}
}

// One address's share of the public pool. A watcher at a table opens one or
// two; a script opens as many as it can.
func TestOneAddressGetsAShareOfThePublicPool(t *testing.T) {
	defer resetLiveSockets()
	hub := newGameEvents()
	for i := range maxPublicPerSource {
		if _, _, _, _, refused := hub.subscribe(eventAudiencePublic, "", "10.0.0.1"); refused != "" {
			t.Fatalf("view %v from one address was refused: %v", i, refused)
		}
	}
	if _, _, _, _, refused := hub.subscribe(eventAudiencePublic, "", "10.0.0.1"); refused == "" {
		t.Fatal("one address took more than its share of the public pool")
	}
	// Somebody else is unaffected, and a seat from that same address is too.
	if _, _, _, _, refused := hub.subscribe(eventAudiencePublic, "", "10.0.0.2"); refused != "" {
		t.Fatalf("another address was refused: %v", refused)
	}
	if _, _, _, _, refused := hub.subscribe(eventAudienceSeat, "France", "10.0.0.1"); refused != "" {
		t.Fatalf("a seat from a busy address was refused: %v", refused)
	}
}

/*
The whole server has a ceiling, not only each game.

Without it the per-game quota still allows the game limit times the game
quota, which is thousands of sockets on a laptop under a table.
*/
func TestNoGameCanPushTheServerPastItsCeiling(t *testing.T) {
	defer resetLiveSockets()
	held := 0
	for game := 0; held < maxLiveSockets+1; game++ {
		hub := newGameEvents()
		room := false
		for i := range maxAuthedSubscribers {
			_, _, _, _, refused := hub.subscribe(eventAudienceGM, "", fmt.Sprintf("10.%v.0.%v", game, i))
			if refused != "" {
				break
			}
			held++
			room = true
		}
		if !room {
			break
		}
	}
	if held != maxLiveSockets {
		t.Errorf("the server carried %v live views, and the ceiling is %v", held, maxLiveSockets)
	}
}

// A slot comes back when the connection does, and the counting does not drift
// when the same handler both revokes and unsubscribes.
func TestASlotComesBackOnce(t *testing.T) {
	defer resetLiveSockets()
	hub := newGameEvents()
	_, _, _, unsubscribe, refused := hub.subscribe(eventAudienceSeat, "France", "10.0.0.1")
	if refused != "" {
		t.Fatal(refused)
	}
	hub.revokeSeat("France")
	unsubscribe()
	unsubscribe()
	liveSockets.mu.Lock()
	total := liveSockets.total
	liveSockets.mu.Unlock()
	if total != 0 {
		t.Errorf("%v live views are still counted", total)
	}
}

func TestGameEventsCapAndRoleRevocation(t *testing.T) {
	defer resetLiveSockets()
	hub := newGameEvents()
	unsubscribes := []func(){}
	for i := range maxPublicSubscribers - 1 {
		_, _, _, unsubscribe, refused := hub.subscribe(eventAudiencePublic, "", fmt.Sprintf("10.0.0.%v", i))
		if refused != "" {
			t.Fatalf("subscriber was refused below the quota: %v", refused)
		}
		unsubscribes = append(unsubscribes, unsubscribe)
	}
	_, _, seatRevoked, seatUnsubscribe, refused := hub.subscribe(eventAudienceSeat, "France", "10.1.1.1")
	if refused != "" {
		t.Fatalf("seat subscriber was refused: %v", refused)
	}
	unsubscribes = append(unsubscribes, seatUnsubscribe)
	_, _, gmRevoked, gmUnsubscribe, refused := hub.subscribe(eventAudienceGM, "", "10.1.1.1")
	if refused != "" {
		t.Fatalf("GM subscriber was refused: %v", refused)
	}
	unsubscribes = append(unsubscribes, gmUnsubscribe)

	hub.revokeSeat("France")
	select {
	case <-seatRevoked:
	default:
		t.Fatal("seat subscriber was not revoked")
	}
	select {
	case <-gmRevoked:
		t.Fatal("revoking a seat also revoked the GM")
	default:
	}
	// Revocation releases capacity even before the handler's deferred cleanup.
	_, _, _, replacementUnsubscribe, refused := hub.subscribe(eventAudienceSeat, "France", "10.1.1.1")
	if refused != "" {
		t.Fatalf("revocation did not release subscriber capacity: %v", refused)
	}
	replacementUnsubscribe()

	for _, unsubscribe := range unsubscribes {
		unsubscribe()
	}
}

func TestWebSocketRefusesUpgradePastGameCap(t *testing.T) {
	defer resetLiveSockets()
	g := &game{events: newGameEvents()}
	for i := range maxPublicSubscribers {
		_, _, _, _, refused := g.events.subscribe(eventAudiencePublic, "", fmt.Sprintf("10.0.0.%v", i))
		if refused != "" {
			t.Fatalf("subscriber was refused below the quota: %v", refused)
		}
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		handleEvents(g, "game", w, r)
	}))
	defer server.Close()

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	url := "ws" + strings.TrimPrefix(server.URL, "http")
	connection, response, err := websocket.Dial(ctx, url, nil)
	if connection != nil {
		connection.Close(websocket.StatusNormalClosure, "")
	}
	if err == nil {
		t.Fatal("upgrade past the per-game cap succeeded")
	}
	if response == nil || response.StatusCode != http.StatusTooManyRequests {
		t.Fatalf("response is %#v, want HTTP 429", response)
	}
}

func TestWebSocketCarriesInitialAndChangedVersions(t *testing.T) {
	defer resetLiveSockets()
	g := &game{events: newGameEvents()}
	games.mu.Lock()
	saved := games.games
	games.games = map[string]*game{"game": g}
	games.mu.Unlock()
	defer func() {
		games.mu.Lock()
		games.games = saved
		games.mu.Unlock()
	}()
	app := &server{}
	server := httptest.NewServer(httpx.Compress(limitBody(http.HandlerFunc(app.serveAPI))))
	defer server.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	url := "ws" + strings.TrimPrefix(server.URL, "http") + "/api/v1/game/game/events"
	connection, _, err := websocket.Dial(ctx, url, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer connection.Close(websocket.StatusNormalClosure, "")

	read := func() gameEvent {
		t.Helper()
		event := gameEvent{}
		if err := wsjson.Read(ctx, connection, &event); err != nil {
			t.Fatalf("read: %v", err)
		}
		return event
	}
	if event := read(); event.Type != "state" || event.Version != 0 {
		t.Fatalf("initial event is %#v", event)
	}
	g.events.publish()
	if event := read(); event.Type != "state" || event.Version != 1 {
		t.Fatalf("changed event is %#v", event)
	}
}
