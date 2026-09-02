package svgprune

// Every test here is a way a definition is reached. What the package must
// never do is drop one of these; dropping an orphan is the easy half.

import (
	"strings"
	"testing"
)

func prune(t *testing.T, svg string, roots ...string) (string, []string) {
	t.Helper()
	out, dropped := Art([]byte(svg), roots)
	return string(out), dropped
}

func mustKeep(t *testing.T, out string, ids ...string) {
	t.Helper()
	for _, id := range ids {
		if !strings.Contains(out, `id="`+id+`"`) {
			t.Errorf("%q was reachable and must survive:\n%s", id, out)
		}
	}
}

func mustDrop(t *testing.T, out string, ids ...string) {
	t.Helper()
	for _, id := range ids {
		if strings.Contains(out, `id="`+id+`"`) {
			t.Errorf("%q is unreachable and must go:\n%s", id, out)
		}
	}
}

func TestDropsAnOrphanPattern(t *testing.T) {
	out, dropped := prune(t, `<svg><defs>`+
		`<pattern id="used"><rect id="tile"/></pattern>`+
		`<pattern id="orphan"><rect id="dead"/></pattern>`+
		`</defs><rect id="sea" fill="url(#used)"/></svg>`)
	mustKeep(t, out, "used", "tile", "sea")
	mustDrop(t, out, "orphan", "dead")
	if len(dropped) != 1 || dropped[0] != "orphan" {
		t.Errorf("dropped ids = %v, want [orphan]", dropped)
	}
}

// classical's live texture is reached in two hops: a shape names pattern1827,
// which paints nothing itself and inherits its tile from pattern-4-3.
func TestFollowsAPatternInheritingFromAnother(t *testing.T) {
	out, _ := prune(t, `<svg><defs>`+
		`<pattern id="tile"><image id="paper"/></pattern>`+
		`<pattern id="placed" xlink:href="#tile" patternTransform="rotate(3)"/>`+
		`</defs><rect id="land" fill="url(#placed)"/></svg>`)
	mustKeep(t, out, "tile", "paper", "placed")
}

func TestFollowsAUseToItsShape(t *testing.T) {
	out, _ := prune(t, `<svg><defs><path id="curve" d="M 0 0"/>`+
		`<path id="nobody" d="M 1 1"/></defs>`+
		`<use id="copy" href="#curve"/></svg>`)
	mustKeep(t, out, "curve", "copy")
	mustDrop(t, out, "nobody")
}

func TestFollowsAGradientInheritingFromAnother(t *testing.T) {
	out, _ := prune(t, `<svg><defs>`+
		`<linearGradient id="stops"><stop offset="0"/></linearGradient>`+
		`<linearGradient id="placed" href="#stops"/>`+
		`<linearGradient id="orphan"><stop offset="1"/></linearGradient>`+
		`</defs><rect id="sea" fill="url(#placed)"/></svg>`)
	mustKeep(t, out, "stops", "placed")
	mustDrop(t, out, "orphan")
}

// A definition reached only through another definition's own attributes still
// counts: the clip on a pattern's tile is drawn when the pattern is.
func TestFollowsAChainThroughADefinitionsChildren(t *testing.T) {
	out, _ := prune(t, `<svg><defs>`+
		`<clipPath id="window"><rect id="hole"/></clipPath>`+
		`<pattern id="tile"><rect id="paint" clip-path="url(#window)"/></pattern>`+
		`</defs><rect id="land" fill="url(#tile)"/></svg>`)
	mustKeep(t, out, "window", "hole", "tile", "paint")
}

func TestAStylesheetsReferenceCounts(t *testing.T) {
	out, _ := prune(t, `<svg><style>.land { fill: url("#tile"); }</style>`+
		`<defs><pattern id="tile"><rect id="paint"/></pattern>`+
		`<pattern id="orphan"><rect/></pattern></defs>`+
		`<rect id="land" class="land"/></svg>`)
	mustKeep(t, out, "tile", "paint")
	mustDrop(t, out, "orphan")
}

// A style plan holds the hatch it repaints, and no shape in the art need name
// it for the plan to need it there.
func TestARootFromOutsideTheFileIsReached(t *testing.T) {
	out, _ := prune(t, `<svg><defs>`+
		`<pattern id="impassableStripes"><line id="hatch"/></pattern>`+
		`<pattern id="orphan"><rect/></pattern>`+
		`</defs><rect id="land"/></svg>`, "impassableStripes")
	mustKeep(t, out, "impassableStripes", "hatch")
	mustDrop(t, out, "orphan")
}

// Live geometry never renders only on demand, however little points at it.
func TestLeavesThePaintedBoardAlone(t *testing.T) {
	svg := `<svg><g id="provinces"><path id="bud" d="M 0 0"/></g>` +
		`<g id="province-centers"><circle id="budCenter"/></g></svg>`
	out, dropped := prune(t, svg)
	if out != svg || len(dropped) != 0 {
		t.Errorf("nothing here is a definition, so nothing may change:\n%s", out)
	}
}

// A stylesheet paints without being named, so being unreferenced says nothing
// about it. So do a title and a description.
func TestKeepsWhatActsWithoutBeingNamed(t *testing.T) {
	out, _ := prune(t, `<svg><defs>`+
		`<style id="sheet">.a{fill:red}</style><title id="name">Board</title>`+
		`</defs><rect id="land" class="a"/></svg>`)
	mustKeep(t, out, "sheet", "name")
}

// An element with no id could never have been pointed at, but nothing proves
// it was meant as a definition either, so it stays.
func TestKeepsAnUnidentifiedDefinition(t *testing.T) {
	out, dropped := prune(t, `<svg><defs><pattern><rect/></pattern></defs>`+
		`<rect id="land"/></svg>`)
	if len(dropped) != 0 || !strings.Contains(out, "<pattern>") {
		t.Errorf("an element with no id must survive:\n%s", out)
	}
}

func TestRunningTwiceChangesNothingTheSecondTime(t *testing.T) {
	svg := `<svg>
    <defs>
      <pattern id="orphan"><rect/></pattern>
      <pattern id="used"><rect/></pattern>
    </defs>
    <rect id="land" fill="url(#used)"/>
  </svg>`
	once, _ := prune(t, svg)
	twice, dropped := prune(t, once)
	if twice != once || len(dropped) != 0 {
		t.Errorf("a second pass changed the file:\n%s", twice)
	}
}

// Art this package cannot read is art it must not damage.
func TestUnparseableArtIsReturnedWhole(t *testing.T) {
	svg := `<svg><defs><pattern id="orphan">`
	out, dropped := prune(t, svg)
	if out != svg || len(dropped) != 0 {
		t.Errorf("a document that does not parse must come back as it went in: %q", out)
	}
}
