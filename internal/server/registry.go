// Every game this process holds, by id.
//
// One map, one lock, and a cap. The cap is what stops a public address from
// turning into unbounded memory (ADR-018).

package server

import (
	"errors"
	"log"
	"os"
	"regexp"
	"strconv"
	"sync"

	"github.com/zond/godip/variants/common"
)

// registry holds every live game, keyed by id.
type registry struct {
	mu    sync.Mutex
	games map[string]*game
	// limit caps how many games the registry may hold. Games never expire,
	// so this is what stops an anonymous loop of creates from eating the
	// box. Set once at startup, from MAX_GAMES.
	limit int
}

var games = &registry{games: map[string]*game{}}

// errGameLimit says create() refused a new game because the registry is at
// its cap.
var errGameLimit = errors.New("game limit reached")

// defaultMaxGames is the cap on live games when MAX_GAMES is unset. A table
// runs a handful of games; the cap exists for the hostile case, not the
// busy one.
const defaultMaxGames = 100

// gameLimit reads MAX_GAMES. A value that is not a positive number is a
// startup error, not a silent default.
func gameLimit() int {
	v := os.Getenv("MAX_GAMES")
	if v == "" {
		return defaultMaxGames
	}
	n, err := strconv.Atoi(v)
	if err != nil || n < 1 {
		log.Fatalf("MAX_GAMES %q: it must be a positive number", v)
	}
	return n
}

var idPattern = regexp.MustCompile(`^[a-z0-9-]{1,32}$`)

func validID(id string) bool {
	return idPattern.MatchString(id)
}

// lookup returns an existing game. Games exist only once POST /api/v1/games has
// created them.
func (self *registry) lookup(id string) (*game, bool) {
	self.mu.Lock()
	defer self.mu.Unlock()
	g, found := self.games[id]
	return g, found
}

// remove takes a game out of the registry and cuts loose everything watching
// it, and says whether there was one. Only the owner deletes a game
// (ADR-060); nothing a player does reaches here.
func (self *registry) remove(id string) bool {
	self.mu.Lock()
	g, found := self.games[id]
	delete(self.games, id)
	self.mu.Unlock()
	if !found {
		return false
	}
	// A live view of a game that no longer exists would poll a 404 forever.
	g.events.revokeAll()
	return true
}

// create registers a new game under a fresh random id.
func (self *registry) create(key string, v common.Variant, f *flow) (*game, string, error) {
	g, err := newGame(key, v)
	if err != nil {
		return nil, "", err
	}
	g.flow = f

	self.mu.Lock()
	defer self.mu.Unlock()
	if self.limit > 0 && len(self.games) >= self.limit {
		return nil, "", errGameLimit
	}
	for attempt := 0; attempt < 10; attempt++ {
		id, err := newGameID()
		if err != nil {
			return nil, "", err
		}
		if _, taken := self.games[id]; taken {
			continue
		}
		self.games[id] = g
		return g, id, nil
	}
	return nil, "", errors.New("could not find a free game id")
}
