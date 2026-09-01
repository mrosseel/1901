/*
The review of the phase that just resolved.

Between two rounds every player wants the same thing: what did everyone
actually order, and what worked. The server hands that over as previousPhase —
public the moment the phase resolved — and this turns it into the two things
the screen needs: a drawing plan for the map, and a list of sentences.

Dismissal is per device and nothing else. A player who has read the result
closes the review and goes back to the board; nobody else's screen moves, and no
one waits. That choice lives in this browser's localStorage under the identity
of the phase reviewed, so a refresh does not bring it back but the next
adjudication does.
*/

import type { PreviousPhase } from "./api";
import { describeOrder, phaseLabel, provinceName } from "./board/provinces";
import { describeInPhase, phaseKind, type PhaseKind } from "./board/phases";
import { abbreviateOrder, proseUnits, unitsOf } from "./notation";
import { illegalReason, isIllegal } from "./illegal";
import type { Unit } from "./board/types";

/** One order as the review lists it. */
export interface ReviewRow {
  province: string;
  power: string;
  /** The sentence, from the server's prose or built from the parts. */
  text: string;
  /* The same order in notation, for a device that asked for it. Both are
     built here so the two can never say different things about one order. */
  brief: string;
  /** "OK" reads as done; anything else is why it failed. */
  resolution: string;
  failed: boolean;
  /** "bounced", "cut", … — the reason, in the server's own words. */
  reason: string;
  /* Written but never legal (ADR-029). It is a failure like the others and it is
     listed as one, in its own words: "bounced" is a story about the board and
     "illegal" is a story about the order. */
  illegal: boolean;
}

/** What the map draws, and what the panel lists. */
export interface ReviewPlan {
  /** The phase these orders belonged to, for the heading. */
  title: string;
  kind: PhaseKind;
  rows: ReviewRow[];
  /** province → the power that ordered there, for the order colours. */
  powers: Record<string, string>;
  /** province → the raw parts the map draws. */
  orderParts: Record<string, string[]>;
  /** Provinces whose order did not come off. */
  failed: Set<string>;
  /** Of those, the ones the rules never allowed in the first place. */
  illegal: Set<string>;
  dislodged: Record<string, Unit>;
  /** Powers that gave no orders at all. */
  nmr: string[];
  /** How many orders were given, and how many of them worked. */
  ordered: number;
  succeeded: number;
}

/*
"OK" is the only resolution that means the order happened. Everything else —
"ErrBounce:tri", "ErrSupportBroken:vie" — is a failure, and its tail is the
reason worth showing.
*/
export function isFailure(resolution: string | undefined): boolean {
  const text = String(resolution || "").trim();
  return text !== "" && text.toUpperCase() !== "OK";
}

/*
godip writes a failure as "ErrSomething" or "ErrSomething:prv". The prefix is
code, so it is unpacked into words a player reads: "bounced in Trieste".
*/
export function failureReason(resolution: string | undefined): string {
  const text = String(resolution || "").trim();
  if (!isFailure(text)) return "";
  const [head, where] = text.split(":");
  const bare = head.replace(/^Err/, "");
  const words = bare
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .trim();
  const said = words || "failed";
  return where ? said + " (" + provinceName(where) + ")" : said;
}

/*
The sentence for one order. The server's own prose is godip's — "Army Galicia
Move Budapest", or worse "Fleet Norwegian Sea Convoy Quebec Norway" — so the
board's wording is preferred, and the server's string is only the fallback for
an order shape the board does not know.

Exported because the seat's own order list needs exactly this: one order, one
sentence, written the same way wherever it is read.
*/
export function orderText(
  province: string,
  parts: string[] | undefined,
  prose: string | undefined,
  kind: PhaseKind,
): string {
  if (parts && parts.length) {
    const said =
      kind === "movement" ? describeOrder(province, parts) : describeInPhase(province, parts, kind);
    if (said) return said;
  }
  if (prose && prose.trim()) return prose.trim();
  if (!parts || !parts.length) return provinceName(province) + " held.";
  return provinceName(province) + " " + parts.join(" ") + ".";
}

