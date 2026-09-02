import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  fetchPublic,
  fetchWatch,
  gameEventsUrl,
  resultsUrl,
  watchMapUrl,
  watchPath,
  type PreviousPhase,
  type PublicState,
  type WatchState,
} from "../api";
import { Board } from "../components/Board";
import { Clock } from "../components/Clock";
import { GameOver } from "../components/GameOver";
import { RefereeGuide } from "../components/RefereeGuide";
import { ModalLayer } from "../components/ModalLayer";
import { SplitLayout } from "../components/SplitLayout";
import { useMapStyle } from "../components/StylePicker";
import { MapToolbar } from "../components/MapToolbar";
import { OrderNotationToggle } from "../components/OrderNotationToggle";
import { useBriefLabels, useBriefMoves, useMarkerStyle, resolveMarkerStyle } from "../prefs";
import { PhaseName } from "../components/PhaseName";
import { SupportedMark } from "../components/SupportedMark";
import { emptyPlan, phaseKind } from "../board/phases";
import { setPowerPalette, setProvinceNames } from "../board/provinces";
import { PowerChip } from "../components/PowerChip";
import { Standings } from "../components/Standings";
import type { BoardApi, BoardState, ReviewDraw } from "../board/types";
import { StaleBuild } from "../components/StaleBuild";
import { noteBuild } from "../build";
import { noteServerTime } from "../clock";
import { useGameEvents, usePoll, useRefreshAt, useTicker } from "../hooks";
import { refereeGuide } from "../referee";
import { nmrLine, reviewPlan } from "../review";
import { styledMapUrl } from "../style";

