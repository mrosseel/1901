/*
The map style this DEVICE draws in.

A style is presentation, not a rule: it changes how the board looks and
nothing about the game. So it belongs to the person looking, not to the game —
one table can have the game master on parchment on a laptop, a player on
midnight on a phone in a dim corner, and the projector on print, all in the
same game. That is why the choice lives in localStorage and never goes to the
server.

An empty preference means "whatever the server serves by default", which is
what a fresh device gets and what a device whose saved style has since been
removed falls back to.
*/

import { getJSON } from "./api";

export const STYLE_KEY = "1901.mapStyle";

/** One entry in the picker, as the server publishes it at /styles. */
export interface MapStyle {
  name: string;
  title: string;
  description: string;
}

/*
localStorage throws rather than returning null in a locked-down browser — a
private window with site data blocked, an iframe with third-party storage off.
A map that will not draw because a preference could not be read would be a
poor trade, so every access is guarded and answers "no preference".
*/
export function readStyle(): string {
  try {
    return window.localStorage.getItem(STYLE_KEY) || "";
  } catch {
    return "";
  }
}

export function writeStyle(name: string): void {
  try {
    if (name) window.localStorage.setItem(STYLE_KEY, name);
    else window.localStorage.removeItem(STYLE_KEY);
  } catch {
    /* The style still applies for this page; it just will not be remembered. */
  }
}

/*
A map URL with the style on it.

The server answers 404 for a style it has not drawn this variant in, rather
than quietly serving the default: a typo in a saved preference would otherwise
look exactly like a style. The board reports that as a map it could not load,
which is true and visible, and the picker is right there to change.
*/
export function styledMapUrl(mapUrl: string, style: string): string {
  if (!style) return mapUrl;
  return mapUrl + (mapUrl.includes("?") ? "&" : "?") + "style=" + encodeURIComponent(style);
}

/** Whatever the server can draw. Read once per page; it cannot change under it. */
let pending: Promise<MapStyle[]> | null = null;

export function fetchStyles(): Promise<MapStyle[]> {
  if (!pending) {
    pending = getJSON<unknown>("/styles")
      .then(readStyles)
      .catch(() => [] as MapStyle[]);
  }
  return pending;
}

/** Makes the server's answer safe to draw: anything malformed is dropped. */
export function readStyles(raw: unknown): MapStyle[] {
  if (!Array.isArray(raw)) return [];
  const out: MapStyle[] = [];
  for (const one of raw) {
    const entry = (one || {}) as Partial<MapStyle>;
    const name = typeof entry.name === "string" ? entry.name.trim() : "";
    if (!name) continue;
    out.push({
      name: name,
      title: typeof entry.title === "string" && entry.title ? entry.title : name,
      description: typeof entry.description === "string" ? entry.description : "",
    });
  }
  return out;
}

/** For tests, which need a clean slate between them. */
export function forgetStyles(): void {
  pending = null;
}
