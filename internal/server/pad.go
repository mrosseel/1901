/*
Padding, so that a length says nothing (ADR-057).

XChaCha20-Poly1305 adds a fixed 16 bytes and otherwise leaves the plaintext's
length alone. A server that stores an envelope therefore reads its size, and
size is worth something: for a retreat or an adjustment there are few legal
order sets, so enumerating them narrows what a seat locked in.

So the plaintext is framed and padded, with the real length inside the AEAD
rather than beside it:

	byte 0      version, 0x01
	bytes 1..4  the content's length, big-endian
	bytes 5..   the content, then zero bytes to the target size

The same frame is built in web/src/pad.ts, and the two must not drift.
*/
package server

import (
	"bytes"
	"encoding/binary"
	"fmt"
)

const (
	padVersion = 0x01
	padHeader  = 5
)

/*
orderPlaintext is the one size every sealed order list is padded to.

Measured against the worst case a classical board can produce: one power
holding every centre, every unit supporting a move, which is what
TestEveryOrderSetFitsOnePlaintext pins. The base64url envelope that comes out
of it is well inside maxEnvelope.
*/
const orderPlaintext = 4096

// pressBuckets are the sizes a press message is padded to (ADR-057). Buckets
// rather than one size, because a fixed 16 KiB message would cost a table of
// seven a few megabytes an evening for nothing.
var pressBuckets = []int{256, 512, 1024, 2048, 4096, 8192, 16384}

// framePad returns the content framed and padded to exactly size bytes.
func framePad(content []byte, size int) ([]byte, error) {
	if len(content)+padHeader > size {
		return nil, fmt.Errorf("%v bytes do not fit in %v", len(content), size)
	}
	out := make([]byte, size)
	out[0] = padVersion
	binary.BigEndian.PutUint32(out[1:padHeader], uint32(len(content)))
	copy(out[padHeader:], content)
	return out, nil
}

/*
unframePad returns the content, and refuses anything that is not a frame this
version wrote.

The version, a length that fits, and padding that is all zero are all checked,
because a decoder that trimmed instead would accept two spellings of the same
message.
*/
func unframePad(padded []byte) ([]byte, error) {
	if len(padded) < padHeader || padded[0] != padVersion {
		return nil, fmt.Errorf("this is not a padded plaintext")
	}
	length := int(binary.BigEndian.Uint32(padded[1:padHeader]))
	if length > len(padded)-padHeader {
		return nil, fmt.Errorf("the stated length runs past the plaintext")
	}
	rest := padded[padHeader+length:]
	if !bytes.Equal(rest, make([]byte, len(rest))) {
		return nil, fmt.Errorf("the padding is not zero")
	}
	return padded[padHeader : padHeader+length], nil
}

/*
pressBucketed says whether a boxed message is one of the sizes press pads to.

The server cannot read a message and does not try. What it can do is refuse one
that is not padded, so a client that skipped the padding does not spend the
evening telling the server how long every sentence was.

The wire form is the 24-byte nonce, the ciphertext, and a 16-byte tag, so the
raw length is a bucket plus 40.
*/
func pressBucketed(raw int) bool {
	for _, bucket := range pressBuckets {
		if raw == bucket+pressBoxOverhead {
			return true
		}
	}
	return false
}

// pressBoxOverhead is the nonce in front and the tag behind.
const pressBoxOverhead = 24 + 16
