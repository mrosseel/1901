import { describe, expect, it } from "vitest";

import { deriveBoxKey, publicKeyOf, randomBytes, signMessage } from "./keys";
import {
  findRoom,
  holdersFor,
  keyBody,
  acceptPin,
  chainBody,
  makeRoom,
  newRoomKey,
  newThreadId,
  openRoomKey,
  pinSignKeys,
  openMessage,
  pressPublicKey,
  readPins,
  roomTitle,
  sameRoom,
  sealMessage,
  signedBody,
  unwrapRoomKey,
  verifiers,
  verifyBoxKey,
  verifyChain,
  verifyPress,
  wrapRoomKey,
  wrapsFor,
  type PressMessage,
  type PressPlace,
  type KeyChain,
  type PressState,
  type PressThread,
  type RoomBinding,
} from "./press";

const GAME = "g1";
const ROOM = ["Austria", "France"];

// A seat's press secret, from bytes that stand in for a seat seed.
function secretFor(name: string): Uint8Array {
  const seed = new Uint8Array(32);
  new TextEncoder().encodeInto(name, seed);
  return deriveBoxKey(seed, "1901 seat box v1");
}

// What the seat publishes, by the same call the app publishes with.
const publicOf = pressPublicKey;

const place = (over: Partial<PressPlace> = {}): PressPlace => ({
  threadId: "t1",
  seq: 1,
  sender: "France",
  phaseIndex: 0,
  at: "2026-09-02T10:00:00Z",
  ...over,
});

/* A seat's signing seed, from bytes that stand in for a seat seed. */
function signSeedFor(name: string): Uint8Array {
  const seed = new Uint8Array(32);
  new TextEncoder().encodeInto("sign " + name, seed);
  return seed;
}

/* What the server publishes about a set of holders, honestly. */
function tableFor(names: string[]): Pick<PressState, "keys" | "keySigs" | "signKeys"> {
  const keys: Record<string, string> = {};
  const keySigs: Record<string, string> = {};
  const signKeys: Record<string, string> = {};
  for (const name of names) {
    const boxPub = publicOf(secretFor(name));
    keys[name] = boxPub;
    keySigs[name] = signMessage(signSeedFor(name), keyBody(GAME, name, boxPub));
    signKeys[name] = publicKeyOf(signSeedFor(name));
  }
  return { keys: keys, keySigs: keySigs, signKeys: signKeys };
}

/* The keys a reader believes each holder under, in the shape everything that
   checks a signature takes. */
function trustedFrom(signKeys: Record<string, string>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const holder of Object.keys(signKeys)) out[holder] = [signKeys[holder]];
  return out;
}

function signerFor(name: string): (body: string) => string {
  return (body: string) => signMessage(signSeedFor(name), body);
}

const binding = (over: Partial<RoomBinding> = {}): RoomBinding => ({
  threadId: "AAAAAAAAAAAAAAAAAAAAAA",
  opener: "France",
  openerBoxPub: publicOf(secretFor("France")),
  openedAt: "2026-09-02T10:00:00Z",
  members: ROOM,
  ...over,
});

/* A room as the server hands it back, built from what an opener made. */
function threadOf(
  made: ReturnType<typeof makeRoom>,
  over: Partial<PressThread> = {},
): PressThread {
  return {
    id: made.room.threadId,
    members: made.room.members,
    openedBy: made.room.opener,
    openedAt: made.room.openedAt,
    openerBoxPub: made.room.openerBoxPub,
    sig: made.sig,
    wraps: made.wraps,
    wrapped: "",
    notes: false,
    unread: 0,
    lastSeq: 0,
    lastAt: "",
    ...over,
  };
}

