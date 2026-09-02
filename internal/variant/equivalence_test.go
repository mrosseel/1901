package variant

// Every variant this server plays used to be a Go package in godip. Each one
// is now a descriptor on disk, and this file is the proof that the crossing
// changed nothing: for each variant it holds godip's own package next to the
// descriptor loaded from variants/generated and refuses to let them differ.
//
// A conversion that quietly moved one border would not break a test, would not
// break a build, and would corrupt every game played on that map. So the
// comparison is exhaustive rather than representative: every region, every
// flag, every edge in both directions, the whole opening position, and then
// several phases of play with the options offered to every power at each one.

import (
	"encoding/json"
	"fmt"
	"reflect"
	"sort"
	"testing"

	"github.com/zond/godip"
	"github.com/zond/godip/state"
	"github.com/zond/godip/variants"
	"github.com/zond/godip/variants/common"
)

// compiledByKey is godip's own variants, by the key this server files them
// under. It is the reference the descriptors are held against.
func compiledByKey() map[string]common.Variant {
	out := map[string]common.Variant{}
	for _, v := range variants.OrderedVariants {
		out[Key(v.Name)] = v
	}
	return out
}

// loadedForEquivalence loads the checked-in descriptors, once per test.
func loadedForEquivalence(t *testing.T) map[string]GeneratedVariant {
	t.Helper()
	WithGeneratedDir(t, repoPath(t, "variants/generated"))
	if err := LoadGenerated(); err != nil {
		t.Fatalf("loading the descriptors: %v", err)
	}
	return Generated
}

// TestEveryGodipVariantHasADescriptor is the first half of dropping the
// compiled path: nothing may be lost on the way out of it.
func TestEveryGodipVariantHasADescriptor(t *testing.T) {
	loaded := loadedForEquivalence(t)
	for key, v := range compiledByKey() {
		if _, found := loaded[key]; !found {
			t.Errorf("godip ships %q (%v) and no descriptor describes it",
				key, v.Name)
		}
	}
}

func TestDescriptorsMatchTheCompiledVariants(t *testing.T) {
	loaded := loadedForEquivalence(t)
	for key, compiled := range compiledByKey() {
		gen, found := loaded[key]
		if !found {
			continue // reported by the test above
		}
		t.Run(key, func(t *testing.T) {
			compareVariants(t, compiled, gen.Variant)
		})
	}
}

func compareVariants(t *testing.T, compiled, loaded common.Variant) {
	t.Helper()
	compareIdentity(t, compiled, loaded)
	compareBoards(t, compiled, loaded)
	compareStarts(t, compiled, loaded)
	compareParsers(t, compiled, loaded)
	comparePhases(t, compiled, loaded)
	compareVictory(t, compiled, loaded)
	comparePlay(t, compiled, loaded)
}

// ---- identity --------------------------------------------------------------

