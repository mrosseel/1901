package main

// The sanitiser is the boundary between art that arrived through code review
// and art that arrived as a file. Each test here is a way SVG executes.

import (
	"strings"
	"testing"
)

func sanitize(t *testing.T, raw string) string {
	t.Helper()
	result, err := sanitizeSVG([]byte(raw))
	if err != nil {
		t.Fatalf("sanitizeSVG: %v", err)
	}
	return string(result.Clean)
}

func mustNotContain(t *testing.T, clean string, forbidden ...string) {
	t.Helper()
	lower := strings.ToLower(clean)
	for _, f := range forbidden {
		if strings.Contains(lower, strings.ToLower(f)) {
			t.Errorf("sanitised art still contains %q:\n%s", f, clean)
		}
	}
}

func TestStripsScriptElement(t *testing.T) {
	clean := sanitize(t, `<svg><script>fetch("/steal")</script><g id="provinces"/></svg>`)
	mustNotContain(t, clean, "script", "fetch")
	if !strings.Contains(clean, `id="provinces"`) {
		t.Errorf("dropped the provinces layer with the script:\n%s", clean)
	}
}

func TestStripsEventHandlers(t *testing.T) {
	clean := sanitize(t, `<svg><g id="provinces"><polygon id="adr" onclick="alert(1)" onload="x()" points="0,0"/></g></svg>`)
	mustNotContain(t, clean, "onclick", "onload", "alert")
	if !strings.Contains(clean, `points="0,0"`) {
		t.Errorf("dropped the geometry with the handler:\n%s", clean)
	}
}

func TestStripsForeignObject(t *testing.T) {
	clean := sanitize(t, `<svg><foreignObject><body xmlns="http://www.w3.org/1999/xhtml"><img src=x onerror="alert(1)"></body></foreignObject><g id="provinces"/></svg>`)
	mustNotContain(t, clean, "foreignObject", "onerror", "img")
}

func TestStripsRemoteReferences(t *testing.T) {
	clean := sanitize(t, `<svg><image href="http://evil/x.png"/><use xlink:href="http://evil/y#a"/><g id="provinces"/></svg>`)
	mustNotContain(t, clean, "evil", "http://", "image")
}

func TestStripsJavascriptURLs(t *testing.T) {
	clean := sanitize(t, `<svg><g id="provinces"><polygon fill="url(javascript:alert(1))" points="0,0"/></g></svg>`)
	mustNotContain(t, clean, "javascript")
}

func TestStripsExternalPaintServers(t *testing.T) {
	clean := sanitize(t, `<svg><g id="provinces"><rect fill="url(http://evil/p.svg#g)" x="0"/></g></svg>`)
	mustNotContain(t, clean, "evil", "http://")
	if !strings.Contains(clean, `x="0"`) {
		t.Errorf("dropped unrelated geometry:\n%s", clean)
	}
}

func TestKeepsInternalPaintServers(t *testing.T) {
	clean := sanitize(t, `<svg><defs><linearGradient id="g"><stop offset="0" stop-color="#fff"/></linearGradient></defs><g id="provinces"><rect fill="url(#g)" x="0"/></g></svg>`)
	if !strings.Contains(clean, "url(#g)") {
		t.Errorf("a same-document gradient reference is safe and must survive:\n%s", clean)
	}
	if !strings.Contains(clean, "linearGradient") {
		t.Errorf("dropped the gradient itself:\n%s", clean)
	}
}

func TestStripsDataURLs(t *testing.T) {
	clean := sanitize(t, `<svg><g id="provinces"><rect fill="data:image/svg+xml;base64,PHN2Zz4=" x="0"/></g></svg>`)
	mustNotContain(t, clean, "data:", "base64")
}

func TestStripsUnsafeCSS(t *testing.T) {
	clean := sanitize(t, `<svg><style>@import url(http://evil/x.css);</style><g id="provinces"><rect style="background:url(http://evil/y)" x="0"/></g></svg>`)
	mustNotContain(t, clean, "@import", "evil")
	if !strings.Contains(clean, `x="0"`) {
		t.Errorf("dropped the geometry with the style:\n%s", clean)
	}
}

