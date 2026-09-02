// A game's settings: what the GM chose, and what a patch may change.
//
// Every setting has a default, and normalised is what makes a settings value
// safe to act on: it is applied to whatever arrives, so a field nobody sent
// and a field somebody sent nonsense in end up the same way.

package server

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"unicode"

	"spring1901/spike/internal/variant"
)

// settings are the game rules the GM fixes before inviting (ADR-022).
//
// Everything but the variant may be changed later; every change bumps
// settingsVersion, lands in the event log and is broadcast to every seat.
type settings struct {
	DeadlineMinutes int    `json:"deadlineMinutes"`
	GMPlays         bool   `json:"gmPlays"`
	Variant         string `json:"variant"`

	// Name is what the table calls this game. Optional: an unnamed game is
	// identified by its id, as every game was before this field existed.
	// It names the table, never a person — nothing binds it to a seat, so
	// ADR-020's anonymity is untouched and every screen may show it.
	Name string `json:"name"`

	// RetreatBuildPercent is what share of the movement clock a retreat or
	// build phase gets. Backstabbr's default is 50, and it is right: those
	// phases are not negotiation phases. Nobody is talking, the orders are
	// forced or nearly so, and a table waiting the full clock for two
	// disbands is a table doing nothing.
	RetreatBuildPercent int `json:"retreatBuildPercent"`

	// GraceMinutes is how long after the deadline orders are still taken.
	// The deadline the clock shows is unchanged; what moves is the moment
	// the GM may force the phase. A player mid-sentence with the referee is
	// the ordinary case at a table, not an exception.
	GraceMinutes int `json:"graceMinutes"`

	// FirstTurnExtraMinutes is added to the first movement phase only.
	// Spring 1901 is the one turn where everybody has to talk to everybody,
	// and every platform that has run real games gives it longer.
	FirstTurnExtraMinutes int `json:"firstTurnExtraMinutes"`

	// IllegalMoves lets a player enter an order the engine refuses (ADR-029).
	// Bluffing by misordering is part of Diplomacy, so this is ON by
	// default, in every press mode. The order is stored and shown as
	// written; at adjudication it is left out of the engine's order set and
	// the phase's ordinary missing/invalid-order consequence applies.
	IllegalMoves bool `json:"illegalMoves"`

	// EndYear stops the game after the last phase of that year (ADR-044).
	// Zero means no end year, which is every game that plays to a solo or a
	// draw. A tournament round with a hard stop at 17:00 sets it, because a
	// board that runs past the round is a board with no result.
	EndYear int `json:"endYear"`

	// Sandbox is a board with no players (ADR-047): one person holds the
	// link, orders every power, and adjudicates. It is set when the game is
	// made and never after, because a game that grew a driver mid-phase
	// would be a game whose orders stopped being its players'.
	Sandbox bool `json:"sandbox"`

	// PressMode is how negotiation happens (ADR-023). Data only for now: no
	// behaviour is attached to it, and the app carries no messages in any
	// mode. Declaring it is the point — a gunboat table wants its rules
	// written down, and seat anonymity (ADR-020) is load-bearing there rather
	// than incidental.
	PressMode string `json:"pressMode"`

	// PressSilenceSeconds is the writing time at the end of a phase, when
	// press closes (ADR-055). WDC 4b2 gives a board one minute to write its
	// orders in silence and 4d makes the silence a rule with a sanction
	// behind it, so this is a rule the app keeps rather than announces.
	// Zero means the app never closes press before the deadline.
	PressSilenceSeconds int `json:"pressSilenceSeconds"`

	// GMReadsPress makes the game master a member of every room (ADR-054).
	// It is offered only when GMPlays is off, and normalised() holds it
	// there: the reason orders are sealed at all is that the person running
	// the server is usually at the board. A referee who does not play is a
	// different person, and the join page says which one this game has.
	GMReadsPress bool `json:"gmReadsPress"`
}

// The press modes a game may declare (ADR-023).
//
//   - ftf: negotiation is verbal at the table. The default.
//   - gunboat: no negotiation at all.
//   - fullpress: in-app messaging. Post-v1; the setting exists so the model
//     is established in data now.
//   - rulebook: press during movement phases, none during retreat and build.
//     webDiplomacy's fourth mode, and it says this is how face-to-face
//     Diplomacy is played (research/platforms.md, steal 7).
var pressModes = map[string]bool{
	"ftf":       true,
	"gunboat":   true,
	"fullpress": true,
	"rulebook":  true,
}

const defaultPressMode = "ftf"