describe("a room key travels to its members and to nobody else", () => {
  it("unwraps for the member it was wrapped for", () => {
    const france = secretFor("France");
    const italy = secretFor("Italy");
    const roomKey = newRoomKey();

    const room = binding();
    const wrapped = wrapRoomKey(GAME, room, "Italy", france, publicOf(italy), roomKey);
    expect(Array.from(unwrapRoomKey(GAME, room, "Italy", italy, wrapped) || [])).toEqual(
      Array.from(roomKey),
    );
  });

  it("does not unwrap for anybody else", () => {
    const france = secretFor("France");
    const italy = secretFor("Italy");
    const austria = secretFor("Austria");
    const room = binding();
    const wrapped = wrapRoomKey(GAME, room, "Italy", france, publicOf(italy), newRoomKey());
    expect(unwrapRoomKey(GAME, room, "Italy", austria, wrapped)).toBeNull();
  });

  /* A wrap carries the whole room, so one lifted out of a stored database
     cannot be dropped into another game, another room with the same members,
     another holder's mailbox, or a room claiming a different opener. */
  it("does not unwrap anywhere but the room and the mailbox it was made for", () => {
    const france = secretFor("France");
    const italy = secretFor("Italy");
    const room = binding();
    const wrapped = wrapRoomKey(GAME, room, "Italy", france, publicOf(italy), newRoomKey());

    expect(unwrapRoomKey("g2", room, "Italy", italy, wrapped)).toBeNull();
    expect(
      unwrapRoomKey(GAME, binding({ threadId: "BBBBBBBBBBBBBBBBBBBBBB" }), "Italy", italy, wrapped),
    ).toBeNull();
    expect(unwrapRoomKey(GAME, binding({ opener: "Austria" }), "Italy", italy, wrapped)).toBeNull();
    expect(
      unwrapRoomKey(GAME, binding({ members: ["Austria", "France", "Italy"] }), "Italy", italy, wrapped),
    ).toBeNull();
    // The same wrap, offered as somebody else's mailbox.
    expect(unwrapRoomKey(GAME, room, "Austria", italy, wrapped)).toBeNull();
  });

  it("treats noise as an unreadable room rather than an empty one", () => {
    const room = binding();
    expect(unwrapRoomKey(GAME, room, "France", secretFor("France"), "not-a-wrap")).toBeNull();
    expect(unwrapRoomKey(GAME, room, "France", secretFor("France"), "AAAA")).toBeNull();
  });

  it("wraps for the whole room and names who has no key yet", () => {
    const france = secretFor("France");
    const keys = { France: publicOf(france), Italy: publicOf(secretFor("Italy")) };
    const out = wrapsFor(GAME, binding(), france, newRoomKey(), ["France", "Italy", "Austria"], {
      keys: keys,
      keySigs: {},
      signKeys: {},
    });
    expect(Object.keys(out.wraps).sort()).toEqual(["France", "Italy"]);
    expect(out.missing).toEqual(["Austria"]);
    expect(out.unverified).toEqual([]);
  });

  /* A key the server hands out but the seat did not sign is a room somebody
     else could read. It is refused, and named, rather than wrapped for. */
  it("refuses a published key its own seat did not sign", () => {
    const france = secretFor("France");
    const signing = randomBytes(32);
    const honest = publicOf(secretFor("Italy"));
    const swapped = publicOf(secretFor("the server"));
    const state = {
      keys: { Italy: honest },
      keySigs: { Italy: signMessage(signing, keyBody(GAME, "Italy", honest)) },
      signKeys: { Italy: publicKeyOf(signing) },
    };
    expect(wrapsFor(GAME, binding(), france, newRoomKey(), ["Italy"], state).unverified).toEqual([]);

    const lying = { ...state, keys: { Italy: swapped } };
    const out = wrapsFor(GAME, binding(), france, newRoomKey(), ["Italy"], lying);
    expect(out.unverified).toEqual(["Italy"]);
    expect(out.wraps).toEqual({});
  });

  it("accepts an unsigned key from a seat that has no signing key", () => {
    expect(verifyBoxKey(GAME, "Italy", "whatever", undefined, undefined)).toBe(true);
    expect(verifyBoxKey(GAME, "Italy", "whatever", undefined, "a-signing-key")).toBe(false);
  });

  it("makes a room id nothing else has", () => {
    expect(newThreadId()).not.toBe(newThreadId());
    expect(newThreadId().length).toBe(22);
  });
});

