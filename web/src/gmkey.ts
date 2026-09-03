/*
The game master's key, on the device that holds it (ADR-048).

The role used to be a link and a cookie, both on one machine, and losing them
was a game nobody could run. So this browser makes a key. The server is handed
the public half and never sees the private one; the private one is written down
as twelve words, and typing them back is the whole recovery.

Where the numbers come from, in order:

  1. 16 bytes from crypto.getRandomValues. That is the entropy and it is the
     only random thing here — everything below is a function of it.
  2. Twelve words, by the BIP-39 rule: 128 bits of entropy plus a 4-bit
     checksum, split into twelve 11-bit numbers, each an index into a list of
     2048 English words. The checksum is why a mistyped word is caught on the
     device rather than by a failed signature.
  3. A 32-byte Ed25519 seed, HKDF-SHA256 of the entropy under a fixed name.
     Not BIP-39's own PBKDF2 seed: there is no wallet on the other end of
     this, no passphrase, and 128 bits of real entropy needs no stretching.
     Naming the key is what stops it being reused anywhere else.
  4. The signature, Ed25519 over a sentence the server made up.

The device keeps the entropy, not the derived key, so the words can be shown
again on the machine that made them. It is a private key in localStorage, which
is worth saying out loud: it is the same class of secret as the game master
token that already lives in the address bar and the browser history, and the
words are the copy that survives this device.
*/

import { entropyToMnemonic, mnemonicToEntropy } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import {
  deriveSigningKey,
  fromBase64Url,
  publicKeyOf,
  randomBytes,
  signMessage as signWith,
  toBase64Url,
} from "./keys";

/* What this key is for. Any other use of these words derives a different key,
   which is the point of naming it. */
const KEY_NAME = "1901 game master key v1";

/** 128 bits, which is twelve words. */
const ENTROPY_BYTES = 16;

/** One entry per game. Exported so a page can list what this device holds. */
export const STORE_PREFIX = "1901.gmkey.";

/** A new key's entropy. Nothing else in this file is random. */
export function makeEntropy(): Uint8Array {
  return randomBytes(ENTROPY_BYTES);
}

/** The twelve words for an entropy, as an array so a page can lay them out. */
export function wordsFor(entropy: Uint8Array): string[] {
  return entropyToMnemonic(entropy, wordlist).split(" ");
}

/*
The entropy behind twelve words, or null when they are not twelve words of
this list in a valid order. Case and spacing are the typist's business, not
the checker's, so they are cleaned up first.
*/
export function entropyFor(words: string): Uint8Array | null {
  const cleaned = words.trim().toLowerCase().split(/\s+/).join(" ");
  try {
    return mnemonicToEntropy(cleaned, wordlist);
  } catch {
    return null;
  }
}

/** The half the server is given. */
export function gmPublicKey(entropy: Uint8Array): string {
  return publicKeyOf(deriveSigningKey(entropy, KEY_NAME));
}

/** A signature over what the server asked for, base64url. */
export function signMessage(entropy: Uint8Array, message: string): string {
  return signWith(deriveSigningKey(entropy, KEY_NAME), message);
}

/*
This device's copy, one game per entry. It is deliberately not the recent-game
note: that one holds the last game and is overwritten, and a key must survive a
game master opening a second table.
*/
export function readStoredKey(gameId: string): Uint8Array | null {
  try {
    const stored = window.localStorage.getItem(STORE_PREFIX + gameId);
    if (!stored) return null;
    const entropy = fromBase64Url(stored);
    return entropy.length === ENTROPY_BYTES ? entropy : null;
  } catch {
    return null;
  }
}

export function writeStoredKey(gameId: string, entropy: Uint8Array): void {
  try {
    window.localStorage.setItem(STORE_PREFIX + gameId, toBase64Url(entropy));
  } catch {
    // A browser that refuses storage still runs the game: the words are the
    // copy that matters and they are on paper.
  }
}