func compareIdentity(t *testing.T, compiled, loaded common.Variant) {
	t.Helper()
	if compiled.Name != loaded.Name {
		t.Errorf("name: %q became %q", compiled.Name, loaded.Name)
	}
	if !reflect.DeepEqual(compiled.Nations, loaded.Nations) {
		t.Errorf("nations differ\n  godip: %v\n  loaded: %v",
			compiled.Nations, loaded.Nations)
	}
	if !reflect.DeepEqual(compiled.PhaseTypes, loaded.PhaseTypes) {
		t.Errorf("phase types differ\n  godip: %v\n  loaded: %v",
			compiled.PhaseTypes, loaded.PhaseTypes)
	}
	if !reflect.DeepEqual(compiled.Seasons, loaded.Seasons) {
		t.Errorf("seasons differ\n  godip: %v\n  loaded: %v",
			compiled.Seasons, loaded.Seasons)
	}
	if !reflect.DeepEqual(compiled.UnitTypes, loaded.UnitTypes) {
		t.Errorf("unit types differ\n  godip: %v\n  loaded: %v",
			compiled.UnitTypes, loaded.UnitTypes)
	}
	if compiled.Description != loaded.Description {
		t.Errorf("description differs\n  godip: %q\n  loaded: %q",
			compiled.Description, loaded.Description)
	}
	if compiled.Rules != loaded.Rules {
		t.Errorf("rules text differs\n  godip: %q\n  loaded: %q",
			compiled.Rules, loaded.Rules)
	}
	if compiled.CreatedBy != loaded.CreatedBy {
		t.Errorf("createdBy: %q became %q", compiled.CreatedBy, loaded.CreatedBy)
	}
	if compiled.Version != loaded.Version {
		t.Errorf("version: %q became %q", compiled.Version, loaded.Version)
	}
	// godip's long-name tables sometimes name a province the graph does not
	// have; the descriptor carries a name for each province it declares, so
	// the comparison is over the graph.
	//
	// A name godip leaves empty is the one difference allowed. Four variants
	// compile no name for a province their graph builder names in a comment
	// and their art draws, and 1800: Empires And Coalitions compiles none for
	// any of its 96. A descriptor that repeated the hole would label the board
	// with nothing, so the name was recovered and written in by hand, and
	// variant-export carries it across a re-export. Filling a hole is the
	// correction; changing a name godip states is still a fault.
	for _, province := range compiled.Graph().Provinces() {
		if province != province.Super() {
			continue
		}
		want := compiled.ProvinceLongNames[province]
		got := loaded.ProvinceLongNames[province]
		if want == "" && got != "" {
			continue
		}
		if want != got {
			t.Errorf("%v is %q in godip and %q loaded", province, want, got)
		}
	}
}

// ---- the board -------------------------------------------------------------

// compareBoards holds the board a game is played on against godip's.
//
// It is the state's graph, not the variant's, because for two variants those
// are different graphs. France vs Austria and Italy vs Germany declare a Graph
// that blanks the home centres of the powers they removed, and a Start that
// plays on the classical graph with those centres intact. The one that decides
// play is the one a state carries, so that is the one a descriptor states, and
// the loaded variant then has only the one board.
func compareBoards(t *testing.T, compiled, loaded common.Variant) {
	t.Helper()
	want, err := compiled.Start()
	if err != nil {
		t.Fatalf("godip's own Start failed: %v", err)
	}
	got, err := loaded.Start()
	if err != nil {
		t.Fatalf("the descriptor's Start failed: %v", err)
	}
	compareGraphs(t, want.Graph(), got.Graph())

	if a, b := provinceSet(loaded.Graph()), provinceSet(got.Graph()); !reflect.DeepEqual(a, b) {
		t.Errorf("the loaded variant reports one board and plays on another")
	}
}

func compareGraphs(t *testing.T, compiled, loaded godip.Graph) {
	t.Helper()

	want := provinceSet(compiled)
	got := provinceSet(loaded)
	if !reflect.DeepEqual(want, got) {
		t.Errorf("the region set differs\n  only in godip: %v\n  only loaded: %v",
			missing(want, got), missing(got, want))
		return
	}

	for _, region := range want {
		province := godip.Province(region)
		if a, b := flagList(compiled.Flags(province)), flagList(loaded.Flags(province)); !reflect.DeepEqual(a, b) {
			t.Errorf("%v is %v in godip and %v loaded", region, a, b)
		}
		if a, b := scName(compiled.SC(province)), scName(loaded.SC(province)); a != b {
			t.Errorf("%v's supply centre is %v in godip and %v loaded", region, a, b)
		}
		// Both directions, separately. An edge stated once in the descriptor
		// becomes two here, and an edge stated one way must stay one way.
		for _, reverse := range []bool{false, true} {
			a := edgeMap(compiled, province, reverse)
			b := edgeMap(loaded, province, reverse)
			if !reflect.DeepEqual(a, b) {
				direction := "out of"
				if reverse {
					direction = "into"
				}
				t.Errorf("edges %v %v differ\n  godip: %v\n  loaded: %v",
					direction, region, a, b)
			}
		}
	}

	if a, b := sortedProvinces(compiled.AllSCs()), sortedProvinces(loaded.AllSCs()); !reflect.DeepEqual(a, b) {
		t.Errorf("the supply centre set differs\n  godip: %v\n  loaded: %v", a, b)
	}
}

