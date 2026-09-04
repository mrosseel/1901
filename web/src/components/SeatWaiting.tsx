import type { CSSProperties } from "react";
import type { SeatState } from "../api";
import { powerColor } from "../board/provinces";
import { seatTone } from "../gamelist";
import { settingsLines } from "../hooks";
import { ruleLines } from "../rules";
import { useFixEnabled } from "@mrosseel/page-comments/fixes";
import { SupportedMark } from "./SupportedMark";
import { VariantNote } from "./VariantNote";

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
export function SeatWaiting({
  state,
  beat,
  connected,
}: {
  state: SeatState | null;
  beat: number;
  connected: boolean;
}) {
  // c003: the map carries the review note somebody wrote, not a green tick.
  const noteInsteadOfTick = useFixEnabled("c003");
  // c006: the review note belongs to the variant gallery alone, not to a
  // running game.
  const noteGoneHere = useFixEnabled("c006");
  // c004: "At the table" names a room. Most games have no room, so the heading
  // names what the section actually lists.
  const seatsHeading = useFixEnabled("c004");
  // c005: the seat count reads as large figures, and the rules as a bullet
  // list, in the design the map pane used to carry before the game started.
  const bigBrief = useFixEnabled("c005");
  const power = state?.you?.power || "";
  const claimed = state?.joinedCount ?? 0;
  const onOffer = state?.seatsOnOffer ?? 0;
  const full = onOffer > 0 && claimed >= onOffer;
  const filled = onOffer > 0 ? Math.min(100, Math.round((claimed / onOffer) * 100)) : 0;

  return (
    <>
      <header className="seat-head">
        {/*
        The card is washed in the power's own colour so a player can match it
        to their pieces across the table. The wash and not the letters, because
        a power's colour is chosen to be told apart on a map and several of
        them cannot carry text at any size.

        The disc beside it is the colour at full strength, drawn the size and
        shape of a unit marker, so the match to the board is exact rather than
        approximate.
        */}
        <div
          className="you-are"
          style={
            {
              borderLeftColor: powerColor(power),
              "--power": powerColor(power),
            } as CSSProperties
          }
        >
          <span className="you-are-piece" aria-hidden="true" />
          <div>
            <p className="you-are-label">You are</p>
            <p className="you-are-power">{power || "…"}</p>
          </div>
        </div>
        {/* What the table calls this game, when it was named. It answers "what
            game is this" — the name of a table, never of a person, so it says
            nothing about who holds which power (ADR-020). */}
        {state?.settings?.name ? <p className="game-name">{state.settings.name}</p> : null}
        {state?.variant ? (
          <p className="muted variant-line">
            <strong>{state.variant.name}</strong>
            {noteGoneHere ? null : (
              <>
                {" "}
                {noteInsteadOfTick ? (
                  <VariantNote note={state.variant.note} />
                ) : (
                  <SupportedMark supported={state.variant.supported} />
                )}
              </>
            )}
          </p>
        ) : null}
      </header>

      <section className="waiting-table">
        <div className="list-head">
          <h2>{seatsHeading ? "Seats" : "At the table"}</h2>
          {/*
          A connected socket keeps the dot alive. During fallback polling the
          element is replaced on every answer, so a poll that has died leaves
          a stopped dot rather than a timer beating over a dead line.
          */}
          <span className="live" key={connected ? "socket" : beat}>
            <span className={`live-dot${connected ? " live-dot-connected" : ""}`} />
            Live
          </span>
        </div>
        {/* Which powers are taken is not said, here or anywhere: the table
            has no names in it (ADR-020), and before the start the powers still
            free are the pool the game master's own is drawn from (ADR-021). */}
        {bigBrief ? (
          <p className={"seat-figures " + seatTone(claimed, onOffer)}>
            <span className="seat-figures-count">
              {claimed} of {onOffer}
            </span>
            <span className="seat-figures-label">powers claimed</span>
          </p>
        ) : (
          <p className="seat-count">
            {claimed} of {onOffer} powers claimed
          </p>
        )}
        <div
          className="seat-bar"
          role="img"
          aria-label={claimed + " of " + onOffer + " powers claimed"}
        >
          <span style={{ width: filled + "%" }} />
        </div>
        {/* The figures above already say whether every power is claimed
            (c008), so this line only says what happens next, at a size that
            carries across the room on its own. */}
        <p className={bigBrief ? "next next-big" : "next"}>
          {bigBrief
            ? full
              ? "Waiting for the game master to start the game."
              : "Waiting for every power to join."
            : full
              ? "Every power is claimed. The game master starts the game."
              : "The game master starts the game once every power is claimed."}
        </p>
      </section>

      {/* The same rules, in the same words, as the page that offered the
          power — a player who tapped through that one now has the minutes to
          read them (ADR-022). */}
      <section>
        <h2>The rules of this game</h2>
        {/* One fact per bullet, so the rules can be scanned rather than read
            through. */}
        {bigBrief ? (
          <ul className="seat-rules">
            {ruleLines(state?.settings, state?.variant?.name).map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        ) : (
          settingsLines(state?.settings).map((line) => (
            <p key={line} className="rule">
              {line}
            </p>
          ))
        )}
      </section>
    </>
  );
}
