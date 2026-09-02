// Padding, so that a length says nothing (ADR-057).
package server

import (
	"encoding/base64"
	"fmt"
	"strings"
	"testing"

	"github.com/zond/godip/variants/classical"
)

func TestAPaddedPlaintextComesBackAsItWentIn(t *testing.T) {
	for _, content := range []string{"", "[]", strings.Repeat("x", 4000)} {
		framed, err := framePad([]byte(content), orderPlaintext)
		if err != nil {
			t.Fatalf("framing %v bytes: %v", len(content), err)
		}
		if len(framed) != orderPlaintext {
			t.Errorf("%v bytes framed to %v, want %v", len(content), len(framed), orderPlaintext)
		}
		back, err := unframePad(framed)
		if err != nil {
			t.Fatalf("unframing: %v", err)
		}
		if string(back) != content {
			t.Errorf("came back as %q", back)
		}
	}
	if _, err := framePad(make([]byte, orderPlaintext), orderPlaintext); err == nil {
		t.Error("content that does not fit was framed anyway")
	}
}

/*
A frame that is not this version's is refused rather than repaired.

A decoder that trimmed instead would accept two spellings of the same message,
which is exactly what the padding exists to prevent.
*/
func TestABrokenFrameIsRefused(t *testing.T) {
	good, err := framePad([]byte("hello"), 64)
	if err != nil {
		t.Fatal(err)
	}
	cases := map[string]func([]byte){
		"a version this build does not write": func(b []byte) { b[0] = 2 },
		"a length that runs past the frame":   func(b []byte) { b[3] = 0xff },
		"padding that is not zero":            func(b []byte) { b[60] = 1 },
	}
	for name, break_ := range cases {
		broken := append([]byte(nil), good...)
		break_(broken)
		if _, err := unframePad(broken); err == nil {
			t.Errorf("%v was accepted", name)
		}
	}
	if _, err := unframePad([]byte{1, 0}); err == nil {
		t.Error("a frame shorter than its header was accepted")
	}
}

/*
Every order set a classical board can produce fits one plaintext (ADR-057).

The worst case is a power holding every centre it can hold, with every unit
giving the longest order the parser takes, which is a support of a move. If
that fits, nothing a real phase produces does not.
*/
func TestEveryOrderSetFitsOnePlaintext(t *testing.T) {
	// A power holds at most every supply centre, so it has at most that many
	// units, and a phase asks for one order per unit.
	worst := []revealedOrder{}
	for _, province := range classical.ClassicalVariant.Graph().AllSCs() {
		worst = append(worst, revealedOrder{
			Province: string(province),
			// A support of a move is the longest form, and the names are the
			// longest ones the classical graph has.
			Parts: []string{"Support", "constantinople", "Move", "constantinople"},
		})
	}
	content, err := canonicalOrders(worst)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("the whole board as one power's orders is %v bytes", len(content))
	if _, err := framePad(content, orderPlaintext); err != nil {
		t.Fatalf("the worst case does not fit: %v", err)
	}

	// And the envelope that comes out of it is inside what the server takes.
	key := make([]byte, 32)
	sealed, err := sealOrders("g1", 0, "Austria", key, worst)
	if err != nil {
		t.Fatal(err)
	}
	if len(sealed) >= maxEnvelope {
		t.Errorf("an envelope is %v characters, and maxEnvelope is %v", len(sealed), maxEnvelope)
	}
}

// A press message is padded to one of a few sizes, and the server refuses one
// that is not, which is all it can say about a message it cannot read.
func TestAPressMessageIsOneOfTheSizesPressPadsTo(t *testing.T) {
	for _, bucket := range pressBuckets {
		if !pressBucketed(bucket + pressBoxOverhead) {
			t.Errorf("a %v-byte message was refused", bucket)
		}
	}
	for _, raw := range []int{0, 100, 256, 256 + pressBoxOverhead - 1, 1 << 20} {
		if pressBucketed(raw) {
			t.Errorf("%v raw bytes passed as a padded message", raw)
		}
	}
}

func TestTheServerRefusesAnUnpaddedMessage(t *testing.T) {
	g := pressGame(t, "fullpress")
	room := openRoom(t, g, "game", "France", "France", "Italy")

	short := base64.RawURLEncoding.EncodeToString(make([]byte, 100))
	if rec := sendPressRaw(g, "game", seatActor("France"), room.ID, short); rec.Code != 400 {
		t.Errorf("an unpadded message: got %v %v, want 400", rec.Code, rec.Body.String())
	}

	if rec := sendPress(g, "game", seatActor("France"), room.ID, "padded"); rec.Code != 200 {
		t.Errorf("a padded message: got %v %v", rec.Code, rec.Body.String())
	}
}

// The largest bucket still fits in one request body, JSON and all.
func TestTheLargestMessageFitsOneRequest(t *testing.T) {
	largest := pressBuckets[len(pressBuckets)-1] + pressBoxOverhead
	wire := base64.RawURLEncoding.EncodedLen(largest)
	body := len(fmt.Sprintf(
		`{"thread":"%v","seq":1,"phaseIndex":0,"at":"2026-09-02T10:00:00Z","box":"%v","sig":"%v"}`,
		strings.Repeat("t", 22), strings.Repeat("b", wire), strings.Repeat("s", 86)))
	if body >= maxPressBody {
		t.Errorf("the largest message is %v bytes and maxPressBody is %v", body, maxPressBody)
	}
}
