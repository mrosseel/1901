/*
The variant catalogue, as the gallery reads it.

The server answers /api/v1/variants with godip's own metadata, and godip is
not tidy: a field can be missing, a count can be zero, a description can be
empty. So
nothing here trusts the shape. Every card line is built by a pure function and
comes back as "" when there is nothing true to say, and the page simply leaves
out the empty ones.

Only classical is verified (ADR-014): it is the one card that carries a tick.
Every other variant draws its map from godip and plays, and says nothing about
itself either way.
*/

export interface Variant {
  key: string;
  name: string;
  powers: string[];
  powerCount: number;
  soloSCCount: number;
  totalSCCount: number;
  startYear: number;
  description: string;
  rules: string;
  createdBy: string;
  supported: boolean;
  mapUrl: string;
}

/** The one variant whose placement is verified, and the preselected card. */
export const DEFAULT_VARIANT = "classical";

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function count(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** One raw entry from the server, made safe to read. */
export function normalizeVariant(raw: Partial<Variant> | undefined): Variant {
  const source = raw || {};
  const key = text(source.key);
  const powers = Array.isArray(source.powers) ? source.powers.map(text).filter(Boolean) : [];
  return {
    key: key,
    name: text(source.name) || key,
    powers: powers,
    powerCount: count(source.powerCount) || powers.length,
    soloSCCount: count(source.soloSCCount),
    totalSCCount: count(source.totalSCCount),
    startYear: count(source.startYear),
    description: text(source.description),
    rules: text(source.rules),
    createdBy: text(source.createdBy),
    supported: source.supported === true,
    mapUrl: text(source.mapUrl) || "/variants/" + encodeURIComponent(key) + "/map.svg",
  };
}

/*
Classical first, because it is the one that is verified and the one most
tables want; the rest of the supported ones next; then everything else by
name. A gallery this long needs its safe choice at the top.
*/
export function sortVariants(list: Variant[]): Variant[] {
  return list.slice().sort((a, b) => {
    if (a.key !== b.key) {
      if (a.key === DEFAULT_VARIANT) return -1;
      if (b.key === DEFAULT_VARIANT) return 1;
    }
    if (a.supported !== b.supported) return a.supported ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

export function readVariants(payload: unknown): Variant[] {
  const raw = Array.isArray(payload)
    ? payload
    : Array.isArray((payload as { variants?: unknown })?.variants)
      ? ((payload as { variants: unknown[] }).variants as Array<Partial<Variant>>)
      : [];
  return sortVariants((raw as Array<Partial<Variant>>).map(normalizeVariant).filter((v) => v.key));
}

/** The key to start on: classical when it is there, otherwise the first card. */
export function preferredVariant(list: Variant[]): string {
  if (list.some((v) => v.key === DEFAULT_VARIANT)) return DEFAULT_VARIANT;
  return list.length ? list[0].key : DEFAULT_VARIANT;
}

export function findVariant(list: Variant[], key: string): Variant | null {
  return list.find((v) => v.key === key) || null;
}

/*
A map asked for in the address, as the showcase asks for it: /new?variant=hundred.

The address is read before the catalogue arrives, so this only says what was
asked. Whether the server has such a map is startingVariant's question.
*/
export function requestedVariant(search: string): string {
  try {
    return new URLSearchParams(search).get("variant")?.trim() || "";
  } catch {
    // A malformed query string is not a variant, and not an error either.
    return "";
  }
}

/** The card the create form opens on: the one asked for, when it exists. */
export function startingVariant(list: Variant[], asked: string): string {
  if (asked && list.some((v) => v.key === asked)) return asked;
  return preferredVariant(list);
}

// --- filtering by table size ----------------------------------------------
/*
Twenty-six cards, and the first question anyone at a real table asks is "how
many of us are there". At a table that has an exact answer — five people are
sitting down, not five to seven — so each band is one power count. Everything
from eight up shares a band, because past a certain size the difference between
nine and thirty-four stops being a table you can seat.

The bands are fixed rather than computed from the data, because a filter whose
choices move when a variant is added is a filter nobody can learn.
*/

export interface PowerBand {
  id: string;
  /** What the option says, before its count. */
  label: string;
  min: number;
  /** 0 means no ceiling. */
  max: number;
}

export const POWER_BANDS: PowerBand[] = [
  { id: "all", label: "All", min: 0, max: 0 },
  { id: "2", label: "2 players", min: 2, max: 2 },
  { id: "3", label: "3 players", min: 3, max: 3 },
  { id: "4", label: "4 players", min: 4, max: 4 },
  { id: "5", label: "5 players", min: 5, max: 5 },
  { id: "6", label: "6 players", min: 6, max: 6 },
  { id: "7", label: "7 players", min: 7, max: 7 },
  { id: "8+", label: "8+ players", min: 8, max: 0 },
];

export function inBand(powerCount: number, band: string): boolean {
  if (band === "all") return true;
  const found = POWER_BANDS.find((one) => one.id === band);
  if (!found) return true;
  if (powerCount < found.min) return false;
  return found.max === 0 || powerCount <= found.max;
}

/** How many cards each band would show, so an option can say so or be disabled. */
export function bandCounts(list: Variant[]): Record<string, number> {
  const out: Record<string, number> = {};
  POWER_BANDS.forEach((band) => {
    out[band.id] = list.filter((one) => inBand(one.powerCount, band.id)).length;
  });
  return out;
}

/*
The picked card is never filtered away.

A filter that hid the variant the game is about to be created on would either
lie about the choice or silently change it, and both are worse than one card
that does not match the filter. When it does not match it goes first, where a
card that is there for a different reason than the rest can be marked as one;
buried in catalogue order it only looks like the filter is broken.
*/
export function filterByBand(list: Variant[], band: string, keep: string): Variant[] {
  const matching = list.filter((one) => inBand(one.powerCount, band));
  const picked = list.find((one) => one.key === keep);
  if (!picked || matching.includes(picked)) return matching;
  return [picked, ...matching];
}

/** True for the picked card the filter does not match: it is shown as an exception. */
export function offBand(list: Variant[], band: string, keep: string): boolean {
  const picked = list.find((one) => one.key === keep);
  return !!picked && !inBand(picked.powerCount, band);
}

// --- the lines on a card --------------------------------------------------

export interface VariantCard {
  key: string;
  name: string;
  /** True for a variant whose board art is verified: it gets a tick. */
  supported: boolean;
  /** "7 powers", or "" when the server did not say. */
  powersLine: string;
  /** "Austria, England, …", or "" when the server did not say. */
  powerNames: string;
  /** "Solo at 18 of 34 supply centres.", or "". */
  soloLine: string;
  /** "Starts in 1901.", or "". */
  startLine: string;
  description: string;
  /** The description cut to one line, for the closed card. */
  blurb: string;
  rules: string;
  /** "By Allan B. Calhamer", or "". */
  credit: string;
  mapUrl: string;
}

/*
The one line a card shows before it is opened. godip's descriptions run from
a phrase to a paragraph, and some open with a shouted beta warning, so the
line is cut at a word boundary rather than mid-word.
*/
export function blurb(text: string, max = 90): string {
  const flat = String(text || "").replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return (space > max * 0.5 ? cut.slice(0, space) : cut).replace(/[.,;:]$/, "") + "…";
}

export function variantCard(variant: Variant): VariantCard {
  const powers = variant.powerCount;
  return {
    key: variant.key,
    name: variant.name,
    supported: variant.supported,
    powersLine: powers ? powers + (powers === 1 ? " power" : " powers") : "",
    powerNames: variant.powers.join(", "),
    soloLine:
      variant.soloSCCount && variant.totalSCCount
        ? "Solo at " + variant.soloSCCount + " of " + variant.totalSCCount + " supply centres."
        : "",
    startLine: variant.startYear ? "Starts in " + variant.startYear + "." : "",
    description: variant.description,
    blurb: blurb(variant.description),
    rules: variant.rules,
    credit: variant.createdBy ? "By " + variant.createdBy : "",
    mapUrl: variant.mapUrl,
  };
}

/*
How many powers the invite link hands out. When the game master plays, one is
held back — and the count is the variant's, not seven: the hundred has three.
*/
export function claimLine(powerCount: number, gmPlays: boolean): string {
  if (!powerCount) return "";
  if (!gmPlays) return "Players claim all " + powerCount + " powers.";
  return (
    "Players claim " +
    (powerCount - 1) +
    " of the " +
    powerCount +
    " powers. One is held for the game master."
  );
}

/*
The Classical board, at the address every other screen asks for it at.

The landing page (ADR-043) is the only screen with no game and no variant
behind it, so it names the one map by hand. Parchment is the style the
classical art was drawn in, and asking for it by name keeps the page's
picture steady when the device's own style preference changes.
*/
export function classicalMapUrl(): string {
  return "/variants/classical/map.svg?style=parchment";
}
