package app

import (
	"spring1901/spike/internal/variant"
	"testing"
	"time"

	"github.com/zond/godip"
	"github.com/zond/godip/variants/classical"
)

// testFlow is a started game's flow with the given settings, on classical.
func testFlow(t *testing.T, s settings) *flow {
	t.Helper()
	f, err := newFlow(s.normalised(), classical.ClassicalVariant)
	if err != nil {
		t.Fatal(err)
	}
	f.started = true
	return f
}

// phaseOf returns the phase the classical board is in after n adjudications
// of nothing, which is how a movement, a retreat and a build phase are got at
// without writing a fake phase.
func classicalPhase(t *testing.T, kind godip.PhaseType) godip.Phase {
	t.Helper()
	state, err := classical.ClassicalVariant.Start()
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 8; i++ {
		if state.Phase().Type() == kind {
			return state.Phase()
		}
		if err := state.Next(); err != nil {
			t.Fatal(err)
		}
	}
	t.Fatalf("classical never reached a %v phase", kind)
	return nil
}

func TestRetreatAndBuildPhasesRunAtTheirShareOfTheClock(t *testing.T) {
	f := testFlow(t, settings{DeadlineMinutes: 20, RetreatBuildPercent: 50})
	movement := classicalPhase(t, godip.Movement)
	adjustment := classicalPhase(t, godip.Adjustment)

	// The first movement phase, with no first-turn bonus set.
	if got := f.phaseMinutes(movement); got != 20 {
		t.Errorf("movement: got %v minutes, want 20", got)
	}
	if got := f.phaseMinutes(adjustment); got != 10 {
		t.Errorf("build at 50%%: got %v minutes, want 10", got)
	}

	f.settings.RetreatBuildPercent = 25
	if got := f.phaseMinutes(adjustment); got != 5 {
		t.Errorf("build at 25%%: got %v minutes, want 5", got)
	}

	// A share that would round a phase away leaves it a minute: a phase with
	// no clock at all is a phase nobody can order in.
	f.settings.DeadlineMinutes = 2
	f.settings.RetreatBuildPercent = 10
	if got := f.phaseMinutes(adjustment); got != 1 {
		t.Errorf("a very short build: got %v minutes, want 1", got)
	}

	// No clock at all stays no clock, whatever the percentage says.
	f.settings.DeadlineMinutes = 0
	if got := f.phaseMinutes(adjustment); got != 0 {
		t.Errorf("no deadline: got %v minutes, want 0", got)
	}
}

func TestTheFirstTurnGetsItsNegotiationBonus(t *testing.T) {
	// Spring 1901 is the one turn where everyone has to talk to everyone.
	f := testFlow(t, settings{DeadlineMinutes: 15, FirstTurnExtraMinutes: 10})
	movement := classicalPhase(t, godip.Movement)
	if got := f.phaseMinutes(movement); got != 25 {
		t.Errorf("Spring 1901: got %v minutes, want 25", got)
	}
	// And only that turn. phaseIndex counts completed adjudications.
	f.phaseIndex = 1
	if got := f.phaseMinutes(movement); got != 15 {
		t.Errorf("a later movement phase: got %v minutes, want 15", got)
	}
	// It is a movement-phase bonus, not a first-phase one.
	f.phaseIndex = 0
	if got := f.phaseMinutes(classicalPhase(t, godip.Adjustment)); got != 8 {
		t.Errorf("a build phase in the first turn: got %v minutes, want 8", got)
	}
}

func TestResolvingEarlyNeverShortensTheNextPhase(t *testing.T) {
	// Backstabbr's anti-rush rule, copied exactly: with period T and time R
	// still on the clock, the next deadline is R + T when R < T, and R when
	// R is already the longer of the two. Both are at least T.
	movement := classicalPhase(t, godip.Movement)
	f := testFlow(t, settings{DeadlineMinutes: 20})
	f.phaseIndex = 1 // no first-turn bonus in the arithmetic

	cases := []struct {
		name  string
		carry time.Duration
		want  time.Duration
	}{
		{"the clock ran out", 0, 20 * time.Minute},
		{"eight minutes left, under the period", 8 * time.Minute, 28 * time.Minute},
		{"thirty minutes left, over the period", 30 * time.Minute, 30 * time.Minute},
	}
	for _, one := range cases {
		f.resetDeadline(movement, one.carry)
		if f.deadlineAt == nil {
			t.Fatalf("%v: no deadline was set", one.name)
		}
		got := time.Until(*f.deadlineAt).Round(time.Second)
		if got < one.want-2*time.Second || got > one.want {
			t.Errorf("%v: next phase got %v, want %v", one.name, got, one.want)
		}
	}
}

func TestGracePeriodMovesTheForceButNotTheDeadline(t *testing.T) {
	// The deadline the clock shows does not move: a grace period that is
	// announced is not a grace period. What moves is the moment the GM may
	// force the phase.
	f := testFlow(t, settings{DeadlineMinutes: 20, GraceMinutes: 5})
	f.seats[f.powers[0]].token = "one"
	f.seats[f.powers[1]].token = "two"
	f.seats[f.powers[2]].token = "three"

	past := time.Now().Add(-time.Minute)
	f.deadlineAt = &past
	if f.canForce() {
		t.Error("the GM could force one minute past the deadline, inside the grace period")
	}
	if got := f.graceEndsAt().Sub(*f.deadlineAt); got != 5*time.Minute {
		t.Errorf("grace: got %v, want 5m", got)
	}

	longPast := time.Now().Add(-10 * time.Minute)
	f.deadlineAt = &longPast
	if !f.canForce() {
		t.Error("the GM could not force after the grace period had ended too")
	}

	// With no grace set, the deadline itself is the moment.
	f.settings.GraceMinutes = 0
	f.deadlineAt = &past
	if !f.canForce() {
		t.Error("with no grace period the deadline itself must arm the force")
	}
}

func TestAllButOneReadyDoesNotArmForceBeforeTheDeadline(t *testing.T) {
	f := testFlow(t, settings{DeadlineMinutes: 20})
	for i, power := range f.powers {
		f.seats[power].token = string(rune('a' + i))
		if i < len(f.powers)-1 {
			f.seats[power].locked = true
		}
	}
	future := time.Now().Add(15 * time.Minute)
	f.deadlineAt = &future
	if f.canForce() {
		t.Error("all but one ready armed force before the published deadline")
	}
}

func TestSettingsDefaultsAndPressModes(t *testing.T) {
	got := settings{}.normalised()
	if got.RetreatBuildPercent != 50 {
		t.Errorf("retreatBuildPercent default: got %v, want 50", got.RetreatBuildPercent)
	}
	if got.PressMode != "ftf" {
		t.Errorf("pressMode default: got %q, want ftf", got.PressMode)
	}
	if got.Variant != variant.DefaultKey {
		t.Errorf("variant default: got %q", got.Variant)
	}
	for _, mode := range []string{"ftf", "gunboat", "fullpress", "rulebook"} {
		if !pressModes[mode] {
			t.Errorf("%v is not an accepted press mode", mode)
		}
	}
	if pressModes["telepathy"] {
		t.Error("an unknown press mode was accepted")
	}
	// A share above a whole clock is a clock, not an error.
	if got := (settings{RetreatBuildPercent: 400}).normalised().RetreatBuildPercent; got != 100 {
		t.Errorf("got %v, want 100", got)
	}
}