func provinceSet(g godip.Graph) []string {
	out := []string{}
	for _, p := range g.Provinces() {
		out = append(out, string(p))
	}
	sort.Strings(out)
	return out
}

func sortedProvinces(in []godip.Province) []string {
	out := []string{}
	for _, p := range in {
		out = append(out, string(p))
	}
	sort.Strings(out)
	return out
}

func flagList(flags map[godip.Flag]bool) []string {
	out := []string{}
	for flag, on := range flags {
		if on {
			out = append(out, string(flag))
		}
	}
	sort.Strings(out)
	return out
}

func scName(nation *godip.Nation) string {
	if nation == nil {
		return "none"
	}
	return string(*nation)
}

func edgeMap(g godip.Graph, province godip.Province, reverse bool) map[string][]string {
	out := map[string][]string{}
	for dest, flags := range g.Edges(province, reverse) {
		out[string(dest)] = flagList(flags)
	}
	return out
}

func missing(from, in []string) []string {
	have := map[string]bool{}
	for _, s := range in {
		have[s] = true
	}
	out := []string{}
	for _, s := range from {
		if !have[s] {
			out = append(out, s)
		}
	}
	return out
}

// ---- the opening position --------------------------------------------------

func compareStarts(t *testing.T, compiled, loaded common.Variant) {
	t.Helper()
	want, err := compiled.Start()
	if err != nil {
		t.Fatalf("godip's own Start failed: %v", err)
	}
	got, err := loaded.Start()
	if err != nil {
		t.Fatalf("the descriptor's Start failed: %v", err)
	}
	compareStates(t, "start", want, got)
}

func compareStates(t *testing.T, where string, want, got *state.State) {
	t.Helper()
	if a, b := phaseName(want.Phase()), phaseName(got.Phase()); a != b {
		t.Errorf("%v: phase is %v in godip and %v loaded", where, a, b)
	}
	if a, b := unitMap(want.Units()), unitMap(got.Units()); !reflect.DeepEqual(a, b) {
		t.Errorf("%v: units differ\n  godip: %v\n  loaded: %v", where, a, b)
	}
	if a, b := unitMap(want.Dislodgeds()), unitMap(got.Dislodgeds()); !reflect.DeepEqual(a, b) {
		t.Errorf("%v: dislodged units differ\n  godip: %v\n  loaded: %v", where, a, b)
	}
	if a, b := centerMap(want.SupplyCenters()), centerMap(got.SupplyCenters()); !reflect.DeepEqual(a, b) {
		t.Errorf("%v: supply centre ownership differs\n  godip: %v\n  loaded: %v",
			where, a, b)
	}
}

func phaseName(p godip.Phase) string {
	return fmt.Sprintf("%d %v %v", p.Year(), p.Season(), p.Type())
}

func unitMap(units map[godip.Province]godip.Unit) map[string]string {
	out := map[string]string{}
	for province, unit := range units {
		out[string(province)] = fmt.Sprintf("%v %v", unit.Type, unit.Nation)
	}
	return out
}

func centerMap(centers map[godip.Province]godip.Nation) map[string]string {
	out := map[string]string{}
	for province, nation := range centers {
		out[string(province)] = string(nation)
	}
	return out
}

// ---- rules -----------------------------------------------------------------

func compareParsers(t *testing.T, compiled, loaded common.Variant) {
	t.Helper()
	want := compiled.Parser.OrderTypes()
	got := loaded.Parser.OrderTypes()
	if !reflect.DeepEqual(orderTypeNames(want), orderTypeNames(got)) {
		t.Errorf("the order types a player may write differ\n  godip: %v\n  loaded: %v",
			orderTypeNames(want), orderTypeNames(got))
	}
	// Two parsers can agree on names and disagree on what accepts them, so the
	// prototypes themselves are compared.
	wantOrders, gotOrders := compiled.Parser.Orders(), loaded.Parser.Orders()
	if len(wantOrders) != len(gotOrders) {
		t.Fatalf("godip parses %d order shapes, the descriptor %d",
			len(wantOrders), len(gotOrders))
	}
	for i := range wantOrders {
		if a, b := reflect.TypeOf(wantOrders[i]), reflect.TypeOf(gotOrders[i]); a != b {
			t.Errorf("order %d is %v in godip and %v loaded", i, a, b)
		}
	}
}

