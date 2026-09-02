package app

// The DATC corpus, adjudicated on the board this server loads from disk.
//
// DATC is the Diplomacy Adjudicator Test Cases: several hundred positions whose
// correct outcome the hobby agreed on, plus the regression files godip
// collected from real games. godip runs them against its own classical package.
// This runs them against variants/generated/classical — the same cases, the
// same adjudicator, a board that arrived as JSON.
//
// It is the strongest single statement the format can make. A descriptor that
// dropped a coast, reversed a border or misfiled a canal would pass every
// structural check and then fail here, in a position somebody wrote down
// because it was hard.

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/zond/godip"
	"github.com/zond/godip/datc"
	"github.com/zond/godip/state"
	"github.com/zond/godip/variants/classical"
	"github.com/zond/godip/variants/common"
)

// datcCorpus locates godip's test files in the module cache.
//
// DATC_CORPUS overrides it, for a checkout that keeps its own copy.
func datcCorpus(t *testing.T) string {
	t.Helper()
	if dir := os.Getenv("DATC_CORPUS"); dir != "" {
		return dir
	}
	out, err := exec.Command("go", "list", "-m", "-f", "{{.Dir}}",
		"github.com/zond/godip").Output()
	if err != nil {
		t.Fatalf("locating godip's DATC corpus: %v\n"+
			"set DATC_CORPUS to the directory holding datc_v2.4_06.txt", err)
	}
	return filepath.Join(strings.TrimSpace(string(out)),
		"variants", "classical", "datc")
}

// godipVersion is the engine the corpus ran against, for the report. An
// unreadable version is not a test failure: the cases still ran.
func godipVersion() string {
	out, err := exec.Command("go", "list", "-m", "-f", "{{.Version}}",
		"github.com/zond/godip").Output()
	if err != nil {
		return "unknown"
	}
	return strings.TrimSpace(string(out))
}

func TestDATCOnTheLoadedClassicalBoard(t *testing.T) {
	withGeneratedDir(t, repoPath(t, filepath.Join("variants", "generated")))
	if err := loadGeneratedVariants(); err != nil {
		t.Fatalf("loading the variants: %v", err)
	}
	variant, found := lookupVariant("classical")
	if !found {
		t.Fatal("classical must load from variants/generated")
	}

	corpus := datcCorpus(t)
	report := datcReport{Engine: godipVersion(), Variant: "classical", Limits: datcLimits}
	for _, file := range []string{
		"datc_v2.4_06.txt",
		"diplicity_errors.txt",
		"droidippy_errors.txt",
		"dipai.txt",
		"real.txt",
	} {
		t.Run(file, func(t *testing.T) {
			report.add(runDATCFile(t, variant, filepath.Join(corpus, file)))
		})
	}
	if err := report.write(datcReportPath); err != nil {
		t.Fatalf("writing %v: %v", datcReportPath, err)
	}
}

// datcLimits is what this run does NOT cover. webDiplomacy's own table is
// honest about skipping the retreat and build cases; ours can beat that by
// saying what it leaves out in the same place it says what it passed
// (ADR-045). These are sentences about method, so they are written here; every
// number in the report is counted.
var datcLimits = []string{
	"Only the classical variant. Every other variant this server plays is " +
		"generated from the same descriptor format and is checked " +
		"structurally, not against DATC.",
	"The corpus is godip's: DATC v2.4 section 6, plus the regression files " +
		"godip collected from Diplicity, Droidippy, dipai and real games. " +
		"A DATC case godip does not ship is not run here.",
	"Each case is one position resolved once. Nothing here exercises the " +
		"deadline, the seat rules or the order-entry grammar.",
}

// datcFileReport is one corpus file's outcome.
type datcFileReport struct {
	Name   string `json:"name"`
	Cases  int    `json:"cases"`
	Passed int    `json:"passed"`
	// Failed names the cases that did not match, so a reader can chase one
	// rather than take the number on trust.
	Failed []string `json:"failed"`
}

// datcReport is the whole run, and the file the server publishes (ADR-045).
//
// It carries no timestamp on purpose. A report that stamps the clock changes
// on every run and says nothing new; this one changes only when an outcome
// does, so a diff on it is a real event.
type datcReport struct {
	Engine  string           `json:"engine"`
	Variant string           `json:"variant"`
	Cases   int              `json:"cases"`
	Passed  int              `json:"passed"`
	Files   []datcFileReport `json:"files"`
	Limits  []string         `json:"limits"`
}

func (self *datcReport) add(file datcFileReport) {
	self.Cases += file.Cases
	self.Passed += file.Passed
	self.Files = append(self.Files, file)
}

func (self *datcReport) write(path string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	sort.Slice(self.Files, func(a, b int) bool { return self.Files[a].Name < self.Files[b].Name })
	encoded, err := json.MarshalIndent(self, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, append(encoded, '\n'), 0o644)
}

