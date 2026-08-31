/*
The seam: one wrapper around window.fetch.

Every byte these pages read from the server goes through fetch — getJSON and
postJSON in api.ts, and the map SVG in board/board.ts. So a single wrapper
installed before a page mounts feeds the whole app from a fixture, and not one
line of the pages, the clients or the board island has to know about it. That
is the point: the gallery renders the very components production renders, so
what it shows is what a player would see.

Two things deliberately still reach the network:

  the map      Every map.svg request is rewritten to the token-free
               /variants/{key}/map.svg and passed through, query string and
               all. The art is real, and the style picker keeps working.
  /styles      The style catalogue, so the picker lists what this server can
               actually draw.

Writes — an order, a lock, a forced adjudication — are answered but not
simulated: the fixture comes straight back. The gallery is for looking at
states, not for playing, and a half-simulated server would be a lie of a
different kind. The README says so too.
*/

import type { GameSummary, GmState, PublicState, SeatState, WatchState } from "../api";
import type { OptionTree } from "../board/types";
import { gameIdOf } from "./fixtures";

export interface Scenario {
  /** Which variant's map the art comes from. */
  variantKey: string;
  seat?: SeatState;
  gm?: GmState;
  /** The live phase of the spectator feed. */
  watch?: WatchState;
  /** Resolved phases, by index, for the spectator page's prev and next. */
  phases?: Record<number, WatchState>;
  /** Province → the option tree the server answered with. */
  options?: Record<string, OptionTree>;
  /** The rows the game list shows. Only the list screen needs them. */
  games?: GameSummary[];
}

const SEAT = /^\/game\/[^/]+\/seat\/[^/]+\/(state|options|order|lock|unlock)$/;
const GM = /^\/game\/[^/]+\/gm\/[^/]+\/(state|settings|start|adjudicate|extend)$/;
const WATCH = /^\/game\/[^/]+\/watch(?:\/(\d+))?$/;
const PUBLIC = /^\/game\/[^/]+\/public$/;
const MAP = /\/map\.svg$/;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status: status,
    headers: { "Content-Type": "application/json" },
  });
}

function missing(what: string): Response {
  return json({ error: "no fixture for " + what }, 404);
}

/*
The public summary, built from whichever fixture the screen is showing.

Every page polls this endpoint for liveness, and the seat page re-reads its
whole state only when the summary changes. Deriving it from the same fixture
keeps it constant, so a gallery screen sits still instead of flickering
through a reload every three seconds.
*/
function summary(scene: Scenario): PublicState | null {
  const source = scene.seat || scene.gm || scene.watch;
  if (!source) return null;
  const seat = scene.seat;
  const gm = scene.gm;
  const watch = scene.watch;
  return {
    gameId: gameIdOf(gm || watch || seat),
    phase: source.phase,
    started: Boolean(source.started),
    joinedCount: gm?.joinedCount ?? watch?.totalSeats ?? seat?.totalSeats ?? 0,
    totalSeats: gm?.totalSeats ?? watch?.totalSeats ?? seat?.totalSeats ?? 0,
    locked: seat?.locked || watch?.locked || {},
    settings: seat?.settings || gm?.settings || { deadlineMinutes: 0, gmPlays: false },
    settingsVersion: seat?.settingsVersion ?? gm?.settingsVersion ?? 1,
    deadlineAt: source.deadlineAt ?? null,
    now: source.now,
    variant: source.variant,
    provinceNames: source.provinceNames,
    placements: source.placements,
    labels: source.labels,
  };
}

function answer(scene: Scenario, url: URL, method: string): Response | null {
  const path = url.pathname;
  const seat = SEAT.exec(path);
  if (seat) {
    if (!scene.seat) return missing("a seat on this screen");
    if (seat[1] === "options") {
      const province = url.searchParams.get("province") || "";
      return json((scene.options || {})[province] || {});
    }
    // A write is answered with the state as captured: nothing is simulated.
    return json(scene.seat);
  }

  const gm = GM.exec(path);
  if (gm) {
    if (!scene.gm) return missing("a game master on this screen");
    return json(gm[1] === "state" ? scene.gm : {});
  }

  const watch = WATCH.exec(path);
  if (watch) {
    if (watch[1] !== undefined) {
      const one = (scene.phases || {})[Number(watch[1])];
      return one ? json(one) : missing("phase " + watch[1]);
    }
    return scene.watch ? json(scene.watch) : missing("a live phase on this screen");
  }

  if (path === "/games/list") {
    return json(scene.games || []);
  }

  if (PUBLIC.test(path)) {
    const derived = summary(scene);
    return derived ? json(derived) : missing("a public summary");
  }

  /*
  Anything else is the real server's to answer — but only if it is a read.
  No button in the gallery may reach a write on a server that has games on
  it, so an unrecognised write is swallowed here rather than forwarded.
  */
  if (method !== "GET") return json({}, 200);
  return null;
}

/*
Where a map request really goes.

A fixture's map lives behind a seat or GM token that died with the game it was
captured from, so the token-free variant map stands in for it. The query is
carried over untouched, which is what keeps the style picker honest.
*/
function realMap(scene: Scenario, url: URL): string {
  return "/variants/" + encodeURIComponent(scene.variantKey) + "/map.svg" + url.search;
}

/** Installs the wrapper. The returned function puts the real fetch back. */
export function installStub(scene: Scenario): () => void {
  const real = window.fetch.bind(window);

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const href =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const url = new URL(href, window.location.origin);
    const method = (init?.method || (input instanceof Request ? input.method : "GET")).toUpperCase();

    if (url.origin !== window.location.origin) return real(input, init);

    if (MAP.test(url.pathname)) return real(realMap(scene, url), init);

    const canned = answer(scene, url, method);
    if (canned) return canned;
    return real(input, init);
  };

  return () => {
    window.fetch = real;
  };
}
