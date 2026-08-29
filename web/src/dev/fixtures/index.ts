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

import type { GmState, SeatState, WatchState } from "../../api";
import type { OptionTree } from "../../board/types";
import { isGmState, isOptionBook, isSeatState, isWatchState } from "../guards";

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
export const watch = (name: string): WatchState => checked(name, isWatchState);
export const options = (name: string): Record<string, OptionTree> =>
  checked(name, isOptionBook);
