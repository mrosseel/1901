// Integrity and playthrough tests for the variants translated from jDip.
//
// The translator is only trustworthy if its output is checked against the
// source it came from, so these tests read the jDip XML again and assert
// that the generated graph, start position and supply centers agree with
// it. They then play one phase to prove godip accepts the result.
package variants1901

import (
	"encoding/xml"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"testing"

	"github.com/zond/godip"
	"github.com/zond/godip/variants/common"

	"spring1901/spike/variants1901/jdip1900"
	"spring1901/spike/variants1901/sailho"
)

type variantCase struct {
	name      string
	variant   common.Variant
	source    string
	adjacency string
	variants  string
	// xmlName selects the VARIANT element in the variants file.
	xmlName string
	// mapFile is the converted map beside the generated package.
	mapFile string
	// unreachable provinces are known placeholders with no neighbours.
	unreachable map[string]bool
	// moves are one legal move per power, used by the playthrough.
	moves map[godip.Nation][3]string
}

var cases = []variantCase{
	{
		name:        "1900",
		variant:     jdip1900.Nineteen00Variant,
		source:      "../tools/jdip-import/source/1900",
		adjacency:   "1900_adjacency.xml",
		variants:    "variants.xml",
		xmlName:     "1900",
		mapFile:     "jdip1900/map.svg",
		unreachable: map[string]bool{"dum": true},
		moves: map[godip.Nation][3]string{
			jdip1900.Germany: {"ber", "Move", "sil"},
			jdip1900.Austria: {"vie", "Move", "boh"},
		},
	},
	{
		name:        "SailHo",
		variant:     sailho.SailHoVariant,
		source:      "../tools/jdip-import/source/sailho",
		adjacency:   "sailho_adjacency.xml",
		variants:    "variants.xml",
		xmlName:     "Sail Ho!",
		mapFile:     "sailho/map.svg",
		unreachable: map[string]bool{},
		moves: map[godip.Nation][3]string{
			sailho.North: {"her", "Move", "alc"},
			sailho.East:  {"cen", "Move", "sis"},
		},
	},
}

// --------------------------------------------------------------- XML input

type xmlAdjacency struct {
	Type string `xml:"type,attr"`
	Refs string `xml:"refs,attr"`
}

type xmlUniqueName struct {
	Name string `xml:"name,attr"`
}

type xmlProvince struct {
	Shortname   string          `xml:"shortname,attr"`
	Fullname    string          `xml:"fullname,attr"`
	UniqueNames []xmlUniqueName `xml:"UNIQUENAME"`
	Adjacencies []xmlAdjacency  `xml:"ADJACENCY"`
}

type xmlProvinces struct {
	Provinces []xmlProvince `xml:"PROVINCE"`
}

type xmlVariant struct {
	Name   string `xml:"name,attr"`
	Powers []struct {
		Name   string `xml:"name,attr"`
		Active string `xml:"active,attr"`
	} `xml:"POWER"`
	Victory struct {
		WinningSCs struct {
			Value string `xml:"value,attr"`
		} `xml:"WINNING_SUPPLY_CENTERS"`
	} `xml:"VICTORYCONDITIONS"`
	SupplyCenters []struct {
		Province  string `xml:"province,attr"`
		Homepower string `xml:"homepower,attr"`
		Owner     string `xml:"owner,attr"`
	} `xml:"SUPPLYCENTER"`
	InitialStates []struct {
		Province  string `xml:"province,attr"`
		Power     string `xml:"power,attr"`
		Unit      string `xml:"unit,attr"`
		Unitcoast string `xml:"unitcoast,attr"`
	} `xml:"INITIALSTATE"`
}

type xmlVariants struct {
	Variants []xmlVariant `xml:"VARIANT"`
}

