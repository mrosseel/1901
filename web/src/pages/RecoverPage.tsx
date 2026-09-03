import { useEffect, useState } from "react";
import { fetchGames, recoverChallenge, recoverClaim, refereePath, type GameSummary } from "../api";
import { phaseLabel } from "../board/provinces";
import { TopBar } from "../components/TopBar";
import { entropyFor, readStoredKey, signMessage, writeStoredKey } from "../gmkey";
import { gameIdInUrl, heldGames } from "../held";
import { readRecentGame } from "../recent";
import { readSeatSeed } from "../seatkey";

/*
Taking the game master role back with twelve words (ADR-048).

This is the only screen in the app somebody types a secret into, and it exists
because the role is the only thing here that cannot be handed back. Everything
else has a person on the other side: a lost seat is one link from the game
master, and a game master who is merely changing device hands the role over
(ADR-041). This is for the case where there is nobody to ask.

The words never leave the browser. They rebuild the key, the key signs a
sentence the server made up, and the signature is what the server checks
against the public half it was given when the key was made. What travels is 64
bytes that prove the words without carrying them.

Typing is the fallback, though, not the common case. A browser that was at a
table still holds that table's keys, so the list at the top of the page says so
and offers the door instead of the question.
*/

/** A game on this device, with whatever the server can tell us about it. */
interface HeldRow {
  gameId: string;
  /** The game's name, the recent note's label, or the bare id. */
  label: string;
  /** Where the game is, or why we cannot say. */
  detail: string;
  seat: boolean;
  /** A game master key is stored here, so the words are not needed. */
  gmKey: boolean;
  /** The server says this browser's cookie is the referee. */
  referee: boolean;
  /** The last address this device used, when nothing else opens the game. */
  recentUrl?: string;
}

function buildRows(games: GameSummary[] | null): HeldRow[] {
  const byId = new Map((games || []).map((game) => [game.gameId, game]));
  const rows: HeldRow[] = [];

  for (const held of heldGames()) {
    const game = byId.get(held.gameId);
    rows.push({
      gameId: held.gameId,
      label: game?.name || held.gameId,
      detail: !game
        ? "The server does not list this game."
        : game.started
          ? phaseLabel(game.phase)
          : "Waiting to start",
      seat: held.seat,
      gmKey: held.gameMaster,
      referee: Boolean(game?.referee),
    });
  }

  // The recent note is a URL, not a key, so it earns a row only when no key
  // already opens that game. Otherwise the same game would be on screen twice.
  const recent = readRecentGame();
  const recentId = recent ? gameIdInUrl(recent.url) : null;
  if (recent && recentId && !rows.some((row) => row.gameId === recentId)) {
    const game = byId.get(recentId);
    rows.push({
      gameId: recentId,
      label: game?.name || recent.label,
      detail: !game
        ? "The server does not list this game."
        : game.started
          ? phaseLabel(game.phase)
          : "Waiting to start",
      seat: false,
      gmKey: false,
      referee: Boolean(game?.referee),
      recentUrl: recent.url,
    });
  }

  return rows;
}

/** What this device has for a game, in the words the row uses. */
function holdings(row: HeldRow): string {
  const parts: string[] = [];
  if (row.seat) parts.push("seat");
  if (row.gmKey || row.referee) parts.push("game master");
  return parts.length ? parts.join(" and ") : "last game open here";
}

