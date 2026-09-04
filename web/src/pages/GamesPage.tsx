import { useEffect, useState, type ReactNode } from "react";
import { TopBar } from "../components/TopBar";

import { clockFace, clockTone, msLeft } from "../clock";
import { copyText } from "../clipboard";
import {
  adminDeleteGame,
  adminMe,
  fetchGames,
  refereePath,
  watchPath,
  type GameSummary,
} from "../api";
import {
  anyRows,
  buildRows,
  groupRows,
  seatText,
  seatTone,
  yoursLabel,
  type GameRow,
} from "../gamelist";
import { entropyFor, readStoredKey } from "../gmkey";
import { heldGames } from "../held";
import { phaseLabel } from "../board/provinces";
import { recoverGameMaster } from "../recover";
import { readSeatSeed } from "../seatkey";
import { useOnlyMyGames } from "../prefs";
import { usePoll, useTicker } from "../hooks";

/*
The front door, and the way back in.

Every game the server holds, the ones being played and the ones waiting for
their table. The list carries public facts only: an id here opens the
spectator view, never a seat or the controls. What turns a row into a door is
this device's own storage — a seat seed or a game-master key — so the same
page that lists the server also lists what this browser can still open, and
the manual recovery cards sit at the foot of it under #recover.

There is no "finished" block. The server's summary says how far a game has got
and never says it is over, so a finished game would be filed under "in
progress" with a confident heading, which is worse than no heading at all.
*/
export function GamesPage({
  recoverGameId = null,
  focusRecover = false,
}: {
  /** Prefilled into the game-id field, from /recover/{gameId}. */
  recoverGameId?: string | null;
  /** Arrived at /recover, so the page opens at the recovery cards. */
  focusRecover?: boolean;
}) {
  const [games, setGames] = useState<GameSummary[] | null>(null);
  const [held, setHeld] = useState(() => heldGames());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [onlyMine, setOnlyMine] = useOnlyMyGames();
  const [admin, setAdmin] = useState(false);

  /* The delete column appears only for the owner, and only the server can say
     who that is. The remembered flag in admin.ts outlives the session it was
     written for, so it is good enough for a link in the bar and not good
     enough for a control that throws a game away. */
  useEffect(() => {
    let cancelled = false;
    adminMe()
      .then((answer) => {
        if (!cancelled) setAdmin(answer.admin);
      })
      .catch(() => {
        // A server that cannot answer is a server with no delete column.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    fetchGames()
      .then(setGames)
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : String(err)),
      );
  }, []);

  useEffect(() => {
    // The address names the section, and the section is at the foot of a long
    // page, so the browser is told to go there once the cards have mounted.
    if (!focusRecover) return;
    const section = document.getElementById("recover");
    // Guarded because not every environment that mounts this page can scroll:
    // the gallery's render test runs it in jsdom, which has no such method.
    if (typeof section?.scrollIntoView === "function") section.scrollIntoView();
  }, [focusRecover]);

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

  /* Recovery from a key already here. The words form below does the same
     thing with the sixteen bytes it builds out of what was typed. */
  const recoverFromStoredKey = async (gameId: string) => {
    const entropy = readStoredKey(gameId);
    if (!entropy) {
      setError("The game-master key for that game is no longer on this device.");
      return;
    }
    setError(null);
    setBusy(gameId);
    try {
      window.location.href = await recoverGameMaster(gameId, entropy);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(null);
    }
  };

  /* The row goes as soon as the server says it is gone, rather than waiting
     for the next poll to notice: a row that lingers after a delete reads as a
     delete that failed. */
  const deleteGame = async (gameId: string) => {
    setError(null);
    try {
      await adminDeleteGame(gameId);
      setGames((listed) => (listed || []).filter((one) => one.gameId !== gameId));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const rows = buildRows(games, held);
  const groups = groupRows(rows, onlyMine);
  const nothing = !anyRows(groups);

  return (
    <>
      <TopBar here="games" />
      <main className="page games-page">
        <h1>Games</h1>
        <p className="lead">
          The games on this server. Players join with the invite link a game
          master hands out.
        </p>
        {/* One line: the way to make a game, and the way to hide everybody
            else's. The filter is a plain checkbox — a box around it read as a
            second card between the button and the list. */}
        <div className="games-actions">
          <a className="cta" href="/new">
            New game
          </a>
          <label
            className="games-filter"
            title="The games this device holds a seat or a game-master key for."
          >
            <input
              type="checkbox"
              checked={onlyMine}
              onChange={(event) => setOnlyMine(event.target.checked)}
            />
            <span>Only my games</span>
          </label>
        </div>

        {error ? <p className="error">{error}</p> : null}

        {nothing && !error ? (
          <p className="muted">
            {onlyMine
              ? "This device holds no game."
              : "No games yet. Create the first one."}
          </p>
        ) : null}

        <GameGroup title="In progress" rows={groups.playing} admin={admin}>
          {(row) => (
            <GameLine
              key={row.gameId}
              row={row}
              busy={busy}
              admin={admin}
              onRecover={recoverFromStoredKey}
              onDelete={deleteGame}
            />
          )}
        </GameGroup>
        <GameGroup title="Setting up" rows={groups.waiting} admin={admin}>
          {(row) => (
            <GameLine
              key={row.gameId}
              row={row}
              busy={busy}
              admin={admin}
              onRecover={recoverFromStoredKey}
              onDelete={deleteGame}
            />
          )}
        </GameGroup>
        <GameGroup
          title="Not on the server"
          rows={groups.gone}
          admin={admin}
          note="This device holds a key for these games and the server does not list them. The key still opens the door if the game comes back."
        >
          {(row) => (
            <GameLine
              key={row.gameId}
              row={row}
              busy={busy}
              admin={admin}
              onRecover={recoverFromStoredKey}
              onDelete={deleteGame}
            />
          )}
        </GameGroup>

        <RecoverSection
          gameId={recoverGameId}
          busy={busy !== null}
          onRecovered={(url) => (window.location.href = url)}
          onError={setError}
          onBusy={setBusy}
          onHeldChanged={() => setHeld(heldGames())}
        />
      </main>
    </>
  );
}

/* One block of the list. An empty block prints nothing at all, heading
   included: a heading over no rows reads as a list that failed to load. */
function GameGroup({
  title,
  rows,
  admin,
  note,
  children,
}: {
  title: string;
  rows: GameRow[];
  /** The owner is here, so every row carries an eighth column. */
  admin: boolean;
  note?: string;
  children: (row: GameRow) => ReactNode;
}) {
  if (rows.length === 0) return null;
  return (
    <section className={admin ? "card game-block can-delete" : "card game-block"}>
      <h2>{title}</h2>
      {note ? <p className="note">{note}</p> : null}
      {/* The column names, on a screen wide enough for the columns to line up.
          A phone never sees them: there the row wraps onto two lines and a
          heading over wrapped lines names the wrong thing. */}
      <div className="game-columns" aria-hidden="true">
        <span>Game</span>
        <span>Variant</span>
        <span>Status</span>
        <span>Seats</span>
        <span>Deadline</span>
        {/* The two door columns name themselves: the buttons in them say
            Enter and Watch, and a heading would say it twice. */}
        <span />
        <span />
        {admin ? <span /> : null}
      </div>
      <ul className="game-list">{rows.map(children)}</ul>
    </section>
  );
}

/*
One game, in fixed columns.

A server running public play adds games faster than anybody reads them, so the
row stays a row: name, variant, status, seats, deadline, and two doors. What
changed from the old single line is that each fact has its own column, and the
columns line up down the page — the eye runs down one of them instead of
reading every row to the end. The name column carries the id under it, because
recovery and support need a durable, speakable way to name a game, and nobody
reads one out correctly twice.
*/
function GameLine({
  row,
  busy,
  admin,
  onRecover,
  onDelete,
}: {
  row: GameRow;
  busy: string | null;
  admin: boolean;
  onRecover: (gameId: string) => void;
  onDelete: (gameId: string) => Promise<void>;
}) {
  const [copied, setCopied] = useState(false);

  const copyId = async () => {
    setCopied(await copyText(row.gameId));
    setTimeout(() => setCopied(false), 1200);
  };

  const label = yoursLabel(row);
  const enter = enterPath(row);

  return (
    <li className="game-row">
      {/* A game with no name is called by its id. One line, not a line
          saying there is no name over a line saying the id. */}
      <div className="col-name">
        <span className="game-title">
          <strong className={row.name ? "game-name" : "game-name game-name-id"}>
            {row.name || row.gameId}
          </strong>
          {label ? (
            <span className="tag tag-mine" title={"Yours: " + label}>
              {label}
            </span>
          ) : null}
          {row.sandbox ? <span className="tag">Sandbox</span> : null}
        </span>
        <span className="game-id">
          {row.name ? <code>{row.gameId}</code> : null}
          <button type="button" className="link" onClick={copyId}>
            {copied ? "Id copied" : "Copy id"}
          </button>
        </span>
      </div>

      {/* On a wide screen this box is display:contents and its four facts
          become four columns of the row's own grid. On a phone it is the
          second line, wrapping as it must. */}
      <div className="game-facts">
        <span className="col-variant">{row.variantName}</span>
        <span className="col-status">
          {!row.onServer
            ? "Not on the server"
            : row.started
              ? phaseLabel(row.phase)
              : "Waiting to start"}
        </span>
        <span className="col-seats">
          {row.onServer && !row.sandbox ? (
            <span className={"seat-count " + seatTone(row.joinedCount, row.totalSeats)}>
              {seatText(row)}
            </span>
          ) : null}
        </span>
        <span className="col-deadline">
          {row.started ? <Deadline deadlineAt={row.deadlineAt} /> : null}
        </span>
      </div>

      {/* Two door columns, always in this order and always both there. An
          empty door column keeps its width, so Watch stays under Watch all the
          way down the page. The owner gets a third one after them. */}
      <div className="col-actions">
        <span className="col-enter">
          {enter ? (
            <a className="button-link" href={enter.href} title={enter.title}>
              Enter
            </a>
          ) : row.gmKey && !row.referee ? (
            /* The words are the fallback (ADR-048) and this is not it: the key
               is already here, so the role is one button away. */
            <button
              type="button"
              disabled={busy !== null}
              title="Recover the game-master role with the key on this device"
              onClick={() => onRecover(row.gameId)}
            >
              {busy === row.gameId ? "…" : "Recover"}
            </button>
          ) : null}
        </span>
        <span className="col-watch">
          {row.onServer ? (
            <a className="button-link" href={watchPath(row.gameId, null)}>
              Watch
            </a>
          ) : null}
        </span>
        {admin ? (
          <span className="col-delete">
            {row.onServer ? <DeleteGame gameId={row.gameId} onDelete={onDelete} /> : null}
          </span>
        ) : null}
      </div>
    </li>
  );
}

/* How long the first press stays armed. Long enough to reach the button
   again, short enough that a list left open holds no live delete. */
const ARMED_MS = 3000;

/*
The owner's one power, on the row it belongs to (ADR-060).

The admin page has the same two-press control, and this one is here for the
same reason the delete lives beside the game rather than on a page of its own:
the person tidying up is reading this list, and going somewhere else to name
the game again is how the wrong one gets deleted.
*/
function DeleteGame({
  gameId,
  onDelete,
}: {
  gameId: string;
  onDelete: (gameId: string) => Promise<void>;
}) {
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!armed) return;
    const timer = window.setTimeout(() => setArmed(false), ARMED_MS);
    return () => window.clearTimeout(timer);
  }, [armed]);

  const press = async () => {
    if (!armed) {
      setArmed(true);
      return;
    }
    setBusy(true);
    try {
      await onDelete(gameId);
    } finally {
      setBusy(false);
      setArmed(false);
    }
  };

  return (
    <button
      type="button"
      className="danger"
      disabled={busy}
      title="Delete this game and everything under it"
      onClick={() => void press()}
    >
      {busy ? "…" : armed ? "Really?" : "Delete"}
    </button>
  );
}

