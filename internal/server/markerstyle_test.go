package server

import "testing"

// The style a game opens its pieces on. It is a setting rather than a rule:
// the server keeps it, every device is told it, and every device may ignore
// it. What the server owes is that the name it hands out is one the board can
// actually draw.
func TestMarkerStyleDefaultsAndRefusesWhatItCannotDraw(t *testing.T) {
	if defaultSettings().MarkerStyle != defaultMarkerStyle {
		t.Errorf("a game nobody set a style on must open on %q, got %q",
			defaultMarkerStyle, defaultSettings().MarkerStyle)
	}
	if !markerStyles[defaultMarkerStyle] {
		t.Errorf("the default style %q is not in the list of styles", defaultMarkerStyle)
	}

	// An empty style is what every game written before the setting existed
	// carries in its row, and a made-up one is what a client can send. Both
	// have to come out as something the board draws, because the board has
	// no pieces for a name it does not know.
	for _, given := range []string{"", "wooden-blocks", "STRATEGIC"} {
		got := settings{MarkerStyle: given}.normalised().MarkerStyle
		if got != defaultMarkerStyle {
			t.Errorf("style %q normalised to %q, want %q", given, got, defaultMarkerStyle)
		}
	}

	for style := range markerStyles {
		if got := (settings{MarkerStyle: style}).normalised().MarkerStyle; got != style {
			t.Errorf("style %q normalised to %q; a style the board draws must survive",
				style, got)
		}
	}
}

// The envelope is a patch, so a game master posting one setting must not send
// the game back to lettered triangles by not mentioning the pieces.
func TestMarkerStyleSurvivesAPatchThatDoesNotMentionIt(t *testing.T) {
	base := defaultSettings()
	base.MarkerStyle = "ancient"

	minutes := 10
	patched := settingsEnvelope{settingsPatch: settingsPatch{DeadlineMinutes: &minutes}}.merge(base)
	if patched.MarkerStyle != "ancient" {
		t.Errorf("a patch that never mentioned the pieces changed them to %q", patched.MarkerStyle)
	}

	patched = settingsEnvelope{Settings: &settingsPatch{DeadlineMinutes: &minutes}}.merge(base)
	if patched.MarkerStyle != "ancient" {
		t.Errorf("the wrapped shape changed the pieces to %q", patched.MarkerStyle)
	}

	pretty := "pretty"
	patched = settingsEnvelope{settingsPatch: settingsPatch{MarkerStyle: &pretty}}.merge(base)
	if patched.MarkerStyle != "pretty" {
		t.Errorf("the game master could not change the pieces: got %q", patched.MarkerStyle)
	}

	// A style this build cannot draw is refused the same way at a running
	// board as at creation, rather than being written into the row.
	junk := "flags"
	patched = settingsEnvelope{settingsPatch: settingsPatch{MarkerStyle: &junk}}.merge(base)
	if patched.MarkerStyle != defaultMarkerStyle {
		t.Errorf("a style the board cannot draw was kept as %q", patched.MarkerStyle)
	}
}