func orderTypeNames(in []godip.OrderType) []string {
	out := []string{}
	for _, t := range in {
		out = append(out, string(t))
	}
	sort.Strings(out)
	return out
}

// comparePhases walks the phase cycle. A variant whose seasons or years step
// differently — Hundred moves five years per turn and has one season — reaches
// different phases from the same starting point.
func comparePhases(t *testing.T, compiled, loaded common.Variant) {
	t.Helper()
	start, err := compiled.Start()
	if err != nil {
		t.Fatal(err)
	}
	p := start.Phase()
	want, got := compiled.Phase(p.Year(), p.Season(), p.Type()), loaded.Phase(p.Year(), p.Season(), p.Type())
	for step := 0; step < 12; step++ {
		if a, b := phaseName(want), phaseName(got); a != b {
			t.Fatalf("phase %d after the start is %v in godip and %v loaded", step, a, b)
		}
		want, got = want.Next(), got.Next()
	}
}

func compareVictory(t *testing.T, compiled, loaded common.Variant) {
	t.Helper()
	start, err := compiled.Start()
	if err != nil {
		t.Fatal(err)
	}
	if a, b := compiled.SoloSCCount(start), loaded.SoloSCCount(start); a != b {
		t.Errorf("a solo needs %d centres in godip and %d loaded", a, b)
	}
	// The win condition is a function of the board, so it is asked about a
	// board: the opening position, and one where a single power holds
	// everything.
	if a, b := compiled.SoloWinner(start), loaded.SoloWinner(start); a != b {
		t.Errorf("at the opening position godip declares %q the winner and the "+
			"descriptor %q", a, b)
	}

	conquered, err := loaded.Start()
	if err != nil {
		t.Fatal(err)
	}
	all := map[godip.Province]godip.Nation{}
	for _, province := range conquered.Graph().AllSCs() {
		all[province] = compiled.Nations[0]
	}
	conquered.SetSupplyCenters(all)
	if a, b := compiled.SoloWinner(conquered), loaded.SoloWinner(conquered); a != b {
		t.Errorf("with every centre held godip declares %q the winner and the "+
			"descriptor %q", a, b)
	}
}

// ---- play ------------------------------------------------------------------

// comparePlay runs the same empty game on both boards.
//
// With no orders given, adjudication is deterministic, so any divergence is a
// difference between the boards. It reaches what the checks above cannot: the
// state flags that decide where a build may land, the neutral orders that move
// unowned units, and the phase's own post-processing.
//
// The options offered to each power are compared at every phase, because they
// are the whole of what a player can do and they are computed from the graph,
// the parser and the flags at once.
func comparePlay(t *testing.T, compiled, loaded common.Variant) {
	t.Helper()
	want, err := compiled.Start()
	if err != nil {
		t.Fatal(err)
	}
	got, err := loaded.Start()
	if err != nil {
		t.Fatal(err)
	}

	for phase := 0; phase < 4; phase++ {
		where := fmt.Sprintf("phase %d", phase)
		compareStates(t, where, want, got)
		for _, nation := range compiled.Nations {
			a := optionsJSON(t, want.Phase().Options(want, nation))
			b := optionsJSON(t, got.Phase().Options(got, nation))
			if a != b {
				t.Errorf("%v: the options offered to %v differ\n  godip: %v\n  loaded: %v",
					where, nation, a, b)
			}
		}
		if err := want.Next(); err != nil {
			t.Fatalf("%v: godip's board: %v", where, err)
		}
		if err := got.Next(); err != nil {
			t.Fatalf("%v: the descriptor's board: %v", where, err)
		}
	}
}

// optionsJSON renders an options tree for comparison. It is a map of maps
// several levels deep, and JSON sorts every level's keys.
func optionsJSON(t *testing.T, options godip.Options) string {
	t.Helper()
	b, err := json.Marshal(options)
	if err != nil {
		t.Fatalf("rendering options: %v", err)
	}
	return string(b)
}
