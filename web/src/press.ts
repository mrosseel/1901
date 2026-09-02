/*
Press, on the phone that can read it (ADR-053, ADR-054).

The server holds ciphertext and a member list. Everything that turns that back
into a conversation happens here:

	room key   32 random bytes, made by whoever opens the room.
	wrap       the room key, encrypted once per member under a key this seat
	           and that member agree on from their two press keys.
	message    the text, encrypted under the room key, then signed by the
	           sender's seat key so the server cannot put words in a mouth.

**What binds a message.** XChaCha20-Poly1305, with `<gameId>|<threadId>|<seq>|
<sender>|<phaseIndex>|<at>` as associated data, which is every field the server
stores in the clear beside the box. So a message cannot be moved to another
room, another game, another place in the order, another mouth, another phase or
another time, and a server that tried would produce something no reader can
open. The phase and the time are in there because the panel draws with them: it
rules off where a phase resolved and it sorts by time, so a server free to
change either could rearrange a conversation without touching a word of it.

**What binds a wrap.** The same cipher, with the room's whole immutable
description as associated data: the game, the thread id, the opener, the
opener's press key, the holder this copy is for, and the member list. So a wrap
cannot be replayed into another game, another room with the same members,
another holder's mailbox, or a room whose opener is claimed to be somebody else.

**What binds the room.** The opener signs a manifest over those same fields,
the time the room was opened, and a digest of every wrap in it (ADR-056). A
reader checks that signature against the signing key it has pinned for the
opener before it unwraps anything. That is what makes a room the server made up
fail: the server can wrap a key it chose for every member, and it cannot sign
the manifest that says who opened the room.

**Why the signature as well as the box.** The box says the writer held the room
key. Every member holds it, so inside a room of three the box alone does not
say which of the three wrote a line. The Ed25519 signature does, and it is
checked against the same public key the seat authenticates with.

**Where this seat's press key comes from.** The seat seed (ADR-049), under its
own name. A seat holding a token instead makes 32 random bytes once and keeps
them in this device's storage: the same hole the order key has, and it fails
the same way.

**What none of this defends against.** The public keys come from the server. A
server that lies about them — handing out its own X25519 key in place of
Italy's — reads everything wrapped for that key. Signing the box key with the
seat key raises the bar to lying about both halves at once, and pinning what
this device has already seen (pinSignKeys) makes a later swap visible. Neither
makes a first contact with a lying server safe, and ADR-054 says so plainly
rather than implying otherwise.

**What the server still sees.** Who is in every room, who opened it, when, how
often each member writes, and how far each of them has read. Press is
content-encrypted and metadata-visible, and ADR-054 says which is which.
*/

import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha256";

import {
  boxPublicKeyOf,
  deriveBoxKey,
  deriveSigningKey,
  fromBase64Url,
  randomBytes,
  signMessage,
  toBase64Url,
  wrapKeyFor,
} from "./keys";
import { readSeatSeed } from "./seatkey";

/** What this seat's press key is for. Never the signing key's name. */
const BOX_KEY_NAME = "1901 seat box v1";
/** The seat's own signing key, named as seatkey.ts names it. */
const SIGN_KEY_NAME = "1901 seat sign v1";
/** The game master's, named as gmkey.ts names it. */
const GM_SIGN_KEY_NAME = "1901 game master key v1";

const NONCE_BYTES = 24;
const KEY_BYTES = 32;
/** A thread id, made here so the opener can sign it (ADR-056). */
const THREAD_ID_BYTES = 16;
const BOX_STORE_PREFIX = "1901.press.box.";

/** The game master in a member list, matching gmHolder on the server. */
export const GM_HOLDER = "*gm";

/** One room as the server describes it. Bodies come separately. */
export interface PressThread {
  id: string;
  members: string[];
  openedBy: string;
  openedAt: string;
  /** The opener's press key at the moment the room was opened. */
  openerBoxPub?: string;
  /** The opener's signing key then, so a handover does not break old rooms. */
  openerSignPub?: string;
  /** The opener's signature over this room's manifest (ADR-056). */
  sig?: string;
  /** Every wrap in the room, so a reader can recompute the signed digest. */
  wraps?: Record<string, string>;
  /** This reader's own wrapped copy of the room key. */
  wrapped: string;
  notes: boolean;
  unread: number;
  lastSeq: number;
  lastAt: string;
  messages?: PressMessage[];
}

