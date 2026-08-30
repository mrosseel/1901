/*
A seat is a key this device holds (D-049).

A seat used to be a secret in the address: whoever read
/game/{id}/seat/{token} was that power, and the same string sat in the
server's database. A copied 1901.db was a set of working seats.

Now the phone makes 32 random bytes when it claims. It derives a signing key
from them, sends the public half, and keeps the seed. The server stores 32
public bytes and can open nothing with them.

Three questions are easy to run together, so they are answered apart:

  Who makes it   This device. crypto.getRandomValues, at the moment of
                 claiming. The server never makes one and never sees one.
  Where it lives This device's storage, one entry per game, so closing the
                 tab does not lose the seat.
  How it travels The fragment of a URL, and only when somebody asks for the
                 seat's link. A browser never puts the part after # in a
                 request, so the seed reaches no server, no log and no
                 Referer header. It is read once at start-up and removed
                 from the address.

Storage alone would be tidier and would break the things this app is for: a
second device, passing the phone round the table, a bookmark, a scanned code.
The address is the seat (D-012), so the address must be able to carry it.
*/

import {
  deriveSigningKey,
  fromBase64Url,
  publicKeyOf,
  randomBytes,
  signMessage as signWith,
  toBase64Url,
} from "./keys";

/* What this key is for. The seat will hold other keys one day — a sealing key
   for D-004's orders — and naming this one keeps them apart. */
const KEY_NAME = "1901 seat sign v1";

const SEED_BYTES = 32;
const STORE_PREFIX = "1901.seat.";

/** A new seat's seed. */
export function makeSeatSeed(): Uint8Array {
  return randomBytes(SEED_BYTES);
}

export function seatPublicKey(seed: Uint8Array): string {
  return publicKeyOf(deriveSigningKey(seed, KEY_NAME));
}

export function signAsSeat(seed: Uint8Array, message: string): string {
  return signWith(deriveSigningKey(seed, KEY_NAME), message);
}

export function readSeatSeed(gameId: string): Uint8Array | null {
  try {
    const stored = window.localStorage.getItem(STORE_PREFIX + gameId);
    if (!stored) return null;
    const seed = fromBase64Url(stored);
    return seed.length === SEED_BYTES ? seed : null;
  } catch {
    return null;
  }
}

export function writeSeatSeed(gameId: string, seed: Uint8Array): void {
  try {
    window.localStorage.setItem(STORE_PREFIX + gameId, toBase64Url(seed));
  } catch {
    // Storage refused. The seat still works for as long as this page is
    // open, and the address in the bar is the copy that survives.
  }
}

export function forgetSeatSeed(gameId: string): void {
  try {
    window.localStorage.removeItem(STORE_PREFIX + gameId);
  } catch {
    // Nothing to do, and nothing that matters: the seat was already gone.
  }
}

/*
The seed a link brought, moved into storage and cleared from the address.

Two browser behaviours make the clearing worth doing even though it is not
airtight. A redirect keeps the fragment when the new address has none of its
own, so a key can arrive on a page that did not expect it. And the history
entry is written before any code runs, so the seed is in this device's history
whatever happens here — which is a reason to strip the bar, not a reason to
skip it.
*/
export function takeSeedFromAddress(gameId: string): Uint8Array | null {
  const match = /(?:^|[#&])k=([A-Za-z0-9_-]+)/.exec(window.location.hash);
  if (!match) return null;
  let seed: Uint8Array;
  try {
    seed = fromBase64Url(match[1]);
  } catch {
    return null;
  }
  if (seed.length !== SEED_BYTES) return null;
  writeSeatSeed(gameId, seed);
  window.history.replaceState(null, "", window.location.pathname + window.location.search);
  return seed;
}

/** The portable copy of a seat, for a second device or a passed phone. */
export function seatLink(gameId: string, seed: Uint8Array): string {
  return (
    window.location.origin +
    "/game/" +
    encodeURIComponent(gameId) +
    "/seat/me/#k=" +
    toBase64Url(seed)
  );
}
