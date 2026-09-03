package svgsafe

// The sanitiser is the boundary between art that arrived through code review
// and art that arrived as a file. Each test here is a way SVG executes.

import (
	"encoding/xml"
	"io"
	"strings"
	"testing"
)

func sanitize(t *testing.T, raw string) string {
	t.Helper()
	result, err := Sanitize([]byte(raw))
	if err != nil {
		t.Fatalf("Sanitize: %v", err)
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
	mustNotContain(t, clean, "evil", "http://")
}

// An <image> is allowed to carry one thing and one thing only: a bitmap.
// godip's maps paint their paper on one, so dropping it would change every
// board the server draws.
func TestKeepsEmbeddedBitmaps(t *testing.T) {
	const pixel = "data:image/png;base64,iVBORw0KGgo="
	clean := sanitize(t,
		`<svg xmlns:xlink="http://www.w3.org/1999/xlink"><image xlink:href="`+
			pixel+`" width="4"/><g id="provinces"/></svg>`)
	if !strings.Contains(clean, pixel) {
		t.Errorf("the paper texture was dropped:\n%s", clean)
	}
	if !strings.Contains(clean, "xlink:href") {
		t.Errorf("the reference lost its prefix, so no browser will resolve it:\n%s", clean)
	}
}

// An embedded SVG document is markup the sanitiser never sees, and it can
// carry a script.
func TestStripsEmbeddedSVGImages(t *testing.T) {
	clean := sanitize(t,
		`<svg><image href="data:image/svg+xml;base64,PHN2Zz48c2NyaXB0Lz48L3N2Zz4="/><g id="provinces"/></svg>`)
	mustNotContain(t, clean, "svg+xml", "PHN2Zz")
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
	if err := RequireBoardLayers([]byte(clean)); err != nil {
		t.Errorf("board layers missing after sanitising: %v", err)
	}
}

func TestReportsWhatItRemoved(t *testing.T) {
	result, err := Sanitize([]byte(`<svg><script>x</script><g id="provinces"><rect onclick="y" x="0"/></g></svg>`))
	if err != nil {
		t.Fatalf("Sanitize: %v", err)
	}
	if !result.Dropped() {
		t.Fatal("expected the pass to report removals")
	}
	summary := result.Summary()
	if !strings.Contains(summary, "script") || !strings.Contains(summary, "onclick") {
		t.Errorf("summary should name what went: %q", summary)
	}
}

// A reference into the same document reaches nothing outside it. Map art is
// full of them: a label curving along a path, a pattern inheriting another, a
// shape repeated by `use`.
func TestKeepsSameDocumentReferences(t *testing.T) {
	clean := sanitize(t, `<svg xmlns:xlink="http://www.w3.org/1999/xlink">`+
		`<defs><path id="curve" d="m 0,0"/><pattern id="grain"/></defs>`+
		`<text><textPath xlink:href="#curve">Adriatic Sea</textPath></text>`+
		`<pattern id="paper" xlink:href="#grain"/>`+
		`<use xlink:href="#curve"/><g id="provinces"/></svg>`)
	for _, want := range []string{"textPath", `xlink:href="#curve"`, `xlink:href="#grain"`} {
		if !strings.Contains(clean, want) {
			t.Errorf("dropped %v:\n%s", want, clean)
		}
	}
}

// godip's maps carry the typeface they were drawn in as a base64 font in a
// stylesheet. Dropping the stylesheet reletters every board.
func TestKeepsAnEmbeddedFont(t *testing.T) {
	const face = "@font-face { font-family: 'Libre Baskerville'; " +
		"src: url(data:font/woff2;charset=utf-8;base64,d09GMgABAAA=); }"
	clean := sanitize(t, `<svg><style>`+face+`</style><g id="provinces"/></svg>`)
	if !strings.Contains(clean, "font-face") {
		t.Errorf("the embedded typeface was dropped:\n%s", clean)
	}
}

func TestStripsARemoteFont(t *testing.T) {
	clean := sanitize(t,
		`<svg><style>@font-face { src: url(http://evil/x.woff2); }</style>`+
			`<g id="provinces"/></svg>`)
	mustNotContain(t, clean, "evil", "font-face")
}

func TestRequireBoardLayersRejectsArtWithout(t *testing.T) {
	if err := RequireBoardLayers([]byte(`<svg><g id="something"/></svg>`)); err == nil {
		t.Error("art with no provinces layer must be rejected")
	}
	if err := RequireBoardLayers([]byte(`<svg><g id="provinces"/></svg>`)); err != nil {
		t.Errorf("art with a provinces layer must be accepted: %v", err)
	}
	// Anchors are a fallback, not a requirement: Pure's map has none.
	if !MissingCenterAnchors([]byte(`<svg><g id="provinces"/></svg>`)) {
		t.Error("missing anchors must be reported")
	}
	if MissingCenterAnchors([]byte(`<svg><g id="province-centers"/></svg>`)) {
		t.Error("present anchors must not be reported missing")
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

// ---- the output has to be a document a browser will draw -------------------

// parses reports whether the sanitised art is well-formed XML. An <img> tag
// parses SVG strictly: anything malformed simply does not draw, and the
// gallery shows "The map for this variant could not be drawn."
func parses(t *testing.T, svg string) error {
	t.Helper()
	decoder := xml.NewDecoder(strings.NewReader(svg))
	for {
		_, err := decoder.Token()
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}
	}
}

func TestOutputIsWellFormed(t *testing.T) {
	// Leading whitespace and an XML declaration are both normal in real art.
	raw := "<?xml version=\"1.0\"?>\n\n<svg xmlns=\"http://www.w3.org/2000/svg\">\n" +
		"\t<g id=\"provinces\">\n\t\t<polygon id=\"a\" points=\"0,0\"/>\n\t</g>\n" +
		"\t<g id=\"province-centers\"><path id=\"aCenter\" d=\"m 1,1\"/></g>\n</svg>\n"
	clean := sanitize(t, raw)

	if err := parses(t, clean); err != nil {
		t.Fatalf("sanitised art must parse: %v\n%s", err, clean)
	}
	if !strings.HasPrefix(clean, "<svg") {
		t.Errorf("a document may not begin with character data:\n%.80s", clean)
	}
}

// TestWhitespaceSurvivesUnmangled guards the bug that produced the blank maps:
// escaping every newline into &#xA; both bloated the art and, before the root
// element, made it unparseable.
func TestWhitespaceSurvivesUnmangled(t *testing.T) {
	clean := sanitize(t, "<svg><g id=\"provinces\">\n\t<text>a\nb</text>\n</g></svg>")
	if strings.Contains(clean, "&#xA;") || strings.Contains(clean, "&#x9;") {
		t.Errorf("newlines and tabs must survive as themselves:\n%s", clean)
	}
	if !strings.Contains(clean, "a\nb") {
		t.Errorf("text content lost its newline:\n%s", clean)
	}
}

func TestTextIsStillEscaped(t *testing.T) {
	clean := sanitize(t, `<svg><g id="provinces"><text>a &amp; b &lt;c&gt;</text></g></svg>`)
	if !strings.Contains(clean, "&amp;") {
		t.Errorf("an ampersand must stay escaped:\n%s", clean)
	}
	if err := parses(t, clean); err != nil {
		t.Errorf("escaping broke the document: %v", err)
	}
}

// jDip wraps a long path's `d` over several lines. A newline inside an
// attribute value is legal XML and a path parser reads it as whitespace, but a
// Go string literal spells it backslash-n, and a path parser stops at the
// backslash. That left 1900 drawing bare ground.
func TestAttributeNewlineSurvives(t *testing.T) {
	clean := sanitize(t, "<svg><g id=\"provinces\"><path d=\"M 0 0\nL 1 1\"/></g></svg>")
	if strings.Contains(clean, `\n`) {
		t.Errorf("a newline in an attribute must not become a backslash:\n%s", clean)
	}
	if !strings.Contains(clean, "M 0 0\nL 1 1") {
		t.Errorf("path data lost its newline:\n%s", clean)
	}
	if err := parses(t, clean); err != nil {
		t.Errorf("the document stopped parsing: %v", err)
	}
}

func TestAttributeQuoteIsEscaped(t *testing.T) {
	clean := sanitize(t, `<svg><g id="provinces"><text aria-label="a &quot;b&quot; c">x</text></g></svg>`)
	if !strings.Contains(clean, "&quot;") {
		t.Errorf("a quote must not be able to close its own value:\n%s", clean)
	}
	if err := parses(t, clean); err != nil {
		t.Errorf("the document stopped parsing: %v", err)
	}
}

// coldwar and vietnamwar carry accented ids, and url(#id) has to keep matching
// them. %q spelled those as \uXXXX, which matches nothing.
func TestAttributeNonASCIISurvives(t *testing.T) {
	clean := sanitize(t, `<svg><g id="provinces"><text id="Kyūshū" aria-label="Süd-Ost">x</text></g></svg>`)
	if strings.Contains(clean, `\u`) {
		t.Errorf("non-ASCII must not be escaped:\n%s", clean)
	}
	if !strings.Contains(clean, `id="Kyūshū"`) || !strings.Contains(clean, `aria-label="Süd-Ost"`) {
		t.Errorf("non-ASCII attribute values must survive:\n%s", clean)
	}
}

func TestAttributeMarkupIsEscaped(t *testing.T) {
	clean := sanitize(t, `<svg><g id="provinces"><text aria-label="a &lt;b&gt; &amp; c">x</text></g></svg>`)
	if !strings.Contains(clean, "&lt;b&gt; &amp; c") {
		t.Errorf("markup characters must stay escaped:\n%s", clean)
	}
	if err := parses(t, clean); err != nil {
		t.Errorf("the document stopped parsing: %v", err)
	}
}

// The board owns every fill on #provinces, so a map that paints its terrain
// there and nowhere else is served as one flat sea (ADR-059).
func TestMissingTerrainLayerFindsArtThatPaintsOnTheHitLayer(t *testing.T) {
	painted := `<svg><g id="provinces"><path id="par" fill="#f0e2c0"/></g>` +
		`<g id="coastline"><path/></g></svg>`
	if !MissingTerrainLayer([]byte(painted)) {
		t.Error("art with the paint on the hit layer must be reported")
	}
	godip := `<svg><g id="background"><path fill="#f0e2c0"/></g>` +
		`<g id="provinces"><path id="par"/></g></svg>`
	if MissingTerrainLayer([]byte(godip)) {
		t.Error("godip's own layering must not be reported")
	}
	jdip := `<svg><g id="MapLayer"><path class="land"/></g>` +
		`<g id="provinces"><path id="par"/></g></svg>`
	if MissingTerrainLayer([]byte(jdip)) {
		t.Error("jDip's layering must not be reported")
	}
	// Art with no hit layer at all is refused outright, so it is not this
	// check's business to have an opinion about it.
	if MissingTerrainLayer([]byte(`<svg><g id="something"/></svg>`)) {
		t.Error("art with no provinces layer must be left to RequireBoardLayers")
	}
}