export interface PressMessage {
  seq: number;
  sender: string;
  phaseIndex: number;
  box: string;
  sig: string;
  at: string;
}

/*
What a signature said about a message, in the three states it can be in.

  ok         signed by the seat it names
  unsigned   no signature at all, which is what a seat holding a token sends
  bad        a signature that does not check, which is somebody lying

The middle one is not the first. A seat with no key cannot sign, so its
messages are honest and unprovable; drawing them as verified would be this app
claiming something it did not check.
*/
export type PressProof = "ok" | "unsigned" | "bad";

/** A message this device could open, with the plain text in it. */
export interface ReadMessage extends PressMessage {
  text: string;
  proof: PressProof;
}

export interface PressState {
  enabled: boolean;
  open: boolean;
  reason?: string;
  /** Whether the notepad takes writing, which the gates do not close. */
  notesOpen: boolean;
  notesReason?: string;
  silenceAt: string | null;
  mode: string;
  you: string;
  gmReads: boolean;
  /** Every holder's public press key, by holder. */
  keys: Record<string, string>;
  /** Each published key's own signature, by holder. */
  keySigs: Record<string, string>;
  /** The seats' signing keys, for checking who really said a line. */
  signKeys: Record<string, string>;
  eliminated: string[];
  threads: PressThread[];
  unread: number;
}

/*
This device's press secret for one game.

Derived where there is a seed to derive from, so a second device opened from
the seat's own link reads the same rooms. Random and stored where there is
not, which is the game master's own seat and every seat of a game made before
ADR-049.
*/
export function pressSecret(gameId: string): Uint8Array {
  const seed = readSeatSeed(gameId);
  if (seed) return deriveBoxKey(seed, BOX_KEY_NAME);
  return storedSecret(BOX_STORE_PREFIX + gameId);
}

/** The press secret of the game master's own key (ADR-048, ADR-054). */
export function gmPressSecret(gameId: string, gmSeed: Uint8Array | null): Uint8Array {
  if (gmSeed) return deriveBoxKey(gmSeed, "1901 gm box v1");
  return storedSecret(BOX_STORE_PREFIX + "gm." + gameId);
}

function storedSecret(key: string): Uint8Array {
  try {
    const stored = window.localStorage.getItem(key);
    if (stored) return fromBase64Url(stored);
  } catch {
    // No storage. The bytes below still work for this page's lifetime.
  }
  const made = randomBytes(KEY_BYTES);
  try {
    window.localStorage.setItem(key, toBase64Url(made));
  } catch {
    // A seat with no storage reads its rooms until the tab closes.
  }
  return made;
}

/** The public half this seat publishes, so others can wrap for it. */
export function pressPublicKey(secret: Uint8Array): string {
  return boxPublicKeyOf(secret);
}

/** The seat's signing key, for putting a name on what it says. */
function signingKeyFor(gameId: string): Uint8Array | null {
  const seed = readSeatSeed(gameId);
  return seed ? deriveSigningKey(seed, SIGN_KEY_NAME) : null;
}

/** Where a message sits: every field the server keeps in the clear beside it. */
export interface PressPlace {
  threadId: string;
  seq: number;
  sender: string;
  phaseIndex: number;
  at: string;
}

/** What binds one message. Never encrypted, always covered. */
function associated(gameId: string, at: PressPlace): Uint8Array {
  return new TextEncoder().encode(
    [gameId, at.threadId, at.seq, at.sender, at.phaseIndex, at.at].join("|"),
  );
}

/** What a signature covers: the ciphertext, in the place it belongs. */
export function signedBody(gameId: string, at: PressPlace, box: string): string {
  return "1901 press|" + [gameId, at.threadId, at.seq, at.sender, at.phaseIndex, at.at].join("|") +
    "|" + box;
}

/** What a seat signs over the press key it publishes (ADR-054). */
export function keyBody(gameId: string, holder: string, boxPub: string): string {
  return "1901 press key|" + gameId + "|" + holder + "|" + boxPub;
}

