import { useState } from "react";
import { createGame, type CreatedGame } from "../api";
import { LinkShare } from "../components/LinkShare";

/*
The first screen: the GM sets the two rules that exist today and gets back the
two links that run the game. The GM link is a secret and is the only way back
into the controls, so the warning sits right next to it.
*/
export function NewGame() {
  const [deadlineMinutes, setDeadlineMinutes] = useState(15);
  const [gmPlays, setGmPlays] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [game, setGame] = useState<CreatedGame | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const created = await createGame({
        deadlineMinutes: Math.max(0, Math.floor(deadlineMinutes) || 0),
        gmPlays: gmPlays,
      });
      setGame(created);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (game) {
    const gmUrl =
      game.gmUrl || new URL("/game/" + game.gameId + "/gm/" + game.gmToken + "/", location.origin).toString();
    const inviteUrl = new URL(game.inviteUrl, location.href).toString();
    return (
      <main className="page">
        <h1>The game is ready</h1>
        <p className="lead">Game {game.gameId}.</p>

        <LinkShare
          title="Your game master link"
          url={gmUrl}
          qr={false}
          note={
            <>
              <strong>Bookmark this link now.</strong> It is the only way back to the
              controls, it is not shown again, and anyone who has it runs the game.
            </>
          }
        />

        <LinkShare
          title="Invite link"
          url={inviteUrl}
          note="Pass the phone around, or let the players scan this. Each one gets a power."
        />

        <p>
          <a className="cta" href={gmUrl}>
            Open the game master page
          </a>
        </p>
      </main>
    );
  }

  return (
    <main className="page">
      <h1>New game</h1>
      <p className="lead">Classical Diplomacy, seven powers, one table.</p>
      <form className="card" onSubmit={submit}>
        <label className="field">
          <span>Minutes for each phase</span>
          <input
            type="number"
            min={0}
            max={1440}
            inputMode="numeric"
            value={deadlineMinutes}
            onChange={(event) => setDeadlineMinutes(Number(event.target.value))}
          />
          <small>Zero runs the game with no deadline.</small>
        </label>

        <label className="field check">
          <input
            type="checkbox"
            checked={gmPlays}
            onChange={(event) => setGmPlays(event.target.checked)}
          />
          <span>I play a power as well</span>
          <small>One power is held back for you and revealed when the game starts.</small>
        </label>

        {error ? <p className="error">{error}</p> : null}

        <button type="submit" className="primary" disabled={busy}>
          {busy ? "Creating…" : "Create the game"}
        </button>
      </form>
    </main>
  );
}
