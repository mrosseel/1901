/*
Taking a new fixture off a running game.

The gallery is only as good as the moments it holds, and the interesting ones
turn up while playing. So this puts one function on the window of any dev
build:

    await __1901capture("seat")

Play a real game in `npm run dev` until the screen is the one worth keeping,
open the console on that tab, and call it. It reads the page's own endpoint
with the page's own tokens — taken from location.pathname, exactly as api.ts
does it — pretty-prints the JSON, copies it to the clipboard and returns it.
Paste it into src/dev/fixtures/<name>.json and add a line to the catalogue in
Gallery.tsx.

  __1901capture()             guesses from the address: seat, gm or watch
  __1901capture("options")    the option trees for every province this power
                              could be asked about, which is what the retreat
                              and adjustment screens need beside their state
  __1901capture("watch", 2)   one resolved phase of the spectator feed

Nothing here is imported by the app. It is installed by the gallery module,
which exists only in a dev build.
*/

import { candidates, phaseKind } from "../board/phases";
import type { OptionTree } from "../board/types";
import { getJSON, parseRoute } from "../api";
import { isSeatState } from "./guards";

type Kind = "seat" | "gm" | "watch" | "public" | "options";

function prefix(): string {
  const route = parseRoute(window.location.pathname);
  if (route.kind === "seat") {
    return "/game/" + route.gameId + "/seat/" + route.seatToken + "/";
  }
  if (route.kind === "gm") return "/game/" + route.gameId + "/gm/" + route.gmToken + "/";
  if (route.kind === "watch") return "/game/" + route.gameId + "/";
  throw new Error("open a seat, game master or spectator page first");
}

function guess(): Kind {
  const kind = parseRoute(window.location.pathname).kind;
  if (kind === "seat" || kind === "gm" || kind === "watch") return kind;
  throw new Error("open a seat, game master or spectator page first");
}

/*
The option trees a retreat or adjustment screen depends on. The seat page asks
the server about the same provinces (board/phases.ts), so this asks about
exactly those and keeps the answers that were not empty.
*/
async function captureOptions(base: string): Promise<Record<string, OptionTree>> {
  const state = await getJSON<unknown>(base + "state");
  if (!isSeatState(state)) throw new Error("that is not a seat page");
  const asked = candidates(state, state.you.power, phaseKind(state.phase));
  const book: Record<string, OptionTree> = {};
  for (const province of asked) {
    const tree = await getJSON<OptionTree>(
      base + "options?province=" + encodeURIComponent(province),
    ).catch(() => ({}) as OptionTree);
    if (Object.keys(tree).length) book[province] = tree;
  }
  return book;
}

/* Keys in order, all the way down, so a re-capture shows a real diff. */
function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === "object") {
    const holder = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(holder).sort()) out[key] = sorted(holder[key]);
    return out;
  }
  return value;
}

export async function capture(kind?: Kind, phaseIndex?: number): Promise<unknown> {
  const what = kind || guess();
  const base = prefix();
  let body: unknown;
  if (what === "options") body = await captureOptions(base);
  else if (what === "watch") {
    body = await getJSON<unknown>(
      base + "watch" + (phaseIndex === undefined ? "" : "/" + phaseIndex),
    );
  } else if (what === "public") body = await getJSON<unknown>(base + "public");
  else body = await getJSON<unknown>(base + "state");

  const text = JSON.stringify(sorted(body), null, 1);
  try {
    await navigator.clipboard.writeText(text);
    console.info("[1901] fixture copied to the clipboard — paste it into src/dev/fixtures/");
  } catch {
    console.info("[1901] the clipboard refused; the JSON is below");
    console.log(text);
  }
  return body;
}

/** Puts capture() on the window, under a name nothing else will take. */
export function installCapture(): void {
  (window as unknown as Record<string, unknown>).__1901capture = capture;
}
