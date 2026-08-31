/*
seed fills a running server with a few games worth looking at.

A server with no games opens on an empty list, which tells a visitor nothing
about what the app does. This makes a handful of Classical games, plays their
first turn and leaves them at Fall 1901, so the spectator pages (ADR-028) have a
real board on them.

Each game is named after the opening it plays. An opening is a named idea, not
a transcript: authors differ over a unit or two and this file states one
standard version of each. Nothing here claims to reproduce a game that was
played by anybody.

	go run ./tools/seed -url http://localhost:8000

It talks to the server over HTTP exactly as a browser does: create, join seven
seats, start, order, lock. That is the point — it exercises the same doors the
table uses, so a seeded game is not a special kind of game.
*/
package main

import (
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"strings"
)

// order is one instruction, in the parts the API takes: the province the unit
// stands in, then the order words: ("Move", "bur") or ("Hold").
type order struct {
	province string
	parts    []string
}

func move(from, to string) order { return order{from, []string{"Move", to}} }
func hold(at string) order       { return order{at, []string{"Hold"}} }

// opening is one seeded game: what it is called, and what each power does in
// Spring 1901.
type opening struct {
	name   string
	orders map[string][]order
}

/*
The orders every power gives unless the opening overrides them.

These are ordinary, uncontentious first moves — the ones a table of strangers
plays. They exist so that a game named after one power's opening still shows a
board where everybody moved, rather than six powers standing still around the
one idea being illustrated.
*/
var standard = map[string][]order{
	"Austria": {move("vie", "bud"), move("bud", "ser"), move("tri", "alb")},
	"England": {move("edi", "nrg"), move("lon", "nth"), move("lvp", "yor")},
	"France":  {move("par", "bur"), move("mar", "spa"), move("bre", "mid")},
	"Germany": {move("ber", "kie"), move("mun", "ruh"), move("kie", "den")},
	"Italy":   {move("nap", "ion"), move("rom", "apu"), move("ven", "tyr")},
	"Russia":  {move("mos", "ukr"), move("war", "gal"), move("sev", "rum"), move("stp/sc", "bot")},
	"Turkey":  {move("ank", "bla"), move("con", "bul"), move("smy", "con")},
}

/*
The seeded games.

Each names an opening and overrides the powers that play it. What makes an
opening worth watching is that the first turn already shows the plan: the
Blitzkrieg puts an army in Burgundy, the Juggernaut hands Russia the Black Sea,
the Lepanto sends the Italian fleet east instead of west.
*/
var openings = []opening{
	{
		// Germany's army goes at France on the first turn instead of
		// covering the Ruhr.
		name: "The Blitzkrieg",
		orders: map[string][]order{
			"Germany": {move("ber", "kie"), move("mun", "bur"), move("kie", "den")},
		},
	},
	{
		// Turkey declines the Black Sea so Russia can take it, which is
		// the handshake the whole alliance rests on.
		name: "The Juggernaut",
		orders: map[string][]order{
			"Russia": {move("sev", "bla"), move("mos", "ukr"), move("war", "gal"), move("stp/sc", "bot")},
			"Turkey": {move("ank", "con"), move("con", "bul"), move("smy", "ank")},
		},
	},
	{
		// Italy sails east for a convoy to Turkey rather than west at
		// France, and Austria covers Trieste so Venice can leave.
		name: "The Lepanto",
		orders: map[string][]order{
			"Italy":   {move("nap", "ion"), move("rom", "apu"), move("ven", "tyr")},
			"Austria": {move("vie", "tri"), move("bud", "ser"), move("tri", "alb")},
		},
	},
	{
		// France holds the south and takes Picardy: no army in Burgundy,
		// nothing for Germany or England to read as a threat.
		name: "The Maginot",
		orders: map[string][]order{
			"France": {move("par", "pic"), hold("mar"), move("bre", "mid")},
		},
	},
	{
		// England's whole opening points at Norway and the north.
		name: "The Northern Opening",
		orders: map[string][]order{
			"England": {move("edi", "nrg"), move("lon", "nth"), move("lvp", "edi")},
		},
	},
	{
		// Austria puts an army in Trieste behind the fleet leaving it and
		// takes Serbia: the defensive Balkan start.
		name: "The Hedgehog",
		orders: map[string][]order{
			"Austria": {move("vie", "tri"), move("bud", "ser"), move("tri", "alb")},
			"Russia":  {move("mos", "ukr"), move("war", "gal"), move("sev", "rum"), move("stp/sc", "bot")},
		},
	},
}

func main() {
	base := flag.String("url", "http://localhost:8000", "the server to fill")
	flag.Parse()

	for _, o := range openings {
		id, err := seed(strings.TrimSuffix(*base, "/"), o)
		if err != nil {
			log.Fatalf("%v: %v", o.name, err)
		}
		fmt.Printf("%-24v %v/watch/%v\n", o.name, *base, id)
	}
}