export function reviewPlan(previous: PreviousPhase | null | undefined): ReviewPlan | null {
  if (!previous) return null;
  const orderParts = previous.orderParts || {};
  const orders = previous.orders || {};
  const powers = previous.powers || {};
  const resolutions = previous.resolutions || {};
  /*
  Grouped by power, and inside a power by province.

  The list used to be sorted by province alone, which interleaved seven
  colours down the sheet. Reading it then meant scanning for your own dot, and
  in an adjustment phase — where the question is what each power built and
  disbanded — it fell apart completely. A power's orders are one thought, so
  they are one run of one colour.

  Powers are ordered by name. It is arbitrary but stable, which is what
  matters: the same power sits in the same place every turn, so a player
  learns where to look instead of searching each time.
  */
  const provinces = Array.from(
    new Set(Object.keys(orderParts).concat(Object.keys(orders))),
  ).sort((a, b) => {
    const left = powers[a] || "";
    const right = powers[b] || "";
    if (left !== right) return left < right ? -1 : 1;
    return a < b ? -1 : a > b ? 1 : 0;
  });
  if (provinces.length === 0 && !(previous.nmr || []).length) return null;

  const kind = phaseKind(previous.phase);
  const failed = new Set<string>();
  const illegal = new Set<string>();
  /* A resolved phase carries no board, so the unit types come out of the
     server's own prose and out of whatever this phase threw out. */
  const unitAt = unitsOf(proseUnits(orders), previous.dislodged || {});
  const rows: ReviewRow[] = provinces.map((province) => {
    const resolution = String(resolutions[province] || "OK");
    const bad = isFailure(resolution);
    const never = isIllegal(resolution);
    if (bad) failed.add(province);
    if (never) illegal.add(province);
    return {
      province: province,
      power: powers[province] || "",
      text: orderText(province, orderParts[province], orders[province], kind),
      brief: abbreviateOrder(province, orderParts[province] || [], kind, unitAt),
      resolution: resolution,
      failed: bad,
      reason: never ? illegalReason(kind) : failureReason(resolution),
      illegal: never,
    };
  });

  return {
    title: phaseLabel(previous.phase),
    kind: kind,
    rows: rows,
    powers: powers,
    orderParts: orderParts,
    failed: failed,
    illegal: illegal,
    dislodged: previous.dislodged || {},
    nmr: (previous.nmr || []).filter(Boolean),
    ordered: rows.length,
    succeeded: rows.filter((row) => !row.failed).length,
  };
}

/** What a phase does when a power submits nothing. */
export function nmrLine(power: string, kind: PhaseKind): string {
  if (kind === "retreat") return power + ": no retreat orders — dislodged units disband.";
  if (kind === "adjustment") return power + ": no adjustment orders — normal adjustment rules apply.";
  return power + ": no orders submitted — units hold.";
}

// --- what this device has already read ------------------------------------

/*
The identity of one adjudication: the game and the phase that was reviewed.
Two games, and two phases of one game, are never the same review.
*/
export function reviewKey(gameId: string, previous: PreviousPhase | null | undefined): string {
  const phase = previous?.phase;
  const stamp = phase
    ? [phase.season, phase.year, phase.type].filter(Boolean).join("-")
    : "none";
  return "1901.review." + gameId + "." + stamp;
}

/*
localStorage can throw outright — a private window, a browser told to keep no
site data — and a review that cannot be remembered is a small loss next to a
page that will not load. So both sides swallow their errors.
*/
export function isDismissed(key: string): boolean {
  try {
    return window.localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

export function dismiss(key: string): void {
  try {
    window.localStorage.setItem(key, "1");
  } catch {
    // Nothing to do: the review simply shows again after a refresh.
  }
}
