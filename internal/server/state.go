// The board as a client reads it, and the review of the turn that made it.
//
// A snapshot is the whole answer to "what does the map look like now": the
// phase, the units, the centres. The review is the turn before it — what was
// ordered, what resolved, what bounced — and it is built when the phase
// advances rather than asked for afterwards.

package server

import "sort"

type phaseJSON struct {
	Season string `json:"season"`
	Year   int    `json:"year"`
	Type   string `json:"type"`
}

type unitJSON struct {
	Type   string `json:"type"`
	Nation string `json:"nation"`
}

type stateJSON struct {
	GameID        string              `json:"gameId"`
	Phase         phaseJSON           `json:"phase"`
	Units         map[string]unitJSON `json:"units"`
	Dislodged     map[string]unitJSON `json:"dislodged"`
	Orders        map[string]string   `json:"orders"`
	OrderParts    map[string][]string `json:"orderParts"`
	Resolutions   map[string]string   `json:"resolutions"`
	SupplyCenters map[string]string   `json:"supplyCenters"`
	Nations       []string            `json:"nations"`
	// Illegal names the provinces whose order the engine refuses (ADR-029).
	// The order is in Orders like any other, as the player wrote it; this
	// is what tells a board to strike it through.
	Illegal []string `json:"illegal"`
}

// snapshot renders the current board as JSON. The caller must hold self.mu.
// It contains every order; only seatState, which filters it, is exposed.
func (self *game) snapshot(id string) stateJSON {
	s := self.state
	out := stateJSON{
		GameID: id,
		Phase: phaseJSON{
			Season: string(s.Phase().Season()),
			Year:   s.Phase().Year(),
			Type:   string(s.Phase().Type()),
		},
		Units:         map[string]unitJSON{},
		Dislodged:     map[string]unitJSON{},
		Orders:        map[string]string{},
		OrderParts:    map[string][]string{},
		Resolutions:   map[string]string{},
		SupplyCenters: map[string]string{},
	}
	for prov, unit := range s.Units() {
		out.Units[string(prov)] = unitJSON{
			Type:   string(unit.Type),
			Nation: string(unit.Nation),
		}
	}
	// Dislodgement is public knowledge: everyone at the table sees which
	// unit was pushed out and has to retreat.
	for prov, unit := range s.Dislodgeds() {
		out.Dislodged[string(prov)] = unitJSON{
			Type:   string(unit.Type),
			Nation: string(unit.Nation),
		}
	}
	for prov, bits := range self.parts {
		out.Orders[string(prov)] = self.describe(prov, bits)
		out.OrderParts[string(prov)] = bits
	}
	for prov, err := range s.Resolutions() {
		if err == nil {
			out.Resolutions[string(prov)] = "OK"
		} else {
			out.Resolutions[string(prov)] = err.Error()
		}
	}
	for prov, nation := range s.SupplyCenters() {
		out.SupplyCenters[string(prov)] = string(nation)
	}
	out.Illegal = self.illegalProvinces()
	for _, nation := range self.variant.Nations {
		out.Nations = append(out.Nations, string(nation))
	}
	sort.Strings(out.Nations)
	return out
}

// phaseReviewJSON is the record of a resolved phase: every order that was
// actually applied, who gave it, and how it turned out. Past orders become
// public once the phase resolves, so this is safe for every view.
type phaseReviewJSON struct {
	Phase       phaseJSON           `json:"phase"`
	Orders      map[string]string   `json:"orders"`
	OrderParts  map[string][]string `json:"orderParts"`
	Powers      map[string]string   `json:"powers"`
	Resolutions map[string]string   `json:"resolutions"`
	Dislodged   map[string]unitJSON `json:"dislodged"`
	NMR         []string            `json:"nmr"`
	// Illegal names the provinces whose order never reached the engine
	// (ADR-029). Their resolution is "IllegalOrder", which is not something
	// godip can say: an engine failure names the rule that beat the order,
	// and this one says the order was never in the fight.
	Illegal []string `json:"illegal"`
	/*
		What each seat locked in, by power (ADR-058).

		The envelope and the signature over it, kept after the phase resolved.
		The orders above are already public, so this adds no secret; what it
		adds is that anybody can check them. Empty for an unsealed game and for
		a seat that revealed nothing.
	*/
	Commitments map[string]commitment `json:"commitments,omitempty"`
}

// illegalResolution is the resolution an illegal order is given. It is not a
// godip error string, and it cannot collide with one.
const illegalResolution = "IllegalOrder"

// beginReview records the phase and its applied orders. It must run after
// any NMR drops and before state.Next(), because the order text is read
// off the board as it stands during the phase.
func (self *game) beginReview(phaseIndex int, nmr []string) *phaseReviewJSON {
	review := &phaseReviewJSON{
		Phase: phaseJSON{
			Season: string(self.state.Phase().Season()),
			Year:   self.state.Phase().Year(),
			Type:   string(self.state.Phase().Type()),
		},
		Orders:      map[string]string{},
		OrderParts:  map[string][]string{},
		Powers:      map[string]string{},
		Resolutions: map[string]string{},
		Dislodged:   map[string]unitJSON{},
		NMR:         []string{},
		Illegal:     self.illegalProvinces(),
	}
	for prov, bits := range self.parts {
		review.Orders[string(prov)] = self.describe(prov, bits)
		review.OrderParts[string(prov)] = bits
		review.Powers[string(prov)] = string(self.owner[prov])
	}
	if nmr != nil {
		review.NMR = nmr
	}
	// The record the phase leaves behind (ADR-058). It is read from the same
	// place on a live adjudication and on a replay, so a restarted game shows
	// the same page.
	if made := self.flow.commitments[phaseIndex]; len(made) > 0 {
		review.Commitments = map[string]commitment{}
		for power, one := range made {
			review.Commitments[power] = one
		}
	}
	return review
}

// endReview fills in the outcome. It must run after state.Next().
func (self *game) endReview(review *phaseReviewJSON) {
	for prov, err := range self.state.Resolutions() {
		if err == nil {
			review.Resolutions[string(prov)] = "OK"
		} else {
			review.Resolutions[string(prov)] = err.Error()
		}
	}
	// An illegal order has no resolution of the engine's, because it was
	// never in the engine (ADR-029). It gets one of ours, so a reader can tell
	// "this order was struck and the unit held" from "this order was tried
	// and lost".
	for _, prov := range review.Illegal {
		review.Resolutions[prov] = illegalResolution
	}
	review.Dislodged = self.dislodgedMap()
}