/*
A room, in the fields that are fixed the moment it opens (ADR-056).

Everything here is signed by the opener and covered by every wrap in the room,
so none of it can be changed afterwards by the server that stores it.
*/
export interface RoomBinding {
  threadId: string;
  opener: string;
  openerBoxPub: string;
  openedAt: string;
  members: string[];
}

/** A room id, made on the opener's device so the opener can sign it. */
export function newThreadId(): string {
  return toBase64Url(randomBytes(THREAD_ID_BYTES));
}

/** The room's fixed description, read off what the server sent back. */
export function roomBinding(thread: PressThread): RoomBinding {
  return {
    threadId: thread.id,
    opener: thread.openedBy,
    openerBoxPub: thread.openerBoxPub || "",
    openedAt: thread.openedAt,
    members: thread.members,
  };
}

/*
What binds one wrap: the whole room, and the holder this copy is for.

The holder is in there because a wrap moved to another mailbox would otherwise
open, and the opener's press key is in there because a reader that took it from
the wrap instead would believe whatever the server put in front of it.
*/
function wrapAssociated(gameId: string, room: RoomBinding, holder: string): Uint8Array {
  return new TextEncoder().encode(
    "1901 press wrap v2|" +
      [
        gameId,
        room.threadId,
        room.opener,
        room.openerBoxPub,
        holder,
        room.members.slice().sort().join(","),
      ].join("|"),
  );
}

/** One wrap, as the manifest names it. */
function wrapDigest(wrapped: string): string {
  return toBase64Url(sha256(new TextEncoder().encode(wrapped)));
}

/*
What the opener signs: the room, and a digest of every wrap in it.

The digests are what stop a wrap being replaced, moved between holders, or
lifted out of another room with the same members. A reader recomputes them from
the wraps the server handed over, so a changed wrap breaks the signature rather
than quietly opening under a key somebody else chose.
*/
export function manifestBody(
  gameId: string,
  room: RoomBinding,
  wraps: Record<string, string>,
): string {
  const digests = Object.keys(wraps)
    .sort()
    .map((holder) => holder + "=" + wrapDigest(wraps[holder]))
    .join(",");
  return (
    "1901 press room v1|" +
    [
      gameId,
      room.threadId,
      room.opener,
      room.openerBoxPub,
      room.openedAt,
      room.members.slice().sort().join(","),
      digests,
    ].join("|")
  );
}

/** A new room's key. Nothing derives it: a room is not a phase. */
export function newRoomKey(): Uint8Array {
  return randomBytes(KEY_BYTES);
}

/*
The room key, wrapped for one holder.

The wrap is itself an envelope: nonce, ciphertext, tag, under the key the two
press keys agree on. Nothing travels with it. A reader takes the opener's
public key from the room's manifest, which the opener signed, and never from
the wrap, which is where the server used to be able to put its own.
*/
export function wrapRoomKey(
  gameId: string,
  room: RoomBinding,
  holder: string,
  ourSecret: Uint8Array,
  theirPublic: string,
  roomKey: Uint8Array,
): string {
  const key = wrapKeyFor(ourSecret, theirPublic);
  const nonce = randomBytes(NONCE_BYTES);
  const body = xchacha20poly1305(key, nonce, wrapAssociated(gameId, room, holder)).encrypt(roomKey);
  const out = new Uint8Array(nonce.length + body.length);
  out.set(nonce);
  out.set(body, nonce.length);
  return toBase64Url(out);
}

/** The room key back, or null when this wrap was not made for us. */
export function unwrapRoomKey(
  gameId: string,
  room: RoomBinding,
  holder: string,
  ourSecret: Uint8Array,
  wrapped: string,
): Uint8Array | null {
  try {
    const raw = fromBase64Url(wrapped);
    if (raw.length <= NONCE_BYTES) return null;
    const key = wrapKeyFor(ourSecret, room.openerBoxPub);
    return xchacha20poly1305(key, raw.slice(0, NONCE_BYTES), wrapAssociated(gameId, room, holder))
      .decrypt(raw.slice(NONCE_BYTES));
  } catch {
    // A wrap made for somebody else, or noise from a modified client. The
    // room shows as unreadable rather than as empty.
    return null;
  }
}