/*
A room is the opener's, or it is nothing (ADR-056).

The attack this closes is a server that makes up a room: it can read every
member's public key, wrap a key it chose for each of them, and claim an honest
power opened it. What it cannot do is sign the manifest, so a reader that has
pinned that power's signing key refuses the room instead of writing into it.
*/
describe("a signed room manifest", () => {
  const table = tableFor(["Austria", "France"]);

  const opened = () =>
    makeRoom(GAME, "France", secretFor("France"), ROOM, ROOM, table, signerFor("France"));

  it("opens for every member of the room it names", () => {
    const made = opened();
    for (const member of ROOM) {
      const read = openRoomKey(
        GAME,
        member,
        threadOf(made),
        secretFor(member),
        trustedFrom(table.signKeys),
      );
      expect(read.reason).toBeUndefined();
      expect(Array.from(read.key || [])).toEqual(Array.from(made.roomKey));
      expect(read.unverified).toBe(false);
    }
  });

  it("refuses a room the server made up with a key it chose", () => {
    // Everything the server has: the members' public keys, and its own secret.
    const attacker = secretFor("the server");
    const fabricated = makeRoom(GAME, "France", attacker, ROOM, ROOM, table, () => "");
    const read = openRoomKey(
      GAME,
      "Austria",
      threadOf(fabricated),
      secretFor("Austria"),
      trustedFrom(table.signKeys),
    );
    expect(read.key).toBeNull();
    expect(read.reason).toContain("France");
  });

  it("refuses a room whose signature is somebody else's", () => {
    const made = opened();
    const read = openRoomKey(
      GAME,
      "Austria",
      threadOf(made, { sig: signerFor("Austria")("anything") }),
      secretFor("Austria"),
      trustedFrom(table.signKeys),
    );
    expect(read.key).toBeNull();
  });

  it("refuses every change to what the opener signed", () => {
    const made = opened();
    const changes: Partial<PressThread>[] = [
      { id: newThreadId() },
      { openedBy: "Austria" },
      { openedAt: "2026-09-02T11:00:00Z" },
      { members: ["Austria", "France", "Italy"] },
      { openerBoxPub: publicOf(secretFor("the server")) },
      { wraps: { ...made.wraps, Austria: made.wraps.France } },
      { sig: "" },
    ];
    for (const change of changes) {
      const read = openRoomKey(
        GAME,
        "Austria",
        threadOf(made, change),
        secretFor("Austria"),
        trustedFrom(table.signKeys),
      );
      expect(read.key, JSON.stringify(change)).toBeNull();
    }
  });

  /* Two rooms with the same members and the same opener. The wraps still do
     not move: each one names its own room id, and the manifest names each
     wrap by its digest. */
  it("refuses a wrap lifted out of another room with the same members", () => {
    const first = opened();
    const second = opened();
    const read = openRoomKey(
      GAME,
      "Austria",
      threadOf(second, { wraps: { ...second.wraps, Austria: first.wraps.Austria } }),
      secretFor("Austria"),
      trustedFrom(table.signKeys),
    );
    expect(read.key).toBeNull();
  });

  /* An opener that holds no signing key cannot sign, and no pin exists for
     it either. The room opens and is marked as unchecked, which is what the
     panel then says out loud. */
  it("opens a room from a holder with no signing key at all, and says so", () => {
    const bare = { keys: table.keys, keySigs: {}, signKeys: {} };
    const made = makeRoom(GAME, "France", secretFor("France"), ROOM, ROOM, bare, () => "");
    const read = openRoomKey(GAME, "Austria", threadOf(made), secretFor("Austria"), {});
    expect(read.key).not.toBeNull();
    expect(read.unverified).toBe(true);
  });

  it("refuses a room opened before manifests existed", () => {
    const made = opened();
    const old = threadOf(made, { openerBoxPub: undefined, wraps: undefined });
    expect(
      openRoomKey(GAME, "Austria", old, secretFor("Austria"), trustedFrom(table.signKeys)).key,
    ).toBeNull();
  });
});

