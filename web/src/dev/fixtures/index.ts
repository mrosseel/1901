/*
The captured states, loaded and checked.

The JSON files beside this one came off a real server (see README.md). They are
imported through import.meta.glob, so they belong to the module graph of the
dev gallery alone: nothing in the production entry reaches them, and the build
never sees them.

Every reader here runs the fixture through a structural guard before handing it
over. A file that has drifted from the server's shape throws where it is read,
with its own name in the message, instead of rendering a page full of blanks.
*/

import type { GameSummary, GmState, SandboxState, SeatState, WatchState } from "../../api";
import type { OptionTree } from "../../board/types";
import type { DatcReport } from "../../pages/DatcPage";
import {
  isDatcReport,
  isGmState,
  isOptionBook,
  isSandboxState,
  isSeatState,
  isWatchState,
} from "../guards";

const files = import.meta.glob("./*.json", { eager: true, import: "default" }) as Record<
  string,
  unknown
>;

/** Every fixture, by its bare name: "seat-retreat", "gm-prestart", … */
export const names: string[] = Object.keys(files)
  .map((path) => path.replace(/^\.\//, "").replace(/\.json$/, ""))
  .sort();

export function raw(name: string): unknown {
  const found = files["./" + name + ".json"];
  if (found === undefined) throw new Error("no fixture named " + name);
  return found;
}

function checked<T>(name: string, guard: (value: unknown) => value is T): T {
  const value = raw(name);
  if (!guard(value)) throw new Error("fixture " + name + " no longer matches its type");
  return value;
}

/*
The game the state came from. Every capture carries it, but only the GM and
spectator answers declare it in their type — a seat page is told its game by
its own address, not by its state. The gallery has no address to read, so it
takes the id off the fixture.
*/
export function gameIdOf(state: unknown): string {
  const holder = (state || {}) as Record<string, unknown>;
  return typeof holder.gameId === "string" ? holder.gameId : "fixture";
}

export const seat = (name: string): SeatState => checked(name, isSeatState);
export const gm = (name: string): GmState => checked(name, isGmState);
export const sandbox = (name: string): SandboxState => checked(name, isSandboxState);
export const watch = (name: string): WatchState => checked(name, isWatchState);
export const options = (name: string): Record<string, OptionTree> =>
  checked(name, isOptionBook);
export const datc = (name: string): DatcReport => checked(name, isDatcReport);

/*
The game list, derived from the spectator captures rather than captured on its
own.

There is no third capture to make: a row of that list is what a bare game id is
already allowed to say about itself, and both of those fields are on the
spectator answer. Deriving it also means the list and the boards behind it can
never drift apart, which a hand-written fixture would do the first time either
changed.
*/
export function gameList(...states: WatchState[]): GameSummary[] {
  return states.map((state, index) => ({
    gameId: state.gameId,
    name: state.name,
    variant: state.variant,
    started: Boolean(state.started),
    phase: state.phase,
    joinedCount: state.joinedCount ?? state.totalSeats ?? 0,
    totalSeats: state.totalSeats ?? 0,
    turns: state.phaseCount ?? 0,
    deadlineAt: state.deadlineAt ?? null,
    createdAt: state.now || new Date(0).toISOString(),
    // One of them is this browser's own, so the list draws both the row a
    // stranger sees and the row with the way back into the controls.
    referee: index === 0,
  }));
}
