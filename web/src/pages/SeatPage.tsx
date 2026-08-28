import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, SeatClient, fetchPublic, type SeatState } from "../api";
import { Board } from "../components/Board";
import {
  phaseLabel,
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
import { StylePicker, useMapStyle } from "../components/StylePicker";
import { SupportedMark } from "../components/SupportedMark";
import { styledMapUrl } from "../style";
import { ReviewOverlay } from "../components/ReviewOverlay";
import { RefereeGuide } from "../components/RefereeGuide";
import { OrderArrowsToggle, useHideOrders } from "../components/OrderArrowsToggle";
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
  Continue writes it off in this browser and nowhere else, so no player ever
  waits for another to finish reading.
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
        setStatus("Every power finalized. The phase was adjudicated.");
      } else if (next.youFinalized) {
        setStatus("Orders finalized. You can still change them.");
      } else {
        setStatus("Finalize withdrawn.");
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

  const orders = state?.orders || {};
  const orderRows = Object.keys(orders).sort();
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

  return (
    <div className="seat-layout">
      <main className="map-pane">
        <Board
          api={api}
          state={state}
          plan={plan}
          review={reviewDraw}
          hideOrders={hideOrders}
          canOrder={canOrder}
          refusal={refusal}
          onState={onBoardState}
          onStatus={(text, error) => {
            setStatus(text);
            setIsError(error);
          }}
          onSelect={setSelected}
          onHandle={(board) => {
            handle.current = board;
          }}
        />
        {refereeing && guide ? (
          <RefereeGuide guide={guide} onClose={() => setRefereeing(false)} />
        ) : reviewing && review ? (
          <ReviewOverlay
            plan={review}
            deadlineAt={state?.deadlineAt}
            onContinue={closeReview}
            onReferee={guide ? () => setRefereeing(true) : undefined}
          />
        ) : null}
      </main>

      <aside className="side">
        <header className="seat-head">
          <h1>
            <span className="dot" style={{ background: powerColor(power) }} />
            You are {power || "…"}
          </h1>
          <p className="muted">
            {state?.started ? phaseLabel(state.phase) : "The game has not started"}
            {state?.variant ? " · " + state.variant.name : ""}{" "}
            {state?.variant ? <SupportedMark supported={state.variant.supported} /> : null}
          </p>
          {/* The deadline is the one thing on this page that must never be
              hunted for, so it gets its own line and its own size. */}
          <Clock deadlineAt={state?.deadlineAt} />
          {review && !reviewing ? (
            <span className="head-links">
              <button type="button" className="link" onClick={() => setReviewing(true)}>
                Last turn
              </button>
              {guide ? (
                <button type="button" className="link" onClick={() => setRefereeing(true)}>
                  Referee guide
                </button>
              ) : null}
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

        {state?.started ? (
          <section className="finalize">
            <button
              type="button"
              className={state.youFinalized ? "primary done" : "primary"}
              onClick={toggleFinalize}
            >
              {state.youFinalized
                ? "Finalized — tap to undo"
                : idle
                  ? "Nothing to do — finalize"
                  : "Finalize orders"}
            </button>
            <p className="muted">
              {state.finalizedCount} of {state.totalSeats} finalized
            </p>
          </section>
        ) : (
          <p className="muted">Waiting for the game master to start the game.</p>
        )}

        <p className={isError ? "status error" : "status"} role="status">
          {status}
        </p>

        <section>
          <h2>Your orders</h2>
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
                  className={"pickable" + (selected === province ? " picked" : "")}
                  tabIndex={0}
                  onClick={() => handle.current?.selectOrder(province)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      handle.current?.selectOrder(province);
                    }
                  }}
                >
                  <span className="order-text">{orders[province]}</span>
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

        {/* Presentation, and this device's alone: it changes what this screen
            draws and nothing any other player sees. */}
        <StylePicker value={style} onChange={setStyle} />
        <OrderArrowsToggle value={hideOrders} onChange={setHideOrders} />
      </aside>
    </div>
  );
}
