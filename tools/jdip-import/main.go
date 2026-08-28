// Command jdip-import translates a jDip variant into a godip variant.
//
// jDip ships three files per variant: a typed adjacency graph, a variants
// file with powers and starting positions, and a map SVG. This program
// reads all three and writes a Go package under variants1901/{key}/ plus a
// converted map. Generation is a development step, not a build step — the
// output is checked in.
//
//	go run ./tools/jdip-import
//
// What it cannot do is stated plainly: rules that live only in the prose
// description are reported, never guessed at.
package main

import (
	"encoding/xml"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// job describes one variant to translate.
type job struct {
	// key is the output directory name under variants1901/. It is not the
	// URL key: the server derives that from displayName, so "1900" is
	// served at /variants/1900/ while its package lives in jdip1900/ —
	// a Go package name may not start with a digit.
	key string
	// pkg is the Go package name (it may not start with a digit).
	pkg string
	// ident is the exported prefix for the generated symbols.
	ident string
	// dir is the vendored source directory.
	dir string
	// adjacency, variants, and svg are file names inside dir.
	adjacency string
	variants  string
	svg       string
	// variantName selects one VARIANT element from the variants file.
	variantName string
	// displayName is the name godip and our catalogue show.
	displayName string
	// createdBy is the variant's author, which the XML does not carry.
	createdBy string
	// rules is the short rules summary shown on the variant card.
	rules string
	// notes are carried into the generated file as known limitations.
	notes []string
}

var jobs = []job{
	{
		key:         "jdip1900",
		pkg:         "jdip1900",
		ident:       "Nineteen00",
		dir:         "tools/jdip-import/source/1900",
		adjacency:   "1900_adjacency.xml",
		variants:    "variants.xml",
		svg:         "1900_dipmap.svg",
		variantName: "1900",
		displayName: "1900",
		createdBy:   "Baron Powell and Edi Birsan",
		rules: `First to 18 Supply Centers (SC) is the winner.
Builds are allowed in home centers only, so the African and Asian centers a
power starts with can never build.
Iceland, Ireland and Switzerland are passable.
Armies move between Clyde and Ireland, and between Gibraltar and Morocco,
without a convoy.
Three provinces have named coasts: Spain, Saint Petersburg and Macedonia.
Russia starts owning "Dummy", jDip's off-map center, which no unit can ever
reach or take.`,
		notes: []string{
			"The Suez half-strength and support-blocking rules are prose in jDip's variant description, not data in the adjacency XML. godip has no half-strength move, so they are NOT implemented: Egypt/Hejaz to Mid-Atlantic moves resolve at full strength and may be supported.",
			"YEARS_WITHOUT_SC_CAPTURE (7) and GAME_LENGTH (35) draw conditions are recorded here but not enforced; godip has no game-length machinery.",
			"jDip's variant data carries an off-map placeholder province, dum (\"Dummy\", alias \"Russian Steamroller\"), adjacent only to itself and owned by Russia at start. It is kept so the supply center count matches jDip, but its self-edge is dropped: no unit can enter or leave it.",
		},
	},
	{
		key:         "sailho",
		pkg:         "sailho",
		ident:       "SailHo",
		dir:         "tools/jdip-import/source/sailho",
		adjacency:   "sailho_adjacency.xml",
		variants:    "variants.xml",
		svg:         "sail_ho.svg",
		variantName: "Sail Ho!",
		displayName: "Sail Ho!",
		createdBy:   "Tarzan",
		rules: `First to 9 of the 16 Supply Centers (SC) is the winner.
Four powers, two home centers each; the other eight centers are neutral.
Half the centers sit on islands, so convoys decide the game.
Two provinces have named coasts: Hesperides and Psyche's Isle.`,
		notes: []string{
			"Sail Ho! declares no RULEOPTIONS, so standard Diplomacy rules apply throughout and nothing needed hand work.",
		},
	},
	{
		key:         "sailhocrowded",
		pkg:         "sailhocrowded",
		ident:       "SailHoCrowded",
		dir:         "tools/jdip-import/source/sailho",
		adjacency:   "sailho_adjacency.xml",
		variants:    "variants.xml",
		svg:         "sail_ho.svg",
		variantName: "Sail Ho! Crowded",
		displayName: "Sail Ho! Crowded",
		createdBy:   "Tarzan",
		rules: `Sail Ho! with six powers on the same 60-province island map.
Convoys decide the game; expect early contact.`,
		notes: []string{
			"Same map and adjacency as Sail Ho!; only powers, starting units and center ownership differ.",
		},
	},
}

const outputRoot = "variants1901"

func main() {
	log.SetFlags(0)
	root, err := repoRoot()
	if err != nil {
		log.Fatal(err)
	}
	for _, j := range jobs {
		if err := run(root, j); err != nil {
			log.Fatalf("%v: %v", j.key, err)
		}
	}
}

// repoRoot walks up from the working directory to the module root.
func repoRoot() (string, error) {
	dir, err := os.Getwd()
	if err != nil {
		return "", err
	}
	for {
		if _, err := os.Stat(filepath.Join(dir, "go.mod")); err == nil {
			return dir, nil
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return "", fmt.Errorf("no go.mod above the working directory")
		}
		dir = parent
	}
}

func run(root string, j job) error {
	src := filepath.Join(root, j.dir)

	provinces, err := readAdjacency(filepath.Join(src, j.adjacency))
	if err != nil {
		return err
	}
	variant, err := readVariant(filepath.Join(src, j.variants), j.variantName)
	if err != nil {
		return err
	}
	model, err := build(j, provinces, variant)
	if err != nil {
		return err
	}

	out := filepath.Join(root, outputRoot, j.key)
	if err := os.MkdirAll(out, 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(out, j.pkg+".go"), []byte(renderGo(j, model)), 0o644); err != nil {
		return err
	}

	svg, report, err := convertSVG(filepath.Join(src, j.svg), model)
	if err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(out, "map.svg"), []byte(svg), 0o644); err != nil {
		return err
	}

	log.Printf("%v: %v provinces (%v with named coasts), %v powers, %v supply centers, %v starting units",
		j.key, len(model.order), model.coastCount(), len(model.powers), len(model.scOwner)+model.neutralSCs(), len(model.units))
	for _, line := range append(model.notes, report...) {
		log.Printf("%v:   %v", j.key, line)
	}
	return nil
}