// defaultRetreatBuildPercent is Backstabbr's: half the movement clock.
const defaultRetreatBuildPercent = 50

// defaultSettings is what a game gets when the GM says nothing at all.
//
// It exists because two of the defaults are not the zero value: the retreat
// clock is half the movement clock, and illegal orders are allowed (ADR-029).
// Building the defaults in one place is what keeps a caller from inventing a
// game that is strict because nobody said otherwise.
func defaultSettings() settings {
	return settings{
		Variant:             variant.DefaultKey,
		RetreatBuildPercent: defaultRetreatBuildPercent,
		PressMode:           defaultPressMode,
		PressSilenceSeconds: defaultPressSilenceSeconds,
		IllegalMoves:        true,
	}
}

// settingsEnvelope accepts both {"deadlineMinutes":..,"gmPlays":..} and
// the wrapped {"settings":{...}} shape.
// settingsPatch is a settings object where every field is optional. A GM who
// sends one setting changes one setting, and a setting nobody mentions keeps
// the value it had. That matters most for a boolean whose default is true:
// illegalMoves (ADR-029) must not turn itself off because a client left it out.
type settingsPatch struct {
	DeadlineMinutes       *int    `json:"deadlineMinutes"`
	GMPlays               *bool   `json:"gmPlays"`
	Variant               *string `json:"variant"`
	Name                  *string `json:"name"`
	RetreatBuildPercent   *int    `json:"retreatBuildPercent"`
	GraceMinutes          *int    `json:"graceMinutes"`
	FirstTurnExtraMinutes *int    `json:"firstTurnExtraMinutes"`
	EndYear               *int    `json:"endYear"`
	PressMode             *string `json:"pressMode"`
	PressSilenceSeconds   *int    `json:"pressSilenceSeconds"`
	GMReadsPress          *bool   `json:"gmReadsPress"`
	IllegalMoves          *bool   `json:"illegalMoves"`
	// Sandbox may be set when the game is made and never after (ADR-047),
	// so apply() below leaves it alone and only decodeCreateSettings reads
	// it. A game master posting settings at a running board cannot turn a
	// table into a sandbox, which would take every player's orders away.
	Sandbox *bool `json:"sandbox"`
}

func (self settingsPatch) apply(base settings) settings {
	if self.DeadlineMinutes != nil {
		base.DeadlineMinutes = *self.DeadlineMinutes
	}
	if self.GMPlays != nil {
		base.GMPlays = *self.GMPlays
	}
	if self.Variant != nil {
		base.Variant = *self.Variant
	}
	if self.Name != nil {
		base.Name = *self.Name
	}
	if self.RetreatBuildPercent != nil {
		base.RetreatBuildPercent = *self.RetreatBuildPercent
	}
	if self.GraceMinutes != nil {
		base.GraceMinutes = *self.GraceMinutes
	}
	if self.FirstTurnExtraMinutes != nil {
		base.FirstTurnExtraMinutes = *self.FirstTurnExtraMinutes
	}
	if self.EndYear != nil {
		base.EndYear = *self.EndYear
	}
	if self.PressMode != nil {
		base.PressMode = *self.PressMode
	}
	if self.PressSilenceSeconds != nil {
		base.PressSilenceSeconds = *self.PressSilenceSeconds
	}
	if self.GMReadsPress != nil {
		base.GMReadsPress = *self.GMReadsPress
	}
	if self.IllegalMoves != nil {
		base.IllegalMoves = *self.IllegalMoves
	}
	return base
}

// settingsEnvelope accepts a bare {"deadlineMinutes":…} body and the wrapped
// {"settings":{…}} shape, and both are patches.
type settingsEnvelope struct {
	Settings *settingsPatch `json:"settings"`
	settingsPatch
}

// sandboxAsked reads the create-only flag out of either shape of the body.
func (self settingsEnvelope) sandboxAsked() bool {
	if self.Settings != nil && self.Settings.Sandbox != nil {
		return *self.Settings.Sandbox
	}
	return self.settingsPatch.Sandbox != nil && *self.settingsPatch.Sandbox
}

// merge applies the envelope on top of the given settings.
func (self settingsEnvelope) merge(base settings) settings {
	if self.Settings != nil {
		base = self.Settings.apply(base)
	}
	return self.settingsPatch.apply(base).normalised()
}

