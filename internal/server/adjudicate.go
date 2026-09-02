// Resolving a phase and entering the next one.
//
// The turn advances by itself once every seat is in (ADR-008). A seat with
// nothing to order is locked by the server rather than waited on (ADR-034),
// which is what stops a build phase with no builds from stalling a table.

package server

import (
	"time"

	"github.com/zond/godip"
)

// maxAutoPhases bounds the run of phases the auto-lock may resolve on its
// own. Only a table where every remaining power is eliminated can produce an
// unbroken run, and that table would otherwise spin forever.
const maxAutoPhases = 8

// nothingToOrder reports whether a power has no legal order at all this
// phase. godip's option tree is nation-scoped, and it is fixed the moment
// the position resolved: an empty tree cannot fill in later in the phase.
func (self *game) nothingToOrder(power godip.Nation) bool {
	return len(self.state.Phase().Options(self.state, power)) == 0
}

// anyoneCouldOrder reports whether the phase now on the board asks any
// claimed seat for an order. A phase that asks nobody is one the table never
// saw, so its empty review must not displace the review of the phase the
// players did play (ADR-034). The public per-phase history keeps it either way.
func (self *game) anyoneCouldOrder() bool {
	// A sandbox has no claimed seat to ask (ADR-047), and the review is the
	// half of it that matters: a driver adjudicates to see what happened.
	// So the question there is whether the POSITION offers an order, which
	// is the same question with the seat layer taken off.
	if self.flow.settings.Sandbox {
		for _, p := range self.flow.powers {
			if !self.nothingToOrder(p) {
				return true
			}
		}
		return false
	}
	for _, s := range self.flow.seats {
		if s.claimed() && !self.nothingToOrder(s.power) {
			return true
		}
	}
	return false
}

// autoLock locks every claimed seat whose power has no legal order in
// the phase now on the board, and returns the powers it locked (ADR-034).
// The caller must hold g.mu.
func (self *game) autoLock() []godip.Nation {
	f := self.flow
	locked := []godip.Nation{}
	for _, p := range f.powers {
		s := f.seats[p]
		if !s.claimed() || s.autoLocked || !self.nothingToOrder(p) {
			continue
		}
		s.locked = true
		s.autoLocked = true
		locked = append(locked, p)
	}
	return locked
}

/*
enterPhase settles the phase now on the board: it auto-locks the seats with
nothing to order and, when that leaves the whole table in, adjudicates on.

The cascade is what keeps auto-lock inside the two existing resolution paths
(ADR-008, ADR-010) instead of adding a third. A phase nobody can order is not a
phase the GM should be asked to force — canForce reads the table as complete,
so without this the game would sit on a screen with no button that does
anything. The caller must hold g.mu.
*/
func (self *game) enterPhase(id string) error {
	f := self.flow
	for i := 0; i < maxAutoPhases; i++ {
		// A game that has ended has no phase to settle (ADR-044). Nothing is
		// auto-locked and nothing adjudicates on, or the board would run
		// past its own result.
		if f.over() {
			return nil
		}
		// A sandbox has no seat to lock, so ADR-034's rule is asked of the
		// position instead: a phase that offers nobody an order is one the
		// driver cannot act on, and leaving it on screen with a button that
		// does nothing but press itself is the dead end auto-lock exists to
		// avoid. An empty retreat phase is the ordinary case.
		if f.settings.Sandbox {
			if self.anyoneCouldOrder() {
				return nil
			}
			f.logEvent(id, "no power has an order to give this phase — adjudicating")
			if err := self.advance(id, false); err != nil {
				return err
			}
			continue
		}
		locked := self.autoLock()
		for _, p := range locked {
			f.logEvent(id, "%v has no order to give this phase — locked automatically", p)
		}
		active := f.activeSeats()
		if active == 0 || f.lockedCount() < active {
			if len(locked) > 0 {
				self.persist(id)
			}
			return nil
		}
		f.logEvent(id, "no power has an order to give this phase — adjudicating")
		if err := self.advance(id, false); err != nil {
			return err
		}
	}
	f.logEvent(id, "auto-lock stopped after %v phases with nothing to order", maxAutoPhases)
	return nil
}

