// SQLite persistence. Every mutation is written through inside the game
// lock, so a hard kill loses nothing; the in-memory structures stay the
// source of truth between writes.
//
// The board is stored as its order history, not as a godip dump. See
// replay() for why.
package main

import (
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"time"

	"github.com/zond/godip"
	"github.com/zond/godip/variants/common"

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
    gm_device        TEXT    NOT NULL DEFAULT '',
    deadline_minutes INTEGER NOT NULL,
    gm_plays         INTEGER NOT NULL,
    settings_version INTEGER NOT NULL,
    started          INTEGER NOT NULL,
    deadline_at      TEXT,
    gm_power         TEXT    NOT NULL DEFAULT '',
    phase_index      INTEGER NOT NULL DEFAULT 0,
    created_at       TEXT    NOT NULL,
    variant          TEXT    NOT NULL DEFAULT 'classical',
    -- The deadline settings of D-022, each with the default a game gets
    -- when nobody sets it, so an older row loads as the game it was.
    retreat_build_percent    INTEGER NOT NULL DEFAULT 50,
    grace_minutes            INTEGER NOT NULL DEFAULT 0,
    first_turn_extra_minutes INTEGER NOT NULL DEFAULT 0,
    press_mode               TEXT    NOT NULL DEFAULT 'ftf',
    -- D-029, and the default is ON: a game written before the setting
    -- existed is one where nobody was ever refused a misorder.
    illegal_moves            INTEGER NOT NULL DEFAULT 1,
    -- What the table calls this game. Empty is the ordinary case and means
    -- the game is known by its id, which is what every game did before.
    name                     TEXT    NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS seat (
    game_id    TEXT    NOT NULL REFERENCES game(id) ON DELETE CASCADE,
    power      TEXT    NOT NULL,
    seat_token TEXT    NOT NULL DEFAULT '',
    device     TEXT    NOT NULL DEFAULT '',
    is_gm      INTEGER NOT NULL DEFAULT 0,
    locked  INTEGER NOT NULL DEFAULT 0,
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
    -- An order the engine refuses, kept as the player wrote it (D-029).
    -- Replay needs the flag: without it a row that will not validate is
    -- indistinguishable from a corrupt one, and the two want opposite
    -- treatment — reproduce the first, drop the second and say so.
    illegal     INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (game_id, phase_index, province)
);

-- Which powers were resolved as NMR in a given phase. Replay cannot work
-- this out on its own: a power with no stored orders may have locked
-- with nothing to order rather than failed to lock.
CREATE TABLE IF NOT EXISTS phase_nmr (
    game_id     TEXT    NOT NULL REFERENCES game(id) ON DELETE CASCADE,
    phase_index INTEGER NOT NULL,
    power       TEXT    NOT NULL,
    PRIMARY KEY (game_id, phase_index, power)
);

CREATE TABLE IF NOT EXISTS event (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    game_id TEXT NOT NULL REFERENCES game(id) ON DELETE CASCADE,
    text    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS event_by_game ON event(game_id, id);

-- Secrets that belong to the server rather than to a game. One row today:
-- the salt every handover link is signed with (D-041). It lives here so a
-- QR code on a table outlives the process that printed it.
CREATE TABLE IF NOT EXISTS server_secret (
    name  TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
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
	if err := migrate(handle); err != nil {
		handle.Close()
		return nil, err
	}
	if err := loadHandoverSalt(handle); err != nil {
		handle.Close()
		return nil, err
	}
	return handle, nil
}

// loadHandoverSalt reads the salt every handover link is signed with, making
// it on first run (D-041). It is stored rather than generated per boot so a
// code somebody photographed still works after a restart.
func loadHandoverSalt(handle *sql.DB) error {
	var stored string
	err := handle.QueryRow(
		`SELECT value FROM server_secret WHERE name = 'handover_salt'`).Scan(&stored)
	if err == nil {
		handoverSalt, err = base64.RawURLEncoding.DecodeString(stored)
		return err
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	made, err := newToken()
	if err != nil {
		return err
	}
	if _, err := handle.Exec(
		`INSERT INTO server_secret (name, value) VALUES ('handover_salt', ?)`, made); err != nil {
		return err
	}
	handoverSalt, err = base64.RawURLEncoding.DecodeString(made)
	return err
}

// gameColumns are the columns a game row has grown since the first schema,
// each with the definition an older database is missing. A row written before
// a setting existed loads as the game it was: a classical game with no press
// mode declared and Backstabbr's retreat clock.
var gameColumns = []struct{ name, definition string }{
	{"variant", `TEXT NOT NULL DEFAULT '` + defaultVariant + `'`},
	{"retreat_build_percent", `INTEGER NOT NULL DEFAULT 50`},
	{"grace_minutes", `INTEGER NOT NULL DEFAULT 0`},
	{"first_turn_extra_minutes", `INTEGER NOT NULL DEFAULT 0`},
	{"press_mode", `TEXT NOT NULL DEFAULT '` + defaultPressMode + `'`},
	{"gm_device", `TEXT NOT NULL DEFAULT ''`},
	{"illegal_moves", `INTEGER NOT NULL DEFAULT 1`},
	// The descriptor hash a generated variant had when the game started.
	// Empty for a compiled variant, which changes only when the binary does.
	{"variant_hash", `TEXT NOT NULL DEFAULT ''`},
	// A game written before names existed keeps the identity it had: its id.
	{"name", `TEXT NOT NULL DEFAULT ''`},
	// The handover counter for the game master role (D-041). A game from
	// before role handovers starts at zero, which is what its links carry.
	{"gm_epoch", `INTEGER NOT NULL DEFAULT 0`},
	// The public half of the game master's key (D-048), base64url. Empty
	// for every game made before keys existed and every one whose game
	// master declined to make one; such a game has no recovery.
	{"gm_public_key", `TEXT NOT NULL DEFAULT ''`},
}

// orderColumns are the columns a game_order row has grown, in the same shape
// as gameColumns.
var orderColumns = []struct{ name, definition string }{
	{"illegal", `INTEGER NOT NULL DEFAULT 0`},
}

// seatColumns are the columns a seat row has grown, in the same shape as
// gameColumns. `locked` is here only for a database that has neither name:
// one written before the rename is carried across by renamedColumns instead,
// which keeps the stored value.
var seatColumns = []struct{ name, definition string }{
	{"locked", `INTEGER NOT NULL DEFAULT 0`},
	// The handover counter (D-041). A game from before handovers existed
	// starts every seat at zero, which is the epoch its links would carry.
	{"epoch", `INTEGER NOT NULL DEFAULT 0`},
	// The public half of the seat's key (D-049). Empty on every seat that
	// holds a token instead, which is every seat of every game made before
	// keys existed.
	{"sign_pub", `TEXT NOT NULL DEFAULT ''`},
}

// renamedColumns are columns that changed name. The rename must run before
// addColumns, or a database holding only the old name would gain an empty
// column under the new one and lose what it stored.
var renamedColumns = []struct{ table, from, to string }{
	// "finalize" was the word for this act until 2026-08-30; see CONTEXT.md.
	{"seat", "finalized", "locked"},
}

// migrate brings an older database up to the current schema.
func migrate(handle *sql.DB) error {
	for _, r := range renamedColumns {
		if err := renameColumn(handle, r.table, r.from, r.to); err != nil {
			return err
		}
	}
	if err := addColumns(handle, "game", gameColumns); err != nil {
		return err
	}
	if err := addColumns(handle, "game_order", orderColumns); err != nil {
		return err
	}
	return addColumns(handle, "seat", seatColumns)
}

// renameColumn renames one column if the old name is still there and the new
// one is not. Both present, or neither, means there is nothing to do.
func renameColumn(handle *sql.DB, table, from, to string) error {
	present, err := columnNames(handle, table)
	if err != nil {
		return err
	}
	if !present[from] || present[to] {
		return nil
	}
	log.Printf("migrating: renaming %v.%v to %v.%v", table, from, table, to)
	_, err = handle.Exec(
		`ALTER TABLE ` + table + ` RENAME COLUMN ` + from + ` TO ` + to)
	return err
}

func addColumns(handle *sql.DB, table string, columns []struct{ name, definition string }) error {
	present, err := columnNames(handle, table)
	if err != nil {
		return err
	}
	for _, column := range columns {
		if present[column.name] {
			continue
		}
		log.Printf("migrating: adding %v.%v", table, column.name)
		if _, err := handle.Exec(
			`ALTER TABLE ` + table + ` ADD COLUMN ` + column.name + ` ` + column.definition); err != nil {
			return err
		}
	}
	return nil
}

func columnNames(handle *sql.DB, table string) (map[string]bool, error) {
	rows, err := handle.Query(`PRAGMA table_info(` + table + `)`)
	if err != nil {
		return nil, err
	}
	present := map[string]bool{}
	for rows.Next() {
		var cid int
		var name, ctype string
		var notNull, pk int
		var deflt sql.NullString
		if err := rows.Scan(&cid, &name, &ctype, &notNull, &deflt, &pk); err != nil {
			rows.Close()
			return nil, err
		}
		present[name] = true
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return present, nil
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
        INSERT INTO game (id, gm_token, invite_token, gm_device, deadline_minutes, gm_plays,
                          settings_version, started, deadline_at, gm_power,
                          phase_index, created_at, variant,
                          retreat_build_percent, grace_minutes,
                          first_turn_extra_minutes, press_mode, illegal_moves,
                          variant_hash, name, gm_epoch, gm_public_key)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            -- The role can be handed on (D-041), which rotates the token, so
            -- unlike the invite it is not write-once.
            gm_token         = excluded.gm_token,
            gm_epoch         = excluded.gm_epoch,
            gm_device        = excluded.gm_device,
            deadline_minutes = excluded.deadline_minutes,
            gm_plays         = excluded.gm_plays,
            settings_version = excluded.settings_version,
            started          = excluded.started,
            deadline_at      = excluded.deadline_at,
            gm_power         = excluded.gm_power,
            phase_index      = excluded.phase_index,
            retreat_build_percent    = excluded.retreat_build_percent,
            grace_minutes            = excluded.grace_minutes,
            first_turn_extra_minutes = excluded.first_turn_extra_minutes,
            press_mode               = excluded.press_mode,
            illegal_moves            = excluded.illegal_moves,
            variant_hash             = excluded.variant_hash,
            name                     = excluded.name,
            -- Write-once in the handler (D-048), so this only ever writes
            -- the key the game already had or the first one it is given.
            gm_public_key            = excluded.gm_public_key`,
		id, f.gmToken, f.inviteToken, f.gmDevice, f.settings.DeadlineMinutes, f.settings.GMPlays,
		f.settingsVersion, f.started, deadline, string(f.gmPower),
		f.phaseIndex, f.createdAt.UTC().Format(time.RFC3339Nano), self.variantKey,
		f.settings.RetreatBuildPercent, f.settings.GraceMinutes,
		f.settings.FirstTurnExtraMinutes, f.settings.PressMode, f.settings.IllegalMoves,
		variantHash(self.variantKey), f.settings.Name, f.gmEpoch, f.gmPublicKey)
	if err != nil {
		return fmt.Errorf("game row: %v", err)
	}

	for _, p := range f.powers {
		s := f.seats[p]
		_, err = tx.Exec(`
            INSERT INTO seat (game_id, power, seat_token, device, is_gm, locked, epoch, sign_pub)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(game_id, power) DO UPDATE SET
                seat_token = excluded.seat_token,
                device     = excluded.device,
                is_gm      = excluded.is_gm,
                locked  = excluded.locked,
                epoch      = excluded.epoch,
                sign_pub   = excluded.sign_pub`,
			id, string(p), s.token, s.device, s.isGM, s.locked, s.epoch, s.signPub)
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
            INSERT INTO game_order (game_id, phase_index, province, power, parts, illegal)
            VALUES (?, ?, ?, ?, ?, ?)`,
			id, f.phaseIndex, string(prov), string(self.owner[prov]), string(encoded),
			self.illegal[prov])
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

// persistNMR records the powers that were resolved as NMR in one phase.
// The caller must hold the game lock and must call this before the phase
// index moves on.
func persistNMR(id string, phaseIndex int, nmr []string) {
	if db == nil || len(nmr) == 0 {
		return
	}
	for _, power := range nmr {
		if _, err := db.Exec(
			`INSERT OR IGNORE INTO phase_nmr (game_id, phase_index, power) VALUES (?, ?, ?)`,
			id, phaseIndex, power); err != nil {
			log.Printf("game %v: PERSIST FAILED (nmr %v): %v", id, power, err)
			return
		}
	}
}

// loadNMR returns the stored NMR powers per phase index.
func loadNMR(id string) (map[int][]string, error) {
	rows, err := db.Query(
		`SELECT phase_index, power FROM phase_nmr WHERE game_id = ? ORDER BY phase_index, power`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[int][]string{}
	for rows.Next() {
		var phaseIndex int
		var power string
		if err := rows.Scan(&phaseIndex, &power); err != nil {
			return nil, err
		}
		out[phaseIndex] = append(out[phaseIndex], power)
	}
	return out, rows.Err()
}

// loadAll reads every stored game into the registry.
func loadAll() error {
	if db == nil {
		return nil
	}
	rows, err := db.Query(`
        SELECT id, gm_token, invite_token, gm_device, deadline_minutes, gm_plays,
               settings_version, started, deadline_at, gm_power, phase_index,
               created_at, COALESCE(variant, ?),
               retreat_build_percent, grace_minutes, first_turn_extra_minutes,
               COALESCE(press_mode, ?), illegal_moves, COALESCE(variant_hash, ''),
               COALESCE(name, ''), COALESCE(gm_epoch, 0), COALESCE(gm_public_key, '')
        FROM game`, defaultVariant, defaultPressMode)
	if err != nil {
		return err
	}
	type row struct {
		id      string
		f       *flow
		key     string
		variant common.Variant
	}
	loaded := []row{}
	for rows.Next() {
		f := &flow{
			seats:       map[godip.Nation]*seat{},
			bySeatToken: map[string]godip.Nation{},
			bySignPub:   map[string]godip.Nation{},
			byDevice:    map[string]godip.Nation{},
			sessions:    map[string]godip.Nation{},
		}
		var id, gmPower, createdAt, key, recordedHash string
		var deadline sql.NullString
		var phaseIndex int
		if err := rows.Scan(&id, &f.gmToken, &f.inviteToken, &f.gmDevice, &f.settings.DeadlineMinutes,
			&f.settings.GMPlays, &f.settingsVersion, &f.started, &deadline, &gmPower,
			&phaseIndex, &createdAt, &key, &f.settings.RetreatBuildPercent,
			&f.settings.GraceMinutes, &f.settings.FirstTurnExtraMinutes,
			&f.settings.PressMode, &f.settings.IllegalMoves, &recordedHash,
			&f.settings.Name, &f.gmEpoch, &f.gmPublicKey); err != nil {
			rows.Close()
			return err
		}
		v, found := lookupVariant(key)
		if !found {
			rows.Close()
			return fmt.Errorf("game %v names unknown variant %q", id, key)
		}
		// A game replays its whole order history against the variant's start
		// position. If a generated descriptor changed underneath it, that
		// replay lands on a board the players never saw.
		if err := checkVariantHash(id, key, recordedHash); err != nil {
			rows.Close()
			return err
		}
		f.settings.Variant = key
		f.settings = f.settings.normalised()
		f.powers = sortedNations(v)
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
		loaded = append(loaded, row{id: id, f: f, key: key, variant: v})
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}

	for _, entry := range loaded {
		g, err := restore(entry.id, entry.key, entry.variant, entry.f)
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
	// illegal marks a row the engine refused when it was entered (D-029).
	// It will not validate on the way back in either, and that is expected.
	illegal bool
}

// restore rebuilds one game: seats, events, and the board.
func restore(id, key string, v common.Variant, f *flow) (*game, error) {
	for _, p := range f.powers {
		f.seats[p] = &seat{power: p}
	}
	rows, err := db.Query(
		`SELECT power, seat_token, device, is_gm, locked, epoch,
                COALESCE(sign_pub, '') FROM seat WHERE game_id = ?`, id)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var power, token, device, signPub string
		var isGM, locked bool
		var epoch int
		if err := rows.Scan(&power, &token, &device, &isGM, &locked, &epoch, &signPub); err != nil {
			rows.Close()
			return nil, err
		}
		s, found := f.seats[godip.Nation(power)]
		if !found {
			continue
		}
		s.token, s.device, s.isGM, s.locked, s.epoch = token, device, isGM, locked, epoch
		s.signPub = signPub
		if token != "" {
			f.bySeatToken[token] = s.power
		}
		if signPub != "" {
			f.bySignPub[signPub] = s.power
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
	nmr, err := loadNMR(id)
	if err != nil {
		return nil, err
	}

	g, err := newGame(key, v)
	if err != nil {
		return nil, err
	}
	g.flow = f
	if err := g.replay(history, nmr, f.phaseIndex); err != nil {
		return nil, err
	}
	// Recomputed rather than read back: autoLocked follows from the position
	// replay just rebuilt, and the event log already carries the lines from
	// when the phase began.
	g.autoLock()
	return g, nil
}

// loadOrders returns every stored order, grouped by phase index.
func loadOrders(id string) (map[int][]storedOrder, error) {
	rows, err := db.Query(
		`SELECT phase_index, province, power, parts, illegal
         FROM game_order WHERE game_id = ? ORDER BY phase_index`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[int][]storedOrder{}
	for rows.Next() {
		var phaseIndex int
		var province, power, encoded string
		var illegal bool
		if err := rows.Scan(&phaseIndex, &province, &power, &encoded, &illegal); err != nil {
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
			illegal:  illegal,
		})
	}
	return out, rows.Err()
}

// replay rebuilds the board from the variant's start position by re-entering every
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
func (self *game) replay(history map[int][]storedOrder, nmr map[int][]string, currentPhase int) error {
	for phase := 0; phase < currentPhase; phase++ {
		if err := self.applyStored(history[phase]); err != nil {
			return fmt.Errorf("phase %v: %v", phase, err)
		}
		// The same capture the live path does, so the review of the last
		// replayed phase comes back byte for byte — and so does every
		// public per-phase snapshot behind the /watch URLs (D-013). That is
		// what makes a historical link survive a hard kill: it is derived
		// from the order rows, not stored beside them.
		position := self.positionNow()
		asked := self.anyoneCouldOrder()
		review := self.beginReview(nmr[phase])
		if err := self.state.Next(); err != nil {
			return fmt.Errorf("phase %v adjudication: %v", phase, err)
		}
		self.endReview(review)
		if asked {
			self.previousPhase = review
		}
		self.recordWatch(phase, position, review)
		self.parts = map[godip.Province][]string{}
		self.owner = map[godip.Province]godip.Nation{}
	}
	return self.applyStored(history[currentPhase])
}

/*
applyStored re-enters one phase's orders.

Two kinds of row will not validate, and they want opposite treatment. A row
marked illegal was refused by the engine when the player entered it and was
kept anyway (D-029): it is put back exactly as it was, still outside the
engine, so the phase replays into the same board and the same review. Any
other row that fails is skipped with a warning rather than failing the whole
load — a game is more useful with one missing order than not at all — and the
warning is worth reading, because it means the row no longer matches the
board that the rest of the history builds.
*/
func (self *game) applyStored(orders []storedOrder) error {
	for _, o := range orders {
		if o.illegal {
			parts := orderParts(o.province, o.parts)
			// It still has to be an order. A row that no longer parses is
			// corrupt, not illegal, and there is nothing to reproduce.
			bits := append([]string{string(o.province)}, parts...)
			if _, err := self.variant.Parser.Parse(bits); err != nil {
				log.Printf("replay: dropping unparseable illegal order %v %v: %v",
					o.province, o.parts, err)
				continue
			}
			self.storeIllegal(o.province, parts, o.power)
			continue
		}
		if err := self.setOrderStrict(o.province, o.parts); err != nil {
			log.Printf("replay: skipping %v %v: %v", o.province, o.parts, err)
			continue
		}
		// Trust the stored power. In a retreat phase the unit has left
		// the board, so nationFor cannot work it out.
		self.owner[o.province] = o.power
	}
	return nil
}
