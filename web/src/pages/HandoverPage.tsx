import { useState } from "react";
import { TopBar } from "../components/TopBar";

import { claimGmHandover, claimHandover } from "../api";

/*
The page a handover QR code opens (D-041).

Everything needed to take the seat is in the address, so this page's whole job
is to ask before it acts. It must not claim on load: a link preview, a scanner
that fetches the URL before it shows it, or a chat client unfurling the address
would otherwise take the power for nobody and strand the phone still holding
it. So there is a button, and the button is the only thing that posts.

Taking the seat kills the previous holder's token. The page says so in the
words the moment needs, because the person reading it is usually standing next
to whoever is about to lose it.
*/
export function HandoverPage({
  gameId,
  power,
  epoch,
  signature,
}: {
  gameId: string;
  /* The power being handed over, or null for the game master role. They are
     one page because the moment is the same — read this, then press once —
     and two acts because what travels is different (D-041). */
  power: string | null;
  epoch: string;
  signature: string;
}) {
  const [taking, setTaking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const take = async () => {
    setTaking(true);
    setError(null);
    try {
      if (power === null) {
        const gm = await claimGmHandover(gameId, epoch, signature);
        window.location.href = gm.gmUrl;
      } else {
        const seat = await claimHandover(gameId, power, epoch, signature);
        window.location.href = seat.seatUrl;
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
      setTaking(false);
    }
  };

  if (power === null) {
    return (
      <>
        <TopBar />
        <main className="page">
          <h1>Take the game master role</h1>
          <section className="card">
            <p>
              This link makes you the game master of game {gameId}. You set the
              deadline, start the game, force a phase when the room is waiting
              on one person, and hand out seats.
            </p>
            <p className="note">
              The rights travel; a power does not. Whoever runs the game now
              stops being able to, and keeps whatever power they play.
            </p>
            {error ? <p className="error">{error}</p> : null}
            <p>
              <button
                type="button"
                className="primary"
                onClick={take}
                disabled={taking}
              >
                {taking ? "Taking the role…" : "Take the game master role"}
              </button>
            </p>
          </section>
        </main>
      </>
    );
  }

  return (
    <>
      <TopBar />
      <main className="page">
        <h1>Take the {power} seat</h1>
        <section className="card">
          <p>
            This link hands you {power} in game {gameId}. The orders already
            given stand, and you may change them while the phase is open.
          </p>
          <p className="note">
            The phone that holds {power} now loses it the moment you take it. A
            power belongs to one person at a time.
          </p>
          {error ? <p className="error">{error}</p> : null}
          <p>
            <button
              type="button"
              className="primary"
              onClick={take}
              disabled={taking}
            >
              {taking ? "Taking the seat…" : "Take " + power}
            </button>
          </p>
        </section>
      </main>
    </>
  );
}