// adjudicate resolves the phase and settles the one that follows it. With
// dropUnlocked set, powers that have not locked lose their orders and
// they submit no orders — an NMR (ADR-010). The caller must hold g.mu.
func (self *game) adjudicate(id string, dropUnlocked bool) error {
	if err := self.advance(id, dropUnlocked); err != nil {
		return err
	}
	return self.enterPhase(id)
}

// advance resolves the phase and puts the next one on the board, without
// auto-locking it. Only adjudicate and enterPhase may call it: every other
// caller wants the auto-lock that goes with a new phase.
func (self *game) advance(id string, dropUnlocked bool) error {
	f := self.flow
	// A proposal belongs to the position in which it was made. Once play
	// moves on, both its survivor list and the consent behind it are stale.
	if f.drawProposal != nil {
		f.logEvent(id, "draw proposal expired when the phase resolved")
		f.drawProposal = nil
	}

	// What is still on the clock as this phase resolves. When every power
	// locked early it is carried onto the next phase, so resolving early
	// never shortens the next turn for anybody (the anti-rush rule). A phase
	// the GM forced carries nothing: its clock had run out, or the GM chose
	// to spend it.
	carry := time.Duration(0)
	if !dropUnlocked {
		carry = f.remaining()
	}

	nmr := []string{}
	if dropUnlocked {
		for _, p := range f.powers {
			s := f.seats[p]
			if !s.claimed() {
				continue
			}
			// A sealed seat that locked and never revealed is an NMR too
			// (ADR-009): its orders exist, on a phone nobody can reach, and
			// the board has never seen them. An auto-locked seat was asked
			// for nothing and is not one.
			held := s.locked
			if f.sealed && !s.autoLocked {
				held = s.revealed
			}
			if held {
				continue
			}
			dropped := 0
			for prov := range self.parts {
				if self.owner[prov] == p {
					self.clearOrder(prov)
					dropped++
				}
			}
			nmr = append(nmr, string(p))
			f.logEvent(id, "NMR for %v — no readiness, %v draft order(s) dropped", p, dropped)
		}
		f.logEvent(id, "GM forced adjudication")
	} else if f.settings.Sandbox {
		f.logEvent(id, "the sandbox driver adjudicated")
	} else {
		f.logEvent(id, "every power locked — adjudicating")
	}

	// Freeze this phase's order rows as they will actually be applied,
	// NMR drops included. Replay reads them back exactly like this.
	self.persist(id)
	persistNMR(id, f.phaseIndex, nmr)

	// The position this phase was played from, for the public per-phase URL
	// (ADR-013). It is read before the board moves.
	position := self.positionNow()
	asked := self.anyoneCouldOrder()
	review := self.beginReview(self.flow.phaseIndex, nmr)
	if err := self.state.Next(); err != nil {
		return err
	}
	self.endReview(review)
	if asked {
		self.previousPhase = review
	}
	self.recordWatch(f.phaseIndex, position, review)
	self.parts = map[godip.Province][]string{}
	self.owner = map[godip.Province]godip.Nation{}
	// The marks belong to the orders that have just been spent (ADR-029).
	// Left standing they would strike a province in the next phase that
	// nobody has ordered yet.
	self.illegal = map[godip.Province]bool{}
	for _, s := range f.seats {
		s.locked = false
		s.autoLocked = false
	}
	f.clearCommits()
	f.phaseIndex++
	f.resetDeadline(self.state.Phase(), carry)
	f.logEvent(id, "phase is now %v %v %v, %v minute(s) of clock%v, deadline %v",
		self.state.Phase().Season(), self.state.Phase().Year(), self.state.Phase().Type(),
		f.phaseMinutes(self.state.Phase()),
		carryNote(carry), rfc3339(f.deadlineAt))
	// Whether that was the last phase (ADR-044). The board has already moved,
	// so the year that was played is the one the position was read at.
	self.checkEnd(id, position.phase.Year)
	self.persist(id)
	return nil
}