/*
What a reader could establish about a room before opening it.

`key` is null unless every check passed. `unverified` marks the one case where
a room opens without a signature: an opener that has no signing key at all,
which is a seat holding a token and every seat of a game made before ADR-049.
The panel draws that differently rather than pretending it was checked.
*/
export interface RoomRead {
  key: Uint8Array | null;
  reason?: string;
  unverified?: boolean;
}

/*
The room key, once the room has been shown to be the opener's own (ADR-056).

The order matters. The signature is checked first, because everything else in
the room is only worth checking if the opener put it there. Then this reader's
own wrap, which the manifest already named by its digest, is opened under the
key this seat and the opener agree on.

A room that fails any of it is unreadable and says why. It is never shown as an
empty room: a reader who is being lied to has to see the lie.
*/
export function openRoomKey(
  gameId: string,
  you: string,
  thread: PressThread,
  ourSecret: Uint8Array,
  signKeys: Record<string, string>,
): RoomRead {
  const wraps = thread.wraps;
  if (!thread.openerBoxPub || !wraps) {
    return { key: null, reason: "This room was opened before this version and cannot be checked." };
  }
  const room = roomBinding(thread);
  const body = manifestBody(gameId, room, wraps);
  const signPub = signKeys[thread.openedBy];
  let unverified = false;
  if (signPub) {
    if (!thread.sig) {
      return { key: null, reason: "This room carries no signature from " + thread.openedBy + "." };
    }
    if (!verifySignature(thread.sig, body, signPub)) {
      return {
        key: null,
        reason: "This room was not opened by " + thread.openedBy + ". Nothing here can be trusted.",
      };
    }
  } else {
    // Nobody has a key for this holder, neither the server nor this device's
    // pins, so there is nothing a signature could be checked against.
    unverified = true;
  }
  const mine = wraps[you];
  if (!mine) {
    return { key: null, reason: "This room holds no key for you." };
  }
  const key = unwrapRoomKey(gameId, room, you, ourSecret, mine);
  if (!key) {
    return {
      key: null,
      reason:
        "This device cannot open this conversation. The key was wrapped for a " +
        "different device, which is what a handover leaves behind.",
    };
  }
  return { key: key, unverified: unverified };
}

function verifySignature(sig: string, body: string, signPub: string): boolean {
  try {
    return ed25519.verify(
      fromBase64Url(sig),
      new TextEncoder().encode(body),
      fromBase64Url(signPub),
    );
  } catch {
    return false;
  }
}

/** One message, boxed under the room key. */
export function sealMessage(
  gameId: string,
  place: PressPlace,
  roomKey: Uint8Array,
  text: string,
): string {
  const nonce = randomBytes(NONCE_BYTES);
  const box = xchacha20poly1305(roomKey, nonce, associated(gameId, place));
  const body = box.encrypt(new TextEncoder().encode(text));
  const out = new Uint8Array(nonce.length + body.length);
  out.set(nonce);
  out.set(body, nonce.length);
  return toBase64Url(out);
}

/** The text back, or null when this device cannot open it. */
export function openMessage(
  gameId: string,
  threadId: string,
  roomKey: Uint8Array,
  message: PressMessage,
): string | null {
  try {
    const raw = fromBase64Url(message.box);
    if (raw.length <= NONCE_BYTES) return null;
    const box = xchacha20poly1305(roomKey, raw.slice(0, NONCE_BYTES), associated(gameId, {
      threadId: threadId,
      seq: message.seq,
      sender: message.sender,
      phaseIndex: message.phaseIndex,
      at: message.at,
    }));
    return new TextDecoder().decode(box.decrypt(raw.slice(NONCE_BYTES)));
  } catch {
    return null;
  }
}

/** This seat's signature over one message, or "" when it holds no seed. */
/*
How this seat signs what it publishes and what it says.

A seat holding a token has no signing key and signs nothing: its messages go
out unsigned, which readers accept and mark as unverified rather than reject.
That is the same seat that cannot derive a press key either, and it fails the
same two ways for the same one reason.
*/
export function seatSigner(gameId: string): (body: string) => string {
  const key = signingKeyFor(gameId);
  return (body: string) => (key ? signMessage(key, body) : "");
}

