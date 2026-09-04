import { useEffect, useState } from "react";
import { powerColor } from "../board/provinces";
import type { RefereeGuide as Guide } from "../referee";

/*
The screen for whoever pushes the pieces.

It is not a summary of the turn — the review is that. It is a checklist of
hands-on acts, grouped the way a pair of hands does them, in type big enough to
read from across a table while looking mostly at the board. One line is one act,
and every line is a whole spoken sentence, because at a real table this is read
aloud: "Move Army Vienna to Trieste."

Ticking is the point. A piece pusher gets interrupted mid-turn, and the tick is
what tells them where they stopped. The pieces that stay put carry no tick,
because they are the answer to "and the rest?" rather than work to do.

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
  const [done, setDone] = useState<ReadonlySet<string>>(new Set());

  // A new phase is a new set of pieces to touch, so the ticks start over.
  useEffect(() => setDone(new Set()), [guide.title]);

  function toggle(id: string) {
    setDone((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }

  const doneCount = guide.sections
    .filter((section) => section.id !== "stays")
    .reduce(
      (count, section) =>
        count + section.actions.filter((action) => done.has(action.id)).length,
      0,
    );
  const allDone = guide.total > 0 && doneCount === guide.total;

  return (
    <section className="referee" aria-label="Move the pieces">
      <header className="referee-head">
        <div>
          <h2>Move the pieces</h2>
          <p className="muted">
            {guide.title} ·{" "}
            {guide.total === 0
              ? "no pieces to touch"
              : allDone
                ? guide.total === 1
                  ? "1 piece done"
                  : "all " + guide.total + " done"
                : doneCount + " of " + guide.total + " done"}
          </p>
        </div>
        <button type="button" onClick={onClose}>
          Close guide
        </button>
      </header>

      {guide.sections.length === 0 ? (
        <p className="referee-empty">Nothing on the board moves. The next phase is already open.</p>
      ) : (
        guide.sections.map((section) => (
          <section key={section.id} className={"referee-group " + section.id}>
            <h3>{section.title}</h3>
            <ol className="referee-list">
              {section.actions.map((action) =>
                section.id === "stays" ? (
                  <li key={action.id}>
                    <span className="dot" style={{ background: powerColor(action.power) }} />
                    <span className="referee-text">
                      {action.text}
                      {action.note ? <span className="referee-note"> · {action.note}</span> : null}
                    </span>
                  </li>
                ) : (
                  <li key={action.id} className={done.has(action.id) ? "is-done" : undefined}>
                    <label className="referee-tick">
                      <input
                        type="checkbox"
                        checked={done.has(action.id)}
                        onChange={() => toggle(action.id)}
                      />
                      <span className="dot" style={{ background: powerColor(action.power) }} />
                      <span className="referee-text">
                        {action.text}
                        {action.note ? <span className="referee-note"> · {action.note}</span> : null}
                      </span>
                    </label>
                  </li>
                ),
              )}
            </ol>
          </section>
        ))
      )}

      <p className="note">
        {allDone
          ? "Every piece is where it should be. Close the guide; the next phase is already open."
          : "Tick each line as you do it on the physical board."}
      </p>
    </section>
  );
}
