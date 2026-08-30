import { describe, expect, it } from "vitest";
import { verify } from "@noble/ed25519";
import { entropyFor, makeEntropy, publicKeyOf, signMessage, wordsFor } from "./gmkey";

function fromBase64Url(text: string): Uint8Array {
  const binary = window.atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

describe("the game master's key (D-048)", () => {
  it("writes twelve words and reads the same entropy back", () => {
    const entropy = makeEntropy();
    const words = wordsFor(entropy);
    expect(words).toHaveLength(12);
    expect(entropyFor(words.join(" "))).toEqual(entropy);
  });

  it("does not care about capitals or extra spacing", () => {
    const entropy = makeEntropy();
    const typed = "  " + wordsFor(entropy).join("   ").toUpperCase() + "\n";
    expect(entropyFor(typed)).toEqual(entropy);
  });

  it("never turns a swapped word into the key it was", () => {
    // The checksum catches fifteen swaps in sixteen; the sixteenth is a
    // valid mnemonic for different entropy. Either way the original key is
    // unreachable, which is the claim that matters.
    const entropy = makeEntropy();
    const words = wordsFor(entropy);
    words[3] = words[3] === "zoo" ? "abandon" : "zoo";
    const rebuilt = entropyFor(words.join(" "));
    if (rebuilt) expect(publicKeyOf(rebuilt)).not.toBe(publicKeyOf(entropy));
  });

  it("refuses a word that is not on the list at all", () => {
    const words = wordsFor(makeEntropy());
    words[0] = "kroonstad";
    expect(entropyFor(words.join(" "))).toBeNull();
  });

  it("derives the same key from the same words on another device", () => {
    const entropy = makeEntropy();
    const elsewhere = entropyFor(wordsFor(entropy).join(" "));
    expect(elsewhere).not.toBeNull();
    expect(publicKeyOf(elsewhere!)).toBe(publicKeyOf(entropy));
  });

  it("signs what the server asked for, and the public half checks it", async () => {
    const entropy = makeEntropy();
    const message = "1901 game master recovery|abc123|nonce.999.sig";
    const signature = fromBase64Url(signMessage(entropy, message));
    const publicKey = fromBase64Url(publicKeyOf(entropy));
    expect(await verify(signature, new TextEncoder().encode(message), publicKey)).toBe(true);
    expect(await verify(signature, new TextEncoder().encode(message + "!"), publicKey)).toBe(false);
  });
});
