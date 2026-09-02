// Reading the games back at startup.
//
// A saved game is not a saved board: it is the variant it was played on and
// every order it has ever had. The board is rebuilt by replaying them, which
// is why a descriptor that changed under a game makes that game unloadable
// rather than wrong.

package server

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"log"
	"strings"
	"time"

	"github.com/zond/godip"
	"github.com/zond/godip/variants/common"

	"spring1901/spike/internal/variant"
)

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
               COALESCE(name, ''), COALESCE(gm_epoch, 0), COALESCE(gm_public_key, ''),
               COALESCE(end_year, 0), COALESCE(result_kind, ''),
               COALESCE(result_powers, ''), COALESCE(result_year, 0),
               COALESCE(result_phase, 0), COALESCE(sealed, 0),
			   COALESCE(draw_powers, ''), COALESCE(draw_required, ''),
			   COALESCE(draw_confirmed, ''),
			   COALESCE(sandbox, 0), COALESCE(sandbox_token, ''),
			   COALESCE(press_silence_seconds, ?), COALESCE(gm_reads_press, 0),
			   COALESCE(gm_box_pub, ''), COALESCE(gm_box_sig, '')
        FROM game`, variant.DefaultKey, defaultPressMode, defaultPressSilenceSeconds)
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
			pressByID:   map[string]*pressThread{},
			commitments: map[int]map[string]commitment{},
		}
		var id, gmPower, createdAt, key, recordedHash string
		var deadline sql.NullString
		var phaseIndex int
		var resultKind, resultPowers string
		var drawPowers, drawRequired, drawConfirmed string
		var resultYear, resultPhase int
		if err := rows.Scan(&id, &f.gmToken, &f.inviteToken, &f.gmDevice, &f.settings.DeadlineMinutes,
			&f.settings.GMPlays, &f.settingsVersion, &f.started, &deadline, &gmPower,
			&phaseIndex, &createdAt, &key, &f.settings.RetreatBuildPercent,
			&f.settings.GraceMinutes, &f.settings.FirstTurnExtraMinutes,
			&f.settings.PressMode, &f.settings.IllegalMoves, &recordedHash,
			&f.settings.Name, &f.gmEpoch, &f.gmPublicKey,
			&f.settings.EndYear, &resultKind, &resultPowers, &resultYear,
			&resultPhase, &f.sealed, &drawPowers, &drawRequired, &drawConfirmed,
			&f.settings.Sandbox, &f.sandboxToken,
			&f.settings.PressSilenceSeconds, &f.settings.GMReadsPress,
			&f.gmBoxPub, &f.gmBoxSig); err != nil {
			rows.Close()
			return err
		}
		v, found := variant.Lookup(key)
		if !found {
			rows.Close()
			return fmt.Errorf("game %v names unknown variant %q", id, key)
		}
		// A game replays its whole order history against the variant's start
		// position. If a generated descriptor changed underneath it, that
		// replay lands on a board the players never saw.
		if err := variant.CheckHash(id, key, recordedHash); err != nil {
			rows.Close()
			return err
		}
		f.settings.Variant = key
		f.settings = f.settings.normalised()
		f.powers = variant.SortedNations(v)
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
		if resultKind != "" {
			powers := []string{}
			if resultPowers != "" {
				powers = strings.Split(resultPowers, ",")
			}
			// Centres are filled in by restore(), once the board they count
			// has been replayed.
			f.result = &gameResult{
				Kind:       resultKind,
				Powers:     powers,
				Year:       resultYear,
				PhaseIndex: resultPhase,
			}
		}
		if drawPowers != "" {
			f.drawProposal = &drawProposal{
				Powers:   strings.Split(drawPowers, ","),
				Required: strings.Split(drawRequired, ","),
			}
			if drawConfirmed != "" {
				f.drawProposal.Confirmed = strings.Split(drawConfirmed, ",")
			} else {
				f.drawProposal.Confirmed = []string{}
			}
		}
		loaded = append(loaded, row{id: id, f: f, key: key, variant: v})
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}

	for _, entry := range loaded {
		made, err := loadCommitments(entry.id)
		if err != nil {
			return fmt.Errorf("game %v commitments: %v", entry.id, err)
		}
		entry.f.commitments = made
		if err := loadPress(entry.id, entry.f); err != nil {
			return fmt.Errorf("game %v press: %v", entry.id, err)
		}
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
	// illegal marks a row the engine refused when it was entered (ADR-029).
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
                COALESCE(sign_pub, ''), COALESCE(sealed_orders, ''),
                COALESCE(sealed_sig, ''), COALESCE(revealed, 0),
                COALESCE(box_pub, ''), COALESCE(box_sig, '')
         FROM seat WHERE game_id = ?`, id)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var power, token, device, signPub, sealed, sealedSig, boxPub, boxSig string
		var isGM, locked, revealed bool
		var epoch int
		if err := rows.Scan(&power, &token, &device, &isGM, &locked, &epoch, &signPub,
			&sealed, &sealedSig, &revealed, &boxPub, &boxSig); err != nil {
			rows.Close()
			return nil, err
		}
		s, found := f.seats[godip.Nation(power)]
		if !found {
			continue
		}
		s.token, s.device, s.isGM, s.locked, s.epoch = token, device, isGM, locked, epoch
		s.signPub = signPub
		// A restart in the middle of a sealed phase brings the envelopes
		// back and no key to any of them (ADR-004). The phones hold the
		// keys, which is the property, and they send them again when the
		// window is open.
		s.sealed, s.sealedSig, s.revealed = sealed, sealedSig, revealed
		s.boxPub, s.boxSig = boxPub, boxSig
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
	g.notifiedEvents = len(f.events)
	if err := g.replay(history, nmr, f.phaseIndex); err != nil {
		return nil, err
	}
	// Recomputed rather than read back: autoLocked follows from the position
	// replay just rebuilt, and the event log already carries the lines from
	// when the phase began.
	g.autoLock()
	// The centre counts of a finished game are the position replay just
	// rebuilt, so they are counted here rather than read from a row
	// (ADR-044).
	if f.result != nil {
		f.result.Centres = g.centreCounts()
	}
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
		// public per-phase snapshot behind the /watch URLs (ADR-013). That is
		// what makes a historical link survive a hard kill: it is derived
		// from the order rows, not stored beside them.
		position := self.positionNow()
		asked := self.anyoneCouldOrder()
		review := self.beginReview(phase, nmr[phase])
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
		self.illegal = map[godip.Province]bool{}
	}
	return self.applyStored(history[currentPhase])
}

/*
applyStored re-enters one phase's orders.

Two kinds of row will not validate, and they want opposite treatment. A row
marked illegal was refused by the engine when the player entered it and was
kept anyway (ADR-029): it is put back exactly as it was, still outside the
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