export function RecoverPage({ gameId }: { gameId: string | null }) {
  const [id, setId] = useState(gameId || "");
  const [words, setWords] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rows, setRows] = useState<HeldRow[]>([]);

  useEffect(() => {
    // The rows exist without the server: the keys are here. The names and the
    // referee mark are what the list adds, so they arrive a moment later.
    setRows(buildRows(null));
    fetchGames()
      .then((games) => setRows(buildRows(games)))
      .catch(() => {
        // An unreachable server still leaves every row openable by id.
      });
  }, []);

  const typed = words.trim().split(/\s+/).filter(Boolean).length;
  const ready = id.trim() !== "" && typed === 12;
  const playerId = id.trim();
  const heldSeat = playerId !== "" && Boolean(readSeatSeed(playerId));
  const anyStoredKey = rows.some((row) => row.gmKey && !row.referee);

  /*
  The recovery itself, once there is an entropy to sign with. The words form
  and the stored-key button differ only in where the sixteen bytes came from.
  */
  const recoverWith = async (game: string, entropy: Uint8Array) => {
    setError(null);
    setBusy(game);
    try {
      const challenge = await recoverChallenge(game);
      const { gmUrl } = await recoverClaim(
        game,
        challenge.nonce,
        signMessage(entropy, challenge.message),
      );
      // This device now holds the key, so it can show the words again and
      // the game master is not one lost tab from doing this a second time.
      // Keyed by the game the server answered for, never by what was typed.
      writeStoredKey(challenge.gameId, entropy);
      window.location.href = gmUrl;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(null);
    }
  };

  const recoverFromWords = () => {
    setError(null);
    const entropy = entropyFor(words);
    if (!entropy) {
      // The checksum is what catches this, and it catches it here rather
      // than after a round trip: a wrong word is a typo, not a rejection.
      setError("Those are not twelve words from the list. Check the spelling and the order.");
      return;
    }
    void recoverWith(id.trim(), entropy);
  };

  const recoverFromStoredKey = (game: string) => {
    const entropy = readStoredKey(game);
    if (!entropy) {
      setError("The game-master key for that game is no longer on this device.");
      return;
    }
    void recoverWith(game, entropy);
  };

  return (
    <>
      <TopBar />
      <main className="page">
        <h1>Return to a game</h1>
        <p className="lead">
          Reopen a seat held on this device, use a saved backup link on a new device,
          or recover the game-master role with its twelve words.
        </p>

        {error ? <p className="error">{error}</p> : null}

        <section className="card">
          <h2>Games on this device</h2>
          {rows.length === 0 ? (
            <p className="muted">This device holds no game.</p>
          ) : (
            <ul className="list held-list">
              {rows.map((row) => (
                <li key={row.gameId}>
                  <div className="row-main">
                    <strong>{row.label}</strong>
                    <span className="muted">Game {row.gameId}</span>
                    <span className="muted">
                      {holdings(row)}
                      {" · "}
                      {row.detail}
                    </span>
                  </div>
                  <span className="row-actions">
                    {row.seat ? (
                      <a
                        className="link"
                        href={"/game/" + encodeURIComponent(row.gameId) + "/seat/me"}
                      >
                        Open my seat
                      </a>
                    ) : null}
                    {row.referee ? (
                      <a className="link" href={refereePath(row.gameId)}>
                        Open as game master
                      </a>
                    ) : null}
                    {row.gmKey && !row.referee ? (
                      <button
                        type="button"
                        className="link"
                        disabled={busy !== null}
                        onClick={() => recoverFromStoredKey(row.gameId)}
                      >
                        {busy === row.gameId ? "Checking…" : "Recover the game-master role"}
                      </button>
                    ) : null}
                    {row.recentUrl && !row.seat && !row.referee ? (
                      <a className="link" href={row.recentUrl}>
                        Back to the game
                      </a>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {anyStoredKey ? (
            <p className="note">
              Recovering the game-master role ends the game master's old address. Whoever
              was running the game with it stops being the game master, which is what makes
              this a recovery and not a second key to the same door.
            </p>
          ) : null}
        </section>

        <section className="card">
          <h2>Return as a player</h2>
          <label className="field">
            <span>Game id</span>
            <input
              type="text"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              value={id}
              onChange={(event) => setId(event.target.value)}
            />
            <small>The id is shown on the game list and can be copied by the game master.</small>
          </label>
          <a
            className={heldSeat ? "cta" : "cta disabled"}
            aria-disabled={!heldSeat}
            href={heldSeat ? "/game/" + encodeURIComponent(playerId) + "/seat/me" : undefined}
          >
            {heldSeat ? "Open my seat" : "No seat key for this game on this device"}
          </a>
          <p className="note">
            After a connection loss, the same seat signs itself back in automatically.
            On a replacement device, open the backup link you saved earlier. With neither
            the old device nor a backup link, ask the game master for a replacement link;
            that action is recorded and may be subject to tournament rules.
          </p>
        </section>

        <section className="card">
          <h2>Recover the game-master role</h2>
          <p>
            Type the twelve words shown when the game's recovery key was made. The words
            stay in this browser; the server receives only a signed challenge.
          </p>
          <label className="field">
            <span>The twelve words</span>
            <textarea
              rows={4}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              value={words}
              onChange={(event) => setWords(event.target.value)}
            />
            <small>
              {typed === 0
                ? "Separate them with spaces. Capitals do not matter."
                : typed + " of 12 words"}
            </small>
          </label>
          <button
            type="button"
            className="primary"
            disabled={!ready || busy !== null}
            onClick={recoverFromWords}
          >
            {busy !== null ? "Checking…" : "Recover game-master access"}
          </button>
          <p className="note">
            This ends the game master's old address. Whoever was running the game with it
            stops being the game master, which is what makes this a recovery and not a
            second key to the same door.
          </p>
        </section>

        <section className="card">
          <h2>If there are no game-master words</h2>
          <p>
            Then there is no recovery. A game with no key is a game whose role lives only
            on the device that created it, and the server holds nothing that can give it
            back. What it can still do is carry on: the game master's screen has a{" "}
            <strong>Hand over</strong> card that moves the role to another device while
            the first one still works.
          </p>
        </section>
      </main>
    </>
  );
}
