import { powerColor } from "../board/provinces";
import type { RefereeGuide as Guide } from "../referee";

/*
The screen for whoever pushes the pieces.

It is not a summary of the turn — the review is that. It is a list of hands-on
acts, grouped the way a pair of hands does them, in type big enough to read
from across a table while looking mostly at the board. One line is one act, and
every line is a whole spoken sentence, because at a real table this is read
aloud: "Move Army Vienna to Trieste."

It covers the map on purpose. A piece pusher working through it is not also
reading the map, and a half-covered list is how a unit gets missed.
*/
export function RefereeGuide({
  guide,
  onClose,
}: {
  guide: Guide;
  onClose: () => void;
}) {
  return (
    <section className="referee" aria-label="Move the pieces">
      <header className="referee-head">
        <div>
          <h2>Move the pieces</h2>
          <p className="muted">
            {guide.title} ·{" "}
            {guide.total === 0
              ? "no pieces to touch"
              : guide.total === 1
                ? "1 piece to touch"
                : guide.total + " pieces to touch"}
          </p>
        </div>
        <button type="button" onClick={onClose}>
          Close guide
        </button>
      </header>

      {guide.sections.length === 0 ? (
        <p className="referee-empty">Nothing on the board moves. Deal the next phase.</p>
      ) : (
        guide.sections.map((section) => (
          <section key={section.id} className={"referee-group " + section.id}>
            <h3>{section.title}</h3>
            <ol className="referee-list">
              {section.actions.map((action) => (
                <li key={action.id}>
                  <span className="dot" style={{ background: powerColor(action.power) }} />
                  <span className="referee-text">
                    {action.text}
                    {action.note ? <span className="referee-note"> — {action.note}</span> : null}
                  </span>
                </li>
              ))}
            </ol>
          </section>
        ))
      )}

      <p className="note">
        Read it down the list. Every line is one act on the physical board.
      </p>
    </section>
  );
}
