import { useState } from "react";

import { claimHandover } from "../api";

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
  power: string;
  epoch: string;
  signature: string;
}) {
  const [taking, setTaking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const take = async () => {
    setTaking(true);
    setError(null);
    try {
      const seat = await claimHandover(gameId, power, epoch, signature);
      window.location.href = seat.seatUrl;
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
      setTaking(false);
    }
  };

  return (
    <main className="page">
      <h1>Take the {power} seat</h1>
      <section className="card">
        <p>
          This link hands you {power} in game {gameId}. The orders already given stand, and
          you may change them while the phase is open.
        </p>
        <p className="note">
          The phone that holds {power} now loses it the moment you take it. A power belongs
          to one person at a time.
        </p>
        {error ? <p className="error">{error}</p> : null}
        <p>
          <button type="button" className="primary" onClick={take} disabled={taking}>
            {taking ? "Taking the seat…" : "Take " + power}
          </button>
        </p>
      </section>
    </main>
  );
}
