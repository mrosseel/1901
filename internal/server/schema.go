// The tables, and how an older database is brought up to them.
//
// A game master's database is a file they already have. Columns are added
// and renamed in place rather than recreated, because the alternative is
// telling somebody their table's games are gone.

package server

import (
	"database/sql"
	"log"

	"spring1901/spike/internal/variant"
)

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
    -- The deadline settings of ADR-022, each with the default a game gets
    -- when nobody sets it, so an older row loads as the game it was.
    retreat_build_percent    INTEGER NOT NULL DEFAULT 50,
    grace_minutes            INTEGER NOT NULL DEFAULT 0,
    first_turn_extra_minutes INTEGER NOT NULL DEFAULT 0,
    press_mode               TEXT    NOT NULL DEFAULT 'ftf',
    -- ADR-029, and the default is ON: a game written before the setting
    -- existed is one where nobody was ever refused a misorder.
    illegal_moves            INTEGER NOT NULL DEFAULT 1,
    -- What the table calls this game. Empty is the ordinary case and means
    -- the game is known by its id, which is what every game did before.
    name                     TEXT    NOT NULL DEFAULT '',
    -- A board with no players (ADR-047), and the one token that drives it.
    -- Both are fixed when the game is made: a game cannot grow a driver or
    -- lose one, so nothing writes either of them twice.
    sandbox                  INTEGER NOT NULL DEFAULT 0,
    sandbox_token            TEXT    NOT NULL DEFAULT ''
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
    -- An order the engine refuses, kept as the player wrote it (ADR-029).
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

-- Press (ADR-053). One row per room, one wrapped room key per holder, one
-- row per message. The server stores ciphertext, a member list and a time;
-- it holds no key to any of it, which is the point (ADR-054).
CREATE TABLE IF NOT EXISTS press_thread (
    game_id   TEXT NOT NULL REFERENCES game(id) ON DELETE CASCADE,
    thread_id TEXT NOT NULL,
    -- A power's name, or '*gm' for the game master.
    opened_by TEXT NOT NULL,
    -- The powers in the room, sorted and comma-joined. Two rooms with the
    -- same members are the same room, and this is the comparison.
    members   TEXT NOT NULL,
    opened_at TEXT NOT NULL,
    -- The room as its opener signed it (ADR-056): their press key, their
    -- signing key at the time, and the signature over the whole room. Empty
    -- on a room opened before manifests existed, which reads as unverifiable
    -- rather than as trustworthy.
    opener_box_pub  TEXT NOT NULL DEFAULT '',
    opener_sign_pub TEXT NOT NULL DEFAULT '',
    manifest_sig    TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (game_id, thread_id)
);

CREATE TABLE IF NOT EXISTS press_key (
    game_id   TEXT NOT NULL REFERENCES game(id) ON DELETE CASCADE,
    thread_id TEXT NOT NULL,
    -- The holder: a power's name, or '*gm'.
    power     TEXT NOT NULL,
    wrapped   TEXT NOT NULL,
    PRIMARY KEY (game_id, thread_id, power)
);

CREATE TABLE IF NOT EXISTS press_message (
    game_id     TEXT    NOT NULL REFERENCES game(id) ON DELETE CASCADE,
    thread_id   TEXT    NOT NULL,
    seq         INTEGER NOT NULL,
    sender      TEXT    NOT NULL,
    phase_index INTEGER NOT NULL,
    box         TEXT    NOT NULL,
    sig         TEXT    NOT NULL,
    at          TEXT    NOT NULL,
    PRIMARY KEY (game_id, thread_id, seq)
);

CREATE TABLE IF NOT EXISTS press_read (
    game_id   TEXT    NOT NULL REFERENCES game(id) ON DELETE CASCADE,
    thread_id TEXT    NOT NULL,
    power     TEXT    NOT NULL,
    last_seq  INTEGER NOT NULL,
    PRIMARY KEY (game_id, thread_id, power)
);

