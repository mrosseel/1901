/*
Orders that are not legal, and are written anyway (ADR-029).

Face-to-face Diplomacy is played on paper, and paper takes any order you can
spell. "A Par → Mos" is not a move Paris can make, and writing it is not a
mistake: it is a claim that costs a unit's turn and buys a rumour. The
adjudicator throws it out and the unit holds, and — this is the whole of the
value — nobody else at the table can tell it apart from an order that was
tried and bounced.

An app that refuses the order at the keyboard takes that away, so the server
stores anything that parses and marks what it refused (settings.illegalMoves).
This file holds the two things every screen needs to agree on: whether the
setting is on, and whether a resolution the server sent back means "this was
never legal".

The setting defaults to ON when it is absent, which is what a server that
predates the setting is: it accepted whatever it was sent.
*/

/** Whatever a state's settings say about it, with the default filled in. */
export function illegalAllowed(settings: { illegalMoves?: boolean } | undefined): boolean {
  return settings?.illegalMoves !== false;
}

/*
godip refuses an unresolvable order with a resolution of its own. It is a
failure like any other — the unit held — but it failed before the adjudication
rather than in it, and a player reading the review is owed the difference:
"bounced" is a story about the board, "illegal" is a story about the order.
*/
export const ILLEGAL_RESOLUTION = "IllegalOrder";

export function isIllegal(resolution: string | undefined): boolean {
  const head = String(resolution || "").trim().split(":")[0];
  return head === ILLEGAL_RESOLUTION || head === "Err" + ILLEGAL_RESOLUTION;
}

/** What the review says about one. Short, because it sits after the order. */
export const ILLEGAL_REASON = "illegal — the unit held";

/*
The line a player sees under their OWN illegal draft, before anything has
resolved. It says both halves: the order will not happen, and nobody else can
see that it will not.
*/
export const ILLEGAL_DRAFT_NOTE = "illegal — will hold; opponents cannot tell";