/*
How the game master signs, with the key of ADR-048 rather than a seat's.

The public half is the one the twelve words recover, and it is the half the
server already publishes, so a ruling is checked against the same key that
proves who the game master is.
*/
export function gmSigner(gmSeed: Uint8Array | null): (body: string) => string {
  if (!gmSeed) return () => "";
  const key = deriveSigningKey(gmSeed, GM_SIGN_KEY_NAME);
  return (body: string) => signMessage(key, body);
}

/*
Whether a published press key really is the one that holder published.

The server hands out both halves, so this alone does not stop a server that
lies about both. What it does stop is the cheaper lie — swapping only the box
key — and together with pinSignKeys it makes the expensive one visible to any
device that has seen the holder's signing key before.
*/
export function verifyBoxKey(
  gameId: string,
  holder: string,
  boxPub: string,
  sig: string | undefined,
  signPub: string | undefined,
): boolean {
  // A seat with no signing key cannot sign its own. That is the game master's
  // own seat and every seat of a game made before ADR-049.
  if (!signPub) return true;
  if (!sig) return false;
  return verifySignature(sig, keyBody(gameId, holder, boxPub), signPub);
}

/*
What can be said about who wrote a message.

An unsigned message is not a forgery: a seat holding a token has no signing key
and sends "". It is not a verified message either, and the panel says so rather
than drawing it like one. What must never pass as ordinary is a signature that
does not check, which is a server or a client putting words in a mouth.
*/
export function verifyPress(
  gameId: string,
  threadId: string,
  message: PressMessage,
  senderSignPub: string | undefined,
): PressProof {
  if (!message.sig) return "unsigned";
  if (!senderSignPub) return "bad";
  const place: PressPlace = {
    threadId: threadId,
    seq: message.seq,
    sender: message.sender,
    phaseIndex: message.phaseIndex,
    at: message.at,
  };
  return verifySignature(message.sig, signedBody(gameId, place, message.box), senderSignPub)
    ? "ok"
    : "bad";
}

/*
The wraps a new room needs: one per member, plus the game master when the game
master reads press.

A holder with no published key cannot be wrapped for, and the caller is told
which, because "France has not opened the app yet" is a thing a player can act
on and a silent missing key is not.
*/
export function wrapsFor(
  gameId: string,
  room: RoomBinding,
  ourSecret: Uint8Array,
  roomKey: Uint8Array,
  holders: string[],
  state: Pick<PressState, "keys" | "keySigs" | "signKeys">,
): { wraps: Record<string, string>; missing: string[]; unverified: string[] } {
  const wraps: Record<string, string> = {};
  const missing: string[] = [];
  const unverified: string[] = [];
  for (const holder of holders) {
    const publicKey = state.keys[holder];
    if (!publicKey) {
      missing.push(holder);
      continue;
    }
    // A key that does not check is worse than a key that is not there: it is
    // a room whose contents somebody else can read. The caller refuses.
    if (!verifyBoxKey(gameId, holder, publicKey, state.keySigs[holder], state.signKeys[holder])) {
      unverified.push(holder);
      continue;
    }
    wraps[holder] = wrapRoomKey(gameId, room, holder, ourSecret, publicKey, roomKey);
  }
  return { wraps: wraps, missing: missing, unverified: unverified };
}

/*
Everything a device needs to send to open a room: the room, its wraps, and the
opener's signature over both.

The manifest is built from the wraps that were actually made, so a room that
could not be wrapped for everybody is refused by the caller before this is
ever signed.
*/
export interface NewRoom {
  room: RoomBinding;
  roomKey: Uint8Array;
  wraps: Record<string, string>;
  sig: string;
  missing: string[];
  unverified: string[];
}

export function makeRoom(
  gameId: string,
  opener: string,
  ourSecret: Uint8Array,
  members: string[],
  holders: string[],
  state: Pick<PressState, "keys" | "keySigs" | "signKeys">,
  sign: (body: string) => string,
): NewRoom {
  const room: RoomBinding = {
    threadId: newThreadId(),
    opener: opener,
    openerBoxPub: pressPublicKey(ourSecret),
    // The same spelling the server checks and the same one a message uses:
    // UTC, no fractional seconds. The opener signs the spelling, not the
    // instant, so nothing may reformat it afterwards.
    openedAt: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
    members: members.slice().sort(),
  };
  const roomKey = newRoomKey();
  const wrapped = wrapsFor(gameId, room, ourSecret, roomKey, holders, state);
  return {
    room: room,
    roomKey: roomKey,
    wraps: wrapped.wraps,
    sig: sign(manifestBody(gameId, room, wrapped.wraps)),
    missing: wrapped.missing,
    unverified: wrapped.unverified,
  };
}

