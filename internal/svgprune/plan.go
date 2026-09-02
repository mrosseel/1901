package svgprune

import (
	"encoding/json"
	"fmt"
	"os"
)

// planRoots is the shape of a style plan, read for the one thing this package
// needs from it: the ids the plan holds on to. The rest of the plan is
// measurements, and none of them name an element.
type planRoots struct {
	Godip struct {
		ImpassablePattern string `json:"impassablePattern"`
		GrainPattern      string `json:"grainPattern"`
		GrainOverlayID    string `json:"grainOverlayId"`
	} `json:"godip"`
}

// PlanRoots reads the ids one style plan names, so that pruning cannot take
// away the pattern a restyle is going to repaint.
//
// A plan that is not there is not an error. Art may be exported before anyone
// has measured a plan from it, and in that order there is nothing to protect.
func PlanRoots(path string) ([]string, error) {
	raw, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var plan planRoots
	if err := json.Unmarshal(raw, &plan); err != nil {
		return nil, fmt.Errorf("%v: %w", path, err)
	}
	var roots []string
	for _, id := range []string{
		plan.Godip.ImpassablePattern,
		plan.Godip.GrainPattern,
		plan.Godip.GrainOverlayID,
	} {
		if id != "" {
			roots = append(roots, id)
		}
	}
	return roots, nil
}
