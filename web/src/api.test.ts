import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  claimSeat,
  createGame,
  fetchGames,
  fetchVariants,
  parseRoute,
  postJSON,
  publicUrl,
  watchMapUrl,
  watchPath,
  watchUrl,
} from "./api";

function stubFetch(reply: { ok: boolean; status: number; body: string }) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init: init });
    return {
      ok: reply.ok,
      status: reply.status,
      text: async () => reply.body,
      json: async () => JSON.parse(reply.body),
    } as unknown as Response;
  });
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe("routes", () => {
  it("reads the four page addresses", () => {
    expect(parseRoute("/")).toEqual({ kind: "index" });
    expect(parseRoute("/new")).toEqual({ kind: "new" });
    // The root is the landing page and the list has its own address (D-043).
    expect(parseRoute("/games")).toEqual({ kind: "games" });
    expect(parseRoute("/games/")).toEqual({ kind: "games" });
    expect(parseRoute("/join/7/abc")).toEqual({
      kind: "join",
      gameId: "7",
      inviteToken: "abc",
    });
    expect(parseRoute("/game/7/gm/tok/")).toEqual({
      kind: "gm",
      gameId: "7",
      gmToken: "tok",
    });
    expect(parseRoute("/game/7/seat/tok/")).toEqual({
      kind: "seat",
      gameId: "7",
      seatToken: "tok",
    });
  });

  it("reads the spectator address, with and without a phase", () => {
    expect(parseRoute("/watch/7")).toEqual({ kind: "watch", gameId: "7", phaseIndex: null });
    expect(parseRoute("/watch/7/")).toEqual({ kind: "watch", gameId: "7", phaseIndex: null });
    expect(parseRoute("/watch/7/3")).toEqual({ kind: "watch", gameId: "7", phaseIndex: 3 });
    expect(parseRoute("/watch/7/0")).toEqual({ kind: "watch", gameId: "7", phaseIndex: 0 });
  });

  it("treats anything else as unknown", () => {
    expect(parseRoute("/game/7/seat/tok/state").kind).toBe("unknown");
    expect(parseRoute("/g/test-ui/").kind).toBe("unknown");
    // A phase that is not a number is not a phase.
    expect(parseRoute("/watch/7/latest").kind).toBe("unknown");
    expect(parseRoute("/watch").kind).toBe("unknown");
  });

  it("addresses the public endpoint without a token", () => {
    expect(publicUrl("7")).toBe("http://localhost:3000/game/7/public");
  });

  it("addresses the spectator feed beside the page it feeds", () => {
    expect(watchPath("7", null)).toBe("/watch/7");
    expect(watchPath("7", 2)).toBe("/watch/7/2");
    expect(watchUrl("7", null)).toBe("http://localhost:3000/game/7/watch");
    expect(watchUrl("7", 2)).toBe("http://localhost:3000/game/7/watch/2");
  });

  it("gives the spectator a map it needs no token for", () => {
    expect(watchMapUrl("7")).toBe("http://localhost:3000/game/7/map.svg");
  });
});

describe("requests", () => {
  it("sends the settings the contract asks for", async () => {
    const calls = stubFetch({ ok: true, status: 200, body: '{"gameId":"7"}' });
    await createGame({ deadlineMinutes: 15, gmPlays: true });
    expect(calls[0].url).toBe("http://localhost:3000/games");
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      settings: { deadlineMinutes: 15, gmPlays: true },
    });
  });

  it("sends the chosen variant with the settings", async () => {
    const calls = stubFetch({ ok: true, status: 200, body: '{"gameId":"7"}' });
    await createGame({ deadlineMinutes: 0, gmPlays: false, variant: "hundred" });
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      settings: { deadlineMinutes: 0, gmPlays: false, variant: "hundred" },
    });
  });

  it("reads the variant catalogue, classical first", async () => {
    const calls = stubFetch({
      ok: true,
      status: 200,
      body: JSON.stringify([
        { key: "hundred", name: "Hundred", powers: ["Burgundy", "England", "France"] },
        { key: "classical", name: "Classical", powerCount: 7, supported: true },
      ]),
    });
    const list = await fetchVariants();
    expect(calls[0].url).toBe("http://localhost:3000/variants");
    expect(list.map((v) => v.key)).toEqual(["classical", "hundred"]);
    expect(list[1].powerCount).toBe(3);
    expect(list[1].mapUrl).toBe("/variants/hundred/map.svg");
  });

  it("claims a power under the game, not under the join page", async () => {
    const calls = stubFetch({ ok: true, status: 200, body: '{"seatUrl":"/game/7/seat/s/"}' });
    const answer = await claimSeat("7", "invite", "pub");
    expect(calls[0].url).toBe("http://localhost:3000/game/7/join/invite");
    expect(answer.seatUrl).toBe("/game/7/seat/s/");
  });

  it("reads the game list from the token-free endpoint", async () => {
    const calls = stubFetch({
      ok: true,
      status: 200,
      body: JSON.stringify([
        { gameId: "7", started: true, referee: false },
        { gameId: "9", started: false, referee: true },
      ]),
    });
    const list = await fetchGames();
    expect(calls[0].url).toBe("http://localhost:3000/games/list");
    expect(list.map((game) => game.gameId)).toEqual(["7", "9"]);
    expect(list[1].referee).toBe(true);
  });

  it("shows the server's own sentence when a power cannot be had", async () => {
    stubFetch({
      ok: false,
      status: 409,
      body: '{"error":"every power is taken — ask the GM for a seat"}',
    });
    const failure = await claimSeat("7", "invite", "pub").catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).status).toBe(409);
    expect((failure as ApiError).message).toBe("every power is taken — ask the GM for a seat");
  });

  it("accepts an empty body from a POST that answers with nothing", async () => {
    stubFetch({ ok: true, status: 200, body: "" });
    await expect(postJSON("/anything")).resolves.toEqual({});
  });
});