// seed plays one game's first turn and returns its id.
func seed(base string, o opening) (string, error) {
	// A jar, because the create sets the referee cookie and the referee
	// door is how this client reaches the game master token at all.
	jar, err := cookiejar.New(nil)
	if err != nil {
		return "", err
	}
	client := &http.Client{
		Jar: jar,
		// The referee door answers with a redirect carrying the token; it
		// has to be read, not followed.
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}

	var created struct {
		GameID    string `json:"gameId"`
		InviteURL string `json:"inviteUrl"`
	}
	body := map[string]any{"settings": map[string]any{
		"name":            o.name,
		"variant":         "classical",
		"gmPlays":         false,
		"deadlineMinutes": 60,
	}}
	if err := post(client, base+"/games", body, &created); err != nil {
		return "", fmt.Errorf("create: %w", err)
	}

	gm, err := gmToken(client, base, created.GameID)
	if err != nil {
		return "", err
	}

	// Seven scans of the one invite (ADR-020). Each gets its own client,
	// because a seat is claimed per device: the server hands the same power
	// back to a browser that already holds one, which is the whole point of
	// the device cookie and would give this one client one seat seven times.
	invite := created.InviteURL
	token := invite[strings.LastIndex(invite, "/")+1:]
	join := base + "/game/" + created.GameID + "/join/" + token

	addresses := make([]string, 0, 7)
	for i := 0; i < 7; i++ {
		var claimed struct {
			SeatURL string `json:"seatUrl"`
		}
		if err := post(&http.Client{}, join, nil, &claimed); err != nil {
			return "", fmt.Errorf("join %v: %w", i+1, err)
		}
		addresses = append(addresses, strings.TrimSuffix(claimed.SeatURL, "/"))
	}

	if err := post(client, base+"/game/"+created.GameID+"/gm/"+gm+"/start", nil, nil); err != nil {
		return "", fmt.Errorf("start: %w", err)
	}

	// A claim answers with an address, not a power, and the powers are dealt
	// at the start (ADR-021). So a seat says who it is only now.
	seats := map[string]string{}
	for _, seat := range addresses {
		var state struct {
			You struct {
				Power string `json:"power"`
			} `json:"you"`
		}
		if err := get(client, seat+"/state", &state); err != nil {
			return "", fmt.Errorf("seat state: %w", err)
		}
		if state.You.Power == "" {
			return "", fmt.Errorf("seat %v was dealt no power", seat)
		}
		seats[state.You.Power] = seat
	}

	for power, seat := range seats {
		orders := o.orders[power]
		if orders == nil {
			orders = standard[power]
		}
		for _, one := range orders {
			body := map[string]any{"province": one.province, "parts": one.parts}
			if err := post(client, seat+"/order", body, nil); err != nil {
				return "", fmt.Errorf("%v %v: %w", power, one.province, err)
			}
		}
		if err := post(client, seat+"/lock", nil, nil); err != nil {
			return "", fmt.Errorf("%v lock: %w", power, err)
		}
	}
	return created.GameID, nil
}

// gmToken reads the game master token out of the referee door's redirect. The
// create answer deliberately carries no secret; the cookie it set is what
// opens this.
func gmToken(client *http.Client, base, id string) (string, error) {
	res, err := client.Get(base + "/game/" + id + "/referee/")
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	io.Copy(io.Discard, res.Body)
	target, err := url.Parse(res.Header.Get("Location"))
	if err != nil || target.Path == "" {
		return "", fmt.Errorf("referee: no redirect (%v)", res.Status)
	}
	parts := strings.Split(strings.Trim(target.Path, "/"), "/")
	if len(parts) < 4 || parts[2] != "gm" {
		return "", fmt.Errorf("referee: %q is not a game master address", target.Path)
	}
	return parts[3], nil
}

// get reads one JSON answer.
func get(client *http.Client, url string, into any) error {
	res, err := client.Get(url)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	answer, err := io.ReadAll(res.Body)
	if err != nil {
		return err
	}
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("%v: %v", res.Status, strings.TrimSpace(string(answer)))
	}
	return json.Unmarshal(answer, into)
}

// post sends a JSON body, or none, and decodes the answer when one is wanted.
func post(client *http.Client, url string, body, into any) error {
	var reader io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reader = bytes.NewReader(encoded)
	}
	req, err := http.NewRequest(http.MethodPost, url, reader)
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	res, err := client.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	answer, err := io.ReadAll(res.Body)
	if err != nil {
		return err
	}
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("%v: %v", res.Status, strings.TrimSpace(string(answer)))
	}
	if into == nil {
		return nil
	}
	return json.Unmarshal(answer, into)
}
