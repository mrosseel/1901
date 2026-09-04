import { useCallback, useEffect, useState } from "react";

import {
  adminDeleteGame,
  adminLogin,
  adminLogout,
  adminMe,
  fetchGames,
  type AdminState,
  type GameSummary,
} from "../api";
import { writeAdminFlag } from "../admin";
import { TopBar } from "../components/TopBar";

/*
The owner's page (ADR-060).

Everything else in this app is about one game and is opened by a link somebody
was handed. This page is about the server, and the only person it is for is
whoever started the process. There are no accounts (ADR-020) and this is not
one: it is the token from ADMIN_TOKEN, typed once, and the single power behind
it is throwing a game away.

A server started without the variable has no admin at all, and the page says so
rather than offering a form that could never work.
*/
export function AdminPage() {
  const [state, setState] = useState<AdminState | null>(null);
  const [error, setError] = useState<string | null>(null);

  const remember = useCallback((next: AdminState) => {
    setState(next);
    writeAdminFlag(next.admin);
  }, []);

  useEffect(() => {
    let cancelled = false;
    adminMe()
      .then((answer) => {
        if (!cancelled) remember(answer);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [remember]);

  return (
    <>
      <TopBar here="admin" />
      <main className="page wide">
        <h1>Admin</h1>
        {error ? <p className="error">{error}</p> : null}
        {!state ? (
          <p className="note">Asking the server…</p>
        ) : !state.enabled ? (
          <section className="card">
            <p>Admin is not enabled on this server.</p>
            <p className="note">
              Start the server with <code>ADMIN_TOKEN</code> set to a long random secret.
              Then type it here.
            </p>
          </section>
        ) : !state.admin ? (
          <Login onIn={remember} />
        ) : (
          <GameTable onOut={() => remember({ admin: false, enabled: true })} />
        )}
      </main>
    </>
  );
}

function Login({ onIn }: { onIn: (state: AdminState) => void }) {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /* The server sleeps a second on a wrong token, so the button says it is
     working rather than looking dead. */
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onIn(await adminLogin(token));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      setToken("");
    }
  }

  return (
    <form className="card" onSubmit={submit}>
      <label className="field">
        <span>The token this server was started with</span>
        <input
          type="password"
          autoComplete="off"
          value={token}
          onChange={(event) => setToken(event.target.value)}
        />
      </label>
      {error ? <p className="error">{error}</p> : null}
      <div className="row">
        <button className="primary" type="submit" disabled={busy || !token}>
          {busy ? "Checking…" : "Log in"}
        </button>
      </div>
    </form>
  );
}

/* How long a first press of Delete stays armed. Long enough to move a thumb,
   short enough that a page left open does not keep a live delete on it. */
const ARMED_MS = 5000;

function GameTable({ onOut }: { onOut: () => void }) {
  const [rows, setRows] = useState<GameSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [armed, setArmed] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchGames()
      .then((list) => {
        if (!cancelled) setRows(list);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /* The armed row disarms itself, so a delete somebody walked away from is
     not one press away from happening. */
  useEffect(() => {
    if (!armed) return;
    const timer = window.setTimeout(() => setArmed(null), ARMED_MS);
    return () => window.clearTimeout(timer);
  }, [armed]);

  async function remove(gameId: string) {
    setBusy(gameId);
    setError(null);
    try {
      await adminDeleteGame(gameId);
      setRows((held) => (held || []).filter((one) => one.gameId !== gameId));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
      setArmed(null);
    }
  }

  async function out() {
    await adminLogout();
    onOut();
  }

  return (
    <>
      <div className="row">
        <button onClick={out}>Log out</button>
      </div>
      {error ? <p className="error">{error}</p> : null}
      {!rows ? (
        <p className="note">Reading the games…</p>
      ) : rows.length === 0 ? (
        <p className="note">This server holds no games.</p>
      ) : (
        <section className="card">
          <ul className="list admin-games">
            {rows.map((one) => (
              <li key={one.gameId}>
                <strong className="admin-name">{one.name || one.gameId}</strong>
                <span className="nation">{one.variant?.key || "classical"}</span>
                <span className="admin-cell">{status(one)}</span>
                <span className="admin-cell">{seats(one)}</span>
                <span className="admin-cell">{day(one.createdAt)}</span>
                <span className="row-actions">
                  <button
                    className="danger"
                    disabled={busy === one.gameId}
                    onClick={() =>
                      armed === one.gameId ? remove(one.gameId) : setArmed(one.gameId)
                    }
                  >
                    {busy === one.gameId
                      ? "Deleting…"
                      : armed === one.gameId
                        ? "Really delete"
                        : "Delete"}
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

/** What this game is doing, in one word or a phase. */
function status(one: GameSummary): string {
  if (one.sandbox) return "sandbox";
  if (!one.started) return "waiting";
  const phase = one.phase || {};
  const said = [phase.season, phase.year, phase.type?.toLowerCase()].filter(Boolean);
  return said.length ? said.join(" ") : "running";
}

/** How full the table is. A sandbox has no players to count. */
function seats(one: GameSummary): string {
  if (one.sandbox) return "no seats";
  return one.joinedCount + "/" + one.totalSeats + " seats";
}

/** The day the game was made, which is all anybody tidying up needs. */
function day(created: string): string {
  const when = new Date(created);
  return Number.isNaN(when.getTime()) ? created : when.toISOString().slice(0, 10);
}
