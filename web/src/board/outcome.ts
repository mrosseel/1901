/*
The colour language of a resolved phase, and the geometry that keeps two
support curves apart.

Backstabbr's convention, and the reason a resolved turn there reads without a
legend: the OUTCOME is the loud channel. A successful order is drawn in ink, a
failed one in red, a retreat in orange. The power is still there — the unit
marker carries it, and every order graphic keeps a thin inner stroke in the
power's colour — but it is the quiet channel, because "whose" is a question you
ask second and "did it work" is the one you ask first.

Ink is a fact about the MAP, not about the page. The board sits on the map's
own art, so a dark map (midnight) wants light ink and every other style wants
dark ink. That is the whole of the theme awareness, and it is one lookup.

Everything here is arithmetic and lookup, so the drawing rules can be tested
without a map.
*/

import type { PhaseKind } from "./phases";

export type Outcome = "success" | "failed" | "retreat" | "illegal";

/** Which end of the scale the map's art sits at. */
export type Ink = "dark" | "light";

export interface OutcomePaint {
  /** The dominant stroke: what the order is drawn in. */
  line: string;
  /** The contrast outline under it, so the line survives any map colour. */
  halo: string;
}

const DARK_INK = "#10131a";
const LIGHT_INK = "#f2efe6";
const FAILED_RED = "#d8382a";
const RETREAT_ORANGE = "#e8820c";
/*
An order the rules never allowed (D-029). It stays in the red family, because
what happened to it is what happens to a failure — the unit held — but it is
the deeper, duller red of the two, and the review says the word "illegal"
beside it. Colour alone was never going to carry that difference: "bounced"
and "was never legal" are two stories, and only one of them is about the
board.
*/
const ILLEGAL_RED = "#a01f4d";

/*
The dark styles are named, not detected: the server publishes four styles and
only one of them is a dark map. A style this list does not know is assumed
light, which is what an undrawn default map is.
*/
const DARK_STYLES = new Set(["midnight"]);

export function inkForStyle(style: string | undefined): Ink {
  return DARK_STYLES.has(String(style || "")) ? "light" : "dark";
}

/*
What one order's graphic means. A retreat phase is orange whether the unit
went somewhere or was taken off, because orange is what "this is the retreat
phase" looks like; a failure beats it, because a failed retreat is a unit that
comes off the board and the table must not miss it.
*/
export function outcomeOf(
  kind: PhaseKind,
  parts: string[],
  failed: boolean,
  illegal = false,
): Outcome {
  if (illegal) return "illegal";
  if (failed) return "failed";
  if (kind === "retreat" && (parts[0] === "Move" || parts[0] === "Disband")) return "retreat";
  return "success";
}

export function outcomePaint(outcome: Outcome, ink: Ink): OutcomePaint {
  const halo = ink === "dark" ? LIGHT_INK : DARK_INK;
  if (outcome === "failed") return { line: FAILED_RED, halo: halo };
  if (outcome === "illegal") return { line: ILLEGAL_RED, halo: halo };
  if (outcome === "retreat") return { line: RETREAT_ORANGE, halo: halo };
  return { line: ink === "dark" ? DARK_INK : LIGHT_INK, halo: halo };
}

// --- support curves -------------------------------------------------------
/*
Two powers supporting the same move draw two curves between nearly the same
pair of points, and without an offset the second one is invisible under the
first — which is exactly the case that decides whether an attack goes in, so it
is the one the table most needs to count.

The fix is Backstabbr's: bow each curve out perpendicular to its own span by a
fraction of that span, and alternate the sign so the supports of one move fan
out symmetrically around the straight line rather than drifting to one side.
*/

/** The bow of a single support, as a fraction of its own span. */
export const SUPPORT_BOW = 0.05;

/** ±1, ∓1, ±2, ∓2 … — the fan the ranks of one supported move are drawn on. */
export function bowStep(index: number): number {
  if (!Number.isFinite(index) || index < 0) return 1;
  const rank = Math.floor(index / 2) + 1;
  return index % 2 === 0 ? rank : -rank;
}

/** How far one support curve bows, as a signed fraction of its span. */
export function supportBow(index: number): number {
  return SUPPORT_BOW * bowStep(index);
}

/*
The province a support or convoy is aimed at, which is what decides whether
two of them would draw on top of each other. A support-hold is written both as
["Support", src] and as ["Support", src, src]; both mean the same target, so
both must land in the same group.
*/
export function supportTarget(parts: string[]): string | null {
  const type = parts[0];
  if (type !== "Support" && type !== "Convoy") return null;
  const src = parts[1];
  if (!src) return null;
  return src + ">" + (parts[2] || src);
}

/*
province → its rank among the supports and convoys of the same move. Ranks are
handed out in province order, so every device draws the same fan and a redraw
never reshuffles it.
*/
export function supportRanks(orderParts: Record<string, string[]>): Record<string, number> {
  const groups: Record<string, string[]> = {};
  Object.keys(orderParts || {})
    .sort()
    .forEach((province) => {
      const target = supportTarget(orderParts[province] || []);
      if (!target) return;
      if (!groups[target]) groups[target] = [];
      groups[target].push(province);
    });

  const out: Record<string, number> = {};
  Object.keys(groups).forEach((target) => {
    groups[target].forEach((province, index) => {
      out[province] = index;
    });
  });
  return out;
}
