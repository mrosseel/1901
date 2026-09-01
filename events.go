// Live game notifications over WebSockets.
//
// Mutations still use ordinary HTTP requests and every role still reads its
// own filtered state endpoint. The socket carries only a monotonically
// increasing version: it says that something changed, never what another
// player's orders contain. This is also the transport future press messages
// can extend without making phase changes wait on polling again.
package main

import (
	"context"
	"net/http"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
	"github.com/zond/godip"
)

type gameEvent struct {
	Type    string `json:"type"`
	Version uint64 `json:"version"`
}

type eventAudience uint8

const (
	eventAudiencePublic eventAudience = iota
	eventAudienceSeat
	eventAudienceGM
	maxGameSubscribers = 64
)

type eventSubscriber struct {
	events   chan gameEvent
	revoked  chan struct{}
	audience eventAudience
	power    godip.Nation
}

type gameEvents struct {
	mu          sync.Mutex
	version     uint64
	subscribers map[*eventSubscriber]struct{}
}

func newGameEvents() *gameEvents {
	return &gameEvents{subscribers: map[*eventSubscriber]struct{}{}}
}

// publish wakes every connected view without ever waiting for a slow phone.
// A subscriber needs only the newest version because it re-reads current
// state; replacing an unread event is therefore lossless.
func (self *gameEvents) publish() {
	if self == nil {
		return
	}
	self.mu.Lock()
	defer self.mu.Unlock()
	self.version++
	event := gameEvent{Type: "state", Version: self.version}
	for subscriber := range self.subscribers {
		select {
		case subscriber.events <- event:
		default:
			select {
			case <-subscriber.events:
			default:
			}
			select {
			case subscriber.events <- event:
			default:
			}
		}
	}
}

func (self *gameEvents) subscribe(audience eventAudience, power godip.Nation) (gameEvent, <-chan gameEvent, <-chan struct{}, func(), bool) {
	self.mu.Lock()
	defer self.mu.Unlock()
	if len(self.subscribers) >= maxGameSubscribers {
		return gameEvent{}, nil, nil, func() {}, false
	}
	subscriber := &eventSubscriber{
		events:   make(chan gameEvent, 1),
		revoked:  make(chan struct{}),
		audience: audience,
		power:    power,
	}
	self.subscribers[subscriber] = struct{}{}
	initial := gameEvent{Type: "state", Version: self.version}
	return initial, subscriber.events, subscriber.revoked, func() {
		self.mu.Lock()
		delete(self.subscribers, subscriber)
		self.mu.Unlock()
	}, true
}

func (self *gameEvents) revoke(audience eventAudience, power godip.Nation) {
	if self == nil {
		return
	}
	self.mu.Lock()
	defer self.mu.Unlock()
	for subscriber := range self.subscribers {
		if subscriber.audience == audience && (audience != eventAudienceSeat || subscriber.power == power) {
			delete(self.subscribers, subscriber)
			close(subscriber.revoked)
		}
	}
}

func (self *gameEvents) revokeSeat(power godip.Nation) {
	self.revoke(eventAudienceSeat, power)
}

func (self *gameEvents) revokeGM() {
	self.revoke(eventAudienceGM, "")
}

const (
	eventWriteTimeout = 10 * time.Second
	eventPingInterval = 25 * time.Second
)

func writeGameEvent(ctx context.Context, connection *websocket.Conn, event gameEvent) error {
	ctx, cancel := context.WithTimeout(ctx, eventWriteTimeout)
	defer cancel()
	return wsjson.Write(ctx, connection, event)
}

// handleEvents upgrades an already-authorized public, seat, or GM route. The
// initial frame makes reconnect a full resynchronization point; subsequent
// frames are coalesced invalidations.
func serveEvents(g *game, audience eventAudience, power godip.Nation, w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeErr(w, http.StatusMethodNotAllowed, "GET only")
		return
	}
	initial, events, revoked, unsubscribe, ok := g.events.subscribe(audience, power)
	if !ok {
		writeErr(w, http.StatusTooManyRequests, "too many live views for this game")
		return
	}
	defer unsubscribe()

	connection, err := websocket.Accept(w, r, nil)
	if err != nil {
		return
	}
	defer connection.Close(websocket.StatusNormalClosure, "")

	// No client messages exist yet. CloseRead keeps control frames flowing and
	// notices a sleeping or disconnected phone without competing with writes.
	baseCtx, cancel := context.WithCancel(context.Background())
	defer cancel()
	ctx := connection.CloseRead(baseCtx)
	if err := writeGameEvent(ctx, connection, initial); err != nil {
		return
	}
	ticker := time.NewTicker(eventPingInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-revoked:
			connection.Close(websocket.StatusPolicyViolation, "authorization changed")
			return
		case event := <-events:
			if err := writeGameEvent(ctx, connection, event); err != nil {
				return
			}
		case <-ticker.C:
			pingCtx, cancel := context.WithTimeout(ctx, eventWriteTimeout)
			err := connection.Ping(pingCtx)
			cancel()
			if err != nil {
				return
			}
		}
	}
}

func handleEvents(g *game, _ string, w http.ResponseWriter, r *http.Request) {
	serveEvents(g, eventAudiencePublic, "", w, r)
}

func handleSeatEvents(g *game, _ string, power godip.Nation, w http.ResponseWriter, r *http.Request) {
	serveEvents(g, eventAudienceSeat, power, w, r)
}

func handleGMEvents(g *game, _ string, w http.ResponseWriter, r *http.Request) {
	serveEvents(g, eventAudienceGM, "", w, r)
}