describe("a message is bound to where it was said", () => {
  const roomKey = newRoomKey();

  it("opens in its own room", () => {
    const box = sealMessage(GAME, place(), roomKey, "Piedmont is yours");
    const message: PressMessage = {
      seq: 1,
      sender: "France",
      phaseIndex: 0,
      box: box,
      sig: "",
      at: "2026-09-02T10:00:00Z",
    };
    expect(openMessage(GAME, "t1", roomKey, message)).toBe("Piedmont is yours");
  });

  it("does not open moved to another game, room, place, mouth, phase or time", () => {
    const box = sealMessage(GAME, place(), roomKey, "Piedmont is yours");
    const base: PressMessage = {
      seq: 1,
      sender: "France",
      phaseIndex: 0,
      box: box,
      sig: "",
      at: "2026-09-02T10:00:00Z",
    };
    expect(openMessage("g2", "t1", roomKey, base)).toBeNull();
    expect(openMessage(GAME, "t2", roomKey, base)).toBeNull();
    expect(openMessage(GAME, "t1", roomKey, { ...base, seq: 2 })).toBeNull();
    expect(openMessage(GAME, "t1", roomKey, { ...base, sender: "Italy" })).toBeNull();
    // The phase and the time are drawn with: the panel rules off where a
    // phase resolved and sorts by time, so a server free to change either
    // could rearrange a conversation without touching a word of it.
    expect(openMessage(GAME, "t1", roomKey, { ...base, phaseIndex: 3 })).toBeNull();
    expect(openMessage(GAME, "t1", roomKey, { ...base, at: "2026-09-02T09:00:00Z" })).toBeNull();
    expect(openMessage(GAME, "t1", newRoomKey(), base)).toBeNull();
  });
});

describe("a signature says which member of the room spoke", () => {
  it("accepts a message the sender's seat key signed", () => {
    const signing = randomBytes(32);
    const box = "the-box";
    const at = place({ seq: 4 });
    const sig = signMessage(signing, signedBody(GAME, at, box));
    const message: PressMessage = {
      seq: 4,
      sender: "France",
      phaseIndex: 0,
      box: box,
      sig: sig,
      at: at.at,
    };
    const signPub = publicKeyOf(signing);

    expect(verifyPress(GAME, "t1", message, [signPub])).toBe("ok");
    // Another seat's key, the wrong room, and every field the body covers.
    expect(verifyPress(GAME, "t1", message, [publicKeyOf(randomBytes(32))])).toBe("bad");
    expect(verifyPress(GAME, "t2", message, [signPub])).toBe("bad");
    expect(verifyPress(GAME, "t1", { ...message, box: "other" }, [signPub])).toBe("bad");
    expect(verifyPress(GAME, "t1", { ...message, phaseIndex: 1 }, [signPub])).toBe("bad");
    expect(
      verifyPress(GAME, "t1", { ...message, at: "2026-09-02T11:00:00Z" }, [signPub]),
    ).toBe("bad");
  });

  /* A seat holding a token has no key to sign with, so its messages are
     honest and unprovable. That is its own state, and not the verified one. */
  it("marks an unsigned message unsigned rather than verified", () => {
    const message: PressMessage = {
      seq: 1,
      sender: "France",
      phaseIndex: 0,
      box: "b",
      sig: "",
      at: "",
    };
    expect(verifyPress(GAME, "t1", message, undefined)).toBe("unsigned");
    // A signature that names a key it does not match is the third state.
    expect(verifyPress(GAME, "t1", { ...message, sig: "nonsense" }, undefined)).toBe("bad");
  });
});

describe("rooms are named by their members", () => {
  const thread = (members: string[]): PressThread => ({
    id: members.join("-"),
    members: members,
    openedBy: members[0],
    openedAt: "",
    wrapped: "",
    notes: members.length === 1,
    unread: 0,
    lastSeq: 0,
    lastAt: "",
  });

  it("is the same room whatever order the members are named in", () => {
    expect(sameRoom(["France", "Italy"], ["Italy", "France"])).toBe(true);
    expect(sameRoom(["France", "Italy"], ["France", "Italy", "Austria"])).toBe(false);
  });

  it("finds the room that already holds these members", () => {
    const threads = [thread(["France", "Italy"]), thread(["France", "Austria"])];
    expect(findRoom(threads, ["Italy", "France"], false)?.id).toBe("France-Italy");
    expect(findRoom(threads, ["Turkey", "France"], false)).toBeUndefined();
    // A room the referee opened is a different room, even with the same
    // powers in it, so asking for a players' room must not find one.
    const refereeRoom = { ...thread(["France"]), openedBy: "*gm" };
    expect(findRoom([refereeRoom], ["France"], false)).toBeUndefined();
    expect(findRoom([refereeRoom], ["France"], true)?.openedBy).toBe("*gm");
    // A handover leaves the dead room beside the one that replaced it, and
    // the rooms arrive oldest first, so the newest match is the live one.
    const dead = { ...thread(["France", "Italy"]), id: "dead" };
    const live = { ...thread(["France", "Italy"]), id: "live" };
    expect(findRoom([dead, live], ["Italy", "France"], false)?.id).toBe("live");
  });

  it("names a room for the other powers in it", () => {
    expect(roomTitle(thread(["France", "Italy", "Austria"]), "France")).toEqual([
      "Italy",
      "Austria",
    ]);
    expect(roomTitle(thread(["France"]), "France")).toEqual([]);
  });

  it("adds the referee to the holders when the referee reads", () => {
    expect(holdersFor(["Italy", "France"], false)).toEqual(["France", "Italy"]);
    expect(holdersFor(["Italy", "France"], true)).toEqual(["France", "Italy", "*gm"]);
  });
});

