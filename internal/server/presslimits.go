package server

import (
	"sort"
	"time"
)

// Quotas count stored envelope text and metadata, not plaintext. Existing
// games over the quota remain readable; new messages are refused. The game
// quota is split evenly between the seats and the game master, so one sender
// cannot silence the rest of the table.
const maxPressStoredBytes int64 = 16 << 20
const pressPageSize = 100
const pressBurst = 10
const pressRefill = 3 * time.Second

type pressRate struct {
	tokens float64
	at     time.Time
}

func (f *flow) takePressRate(holder string, now time.Time) bool {
	if f.pressRates == nil {
		f.pressRates = map[string]pressRate{}
	}
	rate, ok := f.pressRates[holder]
	if !ok {
		rate = pressRate{tokens: pressBurst, at: now}
	}
	rate.tokens += now.Sub(rate.at).Seconds() / pressRefill.Seconds()
	if rate.tokens > pressBurst {
		rate.tokens = pressBurst
	}
	rate.at = now
	accepted := rate.tokens >= 1
	if accepted {
		rate.tokens--
	}
	f.pressRates[holder] = rate
	return accepted
}

func messageBytes(m pressMessage) int64 {
	return int64(len(m.Box) + len(m.Sig) + len(m.Sender) + len(m.At) + 32)
}

func (f *flow) pressSenderQuota() int64 {
	return maxPressStoredBytes / int64(len(f.seats)+1)
}

// pressRoomFor says whether a sender may store n more bytes.
func (f *flow) pressRoomFor(sender string, n int64) bool {
	return f.pressBytes+n <= maxPressStoredBytes && f.pressSenderBytes[sender]+n <= f.pressSenderQuota()
}

func (f *flow) countPressBytes(sender string, n int64) {
	if f.pressSenderBytes == nil {
		f.pressSenderBytes = map[string]int64{}
	}
	f.pressBytes += n
	f.pressSenderBytes[sender] += n
}
func (t *pressThread) lastSeq() int {
	if len(t.messages) == 0 {
		return 0
	}
	return t.messages[len(t.messages)-1].Seq
}
func (t *pressThread) unreadFor(holder string) int {
	if t.unread != nil {
		return t.unread[holder]
	}
	n := 0
	for _, m := range t.messages {
		if m.Seq > t.read[holder] && m.Sender != holder {
			n++
		}
	}
	return n
}
func (t *pressThread) countUnread(holder string, seen int) (int, error) {
	if db != nil {
		var n int
		err := db.QueryRow(`SELECT COUNT(*) FROM press_message WHERE game_id=? AND thread_id=? AND seq>? AND sender<>?`, t.gameID, t.id, seen, holder).Scan(&n)
		return n, err
	}
	n := 0
	for _, m := range t.messages {
		if m.Seq > seen && m.Sender != holder {
			n++
		}
	}
	return n, nil
}
func (t *pressThread) rememberMessage(m pressMessage) {
	// Initialize counts before truncating the in-memory fallback.
	if t.unread == nil {
		t.unread = map[string]int{}
		for holder := range t.keys {
			for _, held := range t.messages {
				if held.Seq > t.read[holder] && held.Sender != holder {
					t.unread[holder]++
				}
			}
		}
	}
	for holder := range t.keys {
		if m.Sender != holder {
			t.unread[holder]++
		}
	}
	if db != nil {
		t.messages = []pressMessage{m}
	} else {
		t.messages = append(t.messages, m)
	}
}

// Missing since requests the latest page. before pages backward; an explicit
// since pages forward. All responses preserve the original signed sequence.
func (t *pressThread) messagePage(since, before int) ([]pressMessage, error) {
	descending := since < 0 || before > 0
	out := []pressMessage{}
	if db != nil {
		query := `SELECT seq,sender,phase_index,box,sig,at FROM press_message WHERE game_id=? AND thread_id=?`
		args := []any{t.gameID, t.id}
		if before > 0 {
			query += " AND seq<?"
			args = append(args, before)
		} else if since >= 0 {
			query += " AND seq>?"
			args = append(args, since)
		}
		if descending {
			query += " ORDER BY seq DESC"
		} else {
			query += " ORDER BY seq ASC"
		}
		query += " LIMIT ?"
		args = append(args, pressPageSize)
		rows, err := db.Query(query, args...)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		for rows.Next() {
			var m pressMessage
			if err := rows.Scan(&m.Seq, &m.Sender, &m.PhaseIndex, &m.Box, &m.Sig, &m.At); err != nil {
				return nil, err
			}
			out = append(out, m)
		}
		if err := rows.Err(); err != nil {
			return nil, err
		}
	} else {
		for _, m := range t.messages {
			if before > 0 && m.Seq >= before {
				continue
			}
			if before == 0 && since >= 0 && m.Seq <= since {
				continue
			}
			out = append(out, m)
		}
		if len(out) > pressPageSize {
			if descending {
				out = out[len(out)-pressPageSize:]
			} else {
				out = out[:pressPageSize]
			}
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Seq < out[j].Seq })
	return out, nil
}
