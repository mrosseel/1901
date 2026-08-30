// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Board } from "./Board";
import { emptyPlan } from "../board/phases";
import type { BoardApi, BoardState } from "../board/types";

/*
Switching the map style remounts the island against a new URL, which is a
brand new, empty board. Everything the old one was showing has to be handed to
it, and the effects that watch each piece cannot do it: they fire on their own
value changing, and a style change changes none of them. The units used to
vanish until something else on the board moved.
*/

// React needs to be told this is a test environment, or every act() warns.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

if (!(globalThis as { CSS?: unknown }).CSS) {
  (globalThis as { CSS?: unknown }).CSS = {
    escape: (value: string) => value.replace(/([^\w-])/g, "\\$1"),
  };
}

const MAP = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <g id="provinces"><path id="vie" d="M 10,10 h 20 v 20 h -20 z"/></g>
  <g id="province-centers"><path id="vieCenter" d="m 20,20 h 2 v 2 h -2 z"/></g>
</svg>`;

const STATE: BoardState = {
  phase: { season: "Spring", year: 1901, type: "Movement" },
  units: { vie: { type: "Army", nation: "Austria" } },
  orders: {},
  orderParts: {},
};

/* The page holds one plan object across a style change, so the effect that
   watches it does not fire. That is the whole point: something has to hand
   the state over, and it cannot be that effect. */
const PLAN = emptyPlan("Austria");

function apiFor(style: string): BoardApi {
  return {
    mapUrl: "/map.svg?style=" + style,
    options: async () => ({}),
    order: async () => ({}),
  };
}

let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe("switching the map style", () => {
  it("keeps the units on the board the new map draws", async () => {
    vi.stubGlobal(
      "fetch",
      async () => ({ ok: true, status: 200, text: async () => MAP }) as unknown as Response,
    );
    const host = document.createElement("div");
    document.body.appendChild(host);

    const draw = (style: string) => (
      <Board
        api={apiFor(style)}
        state={STATE}
        plan={PLAN}
        review={null}
        onState={() => {}}
        onStatus={() => {}}
        onSelect={() => {}}
      />
    );

    await act(async () => {
      root = createRoot(host);
      root!.render(draw("parchment"));
    });
    expect(document.querySelectorAll("#unit-overlay circle").length).toBeGreaterThan(0);

    await act(async () => {
      root!.render(draw("ink"));
    });
    expect(document.querySelectorAll("#unit-overlay circle").length).toBeGreaterThan(0);
  });
});
