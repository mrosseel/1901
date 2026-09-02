// Writing a game down.
//
// The game row is rewritten whole; the orders and the missed turns are
// appended. Both happen while the caller holds the game lock, so what is on
// disk is what the last answer said.

package server

import (
	"encoding/json"
	"fmt"
	"log"
	"strings"
	"time"

	"spring1901/spike/internal/variant"
)

// persist writes the whole game — its settings, seats, current-phase
// orders, and any unwritten events — in one transaction. The caller must
// hold g.mu. Completed phases' order rows are history and never rewritten.
func (self *game) persist(id string) {
	// Orders in an old, unsealed game are persisted too, but editing a private
	// draft is not a public event and must not wake (or disclose activity to)
	// the whole table. User-visible mutations already append an event-log line,
	// so that boundary selects joins, locks, reveals, adjudication, draw votes,
	// settings, handovers and results without a second list of call sites.
	notify := self.flow != nil && len(self.flow.events) > self.notifiedEvents
	if self.flow != nil {
		self.notifiedEvents = len(self.flow.events)
	}
	if notify {
		// The in-memory mutation is authoritative even if SQLite later refuses
		// the write, so connected clients still need to read it.
		defer self.events.publish()
	}
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
	// How the game ended, flattened (ADR-044). The centre counts are not
	// stored: they are the position the board is restored to, so reading
	// them back would be storing the same fact twice.
	resultKind, resultPowers := "", ""
	resultYear, resultPhase := 0, 0
	if f.result != nil {
		resultKind = f.result.Kind
		resultPowers = strings.Join(f.result.Powers, ",")
		resultYear = f.result.Year
		resultPhase = f.result.PhaseIndex
	}
	drawPowers, drawRequired, drawConfirmed := "", "", ""
	if f.drawProposal != nil {
		drawPowers = strings.Join(f.drawProposal.Powers, ",")
		drawRequired = strings.Join(f.drawProposal.Required, ",")
		drawConfirmed = strings.Join(f.drawProposal.Confirmed, ",")
	}
	_, err = tx.Exec(`
        INSERT INTO game (id, gm_token, invite_token, gm_device, deadline_minutes, gm_plays,
                          settings_version, started, deadline_at, gm_power,
                          phase_index, created_at, variant,
                          retreat_build_percent, grace_minutes,
                          first_turn_extra_minutes, press_mode, illegal_moves,
                          variant_hash, name, gm_epoch, gm_public_key,
                          end_year, result_kind, result_powers, result_year, result_phase,
                          sealed, draw_powers, draw_required, draw_confirmed,
                          sandbox, sandbox_token,
                          press_silence_seconds, gm_reads_press, gm_box_pub, gm_box_sig)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            -- The role can be handed on (ADR-041), which rotates the token, so
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
            -- Write-once in the handler (ADR-048), so this only ever writes
            -- the key the game already had or the first one it is given.
            gm_public_key            = excluded.gm_public_key,
            end_year                 = excluded.end_year,
            -- A result is written once and never unwritten (ADR-044): the game
            -- is frozen from the moment it has one, so nothing can produce a
            -- second.
            result_kind              = excluded.result_kind,
            result_powers            = excluded.result_powers,
            result_year              = excluded.result_year,
            result_phase             = excluded.result_phase,
            -- Fixed when the game is made and written back unchanged, so a
            -- game cannot become sealed or unsealed under a table.
            sealed                   = excluded.sealed,
			draw_powers              = excluded.draw_powers,
			draw_required            = excluded.draw_required,
			draw_confirmed           = excluded.draw_confirmed,
            -- Fixed when the game is made, like sealed above and for the
            -- same reason: a table cannot become a sandbox under its players.
            sandbox                  = excluded.sandbox,
            sandbox_token            = excluded.sandbox_token,
            press_silence_seconds    = excluded.press_silence_seconds,
            -- Fixed at start, like gmPlays and the press mode: every room
            -- key already handed out was wrapped for the holders this names.
            gm_reads_press           = excluded.gm_reads_press,
            gm_box_pub               = excluded.gm_box_pub,
            gm_box_sig               = excluded.gm_box_sig`,
		id, f.gmToken, f.inviteToken, f.gmDevice, f.settings.DeadlineMinutes, f.settings.GMPlays,
		f.settingsVersion, f.started, deadline, string(f.gmPower),
		f.phaseIndex, f.createdAt.UTC().Format(time.RFC3339Nano), self.variantKey,
		f.settings.RetreatBuildPercent, f.settings.GraceMinutes,
		f.settings.FirstTurnExtraMinutes, f.settings.PressMode, f.settings.IllegalMoves,
		variant.Hash(self.variantKey), f.settings.Name, f.gmEpoch, f.gmPublicKey,
		f.settings.EndYear, resultKind, resultPowers, resultYear, resultPhase, f.sealed,
		drawPowers, drawRequired, drawConfirmed, f.settings.Sandbox, f.sandboxToken,
		f.settings.PressSilenceSeconds, f.settings.GMReadsPress, f.gmBoxPub, f.gmBoxSig)
	if err != nil {
		return fmt.Errorf("game row: %v", err)
	}

	for _, p := range f.powers {
		s := f.seats[p]
		_, err = tx.Exec(`
            INSERT INTO seat (game_id, power, seat_token, device, is_gm, locked, epoch,
                              sign_pub, sealed_orders, sealed_sig, revealed, box_pub, box_sig)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(game_id, power) DO UPDATE SET
                seat_token = excluded.seat_token,
                device     = excluded.device,
                is_gm      = excluded.is_gm,
                locked  = excluded.locked,
                epoch      = excluded.epoch,
                sign_pub   = excluded.sign_pub,
                sealed_orders = excluded.sealed_orders,
                sealed_sig = excluded.sealed_sig,
                revealed    = excluded.revealed,
                box_pub     = excluded.box_pub,
                box_sig     = excluded.box_sig`,
			id, string(p), s.token, s.device, s.isGM, s.locked, s.epoch, s.signPub,
			s.sealed, s.sealedSig, s.revealed, s.boxPub, s.boxSig)
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
