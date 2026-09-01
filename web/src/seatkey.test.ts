import { describe, expect, it } from "vitest";

import { replacementSeatSeed, seatPublicKey } from "./seatkey";

describe("a handed-over seat", () => {
  it("rejects the former signing seed and gives the recipient a new identity", () => {
    const former = new Uint8Array(32).fill(7);
    const fresh = new Uint8Array(32).fill(9);
    let calls = 0;

    const replacement = replacementSeatSeed(former, () => {
      calls++;
      return calls === 1 ? new Uint8Array(former) : fresh;
    });

    expect(replacement).toEqual(fresh);
    expect(calls).toBe(2);
    expect(seatPublicKey(replacement)).not.toBe(seatPublicKey(former));
  });
});
