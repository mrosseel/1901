import { useState } from "react";

import { copyText } from "../clipboard";
import { readSeatSeed, seatLink } from "../seatkey";

/*
The one thing a player has to do before the game starts (ADR-004).

Your orders are sealed on the server under a key this phone makes. If the
phone dies after you lock in, nothing else can release them and your power
takes an NMR. A second device holding the same seat opens the same key, so a
copy of this seat is the whole of the insurance.

The copy already exists, in the power menu, with its QR code. What it did not
have was a moment: nobody opens a menu they have no question about. So this
asks once, at the start, and then goes away for good.

**Copy it or bookmark it.** Both work, and the address is drawn so the second
one can be done at all: a browser bookmarks a link it is given, and this is the
only place the player is given one.

What does not work is opening the link and then bookmarking the board. The key
rides after the `#`, and the seat page takes it out of the address bar as it
loads (ADR-049), so that bookmark would hold nothing. The note says so, because
it is the mistake this card would otherwise cause.

It is dismissed per game and per device, in the same storage the seat seed
lives in. A player who clears that has lost the seat anyway.
*/

const STORE_PREFIX = "1901.keep.";

function asked(gameId: string): boolean {
  try {
    return window.localStorage.getItem(STORE_PREFIX + gameId) === "done";
  } catch {
    return false;
  }
}

function markAsked(gameId: string): void {
  try {
    window.localStorage.setItem(STORE_PREFIX + gameId, "done");
  } catch {
    // A phone with no storage is asked again next load, which is the right
    // way round: the prompt is cheap and losing the seat is not.
  }
}

export function KeepYourSeat({ gameId, power }: { gameId: string; power: string }) {
  const [seed] = useState(() => readSeatSeed(gameId));
  const [done, setDone] = useState(() => asked(gameId));
  const [said, setSaid] = useState<string | null>(null);

  /* A seat that holds a token instead of a key has nothing portable to keep
     (ADR-049). That is the game master's own seat, and its screen is the one
     with the controls on it. */
  if (!seed || done) return null;

  const copy = async () => {
    if (await copyText(seatLink(gameId, seed))) {
      // Copied is done. The card stays up so the player reads the line below
      // it, and it does not come back on the next load.
      markAsked(gameId);
      setSaid("Copied. Paste it somewhere you can reach from another device.");
      return;
    }
    setSaid("Copy failed. Open the " + power + " menu and use the QR code instead.");
  };

  const dismiss = () => {
    markAsked(gameId);
    setDone(true);
  };

  return (
    <section className="card keep-seat">
      <h2>Keep this seat</h2>
      <p>
        Your orders are sealed with a key that lives on this phone. Keep a copy of the
        seat somewhere else now. If this phone dies, that copy is what lets you finish
        the turn you locked in.
      </p>
      {/* Drawn, because a bookmark needs a link to be made from. This is the
          player's own screen and never the one on the beamer. */}
      <a className="share-url keep-seat-url" href={seatLink(gameId, seed)}>
        {seatLink(gameId, seed)}
      </a>
      <div className="keep-seat-actions">
        <button type="button" onClick={copy}>
          Copy this seat
        </button>
        <button type="button" className="link" onClick={dismiss}>
          Not now
        </button>
      </div>
      {said ? <p className="note">{said}</p> : null}
      <p className="note">
        Copy it into a note, or bookmark the link above. Do not open it and then
        bookmark the board: the key is taken out of the address as the board loads, so
        that bookmark would hold nothing. The same seat, as a QR code, is always in
        the {power} menu.
      </p>
    </section>
  );
}
