import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, SeatClient, fetchPublic, type SeatState } from "../api";
import { Board } from "../components/Board";
import { SplitLayout } from "../components/SplitLayout";
import {
  powerColor,
  provinceName,
  setPowerPalette,
  setProvinceNames,
} from "../board/provinces";
import {
  candidates,
  dutyLine,
  dutyProgress,
  emptyPlan,
  phaseKind,
  planDuty,
  type PhasePlan,
} from "../board/phases";
import type {
  BoardApi,
  BoardHandle,
  BoardState,
  OptionTree,
  ReviewDraw,
  Unit,
} from "../board/types";
import { settingsLines, usePoll, useTicker } from "../hooks";
import { noteServerTime } from "../clock";
import { Clock } from "../components/Clock";
import { useMapStyle } from "../components/StylePicker";
import { MapToolbar } from "../components/MapToolbar";
import { OrderNotationToggle } from "../components/OrderNotationToggle";
import { abbreviateOrders, unitsOf } from "../notation";
import { ILLEGAL_DRAFT_NOTE, illegalAllowed } from "../illegal";
import { PhaseName } from "../components/PhaseName";
import { SupportedMark } from "../components/SupportedMark";
import { styledMapUrl } from "../style";
import { ReviewOverlay } from "../components/ReviewOverlay";
import { ModalLayer } from "../components/ModalLayer";
import { RefereeGuide } from "../components/RefereeGuide";
import { useBriefLabels, useBriefMoves, useHideOrders } from "../prefs";
import { refereeGuide } from "../referee";
import {
  dismiss,
  failureReason,
  isDismissed,
  isFailure,
  reviewKey,
  reviewPlan,
} from "../review";

