/*
The DATC pass rate is a generated page (ADR-045).

DATC is the Diplomacy Adjudicator Test Cases: several hundred positions whose
correct outcome the hobby agreed on. Every serious adjudicator publishes what
it scores against them, and it is the first thing anybody asks. jDip and
webDiplomacy both have a table; diplomacy.mylootcave.com puts "167/167" in its
own meta tags.

We already ran the corpus. datc_test.go resolves every case on the board this
server loads from disk, in CI, on every push. What was missing was publishing
the answer:

	/datc.json    what the last run scored, per file, with the failures named
	/datc         the page that draws it

Two rules, both from ADR-045. The report states what was NOT run, in the same
place it states what passed. And no number here is ever typed: the file is
written by the test that did the work, so a hand-edited claim about
correctness cannot survive a run.

**Why the file is committed.** The corpus lives in godip's module cache, not
in this repository, so the server cannot recount at start-up. The test writes
datcreport/report.json and the binary embeds it. A build made from a tree
where the test has never run serves "not run in this build" rather than a
number, because the honest answer to "what did you score" is never a guess.
*/
package app

import (
	"embed"
	"net/http"
	"spring1901/spike/internal/httpx"
)

// datcReportPath is where the test writes and the build reads. One constant,
// so the two halves cannot drift apart.
const datcReportPath = "datcreport/report.json"

// The report, as it was when this binary was built. The directory is embedded
// rather than the file, so a tree whose test has not run still compiles.
//
//go:embed all:datcreport
var datcReportFS embed.FS

// datcReportBytes is the published report, and nil when this build has none.
func datcReportBytes() []byte {
	out, err := datcReportFS.ReadFile(datcReportPath)
	if err != nil {
		return nil
	}
	return out
}

/*
handleDATC serves /datc.json.

It is published data (ADR-050): a bare, citable address that keeps working,
because the point of the number is that somebody else can quote it.
*/
func handleDATC(w http.ResponseWriter, r *http.Request) {
	report := datcReportBytes()
	if report == nil {
		httpx.WriteErr(w, http.StatusNotFound,
			"this build carries no DATC report: run go test ./... to write %v", datcReportPath)
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(report)
}
