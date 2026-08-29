/*
Orders written the way players write them on paper.

"Army Paris moves to Burgundy." is the right sentence for somebody's first
game, and the wrong one for their fiftieth: a list of eighteen of them is a
wall of words where the same eighteen orders in notation are a column you read
down. Which of the two a screen shows is a preference of the person reading,
not a fact about the game, so it lives on the device (prefs.ts) and defaults to
the sentence.

The notation is the one Diplomacy has always used:

    A Par → Bur        a move
    A Gal H            a hold
    F Tri S A Ven      a support to hold
    F Tri S A Ven → Tri   a support to move
    F Nth C A Lon → Bel   a convoy
    A Tri ✕            a disband
    Build A Rom        a build

Everything is built from the raw parts and the units standing on the board —
never from the server's prose, which is a sentence and cannot be unwritten into
this. The province code is the variant's own key, which is what the abbreviated
map labels show too, so a player reading one is reading the other.
*/

import { baseProvince } from "./board/provinces";
import type { PhaseKind } from "./board/phases";
import type { Unit } from "./board/types";

/** Looks up whatever unit the caller wants a letter for. */
export type UnitLookup = (province: string) => Unit | undefined;

/*
"bur" → "Bur", "spa/sc" → "Spa/sc".

The key is the abbreviation; nothing is invented and nothing is looked up. A
variant whose keys are not three letters gets its own keys, which is still the
shortest true name the map and this list agree on.
*/
export function provinceCode(province: string): string {
  const base = baseProvince(province);
  if (!base) return "";
  const head = base.charAt(0).toUpperCase() + base.slice(1);
  return base === province ? head : head + province.slice(base.length);
}

/** The same code in the case a map label wants: "BUR", "SPA/SC". */
export function mapCode(province: string): string {
  return String(province || "").toUpperCase();
}

/** "A", "F", or "" for a unit type nobody has told us about. */
export function unitInitial(unit: Unit | undefined): string {
  const type = String(unit?.type || "").trim();
  return type ? type.charAt(0).toUpperCase() : "";
}

/** "A Par", or just "Par" where no unit is standing there to name. */
function piece(province: string, unit: Unit | undefined): string {
  const initial = unitInitial(unit);
  return initial ? initial + " " + provinceCode(province) : provinceCode(province);
}

/*
One order in notation.

The phase decides the words the same way describeInPhase does: ["Move","alb"]
is an attack in a movement phase and a retreat in a retreat phase, and the two
are not the same claim. A retreat keeps the dashed arrow the map draws it with
so the two channels agree.
*/
export function abbreviateOrder(
  province: string,
  parts: string[],
  kind: PhaseKind,
  unitAt: UnitLookup,
): string {
  const order = parts || [];
  const type = order[0];
  if (!type) return provinceCode(province);

  if (kind === "adjustment") {
    if (type === "Build") {
      const initial = String(order[1] || "").charAt(0).toUpperCase();
      return "Build " + (initial ? initial + " " : "") + provinceCode(province);
    }
    if (type === "Disband") return piece(province, unitAt(province)) + " ✕";
  }

  if (kind === "retreat") {
    const from = piece(province, unitAt(province));
    if (type === "Move" && order[1]) return from + " ⇢ " + provinceCode(order[1]);
    if (type === "Disband") return from + " ✕";
  }

  const from = piece(province, unitAt(province));
  if (type === "Move" && order[1]) return from + " → " + provinceCode(order[1]);
  if (type === "Hold") return from + " H";
  if (type === "Support" || type === "Convoy") {
    const mark = type === "Convoy" ? " C " : " S ";
    const src = order[1] || "";
    const backed = piece(src, unitAt(src));
    // A support with no third part, or one naming its own source, backs a hold.
    if (order.length < 3 || order[2] === src) return from + mark + backed;
    return from + mark + backed + " → " + provinceCode(order[2]);
  }
  if (type === "Disband") return from + " ✕";

  return [from].concat(order.slice(1).map(provinceCode)).join(" ");
}

/*
A whole list at once, in the order the caller already has.

The lookup a caller passes is the one its own screen is right about: the seat
reads the live units, a review of a retreat phase reads the units the phase
threw out, and neither can answer for the other.
*/
export function abbreviateOrders(
  parts: Record<string, string[]>,
  kind: PhaseKind,
  unitAt: UnitLookup,
): Record<string, string> {
  const out: Record<string, string> = {};
  Object.keys(parts || {}).forEach((province) => {
    out[province] = abbreviateOrder(province, parts[province], kind, unitAt);
  });
  return out;
}

/*
The unit types a resolved phase can still be asked about.

A review is handed the phase's orders and its outcomes, and no board: the units
that gave those orders stood on a board that the adjudication has already
replaced. So the only record of what each of them WAS is the first word of the
server's own prose — "Fleet Brest Move Mid-Atlantic" — which is read back here.

It is a partial answer by construction: a province that gave no order that
phase is not in the table, so a support naming it writes "S Ven" rather than
"S A Ven". That is the honest shape of what a review knows, and notation
without unit letters is still notation.
*/
export function proseUnits(orders: Record<string, string> | undefined): Record<string, Unit> {
  const out: Record<string, Unit> = {};
  Object.keys(orders || {}).forEach((province) => {
    const head = String(orders![province] || "").trim().split(/\s+/)[0] || "";
    if (head === "Army" || head === "Fleet") out[province] = { type: head, nation: "" };
  });
  return out;
}

/** The lookup for a board state: whatever stands in the province now. */
export function unitsOf(
  units: Record<string, Unit> | undefined,
  dislodged?: Record<string, Unit>,
): UnitLookup {
  return (province: string) => {
    const table = units || {};
    const out = dislodged || {};
    return (
      out[province] ||
      out[baseProvince(province)] ||
      table[province] ||
      table[baseProvince(province)]
    );
  };
}
