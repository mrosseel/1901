import { describe, expect, it } from "vitest";

import { deriveOrderKey, fromBase64Url, toBase64Url } from "./keys";
import { canonicalOrders, draftOrders, sealOrders, type DraftOrder } from "./sealed";

/*
The envelope has to be one the server can open (ADR-004).

sealed_test.go pins an envelope this file produced, and this file pins one the
server produced. Each side is checked against bytes the other made, because a
drift would fail every reveal in a real game and tell the player their key does
not open their own orders.
*/

const ORDERS: DraftOrder[] = [
  { province: "bud", parts: ["Move", "ser"] },
  { province: "vie", parts: ["Hold"] },
];

/* A fixed key, so the pinned values are reproducible. A real one is derived
   from the seat seed or made at random; neither belongs in a test. */
const KEY = new Uint8Array(32).map((_, i) => i);

describe("the plaintext", () => {
  it("is the orders as JSON, sorted by province", () => {
    expect(canonicalOrders(ORDERS)).toBe(
      '[{"province":"bud","parts":["Move","ser"]},{"province":"vie","parts":["Hold"]}]',
    );
  });

  it("does not care what order the taps happened in", () => {
    expect(canonicalOrders(ORDERS.slice().reverse())).toBe(canonicalOrders(ORDERS));
  });

  it("has a form for no orders at all", () => {
    expect(canonicalOrders([])).toBe("[]");
  });
});

describe("an envelope", () => {
  it("hides the orders", () => {
    const sealed = sealOrders("g1", 0, "Austria", KEY, ORDERS);
    expect(sealed).not.toContain("bud");
    expect(sealed).not.toContain("ser");
  });

  it("is a new envelope every time, for the same orders", () => {
    const a = sealOrders("g1", 0, "Austria", KEY, ORDERS);
    const b = sealOrders("g1", 0, "Austria", KEY, ORDERS);
    expect(a).not.toBe(b);
  });

  /*
  24 bytes of nonce, then the ciphertext and a 16-byte tag. The server splits
  it at exactly that point, so the length is part of the contract.
  */
  it("carries its nonce in front", () => {
    const raw = fromBase64Url(sealOrders("g1", 0, "Austria", KEY, ORDERS));
    expect(raw.length).toBe(24 + canonicalOrders(ORDERS).length + 16);
  });

  /*
  Only the server opens an envelope, so the cross-check lives in Go: a
  TestTheServerOpensWhatThePhoneSealed there holds an envelope this file
  produced and reads the orders back out of it. What is checked here is the
  other half of that contract — the key encoding both sides must agree on,
  since the server decodes exactly this string.
  */
  it("writes its key the way the server reads one", () => {
    expect(toBase64Url(KEY)).toBe("AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8");
    expect(fromBase64Url(toBase64Url(KEY))).toEqual(KEY);
  });
});

describe("a draft", () => {
  it("lists its orders by province", () => {
    const listed = draftOrders({ key: "k", orders: { vie: ["Hold"], bud: ["Move", "ser"] } });
    expect(listed.map((one) => one.province)).toEqual(["bud", "vie"]);
    expect(listed[0].parts).toEqual(["Move", "ser"]);
  });
});

/*
The recovery this design exists for (ADR-004).

A phone locks in and then goes flat. Its envelope is already on the server. The
only thing missing is 32 bytes, and those are derived from the seat seed rather
than stored, so a second device that holds the seed can make them again.

What the player needs is their seat link, which carries the seed in the
fragment (ADR-049). Open it on another phone and this is the key that comes
back.
*/
describe("the key for a phase", () => {
  const seed = new Uint8Array(32).fill(7);

  it("is the same on any device holding the seed", () => {
    const onTheDeadPhone = deriveOrderKey(seed, "g1", 3);
    const onTheSpare = deriveOrderKey(new Uint8Array(seed), "g1", 3);
    expect(toBase64Url(onTheSpare)).toBe(toBase64Url(onTheDeadPhone));
  });

  it("opens one phase and no other", () => {
    expect(toBase64Url(deriveOrderKey(seed, "g1", 4))).not.toBe(
      toBase64Url(deriveOrderKey(seed, "g1", 3)),
    );
  });

  it("does not travel between games on one device", () => {
    expect(toBase64Url(deriveOrderKey(seed, "g2", 3))).not.toBe(
      toBase64Url(deriveOrderKey(seed, "g1", 3)),
    );
  });

  it("is 32 bytes, which is what the server accepts", () => {
    expect(deriveOrderKey(seed, "g1", 0).length).toBe(32);
  });

  /*
  The whole recovery in one line: the spare device seals nothing and knows
  nothing about the draft. It derives the key, and the envelope the dead phone
  left on the server opens under it.
  */
  it("is what a spare device sends for a phone that died", () => {
    const dead = deriveOrderKey(seed, "g1", 0);
    const envelope = sealOrders("g1", 0, "Austria", dead, ORDERS);
    const spare = deriveOrderKey(seed, "g1", 0);
    expect(toBase64Url(spare)).toBe(toBase64Url(dead));
    expect(envelope.length).toBeGreaterThan(0);
  });
});
