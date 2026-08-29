import { powerColor } from "../board/provinces";
import { nmrLine, type ReviewPlan } from "../review";
import { Clock } from "./Clock";

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
  return (
    <section className="review-sheet" aria-label="What happened last turn">
      <header className="review-head">
        <div>
          <h2>{plan.title}</h2>
          <p className="muted">
            {plan.ordered === 0
              ? "No orders were given."
              : plan.succeeded + " of " + plan.ordered + " orders came off."}
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
          <li key={row.province} className={row.failed ? "review-row failed" : "review-row"}>
            <span className="dot" style={{ background: powerColor(row.power) }} />
            <span className="order-text">{row.text}</span>
            {row.failed ? <span className="review-why">{row.reason}</span> : null}
          </li>
        ))}
      </ul>

      <div className="review-actions">
        <button type="button" className="primary" onClick={onClose}>
          Close review
        </button>
        {/* The same phase, told as physical acts, for whoever is moving the
            pieces on the real board. */}
        {onReferee ? (
          <button type="button" onClick={onReferee}>
            Referee guide
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
