// What the tournament pipeline reads (ADR-046), and the published DATC
// score (ADR-045).
package main

import (
	"encoding/csv"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// playYear runs classical from a Spring Movement to the next one, with
// Austria taking Serbia so a centre really changes hands.
func playYear(t *testing.T, g *game, id string) {
	t.Helper()
	order(t, g, "bud", "Move", "ser")
	for i := 0; i < 6 && g.state.Phase().Season() != "Spring"; i++ {
		lockAll(t, g, id)
	}
	lockAll(t, g, id)
	for i := 0; i < 6 && g.state.Phase().Season() != "Spring"; i++ {
		lockAll(t, g, id)
	}
}

func TestResultsCountEveryPowerInEveryYear(t *testing.T) {
	g := watchTestGame(t)
	playYear(t, g, "game")

	out := g.results("game")
	if len(out.Powers) != len(g.flow.powers) {
		t.Fatalf("%v powers listed, want %v", len(out.Powers), len(g.flow.powers))
	}
	if len(out.Years) < 2 {
		t.Fatalf("%v years, want at least 1901 and the year now being played", len(out.Years))
	}
	first := out.Years[0]
	if first.Year != 1901 {
		t.Errorf("the first year is %v, want 1901", first.Year)
	}
	if !first.Final {
		t.Error("1901 is over and is not marked final")
	}
	// Every power named, so an eliminated one would read as zero rather than
	// vanish from the file.
	if len(first.Centres) != len(g.flow.powers) {
		t.Errorf("1901 counts %v powers, want %v", len(first.Centres), len(g.flow.powers))
	}
	// Austria took Serbia, so its year-end count is one above the opening.
	if first.Centres["Austria"] != 4 {
		t.Errorf("Austria ends 1901 with %v centres, want 4", first.Centres["Austria"])
	}
	last := out.Years[len(out.Years)-1]
	if last.Final {
		t.Error("the year being played is marked final")
	}
	if out.Result != nil {
		t.Error("a running game reports a result")
	}
}

// A finished game reports no unfinished year: the phase it froze on was never
// played, so it is not a year of the game.
func TestResultsOfAFinishedGameAreAllFinal(t *testing.T) {
	g := watchTestGame(t)
	giveCentres(t, g, "France", 18)
	lockAll(t, g, "game")

	out := g.results("game")
	if out.Result == nil {
		t.Fatal("the finished game reports no result")
	}
	for _, year := range out.Years {
		if !year.Final {
			t.Errorf("%v is not final on a finished game", year.Year)
		}
	}
}

func TestResultsCSVHasARowPerPowerPerYear(t *testing.T) {
	g := watchTestGame(t)
	playYear(t, g, "game")

	rec := httptest.NewRecorder()
	handleResultsCSV(g, "game", rec, httptest.NewRequest(http.MethodGet, "/results.csv", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("results.csv answered %v", rec.Code)
	}
	if got := rec.Header().Get("Content-Type"); !strings.HasPrefix(got, "text/csv") {
		t.Errorf("content type is %q, want text/csv", got)
	}

	rows, err := csv.NewReader(rec.Body).ReadAll()
	if err != nil {
		t.Fatalf("the CSV does not parse: %v", err)
	}
	header := []string{"game", "year", "power", "centres", "final"}
	if len(rows) == 0 || strings.Join(rows[0], ",") != strings.Join(header, ",") {
		t.Fatalf("header is %v, want %v", rows[0], header)
	}
	years := len(g.results("game").Years)
	want := 1 + years*len(g.flow.powers)
	if len(rows) != want {
		t.Errorf("%v rows, want %v", len(rows), want)
	}
	for _, row := range rows[1:] {
		if len(row) != len(header) {
			t.Fatalf("row %v has %v columns, want %v", row, len(row), len(header))
		}
	}
}

// The published feed is token-free, like the board it counts.
func TestResultsJSONIsServed(t *testing.T) {
	g := watchTestGame(t)
	playYear(t, g, "game")

	rec := httptest.NewRecorder()
	handleResults(g, "game", rec, httptest.NewRequest(http.MethodGet, "/results.json", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("results.json answered %v", rec.Code)
	}
	out := resultsJSON{}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("the JSON does not parse: %v", err)
	}
	if out.GameID != "game" || len(out.Years) == 0 {
		t.Errorf("the feed reads %+v", out)
	}
}

/*
TestTheDATCReportIsPublished (ADR-045).

The report is written by the run that resolved the cases and embedded at
build time, so this checks the two halves agree: the build carries a report,
and the report says every case passed. A build whose test has never run has
no file, and the page says so rather than guessing — but this repository ships
one, and a regression that turned it red would be caught here.
*/
func TestTheDATCReportIsPublished(t *testing.T) {
	raw := datcReportBytes()
	if raw == nil {
		t.Fatalf("this build carries no %v — run go test ./...", datcReportPath)
	}
	report := struct {
		Engine string `json:"engine"`
		Cases  int    `json:"cases"`
		Passed int    `json:"passed"`
		Files  []struct {
			Name   string   `json:"name"`
			Cases  int      `json:"cases"`
			Passed int      `json:"passed"`
			Failed []string `json:"failed"`
		} `json:"files"`
		Limits []string `json:"limits"`
	}{}
	if err := json.Unmarshal(raw, &report); err != nil {
		t.Fatalf("the report does not parse: %v", err)
	}
	if report.Cases == 0 {
		t.Fatal("the report counts no cases")
	}
	if report.Passed != report.Cases {
		t.Errorf("%v of %v cases pass", report.Passed, report.Cases)
	}
	if report.Engine == "" {
		t.Error("the report does not name the engine it ran against")
	}
	// The limits are the half webDiplomacy's table leaves out, so an empty
	// list is a page that claims more than it ran.
	if len(report.Limits) == 0 {
		t.Error("the report states no limits")
	}
	total := 0
	for _, file := range report.Files {
		total += file.Cases
		if len(file.Failed) != file.Cases-file.Passed {
			t.Errorf("%v names %v failures but counts %v",
				file.Name, len(file.Failed), file.Cases-file.Passed)
		}
	}
	if total != report.Cases {
		t.Errorf("the files add up to %v cases, the total says %v", total, report.Cases)
	}

	rec := httptest.NewRecorder()
	handleDATC(rec, httptest.NewRequest(http.MethodGet, "/datc.json", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("/datc.json answered %v", rec.Code)
	}
	if rec.Body.Len() != len(raw) {
		t.Error("the served report is not the embedded one")
	}
}