// ---------------------------------------------------------------- adjacency

type xmlAdjacency struct {
	Type string `xml:"type,attr"`
	Refs string `xml:"refs,attr"`
}

type xmlUniqueName struct {
	Name string `xml:"name,attr"`
}

type xmlProvince struct {
	Shortname         string          `xml:"shortname,attr"`
	Fullname          string          `xml:"fullname,attr"`
	IsConvoyableCoast string          `xml:"isConvoyableCoast,attr"`
	UniqueNames       []xmlUniqueName `xml:"UNIQUENAME"`
	Adjacencies       []xmlAdjacency  `xml:"ADJACENCY"`
}

type xmlProvinces struct {
	Provinces []xmlProvince `xml:"PROVINCE"`
}

func readAdjacency(path string) ([]xmlProvince, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	doc := xmlProvinces{}
	if err := unmarshal(stripDoctype(string(raw)), &doc); err != nil {
		return nil, fmt.Errorf("%v: %v", path, err)
	}
	if len(doc.Provinces) == 0 {
		return nil, fmt.Errorf("%v: no PROVINCE elements", path)
	}
	return doc.Provinces, nil
}

// ----------------------------------------------------------------- variants

type xmlPower struct {
	Name     string `xml:"name,attr"`
	Active   string `xml:"active,attr"`
	Altnames string `xml:"altnames,attr"`
}