/*
The spectator screen: the projector at the table, and the permanent address of
one phase of one game.

It is read-only in the strong sense ADR-013 asks for — not "the buttons are
hidden" but "there is no way from here to an Order". It holds no token, it
reads an endpoint that answers with public board state only, and the board
island is handed a review draw for every phase, which is the mode in which the
map takes no taps at all. Its BoardApi cannot post: both of its methods reject.

A resolved phase draws that phase's orders in the outcome colours, the same
picture every player got in their review, plus the resolution list beside it.
The live phase draws the board and the clock and nothing else, because there
is nothing else that is public yet.
*/
export function WatchPage({
  gameId,
  phaseIndex,
}: {
  gameId: string;
  phaseIndex: number | null;
}) {
  const [at, setAt] = useState<number | null>(phaseIndex);
  const [watch, setWatch] = useState<WatchState | null>(null);
  const [summary, setSummary] = useState<PublicState | null>(null);
  const [feedMissing, setFeedMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refereeing, setRefereeing] = useState(false);
  const [style, setStyle] = useMapStyle();
  const [briefLabels, setBriefLabels] = useBriefLabels();
  const [markerStyle, setMarkerStyle] = useMarkerStyle();
  /* The game master says what the table opens on; this device may say
     otherwise, and then it wins (prefs.ts). */
  const tableMarkerStyle = summary?.settings?.markerStyle;
  const drawnMarkers = resolveMarkerStyle(markerStyle, tableMarkerStyle);
  const [briefMoves, setBriefMoves] = useBriefMoves();
  const asked = useRef<number | null>(null);

  // The address is the state: back and forward walk the phases.
  useEffect(() => {
    const onPop = () => {
      const parts = window.location.pathname.split("/").filter(Boolean);
      const last = parts[2];
      setAt(last && /^\d+$/.test(last) ? Number(last) : null);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const go = useCallback(
    (next: number | null) => {
      setAt(next);
      window.history.pushState(null, "", watchPath(gameId, next));
    },
    [gameId],
  );

  /*
  The spectator feed, with the public summary as the fallback.

  The summary is not a substitute — it carries no units, so no board can be
  drawn from it — but it does carry the phase, the clock and the locked
  count, and those are most of the header. So a server that does not serve
  /watch yet gets a page that says what it can and says plainly what it
  cannot, rather than a blank screen.
  */
  const read = useCallback(async () => {
    let refused: unknown = null;
    try {
      const next = await fetchWatch(gameId, at);
      setProvinceNames(next.provinceNames);
      setPowerPalette(Object.keys(next.locked || {}));
      noteServerTime(next.now);
      noteBuild(next.build);
      setWatch(next);
      setFeedMissing(false);
      setError(null);
      return;
    } catch (err) {
      refused = err;
    }
    /*
    Any refusal at all falls back, not only a 404: a server without the route
    may answer with the page shell, which fails to parse rather than to fetch,
    and the two mean the same thing to a viewer.
    */
    try {
      const fallback = await fetchPublic(gameId);
      setProvinceNames(fallback.provinceNames);
      setPowerPalette(Object.keys(fallback.locked || {}));
      noteServerTime(fallback.now);
      noteBuild(fallback.build);
      setSummary(fallback);
      setFeedMissing(true);
      setError(null);
    } catch {
      setError(refused instanceof Error ? refused.message : String(refused));
    }
  }, [gameId, at]);

  useEffect(() => {
    if (asked.current === at) return;
    asked.current = at;
    read().catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, [at, read]);

  // Only the live phase moves under the viewer; a resolved one is a fact.
  const live = useGameEvents(gameEventsUrl(gameId), read, at === null);
  useRefreshAt(watch?.graceUntil || summary?.graceUntil, read, live && at === null);
  usePoll(3000, read, at === null && !live);

  const phase = watch?.phase || summary?.phase;
  const deadlineAt = watch ? watch.deadlineAt : summary?.deadlineAt || null;
  useTicker(Boolean(deadlineAt));

  const historical = Boolean(watch?.historical || at !== null);
  const phaseCount = watch?.phaseCount;

  /*
  A resolved phase read back through the same code every player's review uses,
  so the spectator screen and the phones cannot disagree about what happened.
  */
  const previous = useMemo<PreviousPhase | null>(() => {
    if (!watch || !historical) return null;
    return {
      phase: watch.phase,
      orders: watch.orders,
      orderParts: watch.orderParts,
      powers: watch.powers,
      resolutions: watch.resolutions,
      dislodged: watch.dislodged,
      nmr: watch.nmr,
    };
  }, [watch, historical]);

  const plan = useMemo(() => reviewPlan(previous), [previous]);
  const guide = useMemo(() => refereeGuide(previous), [previous]);

  const boardState = useMemo<BoardState | null>(() => {
    if (!watch) return null;
    return {
      phase: watch.phase,
      units: watch.units || {},
      dislodged: watch.dislodged || {},
      supplyCenters: watch.supplyCenters || {},
      placements: watch.placements,
      labels: watch.labels,
      orders: {},
      orderParts: {},
    };
  }, [watch]);

  /*
  The board is always in review mode, whatever phase is on screen. That is not
  a presentation choice: review mode is the mode in which the island refuses
  every tap, so it is how this page is read-only by construction rather than
  by omission. The live phase simply reviews an empty set of orders.
  */
  const draw = useMemo<ReviewDraw>(
    () => ({
      kind: phaseKind(phase),
      orderParts: (historical && watch?.orderParts) || {},
      powers: (historical && watch?.powers) || {},
      failed: plan ? Array.from(plan.failed) : [],
      illegal: plan ? Array.from(plan.illegal) : [],
      dislodged: watch?.dislodged || {},
      style: style,
    }),
    [phase, historical, watch, plan, style],
  );

  // Nothing here may reach an endpoint that writes. Both methods refuse.
  const api = useMemo<BoardApi>(
    () => ({
      mapUrl: styledMapUrl(watchMapUrl(gameId), style),
      options: () => Promise.reject(new Error("The spectator view gives no orders.")),
      order: () => Promise.reject(new Error("The spectator view gives no orders.")),
    }),
    [gameId, style],
  );

  /*
  The phases, walked. The live phase is the last of the count, so the resolved
  ones are 0 … phaseCount - 2: stepping back from Live lands on the last of
  those, and stepping forward past it returns to Live rather than asking for
  the live phase by number, which would draw it as a phase that had resolved.
  */
  const liveIndex = phaseCount === undefined ? null : phaseCount - 1;
  const prevTo =
    at === null
      ? liveIndex !== null && liveIndex > 0
        ? liveIndex - 1
        : null
      : at > 0
        ? at - 1
        : null;
  const nextTo = at === null || (liveIndex !== null && at + 1 >= liveIndex) ? null : at + 1;
  const canPrev = prevTo !== null;
  const canNext = at !== null;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "ArrowLeft" && canPrev) {
        event.preventDefault();
        go(prevTo);
      } else if (event.key === "ArrowRight" && canNext) {
        event.preventDefault();
        go(nextTo);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [canPrev, canNext, prevTo, nextTo, go]);

  const lockedCount =
    watch?.lockedCount ??
    Object.values(summary?.locked || {}).filter(Boolean).length;
  const totalSeats = watch?.totalSeats ?? summary?.totalSeats;
  const variant = watch?.variant || summary?.variant;
  /* What the table calls this game (ADR-042). The feed carries it; the public
     summary carries it under settings, which is the fallback's only source. */
  const name = watch?.name || summary?.settings?.name;

  /*
  The game that has not begun. A spectator link is opened at the table before
  anything else, so the live phase must not be dressed up as one being played:
  there is no clock, nobody can be locked in, and the only number worth the
  screen is the one the invite is filling. The board underneath is the opening
  position, which is exactly what a projector should be showing then.
  */
  const waiting = !historical && (watch ? !watch.started : summary ? !summary.started : false);
  const joinedCount = watch?.joinedCount ?? summary?.joinedCount;
  const seatsToFill = watch?.seatsToFill ?? summary?.totalSeats;

  // The guide is read, not acted on: while it is open the board and the panel
  // behind it answer nothing, here as on every other page.
  const reading = refereeing && Boolean(guide);

  return (
    <>
    <StaleBuild beat={watch ?? null} />
    <SplitLayout className="seat-layout watch" frozen={reading}>
      <main className="map-pane" inert={reading || undefined}>
        {boardState ? (
          <Board
            api={api}
            state={boardState}
            plan={emptyPlan("")}
            review={draw}
            briefLabels={briefLabels}
            markerStyle={drawnMarkers}
            onState={() => undefined}
            onStatus={() => undefined}
            onSelect={() => undefined}
          />
        ) : (
          <p className="watch-blank">
            {feedMissing
              ? "This server does not serve the spectator board yet."
              : error || "Reading the game…"}
          </p>
        )}
        {/* The projector's own controls, on the board the room is watching.
            No arrows switch: this screen draws a resolved phase, which is the
            picture everybody is reading, not one seat's private draft. */}
        {boardState ? (
          <MapToolbar
            style={style}
            onStyle={setStyle}
            briefLabels={briefLabels}
            onBriefLabels={setBriefLabels}
            markerStyle={markerStyle}
            onMarkerStyle={setMarkerStyle}
            tableMarkerStyle={tableMarkerStyle}
          />
        ) : null}
      </main>

      <aside className="side" inert={reading || undefined}>
        <header className="seat-head">
          <h1 className="phase-now">
            {waiting ? "Waiting to start" : <PhaseName phase={phase} />}
          </h1>
          {name ? <p className="game-name">{name}</p> : null}
          {/* A named game does not print its id: this screen is read across
              a room, where a ten-character token says nothing anybody can
              use. The address carries it, and an unnamed game still needs
              it, because it has nothing else to be called. */}
          <p className="muted">
            {name ? "" : "Game " + gameId + " · "}
            {variant ? variant.name : ""}{" "}
            {variant ? <SupportedMark supported={variant.supported} /> : null}
          </p>
          {historical ? (
            <p className="muted">This phase has resolved.</p>
          ) : waiting ? null : (
            <Clock deadlineAt={deadlineAt} />
          )}
          {waiting ? (
            <>
              {joinedCount !== undefined && seatsToFill !== undefined ? (
                <p className="joined-big">
                  <strong>{joinedCount}</strong> of {seatsToFill} players have joined
                </p>
              ) : null}
              <p className="muted">
                The game master starts the game once every power is taken. The board
                is the opening position.
              </p>
            </>
          ) : totalSeats !== undefined ? (
            /* "locked in" alone was read as "joined" on a screen that also
               counts joiners, and the two count different sets: this line
               counts every claimed seat, the one above counts the seats an
               invite may still hand out. Naming what was locked ends it. */
            <p className="muted">
              {lockedCount} of {totalSeats} players are ready
            </p>
          ) : null}
        </header>

        {/* How the game ended (ADR-044). It rides on every phase of a
            finished game, so a link to Fall 1904 still says who won. */}
        <GameOver result={watch?.result} />

        {/* The supply centre count, which is what a room watching a board
            wants to know and what the whole game is about. Public arithmetic
            on a position this page is already drawing (ADR-013). */}
        {waiting ? null : (
          <Standings state={boardState} powers={Object.keys(summary?.locked || {})} />
        )}

        {/* The counts, as a file (ADR-046). This is the address a tournament
            director is handed, so the export lives here as well as on the
            game master's page. */}
        {waiting ? null : (
          <p className="results-links">
            <a href={resultsUrl(gameId, "csv")}>results.csv</a>{" "}
            <a href={resultsUrl(gameId, "json")}>results.json</a>
          </p>
        )}

        {/* Nothing to walk before the first phase has resolved. */}
        {waiting ? null : (
          <>
            <nav className="watch-nav">
              <button type="button" disabled={!canPrev} onClick={() => go(prevTo)}>
                ← Earlier phase
              </button>
              <span className="muted">
                {at === null
                  ? "Live"
                  : phaseCount
                    ? "Phase " + (at + 1) + " of " + phaseCount
                    : "Phase " + (at + 1)}
              </span>
              <button type="button" disabled={!canNext} onClick={() => go(nextTo)}>
                Later phase →
              </button>
            </nav>
            <p className="note">The arrow keys walk the phases.</p>
          </>
        )}

        {error ? <p className="status error">{error}</p> : null}
        {feedMissing ? (
          <p className="note">
            The board and the phase history come from the spectator feed, which this
            server does not answer yet. The phase, the clock and the locked-in count
            below are read from the public summary instead.
          </p>
        ) : null}

        {plan ? (
          <>
            {plan.nmr.length ? (
              <ul className="review-nmr">
                {plan.nmr.map((power) => (
                  <li key={power}>
                    <PowerChip power={power} small />
                    {nmrLine(power, plan.kind)}
                  </li>
                ))}
              </ul>
            ) : null}
            <section>
              <div className="list-head">
                <h2>What happened</h2>
                <OrderNotationToggle value={briefMoves} onChange={setBriefMoves} />
              </div>
              <p className="muted">
                {plan.ordered} orders submitted · {Object.keys(plan.dislodged).length} units dislodged.
              </p>
              <ul className="review-list">
                {plan.rows.map((row) => (
                  <li
                    key={row.province}
                    className={
                      "review-row" +
                      (row.failed ? " failed" : "") +
                      (row.illegal ? " illegal" : "")
                    }
                  >
                    <PowerChip power={row.power} small />
                    <span className="order-text">{briefMoves ? row.brief : row.text}</span>
                    {row.failed ? (
                      <span className={row.illegal ? "review-why illegal" : "review-why"}>
                        {row.reason}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </section>
            {guide ? (
              <button type="button" onClick={() => setRefereeing(true)}>
                Move the pieces
              </button>
            ) : null}
          </>
        ) : null}

      </aside>
    </SplitLayout>

    {refereeing && guide ? (
      <ModalLayer onClose={() => setRefereeing(false)}>
        <RefereeGuide guide={guide} onClose={() => setRefereeing(false)} />
      </ModalLayer>
    ) : null}
    </>
  );
}