func decode(t *testing.T, path string, into interface{}) {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %v: %v", path, err)
	}
	body := string(raw)
	if start := strings.Index(body, "<!DOCTYPE"); start >= 0 {
		if end := strings.Index(body[start:], "]>"); end >= 0 {
			body = body[:start] + body[start+end+2:]
		}
	}
	decoder := xml.NewDecoder(strings.NewReader(body))
	decoder.Strict = false
	decoder.Entity = xml.HTMLEntity
	if err := decoder.Decode(into); err != nil {
		t.Fatalf("decode %v: %v", path, err)
	}
}

var coastCodes = map[string]bool{"nc": true, "sc": true, "ec": true, "wc": true}

// key turns a jDip reference into a godip province key, resolving the
// UNIQUENAME aliases jDip allows in refs.
func key(ref string, alias map[string]string) (godip.Province, bool) {
	base, coast := ref, ""
	if cut := strings.LastIndexAny(ref, "-/"); cut >= 0 && coastCodes[ref[cut+1:]] {
		base, coast = ref[:cut], ref[cut+1:]
	}
	canonical, ok := alias[strings.ToLower(base)]
	if !ok {
		return "", false
	}
	if coast == "" {
		return godip.Province(canonical), true
	}
	return godip.Province(canonical + "/" + coast), true
}

// ------------------------------------------------------------------- tests

// TestGraphMatchesSource walks the jDip adjacency file and asserts that
// every edge it declares exists in the generated graph with the right unit
// type, that no reference dangles, and that edges the XML declares from
// both sides are bidirectional.
func TestGraphMatchesSource(t *testing.T) {
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			doc := xmlProvinces{}
			decode(t, filepath.Join(c.source, c.adjacency), &doc)
			if len(doc.Provinces) == 0 {
				t.Fatal("the adjacency file declares no provinces")
			}

			alias := map[string]string{}
			for _, p := range doc.Provinces {
				alias[strings.ToLower(p.Shortname)] = p.Shortname
			}
			for _, p := range doc.Provinces {
				for _, u := range p.UniqueNames {
					name := strings.ToLower(strings.TrimSpace(u.Name))
					if _, taken := alias[name]; name != "" && !taken {
						alias[name] = p.Shortname
					}
				}
			}

			graph := c.variant.Graph()

			// Every declared edge must be in the graph, flagged for the
			// unit type the adjacency type says.
			declared := map[[2]godip.Province]bool{}
			for _, p := range doc.Provinces {
				from := godip.Province(p.Shortname)
				if !graph.Has(from) {
					t.Errorf("%v is in the XML but not in the graph", from)
					continue
				}
				for _, adj := range p.Adjacencies {
					kind := strings.TrimSpace(adj.Type)
					src := from
					want := godip.Land
					switch {
					case kind == "" || kind == "mv":
						want = godip.Land
					case kind == "xc":
						want = godip.Sea
					case coastCodes[kind]:
						src = godip.Province(p.Shortname + "/" + kind)
						want = godip.Sea
						if !graph.Has(src) {
							t.Errorf("%v is declared in the XML but not in the graph", src)
							continue
						}
					default:
						t.Errorf("%v: unknown adjacency type %q", from, kind)
						continue
					}
					for _, ref := range strings.Fields(adj.Refs) {
						to, ok := key(ref, alias)
						if !ok {
							t.Errorf("%v refers to %v, which is not a province", src, ref)
							continue
						}
						if !graph.Has(to) {
							t.Errorf("%v refers to %v, which is not in the graph", src, ref)
							continue
						}
						if to == src {
							// A self-reference; the translator drops it on
							// purpose and reports it.
							continue
						}
						flags := graph.Edges(src, false)[to]
						if flags == nil {
							t.Errorf("the graph has no edge %v -> %v, which the XML declares", src, to)
							continue
						}
						if !flags[want] {
							t.Errorf("edge %v -> %v is missing the %v flag", src, to, want)
						}
						declared[[2]godip.Province{src, to}] = true
					}
				}
			}

			// jDip declares each border from both sides. Where it does,
			// the graph must carry both directions.
			for pair := range declared {
				reverse := [2]godip.Province{pair[1], pair[0]}
				if !declared[reverse] {
					continue
				}
				if graph.Edges(pair[1], false)[pair[0]] == nil {
					t.Errorf("the XML declares %v <-> %v but the graph has only one direction", pair[0], pair[1])
				}
			}

			// No edge may point at a province the graph does not know.
			for _, prov := range graph.Provinces() {
				for to := range graph.Edges(prov, false) {
					if !graph.Has(to) {
						t.Errorf("%v has an edge to unknown province %v", prov, to)
					}
				}
				if len(graph.Edges(prov, false)) == 0 && !c.unreachable[string(prov)] {
					t.Errorf("%v has no neighbours and is not a known placeholder", prov)
				}
			}
		})
	}
}

