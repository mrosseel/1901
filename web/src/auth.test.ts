import { afterEach, describe, expect, it, vi } from "vitest";
import { claimHandover, claimSeat, openSeatSession, SeatClient } from "./api";
import { seatPublicKey, signAsSeat, writeSeatSeed } from "./seatkey";
import { recoverGameMaster } from "./recover";
import { signMessage } from "./gmkey";

function replies(items: Array<{ status?: number; body: unknown }>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const reply = items.shift();
    if (!reply) throw new Error("unexpected request");
    const status = reply.status ?? 200;
    return { ok: status < 400, status, text: async () => JSON.stringify(reply.body), json: async () => reply.body };
  });
  return calls;
}
const seed = new Uint8Array(32).fill(7);
afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });

describe("authentication proofs", () => {
  it("signs the join domain locally and retries with a fresh proof", async () => {
    const calls = replies([
      { body: { nonce: "first", message: "attacker-selected text" } },
      { status: 403, body: { error: "used challenge" } },
      { body: { nonce: "second", message: "another protocol" } },
      { body: { seatUrl: "/game/g/seat/me/", keyed: true } },
    ]);
    await claimSeat("g", "invite", seed);
    expect(calls).toHaveLength(4);
    for (const [index, nonce] of [[1, "first"], [3, "second"]] as const) {
      const body = JSON.parse(calls[index].init!.body as string);
      expect(body).toMatchObject({ signPub: seatPublicKey(seed), nonce,
        signature: signAsSeat(seed, "1901 seat enrollment|g|join|" + nonce) });
      expect(body).not.toHaveProperty("seed");
    }
  });

  it("binds a handover proof to its game, power and epoch", async () => {
    const calls = replies([{ body: { nonce: "n" } }, { body: { keyed: true } }]);
    await claimHandover("g", "France", "4", "link-signature", seed, "chain");
    const body = JSON.parse(calls[1].init!.body as string);
    expect(body.signature).toBe(signAsSeat(seed, "1901 seat enrollment|g|handover:France:4|n"));
    expect(body.keyChainSig).toBe("chain");
    expect(calls[0].url).toContain("/handover/France/4/link-signature");
  });

  it("uses a new challenge to reconnect after a consumed session proof", async () => {
    writeSeatSeed("g", seed);
    const calls = replies([
      { body: { nonce: "old" } }, { status: 403, body: { error: "used" } },
      { body: { nonce: "new" } }, { body: { power: "France" } },
    ]);
    expect(await openSeatSession("g")).toBe("France");
    expect(JSON.parse(calls[3].init!.body as string).signature).toBe(signAsSeat(seed, "1901 seat session|g|new"));
  });

  it("recovery signs only its own domain and retries once", async () => {
    const entropy = new Uint8Array(16).fill(3);
    const calls = replies([
      { body: { nonce: "old", gameId: "g", message: "not recovery" } },
      { status: 403, body: { error: "expired" } },
      { body: { nonce: "fresh", gameId: "g", message: "not recovery" } },
      { body: { gmUrl: "/game/g/gm/new/" } },
    ]);
    expect(await recoverGameMaster("g", entropy)).toBe("/game/g/gm/new/");
    expect(JSON.parse(calls[3].init!.body as string).signature).toBe(signMessage(entropy,"1901 game master recovery|g|fresh"));
  });

  it("does not retry a conflicting enrollment", async () => {
    const calls = replies([{ body: { nonce: "n" } }, { status: 409, body: { error: "key already claimed" } }]);
    await expect(claimSeat("g", "invite", seed)).rejects.toMatchObject({ status: 409 });
    expect(calls).toHaveLength(2);
  });

  it("requests bounded history pages without changing their signed contents", async () => {
    const message = { seq: 125, box: "ciphertext", sig: "signature", at: "2026-09-05T10:00:00Z" };
    const page = { messages: [message], lastSeq: 225, hasOlder: true };
    const calls = replies([{ body: page }, { body: page }, { body: page }]);
    const client = new SeatClient("g", "me");
    await client.pressThread("room");
    expect(calls[0].url).not.toContain("since=");
    expect(await client.pressThread("room", undefined, 126)).toEqual(page);
    expect(calls[1].url).toContain("before=126");
    await client.pressThread("room", 100);
    expect(calls[2].url).toContain("since=100");
  });
});
