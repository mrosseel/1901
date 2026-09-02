import { useState } from "react";
import {
  replacementSeatSeed,
  seatPublicKey,
  seedInAddress,
  signAsSeat,
  writeSeatSeed,
} from "../seatkey";
import { inheritSealedOrderKey } from "../sealed";
import { chainBody } from "../press";
import { TopBar } from "../components/TopBar";

import { claimGmHandover, claimHandover } from "../api";

/*
The page a handover QR code opens (ADR-041).

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
     and two acts because what travels is different (ADR-041). */
  power: string | null;
  epoch: string;
  signature: string;
}) {
  const [taking, setTaking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const carriesOrders = power !== null && Boolean(seedInAddress());

  const take = async () => {
    setTaking(true);
    setError(null);
    try {
      if (power === null) {
        const gm = await claimGmHandover(gameId, epoch, signature);
        window.location.replace(gm.gmUrl);
      } else {
        /*
        The seat's own key, where the link carries one (ADR-004).

        A seat that has already locked in this phase has sealed its orders
        under a key derived from that seed. The taking phone retains only that
        phase's order key and makes a fresh signing seed of its own. Reusing
        the former signing seed would let the old device take the seat back.

        A link minted by the game master carries no seed, because the server
        has none. Then this makes one, and whatever that seat had locked in is
        beyond reach.
        */
        const formerSeed = seedInAddress();
        // Authentication must rotate even when the old seed travels with the
        // link. The old seed is retained only long enough to recover this
        // phase's envelope key; reusing it here would leave the former holder
        // able to sign back in after the handover.
        const seatSeed = replacementSeatSeed(formerSeed);
        /*
        The step from the old seat key to the new one, signed with the old one
        (ADR-056).

        Every device that had pinned the old key can follow this without
        asking anybody, which is what tells a real handover apart from a
        server inventing a key. A link the game master minted carries no
        former seed, so there is nothing to sign with and the table has to
        confirm the change out loud instead.
        */
        const newPub = seatPublicKey(seatSeed);
        const chainSig = formerSeed
          ? signAsSeat(
              formerSeed,
              chainBody(gameId, power, seatPublicKey(formerSeed), newPub),
            )
          : "";
        const seat = await claimHandover(gameId, power, epoch, signature, newPub, chainSig);
        if (seat.keyed) {
          writeSeatSeed(gameId, seatSeed);
          if (formerSeed && typeof seat.phaseIndex === "number") {
            inheritSealedOrderKey(gameId, seat.phaseIndex, formerSeed, seatSeed);
          }
        }
        window.location.replace(seat.seatUrl);
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
              deadline, start the game, force a phase after its deadline, and
              hand out replacement seats.
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
            This link hands you {power} in game {gameId}. {carriesOrders
              ? "The current locked orders travel with the seat, and you may change them while the phase is open."
              : "Orders kept only on the previous device cannot be recovered; you may enter new ones while the phase is open."}
          </p>
          <p className="note">
            The phone that holds {power} now loses it the moment you take it. A
            power belongs to one person at a time. Continue only for device recovery
            or a replacement allowed by your house or tournament rules.
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