type xmlSupplyCenter struct {
	Province  string `xml:"province,attr"`
	Homepower string `xml:"homepower,attr"`
	Owner     string `xml:"owner,attr"`
}

type xmlInitialState struct {
	Province  string `xml:"province,attr"`
	Power     string `xml:"power,attr"`
	Unit      string `xml:"unit,attr"`
	Unitcoast string `xml:"unitcoast,attr"`
}

type xmlRuleOption struct {
	Name  string `xml:"name,attr"`
	Value string `xml:"value,attr"`
}

type xmlVariant struct {
	Name        string          `xml:"name,attr"`
	Version     string          `xml:"version,attr"`
	Description string          `xml:"DESCRIPTION"`
	RuleOptions []xmlRuleOption `xml:"RULEOPTIONS>RULEOPTION"`
	Powers      []xmlPower      `xml:"POWER"`
	StartTurn   struct {
		Turn string `xml:"turn,attr"`
	} `xml:"STARTINGTIME"`
	Victory struct {
		WinningSCs struct {
			Value string `xml:"value,attr"`
		} `xml:"WINNING_SUPPLY_CENTERS"`
		YearsWithout struct {
			Value string `xml:"value,attr"`
		} `xml:"YEARS_WITHOUT_SC_CAPTURE"`
		GameLength struct {
			Value string `xml:"value,attr"`
		} `xml:"GAME_LENGTH"`
	} `xml:"VICTORYCONDITIONS"`
	SupplyCenters []xmlSupplyCenter `xml:"SUPPLYCENTER"`
	InitialStates []xmlInitialState `xml:"INITIALSTATE"`
}

type xmlVariants struct {
	Variants []xmlVariant `xml:"VARIANT"`
}

func readVariant(path, name string) (*xmlVariant, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	doc := xmlVariants{}
	if err := unmarshal(stripDoctype(string(raw)), &doc); err != nil {
		return nil, fmt.Errorf("%v: %v", path, err)
	}
	for i := range doc.Variants {
		if doc.Variants[i].Name == name {
			return &doc.Variants[i], nil
		}
	}
	names := []string{}
	for _, v := range doc.Variants {
		names = append(names, v.Name)
	}
	return nil, fmt.Errorf("%v: no VARIANT named %q (have %v)", path, name, names)
}

func unmarshal(body string, into interface{}) error {
	decoder := xml.NewDecoder(strings.NewReader(body))
	decoder.Strict = false
	decoder.Entity = xml.HTMLEntity
	return decoder.Decode(into)
}

// stripDoctype removes the DOCTYPE declaration and its internal subset.
// Go's XML decoder will not expand the entities jDip declares there, and
// nothing downstream needs them.
func stripDoctype(body string) string {
	start := strings.Index(body, "<!DOCTYPE")
	if start < 0 {
		return body
	}
	rest := body[start:]
	if open := strings.Index(rest, "["); open >= 0 && open < strings.Index(rest+">", ">") {
		if close := strings.Index(rest, "]>"); close >= 0 {
			return body[:start] + rest[close+2:]
		}
	}
	if end := strings.Index(rest, ">"); end >= 0 {
		return body[:start] + rest[end+1:]
	}
	return body
}

// -------------------------------------------------------------------- model

// coastCodes are the jDip adjacency types that name a coast.
var coastCodes = map[string]bool{"nc": true, "sc": true, "ec": true, "wc": true}

// province is one node of the translated graph.
type province struct {
	key        string
	name       string
	land       []string // army edges
	sea        []string // fleet edges along the single coast
	coasts     map[string][]string
	convoyable bool
}

// hasCoasts reports whether the province carries named coasts.
func (self *province) hasCoasts() bool { return len(self.coasts) > 0 }