/*
One player's board.

The server hands this page its own power's orders and nothing else, and refuses
any request about another power. The page holds the same line one step earlier:
a tap on someone else's unit is answered with a sentence, not a 403.
*/
export function SeatPage({ gameId, seatToken }: { gameId: string; seatToken: string }) {
  const client = useMemo(() => new SeatClient(gameId, seatToken), [gameId, seatToken]);
  const [state, setState] = useState<SeatState | null>(null);
  const [status, setStatus] = useState("");
  const [isError, setIsError] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [rulesChanged, setRulesChanged] = useState(false);
  const [gone, setGone] = useState(false);
  const [plan, setPlan] = useState<PhasePlan>(emptyPlan(""));
  const [reviewing, setReviewing] = useState(false);
  const [refereeing, setRefereeing] = useState(false);
  const [style, setStyle] = useMapStyle();
  const [hideOrders, setHideOrders] = useHideOrders();
  const [briefLabels, setBriefLabels] = useBriefLabels();
  const [briefMoves, setBriefMoves] = useBriefMoves();
  /*
  The drafts this device knows the rules refuse (D-029). It comes from the
  board, which is the only thing that saw the options tree the target was not
  in, and it goes no further than this panel: nothing about it is sent, and no
  other seat is told. That is the point of writing one.
  */
  const [illegalDrafts, setIllegalDrafts] = useState<string[]>([]);
  const handle = useRef<BoardHandle | null>(null);
  const knownVersion = useRef<number | null>(null);
  const fingerprint = useRef<string>("");

  const power = state?.you?.power || "";

  const refresh = useCallback(async () => {
    try {
      const next = await client.state();
      /*
      The variant's long names and its colours come with the state, and every
      sentence the board writes needs them, so they are taken before the state
      is put on screen.
      */
      setProvinceNames(next.provinceNames);
      setPowerPalette(Object.keys(next.finalized || {}));
      // Every countdown on this page is measured against the server's clock,
      // never this device's.
      noteServerTime(next.now);
      setState(next);
      if (knownVersion.current !== null && next.settingsVersion !== knownVersion.current) {
        setRulesChanged(true);
      }
      knownVersion.current = next.settingsVersion;
      return next;
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) setGone(true);
      throw err;
    }
  }, [client]);

  useEffect(() => {
    refresh().catch((err: unknown) => {
      setStatus(err instanceof Error ? err.message : String(err));
      setIsError(true);
    });
  }, [refresh]);

  /*
  The cheap public endpoint is the liveness poll. The seat state — which is the
  bigger answer and the one that can move the board under a player's fingers —
  is only re-read when that summary actually changed.
  */
  usePoll(
    3000,
    async () => {
      const summary = await fetchPublic(gameId);
      noteServerTime(summary.now);
      const mark = JSON.stringify([
        summary.started,
        summary.settingsVersion,
        summary.phase,
        summary.finalized,
        summary.deadlineAt,
      ]);
      if (mark === fingerprint.current) return;
      fingerprint.current = mark;
      await refresh();
    },
    !gone,
  );
  useTicker(Boolean(state?.deadlineAt));

  /*
  Retreats and adjustments are decided per province, not per unit, and the
  server holds the rules. So when such a phase opens the page asks it about the
  few provinces that could possibly carry an order — the dislodged units, or
  the units and the empty centres it holds — and keeps the answers. That set is
  highlighted, what may be tapped, and where the build or disband count comes
  from. It is re-read after each order, because an order spends the budget.
  */
  const kind = phaseKind(state?.phase);
  const started = Boolean(state?.started);
  const boardMark = JSON.stringify([
    state?.phase,
    state?.units,
    state?.dislodged,
    state?.orderParts,
    state?.supplyCenters,
  ]);

  useEffect(() => {
    if (!power) return;
    if (!started || kind === "movement") {
      setPlan(emptyPlan(power, kind));
      return;
    }
    let cancelled = false;
    (async () => {
      const asked = candidates(state, power, kind);
      const trees = await Promise.all(
        asked.map((province) =>
          client
            .options(province)
            // A province the server refuses simply carries no order this
            // phase; so does one whose tree comes back empty.
            .catch((): OptionTree => ({})),
        ),
      );
      const actionable: Record<string, OptionTree> = {};
      asked.forEach((province, i) => {
        const tree = trees[i];
        if (tree && Object.keys(tree).length) actionable[province] = tree;
      });
      if (cancelled) return;
      setPlan({ kind: kind, power: power, actionable: actionable, duty: planDuty(actionable) });
    })();
    return () => {
      cancelled = true;
    };
    // state is read inside, but the board fingerprint is what decides a re-read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, power, kind, started, boardMark]);

  /*
  The phase that just resolved, and whether this device has read it yet.

  A review opens by itself the first time a device sees a new adjudication —
  on a poll that brought one, or on a page opened while one is still unread.
  Closing the review writes it off in this browser and nowhere else, so no
  player ever waits for another to finish reading.
  */
  const review = useMemo(() => reviewPlan(state?.previousPhase), [state?.previousPhase]);
  const seenKey = review ? reviewKey(gameId, state?.previousPhase) : "";
  const readKey = useRef<string | null>(null);

  useEffect(() => {
    if (!seenKey || readKey.current === seenKey) return;
    readKey.current = seenKey;
    setReviewing(!isDismissed(seenKey));
  }, [seenKey]);

  const closeReview = useCallback(() => {
    if (seenKey) dismiss(seenKey);
    setReviewing(false);
  }, [seenKey]);

  const reviewDraw = useMemo<ReviewDraw | null>(() => {
    if (!reviewing || !review) return null;
    return {
      kind: review.kind,
      orderParts: review.orderParts,
      powers: review.powers,
      failed: Array.from(review.failed),
      illegal: Array.from(review.illegal),
      dislodged: review.dislodged,
      style: style,
    };
  }, [reviewing, review, style]);

  // The same adjudication, told as acts on the physical board.
  const guide = useMemo(() => refereeGuide(state?.previousPhase), [state?.previousPhase]);

  /*
  The board island only ever talks to this seat's endpoints.

  The style is in the map URL, so changing it changes this object, and the
  island is mounted afresh against the new one — which refetches the map. That
  is the whole of the refetch: a style change is rare and deliberate, and
  starting the board over on it is simpler than teaching it to swap its own
  art underneath a half-built order.
  */
  const api = useMemo<BoardApi>(
    () => ({
      mapUrl: styledMapUrl(client.mapUrl, style),
      options: (province) => client.options(province),
      order: (province, parts) => client.order(province, parts),
    }),
    [client, style],
  );

  const canOrder = useCallback(
    (_province: string, unit: Unit | undefined) => Boolean(unit && unit.nation === power),
    [power],
  );
  const refusal = useCallback(
    (province: string, unit: Unit | undefined) =>
      unit
        ? provinceName(province) + " is " + unit.nation + "'s. You order " + power + " only."
        : "There is no unit in " + provinceName(province) + ".",
    [power],
  );

  const onBoardState = useCallback((next: BoardState) => {
    // An order post answers with the whole seat state, so it replaces this
    // page's copy as well as the board's.
    setState((current) => (current ? ({ ...current, ...next } as SeatState) : (next as SeatState)));
  }, []);

  const toggleFinalize = async () => {
    if (!state) return;
    const wanted = !state.youFinalized;
    try {
      const next = await client.finalize(wanted);
      setState(next);
      /*
      Finalizing last resolves the phase at once (D-008), and that clears every
      flag — so a false flag after asking to finalize means "it adjudicated",
      not "it did not take".
      */
      if (wanted && !next.youFinalized) {
        setStatus("Every power locked in. The phase was adjudicated.");
      } else if (next.youFinalized) {
        setStatus("Orders locked in. You can still change them until the phase resolves.");
      } else {
        setStatus("Orders unlocked. Lock them in again before the deadline.");
      }
      setIsError(false);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
      setIsError(true);
    }
  };

  if (gone) {
    return (
      <main className="page">
        <h1>Board not found</h1>
        <p>This link is wrong, or the game is gone. Ask the game master for a new one.</p>
      </main>
    );
  }

  /*
  This power's orders, in whichever of the two languages this device asked
  for. The notation is built from the raw parts and the units on the board,
  never from the sentence beside it — a sentence cannot be unwritten into
  notation, and the two would drift the first time either changed.
  */
  const orders = briefMoves
    ? abbreviateOrders(
        state?.orderParts || {},
        kind,
        unitsOf(state?.units, kind === "retreat" ? state?.dislodged : undefined),
      )
    : state?.orders || {};
  const orderRows = Object.keys(orders).sort();
  /* Only while the rule is on: a server that refuses illegal orders has none
     to mark, and a stale mark would be a lie about a live draft. */
  const illegalHere = illegalAllowed(state?.settings)
    ? new Set(illegalDrafts)
    : new Set<string>();
  const duty = dutyLine(plan, state);
  // Idle means this power was asked for nothing at all — not that it has
  // already given the orders it owed.
  const idle =
    started &&
    kind !== "movement" &&
    Object.keys(plan.actionable).length === 0 &&
    orderRows.length === 0;
  const done = plan.duty ? dutyProgress(state, plan.duty) : 0;
  // Resolutions are public once a phase has been adjudicated, so every power's
  // outcome is listed, not only this one's.
  const resolutions = state?.phaseResolutions || state?.resolutions || {};
  const resolutionRows = Object.keys(resolutions).sort();

  /*
  A review or a guide is a thing to read, and while one is open it owns the
  screen. The board and the panel behind it go inert — so the phase
  commitment and a "close this view" button can never be reachable at the
  same moment, at any size.
  */
  const reading = (refereeing && Boolean(guide)) || (reviewing && Boolean(review));

  return (
    <>
    <SplitLayout className="seat-layout" frozen={reading}>
      <main className="map-pane" inert={reading || undefined}>
        <Board
          api={api}
          state={state}
          plan={plan}
          review={reviewDraw}
          hideOrders={hideOrders}
          briefLabels={briefLabels}
          canOrder={canOrder}
          refusal={refusal}
          onState={onBoardState}
          onStatus={(text, error) => {
            setStatus(text);
            setIsError(error);
          }}
          onSelect={setSelected}
          onIllegal={setIllegalDrafts}
          onHandle={(board) => {
            handle.current = board;
          }}
        />
        {/* On the map, because everything on it changes what the map draws.
            Presentation, and this device's alone. */}
        <MapToolbar
          style={style}
          onStyle={setStyle}
          hideOrders={hideOrders}
          onHideOrders={setHideOrders}
          briefLabels={briefLabels}
          onBriefLabels={setBriefLabels}
        />
      </main>

      <aside className="side" inert={reading || undefined}>
        <header className="seat-head">
          {/* The phase is what the whole table is playing. It is read across a
              room, so it is the largest thing on the page. */}
          <p className="phase-now">
            {state?.started ? <PhaseName phase={state.phase} /> : "The game has not started"}
          </p>
          <h1>
            <span className="dot" style={{ background: powerColor(power) }} />
            You are {power || "…"}
          </h1>
          <p className="muted">
            {state?.variant ? state.variant.name : ""}{" "}
            {state?.variant ? <SupportedMark supported={state.variant.supported} /> : null}
          </p>
          {/* The deadline is the one thing on this page that must never be
              hunted for, so it gets its own line and its own size. */}
          <Clock deadlineAt={state?.deadlineAt} />
          {review && !reviewing ? (
            <span className="head-links">
              <button type="button" className="link" onClick={() => setReviewing(true)}>
                Review last turn
              </button>
              {guide ? (
                <button type="button" className="link" onClick={() => setRefereeing(true)}>
                  Move the pieces
                </button>
              ) : null}
            </span>
          ) : null}
          {/* Only the game master's own seat carries this: the switch from
              the board to the controls, and back from there. */}
          {state?.refereeUrl ? (
            <span className="head-links">
              <a className="link" href={state.refereeUrl}>
                Game master view
              </a>
            </span>
          ) : null}
          {/* What this phase asks of this power: the units that must retreat,
              or the builds and disbands owed. */}
          {duty ? (
            <p className={idle ? "duty idle" : "duty"}>
              {duty}
              {plan.duty && !idle ? " (" + done + " of " + plan.duty.count + " in)" : ""}
            </p>
          ) : null}
        </header>

        {rulesChanged ? (
          <div className="banner">
            <div>
              <strong>The rules changed.</strong>
              {settingsLines(state?.settings).map((line) => (
                <div key={line}>{line}</div>
              ))}
            </div>
            <button type="button" className="link" onClick={() => setRulesChanged(false)}>
              Dismiss
            </button>
          </div>
        ) : null}

        {state?.started && state.nothingToOrder ? (
          <section className="finalize">
            {/*
            No button, because there is no choice being declined: the phase
            asks this power for nothing, and the table is already past it.
            */}
            <div className="lock-btn locked auto">
              <span className="lock-main">
                Nothing to order — {state.finalizedCount} of {state.totalSeats} players in
              </span>
              <span className="lock-sub">
                {power} has no order to give this phase, so this seat is finalized for you.
              </span>
            </div>
          </section>
        ) : state?.started ? (
          <section className="finalize">
            {/*
            The one control on this page that commits this power to the phase.
            It is the loudest thing in the panel on purpose: a first-time
            player must never confuse it with a button that only closes a view.
            */}
            <button
              type="button"
              className={state.youFinalized ? "lock-btn locked" : "lock-btn"}
              aria-pressed={state.youFinalized}
              onClick={toggleFinalize}
            >
              <span className="lock-main">
                {state.youFinalized
                  ? "Orders locked — " +
                    state.finalizedCount +
                    " of " +
                    state.totalSeats +
                    " players in"
                  : idle
                    ? "Nothing to order — lock in"
                    : "Lock in my orders"}
              </span>
              <span className="lock-sub">
                {state.youFinalized
                  ? "Tap to unlock · finalized"
                  : "Finalize this phase · you can still change them"}
              </span>
            </button>
            {state.youFinalized ? null : (
              <p className="muted">
                {state.finalizedCount} of {state.totalSeats} players locked in
              </p>
            )}
          </section>
        ) : (
          <p className="muted">Waiting for the game master to start the game.</p>
        )}

        <p className={isError ? "status error" : "status"} role="status">
          {status}
        </p>

        <section>
          {/* The switch belongs to the list it rewrites, not to the map. */}
          <div className="list-head">
            <h2>Your orders</h2>
            <OrderNotationToggle value={briefMoves} onChange={setBriefMoves} />
          </div>
          {orderRows.length === 0 ? (
            <p className="muted">
              {idle
                ? "Nothing to order this phase."
                : kind === "retreat"
                  ? "No orders yet. Tap the dislodged unit, ringed in red."
                  : kind === "adjustment"
                    ? "No orders yet. Tap a highlighted province."
                    : "No orders yet. Tap one of your units on the map."}
            </p>
          ) : (
            <ul className="list">
              {orderRows.map((province) => (
                <li
                  key={province}
                  className={
                    "pickable" +
                    (selected === province ? " picked" : "") +
                    (illegalHere.has(province) ? " illegal" : "")
                  }
                  tabIndex={0}
                  onClick={() => handle.current?.selectOrder(province)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      handle.current?.selectOrder(province);
                    }
                  }}
                >
                  <span className="order-text">
                    {orders[province]}
                    {/* Said, not only coloured: the player is bluffing on
                        purpose and is owed both halves of what that costs. */}
                    {illegalHere.has(province) ? (
                      <span className="illegal-note">{ILLEGAL_DRAFT_NOTE}</span>
                    ) : null}
                  </span>
                  <span className="row-actions">
                    <button
                      type="button"
                      title={"Change the order for " + provinceName(province)}
                      onClick={(event) => {
                        event.stopPropagation();
                        handle.current?.changeOrder(province);
                      }}
                    >
                      Change
                    </button>
                    <button
                      type="button"
                      className="row-cancel"
                      title={"Remove the order for " + provinceName(province)}
                      onClick={(event) => {
                        event.stopPropagation();
                        handle.current?.cancelOrder(province);
                      }}
                    >
                      ×
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        {resolutionRows.length ? (
          <section>
            <h2>Last phase</h2>
            <ul className="list">
              {/* A failure is said in the review's words, not godip's code. */}
              {resolutionRows.map((province) => (
                <li key={province}>
                  <span className="nation">{provinceName(province)}</span>
                  <span className="order-text">
                    {isFailure(resolutions[province])
                      ? failureReason(resolutions[province])
                      : "came off"}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

      </aside>
    </SplitLayout>

    {refereeing && guide ? (
      <ModalLayer onClose={() => setRefereeing(false)}>
        <RefereeGuide guide={guide} onClose={() => setRefereeing(false)} />
      </ModalLayer>
    ) : reviewing && review ? (
      <ModalLayer onClose={closeReview}>
        <ReviewOverlay
          plan={review}
          deadlineAt={state?.deadlineAt}
          onClose={closeReview}
          onReferee={guide ? () => setRefereeing(true) : undefined}
        />
      </ModalLayer>
    ) : null}
    </>
  );
}
