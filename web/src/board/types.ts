/* The shapes the board island reads. They match the M0 state JSON, which the
   seat endpoint also answers with, filtered to one power. */

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
  options: Array<{ key: string; label: string; filter?: string }>;
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

export interface BoardHandle {
  /** Replaces the board state and redraws. Safe before the map has loaded. */
  update(state: BoardState): void;
  /** Picks one option in the builder, by key. */
  choose(key: string): void;
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
  };
}