-- Secrets that belong to the server rather than to a game. One row today:
-- the salt every handover link is signed with (ADR-041). It lives here so a
-- QR code on a table outlives the process that printed it.
CREATE TABLE IF NOT EXISTS server_secret (
    name  TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
`

// gameColumns are the columns a game row has grown since the first schema,
// each with the definition an older database is missing. A row written before
// a setting existed loads as the game it was: a classical game with no press
// mode declared and Backstabbr's retreat clock.
var gameColumns = []struct{ name, definition string }{
	{"variant", `TEXT NOT NULL DEFAULT '` + variant.DefaultKey + `'`},
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
	// The handover counter for the game master role (ADR-041). A game from
	// before role handovers starts at zero, which is what its links carry.
	{"gm_epoch", `INTEGER NOT NULL DEFAULT 0`},
	// The public half of the game master's key (ADR-048), base64url. Empty
	// for every game made before keys existed and every one whose game
	// master declined to make one; such a game has no recovery.
	{"gm_public_key", `TEXT NOT NULL DEFAULT ''`},
	// The end year, and how the game ended (ADR-044). A game written before
	// endings existed has no end year and no result, which is what every
	// running game has.
	{"end_year", `INTEGER NOT NULL DEFAULT 0`},
	{"result_kind", `TEXT NOT NULL DEFAULT ''`},
	{"result_powers", `TEXT NOT NULL DEFAULT ''`},
	{"result_year", `INTEGER NOT NULL DEFAULT 0`},
	{"result_phase", `INTEGER NOT NULL DEFAULT 0`},
	// The pending proposal and its consent trail (ADR-052).
	{"draw_powers", `TEXT NOT NULL DEFAULT ''`},
	{"draw_required", `TEXT NOT NULL DEFAULT ''`},
	{"draw_confirmed", `TEXT NOT NULL DEFAULT ''`},
	// Whether this game keeps its orders on the phones (ADR-004). The default
	// is 0 and it is deliberate: every game written before commit-reveal
	// existed keeps writing its drafts to the server, because migrating a
	// game that is mid-phase at a table would lose the orders on the table.
	{"sealed", `INTEGER NOT NULL DEFAULT 0`},
	// A board with no players, and the token that drives it (ADR-047). The
	// default is 0 and an empty token: every game written before sandboxes
	// existed was played by people, which is what a sandbox is not.
	{"sandbox", `INTEGER NOT NULL DEFAULT 0`},
	{"sandbox_token", `TEXT NOT NULL DEFAULT ''`},
	// The press rules (ADR-053, ADR-055) and the referee's key (ADR-054). A
	// game written before press existed carries no messages whatever these
	// say, because its press mode is ftf or gunboat.
	{"press_silence_seconds", `INTEGER NOT NULL DEFAULT 60`},
	{"gm_reads_press", `INTEGER NOT NULL DEFAULT 0`},
	{"gm_box_pub", `TEXT NOT NULL DEFAULT ''`},
	{"gm_box_sig", `TEXT NOT NULL DEFAULT ''`},
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
	// The handover counter (ADR-041). A game from before handovers existed
	// starts every seat at zero, which is the epoch its links would carry.
	{"epoch", `INTEGER NOT NULL DEFAULT 0`},
	// The public half of the seat's key (ADR-049). Empty on every seat that
	// holds a token instead, which is every seat of every game made before
	// keys existed.
	{"sign_pub", `TEXT NOT NULL DEFAULT ''`},
	// The envelope this seat locked in, and whether the key to it has been
	// sent (ADR-004). Both are per phase and both are cleared by every
	// adjudication, so an older database starts every seat empty, which is
	// what a seat that has not locked in looks like.
	{"sealed_orders", `TEXT NOT NULL DEFAULT ''`},
	{"revealed", `INTEGER NOT NULL DEFAULT 0`},
	// The public half of this seat's press key (ADR-054). Empty on every
	// seat that has never opened the press panel.
	{"box_pub", `TEXT NOT NULL DEFAULT ''`},
	{"box_sig", `TEXT NOT NULL DEFAULT ''`},
}

// pressThreadColumns are the columns a room row has grown, in the same shape
// as gameColumns. A room written before ADR-056 has none of them, and a reader
// shows it as a room it cannot check rather than opening it.
var pressThreadColumns = []struct{ name, definition string }{
	{"opener_box_pub", `TEXT NOT NULL DEFAULT ''`},
	{"opener_sign_pub", `TEXT NOT NULL DEFAULT ''`},
	{"manifest_sig", `TEXT NOT NULL DEFAULT ''`},
}

// renamedColumns are columns that changed name. The rename must run before
// addColumns, or a database holding only the old name would gain an empty
// column under the new one and lose what it stored.
var renamedColumns = []struct{ table, from, to string }{
	// "finalize" was the word for this act until 2026-08-30; see CONTEXT.md.
	{"seat", "finalized", "locked"},
	// The commitment was a digest for one afternoon and is an envelope
	// (ADR-004). No database outside this repository ever held the old
	// column, and the rename is here so the ones inside it carry across.
	{"seat", "commit_hash", "sealed_orders"},
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
	if err := addColumns(handle, "press_thread", pressThreadColumns); err != nil {
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