// normalised fills in the defaults and refuses the impossible. A negative
// clock is zero — no deadline — and a retreat clock of nought per cent would
// be a phase that is over before it starts.
func (self settings) normalised() settings {
	if self.DeadlineMinutes < 0 {
		self.DeadlineMinutes = 0
	}
	if self.GraceMinutes < 0 {
		self.GraceMinutes = 0
	}
	if self.FirstTurnExtraMinutes < 0 {
		self.FirstTurnExtraMinutes = 0
	}
	// A year before the game starts, or a negative one, is no end year at
	// all. Lowering it below the year on the board is allowed and fires at
	// the next adjudication, which is what a game master shortening a round
	// that has overrun is asking for.
	if self.EndYear < 0 {
		self.EndYear = 0
	}
	if self.RetreatBuildPercent <= 0 {
		self.RetreatBuildPercent = defaultRetreatBuildPercent
	}
	if self.RetreatBuildPercent > 100 {
		self.RetreatBuildPercent = 100
	}
	if self.Variant == "" {
		self.Variant = variant.DefaultKey
	}
	if self.PressMode == "" {
		self.PressMode = defaultPressMode
	}
	if self.PressSilenceSeconds < 0 {
		self.PressSilenceSeconds = 0
	}
	if self.PressSilenceSeconds > maxPressSilenceSeconds {
		self.PressSilenceSeconds = maxPressSilenceSeconds
	}
	// The pairing of ADR-054, held here rather than at the form, so a row
	// loaded from the database says the same thing the form would have.
	if self.GMPlays {
		self.GMReadsPress = false
	}
	// A sandbox has nobody to keep waiting and nobody to hand a seat to
	// (ADR-047), so the three settings that only mean something to a table
	// are held at nothing. Doing it here rather than at creation is what
	// makes a row loaded from the database say the same thing.
	if self.Sandbox {
		self.GMPlays = false
		self.DeadlineMinutes = 0
		self.GraceMinutes = 0
		self.FirstTurnExtraMinutes = 0
	}
	self.Name = tidyName(self.Name)
	return self
}

// maxNameRunes caps the game name. It is a line on a list and a heading on a
// page, not a paragraph, and the cap is what keeps it one.
const maxNameRunes = 60

// tidyName folds every run of whitespace to one space, trims the ends, and
// cuts the result to maxNameRunes. Control characters go: the name is drawn
// as one line, in a list beside other names.
func tidyName(name string) string {
	clean := strings.Map(func(r rune) rune {
		if r == '\t' || r == '\n' || r == '\r' {
			return ' '
		}
		if unicode.IsControl(r) {
			return -1
		}
		return r
	}, name)
	clean = strings.Join(strings.Fields(clean), " ")
	runes := []rune(clean)
	if len(runes) > maxNameRunes {
		clean = strings.TrimSpace(string(runes[:maxNameRunes]))
	}
	return clean
}

func decodeSettings(r *http.Request, base settings) (settings, error) {
	env := settingsEnvelope{}
	if r.Body == nil {
		return base, nil
	}
	if err := json.NewDecoder(r.Body).Decode(&env); err != nil {
		return base, err
	}
	neu := env.merge(base)
	if !pressModes[neu.PressMode] {
		return base, fmt.Errorf("unknown press mode %q: it is one of ftf, gunboat, fullpress, rulebook",
			neu.PressMode)
	}
	return neu, nil
}

/*
decodeCreateSettings reads a creation body.

It is decodeSettings plus the one field that may only be set here: the sandbox
flag (ADR-047). Everything else about a game may be changed later and is
answered by the game master's settings route; a board with no players cannot
become a board with players, or the other way round, without the orders on it
changing hands.
*/
func decodeCreateSettings(r *http.Request) (settings, error) {
	base := defaultSettings()
	env := settingsEnvelope{}
	if r.Body != nil {
		if err := json.NewDecoder(r.Body).Decode(&env); err != nil {
			return base, err
		}
	}
	neu := env.merge(base)
	if !pressModes[neu.PressMode] {
		return base, fmt.Errorf("unknown press mode %q: it is one of ftf, gunboat, fullpress, rulebook",
			neu.PressMode)
	}
	neu.Sandbox = env.sandboxAsked()
	/*
		The referee's mailbox is opened with the game master's key (ADR-048,
		ADR-054), and that key is made after the game exists, on the referee
		screen. So a game cannot be created with the setting already on: there is
		nothing yet for a room key to be wrapped for, and the setting is fixed
		from the start (handleGMSettings), which would leave every room in the
		game refused with no way back.
	*/
	neu.GMReadsPress = false
	// normalised has already run inside merge, and the flag arrives after
	// it, so the settings a sandbox holds at nothing are cleared here.
	return neu.normalised(), nil
}