/*
The signing keys this device has seen before, and whether any of them changed.

A seat's signing key is fixed for as long as one person holds the seat, and a
handover replaces it (ADR-049). So a change is either a handover, which the
table knows about, or a server handing out a key it made up. Neither is a thing
to hide: the panel names the powers whose key is new and lets the player decide
whether that matches what happened at the table.
*/
const PIN_PREFIX = "1901.press.pin.";

/*
Where the pins live. The store is a parameter for the same reason split.ts
makes it one: the arithmetic and the rule can then be tested without a browser.
*/
type Store = Pick<Storage, "getItem" | "setItem">;

function storage(given?: Store): Store | null {
  if (given) return given;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function readPins(gameId: string, given?: Store): Record<string, string> {
  const store = storage(given);
  if (!store) return {};
  try {
    return JSON.parse(store.getItem(PIN_PREFIX + gameId) || "{}");
  } catch {
    // Nothing pinned, or something that is not a pin table.
    return {};
  }
}

/*
Pin what has not been seen before, and report what stopped matching.

Two different jobs, and only one of them refuses anything:

  a key that CHANGED     is reported and then pinned at its new value. A
                         handover changes a seat's key for real (ADR-049), so
                         a pin that refused the new one would end that seat's
                         press for the rest of the game. The warning is the
                         defence, and the table is the one that knows which
                         kind of change this was.
  a key that VANISHED    is reported and keeps its pin, which is then what
                         everything is checked against. Otherwise the cheapest
                         attack on the whole scheme would be to omit a signing
                         key: with nothing to check against, verifyBoxKey lets
                         any box key through, and a device that had already
                         seen the real one would never notice.
*/
export function pinSignKeys(
  gameId: string,
  signKeys: Record<string, string>,
  given?: Store,
): { pinned: Record<string, string>; changed: string[] } {
  const pinned = readPins(gameId, given);
  const changed: string[] = [];
  for (const holder of Object.keys(pinned)) {
    if (signKeys[holder] === undefined || signKeys[holder] !== pinned[holder]) {
      changed.push(holder);
    }
  }
  for (const holder of Object.keys(signKeys)) {
    pinned[holder] = signKeys[holder];
  }
  try {
    storage(given)?.setItem(PIN_PREFIX + gameId, JSON.stringify(pinned));
  } catch {
    // Without storage there is nothing to compare against next time.
  }
  return { pinned: pinned, changed: changed.sort() };
}

/** The holders a room between these members needs keys for. */
export function holdersFor(members: string[], gmReads: boolean): string[] {
  const out = members.slice().sort();
  if (gmReads) out.push(GM_HOLDER);
  return out;
}

/** Two member lists name the same room when they hold the same powers. */
export function sameRoom(a: string[], b: string[]): boolean {
  return a.slice().sort().join(",") === b.slice().sort().join(",");
}

/*
The room in this list with exactly these members, opened by the same side.

The server keeps a room the game master opened apart from one the powers
opened, even with identical membership (ADR-054), so the panel has to ask the
same question or it would hand a power the referee's room and refuse to let
the referee open one at all. It also takes the newest match, for the same
reason the server does: a handover leaves a room nobody can open beside the
one that replaced it, and the rooms arrive oldest first.
*/
export function findRoom(
  threads: PressThread[],
  members: string[],
  byGM: boolean,
): PressThread | undefined {
  // The newest, matching the server's own rule: after a handover those
  // members have a dead room and a live one, and the live one is the later.
  const matching = threads.filter(
    (thread) => sameRoom(thread.members, members) && (thread.openedBy === GM_HOLDER) === byGM,
  );
  return matching.length ? matching[matching.length - 1] : undefined;
}

/*
How a room is named on screen: the other powers in it, never this seat.

A row that said "France, Italy" to France would waste half the line saying
something the reader already knows. A room with one member is the reader's own
and is named for what it is.
*/
export function roomTitle(thread: PressThread, you: string): string[] {
  const others = thread.members.filter((member) => member !== you);
  return others.length ? others : [];
}
