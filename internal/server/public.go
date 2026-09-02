// The public board: what anybody with the address may read.
//
// It carries the position and the phase, and no seat's orders. This is the
// answer behind the spectator screen and the per-phase watch URLs (ADR-028).

package server

import (
	"net/http"

	"spring1901/spike/internal/assets"
	"spring1901/spike/internal/httpx"
	"spring1901/spike/internal/variant"
)

type publicStateJSON struct {
	GameID          string                 `json:"gameId"`
	Phase           phaseJSON              `json:"phase"`
	Started         bool                   `json:"started"`
	JoinedCount     int                    `json:"joinedCount"`
	TotalSeats      int                    `json:"totalSeats"`
	Locked          map[string]bool        `json:"locked"`
	Settings        settings               `json:"settings"`
	SettingsVersion int                    `json:"settingsVersion"`
	DeadlineAt      interface{}            `json:"deadlineAt"`
	GraceUntil      interface{}            `json:"graceUntil"`
	PhaseMinutes    int                    `json:"phaseMinutes"`
	Variant         variant.RefJSON        `json:"variant"`
	ProvinceNames   map[string]string      `json:"provinceNames"`
	Placements      variant.PlacementTable `json:"placements"`
	Labels          *variant.LabelPlan     `json:"labels,omitempty"`
	Dislodged       map[string]unitJSON    `json:"dislodged"`
	PreviousPhase   *phaseReviewJSON       `json:"previousPhase"`
	// Result is how the game ended, null while it runs (ADR-044).
	Result       *gameResult   `json:"result"`
	DrawProposal *drawProposal `json:"drawProposal,omitempty"`
	// Sealed and RevealOpen say how this game takes orders and whether the
	// phones should be sending theirs (ADR-004). Both are counts of nobody:
	// a seat's own orders are not here and never were.
	Sealed     bool   `json:"sealed"`
	RevealOpen bool   `json:"revealOpen"`
	Now        string `json:"now"`
	// Which client build this server is serving (ADR-050). Every page polls
	// this answer, so this is where a stale tab finds out.
	Build string `json:"build"`
}

func handlePublic(g *game, id string, w http.ResponseWriter, r *http.Request) {
	g.mu.Lock()
	defer g.mu.Unlock()
	f := g.flow
	httpx.WriteJSON(w, http.StatusOK, publicStateJSON{
		GameID: id,
		Build:  assets.BuildStamp(),
		Phase: phaseJSON{
			Season: string(g.state.Phase().Season()),
			Year:   g.state.Phase().Year(),
			Type:   string(g.state.Phase().Type()),
		},
		Started:         f.started,
		JoinedCount:     f.joinedCount(),
		TotalSeats:      f.joinerSeats(),
		Locked:          f.lockedMap(),
		Settings:        f.settings,
		SettingsVersion: f.settingsVersion,
		DeadlineAt:      rfc3339(f.deadlineAt),
		GraceUntil:      rfc3339(f.graceEndsAt()),
		PhaseMinutes:    f.phaseMinutes(g.state.Phase()),
		Variant:         g.variantRef(),
		ProvinceNames:   g.provinceNames(),
		Placements:      g.placements(),
		Labels:          g.labels(),
		Dislodged:       g.dislodgedMap(),
		PreviousPhase:   g.previousPhase,
		Result:          f.result,
		DrawProposal:    f.drawProposal,
		Sealed:          f.sealed,
		RevealOpen:      f.revealOpen(),
		Now:             serverNow(),
	})
}
