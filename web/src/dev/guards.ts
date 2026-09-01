/*
Structural checks for the captured fixtures.

The fixtures are JSON files, so TypeScript will believe anything about them.
These guards are what makes an `as SeatState` honest: they walk the shape the
page actually reads and refuse a file that has drifted from the server. The
test suite runs every fixture through them, so a capture taken against a newer
server fails the build rather than the gallery.

They check shape, not truth. A guard asks "is `units` a map of province to
{type, nation}", never "is Vienna Austrian".
*/

import type { GmState, PublicState, SandboxState, SeatState, WatchState } from "../api";
import type { DatcReport } from "../pages/DatcPage";
import type { OptionTree } from "../board/types";

type Bag = Record<string, unknown>;

function bag(value: unknown): Bag | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Bag) : null;
}

/** Every value of a map answers `check`. An absent or null map passes. */
function mapOf(value: unknown, check: (one: unknown) => boolean): boolean {
  if (value === undefined || value === null) return true;
  const holder = bag(value);
  if (!holder) return false;
  return Object.values(holder).every(check);
}

function optional(value: unknown, check: (one: unknown) => boolean): boolean {
  return value === undefined || value === null || check(value);
}

const isString = (v: unknown) => typeof v === "string";
const isNumber = (v: unknown) => typeof v === "number";
const isBool = (v: unknown) => typeof v === "boolean";
const isStrings = (v: unknown) => Array.isArray(v) && v.every(isString);

function isUnit(value: unknown): boolean {
  const unit = bag(value);
  return Boolean(unit && isString(unit.type) && isString(unit.nation));
}

function isPlacement(value: unknown): boolean {
  const place = bag(value);
  if (!place) return false;
  const pair = (v: unknown) => Array.isArray(v) && v.length === 2 && v.every(isNumber);
  return pair(place.unit) && isNumber(place.scale) && pair(place.dislodged);
}

function isPhase(value: unknown): boolean {
  const phase = bag(value);
  if (!phase) return false;
  return optional(phase.season, isString) && optional(phase.year, isNumber) &&
    optional(phase.type, isString);
}

/** The board fields every state that draws a map carries. */
function isBoardish(state: Bag): boolean {
  return (
    optional(state.phase, isPhase) &&
    mapOf(state.units, isUnit) &&
    mapOf(state.dislodged, isUnit) &&
    mapOf(state.supplyCenters, isString) &&
    mapOf(state.orders, isString) &&
    mapOf(state.orderParts, isStrings) &&
    mapOf(state.placements, isPlacement) &&
    mapOf(state.provinceNames, isString)
  );
}

function isVariantRef(value: unknown): boolean {
  const ref = bag(value);
  return Boolean(ref && isString(ref.key) && isString(ref.name) && isBool(ref.supported));
}

function isSettings(value: unknown): boolean {
  const rules = bag(value);
  return Boolean(
    rules && isNumber(rules.deadlineMinutes) && isBool(rules.gmPlays) &&
      optional(rules.variant, isString) && optional(rules.name, isString),
  );
}

function isPreviousPhase(value: unknown): boolean {
  const prev = bag(value);
  if (!prev) return false;
  return (
    optional(prev.phase, isPhase) &&
    mapOf(prev.orders, isString) &&
    mapOf(prev.orderParts, isStrings) &&
    mapOf(prev.powers, isString) &&
    mapOf(prev.resolutions, isString) &&
    mapOf(prev.dislodged, isUnit) &&
    optional(prev.nmr, isStrings)
  );
}

/** The fields common to every state answer: the variant and the clock. */
function isVariantAware(state: Bag): boolean {
  return (
    optional(state.variant, isVariantRef) &&
    optional(state.now, isString) &&
    optional(state.previousPhase, isPreviousPhase)
  );
}

export function isSeatState(value: unknown): value is SeatState {
  const state = bag(value);
  if (!state) return false;
  const you = bag(state.you);
  return Boolean(
    you && isString(you.power) &&
      isBoardish(state) &&
      isVariantAware(state) &&
      isSettings(state.settings) &&
      isNumber(state.settingsVersion) &&
      isBool(state.started) &&
      isBool(state.youLocked) &&
      optional(state.nothingToOrder, isBool) &&
      isBool(state.canForce) &&
      isNumber(state.lockedCount) &&
      isNumber(state.totalSeats) &&
      isNumber(state.joinedCount) &&
      isNumber(state.seatsOnOffer) &&
      optional(state.deadlineAt, isString) &&
      mapOf(state.locked, isBool) &&
      mapOf(state.phaseResolutions, isString) &&
      optional(state.refereeUrl, isString),
  );
}