/*
The door this device can already open, or null when it can open none.

A seat comes first: a game master who also plays wants the board, and the GM
view is one tap away from the seat's own menu. Otherwise the referee cookie
answers /game/{id}/referee/, which the server redirects to the GM view — or,
for a sandbox, to the driver's link, because a sandbox has no GM view to open.
*/
function enterPath(row: GameRow): { href: string; title: string } | null {
  if (row.seat) {
    return {
      href: "/game/" + encodeURIComponent(row.gameId) + "/seat/me",
      title: "Open your seat",
    };
  }
  if (row.referee) {
    return {
      href: refereePath(row.gameId),
      title: row.sandbox ? "Open this sandbox" : "Open the game master view",
    };
  }
  return null;
}

/* The time left in the phase, ticking. A game with no deadline says nothing:
   the absence is the answer, and a line saying so is a line of noise. */
function Deadline({ deadlineAt }: { deadlineAt: string | null }) {
  useTicker(Boolean(deadlineAt));
  const left = msLeft(deadlineAt);
  if (left === null) return null;
  const tone = clockTone(left);
  return (
    <span className={"game-deadline " + tone}>
      {left <= 0 ? "Deadline passed" : clockFace(left) + " left"}
    </span>
  );
}

/*
Returning by hand, for the cases the list above cannot cover.

A device that was at the table already has its row up there. This is for the
other two: a replacement device with a backup link, and a game master with
nothing but the twelve words. It is the only place in the app somebody types a
secret in, which is why it is at the foot of the page rather than at the head
of it.
*/
function RecoverSection({
  gameId,
  busy,
  onRecovered,
  onError,
  onBusy,
  onHeldChanged,
}: {
  gameId: string | null;
  busy: boolean;
  onRecovered: (url: string) => void;
  onError: (message: string | null) => void;
  onBusy: (gameId: string | null) => void;
  onHeldChanged: () => void;
}) {
  const [id, setId] = useState(gameId || "");
  const [words, setWords] = useState("");

  const typed = words.trim().split(/\s+/).filter(Boolean).length;
  const playerId = id.trim();
  const ready = playerId !== "" && typed === 12;
  const heldSeat = playerId !== "" && Boolean(readSeatSeed(playerId));

  const recoverFromWords = async () => {
    onError(null);
    const entropy = entropyFor(words);
    if (!entropy) {
      // The checksum is what catches this, and it catches it here rather
      // than after a round trip: a wrong word is a typo, not a rejection.
      onError("Those are not twelve words from the list. Check the spelling and the order.");
      return;
    }
    onBusy(playerId);
    try {
      const url = await recoverGameMaster(playerId, entropy);
      onHeldChanged();
      onRecovered(url);
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
      onBusy(null);
    }
  };

  return (
    <section id="recover" className="recover">
      <h2>Return to a game</h2>

      <div className="card">
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
          <small>The game list shows the id. The game master can copy it there.</small>
        </label>
        <a
          className={heldSeat ? "cta" : "cta disabled"}
          aria-disabled={!heldSeat}
          href={heldSeat ? "/game/" + encodeURIComponent(playerId) + "/seat/me" : undefined}
        >
          {heldSeat ? "Open my seat" : "No seat key for this game on this device"}
        </a>
        <p className="note">
          After a connection loss, the seat signs back in on its own.
          On a replacement device, open the backup link you saved earlier. With no
          old device and no backup link, ask the game master for a replacement link.
          The server logs that request, and tournament rules may cover it.
        </p>
      </div>

      <div className="card">
        <h2>Recover the game-master role</h2>
        <p>
          Type the twelve words shown when the game's recovery key was made. The words
          stay in this browser. The server receives only a signed challenge.
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
          disabled={!ready || busy}
          onClick={() => void recoverFromWords()}
        >
          {busy ? "Checking…" : "Recover game-master access"}
        </button>
        <p className="note">
          This ends the game master's old address. Whoever was running the game with it
          stops being the game master.
        </p>
      </div>

      <div className="card">
        <h2>If there are no game-master words</h2>
        <p>
          Then there is no recovery. A game with no key is a game whose role lives only
          on the device that created it. The server holds nothing that can give it back.
          The game can still carry on. The game master's screen has a{" "}
          <strong>Hand over</strong> card that moves the role to another device while
          the first one still works.
        </p>
      </div>
    </section>
  );
}
