package main

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
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
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

func TestDATCOnTheLoadedClassicalBoard(t *testing.T) {
	withGeneratedDir(t, filepath.Join("variants", "generated"))
	if err := loadGeneratedVariants(); err != nil {
		t.Fatalf("loading the variants: %v", err)
	}
	variant, found := lookupVariant("classical")
	if !found {
		t.Fatal("classical must load from variants/generated")
	}

	corpus := datcCorpus(t)
	for _, file := range []string{
		"datc_v2.4_06.txt",
		"diplicity_errors.txt",
		"droidippy_errors.txt",
		"dipai.txt",
		"real.txt",
	} {
		t.Run(file, func(t *testing.T) {
			runDATCFile(t, variant, filepath.Join(corpus, file))
		})
	}
}

func runDATCFile(t *testing.T, variant common.Variant, path string) {
	t.Helper()
	in, err := os.Open(path)
	if err != nil {
		t.Fatalf("opening %v: %v", path, err)
	}
	defer in.Close()

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
		runDATCCase(t, variant, pair)
	}); err != nil {
		t.Fatalf("parsing %v: %v", path, err)
	}
	if cases == 0 {
		t.Fatalf("%v produced no cases", path)
	}
	t.Logf("%d cases", cases)
}

// runDATCCase sets one position up on the loaded board, resolves it, and
// compares the result with what the case says must happen.
func runDATCCase(t *testing.T, variant common.Variant, pair *datc.StatePair) {
	t.Helper()

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
			t.Fatalf("%v: unsupported phase type %v", pair.Case, s.Phase().Type())
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
	compareDATCResult(t, pair, s)
}

func compareDATCResult(t *testing.T, pair *datc.StatePair, s *state.State) {
	t.Helper()
	describe := func(u godip.Unit) string { return fmt.Sprintf("%v %v", u.Type, u.Nation) }

	for province, want := range pair.After.Units {
		got, ok := s.Units()[province]
		if !ok {
			t.Errorf("%v: expected %v in %v, found nothing",
				pair.Case, describe(want), province)
		} else if !got.Equal(want) {
			t.Errorf("%v: expected %v in %v, found %v",
				pair.Case, describe(want), province, describe(got))
		}
	}
	for province, got := range s.Units() {
		if _, ok := pair.After.Units[province]; !ok {
			t.Errorf("%v: expected %v to be empty, found %v",
				pair.Case, province, describe(got))
		}
	}
	for province, want := range pair.After.Dislodgeds {
		got, ok := s.Dislodgeds()[province]
		if !ok {
			t.Errorf("%v: expected %v dislodged in %v, found nothing",
				pair.Case, describe(want), province)
		} else if !got.Equal(want) {
			t.Errorf("%v: expected %v dislodged in %v, found %v",
				pair.Case, describe(want), province, describe(got))
		}
	}
	for province, got := range s.Dislodgeds() {
		if _, ok := pair.After.Dislodgeds[province]; !ok {
			t.Errorf("%v: expected no dislodged unit in %v, found %v",
				pair.Case, province, describe(got))
		}
	}
}
