/*
What each phase type asks of a player, worked out from the board state and the
options trees the server answers with. Everything here is pure, so the rules
can be tested without a map.

The three phase types godip runs, and what the options look like in each
(captured from a live classical game):

  Movement    {Hold|Move|Support|Convoy: {Type:"OrderType",
                Next:{<src>:{Type:"SrcProvince", Next:{…}}}}}

  Retreat     {Move:    {Type:"OrderType",
                          Next:{<src>:{Type:"SrcProvince",
                                       Next:{<dst>:{}, …}}}},
               Disband: {Type:"OrderType",
                          Next:{<src>:{Type:"SrcProvince", Next:{}}}}}
              Only the dislodged unit's own province carries options.

  Adjustment  {Build:   {Type:"OrderType", Filter:"MAX:Build:0",
                          Next:{Army|Fleet:{Type:"UnitType",
                                Next:{<src>:{Type:"SrcProvince", Next:{}}}}}}}
              {Disband: {Type:"OrderType", Filter:"MAX:Disband:0",
                          Next:{<src>:{Type:"SrcProvince", Next:{}}}}}
              Builds are offered on the empty centres the variant allows,
              disbands on units.

The filter is "MAX:<type>:<n>", where n is one LESS than the number of orders
of that type the power owes. So "MAX:Build:0" means one build.
*/

import type { BoardState, OptionTree, Unit } from "./types";
import { baseProvince, provinceName, unitLabel } from "./provinces";

export type PhaseKind = "movement" | "retreat" | "adjustment";

export interface Duty {
  type: "Build" | "Disband";
  count: number;
}

export interface PhasePlan {
  kind: PhaseKind;
  /** The seat's own power. */
  power: string;
  /** Province → the options tree the server gave for it. */
  actionable: Record<string, OptionTree>;
  /** How many builds or disbands are owed, when the phase asks for either. */
  duty: Duty | null;
}

export function phaseKind(phase: BoardState["phase"]): PhaseKind {
  const type = String(phase?.type || "").toLowerCase();
  if (type === "retreat") return "retreat";
  if (type === "adjustment") return "adjustment";
  return "movement";
}

export function emptyPlan(power: string, kind: PhaseKind = "movement"): PhasePlan {
  return { kind: kind, power: power, actionable: {}, duty: null };
}

/** Dislodged units of one power, by province. */
export function ownDislodged(state: BoardState | null, power: string): string[] {
  const dislodged = state?.dislodged || {};
  return Object.keys(dislodged)
    .filter((province) => dislodged[province].nation === power)
    .sort();
}

function ownUnits(state: BoardState | null, power: string): string[] {
  const units = state?.units || {};
  return Object.keys(units)
    .filter((province) => units[province].nation === power)
    .sort();
}

/*
The provinces worth asking the server about when a phase begins. The server
decides what is legal; this only keeps the page from asking about every
province on the map.

Which supply centres a power may build in is the variant's business, not this
page's: no home-centre table lives here. A build can only ever be offered on a
supply centre this power holds with nothing standing on it, so those are what
is probed, and the tree that comes back — empty for a centre that is not a
home centre for this variant — is the answer.
*/
export function candidates(state: BoardState | null, power: string, kind: PhaseKind): string[] {
  if (kind === "retreat") return ownDislodged(state, power);
  if (kind !== "adjustment") return [];

  const units = state?.units || {};
  const centers = state?.supplyCenters || {};
  const empty = Object.keys(centers).filter(
    (province) => centers[province] === power && !occupied(units, province),
  );
  return Array.from(new Set(ownUnits(state, power).concat(empty))).sort();
}

function occupied(units: Record<string, Unit>, province: string): boolean {
  return Object.keys(units).some((key) => baseProvince(key) === province);
}

/** "MAX:Build:0" on any node of a tree means one build is owed. */
export function dutyOf(tree: OptionTree): Duty | null {
  for (const key of Object.keys(tree || {})) {
    const filter = tree[key]?.Filter;
    if (!filter) continue;
    const match = /^MAX:(Build|Disband):(\d+)$/.exec(filter);
    if (match) return { type: match[1] as Duty["type"], count: Number(match[2]) + 1 };
  }
  return null;
}

/** The duty the whole plan carries, taken from the first tree that names one. */
export function planDuty(actionable: Record<string, OptionTree>): Duty | null {
  for (const province of Object.keys(actionable)) {
    const duty = dutyOf(actionable[province]);
    if (duty) return duty;
  }
  return null;
}

/** The line under the phase name: what this power must do before it finalizes. */
export function dutyLine(plan: PhasePlan, state: BoardState | null): string {
  const provinces = Object.keys(plan.actionable);
  if (plan.kind === "movement") return "";
  if (provinces.length === 0) {
    // Nothing left to order can mean two things: this power was never asked,
    // or it has already spent everything the phase gave it.
    if (Object.keys(state?.orderParts || {}).length > 0) {
      return plan.kind === "retreat" ? "Your retreat is in." : "Your adjustments are in.";
    }
    return "Nothing to order this phase — waiting for others.";
  }

  if (plan.kind === "retreat") {
    const names = provinces.map((province) => unitLabel(state, province, true));
    if (names.length === 1) return names[0] + " must retreat or disband.";
    return names.join(", ") + " must retreat or disband.";
  }

  const duty = plan.duty;
  if (!duty) return "Adjustments are open.";
  const many = duty.count === 1 ? "" : "s";
  if (duty.type === "Build") {
    /* Not "home centres": several variants let a power build on any centre it
       holds, and the server has already decided which ones — they are the
       highlighted ones. */
    return "Build " + duty.count + ": tap a highlighted supply centre.";
  }
  return "Disband " + duty.count + ": tap " + (duty.count === 1 ? "a unit" : duty.count + " units") + " to remove" + many + ".";
}

/** How many orders of the duty's type are in already. */
export function dutyProgress(state: BoardState | null, duty: Duty | null): number {
  if (!duty) return 0;
  const parts = state?.orderParts || {};
  return Object.keys(parts).filter((province) => parts[province][0] === duty.type).length;
}

/*
What an order will read as once it is in. The phase decides the words: the same
["Move", "boh"] is an attack in a movement phase and a retreat in a retreat
phase.
*/
export function describeInPhase(province: string, parts: string[], kind: PhaseKind): string {
  const from = provinceName(province);
  const type = parts[0];
  if (kind === "retreat") {
    if (type === "Move") return from + " retreats to " + provinceName(parts[1]) + ".";
    if (type === "Disband") return from + " disbands.";
  }
  if (kind === "adjustment") {
    if (type === "Build") {
      const unit = String(parts[1] || "unit").toLowerCase();
      return from + " builds " + (unit === "army" ? "an army" : "a " + unit) + ".";
    }
    if (type === "Disband") return from + " disbands.";
  }
  return "";
}
