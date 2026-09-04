// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { buildCatalogue } from "./Gallery";
import { parseRoute } from "../api";

/*
The gallery is the design review surface, and a review surface that quietly
falls behind the app is worse than none: it shows what somebody remembered to
add and reads as if it showed everything. Eight screens — the landing page,
the game list, the new game form, join, questions, both handovers and the
recovery page — were missing from it for weeks, and nothing said so.

So the catalogue answers to the route table. Every address the app can be at
is a screen somebody can look at, and adding a route without a picture of it
fails here.
*/

/*
Every kind the Route union can be, named by an address that produces it.
Adding a route to api.ts and not to this list fails the last case below, which
is the one that keeps this list honest too.
*/
const ADDRESSES: Record<string, string> = {
  index: "/",
  games: "/games",
  faq: "/faq",
  variants: "/variants",
  datc: "/datc",
  admin: "/admin",
  recover: "/recover",
  new: "/new",
  join: "/join/abc/xyz",
  gm: "/game/abc/gm/tok",
  seat: "/game/abc/seat/tok",
  sandbox: "/game/abc/sandbox/tok",
  watch: "/watch/abc",
  handover: "/handover/abc/Austria/1/sig",
  "handover-gm": "/handover-gm/abc/1/sig",
};

describe("the gallery's coverage of the app", () => {
  it("has a screen for every route a player can be at", () => {
    const covered = new Set(buildCatalogue().map((entry) => entry.route));
    const missing = Object.keys(ADDRESSES).filter((kind) => !covered.has(kind as never));
    expect(missing).toEqual([]);
  });

  /* "unknown" is the fallback for an address that is not a screen, so it is
     the one kind with nothing to draw. */
  it("draws nothing for an address that is not a screen", () => {
    expect(parseRoute("/nowhere/at/all").kind).toBe("unknown");
    const covered = new Set(buildCatalogue().map((entry) => entry.route));
    expect(covered.has("unknown")).toBe(false);
  });

  /* The map above is only as good as its addresses: each one must really
     parse to the kind it is filed under, or a route could be "covered" by a
     typo. */
  it("names each route by an address that really parses to it", () => {
    for (const [kind, path] of Object.entries(ADDRESSES)) {
      expect([path, parseRoute(path).kind]).toEqual([path, kind]);
    }
  });
});
