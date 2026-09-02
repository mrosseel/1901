/*
Padding, so that a length says nothing (ADR-057).

XChaCha20-Poly1305 adds a fixed 16 bytes and otherwise leaves the plaintext's
length alone. A server that stores an envelope therefore reads its size, and
size is worth something: for a retreat or an adjustment there are few legal
order sets, so enumerating them narrows what a seat locked in. A press message
leaks the length of the sentence, which at a table is most of the sentence.

So both are padded, and the real length is inside the AEAD rather than beside
it:

	byte 0      version, 0x01
	bytes 1..4  the content's length, big-endian
	bytes 5..   the content, then zero bytes to the target size

Opening checks all three: the version, a length that fits, and padding that is
zero. A frame that fails any of them is refused rather than trimmed, because
the alternative is a decoder that accepts two spellings of the same message.
*/

const VERSION = 0x01;
const HEADER = 5;

/*
The sizes a press message is padded to (ADR-057).

Buckets rather than one size, because a fixed 16 KiB message would cost a table
of seven a few megabytes an evening for nothing. What the server sees is which
bucket a sentence fell in, and inside a bucket every message is the same
length.
*/
export const PRESS_BUCKETS = [256, 512, 1024, 2048, 4096, 8192, 16384];

/** One phase's orders, padded to one size, so every order set looks alike. */
export const ORDER_PLAINTEXT = 4096;

/** The smallest bucket a message of this length fits in, or null when none. */
export function bucketFor(length: number): number | null {
  for (const bucket of PRESS_BUCKETS) {
    if (length + HEADER <= bucket) return bucket;
  }
  return null;
}

/** The content, framed and padded to exactly `size` bytes. */
export function frame(content: Uint8Array, size: number): Uint8Array {
  if (content.length + HEADER > size) {
    throw new Error("this is too long to send");
  }
  const out = new Uint8Array(size);
  out[0] = VERSION;
  out[1] = (content.length >>> 24) & 0xff;
  out[2] = (content.length >>> 16) & 0xff;
  out[3] = (content.length >>> 8) & 0xff;
  out[4] = content.length & 0xff;
  out.set(content, HEADER);
  return out;
}

/** The content back, or null when this is not a frame this version wrote. */
export function unframe(padded: Uint8Array): Uint8Array | null {
  if (padded.length < HEADER || padded[0] !== VERSION) return null;
  const length =
    padded[1] * 0x1000000 + ((padded[2] << 16) | (padded[3] << 8) | padded[4]);
  if (length > padded.length - HEADER) return null;
  for (let at = HEADER + length; at < padded.length; at++) {
    if (padded[at] !== 0) return null;
  }
  return padded.slice(HEADER, HEADER + length);
}
