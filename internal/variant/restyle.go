// The application half of a restyle (ADR-026).
//
// A styled map is composed when it is asked for, out of three things: the
// original art, the style plan a browser measured from it, and the style's
// own tokens. This file is the one entry point; the two kinds of map it can
// be handed are in godipart.go and jdipart.go, and the text arithmetic they
// both use is in svgtext.go.

package variant

import "fmt"

// applyStyle composes one styled map out of the original art, the plan
// measured from it, and the style's tokens.
func applyStyle(original string, plan *stylePlan, style *loadedStyle, centres []string) (string, error) {
	switch plan.Kind {
	case "godip":
		return applyGodipStyle(original, plan.Godip, style)
	case "jdip":
		return applyJDipStyle(original, plan.JDip, style, centres)
	}
	return "", fmt.Errorf("style plan for %v names no applier kind", plan.Key)
}
