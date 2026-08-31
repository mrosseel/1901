/*
The one place this app does cryptography.

Three things use it: the game master's key and its twelve words (ADR-048), the
seat key that replaces the token in the address (ADR-049), and the key that
seals a phase's orders (ADR-004). The first two make random bytes, derive a
named key from them, and sign a sentence the server made up; the third derives
a key and encrypts with it. Nothing here holds state and nothing here talks to
the server.

Ed25519 is not in every browser's WebCrypto, and crypto.subtle is unavailable
outside a secure context — which run.sh's plain http on a LAN is. So the maths
is a vendored library and SHA-512 is handed to it explicitly. Nothing in this
app may depend on crypto.subtle. crypto.getRandomValues carries no such rule
and is the one platform call these files make.
*/

import { etc, getPublicKey, sign } from "@noble/ed25519";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";
import { sha512 } from "@noble/hashes/sha512";

/*
Left unset, the curve reaches for crypto.subtle. It is wired here once, at
module load, so every caller below is synchronous and nothing depends on a
secure context.
*/
etc.sha512Sync = (...messages: Uint8Array[]) => sha512(etc.concatBytes(...messages));

/** Base64url with no padding, the shape every key and signature travels in. */
export function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return window.btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(text: string): Uint8Array {
  const binary = window.atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** Random bytes, and the only random thing in this app. */
export function randomBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  window.crypto.getRandomValues(out);
  return out;
}

/*
An Ed25519 seed from some other secret. The name is what keeps one key out of
another's job: the same 32 bytes under two names are two unrelated keys, so a
seat's signing key can never be mistaken for anything else it might later hold.
*/
export function deriveSigningKey(secret: Uint8Array, name: string): Uint8Array {
  return hkdf(sha256, secret, name, "ed25519 seed", 32);
}

/*
The key that seals one phase's orders (ADR-004).

Derived and not random, so it can be made again. A device holding the seat seed
can produce the key for any phase of that game, which is what lets a player
whose phone died open the seat on a second device and release orders that are
already sitting on the server.

The phase is in the derivation, so one released key opens one phase and no
other. The game id is there too, because one device may hold seats in several
games and a key must not travel between them.
*/
export function deriveOrderKey(seed: Uint8Array, gameId: string, phaseIndex: number): Uint8Array {
  return hkdf(sha256, seed, "1901 order key v1", gameId + "|" + phaseIndex, 32);
}

export function publicKeyOf(signingKey: Uint8Array): string {
  return toBase64Url(getPublicKey(signingKey));
}

export function signMessage(signingKey: Uint8Array, message: string): string {
  return toBase64Url(sign(new TextEncoder().encode(message), signingKey));
}