func runDATCFile(t *testing.T, variant common.Variant, path string) datcFileReport {
	t.Helper()
	in, err := os.Open(path)
	if err != nil {
		t.Fatalf("opening %v: %v", path, err)
	}
	defer in.Close()

	out := datcFileReport{Name: filepath.Base(path), Failed: []string{}}
	cases := 0
	parser := datc.Parser{
		Variant:     "Standard",
		OrderParser: classical.DATCOrder,
		// The phases come from the loaded variant, not from godip's, so a
		// descriptor naming the wrong rules profile fails here too.
		PhaseParser: func(season string, year int, typ string) (godip.Phase, error) {
			phase, err := classical.DATCPhase(season, year, typ)
			if err != nil {
				return nil, err
			}
			return variant.Phase(phase.Year(), phase.Season(), phase.Type()), nil
		},
		NationParser:   classical.DATCNation,
		UnitTypeParser: classical.DATCUnitType,
		ProvinceParser: classical.DATCProvince,
	}
	if err := parser.Parse(in, func(pair *datc.StatePair) {
		cases++
		problems := runDATCCase(variant, pair)
		if len(problems) == 0 {
			out.Passed++
			return
		}
		out.Failed = append(out.Failed, pair.Case)
		for _, problem := range problems {
			t.Error(problem)
		}
	}); err != nil {
		t.Fatalf("parsing %v: %v", path, err)
	}
	if cases == 0 {
		t.Fatalf("%v produced no cases", path)
	}
	out.Cases = cases
	t.Logf("%d of %d cases", out.Passed, cases)
	return out
}

// runDATCCase sets one position up on the loaded board, resolves it, and
// returns what did not match, empty when the case passed. It reports nothing
// itself: the caller both fails the test and counts the case, and those two
// jobs have to see the same answer (ADR-045).
func runDATCCase(variant common.Variant, pair *datc.StatePair) []string {
	phase := pair.Before.Phase
	if phase == nil {
		phase = variant.Phase(1901, godip.Spring, godip.Movement)
	}
	s := variant.Blank(phase)
	s.SetUnits(pair.Before.Units)
	s.SetDislodgeds(pair.Before.Dislodgeds)
	s.SetSupplyCenters(pair.Before.SCs)

	for province, order := range pair.Before.Orders {
		switch s.Phase().Type() {
		case godip.Movement:
			if u, _, ok := s.Unit(province); ok && u.Nation == order.Nation {
				s.SetOrder(province, order.Order)
			}
		case godip.Retreat:
			if u, _, ok := s.Dislodged(province); ok && u.Nation == order.Nation {
				s.SetOrder(province, order.Order)
			}
		case godip.Adjustment:
			if order.Order.Type() == godip.Build {
				if n, _, ok := s.SupplyCenter(province); ok && n == order.Nation {
					s.SetOrder(province, order.Order)
				}
			} else if order.Order.Type() == godip.Disband {
				if u, _, ok := s.Unit(province); ok && u.Nation == order.Nation {
					s.SetOrder(province, order.Order)
				}
			}
		default:
			return []string{fmt.Sprintf("%v: unsupported phase type %v",
				pair.Case, s.Phase().Type())}
		}
	}
	// A case may declare what happened the phase before, which is how a unit
	// comes to be bounced or dislodged in the position being resolved.
	for _, order := range pair.Before.FailedOrders {
		if order.Order.Type() == godip.Move && !order.Order.Flags()[godip.ViaConvoy] {
			s.AddBounce(order.Order.Targets()[0], order.Order.Targets()[1])
		}
	}
	for _, order := range pair.Before.SuccessfulOrders {
		if order.Order.Type() == godip.Move && !order.Order.Flags()[godip.ViaConvoy] {
			s.SetDislodger(order.Order.Targets()[0], order.Order.Targets()[1])
		}
	}

	s.Next()
	return compareDATCResult(pair, s)
}

func compareDATCResult(pair *datc.StatePair, s *state.State) []string {
	problems := []string{}
	describe := func(u godip.Unit) string { return fmt.Sprintf("%v %v", u.Type, u.Nation) }
	note := func(format string, args ...interface{}) {
		problems = append(problems, fmt.Sprintf(format, args...))
	}

	for province, want := range pair.After.Units {
		got, ok := s.Units()[province]
		if !ok {
			note("%v: expected %v in %v, found nothing",
				pair.Case, describe(want), province)
		} else if !got.Equal(want) {
			note("%v: expected %v in %v, found %v",
				pair.Case, describe(want), province, describe(got))
		}
	}
	for province, got := range s.Units() {
		if _, ok := pair.After.Units[province]; !ok {
			note("%v: expected %v to be empty, found %v",
				pair.Case, province, describe(got))
		}
	}
	for province, want := range pair.After.Dislodgeds {
		got, ok := s.Dislodgeds()[province]
		if !ok {
			note("%v: expected %v dislodged in %v, found nothing",
				pair.Case, describe(want), province)
		} else if !got.Equal(want) {
			note("%v: expected %v dislodged in %v, found %v",
				pair.Case, describe(want), province, describe(got))
		}
	}
	for province, got := range s.Dislodgeds() {
		if _, ok := pair.After.Dislodgeds[province]; !ok {
			note("%v: expected no dislodged unit in %v, found %v",
				pair.Case, province, describe(got))
		}
	}
	return problems
}
