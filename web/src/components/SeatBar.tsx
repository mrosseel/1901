import type { ReactNode } from "react";

import { clockFace, clockTone, msLeft } from "../clock";
import { useTicker } from "../hooks";
import { PhaseName } from "./PhaseName";
import type { BoardState } from "../board/types";
import { inkOn } from "./PowerChip";
import { powerColor } from "../board/provinces";

/*
One row across the top of the seat screen: everything a player needs without
looking for it.

A phone at a table is read in glances between conversations. The four things
that decide what to do next were spread down the panel, below the map, and the
panel is also where the orders are — so checking the clock meant scrolling past
the thing you were in the middle of. They live here instead, in the order a
player asks for them:

	who am I     the power, on its own colour, and the seat menu behind it
	where are we the phase
	am I done    orders entered of orders expected
	how long     the deadline
	who wants me unread press

Nothing in the bar is a link away from the page. It is four facts and two
controls, and it never wraps: at 320px the phase shortens and the chip drops to
three letters before anything is dropped.
*/
export function SeatBar({
  power,
  phase,
  started,
  ordersIn,
  ordersExpected,
  locked,
  deadlineAt,
  unread,
  pressEnabled,
  pressShowing,
  onPress,
  menu,
}: {
  power: string;
  phase: BoardState["phase"];
  /** Before the start there is no phase, no count and no clock to show. */
  started: boolean;
  ordersIn: number;
  ordersExpected: number;
  /** This seat has declared the phase done, which is the end of the count. */
  locked: boolean;
  deadlineAt: string | null | undefined;
  unread: number;
  pressEnabled: boolean;
  pressShowing: boolean;
  onPress: () => void;
  /** The seat menu, opened by the power chip (ADR-041). */
  menu: ReactNode;
}) {
  useTicker(Boolean(deadlineAt));
  const left = msLeft(deadlineAt);
  const background = powerColor(power);

  return (
    <div className="seat-top">
      <div
        className="seat-top-power"
        style={{ background: background, color: inkOn(background) }}
      >
        {menu}
      </div>

      <div className="seat-top-phase">
        {started ? <PhaseName phase={phase} /> : "Waiting to start"}
      </div>

      {/* Not a progress bar. A player wants the two numbers, and whether the
          gap between them is a problem. */}
      {started ? (
        <div
          className={
            "seat-top-orders" +
            (locked ? " locked" : ordersIn < ordersExpected ? " short" : " complete")
          }
          title={
            locked ? "Your orders are in" : ordersIn + " of " + ordersExpected + " orders entered"
          }
        >
          {locked ? (
            <span className="seat-top-ready">Ready</span>
          ) : (
            <>
              <OrdersIcon />
              <strong>{ordersIn}</strong>
              <span className="seat-top-of">/{ordersExpected}</span>
            </>
          )}
        </div>
      ) : null}

      {started && left !== null ? (
        <div className={"seat-top-clock " + clockTone(left)} role="timer" aria-live="off">
          {clockFace(left)}
        </div>
      ) : null}

      {pressEnabled ? (
        <button
          type="button"
          className={pressShowing ? "seat-top-press showing" : "seat-top-press"}
          aria-pressed={pressShowing}
          aria-label={
            pressShowing
              ? "Back to orders"
              : unread
                ? unread + " unread " + (unread === 1 ? "message" : "messages")
                : "Messages"
          }
          onClick={onPress}
        >
          <EnvelopeIcon />
          {unread ? <span className="seat-top-badge">{unread > 99 ? "99+" : unread}</span> : null}
        </button>
      ) : null}
    </div>
  );
}

/* A sheet with three ruled lines: an order form. Bare digits in the bar read
   as a score, or a phase count, until the icon says what is being counted. */
function OrdersIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
      <rect x="5" y="3" width="14" height="18" rx="2" fill="none" stroke="currentColor"
        strokeWidth="1.8" />
      <path d="M8.5 8.5h7M8.5 12h7M8.5 15.5h4.5" fill="none" stroke="currentColor"
        strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

/* Drawn rather than typed: an emoji envelope is a different size, colour and
   baseline on every phone at the table. */
function EnvelopeIcon() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false">
      <rect x="2.5" y="5" width="19" height="14" rx="2.5" fill="none" stroke="currentColor"
        strokeWidth="1.8" />
      <path d="M3.5 7l8.5 6 8.5-6" fill="none" stroke="currentColor" strokeWidth="1.8"
        strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
