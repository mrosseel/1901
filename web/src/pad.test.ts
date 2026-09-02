import { describe, expect, it } from "vitest";

import { ORDER_PLAINTEXT, PRESS_BUCKETS, bucketFor, frame, unframe } from "./pad";

const bytes = (text: string) => new TextEncoder().encode(text);

describe("a padded plaintext", () => {
  it("comes back exactly as it went in", () => {
    const content = bytes("Piedmont is yours");
    expect(Array.from(unframe(frame(content, 256)) || [])).toEqual(Array.from(content));
  });

  it("is the target size whatever it holds", () => {
    expect(frame(bytes(""), 256).length).toBe(256);
    expect(frame(bytes("x".repeat(200)), 256).length).toBe(256);
  });

  it("refuses content that does not fit", () => {
    expect(() => frame(bytes("x".repeat(252)), 256)).toThrow();
  });

  /* Refused rather than trimmed: a decoder that repaired a frame would accept
     two spellings of the same message. */
  it("refuses a frame that is not this version's", () => {
    const good = frame(bytes("hello"), 64);
    const wrongVersion = good.slice();
    wrongVersion[0] = 2;
    expect(unframe(wrongVersion)).toBeNull();

    const wrongLength = good.slice();
    wrongLength[4] = 200;
    expect(unframe(wrongLength)).toBeNull();

    const dirtyPadding = good.slice();
    dirtyPadding[40] = 1;
    expect(unframe(dirtyPadding)).toBeNull();

    expect(unframe(new Uint8Array(3))).toBeNull();
  });
});

describe("the sizes press pads to", () => {
  it("takes the smallest bucket a message fits in", () => {
    expect(bucketFor(0)).toBe(256);
    expect(bucketFor(251)).toBe(256);
    expect(bucketFor(252)).toBe(512);
    expect(bucketFor(PRESS_BUCKETS[PRESS_BUCKETS.length - 1] - 5)).toBe(16384);
  });

  it("has no bucket for a message past the largest", () => {
    expect(bucketFor(16380)).toBeNull();
  });

  it("pads an order list to one size and not to a bucket", () => {
    expect(ORDER_PLAINTEXT).toBe(4096);
  });
});
