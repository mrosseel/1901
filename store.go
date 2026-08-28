// SQLite persistence. Every mutation is written through inside the game
// lock, so a hard kill loses nothing; the in-memory structures stay the
// source of truth between writes.
//
// The board is stored as its order history, not as a godip dump. See
// replay() for why.
package main

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"time"

	"github.com/zond/godip"

	_ "modernc.org/sqlite"
)

// defaultDBPath can be overridden with the DB environment variable.
const defaultDBPath = "1901.db"

func dbPath() string {
	if p := os.Getenv("DB"); p != "" {
		return p
	}
	return defaultDBPath
}

// db is the process-wide handle. It is nil only before openDB runs.
var db *sql.DB

const schema = `
CREATE TABLE IF NOT EXISTS game (
    id               TEXT PRIMARY KEY,
    gm_token         TEXT    NOT NULL,
    invite_token     TEXT    NOT NULL,
    deadline_minutes INTEGER NOT NULL,
    gm_plays         INTEGER NOT NULL,
    settings_version INTEGER NOT NULL,
    started          INTEGER NOT NULL,
    deadline_at      TEXT,
    gm_power         TEXT    NOT NULL DEFAULT '',
    phase_index      INTEGER NOT NULL DEFAULT 0,
    created_at       TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS seat (
    game_id    TEXT    NOT NULL REFERENCES game(id) ON DELETE CASCADE,
    power      TEXT    NOT NULL,
    seat_token TEXT    NOT NULL DEFAULT '',
    device     TEXT    NOT NULL DEFAULT '',
    is_gm      INTEGER NOT NULL DEFAULT 0,
    finalized  INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (game_id, power)
);

-- One row per province per phase. Rows with phase_index below the game's
-- current phase are the applied history that replay() feeds back into
-- godip; rows at the current phase are this phase's draft orders.
CREATE TABLE IF NOT EXISTS game_order (
    game_id     TEXT    NOT NULL REFERENCES game(id) ON DELETE CASCADE,
    phase_index INTEGER NOT NULL,
    province    TEXT    NOT NULL,
    power       TEXT    NOT NULL,
    parts       TEXT    NOT NULL,
    PRIMARY KEY (game_id, phase_index, province)
);

CREATE TABLE IF NOT EXISTS event (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    game_id TEXT NOT NULL REFERENCES game(id) ON DELETE CASCADE,
    text    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS event_by_game ON event(game_id, id);
`

// openDB opens the database and applies the schema.
func openDB(path string) (*sql.DB, error) {
	handle, err := sql.Open("sqlite", path+"?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)&_pragma=foreign_keys(1)")
	if err != nil {
		return nil, err
	}
	// One writer at a time keeps the write-through simple and avoids
	// SQLITE_BUSY between concurrent game locks.
	handle.SetMaxOpenConns(1)
	if _, err := handle.Exec(schema); err != nil {
		handle.Close()
		return nil, err
	}
	return handle, nil
}

// persist writes the whole game — its settings, seats, current-phase
// orders, and any unwritten events — in one transaction. The caller must
// hold g.mu. Completed phases' order rows are history and never rewritten.
func (self *game) persist(id string) {
	if db == nil {
		return
	}
	if err := self.persistErr(id); err != nil {
		// The move already happened in memory; refusing it now would be
		// worse than a stale row, so log loudly and carry on.
		log.Printf("game %v: PERSIST FAILED: %v", id, err)
	}
}

