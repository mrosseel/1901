package svground

import (
	"math"
	"strings"
	"testing"
)

func TestTrailingZerosAreStripped(t *testing.T) {
	cases := map[string]string{
		`<path d="M 1234.50 1234.00"/>`: `<path d="M1234.5 1234"/>`,
		`<path d="M 0.005 -0.004"/>`:    `<path d="M0.01 0"/>`,
		`<path d="M 3.4406685e-4 5"/>`:  `<path d="M0 5"/>`,
	}
	for in, want := range cases {
		if got := string(Art([]byte(in))); got != want {
			t.Errorf("Art(%v) = %v, want %v", in, got, want)
		}
	}
}

func TestOnlyGeometryAttributesAreTouched(t *testing.T) {
	// Every number here is one that two decimals would ruin, or one that is
	// not geometry at all. None of them may move.
	art := `<svg viewBox="0 0 1524.4444 1357.7777">` +
		`<g transform="translate(-0.00514694,3.4406685e-4) scale(0.001)" ` +
		`patternTransform="scale(0.0005)" style="stroke-width:0.264583;opacity:0.05">` +
		`<stop offset="0.333333" stop-opacity="0.125"/>` +
		`<rect fill-opacity="0.001" x="1.23456" width="2.34567"/>` +
		`</g></svg>`
	if got := string(Art([]byte(art))); got != art {
		t.Errorf("Art rewrote something outside d and points:\n%v\n%v", art, got)
	}
}

func TestPointsAreRounded(t *testing.T) {
	in := `<polygon points="1.23456,7.89 -0.004 2"/>`
	want := `<polygon points="1.23 7.89 0 2"/>`
	if got := string(Art([]byte(in))); got != want {
		t.Errorf("Art = %v, want %v", got, want)
	}
}

// walk replays a path's absolute endpoints, so a rounded path can be compared
// against the one it came from.
func walk(t *testing.T, d string) []float64 {
	t.Helper()
	tokens, ok := tokenizePath(d)
	if !ok {
		t.Fatalf("cannot read path %q", d)
	}
	out := []float64{}
	x, y, startX, startY := 0.0, 0.0, 0.0, 0.0
	at := 0
	for at < len(tokens) {
		command := tokens[at].letter
		at++
		kind := lower(command)
		relative := command >= 'a' && command <= 'z'
		arity := pathArity[kind]
		if arity == 0 {
			x, y = startX, startY
			out = append(out, x, y)
			continue
		}
		first := true
		for at < len(tokens) && tokens[at].letter == 0 {
			group := make([]float64, arity)
			for i := range group {
				group[i] = tokens[at+i].number
			}
			at += arity
			var dx, dy float64
			switch kind {
			case 'm', 'l', 't':
				dx, dy = group[0], group[1]
			case 'h':
				dx, dy = group[0], 0
				if !relative {
					dy = y
				}
			case 'v':
				dx, dy = 0, group[0]
				if !relative {
					dx = x
				}
			case 'c':
				dx, dy = group[4], group[5]
			case 's', 'q':
				dx, dy = group[2], group[3]
			case 'a':
				dx, dy = group[5], group[6]
			}
			if relative {
				x, y = x+dx, y+dy
			} else {
				x, y = dx, dy
			}
			if kind == 'm' && first {
				startX, startY = x, y
			}
			first = false
			out = append(out, x, y)
			if kind == 'm' {
				kind, arity = 'l', 2
			}
		}
	}
	return out
}

func TestRelativePathsDoNotDrift(t *testing.T) {
	// A thousand relative steps that each round the wrong way would walk five
	// units off the map. The residual carry is what stops that.
	parts := []string{"m 0,0"}
	for i := 0; i < 1000; i++ {
		parts = append(parts, "l 0.994999,0.994999")
	}
	in := strings.Join(parts, " ")
	rounded, ok := roundPath(in)
	if !ok {
		t.Fatal("roundPath refused a path it should read")
	}
	before, after := walk(t, in), walk(t, rounded)
	worst := 0.0
	for i := range before {
		worst = math.Max(worst, math.Abs(before[i]-after[i]))
	}
	if worst > 0.005001 {
		t.Errorf("endpoints drifted by %v units", worst)
	}
}

func TestUnreadableGeometryIsLeftAlone(t *testing.T) {
	for _, art := range []string{
		`<path d="M 1 2 W 3 4"/>`,
		`<path d="1 2 3"/>`,
		`<path d="M 1 2 L 3"/>`,
		`<polygon points="1 2 3"/>`,
	} {
		if got := string(Art([]byte(art))); got != art {
			t.Errorf("Art rewrote %v as %v", art, got)
		}
	}
}

func TestRoundingIsIdempotent(t *testing.T) {
	art := []byte(`<path d="m 10.123456,20.987654 c 0.5,0.25 1.005,2.004 3.3333,4.6666 z"/>`)
	once := Art(art)
	if twice := Art(once); string(twice) != string(once) {
		t.Errorf("a second pass changed the art:\n%s\n%s", once, twice)
	}
}
