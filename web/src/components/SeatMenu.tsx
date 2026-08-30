import { useState } from "react";

import { type Handover, type SeatClient } from "../api";
import { powerColor } from "../board/provinces";
import { LinkShare } from "./LinkShare";
import { ModalLayer } from "./ModalLayer";

/*
The seat's own menu (D-041).

Every seat carries a player icon. Tapping it opens this: what the seat is, and
the one thing that can be done with it. It is deliberately short — a player
looking at their own phone mid-negotiation wants the board back, not a settings
screen.

What it says: the power, how many turns have been played, how long the game has
run. What it does: hand this power to somebody else. The next person scans the
code and the power is theirs, and this phone's seat dies the moment they do.

The link is minted on opening rather than held on the page, so a menu left open
never shows a code that has already been used.
*/
export function SeatMenu({
  power,
  turns,
  createdAt,
  seat,
}: {
  power: string;
  turns?: number;
  createdAt?: string;
  seat: SeatClient;
}) {
  const [open, setOpen] = useState(false);
  const [link, setLink] = useState<Handover | null>(null);
  const [error, setError] = useState<string | null>(null);

  const show = () => {
    setOpen(true);
    setLink(null);
    setError(null);
    seat
      .handover()
      .then(setLink)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  };

  return (
    <>
      <button
        type="button"
        className="seat-menu-button"
        onClick={show}
        title={"The " + power + " seat"}
        aria-label={"The " + power + " seat"}
      >
        <span className="dot" style={{ background: powerColor(power) }} />
        <PlayerIcon />
      </button>

      {open ? (
        <ModalLayer onClose={() => setOpen(false)}>
          <section className="seat-menu">
            <header>
              <p className="you-are-label">This seat</p>
              <p className="seat-menu-power">{power}</p>
              <p className="muted">
                {turns === undefined ? "" : turns + (turns === 1 ? " turn" : " turns") + " played"}
                {turns !== undefined && createdAt ? " · " : ""}
                {createdAt ? elapsed(createdAt) : ""}
              </p>
            </header>

            {error ? <p className="error">{error}</p> : null}
            {link ? (
              <LinkShare
                title="Hand this power to somebody else"
                url={link.url}
                note={
                  <>
                    The next person scans this and {power} is theirs. This phone loses the
                    seat the moment they do, so do not scan it yourself.
                  </>
                }
              />
            ) : error ? null : (
              <p className="muted">Making a link…</p>
            )}

            <button type="button" className="primary" onClick={() => setOpen(false)}>
              Close
            </button>
          </section>
        </ModalLayer>
      ) : null}
    </>
  );
}

/* How long the game has been running, in the coarsest unit that is still
   true. Nobody at a table wants "2h 14m 09s"; they want to know whether this
   has been going an hour or all afternoon. */
function elapsed(createdAt: string): string {
  const since = Date.now() - new Date(createdAt).getTime();
  if (!Number.isFinite(since) || since < 0) return "";
  const minutes = Math.floor(since / 60000);
  if (minutes < 60) return "running " + Math.max(minutes, 1) + " min";
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return "running " + hours + (hours === 1 ? " hour" : " hours");
  const days = Math.floor(hours / 24);
  return "running " + days + (days === 1 ? " day" : " days");
}

/* Drawn rather than lettered, for the same reason the board's marks are: it
   sits at 18px beside a coloured dot and has to stay legible there. */
function PlayerIcon() {
  return (
    <svg className="seat-menu-icon" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="8" r="4" />
      <path d="M4.5 20a7.5 7.5 0 0 1 15 0" />
    </svg>
  );
}
