import type { SeatState } from "../api";
import { powerColor } from "../board/provinces";
import { settingsLines } from "../hooks";
import { SupportedMark } from "./SupportedMark";

/*
The panel a player sits on between scanning the code and the first phase.

It is the first thing anyone sees of this app, and it can be on screen for
several minutes while the rest of the table arrives. So it answers the four
questions a person has at that moment, in the order they ask them: who am I,
who else is here, what game is this, and what happens next.

Nothing here can be acted on, and nothing here pretends to be. The panel
carries no button at all: the only act left before the game starts belongs to
the game master, and a control a player cannot use is a control they will try.

The power takes the size the phase line takes once the game is running. Before
the start there is no phase — the board is set up and nobody has played on it —
and the power a player has just been dealt at random is the whole of what this
screen is about.
*/
export function SeatWaiting({ state, beat }: { state: SeatState | null; beat: number }) {
  const power = state?.you?.power || "";
  const claimed = state?.joinedCount ?? 0;
  const onOffer = state?.seatsOnOffer ?? 0;
  const full = onOffer > 0 && claimed >= onOffer;
  const filled = onOffer > 0 ? Math.min(100, Math.round((claimed / onOffer) * 100)) : 0;

  return (
    <>
      <header className="seat-head">
        {/* The border, not the letters, carries the colour: a power's colour
            is chosen to be told apart on the map, not to be read as text. */}
        <div className="you-are" style={{ borderLeftColor: powerColor(power) }}>
          <p className="you-are-label">You are</p>
          <p className="you-are-power">{power || "…"}</p>
        </div>
        {state?.variant ? (
          <p className="muted variant-line">
            <strong>{state.variant.name}</strong>{" "}
            <SupportedMark supported={state.variant.supported} />
          </p>
        ) : null}
      </header>

      <section className="waiting-table">
        <div className="list-head">
          <h2>At the table</h2>
          {/*
          The one honest sign this page is not stuck. The element is replaced
          on every answer the server gives, which is what restarts the
          animation — a page whose polling has died shows a dot that has
          stopped, rather than a timer of its own beating over a dead line.
          */}
          <span className="live" key={beat}>
            <span className="live-dot" />
            Live
          </span>
        </div>
        {/* Which powers are taken is not said, here or anywhere: the table
            has no names in it (D-020), and before the start the powers still
            free are the pool the game master's own is drawn from (D-021). */}
        <p className="seat-count">
          {claimed} of {onOffer} powers claimed
        </p>
        <div
          className="seat-bar"
          role="img"
          aria-label={claimed + " of " + onOffer + " powers claimed"}
        >
          <span style={{ width: filled + "%" }} />
        </div>
        <p className="next">
          {full
            ? "Every power is claimed. The game master starts the game."
            : "The game master starts the game once every power is claimed."}
        </p>
      </section>

      {/* The same rules, in the same words, as the page that offered the
          power — a player who tapped through that one now has the minutes to
          read them (D-022). */}
      <section>
        <h2>The rules of this game</h2>
        {settingsLines(state?.settings).map((line) => (
          <p key={line} className="rule">
            {line}
          </p>
        ))}
      </section>
    </>
  );
}
