/*
Emit what the tournament pipeline already eats (ADR-046).

dipvis, which runs publicly as DipTV, is the software a face-to-face
Diplomacy tournament actually runs on: registration, roll call, seeding,
scoring, standings, and the CSV the World Diplomacy Database ingests. It gets
its supply-centre counts by scraping Backstabbr's HTML, through an action its
tournament directors know as "Import SC Counts from Backstabbr".

That scraper is the seam. This server already publishes the whole position at
a stable address with no token (ADR-028), so a director's pipeline works the
day somebody points it here, and a scraper is replaced by an answer.

	/game/{id}/results.json    every year, every power, the centre count
	/game/{id}/results.csv     the same numbers, for a spreadsheet

Both are public and unauthenticated, like everything else about a board that
anybody in the room can see. Neither carries an order.

**What a year's count means.** Supply-centre ownership changes once a year, at
the adjustment phase, so a year's count is read from the LAST phase this
server holds for that year. For a year that finished, that is its adjustment
phase and the number is final. For the year being played it is the board as it
stands, and the row says `final: false` — a director importing mid-round gets
the current count and is told it is current.

**We compute no score.** dipvis's own catalogue carries 25 scoring systems,
each with tests, and DESIGN.md §1 says scoring is not our job. What we owe the
pipeline is the counts and the result (ADR-044).
*/
package app

import (
	"encoding/csv"
	"fmt"
	"net/http"
	"sort"
	"spring1901/spike/internal/httpx"
	"spring1901/spike/internal/variant"
	"strconv"
)

// resultsYearJSON is one year of the game, as counts.
type resultsYearJSON struct {
	Year  int       `json:"year"`
	Phase phaseJSON `json:"phase"`
	// Final says the year is over and its count cannot change. False on the
	// year being played.
	Final   bool           `json:"final"`
	Centres map[string]int `json:"centres"`
}

// resultsJSON is the whole game, as the tournament pipeline wants it.
type resultsJSON struct {
	GameID string            `json:"gameId"`
	Name   string            `json:"name,omitempty"`
	Powers []string          `json:"powers"`
	Years  []resultsYearJSON `json:"years"`
	// Result is how the game ended, null while it runs (ADR-044).
	Result  *gameResult     `json:"result"`
	Variant variant.RefJSON `json:"variant"`
	Now     string          `json:"now"`
}

/*
countCentres counts a phase's recorded ownership per power, naming every power
of the variant so an eliminated one reads as zero rather than as missing.
*/
func (self *game) countCentres(owners map[string]string) map[string]int {
	out := map[string]int{}
	for _, p := range self.flow.powers {
		out[string(p)] = 0
	}
	for _, nation := range owners {
		if nation == "" {
			continue
		}
		if _, known := out[nation]; known {
			out[nation]++
		}
	}
	return out
}

/*
results gathers one row per year. The caller must hold g.mu.

Later phases of a year overwrite earlier ones, which is what makes the last
phase of the year the one that counts. The board as it stands is written last
and is never final, so a game in progress reports the year it is in.
*/
func (self *game) results(id string) resultsJSON {
	f := self.flow
	out := resultsJSON{
		GameID:  id,
		Name:    f.settings.Name,
		Result:  f.result,
		Variant: self.variantRef(),
		Now:     serverNow(),
	}
	for _, p := range f.powers {
		out.Powers = append(out.Powers, string(p))
	}

	byYear := map[int]resultsYearJSON{}
	for _, snapshot := range self.watch {
		if snapshot == nil {
			continue
		}
		year := snapshot.position.phase.Year
		byYear[year] = resultsYearJSON{
			Year:    year,
			Phase:   snapshot.position.phase,
			Final:   true,
			Centres: self.countCentres(snapshot.position.supplyCenters),
		}
	}
	// The board now. A finished game froze on the phase after its last, and
	// that phase was never played, so it is not a year of the game.
	if !f.over() {
		position := self.positionNow()
		byYear[position.phase.Year] = resultsYearJSON{
			Year:    position.phase.Year,
			Phase:   position.phase,
			Final:   false,
			Centres: self.countCentres(position.supplyCenters),
		}
	}

	years := make([]int, 0, len(byYear))
	for year := range byYear {
		years = append(years, year)
	}
	sort.Ints(years)
	for _, year := range years {
		out.Years = append(out.Years, byYear[year])
	}
	return out
}

// handleResults serves /game/{id}/results.json.
func handleResults(g *game, id string, w http.ResponseWriter, r *http.Request) {
	g.mu.Lock()
	defer g.mu.Unlock()
	httpx.WriteJSON(w, http.StatusOK, g.results(id))
}

/*
handleResultsCSV serves /game/{id}/results.csv.

Five columns: game, year, power, centres, final. dipvis publishes no column
names for a supply-centre import — its importer reads a site's HTML, not a
file — so these are ours, and they are named here because ADR-046 says an
invented column has to be written down somewhere.
*/
func handleResultsCSV(g *game, id string, w http.ResponseWriter, r *http.Request) {
	g.mu.Lock()
	out := g.results(id)
	g.mu.Unlock()

	w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	w.Header().Set("Content-Disposition",
		fmt.Sprintf(`attachment; filename="1901-%v-results.csv"`, id))
	rows := csv.NewWriter(w)
	_ = rows.Write([]string{"game", "year", "power", "centres", "final"})
	for _, year := range out.Years {
		for _, power := range out.Powers {
			_ = rows.Write([]string{
				id,
				strconv.Itoa(year.Year),
				power,
				strconv.Itoa(year.Centres[power]),
				strconv.FormatBool(year.Final),
			})
		}
	}
	rows.Flush()
}