func (self *game) persistErr(id string) error {
	f := self.flow
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	var deadline interface{}
	if f.deadlineAt != nil {
		deadline = f.deadlineAt.UTC().Format(time.RFC3339Nano)
	}
	_, err = tx.Exec(`
        INSERT INTO game (id, gm_token, invite_token, deadline_minutes, gm_plays,
                          settings_version, started, deadline_at, gm_power,
                          phase_index, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            deadline_minutes = excluded.deadline_minutes,
            gm_plays         = excluded.gm_plays,
            settings_version = excluded.settings_version,
            started          = excluded.started,
            deadline_at      = excluded.deadline_at,
            gm_power         = excluded.gm_power,
            phase_index      = excluded.phase_index`,
		id, f.gmToken, f.inviteToken, f.settings.DeadlineMinutes, f.settings.GMPlays,
		f.settingsVersion, f.started, deadline, string(f.gmPower),
		f.phaseIndex, f.createdAt.UTC().Format(time.RFC3339Nano))
	if err != nil {
		return fmt.Errorf("game row: %v", err)
	}

	for _, p := range powers() {
		s := f.seats[p]
		_, err = tx.Exec(`
            INSERT INTO seat (game_id, power, seat_token, device, is_gm, finalized)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(game_id, power) DO UPDATE SET
                seat_token = excluded.seat_token,
                device     = excluded.device,
                is_gm      = excluded.is_gm,
                finalized  = excluded.finalized`,
			id, string(p), s.token, s.device, s.isGM, s.finalized)
		if err != nil {
			return fmt.Errorf("seat %v: %v", p, err)
		}
	}

	// Rewrite this phase's draft orders wholesale — there are at most a
	// few dozen, and it keeps cancellation and replacement trivial.
	if _, err = tx.Exec(`DELETE FROM game_order WHERE game_id = ? AND phase_index = ?`,
		id, f.phaseIndex); err != nil {
		return fmt.Errorf("clear orders: %v", err)
	}
	for prov, parts := range self.parts {
		encoded, err := json.Marshal(parts)
		if err != nil {
			return fmt.Errorf("encode order %v: %v", prov, err)
		}
		_, err = tx.Exec(`
            INSERT INTO game_order (game_id, phase_index, province, power, parts)
            VALUES (?, ?, ?, ?, ?)`,
			id, f.phaseIndex, string(prov), string(self.owner[prov]), string(encoded))
		if err != nil {
			return fmt.Errorf("order %v: %v", prov, err)
		}
	}

	for _, line := range f.events[f.persistedEvents:] {
		if _, err = tx.Exec(`INSERT INTO event (game_id, text) VALUES (?, ?)`, id, line); err != nil {
			return fmt.Errorf("event: %v", err)
		}
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	f.persistedEvents = len(f.events)
	return nil
}

// loadAll reads every stored game into the registry.
func loadAll() error {
	if db == nil {
		return nil
	}
	rows, err := db.Query(`
        SELECT id, gm_token, invite_token, deadline_minutes, gm_plays,
               settings_version, started, deadline_at, gm_power, phase_index, created_at
        FROM game`)
	if err != nil {
		return err
	}
	type row struct {
		id         string
		f          *flow
		phaseIndex int
	}
	loaded := []row{}
	for rows.Next() {
		f := &flow{
			seats:       map[godip.Nation]*seat{},
			bySeatToken: map[string]godip.Nation{},
			byDevice:    map[string]godip.Nation{},
		}
		var id, gmPower, createdAt string
		var deadline sql.NullString
		var phaseIndex int
		if err := rows.Scan(&id, &f.gmToken, &f.inviteToken, &f.settings.DeadlineMinutes,
			&f.settings.GMPlays, &f.settingsVersion, &f.started, &deadline, &gmPower,
			&phaseIndex, &createdAt); err != nil {
			rows.Close()
			return err
		}
		if deadline.Valid {
			at, err := time.Parse(time.RFC3339Nano, deadline.String)
			if err == nil {
				f.deadlineAt = &at
			}
		}
		if at, err := time.Parse(time.RFC3339Nano, createdAt); err == nil {
			f.createdAt = at
		}
		f.gmPower = godip.Nation(gmPower)
		f.phaseIndex = phaseIndex
		loaded = append(loaded, row{id: id, f: f, phaseIndex: phaseIndex})
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}

	for _, entry := range loaded {
		g, err := restore(entry.id, entry.f)
		if err != nil {
			return fmt.Errorf("game %v: %v", entry.id, err)
		}
		games.mu.Lock()
		games.games[entry.id] = g
		games.mu.Unlock()
	}
	log.Printf("loaded %v game(s) from %v", len(loaded), dbPath())
	return nil
}

// storedOrder is one persisted order row.
type storedOrder struct {
	province godip.Province
	power    godip.Nation
	parts    []string
}

// restore rebuilds one game: seats, events, and the board.
func restore(id string, f *flow) (*game, error) {
	for _, p := range powers() {
		f.seats[p] = &seat{power: p}
	}
	rows, err := db.Query(
		`SELECT power, seat_token, device, is_gm, finalized FROM seat WHERE game_id = ?`, id)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var power, token, device string
		var isGM, finalized bool
		if err := rows.Scan(&power, &token, &device, &isGM, &finalized); err != nil {
			rows.Close()
			return nil, err
		}
		s, found := f.seats[godip.Nation(power)]
		if !found {
			continue
		}
		s.token, s.device, s.isGM, s.finalized = token, device, isGM, finalized
		if token != "" {
			f.bySeatToken[token] = s.power
		}
		if device != "" {
			f.byDevice[device] = s.power
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}

	rows, err = db.Query(`SELECT text FROM event WHERE game_id = ? ORDER BY id`, id)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var line string
		if err := rows.Scan(&line); err != nil {
			rows.Close()
			return nil, err
		}
		f.events = append(f.events, line)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	f.persistedEvents = len(f.events)

	history, err := loadOrders(id)
	if err != nil {
		return nil, err
	}

	g, err := newGame()
	if err != nil {
		return nil, err
	}
	g.flow = f
	if err := g.replay(history, f.phaseIndex); err != nil {
		return nil, err
	}
	return g, nil
}

// loadOrders returns every stored order, grouped by phase index.
func loadOrders(id string) (map[int][]storedOrder, error) {
	rows, err := db.Query(
		`SELECT phase_index, province, power, parts FROM game_order WHERE game_id = ? ORDER BY phase_index`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[int][]storedOrder{}
	for rows.Next() {
		var phaseIndex int
		var province, power, encoded string
		if err := rows.Scan(&phaseIndex, &province, &power, &encoded); err != nil {
			return nil, err
		}
		parts := []string{}
		if err := json.Unmarshal([]byte(encoded), &parts); err != nil {
			return nil, fmt.Errorf("decode order %v: %v", province, err)
		}
		out[phaseIndex] = append(out[phaseIndex], storedOrder{
			province: godip.Province(province),
			power:    godip.Nation(power),
			parts:    parts,
		})
	}
	return out, rows.Err()
}

// replay rebuilds the board from the classical start by re-entering every
// applied order and adjudicating, phase by phase, then re-entering the
// current phase's drafts.
//
// The alternative was godip's Dump/Load pair. Load takes no phase and no
// resolutions, and its order map holds unexported adjudicator types with
// no serialization of their own — so a dump would have to be completed by
// re-parsing order strings anyway, and would still lose the phase. Replay
// goes through the same setOrder path a live request uses, so a restored
// game cannot diverge from one that was never restarted, and it survives
// any change to godip's internals.
func (self *game) replay(history map[int][]storedOrder, currentPhase int) error {
	for phase := 0; phase < currentPhase; phase++ {
		if err := self.applyStored(history[phase]); err != nil {
			return fmt.Errorf("phase %v: %v", phase, err)
		}
		if err := self.state.Next(); err != nil {
			return fmt.Errorf("phase %v adjudication: %v", phase, err)
		}
		self.parts = map[godip.Province][]string{}
		self.owner = map[godip.Province]godip.Nation{}
	}
	return self.applyStored(history[currentPhase])
}

// applyStored re-enters one phase's orders. An order that no longer
// validates is skipped with a warning rather than failing the load; the
// game is more useful with one missing order than not at all.
func (self *game) applyStored(orders []storedOrder) error {
	for _, o := range orders {
		if err := self.setOrder(o.province, o.parts); err != nil {
			log.Printf("replay: skipping %v %v: %v", o.province, o.parts, err)
			continue
		}
		// Trust the stored power. In a retreat phase the unit has left
		// the board, so nationFor cannot work it out.
		self.owner[o.province] = o.power
	}
	return nil
}
