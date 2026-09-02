package app

import (
	"context"
	"net/http"
	"net/http/httptest"
	"spring1901/spike/internal/httpx"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
)

func TestGameEventsCoalesceForASlowPhone(t *testing.T) {
	hub := newGameEvents()
	initial, events, _, unsubscribe, ok := hub.subscribe(eventAudiencePublic, "")
	if !ok {
		t.Fatal("first subscriber was refused")
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

func TestGameEventsCapAndRoleRevocation(t *testing.T) {
	hub := newGameEvents()
	unsubscribes := make([]func(), 0, maxGameSubscribers)
	for range maxGameSubscribers - 2 {
		_, _, _, unsubscribe, ok := hub.subscribe(eventAudiencePublic, "")
		if !ok {
			t.Fatal("subscriber was refused below the cap")
		}
		unsubscribes = append(unsubscribes, unsubscribe)
	}
	_, _, seatRevoked, seatUnsubscribe, ok := hub.subscribe(eventAudienceSeat, "France")
	if !ok {
		t.Fatal("seat subscriber was refused below the cap")
	}
	unsubscribes = append(unsubscribes, seatUnsubscribe)
	_, _, gmRevoked, gmUnsubscribe, ok := hub.subscribe(eventAudienceGM, "")
	if !ok {
		t.Fatal("GM subscriber was refused at the cap")
	}
	unsubscribes = append(unsubscribes, gmUnsubscribe)
	if _, _, _, _, ok := hub.subscribe(eventAudiencePublic, ""); ok {
		t.Fatal("subscriber past the per-game cap was accepted")
	}

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
	_, _, _, replacementUnsubscribe, ok := hub.subscribe(eventAudiencePublic, "")
	if !ok {
		t.Fatal("revocation did not release subscriber capacity")
	}
	replacementUnsubscribe()

	for _, unsubscribe := range unsubscribes {
		unsubscribe()
	}
}

func TestWebSocketRefusesUpgradePastGameCap(t *testing.T) {
	g := &game{events: newGameEvents()}
	for range maxGameSubscribers {
		_, _, _, _, ok := g.events.subscribe(eventAudiencePublic, "")
		if !ok {
			t.Fatal("subscriber was refused below the cap")
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