// TestStartMatchesSource asserts that the starting units, their owners and
// the supply center counts all match the jDip variants file, and that every
// starting unit stands somewhere it is legally allowed to be.
func TestStartMatchesSource(t *testing.T) {
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			doc := xmlVariants{}
			decode(t, filepath.Join(c.source, c.variants), &doc)
			var source *xmlVariant
			for i := range doc.Variants {
				if doc.Variants[i].Name == c.xmlName {
					source = &doc.Variants[i]
				}
			}
			if source == nil {
				t.Fatalf("no VARIANT named %q", c.xmlName)
			}

			// Powers.
			wantPowers := []string{}
			for _, p := range source.Powers {
				if !strings.EqualFold(p.Active, "false") {
					wantPowers = append(wantPowers, p.Name)
				}
			}
			gotPowers := []string{}
			for _, n := range c.variant.Nations {
				gotPowers = append(gotPowers, string(n))
			}
			sort.Strings(wantPowers)
			sort.Strings(gotPowers)
			if strings.Join(wantPowers, ",") != strings.Join(gotPowers, ",") {
				t.Errorf("powers: want %v, got %v", wantPowers, gotPowers)
			}

			state, err := c.variant.Start()
			if err != nil {
				t.Fatalf("Start: %v", err)
			}
			graph := state.Graph()

			// Supply center count and ownership.
			if want, got := len(source.SupplyCenters), len(graph.AllSCs()); want != got {
				t.Errorf("supply centers: the XML declares %v, the graph has %v", want, got)
			}
			wantOwned := map[godip.Province]string{}
			for _, sc := range source.SupplyCenters {
				if owner := strings.TrimSpace(sc.Owner); owner != "" {
					wantOwned[godip.Province(sc.Province)] = strings.ToLower(owner)
				}
			}
			gotOwned := state.SupplyCenters()
			if len(wantOwned) != len(gotOwned) {
				t.Errorf("owned centers: the XML declares %v, the start has %v", len(wantOwned), len(gotOwned))
			}
			for prov, owner := range wantOwned {
				got, ok := gotOwned[prov]
				if !ok {
					t.Errorf("%v is owned in the XML but unowned at start", prov)
					continue
				}
				if !strings.EqualFold(string(got), owner) && !strings.EqualFold(alias1900(string(got)), owner) {
					t.Errorf("%v: the XML says %v owns it, the start says %v", prov, owner, got)
				}
			}

			// Solo target.
			wantSolo, err := strconv.Atoi(strings.TrimSpace(source.Victory.WinningSCs.Value))
			if err != nil {
				t.Fatalf("WINNING_SUPPLY_CENTERS: %v", err)
			}
			if got := c.variant.SoloSCCount(state); got != wantSolo {
				t.Errorf("solo target: want %v, got %v", wantSolo, got)
			}

			// Starting units: count, position and legality.
			units := state.Units()
			if want, got := len(source.InitialStates), len(units); want != got {
				t.Errorf("starting units: the XML declares %v, the start has %v", want, got)
			}
			for _, is := range source.InitialStates {
				at := godip.Province(is.Province)
				if coast := strings.TrimSpace(is.Unitcoast); coast != "" {
					at = godip.Province(is.Province + "/" + coast)
				}
				unit, _, ok := state.Unit(at)
				if !ok {
					t.Errorf("no unit at %v, which the XML starts one in", at)
					continue
				}
				wantType := godip.Army
				if strings.EqualFold(is.Unit, "fleet") {
					wantType = godip.Fleet
				}
				if unit.Type != wantType {
					t.Errorf("%v: the XML starts a %v, the graph has a %v", at, wantType, unit.Type)
				}
				// A unit must stand on terrain of its own kind.
				flags := graph.Flags(at)
				if wantType == godip.Army && !flags[godip.Land] {
					t.Errorf("army at %v, which is not land", at)
				}
				if wantType == godip.Fleet && !flags[godip.Sea] {
					t.Errorf("fleet at %v, which is not sea or coast", at)
				}
			}
		})
	}
}

