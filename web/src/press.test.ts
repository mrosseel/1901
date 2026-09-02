import { describe, expect, it } from "vitest";

import { deriveBoxKey, publicKeyOf, randomBytes, signMessage } from "./keys";
import {
  findRoom,
  holdersFor,
  keyBody,
  newRoomKey,
  pinSignKeys,
  openMessage,
  pressPublicKey,
  roomTitle,
  sameRoom,
  sealMessage,
  signedBody,
  unwrapRoomKey,
  verifyBoxKey,
  verifyPress,
  wrapRoomKey,
  wrapsFor,
  type PressMessage,
  type PressPlace,
  type PressThread,
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

describe("a room key travels to its members and to nobody else", () => {
  it("unwraps for the member it was wrapped for", () => {
    const france = secretFor("France");
    const italy = secretFor("Italy");
    const roomKey = newRoomKey();

    const wrapped = wrapRoomKey(GAME, ROOM, france, publicOf(italy), roomKey);
    expect(Array.from(unwrapRoomKey(GAME, ROOM, italy, wrapped) || [])).toEqual(
      Array.from(roomKey),
    );
  });

  it("does not unwrap for anybody else", () => {
    const france = secretFor("France");
    const italy = secretFor("Italy");
    const austria = secretFor("Austria");
    const wrapped = wrapRoomKey(GAME, ROOM, france, publicOf(italy), newRoomKey());
    expect(unwrapRoomKey(GAME, ROOM, austria, wrapped)).toBeNull();
  });

  /* A wrap carries the game and the room's membership, so one lifted out of
     a stored database cannot be dropped into another game or another room. */
  it("does not unwrap in another game or another membership", () => {
    const france = secretFor("France");
    const italy = secretFor("Italy");
    const wrapped = wrapRoomKey(GAME, ROOM, france, publicOf(italy), newRoomKey());
    expect(unwrapRoomKey("g2", ROOM, italy, wrapped)).toBeNull();
    expect(unwrapRoomKey(GAME, ["Austria", "France", "Italy"], italy, wrapped)).toBeNull();
  });

  it("treats noise as an unreadable room rather than an empty one", () => {
    expect(unwrapRoomKey(GAME, ROOM, secretFor("France"), "not-a-wrap")).toBeNull();
    expect(
      unwrapRoomKey(GAME, ROOM, secretFor("France"), publicOf(secretFor("Italy")) + ".AAAA"),
    ).toBeNull();
  });

  it("wraps for the whole room and names who has no key yet", () => {
    const france = secretFor("France");
    const keys = { France: publicOf(france), Italy: publicOf(secretFor("Italy")) };
    const out = wrapsFor(GAME, ROOM, france, newRoomKey(), ["France", "Italy", "Austria"], {
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
    expect(wrapsFor(GAME, ROOM, france, newRoomKey(), ["Italy"], state).unverified).toEqual([]);

    const lying = { ...state, keys: { Italy: swapped } };
    const out = wrapsFor(GAME, ROOM, france, newRoomKey(), ["Italy"], lying);
    expect(out.unverified).toEqual(["Italy"]);
    expect(out.wraps).toEqual({});
  });

  it("accepts an unsigned key from a seat that has no signing key", () => {
    expect(verifyBoxKey(GAME, "Italy", "whatever", undefined, undefined)).toBe(true);
    expect(verifyBoxKey(GAME, "Italy", "whatever", undefined, "a-signing-key")).toBe(false);
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

    expect(verifyPress(GAME, "t1", message, signPub)).toBe("ok");
    // Another seat's key, the wrong room, and every field the body covers.
    expect(verifyPress(GAME, "t1", message, publicKeyOf(randomBytes(32)))).toBe("bad");
    expect(verifyPress(GAME, "t2", message, signPub)).toBe("bad");
    expect(verifyPress(GAME, "t1", { ...message, box: "other" }, signPub)).toBe("bad");
    expect(verifyPress(GAME, "t1", { ...message, phaseIndex: 1 }, signPub)).toBe("bad");
    expect(verifyPress(GAME, "t1", { ...message, at: "2026-09-02T11:00:00Z" }, signPub)).toBe("bad");
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
A signing key this device has seen cannot be taken away.

Omitting a key was the cheapest attack on the whole scheme: with nothing to
check against, verifyBoxKey lets any box key through, so a server could drop a
power's signing key and then hand out its own press key for that power.
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
    const first = pinSignKeys(GAME, { France: "a", Italy: "b" }, kept);
    expect(first.changed).toEqual([]);
    expect(first.pinned).toEqual({ France: "a", Italy: "b" });
  });

  it("names a key that changed", () => {
    const kept = store();
    pinSignKeys(GAME, { France: "a", Italy: "b" }, kept);
    expect(pinSignKeys(GAME, { France: "a", Italy: "other" }, kept).changed).toEqual(["Italy"]);
  });

  it("names a key that vanished, and keeps the pin", () => {
    const kept = store();
    pinSignKeys(GAME, { France: "a", Italy: "b" }, kept);
    const gone = pinSignKeys(GAME, { France: "a" }, kept);
    expect(gone.changed).toEqual(["Italy"]);
    expect(gone.pinned.Italy).toBe("b");
    // And the pin is what a later wrap is checked against, so the key the
    // server is now offering for Italy cannot pass unverified.
    const out = wrapsFor(GAME, ROOM, secretFor("France"), newRoomKey(), ["Italy"], {
      keys: { Italy: publicOf(secretFor("the server")) },
      keySigs: {},
      signKeys: gone.pinned,
    });
    expect(out.unverified).toEqual(["Italy"]);
  });
});