// model is everything the generator needs.
type model struct {
	job       job
	provinces map[string]*province
	order     []string // province keys, sorted
	// alias maps every lower-case name jDip accepts for a province — its
	// shortname and each UNIQUENAME — to the shortname.
	alias map[string]string

	powers    []string          // canonical display names, in file order
	powerOf   map[string]string // lower-case key -> display name
	homeSC    map[string]string // province -> home power ("" means neutral)
	scOwner   map[string]string // province -> owner at start
	units     map[string]unit   // province (with coast) -> unit
	unitOrder []string

	season    string
	year      int
	winningSC int

	// notes are anomalies found while translating, reported to the operator.
	notes []string

	description         string
	ruleOptions         []xmlRuleOption
	yearsWithoutCapture string
	gameLength          string
}

type unit struct {
	kind  string // "Army" or "Fleet"
	power string
}

func (self *model) coastCount() int {
	n := 0
	for _, p := range self.provinces {
		if p.hasCoasts() {
			n++
		}
	}
	return n
}

func (self *model) neutralSCs() int {
	n := 0
	for prov := range self.homeSC {
		if _, owned := self.scOwner[prov]; !owned {
			n++
		}
	}
	return n
}

func build(j job, raw []xmlProvince, variant *xmlVariant) (*model, error) {
	m := &model{
		job:                 j,
		provinces:           map[string]*province{},
		alias:               map[string]string{},
		powerOf:             map[string]string{},
		homeSC:              map[string]string{},
		scOwner:             map[string]string{},
		units:               map[string]unit{},
		description:         cleanDescription(variant.Description),
		ruleOptions:         variant.RuleOptions,
		yearsWithoutCapture: variant.Victory.YearsWithout.Value,
		gameLength:          variant.Victory.GameLength.Value,
	}

	for _, rp := range raw {
		key := strings.TrimSpace(rp.Shortname)
		if key == "" {
			return nil, fmt.Errorf("a PROVINCE has no shortname")
		}
		if _, twice := m.provinces[key]; twice {
			return nil, fmt.Errorf("province %v is declared twice", key)
		}
		p := &province{
			key:        key,
			name:       strings.TrimSpace(rp.Fullname),
			coasts:     map[string][]string{},
			convoyable: strings.EqualFold(strings.TrimSpace(rp.IsConvoyableCoast), "true"),
		}
		for _, adj := range rp.Adjacencies {
			refs := refsOf(adj.Refs)
			switch t := strings.TrimSpace(adj.Type); {
			case t == "" || t == "mv":
				p.land = append(p.land, refs...)
			case t == "xc":
				p.sea = append(p.sea, refs...)
			case coastCodes[t]:
				p.coasts[t] = append(p.coasts[t], refs...)
			default:
				return nil, fmt.Errorf("province %v: unknown adjacency type %q", key, t)
			}
		}
		m.provinces[key] = p
		m.order = append(m.order, key)
	}
	sort.Strings(m.order)

	// A shortname always wins; UNIQUENAME aliases fill in the rest. jDip's
	// own data uses them in refs (1900 writes "mao" for "mid").
	for _, key := range m.order {
		m.alias[strings.ToLower(key)] = key
	}
	for _, rp := range raw {
		key := strings.TrimSpace(rp.Shortname)
		for _, alias := range rp.UniqueNames {
			name := strings.ToLower(strings.TrimSpace(alias.Name))
			if name == "" {
				continue
			}
			if _, taken := m.alias[name]; taken {
				continue
			}
			m.alias[name] = key
		}
	}

	// Rewrite every reference to the canonical shortname, and drop the
	// self-references jDip uses for placeholder provinces: godip has no
	// notion of a province adjacent to itself.
	for _, key := range m.order {
		p := m.provinces[key]
		resolve := func(list []string, from string) ([]string, error) {
			out := []string{}
			for _, ref := range list {
				base, coast := splitCoast(ref)
				canonical, ok := m.alias[strings.ToLower(base)]
				if !ok {
					return nil, fmt.Errorf("%v refers to unknown province %v", from, ref)
				}
				if canonical == key && coast == "" {
					m.notes = append(m.notes, fmt.Sprintf("%v lists itself as adjacent; the edge is dropped", key))
					continue
				}
				if coast == "" {
					out = append(out, canonical)
				} else {
					out = append(out, canonical+"-"+coast)
				}
			}
			return out, nil
		}
		var err error
		if p.land, err = resolve(p.land, key+" mv"); err != nil {
			return nil, err
		}
		if p.sea, err = resolve(p.sea, key+" xc"); err != nil {
			return nil, err
		}
		for code, refs := range p.coasts {
			if p.coasts[code], err = resolve(refs, key+" "+code); err != nil {
				return nil, err
			}
		}
		if len(p.land) == 0 && len(p.sea) == 0 && !p.hasCoasts() {
			m.notes = append(m.notes, fmt.Sprintf("%v (%v) has no neighbours; it stays on the board but no unit can enter or leave it", key, p.name))
		}
	}

	// Every reference must resolve, coasts included.
	for _, key := range m.order {
		p := m.provinces[key]
		check := func(list []string, from string) error {
			for _, ref := range list {
				base, coast := splitCoast(ref)
				target, found := m.provinces[base]
				if !found {
					return fmt.Errorf("%v refers to unknown province %v", from, ref)
				}
				if coast != "" {
					if _, ok := target.coasts[coast]; !ok {
						return fmt.Errorf("%v refers to %v, but %v declares no %v coast", from, ref, base, coast)
					}
				}
			}
			return nil
		}
		if err := check(p.land, key+" mv"); err != nil {
			return nil, err
		}
		if err := check(p.sea, key+" xc"); err != nil {
			return nil, err
		}
		for code, refs := range p.coasts {
			if err := check(refs, key+" "+code); err != nil {
				return nil, err
			}
		}
	}

	for _, power := range variant.Powers {
		if strings.EqualFold(power.Active, "false") {
			continue
		}
		name := strings.TrimSpace(power.Name)
		m.powers = append(m.powers, name)
		m.powerOf[strings.ToLower(name)] = name
		for _, alt := range refsOf(strings.ReplaceAll(power.Altnames, ",", " ")) {
			m.powerOf[strings.ToLower(alt)] = name
		}
	}
	if len(m.powers) == 0 {
		return nil, fmt.Errorf("the variant declares no active powers")
	}

	for _, sc := range variant.SupplyCenters {
		prov := strings.TrimSpace(sc.Province)
		if _, found := m.provinces[prov]; !found {
			return nil, fmt.Errorf("supply center in unknown province %v", prov)
		}
		home := ""
		if raw := strings.TrimSpace(sc.Homepower); raw != "" {
			resolved, ok := m.powerOf[strings.ToLower(raw)]
			if !ok {
				return nil, fmt.Errorf("supply center %v names unknown power %v", prov, raw)
			}
			home = resolved
		}
		m.homeSC[prov] = home
		if raw := strings.TrimSpace(sc.Owner); raw != "" {
			resolved, ok := m.powerOf[strings.ToLower(raw)]
			if !ok {
				return nil, fmt.Errorf("supply center %v names unknown owner %v", prov, raw)
			}
			m.scOwner[prov] = resolved
		}
	}

	for _, is := range variant.InitialStates {
		prov := strings.TrimSpace(is.Province)
		base, found := m.provinces[prov]
		if !found {
			return nil, fmt.Errorf("starting unit in unknown province %v", prov)
		}
		power, ok := m.powerOf[strings.ToLower(strings.TrimSpace(is.Power))]
		if !ok {
			return nil, fmt.Errorf("starting unit in %v names unknown power %v", prov, is.Power)
		}
		kind := ""
		switch strings.ToLower(strings.TrimSpace(is.Unit)) {
		case "army":
			kind = "Army"
		case "fleet":
			kind = "Fleet"
		default:
			return nil, fmt.Errorf("starting unit in %v has unknown type %q", prov, is.Unit)
		}
		at := prov
		if coast := strings.TrimSpace(is.Unitcoast); coast != "" {
			if _, ok := base.coasts[coast]; !ok {
				return nil, fmt.Errorf("starting unit in %v names coast %v, which is not declared", prov, coast)
			}
			at = prov + "/" + coast
		}
		if kind == "Fleet" && at == prov && len(base.sea) == 0 && base.hasCoasts() {
			return nil, fmt.Errorf("fleet in %v needs a unitcoast: the province has named coasts", prov)
		}
		if kind == "Army" && len(base.land) == 0 {
			return nil, fmt.Errorf("army in %v, which no army can reach", prov)
		}
		m.units[at] = unit{kind: kind, power: power}
		m.unitOrder = append(m.unitOrder, at)
	}
	sort.Strings(m.unitOrder)

	season, year, err := parseTurn(variant.StartTurn.Turn)
	if err != nil {
		return nil, err
	}
	m.season, m.year = season, year

	m.winningSC, err = strconv.Atoi(strings.TrimSpace(variant.Victory.WinningSCs.Value))
	if err != nil {
		return nil, fmt.Errorf("WINNING_SUPPLY_CENTERS: %v", err)
	}
	return m, nil
}

