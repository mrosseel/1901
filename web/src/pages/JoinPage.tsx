import { useState } from "react";
import { TopBar } from "../components/TopBar";
import { claimSeat, fetchPublic, type PublicState } from "../api";
import { countdown, settingsLines, usePoll, useTicker } from "../hooks";
import { makeSeatSeed, readSeatSeed, seatPublicKey, writeSeatSeed } from "../seatkey";
import { SupportedMark } from "../components/SupportedMark";
import { noteBuild } from "../build";
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
    noteBuild(next.build);
    setGame(next);
  });
  useTicker(Boolean(game?.deadlineAt));

  const claim = async () => {
    setBusy(true);
    setError(null);
    try {
      // A returning keyed seat does not claim again. This works after the
      // device cookie or in-memory session is gone: /seat/me challenges the
      // key this browser still holds and opens a fresh session.
      const existing = readSeatSeed(gameId);
      if (existing) {
        location.replace("/game/" + encodeURIComponent(gameId) + "/seat/me");
        return;
      }
      // This device makes the seat's key before it asks for a power, and
      // sends only the public half (ADR-049). The seed is written here, one
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
  const heldHere = Boolean(readSeatSeed(gameId));

  return (
    <>
      <TopBar />
      <main className="page">
        <h1>Join the game</h1>
        {/* The name tells a player which table this link belongs to, which is
          worth knowing before claiming a power on it. It names the table and
          nothing else, so the seats stay anonymous (ADR-020). */}
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

        <button
          type="button"
          className="primary"
          onClick={claim}
          disabled={busy || (full && !heldHere)}
        >
          {busy
            ? "Claiming…"
            : full
              ? heldHere ? "Open my board" : "All powers claimed"
              : heldHere ? "Open my board" : "Claim a power"}
        </button>
        <p className="note">
          {heldHere
            ? "This phone already holds a seat key for the game."
            : full
              ? "Use the original phone, a seat backup link, or ask the game master for a replacement link."
              : "A new seat is bound to this browser. Back it up from the seat menu if you may change devices."}
        </p>
      </main>
    </>
  );
}
