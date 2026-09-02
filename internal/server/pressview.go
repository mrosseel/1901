// Press on the wire: what a seat is told about its own rooms.
//
// Bodies are ciphertext and stay that way. What this adds is the part the
// server does know — who is in a room, how many messages it holds, how many
// of them this actor has not read.

package server

import (
	"sort"
)

type pressThreadJSON struct {
	ID       string   `json:"id"`
	Members  []string `json:"members"`
	OpenedBy string   `json:"openedBy"`
	OpenedAt string   `json:"openedAt"`
	// The room as its opener signed it (ADR-056). A reader checks the
	// signature against the signing key it pinned for that holder before it
	// opens anything, so these three travel with every room.
	OpenerBoxPub  string `json:"openerBoxPub,omitempty"`
	OpenerSignPub string `json:"openerSignPub,omitempty"`
	Sig           string `json:"sig,omitempty"`
	// Wraps is every holder's copy of the room key. A reader needs them all,
	// because the manifest names each one by its digest and a reader that saw
	// only its own could not recompute what was signed. They are ciphertext
	// to everybody but their own holder.
	Wraps map[string]string `json:"wraps,omitempty"`
	// Wrapped is this reader's own copy of the room key and nobody else's.
	Wrapped string `json:"wrapped"`
	// Notes marks the reader's own single-member room, which the panel pins.
	Notes    bool           `json:"notes"`
	Unread   int            `json:"unread"`
	LastSeq  int            `json:"lastSeq"`
	LastAt   string         `json:"lastAt"`
	Messages []pressMessage `json:"messages,omitempty"`
}

type pressStateJSON struct {
	Enabled bool `json:"enabled"`
	// Open says a message may be sent right now, and Reason says why not.
	Open   bool   `json:"open"`
	Reason string `json:"reason,omitempty"`
	/*
		Whether this power's own notepad takes writing. It is a different
		question from Open: the notepad survives the writing minute, a retreat
		phase and elimination (ADR-055), and it closes only when the game does.
	*/
	NotesOpen   bool   `json:"notesOpen"`
	NotesReason string `json:"notesReason,omitempty"`
	// SilenceAt is when the writing time starts, so the panel can count
	// down to it rather than only refuse afterwards.
	SilenceAt interface{}       `json:"silenceAt"`
	Mode      string            `json:"mode"`
	You       string            `json:"you"`
	GMReads   bool              `json:"gmReads"`
	Keys      map[string]string `json:"keys"`
	// Each published box key's signature, by holder (ADR-054).
	KeySigs map[string]string `json:"keySigs"`
	// SignKeys are the seats' Ed25519 public halves, so a reader can check
	// that a line really came from the power it names. A public key is not
	// a secret, and the server checking signatures instead would be the
	// server deciding who said what.
	SignKeys map[string]string `json:"signKeys"`
	// SignChains are the signed steps from an old seat key to a new one
	// (ADR-056), so a device that pinned the old one can follow a real
	// handover without asking the table to confirm it.
	SignChains []keyChain        `json:"signChains"`
	Eliminated []string          `json:"eliminated"`
	Threads    []pressThreadJSON `json:"threads"`
	Unread     int               `json:"unread"`
}

// pressView is the whole press state one actor may see: the rooms, this
// reader's wrapped key for each, and the public box keys it needs to open a
// new room. Message bodies come from the thread route, not from here.
func (self *game) pressView(actor pressActor) pressStateJSON {
	f := self.flow
	out := pressStateJSON{
		Enabled:    f.pressEnabled(),
		Mode:       f.settings.PressMode,
		You:        actor.holder,
		GMReads:    f.settings.GMReadsPress,
		Keys:       map[string]string{},
		KeySigs:    map[string]string{},
		SignKeys:   map[string]string{},
		SignChains: append([]keyChain{}, f.keyChains...),
		Eliminated: []string{},
		Threads:    []pressThreadJSON{},
		SilenceAt:  rfc3339(f.pressSilenceAt()),
	}
	if !out.Enabled {
		out.Reason = "this game carries no messages"
		return out
	}
	// Every power that has published a box key, so a room can be opened
	// with any of them. A public key is not a secret; what it protects is.
	for _, p := range f.powers {
		s := f.seats[p]
		if s == nil {
			continue
		}
		if s.boxPub != "" {
			out.Keys[string(p)] = s.boxPub
			out.KeySigs[string(p)] = s.boxSig
		}
		if s.signPub != "" {
			out.SignKeys[string(p)] = s.signPub
		}
	}
	if f.settings.GMReadsPress {
		if f.gmBoxPub != "" {
			out.Keys[gmHolder] = f.gmBoxPub
			out.KeySigs[gmHolder] = f.gmBoxSig
		}
		// The referee signs what it says with the key of ADR-048, so the
		// same public half that recovers a game also checks a ruling.
		if f.gmPublicKey != "" {
			out.SignKeys[gmHolder] = f.gmPublicKey
		}
	}
	if f.started {
		for p, gone := range self.eliminated() {
			if gone {
				out.Eliminated = append(out.Eliminated, string(p))
			}
		}
		sort.Strings(out.Eliminated)
	}
	// Whether anything at all may be said now, before a room is chosen. The
	// per-room answer comes from pressWritable at the moment of sending.
	out.Open, out.Reason = self.pressWritableNow(actor)
	out.NotesOpen, out.NotesReason = self.pressNotesWritable()

	for _, t := range f.press {
		if !f.actorReads(actor, t) {
			continue
		}
		out.Threads = append(out.Threads, t.summary(actor))
	}
	out.Unread = f.pressUnread(actor)
	return out
}

func (t *pressThread) summary(actor pressActor) pressThreadJSON {
	wraps := map[string]string{}
	for holder, wrapped := range t.keys {
		wraps[holder] = wrapped
	}
	row := pressThreadJSON{
		ID:            t.id,
		Members:       nations(t.members),
		OpenedBy:      t.openedBy,
		OpenedAt:      t.openedAt,
		OpenerBoxPub:  t.openerBoxPub,
		OpenerSignPub: t.openerSignPub,
		Sig:           t.manifestSig,
		Wraps:         wraps,
		Wrapped:       t.keys[actor.holder],
		Notes:         isNotes(actor, t.openedBy, t.members),
	}
	seen := t.read[actor.holder]
	for _, m := range t.messages {
		if m.Seq > seen && m.Sender != actor.holder {
			row.Unread++
		}
	}
	if n := len(t.messages); n > 0 {
		row.LastSeq = t.messages[n-1].Seq
		row.LastAt = t.messages[n-1].At
	}
	return row
}