// refsOf splits a whitespace-separated refs attribute.
func refsOf(raw string) []string {
	out := []string{}
	for _, field := range strings.Fields(raw) {
		if field != "" {
			out = append(out, field)
		}
	}
	return out
}

// splitCoast turns a jDip reference into province and coast. The two pilot
// variants disagree on the separator — 1900 writes "mac-wc", Sail Ho writes
// "psy/wc" — so both are accepted. A separator not followed by a coast code
// belongs to the province name.
func splitCoast(ref string) (string, string) {
	cut := strings.LastIndexAny(ref, "-/")
	if cut < 0 {
		return ref, ""
	}
	code := ref[cut+1:]
	if !coastCodes[code] {
		return ref, ""
	}
	return ref[:cut], code
}

// godipRef turns a jDip reference into a godip province key.
func godipRef(ref string) string {
	base, coast := splitCoast(ref)
	if coast == "" {
		return base
	}
	return base + "/" + coast
}

// parseTurn reads jDip's "Spring, 1900, Movement" starting time.
func parseTurn(raw string) (string, int, error) {
	fields := strings.FieldsFunc(raw, func(r rune) bool {
		return r == ',' || r == ' ' || r == '\t'
	})
	season, year := "", 0
	for _, field := range fields {
		switch strings.ToLower(field) {
		case "spring":
			season = "Spring"
		case "fall", "autumn":
			season = "Fall"
		default:
			if n, err := strconv.Atoi(field); err == nil {
				year = n
			}
		}
	}
	if season == "" || year == 0 {
		return "", 0, fmt.Errorf("cannot read starting turn %q", raw)
	}
	return season, year, nil
}

var tagPattern = regexp.MustCompile(`(?s)<[^>]*>`)
var spacePattern = regexp.MustCompile(`\s+`)

// cleanDescription flattens jDip's HTML description into one paragraph.
func cleanDescription(raw string) string {
	text := tagPattern.ReplaceAllString(raw, " ")
	text = strings.ReplaceAll(text, "&nbsp;", " ")
	text = spacePattern.ReplaceAllString(text, " ")
	text = strings.TrimSpace(text)
	// The card shows a summary, not the full rules sheet.
	if cut := strings.Index(text, " Rules "); cut > 0 {
		text = text[:cut]
	}
	if len(text) > 400 {
		if cut := strings.LastIndex(text[:400], ". "); cut > 0 {
			text = text[:cut+1]
		} else {
			text = text[:400]
		}
	}
	return strings.TrimSpace(text)
}