/*
A signing key this device has seen cannot be taken away, and cannot be
replaced by the server repeating a new one (SR-2).

Omitting a key was the cheapest attack on the whole scheme: with nothing to
check against, verifyBoxKey lets any box key through, so a server could drop a
power's signing key and then hand out its own press key for that power.
Replacing one was almost as cheap, because the pin used to move to whatever
the server said next.
*/
describe("the signing keys this device has seen", () => {
  const store = () => {
    const held: Record<string, string> = {};
    return {
      getItem: (key: string) => held[key] ?? null,
      setItem: (key: string, value: string) => {
        held[key] = value;
      },
    };
  };

  it("pins what it sees the first time and says nothing about it", () => {
    const kept = store();
    const first = pinSignKeys(GAME, { France: "a", Italy: "b" }, [], kept);
    expect(first.changed).toEqual([]);
    expect(first.pending).toEqual([]);
    expect(first.pinned.France).toEqual({ current: "a", history: [] });
  });

  it("holds a changed key pending over every poll that repeats it", () => {
    const kept = store();
    pinSignKeys(GAME, { France: "a", Italy: "b" }, [], kept);
    for (let poll = 0; poll < 3; poll++) {
      const seen = pinSignKeys(GAME, { France: "a", Italy: "other" }, [], kept);
      expect(seen.pending).toEqual(["Italy"]);
      expect(seen.pinned.Italy.current).toBe("b");
      expect(seen.pinned.Italy.pending).toBe("other");
    }
  });

  it("wraps nothing for a holder whose key is pending", () => {
    const believed = verifiers(
      { Italy: { current: "b", pending: "other", history: [] } },
      { Italy: "other" },
    );
    expect(believed.pending).toEqual(["Italy"]);
    const out = wrapsFor(GAME, binding(), secretFor("France"), newRoomKey(), ["Italy"], {
      keys: { Italy: publicOf(secretFor("Italy")) },
      keySigs: {},
      signKeys: believed.current,
      pending: believed.pending,
    });
    expect(out.unverified).toEqual(["Italy"]);
    expect(out.wraps).toEqual({});
  });

  it("checks nothing under a pending key", () => {
    const believed = verifiers(
      { Italy: { current: "b", pending: "other", history: ["older"] } },
      { Italy: "other" },
    );
    expect(believed.current.Italy).toBe("b");
    expect(believed.trusted.Italy).toEqual(["b", "older"]);
  });

  /* The outgoing device signs the step from its own key to the next one, so
     every device that pinned the old key can follow a real handover without
     anybody being asked. */
  it("follows a signed handover on its own", () => {
    const kept = store();
    const old = randomBytes(32);
    const next = randomBytes(32);
    const from = publicKeyOf(old);
    const to = publicKeyOf(next);
    pinSignKeys(GAME, { Italy: from }, [], kept);

    const link: KeyChain = {
      holder: "Italy",
      from: from,
      to: to,
      sig: signMessage(old, chainBody(GAME, "Italy", from, to)),
    };
    expect(verifyChain(GAME, link)).toBe(true);
    const seen = pinSignKeys(GAME, { Italy: to }, [link], kept);
    expect(seen.pending).toEqual([]);
    expect(seen.pinned.Italy.current).toBe(to);
    // The old key stays, so what Italy said before the handover still checks.
    expect(seen.pinned.Italy.history).toEqual([from]);
  });

  it("refuses a step nothing signed, and one signed by the wrong key", () => {
    const old = randomBytes(32);
    const to = publicKeyOf(randomBytes(32));
    const from = publicKeyOf(old);
    expect(verifyChain(GAME, { holder: "Italy", from: from, to: to, sig: "" })).toBe(false);
    expect(
      verifyChain(GAME, {
        holder: "Italy",
        from: from,
        to: to,
        sig: signMessage(randomBytes(32), chainBody(GAME, "Italy", from, to)),
      }),
    ).toBe(false);
    // The right key over the wrong sentence is no better.
    expect(
      verifyChain(GAME, {
        holder: "Italy",
        from: from,
        to: to,
        sig: signMessage(old, chainBody(GAME, "France", from, to)),
      }),
    ).toBe(false);
  });

  it("advances the pin once when the table confirms a handover", () => {
    const kept = store();
    pinSignKeys(GAME, { Italy: "b" }, [], kept);
    pinSignKeys(GAME, { Italy: "other" }, [], kept);
    const pinned = acceptPin(GAME, "Italy", kept);
    expect(pinned.Italy.current).toBe("other");
    expect(pinned.Italy.pending).toBeUndefined();
    expect(pinned.Italy.history).toEqual(["b"]);
    // And it stays there on the next poll, rather than being reported again.
    expect(pinSignKeys(GAME, { Italy: "other" }, [], kept).pending).toEqual([]);
  });

  it("names a key that vanished, and keeps the pin", () => {
    const kept = store();
    pinSignKeys(GAME, { France: "a", Italy: "b" }, [], kept);
    const gone = pinSignKeys(GAME, { France: "a" }, [], kept);
    expect(gone.changed).toEqual(["Italy"]);
    expect(gone.pending).toEqual([]);
    expect(gone.pinned.Italy.current).toBe("b");
    // And the pin is what a later wrap is checked against, so the key the
    // server is now offering for Italy cannot pass unverified.
    const believed = verifiers(gone.pinned, { France: "a" });
    const out = wrapsFor(GAME, binding(), secretFor("France"), newRoomKey(), ["Italy"], {
      keys: { Italy: publicOf(secretFor("the server")) },
      keySigs: {},
      signKeys: believed.current,
      pending: believed.pending,
    });
    expect(out.unverified).toEqual(["Italy"]);
  });

  it("reads a pin written before this version", () => {
    const kept = store();
    kept.setItem("1901.press.pin." + GAME, JSON.stringify({ Italy: "b" }));
    expect(readPins(GAME, kept).Italy).toEqual({ current: "b", history: [] });
  });
});

