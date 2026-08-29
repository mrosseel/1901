import { powerColor } from "../board/provinces";
import { nmrLine, type ReviewPlan } from "../review";
import { Clock } from "./Clock";
import { PhaseName } from "./PhaseName";
import { OrderNotationToggle } from "./OrderNotationToggle";
import { useBriefMoves } from "../prefs";
import { ILLEGAL_REASON } from "../illegal";

/*
What happened last turn, read while the next one is already running.

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
}: {
  plan: ReviewPlan;
  deadlineAt: string | null | undefined;
  onClose: () => void;
  /** Opens the piece pusher's list. Absent on a screen that has no board. */
  onReferee?: () => void;
}) {
  /* The same switch as the seat's own order list, reading the same preference:
     a player who writes their orders in notation reads them back in it. */
  const [brief, setBrief] = useBriefMoves();

  return (
    <section className="review-sheet" aria-label="What happened last turn">
      <header className="review-head">
        <div>
          <h2>
            <PhaseName label={plan.title} />
          </h2>
          <p className="muted">
            {plan.ordered === 0
              ? "No orders were given."
              : plan.succeeded + " of " + plan.ordered + " orders came off."}{" "}
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
              <span className="dot" style={{ background: powerColor(power) }} />
              {nmrLine(power)}
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
            <span className="dot" style={{ background: powerColor(row.power) }} />
            <span className="order-text">{brief ? row.brief : row.text}</span>
            {row.failed ? (
              <span className={row.illegal ? "review-why illegal" : "review-why"}>
                {row.illegal ? ILLEGAL_REASON : row.reason}
              </span>
            ) : null}
          </li>
        ))}
      </ul>

      <div className="review-actions">
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
      <p className="note">
        Closing this changes nothing in the game. Only your screen — everyone else reads at
        their own pace.
      </p>
    </section>
  );
}
