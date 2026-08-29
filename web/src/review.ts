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
import type { Unit } from "./board/types";

/** One order as the review lists it. */
export interface ReviewRow {
  province: string;
  power: string;
  /** The sentence, from the server's prose or built from the parts. */
  text: string;
  /** "OK" reads as done; anything else is why it failed. */
  resolution: string;
  failed: boolean;
  /** "bounced", "cut", … — the reason, in the server's own words. */
  reason: string;
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
Move Budapest" — so the board's wording is preferred, and the server's string
is only the fallback for an order shape the board does not know.
*/
function orderText(
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
  const provinces = Array.from(
    new Set(Object.keys(orderParts).concat(Object.keys(orders))),
  ).sort();
  if (provinces.length === 0 && !(previous.nmr || []).length) return null;

  const kind = phaseKind(previous.phase);
  const failed = new Set<string>();
  const rows: ReviewRow[] = provinces.map((province) => {
    const resolution = String(resolutions[province] || "OK");
    const bad = isFailure(resolution);
    if (bad) failed.add(province);
    return {
      province: province,
      power: powers[province] || "",
      text: orderText(province, orderParts[province], orders[province], kind),
      resolution: resolution,
      failed: bad,
      reason: failureReason(resolution),
    };
  });

  return {
    title: phaseLabel(previous.phase),
    kind: kind,
    rows: rows,
    powers: powers,
    orderParts: orderParts,
    failed: failed,
    dislodged: previous.dislodged || {},
    nmr: (previous.nmr || []).filter(Boolean),
    ordered: rows.length,
    succeeded: rows.filter((row) => !row.failed).length,
  };
}

/** "Russia: no orders received — units held." */
export function nmrLine(power: string): string {
  return power + ": no orders — units hold.";
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