/*
A missing signature from a seat that has one is somebody taking it off, not a
seat that cannot sign (SR-2).
*/
describe("what a missing signature means", () => {
  const bare: PressMessage = {
    seq: 1,
    sender: "France",
    phaseIndex: 0,
    box: "b",
    sig: "",
    at: "",
  };

  it("is bad from a holder that has a signing key", () => {
    expect(verifyPress(GAME, "t1", bare, [publicKeyOf(randomBytes(32))])).toBe("bad");
  });

  it("is unsigned from a holder that has none", () => {
    expect(verifyPress(GAME, "t1", bare, [])).toBe("unsigned");
    expect(verifyPress(GAME, "t1", bare, undefined)).toBe("unsigned");
  });

  /* A handover replaces the key. What the seat said before it was signed by
     the key it replaced, and that is what the history is for. */
  it("checks an old message against the key that wrote it", () => {
    const old = randomBytes(32);
    const at = place({ seq: 4 });
    const message: PressMessage = {
      seq: 4,
      sender: "France",
      phaseIndex: 0,
      box: "the-box",
      sig: signMessage(old, signedBody(GAME, at, "the-box")),
      at: at.at,
    };
    const now = publicKeyOf(randomBytes(32));
    expect(verifyPress(GAME, "t1", message, [now])).toBe("bad");
    expect(verifyPress(GAME, "t1", message, [now, publicKeyOf(old)])).toBe("ok");
  });
});
