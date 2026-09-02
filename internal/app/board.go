// What a game knows about the board it is played on.
//
// None of it is game state: two games on classical answer the same. The game
// holds a variant key, and the variant package holds everything the key
// stands for — the name, the province table, the marker positions and the
// label plan. These four methods are the whole of the join, and they are here
// so the state answers read the same as they did when the variant registry
// was a file away instead of a package away.

package app

import "spring1901/spike/internal/variant"

// variantRef identifies the variant this game is played on.
func (self *game) variantRef() variant.RefJSON {
	return variant.Ref(self.variantKey, self.variant.Name)
}

// provinceNames is the abbreviation-to-long-name table the board labels from.
func (self *game) provinceNames() map[string]string {
	return variant.ProvinceNames(self.variantKey)
}

// placements is the approved marker table, or nil when the variant has none.
func (self *game) placements() variant.PlacementTable {
	return variant.PlacementFor(self.variantKey)
}

// labels is the plan a data-mode map draws its names from, or nil.
func (self *game) labels() *variant.LabelPlan {
	return variant.Labels(self.variantKey, self.state.Graph())
}
