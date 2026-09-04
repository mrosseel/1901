import { useEffect } from "react";
import { PowerChip } from "./PowerChip";
import { nmrLine, type ReviewPlan } from "../review";
import { Clock } from "./Clock";
import { PhaseName } from "./PhaseName";
import { OrderNotationToggle } from "./OrderNotationToggle";
import { useBriefMoves } from "../prefs";

/*
What happened last phase, read while the next one is already running.

The map behind this sheet is drawing the same thing — every power's orders,
the failed ones crossed — so the sheet stays a sheet and never covers the
board. The clock for the NEW phase sits in its header, because the deadline
does not wait for anyone to finish reading, and a player who loses track of it
is a player who gets adjudicated as an NMR.

Closing is this device's own. Nothing is sent, nobody is waited for, and
another player still reading is not holding anyone up. The button says
"Close review" for that reason: it must not read as a step the game takes.
*/
export function ReviewOverlay({
  plan,
  deadlineAt,
  onClose,
  onReferee,
  onMap,
}: {
  plan: ReviewPlan;
  deadlineAt: string | null | undefined;
  onClose: () => void;
  /** Opens the piece pusher's list. Absent on a screen that has no board. */
  onReferee?: () => void;
  /*
  Puts the sheet away and leaves the map, which is drawing this same phase.
  Absent on a screen with no board behind the sheet — the game master's
  page has none.
  */
  onMap?: () => void;
}) {
  /* The same switch as the seat's own order list, reading the same preference:
     a player who writes their orders in notation reads them back in it. */
  const [brief, setBrief] = useBriefMoves();

  return (
    <section className="review-sheet" aria-label="What happened last phase">
      <header className="review-head">
        <div>
          <h2>
            <PhaseName label={plan.title} />
          </h2>
          <p className="muted">
            {plan.ordered === 0
              ? "No orders were submitted."
              : plan.ordered + " orders submitted · " +
                Object.keys(plan.dislodged).length + " units dislodged."}{" "}
            {/* The list below is what this rewrites, so the switch sits with
                the line that counts it. */}
            <OrderNotationToggle value={brief} onChange={setBrief} />
          </p>
        </div>
        <Clock deadlineAt={deadlineAt} />
      </header>

      {plan.nmr.length ? (
        <ul className="review-nmr">
          {plan.nmr.map((power) => (
            <li key={power}>
              <PowerChip power={power} small />
              {nmrLine(power, plan.kind)}
            </li>
          ))}
        </ul>
      ) : null}

      <ul className="review-list">
        {plan.rows.map((row) => (
          <li
            key={row.province}
            className={
              "review-row" + (row.failed ? " failed" : "") + (row.illegal ? " illegal" : "")
            }
          >
            <PowerChip power={row.power} small />
            <span className="order-text">{brief ? row.brief : row.text}</span>
            {row.failed ? (
              <span className={row.illegal ? "review-why illegal" : "review-why"}>
                {row.reason}
              </span>
            ) : null}
          </li>
        ))}
      </ul>

      <div className="review-actions">
        {/*
        Two ways to read one turn, and the same turn either way: the sheet
        names the orders, the map draws them. The pair sit side by side and
        the same size, because neither is the answer — a player checking
        whether their support landed wants the map, and one counting builds
        wants the list.
        */}
        {onMap ? (
          <button type="button" className="primary review-flip" onClick={onMap}>
            See it on the map
          </button>
        ) : null}
        <button type="button" className="primary" onClick={onClose}>
          Close review
        </button>
        {/* The same phase, told as physical acts, for whoever keeps the real
            board. A quiet link: most tables project the board and never touch
            pieces, so this must not compete with Close review. */}
        {onReferee ? (
          <button type="button" className="link" onClick={onReferee}>
            Move the pieces
          </button>
        ) : null}
      </div>
    </section>
  );
}

/*
The review, with the map showing instead of the list.

The board behind is already drawing this phase — every power's orders, the
failed ones crossed — so reading it needs no sheet at all. What it needs is
the way back and the way out, and nothing else on screen.

The map may be panned and zoomed while this stands. It cannot be ordered on:
the board refuses every tap while a review is up, and the order panel beside
it stays inert, so the one thing a player must not do half-read — lock in this
phase — is still out of reach.
*/
export function ReviewPeekBar({
  title,
  onMoves,
  onClose,
}: {
  title: string;
  onMoves: () => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="review-bar" role="dialog" aria-label="What happened last phase">
      <p className="review-bar-title">
        <PhaseName label={title} />
      </p>
      <div className="review-actions">
        <button type="button" className="primary review-flip" onClick={onMoves}>
          Read the orders
        </button>
        <button type="button" className="primary" onClick={onClose}>
          Close review
        </button>
      </div>
    </div>
  );
}