/*
The sandbox answer (ADR-047): the seat state with the seat taken off. No `you`,
no lock, no clock — and one field a seat has no use for, which is who entered
each drafted order.
*/
export function isSandboxState(value: unknown): value is SandboxState {
  const state = bag(value);
  if (!state) return false;
  return Boolean(
    isString(state.gameId) &&
      isBoardish(state) &&
      isVariantAware(state) &&
      isSettings(state.settings) &&
      isNumber(state.settingsVersion) &&
      isNumber(state.phaseIndex) &&
      isStrings(state.nations) &&
      isStrings(state.nothingToOrder) &&
      mapOf(state.orderPowers, isString) &&
      optional(state.illegal, isStrings),
  );
}

export function isGmState(value: unknown): value is GmState {
  const state = bag(value);
  if (!state) return false;
  const seats = state.seats;
  const seatOk = (one: unknown) => {
    const seat = bag(one);
    return Boolean(
      seat && isString(seat.power) && isBool(seat.joined) && isBool(seat.locked) &&
        optional(seat.isGm, isBool),
    );
  };
  return Boolean(
    isString(state.gameId) &&
      isVariantAware(state) &&
      isSettings(state.settings) &&
      isNumber(state.settingsVersion) &&
      isBool(state.started) &&
      optional(state.phase, isPhase) &&
      Array.isArray(seats) &&
      seats.every(seatOk) &&
      isNumber(state.joinedCount) &&
      isNumber(state.totalSeats) &&
      (state.gmPower === null || isString(state.gmPower)) &&
      isString(state.inviteUrl) &&
      optional(state.deadlineAt, isString) &&
      isBool(state.canForce) &&
      optional(state.gmSeatUrl, isString) &&
      optional(state.events, isStrings),
  );
}

export function isWatchState(value: unknown): value is WatchState {
  const state = bag(value);
  if (!state) return false;
  return Boolean(
    isString(state.gameId) &&
      isBoardish(state) &&
      isVariantAware(state) &&
      isBool(state.started) &&
      optional(state.phaseIndex, isNumber) &&
      optional(state.phaseCount, isNumber) &&
      optional(state.historical, isBool) &&
      mapOf(state.powers, isString) &&
      mapOf(state.resolutions, isString) &&
      optional(state.nmr, isStrings) &&
      mapOf(state.locked, isBool) &&
      optional(state.lockedCount, isNumber) &&
      optional(state.totalSeats, isNumber) &&
      optional(state.deadlineAt, isString),
  );
}

export function isPublicState(value: unknown): value is PublicState {
  const state = bag(value);
  if (!state) return false;
  return Boolean(
    isString(state.gameId) &&
      isVariantAware(state) &&
      isBool(state.started) &&
      isNumber(state.joinedCount) &&
      isNumber(state.totalSeats) &&
      mapOf(state.locked, isBool) &&
      isSettings(state.settings) &&
      isNumber(state.settingsVersion),
  );
}

/*
The published DATC report (ADR-045). It is generated by the run that resolved
the cases, so the gallery's copy is a capture like any other and the guard is
what says it still has the shape the page draws.
*/
export function isDatcReport(value: unknown): value is DatcReport {
  const report = bag(value);
  if (!report) return false;
  const fileOk = (one: unknown) => {
    const file = bag(one);
    return Boolean(
      file && isString(file.name) && isNumber(file.cases) && isNumber(file.passed) &&
        isStrings(file.failed),
    );
  };
  return Boolean(
    isString(report.engine) &&
      isString(report.variant) &&
      isNumber(report.cases) &&
      isNumber(report.passed) &&
      Array.isArray(report.files) &&
      report.files.every(fileOk) &&
      isStrings(report.limits),
  );
}

/*
godip's option tree, as far as the page cares: a recursive map whose nodes may
carry Type, Filter and a Next of the same shape.
*/
export function isOptionTree(value: unknown): value is OptionTree {
  const tree = bag(value);
  if (!tree) return false;
  return Object.values(tree).every((node) => {
    const one = bag(node);
    if (!one) return false;
    return (
      optional(one.Type, isString) &&
      optional(one.Filter, isString) &&
      optional(one.Next, isOptionTree)
    );
  });
}

/** A map of province to option tree, which is how the fixtures store them. */
export function isOptionBook(value: unknown): value is Record<string, OptionTree> {
  const book = bag(value);
  return Boolean(book && Object.values(book).every(isOptionTree));
}
