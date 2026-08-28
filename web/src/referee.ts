/*
The referee guide: what to do to the pieces on the real board.

At a face-to-face table somebody pushes the pieces, and at a tournament that
is a named role with a budget of minutes. Every other screen in this app
answers "what happened"; this one answers "what do I move", which is a
different list. A support that held is history and needs no hand; a bounce
needs a hand precisely because nothing moves and the piece pusher must be told
not to touch it.

So the guide is grouped by physical act, in the order a pair of hands does
them: pieces that travel, pieces that come off, pieces that go on, and last
the pieces that stay where they are. It is written to be read ALOUD, so every
line is a whole imperative sentence with a long province name in it — never
"vie → tri".

Everything here is pure: it takes the previousPhase record the server already
publishes and returns sentences.
*/

import type { PreviousPhase } from "./api";
import { phaseKind, type PhaseKind } from "./board/phases";
import { phaseLabel, provinceName } from "./board/provinces";
import { isFailure } from "./review";

/** One thing to do to the board, or one thing deliberately not done. */
export interface RefereeAction {
  /** Unique within the guide, for React keys. */
  id: string;
  /** Whose piece it is, for the coloured dot. */
  power: string;
  /*
  The act itself. Where there is a note, the two are read as one sentence —
  "Army Munich stays — bounced in Paris." — so the act carries no full stop of
  its own and the note carries the one for both.
  */
  text: string;
  /** The trailing clause, quieter on screen: why, or what to do with it. */
  note?: string;
}

export type RefereeGroup = "moves" | "removals" | "placements" | "stays";

export interface RefereeSection {
  id: RefereeGroup;
  title: string;
  actions: RefereeAction[];
}

export interface RefereeGuide {
  /** The phase these acts belong to. */
  title: string;
  kind: PhaseKind;
  /** Only the sections that have something in them. */
  sections: RefereeSection[];
  /* How many pieces actually have to be touched. The pieces that stay put are
     listed but not counted: they are the answer to "and the rest?", not work. */
  total: number;
}

const TITLES: Record<RefereeGroup, string> = {
  moves: "Move these",
  removals: "Take these off",
  placements: "Put these on",
  stays: "Leave these alone",
};

const ORDER: RefereeGroup[] = ["moves", "removals", "placements", "stays"];

/*
The unit type, read back out of the server's own prose.

previousPhase carries no units — it is a record of orders — but the prose it
carries was written while the unit was still standing there, as "Army Vienna
Move Trieste". So the words before the province's long name are the unit type,
whatever this variant calls it, and a prose line that does not name the
province at all simply yields nothing.
*/
export function unitTypeOf(province: string, prose: string | undefined): string {
  const said = String(prose || "");
  const name = provinceName(province);
  const at = said.indexOf(name);
  if (at <= 0) return "";
  return said.slice(0, at).trim();
}

/** "Army Vienna", or just "Vienna" when the prose did not name a unit type. */
export function pieceLabel(province: string, prose: string | undefined): string {
  const type = unitTypeOf(province, prose);
  return type ? type + " " + provinceName(province) : provinceName(province);
}

/*
Why an order did not come off, in the words a referee says out loud.

godip writes "ErrBounce:bur". review.ts already unpacks that for the order
list; this phrasing differs on purpose — "bounced in Burgundy" rather than
"bounce (Burgundy)" — because this line is spoken and that one is read.
*/
export function refereeReason(resolution: string | undefined): string {
  const text = String(resolution || "").trim();
  if (!isFailure(text)) return "";
  const [head, where] = text.split(":");
  const bare = head.replace(/^Err/, "");
  const words =
    bare
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .toLowerCase()
      .trim() || "failed";
  const said = words === "bounce" ? "bounced" : words;
  return where ? said + " in " + provinceName(where) : said;
}

export function refereeGuide(previous: PreviousPhase | null | undefined): RefereeGuide | null {
  if (!previous) return null;
  const orderParts = previous.orderParts || {};
  const prose = previous.orders || {};
  const powers = previous.powers || {};
  const resolutions = previous.resolutions || {};
  const dislodged = previous.dislodged || {};
  const nmr = (previous.nmr || []).filter(Boolean);
  const kind = phaseKind(previous.phase);

  const provinces = Array.from(
    new Set(Object.keys(orderParts).concat(Object.keys(prose))),
  ).sort();
  if (!provinces.length && !nmr.length && !Object.keys(dislodged).length) return null;

  const groups: Record<RefereeGroup, RefereeAction[]> = {
    moves: [],
    removals: [],
    placements: [],
    stays: [],
  };

  provinces.forEach((province) => {
    const parts = orderParts[province] || [];
    const type = parts[0];
    const power = powers[province] || "";
    const piece = pieceLabel(province, prose[province]);
    const failed = isFailure(resolutions[province]);
    const why = refereeReason(resolutions[province]);

    if (kind === "adjustment") {
      if (type === "Build") {
        const unit = String(parts[1] || "unit");
        groups.placements.push({
          id: province,
          power: power,
          text: "Place a new " + unit + " in " + provinceName(province) + ".",
        });
        return;
      }
      if (type === "Disband") {
        groups.removals.push({
          id: province,
          power: power,
          text: "Remove " + piece + " from the board.",
        });
      }
      return;
    }

    if (kind === "retreat") {
      if (type === "Disband") {
        groups.removals.push({
          id: province,
          power: power,
          text: "Remove " + piece + " from the board.",
        });
        return;
      }
      if (type === "Move" && parts[1]) {
        if (failed) {
          groups.removals.push({
            id: province,
            power: power,
            text: "Remove " + piece + " from the board",
            note: "its retreat " + why + ".",
          });
          return;
        }
        groups.moves.push({
          id: province,
          power: power,
          text: "Retreat " + piece + " to " + provinceName(parts[1]) + ".",
        });
      }
      return;
    }

    // Movement. Only a move puts a hand on the board; everything else that
    // came off is bookkeeping the pusher does not need.
    if (type === "Move" && parts[1] && !failed) {
      groups.moves.push({
        id: province,
        power: power,
        text: "Move " + piece + " to " + provinceName(parts[1]) + ".",
      });
      return;
    }
    if (failed) {
      groups.stays.push({
        id: province,
        power: power,
        text: piece + " stays",
        note: why + ".",
      });
    }
  });

  /*
  A dislodged unit is the one piece that is neither moved nor removed: it is
  lifted off its province and stood beside it until the retreat phase says
  which. That is a physical act, so it belongs in the removals column even
  though the piece is not going back in the box.
  */
  Object.keys(dislodged)
    .sort()
    .forEach((province) => {
      const unit = dislodged[province];
      groups.removals.push({
        id: "dislodged:" + province,
        power: unit.nation,
        text: unit.type + " " + provinceName(province) + " is dislodged",
        note: "stand it aside until the retreat phase.",
      });
    });

  nmr.forEach((power) => {
    groups.stays.push({
      id: "nmr:" + power,
      power: power,
      text: power + " sent no orders",
      note: "all of " + power + "'s units hold.",
    });
  });

  const sections = ORDER.map((id) => ({
    id: id,
    title: TITLES[id],
    actions: groups[id],
  })).filter((section) => section.actions.length > 0);

  return {
    title: phaseLabel(previous.phase),
    kind: kind,
    sections: sections,
    total: sections
      .filter((section) => section.id !== "stays")
      .reduce((sum, section) => sum + section.actions.length, 0),
  };
}
