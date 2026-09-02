// Making a game, and listing the ones this server holds.
//
// The create response carries no GM secret: the referee is recognised by a
// cookie this server sets, and the list is public facts only (ADR-013,
// ADR-043).

package server

import (
	"errors"
	"net/http"
	"sort"
	"time"

	"spring1901/spike/internal/httpx"
	"spring1901/spike/internal/variant"
)

type createResponse struct {
	GameID    string          `json:"gameId"`
	InviteURL string          `json:"inviteUrl"`
	Variant   variant.RefJSON `json:"variant"`
	// SandboxURL is set only for a sandbox (ADR-047). There is no invite to
	// share and no seat to claim, so this one link is the whole handover.
	SandboxURL string `json:"sandboxUrl,omitempty"`
}

// The create response carries no GM secret on purpose. The creating browser
// gets the referee view through the cookie set below, and the GM token
// itself reaches only two places: the GM pages behind /game/{id}/gm/, and
// the seat state of the GM's own power once the game has started.
func handleCreateGame(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		httpx.WriteErr(w, http.StatusMethodNotAllowed, "POST only")
		return
	}
	s, err := decodeCreateSettings(r)
	if err != nil {
		httpx.WriteErr(w, http.StatusBadRequest, "bad body: %v", err)
		return
	}
	v, found := variant.Lookup(s.Variant)
	if !found {
		httpx.WriteErr(w, http.StatusBadRequest, "unknown variant %q", s.Variant)
		return
	}
	f, err := newFlow(s, v)
	if err != nil {
		httpx.WriteErr(w, http.StatusInternalServerError, "tokens: %v", err)
		return
	}
	g, id, err := games.create(s.Variant, v, f)
	if err != nil {
		if errors.Is(err, errGameLimit) {
			httpx.WriteErr(w, http.StatusServiceUnavailable,
				"the server holds its maximum of %v game(s) — raise MAX_GAMES to make room", games.limit)
			return
		}
		httpx.WriteErr(w, http.StatusInternalServerError, "create game: %v", err)
		return
	}
	g.mu.Lock()
	if s.Name != "" {
		f.logEvent(id, "game named %q", s.Name)
	}
	f.logEvent(id, "game created on %v, deadlineMinutes=%v gmPlays=%v "+
		"retreatBuildPercent=%v graceMinutes=%v firstTurnExtraMinutes=%v pressMode=%v "+
		"pressSilenceSeconds=%v gmReadsPress=%v illegalMoves=%v markerStyle=%v",
		v.Name, s.DeadlineMinutes, s.GMPlays, s.RetreatBuildPercent, s.GraceMinutes,
		s.FirstTurnExtraMinutes, s.PressMode, s.PressSilenceSeconds, s.GMReadsPress,
		s.IllegalMoves, s.MarkerStyle)
	if !variant.Supported[s.Variant] {
		f.logEvent(id, "%v is experimental — unit placement on the map is not verified", v.Name)
	}
	if s.Sandbox {
		// There is nobody to wait for, so a sandbox is open the moment it
		// exists (ADR-047). enterPhase settles the opening position exactly
		// as a started game does; with no claimed seat it locks nothing.
		f.started = true
		f.logEvent(id, "sandbox opened — no seats, no deadline, one driver")
		if err := g.enterPhase(id); err != nil {
			g.mu.Unlock()
			httpx.WriteErr(w, http.StatusInternalServerError, "open sandbox: %v", err)
			return
		}
	}
	g.persist(id)
	g.mu.Unlock()

	http.SetCookie(w, &http.Cookie{
		Name:     refereeCookieName(id),
		Value:    f.gmDevice,
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   60 * 60 * 24 * 30,
	})
	out := createResponse{
		GameID:    id,
		InviteURL: inviteURL(r, id, f.inviteToken),
		Variant:   g.variantRef(),
	}
	if s.Sandbox {
		// A sandbox hands out no seats, so the invite in the answer above
		// opens nothing. The link that matters is this one.
		out.InviteURL = ""
		out.SandboxURL = sandboxURL(r, id, f.sandboxToken)
	}
	httpx.WriteJSON(w, http.StatusOK, out)
}

// gameSummaryJSON is one row of the main-page list. It holds what the
// public watch view holds and nothing more: the id opens the public pages
// only, and every secret stays behind its token.
type gameSummaryJSON struct {
	GameID string `json:"gameId"`
	// Name is what the table calls this game, empty when nobody named it.
	// It belongs to the game, not to any seat, so it is as public as the id.
	Name        string          `json:"name"`
	Variant     variant.RefJSON `json:"variant"`
	Started     bool            `json:"started"`
	Phase       phaseJSON       `json:"phase"`
	JoinedCount int             `json:"joinedCount"`
	TotalSeats  int             `json:"totalSeats"`
	Turns       int             `json:"turns"`
	DeadlineAt  interface{}     `json:"deadlineAt"`
	CreatedAt   string          `json:"createdAt"`
	// Sandbox marks a board with no players (ADR-047). The list shows it
	// because the two read nothing alike: "0 of 7 joined" on a sandbox is
	// not a table waiting to fill, it is a board that never had seats.
	Sandbox bool `json:"sandbox,omitempty"`
	// Referee is true only for the browser that created the game: its
	// cookie matched. It is what puts the referee link on the main page
	// for the GM and nobody else.
	Referee bool `json:"referee"`
}

// handleListGames answers GET /games with every game on the server, newest
// first. Publishing the ids is a deliberate trade: an id opens the public
// watch view, and nothing else — the seat, invite, and GM tokens stay
// unread.
func handleListGames(w http.ResponseWriter, r *http.Request) {
	games.mu.Lock()
	ids := make([]string, 0, len(games.games))
	for id := range games.games {
		ids = append(ids, id)
	}
	games.mu.Unlock()

	out := make([]gameSummaryJSON, 0, len(ids))
	for _, id := range ids {
		g, found := games.lookup(id)
		if !found {
			continue
		}
		g.mu.Lock()
		f := g.flow
		out = append(out, gameSummaryJSON{
			GameID:  id,
			Name:    f.settings.Name,
			Variant: g.variantRef(),
			Started: f.started,
			Phase: phaseJSON{
				Season: string(g.state.Phase().Season()),
				Year:   g.state.Phase().Year(),
				Type:   string(g.state.Phase().Type()),
			},
			JoinedCount: f.joinedCount(),
			TotalSeats:  f.joinerSeats(),
			Turns:       f.phaseIndex,
			DeadlineAt:  rfc3339(f.deadlineAt),
			CreatedAt:   f.createdAt.UTC().Format(time.RFC3339),
			Sandbox:     f.settings.Sandbox,
			Referee:     f.gmDevice != "" && subtleEqual(refereeCookieValue(r, id), f.gmDevice),
		})
		g.mu.Unlock()
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt > out[j].CreatedAt })
	httpx.WriteJSON(w, http.StatusOK, out)
}
