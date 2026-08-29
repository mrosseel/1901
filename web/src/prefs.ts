/*
Preferences that belong to the DEVICE, not to the game.

Same rule as the map style in style.ts: nothing here goes to the server,
because nothing here changes what anybody else sees. localStorage can throw
outright in a locked-down browser, so every access is guarded and a preference
that cannot be read is simply the default.
*/

import { useState } from "react";

export const HIDE_ORDERS_KEY = "1901.hideOrders";

/*
Hiding your own pending arrows.

vDiplomacy's observation: drawing the pending orders on the map is the right
default — you check a picture instead of a list — but a board covered in your
own arrows is hard to read while you are still deciding what to do. So the
arrows come off on request. Only your own: this switch never touches the
review of a resolved phase, which is the picture everyone is reading together.
*/
export function readHideOrders(): boolean {
  return read(HIDE_ORDERS_KEY);
}

export function writeHideOrders(on: boolean): void {
  write(HIDE_ORDERS_KEY, on);
}

export const BRIEF_MOVES_KEY = "1901.briefMoves";
export const BRIEF_LABELS_KEY = "1901.briefLabels";

/*
Orders written in notation instead of in sentences.

"Army Paris moves to Burgundy." is the right line for a first game and the
wrong one for a fiftieth: eighteen sentences are a wall, eighteen orders in
notation are a column. Which one a player wants is a fact about the player, so
it is asked here and defaults to the sentence — the notation is a shorthand,
and a shorthand nobody has been taught is a cipher.
*/
export function readBriefMoves(): boolean {
  return read(BRIEF_MOVES_KEY);
}

export function writeBriefMoves(on: boolean): void {
  write(BRIEF_MOVES_KEY, on);
}

/*
Province codes on the map instead of names.

A map at fit-all zoom cannot fit "Mid-Atlantic Ocean" into the province it
names, so the art either overflows it or shrinks the name past reading. The
three-letter code fits every time, and it is the same code the notation above
writes, so a player who has switched both is reading one language. Off by
default, for the same reason: the full name is what a first game needs.
*/
export function readBriefLabels(): boolean {
  return read(BRIEF_LABELS_KEY);
}

export function writeBriefLabels(on: boolean): void {
  write(BRIEF_LABELS_KEY, on);
}

function read(key: string): boolean {
  try {
    return window.localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

function write(key: string, on: boolean): void {
  try {
    if (on) window.localStorage.setItem(key, "1");
    else window.localStorage.removeItem(key);
  } catch {
    // The switch still works for this page; it just will not be remembered.
  }
}

/*
Each preference, as the hook a page uses it through.

Every one of the three is the same three lines — read once on mount, write on
change, keep it in state so the page redraws — and one of those lines is the
storage guard. They live here beside the storage rather than beside the
switches, because the switches for one preference are now in more than one
place and a second copy of the guard is a second thing to get wrong.
*/
export function useHideOrders(): [boolean, (hidden: boolean) => void] {
  return usePref(readHideOrders, writeHideOrders);
}

export function useBriefLabels(): [boolean, (brief: boolean) => void] {
  return usePref(readBriefLabels, writeBriefLabels);
}

export function useBriefMoves(): [boolean, (brief: boolean) => void] {
  return usePref(readBriefMoves, writeBriefMoves);
}

function usePref(
  read: () => boolean,
  save: (on: boolean) => void,
): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState<boolean>(read);
  return [
    on,
    (next: boolean) => {
      save(next);
      setOn(next);
    },
  ];
}
