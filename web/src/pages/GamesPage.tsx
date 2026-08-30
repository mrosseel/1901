import { useEffect, useState } from "react";
import { fetchGames, refereePath, watchPath, type GameSummary } from "../api";
import { phaseLabel } from "../board/provinces";
import { usePoll } from "../hooks";
import { SupportedMark } from "../components/SupportedMark";

/*
The front door. Every game the server holds, the ones being played and the
ones waiting for their table. The list carries public facts only: an id here
opens the spectator view, never a seat or the controls. The referee link
appears only on the browser that created the game, and works only there.
*/
export function GamesPage() {
  const [games, setGames] = useState<GameSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchGames()
      .then(setGames)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  usePoll(5000, () => {
    fetchGames()
      .then((next) => {
        setGames(next);
        setError(null);
      })
      .catch(() => {
        // A quiet poll failure keeps the last list on screen.
      });
  });

  const playing = (games || []).filter((game) => game.started);
  const waiting = (games || []).filter((game) => !game.started);

  return (
    <main className="page">
      <h1>1901</h1>
      <p className="lead">
        The games on this server. Players join with the invite link a game master
        hands out.
      </p>
      <p>
        <a className="cta" href="/new">
          New game
        </a>
      </p>

      {error ? <p className="error">{error}</p> : null}
      {games && games.length === 0 && !error ? (
        <p className="muted">No games yet. Create the first one.</p>
      ) : null}

      {playing.length ? (
        <section className="card">
          <h2>In progress</h2>
          <ul className="list">
            {playing.map((game) => (
              <GameRow key={game.gameId} game={game} />
            ))}
          </ul>
        </section>
      ) : null}

      {waiting.length ? (
        <section className="card">
          <h2>Setting up</h2>
          <ul className="list">
            {waiting.map((game) => (
              <GameRow key={game.gameId} game={game} />
            ))}
          </ul>
        </section>
      ) : null}
    </main>
  );
}

function GameRow({ game }: { game: GameSummary }) {
  return (
    <li>
      <div className="row-main">
        {/* The name is what a game master reads first when two tables are
            running; the id stays on the row, because it is the address and an
            unnamed game has nothing else. */}
        <strong>{game.name || game.gameId}</strong>
        <span className="muted">
          {game.name ? game.gameId + " · " : ""}
          {game.variant ? game.variant.name : ""}
          {game.variant ? <SupportedMark supported={game.variant.supported} /> : null}
          {" · "}
          {game.started ? phaseLabel(game.phase) : "waiting to start"}
          {" · "}
          {game.joinedCount} of {game.totalSeats} seated
          {game.started && game.turns ? " · " + game.turns + " turn(s) played" : ""}
        </span>
      </div>
      <span className="row-actions">
        <a className="link" href={watchPath(game.gameId, null)}>
          Watch
        </a>
        {game.referee ? (
          <a className="link" href={refereePath(game.gameId)}>
            Game master view
          </a>
        ) : null}
      </span>
    </li>
  );
}
