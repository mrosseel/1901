import { useState } from "react";
import { TopBar } from "../components/TopBar";
import { claimSeat, fetchPublic, type PublicState } from "../api";
import { countdown, settingsLines, usePoll, useTicker } from "../hooks";
import { makeSeatSeed, seatPublicKey, writeSeatSeed } from "../seatkey";
import { SupportedMark } from "../components/SupportedMark";
import { noteServerTime } from "../clock";

/*
What a player sees after scanning the invite: the rules first, then one button.
The claim is never automatic — a player who is only looking must not take a
power. A device that already holds one gets the same board back.
*/
export function JoinPage({
  gameId,
  inviteToken,
}: {
  gameId: string;
  inviteToken: string;
}) {
  const [game, setGame] = useState<PublicState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  usePoll(3000, async () => {
    const next = await fetchPublic(gameId);
    noteServerTime(next.now);
    setGame(next);
  });
  useTicker(Boolean(game?.deadlineAt));

  const claim = async () => {
    setBusy(true);
    setError(null);
    try {
      // This device makes the seat's key before it asks for a power, and
      // sends only the public half (D-049). The seed is written here, one
      // step before the board opens, so a refused claim leaves nothing
      // behind.
      const seed = makeSeatSeed();
      const seat = await claimSeat(gameId, inviteToken, seatPublicKey(seed));
      if (seat.keyed) writeSeatSeed(gameId, seed);
      // The board replaces this page: the back button must not lead to a
      // second claim.
      location.replace(new URL(seat.seatUrl, location.href).toString());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  const full = Boolean(game && game.joinedCount >= game.totalSeats);

  return (
    <>
      <TopBar />
      <main className="page">
        <h1>Join the game</h1>
        {/* The name tells a player which table this link belongs to, which is
          worth knowing before claiming a power on it. It names the table and
          nothing else, so the seats stay anonymous (D-020). */}
        {game?.settings?.name ? (
          <p className="game-name">{game.settings.name}</p>
        ) : null}
        <p className="lead">
          Game {gameId}. You are given a power at random when you claim.
        </p>

        <section className="card">
          <h2>The rules of this game</h2>
          {/* The variant comes before the rules: a player is claiming a power
            on this board, so its name is the first thing to read. */}
          {game?.variant ? (
            <p className="variant-line">
              <strong>{game.variant.name}</strong>{" "}
              <SupportedMark supported={game.variant.supported} />
            </p>
          ) : null}
          {settingsLines(game?.settings).map((line) => (
            <p key={line}>{line}</p>
          ))}
          {game ? (
            <p className="muted">
              {game.joinedCount} of {game.totalSeats} powers claimed
              {game.started ? " · the game has started" : ""}
              {game.deadlineAt ? " · " + countdown(game.deadlineAt) : ""}
            </p>
          ) : (
            <p className="muted">Reading the game…</p>
          )}
        </section>

        {error ? <p className="error">{error}</p> : null}

        {/* The button stays live even when every power is taken: a phone that
          already holds one is sent back to its own board by the same call. */}
        <button
          type="button"
          className="primary"
          onClick={claim}
          disabled={busy}
        >
          {busy ? "Claiming…" : full ? "Open my board" : "Claim a power"}
        </button>
        <p className="note">
          Already claimed on this phone? The same button takes you back to your
          own board.
        </p>
      </main>
    </>
  );
}
