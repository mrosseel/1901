import { useState } from "react";

import { type Handover, type SeatClient } from "../api";
import { readSeatSeed, seatLink, withSeed } from "../seatkey";
import { LinkShare } from "./LinkShare";
import { PowerChip } from "./PowerChip";
import { ModalLayer } from "./ModalLayer";

/*
The seat's own menu (ADR-041).

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
  gameId,
  power,
  turns,
  createdAt,
  isGameMaster,
  seat,
}: {
  gameId: string;
  power: string;
  turns?: number;
  createdAt?: string;
  /* A game master who plays holds two things at once, and they are handed on
     separately (ADR-041). Their menu shows both codes; everybody else's shows
     the one they have. */
  isGameMaster?: boolean;
  seat: SeatClient;
}) {
  const [open, setOpen] = useState(false);
  /* The seat's own address, rebuilt from the seed this device holds (ADR-049).
     It is the portable copy: a second device, or a phone passed round the
     table, opens the same seat rather than taking it from anybody. */
  const [portable, setPortable] = useState<string | null>(null);
  const [link, setLink] = useState<Handover | null>(null);
  const [role, setRole] = useState<Handover | null>(null);
  const [error, setError] = useState<string | null>(null);

  const show = () => {
    setOpen(true);
    setLink(null);
    setRole(null);
    setError(null);
    const fail = (err: unknown) => setError(err instanceof Error ? err.message : String(err));
    const seed = seat.keyed ? readSeatSeed(gameId) : null;
    setPortable(seed ? seatLink(gameId, seed) : null);
    /*
    The handover carries this seat's seed, appended here and never by the
    server (ADR-004). The taking phone derives this phase's order key from it,
    then makes a fresh signing seed for the seat. Keeping those jobs separate
    preserves locked orders without leaving this device able to sign back in.

    A game master minting a link for a dead phone cannot do this. The server
    has no seed, and that link still costs the locked orders.
    */
    seat
      .handover()
      .then((made) => setLink(seed ? { ...made, url: withSeed(made.url, seed) } : made))
      .catch(fail);
    if (isGameMaster) seat.roleHandover().then(setRole).catch(fail);
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
        <PowerChip power={power} />
        <PlayerIcon />
      </button>

      {open ? (
        <ModalLayer onClose={() => setOpen(false)}>
          <section className="seat-menu">
            <header>
              <p className="you-are-label">This seat</p>
              <p className="seat-menu-power">
                <PowerChip power={power} />
              </p>
              <p className="muted">
                {turns === undefined
                  ? ""
                  : turns + (turns === 1 ? " phase resolved" : " phases resolved")}
                {turns !== undefined && createdAt ? " · " : ""}
                {createdAt ? elapsed(createdAt) : ""}
              </p>
            </header>

            {error ? <p className="error">{error}</p> : null}
            <div className="handovers">
              {link ? (
                <LinkShare
                  title={isGameMaster ? "Your power · " + power : "Move this seat to another device"}
                  url={link.url}
                  note={
                    <>
                      The next person scans this and {power} is theirs, orders and all,
                      including any you have already locked in. This phone loses the seat
                      the moment they do, so do not scan it yourself.
                    </>
                  }
                />
              ) : error ? null : (
                <p className="muted">Making a link…</p>
              )}
              {isGameMaster && role ? (
                <LinkShare
                  title="The game master role"
                  url={role.url}
                  note={
                    <>
                      Whoever opens this runs the game: the deadline, the start, forcing a
                      phase. You keep {power} and stop being the game master.
                    </>
                  }
                />
              ) : null}
            </div>

            {/*
            The spare copy, and the only way back from a dead phone (ADR-004).

            Your orders are sealed on the server under a key this seat makes.
            Scan this onto a second device and that device makes the same key,
            so it can release orders this phone locked in and can no longer
            send. A phone that dies without this taking its power with it is
            what the note has to say, because nobody opens this menu twice.
            */}
            {portable ? (
              <LinkShare
                private
                title="Back up or open this seat on another device"
                url={portable}
                note={
                  <>
                    Scan this now, onto anything you can reach later. Both devices then
                    play {power}, and if this phone dies your locked orders still count.
                    Without it they do not. The key is after the # and no server ever
                    sees it.
                  </>
                }
              />
            ) : null}

            {/* The way out, and back. The seat page has no bar of its own —
                the map wants every pixel — so the links live here, one tap
                from the board (ADR-043). */}
            <nav className="seat-menu-links">
              <a href="/games">All games</a>
              <a href="/faq">Questions</a>
              <a href="/">About 1901</a>
            </nav>

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
