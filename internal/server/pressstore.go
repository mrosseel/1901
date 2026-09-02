// Press, on disk.
//
// It is written row by row as it happens, like the NMR table and unlike the
// game row: a message is append-only and there is nothing to rewrite. Every
// function here is a no-op without a database, which is what lets the tests
// run the whole flow in memory.

package server

import (
	"log"
	"strings"
	"time"

	"github.com/zond/godip"
)

/*
persistPressThread writes a room and every wrapped key it holds, together.

Unlike a message, a half-written room is unusable rather than merely
incomplete: a member whose wrap did not land can never open it, and nothing
later will notice. So this one is a transaction and it returns its error,
which the handler turns into a refusal.
*/
func persistPressThread(id string, t *pressThread) error {
	if db == nil {
		return nil
	}
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`
        INSERT OR IGNORE INTO press_thread (game_id, thread_id, opened_by, members, opened_at)
        VALUES (?, ?, ?, ?, ?)`,
		id, t.id, t.openedBy, t.memberKey(), t.openedAt.UTC().Format(time.RFC3339Nano)); err != nil {
		return err
	}
	for holder, wrapped := range t.keys {
		if _, err := tx.Exec(`
            INSERT OR REPLACE INTO press_key (game_id, thread_id, power, wrapped)
            VALUES (?, ?, ?, ?)`, id, t.id, holder, wrapped); err != nil {
			return err
		}
	}
	return tx.Commit()
}

/*
persistPressMessage writes one message, and says whether it landed.

INSERT rather than INSERT OR REPLACE: a sequence that is already taken is a
bug somewhere above, and overwriting what a room already holds would destroy a
message rather than report the bug.
*/
func persistPressMessage(id, threadID string, m pressMessage) error {
	if db == nil {
		return nil
	}
	_, err := db.Exec(`
        INSERT INTO press_message
            (game_id, thread_id, seq, sender, phase_index, box, sig, at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		id, threadID, m.Seq, m.Sender, m.PhaseIndex, m.Box, m.Sig, m.At)
	if err != nil {
		log.Printf("game %v: PERSIST FAILED (press message): %v", id, err)
	}
	return err
}

func persistPressRead(id, threadID, holder string, seq int) {
	if db == nil {
		return
	}
	if _, err := db.Exec(`
        INSERT OR REPLACE INTO press_read (game_id, thread_id, power, last_seq)
        VALUES (?, ?, ?, ?)`, id, threadID, holder, seq); err != nil {
		log.Printf("game %v: PERSIST FAILED (press read): %v", id, err)
	}
}

// loadPress reads one game's rooms back. The caller holds no lock: this runs
// while the game is being built and before anybody can reach it.
func loadPress(id string, f *flow) error {
	rows, err := db.Query(`
        SELECT thread_id, opened_by, members, opened_at
        FROM press_thread WHERE game_id = ? ORDER BY rowid`, id)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var threadID, openedBy, members, openedAt string
		if err := rows.Scan(&threadID, &openedBy, &members, &openedAt); err != nil {
			return err
		}
		t := &pressThread{
			id:       threadID,
			openedBy: openedBy,
			keys:     map[string]string{},
			read:     map[string]int{},
		}
		for _, name := range strings.Split(members, ",") {
			if name != "" {
				t.members = append(t.members, godip.Nation(name))
			}
		}
		if at, err := time.Parse(time.RFC3339Nano, openedAt); err == nil {
			t.openedAt = at
		}
		f.press = append(f.press, t)
		f.pressByID[t.id] = t
	}
	if err := rows.Err(); err != nil {
		return err
	}
	if err := loadPressKeys(id, f); err != nil {
		return err
	}
	if err := loadPressMessages(id, f); err != nil {
		return err
	}
	return loadPressRead(id, f)
}

func loadPressKeys(id string, f *flow) error {
	rows, err := db.Query(
		`SELECT thread_id, power, wrapped FROM press_key WHERE game_id = ?`, id)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var threadID, holder, wrapped string
		if err := rows.Scan(&threadID, &holder, &wrapped); err != nil {
			return err
		}
		if t := f.pressByID[threadID]; t != nil {
			t.keys[holder] = wrapped
		}
	}
	return rows.Err()
}

func loadPressMessages(id string, f *flow) error {
	rows, err := db.Query(`
        SELECT thread_id, seq, sender, phase_index, box, sig, at
        FROM press_message WHERE game_id = ? ORDER BY thread_id, seq`, id)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var threadID string
		var m pressMessage
		if err := rows.Scan(&threadID, &m.Seq, &m.Sender, &m.PhaseIndex,
			&m.Box, &m.Sig, &m.At); err != nil {
			return err
		}
		if t := f.pressByID[threadID]; t != nil {
			t.messages = append(t.messages, m)
		}
	}
	return rows.Err()
}

func loadPressRead(id string, f *flow) error {
	rows, err := db.Query(
		`SELECT thread_id, power, last_seq FROM press_read WHERE game_id = ?`, id)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var threadID, holder string
		var seq int
		if err := rows.Scan(&threadID, &holder, &seq); err != nil {
			return err
		}
		if t := f.pressByID[threadID]; t != nil {
			t.read[holder] = seq
		}
	}
	return rows.Err()
}
