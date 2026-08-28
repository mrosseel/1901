import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, claimSeat, createGame, parseRoute, postJSON, publicUrl } from "./api";

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
    expect(parseRoute("/new")).toEqual({ kind: "new" });
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

  it("treats anything else as unknown", () => {
    expect(parseRoute("/").kind).toBe("unknown");
    expect(parseRoute("/game/7/seat/tok/state").kind).toBe("unknown");
    expect(parseRoute("/g/test-ui/").kind).toBe("unknown");
  });

  it("addresses the public endpoint without a token", () => {
    expect(publicUrl("7")).toBe("http://localhost:3000/game/7/public");
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

  it("claims a power under the game, not under the join page", async () => {
    const calls = stubFetch({ ok: true, status: 200, body: '{"seatUrl":"/game/7/seat/s/"}' });
    const answer = await claimSeat("7", "invite");
    expect(calls[0].url).toBe("http://localhost:3000/game/7/join/invite");
    expect(answer.seatUrl).toBe("/game/7/seat/s/");
  });

  it("shows the server's own sentence when a power cannot be had", async () => {
    stubFetch({
      ok: false,
      status: 409,
      body: '{"error":"every power is taken — ask the GM for a seat"}',
    });
    const failure = await claimSeat("7", "invite").catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).status).toBe(409);
    expect((failure as ApiError).message).toBe("every power is taken — ask the GM for a seat");
  });

  it("accepts an empty body from a POST that answers with nothing", async () => {
    stubFetch({ ok: true, status: 200, body: "" });
    await expect(postJSON("/anything")).resolves.toEqual({});
  });
});
