// Live game notifications over WebSockets.
//
// Capacity is split three ways, because the public route needs no credential
// and the seats must not have to compete with it. See the quota block below.
//
// Mutations still use ordinary HTTP requests and every role still reads its
// own filtered state endpoint. The socket carries only a monotonically
// increasing version: it says that something changed, never what another
// player's orders contain. This is also the transport future press messages
// can extend without making phase changes wait on polling again.
package server

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"spring1901/spike/internal/httpx"

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
)

/*
The quotas, and why there are three of them.

The bare `/api/v1/game/{id}/events` route is public by design (ADR-013): a
watcher needs no credential. So anybody who knows a game's address can open
sockets on it, and one pool shared with the seats meant a raw client could take
every slot and push the table back onto polling.

	maxPublicSubscribers   what an unauthenticated watcher pool holds.
	maxAuthedSubscribers   held for the seats and the game master, and never
	                       reachable from the public route. A board has seven
	                       powers and a referee, and a player may have the
	                       game open on a phone and a laptop, so this is
	                       comfortably more than a full table needs.
	maxPublicPerSource     one address's share of the public pool. A watcher
	                       at a table opens one or two; a script opens as many
	                       as it can.

maxLiveSockets is the whole server. Without it the per-game cap still allows
the game limit times the game cap, which is thousands of file descriptors on a
laptop under a table.
*/
const (
	maxPublicSubscribers = 32
	maxAuthedSubscribers = 32
	maxPublicPerSource   = 4
	maxLiveSockets       = 512
)

/*
liveSockets counts every live view this process holds, across every game.

Public connections are also counted per source address, because the public
route is the one with no credential behind it and one machine opening thirty
watchers is not a table.
*/
type liveSocketCount struct {
	mu       sync.Mutex
	total    int
	bySource map[string]int
}

var liveSockets = liveSocketCount{bySource: map[string]int{}}

// take claims one server-wide slot, and one of this source's public slots.
// The reason is the sentence the caller shows.
func (self *liveSocketCount) take(audience eventAudience, source string) string {
	self.mu.Lock()
	defer self.mu.Unlock()
	if self.total >= maxLiveSockets {
		return "this server is carrying as many live views as it can"
	}
	if audience == eventAudiencePublic {
		if self.bySource[source] >= maxPublicPerSource {
			return "too many live views from this address"
		}
		self.bySource[source]++
	}
	self.total++
	return ""
}

func (self *liveSocketCount) give(audience eventAudience, source string) {
	self.mu.Lock()
	defer self.mu.Unlock()
	if self.total > 0 {
		self.total--
	}
	if audience != eventAudiencePublic {
		return
	}
	if self.bySource[source] <= 1 {
		delete(self.bySource, source)
		return
	}
	self.bySource[source]--
}

/*
trustedProxies is the set of addresses whose X-Forwarded-For is believed, read
once at startup from TRUSTED_PROXY. Empty means nobody's is.

At a table every phone reaches this process directly and its own address is
the truth. Behind a reverse proxy every connection arrives from the proxy, so
the per-source share would put the whole internet on one address. Only the
proxy may say who it is fronting: a header from anyone else is a way to dodge
the share by making up addresses, so it is ignored unless the connection
itself comes from a listed proxy.
*/
var trustedProxies []*net.IPNet

// eventSource is the address a public connection is counted against. The port
// changes with every connection, so only the host is kept. When the connection
// comes from a trusted proxy, the address is the last one that proxy appended
// to X-Forwarded-For, which is the client it accepted the connection from.
func eventSource(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	if !fromTrustedProxy(host) {
		return host
	}
	hops := strings.Split(r.Header.Get("X-Forwarded-For"), ",")
	client := strings.TrimSpace(hops[len(hops)-1])
	if client == "" {
		return host
	}
	return client
}

func fromTrustedProxy(host string) bool {
	ip := net.ParseIP(host)
	if ip == nil {
		return false
	}
	for _, network := range trustedProxies {
		if network.Contains(ip) {
			return true
		}
	}
	return false
}

// parseTrustedProxies reads a comma-separated list of addresses or CIDR
// ranges. A bare address becomes a range of one.
func parseTrustedProxies(list string) ([]*net.IPNet, error) {
	var out []*net.IPNet
	for _, item := range strings.Split(list, ",") {
		item = strings.TrimSpace(item)
		if item == "" {
			continue
		}
		if !strings.Contains(item, "/") {
			if ip := net.ParseIP(item); ip != nil {
				bits := 32
				if ip.To4() == nil {
					bits = 128
				}
				item = fmt.Sprintf("%s/%d", ip, bits)
			}
		}
		_, network, err := net.ParseCIDR(item)
		if err != nil {
			return nil, fmt.Errorf("%q is not an address or a CIDR range", item)
		}
		out = append(out, network)
	}
	return out, nil
}

type eventSubscriber struct {
	events   chan gameEvent
	revoked  chan struct{}
	audience eventAudience
	power    godip.Nation
	// source is the address a public connection is counted against, so the
	// server-wide accounting can be given back when this one goes.
	source string
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

/*
subscribe takes a slot, or says why there is none.

A seat and the game master are counted apart from the watchers, so a public
pool somebody filled cannot refuse a player. The returned function gives the
slot back and runs exactly once, from the handler's defer; revoke takes a
subscriber out of the game's pool without touching the server-wide count,
because the handler that owns it is still on its way out.
*/
func (self *gameEvents) subscribe(audience eventAudience, power godip.Nation, source string) (gameEvent, <-chan gameEvent, <-chan struct{}, func(), string) {
	if reason := liveSockets.take(audience, source); reason != "" {
		return gameEvent{}, nil, nil, func() {}, reason
	}
	self.mu.Lock()
	held := 0
	for subscriber := range self.subscribers {
		if (subscriber.audience == eventAudiencePublic) == (audience == eventAudiencePublic) {
			held++
		}
	}
	limit := maxAuthedSubscribers
	reason := "too many players and referees are watching this game"
	if audience == eventAudiencePublic {
		limit = maxPublicSubscribers
		reason = "too many live views of this game"
	}
	if held >= limit {
		self.mu.Unlock()
		liveSockets.give(audience, source)
		return gameEvent{}, nil, nil, func() {}, reason
	}
	subscriber := &eventSubscriber{
		events:   make(chan gameEvent, 1),
		revoked:  make(chan struct{}),
		audience: audience,
		power:    power,
		source:   source,
	}
	self.subscribers[subscriber] = struct{}{}
	initial := gameEvent{Type: "state", Version: self.version}
	self.mu.Unlock()
	release := sync.OnceFunc(func() {
		self.mu.Lock()
		delete(self.subscribers, subscriber)
		self.mu.Unlock()
		liveSockets.give(audience, source)
	})
	return initial, subscriber.events, subscriber.revoked, release, ""
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
		httpx.WriteErr(w, http.StatusMethodNotAllowed, "GET only")
		return
	}
	initial, events, revoked, unsubscribe, refused := g.events.subscribe(audience, power, eventSource(r))
	if refused != "" {
		httpx.WriteErr(w, http.StatusTooManyRequests, "%v", refused)
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
