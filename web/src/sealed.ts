/*
The orders stay on this phone until every phone has locked in (ADR-004).

The server this app talks to is usually the game master's laptop, and the game
master usually plays. So "the server does not show your orders to anybody" is a
promise, not a property, and the only way to make it a property is for the
server not to be able to read them.

	draft     every order goes into localStorage. Nothing is sent.
	commit    locking sends the orders encrypted under a key this phone holds.
	reveal    once every seat has locked in, this phone sends the key, unasked
	          (ADR-009). The server decrypts and applies them all at once.

**Why an envelope and not a digest.** The first build sent a hash. It kept the
orders off the server and it lost them: a phone that locked in and then went
flat held the only copy, so its power was an NMR. An envelope is on the server
from the lock, and the only thing missing is 32 bytes.

**Where the key comes from.** A seat with a seed derives it (ADR-049), so any
device holding that seed can make it again — a player whose phone died can open
the seat on a second device from their seat link and release the key, and the
orders already on the server become the orders that count. A seat that holds a
token instead, which is the game master's own, has nothing to derive from: it
makes a random key once and keeps it beside the draft, and a dead phone there
is still an NMR.

**What binds an envelope.** XChaCha20-Poly1305, with `<gameId>|<phaseIndex>|
<power>` as associated data. That is not encrypted; the tag covers it. So an
envelope cannot be moved to another phase, another seat or another game, and
sealed.go checks the same three fields when it opens one.

The wire form is base64url of the 24-byte nonce followed by the ciphertext and
its tag. The plaintext is the order list as JSON, sorted by province, which is
what canonicalOrders builds on the Go side.
*/

import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";

import { deriveOrderKey, fromBase64Url, randomBytes, toBase64Url } from "./keys";
import { readSeatSeed } from "./seatkey";

/** One order, as this phone holds it and as the server will read it. */
export interface DraftOrder {
  province: string;
  parts: string[];
}

/*
A phase's worth of drafting: what was written, and the key that seals it.

The key is stored even when it is derived, so nothing on the ordering path has
to reach for the seed. What being derived buys is that it can be made again
somewhere else, not that it is kept anywhere different.
*/
export interface Draft {
  key: string;
  orders: Record<string, string[]>;
}

const STORE_PREFIX = "1901.draft.";
const NONCE_BYTES = 24;
const KEY_BYTES = 32;

function keyFor(gameId: string, phaseIndex: number): string {
  return STORE_PREFIX + gameId + "." + phaseIndex;
}

/** What the three fields bind an envelope to. Never encrypted, always covered. */
function associated(gameId: string, phaseIndex: number, power: string): Uint8Array {
  return new TextEncoder().encode(gameId + "|" + phaseIndex + "|" + power);
}

/** The plaintext: the orders as JSON, sorted, and nothing about the taps. */
export function canonicalOrders(orders: DraftOrder[]): string {
  const sorted = orders
    .slice()
    .sort((a, b) => (a.province < b.province ? -1 : a.province > b.province ? 1 : 0));
  return JSON.stringify(sorted);
}

/** Seals one phase's orders. The result is what a lock sends. */
export function sealOrders(
  gameId: string,
  phaseIndex: number,
  power: string,
  key: Uint8Array,
  orders: DraftOrder[],
): string {
  const nonce = randomBytes(NONCE_BYTES);
  const box = xchacha20poly1305(key, nonce, associated(gameId, phaseIndex, power));
  const body = box.encrypt(new TextEncoder().encode(canonicalOrders(orders)));
  const out = new Uint8Array(nonce.length + body.length);
  out.set(nonce);
  out.set(body, nonce.length);
  return toBase64Url(out);
}

/*
The key for one phase, made if this is the first order of it.

A seat with a seed derives it. A seat without one — the game master's, which
holds a token (ADR-049) — makes 32 random bytes instead, and those live only
here.
*/
function makeKey(gameId: string, phaseIndex: number): string {
  const seed = readSeatSeed(gameId);
  if (seed) return toBase64Url(deriveOrderKey(seed, gameId, phaseIndex));
  return toBase64Url(randomBytes(KEY_BYTES));
}

export function readDraft(gameId: string, phaseIndex: number): Draft {
  try {
    const stored = window.localStorage.getItem(keyFor(gameId, phaseIndex));
    if (stored) {
      const parsed = JSON.parse(stored) as Draft;
      if (parsed && typeof parsed.key === "string" && parsed.orders) return parsed;
    }
  } catch {
    // No storage, or something that is not a draft. Start a new one.
  }
  return { key: makeKey(gameId, phaseIndex), orders: {} };
}

export function writeDraft(gameId: string, phaseIndex: number, draft: Draft): void {
  try {
    window.localStorage.setItem(keyFor(gameId, phaseIndex), JSON.stringify(draft));
  } catch {
    // A phone with no storage still plays. What it loses is the way back
    // after a reload, and the game master's force is the way out of that.
  }
}

/*
Everything this game left behind, once a phase has resolved.

A draft is worthless the moment its phase is over: it was revealed when the
phase resolved and is public. Anything from a phase before the one now being
played goes, so a long game does not fill the phone up.
*/
export function forgetOldDrafts(gameId: string, phaseIndex: number): void {
  try {
    const prefix = STORE_PREFIX + gameId + ".";
    const stale: string[] = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i);
      if (!key || !key.startsWith(prefix)) continue;
      const at = Number(key.slice(prefix.length));
      if (Number.isFinite(at) && at < phaseIndex) stale.push(key);
    }
    for (const key of stale) window.localStorage.removeItem(key);
  } catch {
    // Nothing to clean up that we can reach.
  }
}

/** The draft as a list, which is the shape that goes into an envelope. */
export function draftOrders(draft: Draft): DraftOrder[] {
  return Object.keys(draft.orders)
    .sort()
    .map((province) => ({ province: province, parts: draft.orders[province] }));
}

/** This phase's envelope, for the lock. */
export function sealDraft(
  gameId: string,
  phaseIndex: number,
  power: string,
  draft: Draft,
): string {
  return sealOrders(gameId, phaseIndex, power, fromBase64Url(draft.key), draftOrders(draft));
}
