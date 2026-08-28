/* The shapes the board island reads. They match the seat state JSON, which is
   the board filtered to one power. */

import type { PhasePlan } from "./phases";

export interface Unit {
  type: string;
  /* godip's word for the power, kept only where it crosses the godip
     boundary: the JSON field name. Nothing built from it reaches the UI. */
  nation: string;
}

export interface PhaseInfo {
  season?: string;
  year?: number;
  type?: string;
}

export interface BoardState {
  phase?: PhaseInfo;
  units?: Record<string, Unit>;
  /* Units thrown out of their province by the last adjudication, keyed by the
     province they were thrown out of. They stand beside the winner until the
     retreat phase resolves, so the map must draw both. Public knowledge. */
  dislodged?: Record<string, Unit>;
  supplyCenters?: Record<string, string>;
  orders?: Record<string, string>;
  orderParts?: Record<string, string[]>;
  resolutions?: Record<string, string>;
}

/* godip serialises Options as a recursive map:
     { "<value>": { "Type": "OrderType"|"Province"|"SrcProvince"|"UnitType",
                    "Next": { ... }, "Filter": "..." } }
   A leaf has an empty or missing "Next". */
export interface OptionNode {
  Type?: string;
  Next?: OptionTree;
  Filter?: string;
}

export type OptionTree = Record<string, OptionNode>;

/* What the island hands React so it can draw the order builder. The island
   keeps the tree; React only draws these buttons and calls choose(). */
export interface BuilderView {
  province: string;
  title: string;
  hint: string;
  /* Each button carries an id the island resolves itself: some descend one
     step into the tree, others stand for a whole path ("Build Army"). */
  options: Array<{ id: string; label: string; filter?: string; danger?: boolean }>;
}

export interface BoardApi {
  /** Where the map SVG comes from. */
  mapUrl: string;
  /** The option tree for one province. */
  options(province: string): Promise<OptionTree>;
  /** Posts an order and answers with the new state. Empty parts drop it. */
  order(province: string, parts: string[]): Promise<BoardState>;
}

export interface BoardCallbacks {
  /** The one hint line: what to tap next, or what just happened. */
  status(text: string, isError?: boolean): void;
  /** null closes the order builder. */
  builder(view: BuilderView | null): void;
  /** A fresh state came back from an order post. */
  state(state: BoardState): void;
  /** Which order is singled out on the map, so a list can match it. */
  select(province: string | null): void;
  /** Refuses a unit before any request is made. Seat mode says "not mine". */
  canOrder?(province: string, unit: Unit | undefined): boolean;
  /** The message shown when canOrder refuses. */
  refusal?(province: string, unit: Unit | undefined): string;
}

/*
What the board draws when it is showing the phase that just resolved instead
of the one being ordered: every power's orders, not one power's, with the ones
that failed marked. It is drawn from provinces alone — the arrows run between
province anchors — so it needs no units, only who ordered where.
*/
export interface ReviewDraw {
  /** The kind of the phase reviewed, which decides how the parts read. */
  kind: "movement" | "retreat" | "adjustment";
  orderParts: Record<string, string[]>;
  /** province → the power that ordered there, for the colour. */
  powers: Record<string, string>;
  /** The provinces whose order did not come off. */
  failed: string[];
  /** Units thrown out by this adjudication, ringed where they stood. */
  dislodged: Record<string, Unit>;
}

export interface BoardHandle {
  /** Replaces the board state and the phase plan, and redraws. Safe before
      the map has loaded. */
  update(state: BoardState, plan: PhasePlan): void;
  /** Draws the phase that just resolved instead of the live one; null ends it.
      While a review is up the map takes no orders. */
  showReview(view: ReviewDraw | null): void;
  /** Presses one of the builder's buttons, by id. */
  choose(id: string): void;
  /** Backs out one step: the chip, then a half-built support, then the order. */
  escape(): void;
  /** Drops the order for a province. */
  cancelOrder(province: string): Promise<void>;
  /** Drops it and reopens the unit for a new one. */
  changeOrder(province: string): Promise<void>;
  /** Singles out one order on the map, or clears the choice. */
  selectOrder(province: string | null): void;
  resetView(): void;
  /** Resolves once the map is on screen; rejects if it cannot be loaded. */
  ready: Promise<void>;
  destroy(): void;
  /** Read-only innards, for the test harness. */
  debug: {
    centers: Map<string, { x: number; y: number }>;
    view(): { x: number; y: number; w: number; h: number } | null;
    zoom(): number;
    state(): BoardState | null;
    plan(): PhasePlan;
  };
}
