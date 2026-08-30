import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  fetchPublic,
  fetchWatch,
  watchMapUrl,
  watchPath,
  type PreviousPhase,
  type PublicState,
  type WatchState,
} from "../api";
import { Board } from "../components/Board";
import { Clock } from "../components/Clock";
import { RefereeGuide } from "../components/RefereeGuide";
import { ModalLayer } from "../components/ModalLayer";
import { SplitLayout } from "../components/SplitLayout";
import { useMapStyle } from "../components/StylePicker";
import { MapToolbar } from "../components/MapToolbar";
import { OrderNotationToggle } from "../components/OrderNotationToggle";
import { useBriefLabels, useBriefMoves } from "../prefs";
import { PhaseName } from "../components/PhaseName";
import { SupportedMark } from "../components/SupportedMark";
import { emptyPlan, phaseKind } from "../board/phases";
import { powerColor, setPowerPalette, setProvinceNames } from "../board/provinces";
import type { BoardApi, BoardState, ReviewDraw } from "../board/types";
import { noteServerTime } from "../clock";
import { usePoll, useTicker } from "../hooks";
import { refereeGuide } from "../referee";
import { nmrLine, reviewPlan } from "../review";
import { styledMapUrl } from "../style";

/*
The spectator screen: the projector at the table, and the permanent address of
one phase of one game.

It is read-only in the strong sense D-013 asks for — not "the buttons are
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
  drawn from it — but it does carry the phase, the clock and the finalized
  count, and those are most of the header. So a server that does not serve
  /watch yet gets a page that says what it can and says plainly what it
  cannot, rather than a blank screen.
  */
  const read = useCallback(async () => {
    let refused: unknown = null;
    try {
      const next = await fetchWatch(gameId, at);
      setProvinceNames(next.provinceNames);
      setPowerPalette(Object.keys(next.finalized || {}));
      noteServerTime(next.now);
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
      setPowerPalette(Object.keys(fallback.finalized || {}));
      noteServerTime(fallback.now);
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
  usePoll(3000, read, at === null);

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

  const prevTo = at === null ? (phaseCount ? phaseCount - 1 : null) : at > 0 ? at - 1 : null;
  const nextTo =
    at === null ? null : phaseCount !== undefined && at + 1 >= phaseCount ? null : at + 1;
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

  const finalizedCount =
    watch?.finalizedCount ??
    Object.values(summary?.finalized || {}).filter(Boolean).length;
  const totalSeats = watch?.totalSeats ?? summary?.totalSeats;
  const variant = watch?.variant || summary?.variant;

  // The guide is read, not acted on: while it is open the board and the panel
  // behind it answer nothing, here as on every other page.
  const reading = refereeing && Boolean(guide);

  return (
    <>
    <SplitLayout className="seat-layout watch" frozen={reading}>
      <main className="map-pane" inert={reading || undefined}>
        {boardState ? (
          <Board
            api={api}
            state={boardState}
            plan={emptyPlan("")}
            review={draw}
            briefLabels={briefLabels}
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
          />
        ) : null}
      </main>

      <aside className="side" inert={reading || undefined}>
        <header className="seat-head">
          <h1 className="phase-now">
            <PhaseName phase={phase} />
          </h1>
          <p className="muted">
            Game {gameId}
            {variant ? " · " + variant.name : ""}{" "}
            {variant ? <SupportedMark supported={variant.supported} /> : null}
          </p>
          {historical ? (
            <p className="muted">This phase has resolved.</p>
          ) : (
            <Clock deadlineAt={deadlineAt} />
          )}
          {!historical && totalSeats !== undefined ? (
            <p className="muted">
              {finalizedCount} of {totalSeats} players locked in
            </p>
          ) : null}
        </header>

        <nav className="watch-nav">
          <button type="button" disabled={!canPrev} onClick={() => go(prevTo)}>
            ← Earlier phase
          </button>
          <span className="muted">
            {at === null ? "Live" : phaseCount ? "Phase " + (at + 1) + " of " + phaseCount : "Phase " + (at + 1)}
          </span>
          <button type="button" disabled={!canNext} onClick={() => go(nextTo)}>
            Later phase →
          </button>
        </nav>
        <p className="note">The arrow keys walk the phases.</p>

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
                    <span className="dot" style={{ background: powerColor(power) }} />
                    {nmrLine(power)}
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
                {plan.succeeded} of {plan.ordered} orders came off.
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
                    <span className="dot" style={{ background: powerColor(row.power) }} />
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