// alias1900 maps a godip power name back to the lower-case name jDip's
// supply center rows use, where the two differ.
func alias1900(name string) string {
	switch name {
	case "Britain":
		return "britain"
	default:
		return strings.ToLower(name)
	}
}

// TestPlaythrough gives two powers a legal move each and adjudicates,
// which is the smallest end-to-end proof that godip accepts the variant.
func TestPlaythrough(t *testing.T) {
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			state, err := c.variant.Start()
			if err != nil {
				t.Fatalf("Start: %v", err)
			}

			orders := map[godip.Province]godip.Adjudicator{}
			for nation, move := range c.moves {
				from := godip.Province(move[0])
				unit, _, ok := state.Unit(from)
				if !ok {
					t.Fatalf("no unit in %v to order", from)
				}
				if unit.Nation != nation {
					t.Fatalf("%v holds a %v unit, not %v", from, unit.Nation, nation)
				}
				// The move must be one the options tree offers, so the
				// test cannot pass on an order no player could give.
				options := state.Phase().Options(state, nation)[from]
				targets := options[godip.OrderType(move[1])][godip.SrcProvince(from)]
				if _, legal := targets[godip.Province(move[2])]; !legal {
					t.Fatalf("%v %v %v is not in the options tree for %v",
						move[0], move[1], move[2], nation)
				}
				order, err := c.variant.Parser.Parse([]string{move[0], move[1], move[2]})
				if err != nil {
					t.Fatalf("parse %v: %v", move, err)
				}
				if _, err := order.Validate(state); err != nil {
					t.Fatalf("%v is illegal: %v", move, err)
				}
				orders[from] = order
			}
			state.SetOrders(orders)

			before := state.Phase()
			if err := state.Next(); err != nil {
				t.Fatalf("adjudicate: %v", err)
			}
			if state.Phase() == before {
				t.Error("the phase did not advance")
			}
			for _, move := range c.moves {
				if err := state.Resolutions()[godip.Province(move[0])]; err != nil {
					t.Errorf("%v %v %v resolved as %v, wanted success", move[0], move[1], move[2], err)
				}
				if _, _, ok := state.Unit(godip.Province(move[2])); !ok {
					t.Errorf("nothing arrived in %v", move[2])
				}
			}
		})
	}
}

// TestMapMatchesGraph asserts the converted map can carry the game: every
// province the graph knows has a hit shape and a placement anchor.
func TestMapMatchesGraph(t *testing.T) {
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			raw, err := os.ReadFile(c.mapFile)
			if err != nil {
				t.Fatalf("read %v: %v", c.mapFile, err)
			}
			body := string(raw)
			if strings.Contains(body, "<!DOCTYPE") {
				t.Error("the converted map still carries a DOCTYPE")
			}
			if strings.Contains(body, "jdipNS") {
				t.Error("the converted map still carries jdipNS markup")
			}
			if !strings.Contains(body, `id="provinces"`) {
				t.Fatal("the converted map has no provinces layer")
			}

			for _, prov := range c.variant.Graph().Provinces() {
				id := string(prov)
				if !c.unreachable[id] && !strings.Contains(body, `id="`+id+`"`) {
					t.Errorf("no hit shape for %v", id)
				}
				if !strings.Contains(body, `id="`+id+`Center"`) {
					t.Errorf("no placement anchor for %v", id)
				}
			}
		})
	}
}
