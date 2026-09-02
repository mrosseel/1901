// An art-mode map pays nothing for the label plan it does not have.
package app

import (
	"bytes"
	"encoding/json"
	"testing"

	"spring1901/spike/internal/variant"
)

// Every map served today is an art-mode map, so every state served today must
// be the state that was served before this field existed — to the byte.
func TestAnArtModeStateCarriesNoLabelField(t *testing.T) {
	b, err := json.Marshal(publicStateJSON{})
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(b, []byte(`"labels"`)) {
		t.Errorf("a map that draws its own names still pays for the field: %v", string(b))
	}
	b, err = json.Marshal(publicStateJSON{Labels: &variant.LabelPlan{Mode: "records"}})
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(b, []byte(`"labels":{"mode":"records"`)) {
		t.Errorf("the plan did not reach the wire: %v", string(b))
	}
}
