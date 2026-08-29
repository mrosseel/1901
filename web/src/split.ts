/*
Where the border between the map and the order panel sits.

The seat screen is one map and one panel. Which of the two needs the room
changes by the minute: you read the board, then you work through a list of
retreats, then you read the board again. A fixed border serves whichever half
the designer guessed at, so the border moves instead, and the device remembers
where its owner put it.

Everything here is arithmetic and storage. No element is touched, so the
clamps and the keys can be tested without a browser.
*/

/*
Three layouts, matching the media queries in app.css. Keep them in step:
  phone      (max-width: 780px), (max-height: 500px)
  landscape  (max-height: 500px)
Anything else is the two-column desktop.
*/
export type SplitMode = "portrait" | "landscape" | "desktop";

export const NARROW_PX = 780;
export const SHORT_PX = 500;

export function modeFor(width: number, height: number): SplitMode {
  if (height <= SHORT_PX) return "landscape";
  if (width <= NARROW_PX) return "portrait";
  return "desktop";
}

/*
What the stored number means, per mode.

On a phone the map's share of the height is the honest unit: the screen is
the whole layout, and a share survives the address bar growing and shrinking.
On a desktop the panel's width in pixels is the honest one: text wants a
column of a certain width, not a fraction of whatever monitor it landed on.
*/
export const SPLIT_DEFAULTS: Record<SplitMode, number> = {
  portrait: 0.58,
  landscape: 0.75,
  desktop: 340,
};

/** The share of the height the map may take on a phone. */
export const MIN_MAP_SHARE = 0.25;
export const MAX_MAP_SHARE = 0.85;

/** What the panel needs to be a panel, and what it may not starve the map to. */
export const MIN_SIDE_PX = 260;
export const MAX_SIDE_PX = 720;
/** The map keeps at least this much of a desktop window. */
export const MIN_MAP_PX = 320;

/*
A wanted split, held to what the mode allows.

`extent` is the container's size along the axis being dragged: its height on a
phone, its width on a desktop. A container too small for both minimums gives
the map what is left rather than overlapping the two.
*/
export function clampSplit(mode: SplitMode, value: number, extent: number): number {
  if (!Number.isFinite(value)) return SPLIT_DEFAULTS[mode];
  if (mode === "desktop") {
    const high = Math.max(MIN_SIDE_PX, Math.min(MAX_SIDE_PX, extent - MIN_MAP_PX));
    return Math.min(high, Math.max(Math.min(MIN_SIDE_PX, high), value));
  }
  return Math.min(MAX_MAP_SHARE, Math.max(MIN_MAP_SHARE, value));
}

/** The default for a mode, already clamped to this container. */
export function defaultSplit(mode: SplitMode, extent: number): number {
  return clampSplit(mode, SPLIT_DEFAULTS[mode], extent);
}

/*
The split after a drag of `delta` pixels from where it started.

Down and right both make the number grow on a phone — the map is above the
handle, so dragging down gives the map more. On a desktop the panel is to the
right of the handle, so dragging right makes the panel narrower.
*/
export function splitAfterDrag(
  mode: SplitMode,
  start: number,
  delta: number,
  extent: number,
): number {
  if (mode === "desktop") return clampSplit(mode, start - delta, extent);
  return clampSplit(mode, start + (extent ? delta / extent : 0), extent);
}

/** The CSS length the grid track takes for this split. */
export function splitTrack(mode: SplitMode, value: number): string {
  return mode === "desktop" ? Math.round(value) + "px" : (value * 100).toFixed(3) + "%";
}

/*
One key per layout mode, because a phone held the other way is a different
screen with a different answer, and a laptop that also runs the page should
not have a phone's share written over its column width.
*/
export function splitKey(mode: SplitMode): string {
  return "1901.split." + mode;
}

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function storage(given?: Store): Store | null {
  if (given) return given;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** The remembered split, or null where there is none to be had. */
export function readSplit(mode: SplitMode, given?: Store): number | null {
  const store = storage(given);
  if (!store) return null;
  try {
    const raw = store.getItem(splitKey(mode));
    if (raw === null) return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

export function writeSplit(mode: SplitMode, value: number, given?: Store): void {
  const store = storage(given);
  if (!store) return;
  try {
    store.setItem(splitKey(mode), String(value));
  } catch {
    // The split still works for this page; it just will not be remembered.
  }
}

export function forgetSplit(mode: SplitMode, given?: Store): void {
  const store = storage(given);
  if (!store) return;
  try {
    store.removeItem(splitKey(mode));
  } catch {
    // Nothing to undo.
  }
}

/** The remembered split for this container, or the default. */
export function initialSplit(mode: SplitMode, extent: number, given?: Store): number {
  const saved = readSplit(mode, given);
  return saved === null ? defaultSplit(mode, extent) : clampSplit(mode, saved, extent);
}