// Real map art is restyled through its stylesheet, so safe CSS has to survive.
func TestKeepsSafeCSS(t *testing.T) {
	clean := sanitize(t, `<svg><style>.land{fill:#eee}.sea{fill:url(#g)}</style><g id="provinces" style="fill:none;stroke:none"><rect class="land" x="0"/></g></svg>`)
	for _, want := range []string{".land{fill:#eee}", "url(#g)", `style="fill:none;stroke:none"`, `class="land"`} {
		if !strings.Contains(clean, want) {
			t.Errorf("safe css %q must survive:\n%s", want, clean)
		}
	}
}

func TestStripsCSSThatEscapesItsElement(t *testing.T) {
	clean := sanitize(t, `<svg><style>a{}</style><g id="provinces"/></svg>`)
	if !strings.Contains(clean, "a{}") {
		t.Fatalf("baseline css should survive:\n%s", clean)
	}
	poisoned := sanitize(t, `<svg><style>x{}</style><g id="provinces"/></svg>`)
	_ = poisoned
	for _, bad := range []string{
		`<svg><style>@import "x";</style><g id="provinces"/></svg>`,
		`<svg><style>a{behavior:url(x.htc)}</style><g id="provinces"/></svg>`,
		`<svg><style>a{background:expression(alert(1))}</style><g id="provinces"/></svg>`,
	} {
		out := sanitize(t, bad)
		mustNotContain(t, out, "@import", "behavior", "expression")
	}
}

func TestStripsAnimationThatRewritesAttributes(t *testing.T) {
	clean := sanitize(t, `<svg><g id="provinces"><rect x="0"><animate attributeName="href" to="javascript:alert(1)"/></rect></g></svg>`)
	mustNotContain(t, clean, "animate", "javascript")
}

func TestStripsDoctypeAndEntities(t *testing.T) {
	raw := `<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><svg><g id="provinces"><text>&xxe;</text></g></svg>`
	clean := sanitize(t, raw)
	mustNotContain(t, clean, "DOCTYPE", "ENTITY", "/etc/passwd")
}

func TestKeepsTheShapesABoardNeeds(t *testing.T) {
	raw := `<svg viewBox="0 0 100 100"><g id="provinces" style="x"><polygon id="adr" points="1,1 2,2" fill="#eee" stroke="#333"/></g><g id="province-centers"><path id="adrCenter" d="m 5,5"/></g></svg>`
	clean := sanitize(t, raw)

	for _, want := range []string{
		`viewBox="0 0 100 100"`, `id="provinces"`, `id="province-centers"`,
		`id="adr"`, `points="1,1 2,2"`, `fill="#eee"`, `stroke="#333"`,
		`id="adrCenter"`, `d="m 5,5"`,
	} {
		if !strings.Contains(clean, want) {
			t.Errorf("sanitising removed %q, which the board needs:\n%s", want, clean)
		}
	}
	if err := requireBoardLayers([]byte(clean)); err != nil {
		t.Errorf("board layers missing after sanitising: %v", err)
	}
}

func TestReportsWhatItRemoved(t *testing.T) {
	result, err := sanitizeSVG([]byte(`<svg><script>x</script><g id="provinces"><rect onclick="y" x="0"/></g></svg>`))
	if err != nil {
		t.Fatalf("sanitizeSVG: %v", err)
	}
	if !result.Dropped() {
		t.Fatal("expected the pass to report removals")
	}
	summary := result.Summary()
	if !strings.Contains(summary, "script") || !strings.Contains(summary, "onclick") {
		t.Errorf("summary should name what went: %q", summary)
	}
}

func TestRequireBoardLayersRejectsArtWithout(t *testing.T) {
	if err := requireBoardLayers([]byte(`<svg><g id="something"/></svg>`)); err == nil {
		t.Error("art with no provinces layer must be rejected")
	}
	if err := requireBoardLayers([]byte(`<svg><g id="provinces"/></svg>`)); err == nil {
		t.Error("art with no province-centers layer must be rejected")
	}
}

func TestSanitisingIsIdempotent(t *testing.T) {
	raw := `<svg viewBox="0 0 9 9"><g id="provinces"><polygon id="a" points="0,0"/></g><g id="province-centers"><path id="aCenter" d="m 1,1"/></g></svg>`
	once := sanitize(t, raw)
	twice := sanitize(t, once)
	if once != twice {
		t.Errorf("a second pass changed the art:\n%s\n%s", once, twice)
	}
}
