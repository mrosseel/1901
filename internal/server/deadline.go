// The clock: how long a phase gets, and how much of it is left.
//
// ADR-008, ADR-010, ADR-022; research/platforms.md, steal 8.
//
// A deadline is one number in the settings and three rules on top of it, all
// of them stolen from platforms that have run real games for years:
//
//   - a retreat or build phase runs at retreatBuildPercent of the movement
//     clock, because it is not a negotiation phase;
//   - the first movement phase gets firstTurnExtraMinutes on top, because
//     Spring 1901 is the one turn where everyone must talk to everyone;
//   - resolving early never shortens the next phase for anybody, which is
//     the anti-rush rule below.

package server

import (
	"fmt"
	"time"

	"github.com/zond/godip"
)

// phaseMinutes is how long the phase now on the board gets.
func (self *flow) phaseMinutes(phase godip.Phase) int {
	base := self.settings.DeadlineMinutes
	if base <= 0 {
		return 0
	}
	minutes := base
	switch phase.Type() {
	case godip.Retreat, godip.Adjustment:
		percent := self.settings.RetreatBuildPercent
		if percent <= 0 {
			percent = defaultRetreatBuildPercent
		}
		// Rounded up, so a short clock cannot round a phase away entirely.
		minutes = (base*percent + 99) / 100
		if minutes < 1 {
			minutes = 1
		}
	}
	// The first movement phase of the game, and only that one.
	if self.phaseIndex == 0 && phase.Type() == godip.Movement {
		minutes += self.settings.FirstTurnExtraMinutes
	}
	return minutes
}

/*
resetDeadline restarts the clock for the phase now on the board.

`carry` is the time that was still on the clock when the previous phase
resolved, and it is the anti-rush rule (Backstabbr's, copied exactly): with
period T and remaining R, if R < T the next deadline is R + T; otherwise it is
R. Both are at least T, so a table that locks early never costs the next
table its turn. A phase that ran its clock out carries nothing.
*/
func (self *flow) resetDeadline(phase godip.Phase, carry time.Duration) {
	minutes := self.phaseMinutes(phase)
	if minutes <= 0 {
		self.deadlineAt = nil
		return
	}
	period := time.Duration(minutes) * time.Minute
	length := period
	if carry > 0 {
		if carry < period {
			length = carry + period
		} else {
			length = carry
		}
	}
	at := time.Now().Add(length)
	self.deadlineAt = &at
}

// carryNote says, in the event log, that a phase resolved early and what the
// table got back for it.
func carryNote(carry time.Duration) string {
	if carry <= 0 {
		return ""
	}
	return fmt.Sprintf(" plus %v carried from an early finish (anti-rush)",
		carry.Round(time.Second))
}

// remaining is what is left on the clock, or zero when it has run out or
// there is no clock at all.
func (self *flow) remaining() time.Duration {
	if self.deadlineAt == nil {
		return 0
	}
	left := time.Until(*self.deadlineAt)
	if left < 0 {
		return 0
	}
	return left
}

// graceEndsAt is the moment the GM may force the phase: the deadline plus
// whatever grace the settings allow. The deadline the clock shows does not
// move, because a grace period that is announced is not a grace period.
func (self *flow) graceEndsAt() *time.Time {
	if self.deadlineAt == nil {
		return nil
	}
	if self.settings.GraceMinutes <= 0 {
		return self.deadlineAt
	}
	at := self.deadlineAt.Add(time.Duration(self.settings.GraceMinutes) * time.Minute)
	return &at
}

// serverNow is the clock the client should measure deadlines against.
// Phones at a table are not reliably in sync.
func serverNow() string {
	return time.Now().UTC().Format(time.RFC3339)
}

func rfc3339(t *time.Time) interface{} {
	if t == nil {
		return nil
	}
	return t.UTC().Format(time.RFC3339)
}
