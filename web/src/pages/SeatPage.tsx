import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, SeatClient, fetchPublic, type SeatState } from "../api";
import { Board } from "../components/Board";
import { POWER_COLORS, phaseLabel, provinceName } from "../board/provinces";
import {
  candidates,
  dutyLine,
  dutyProgress,
  emptyPlan,
  phaseKind,
  planDuty,
  type PhasePlan,
} from "../board/phases";
import type { BoardApi, BoardHandle, BoardState, OptionTree, Unit } from "../board/types";
import { countdown, settingsLines, usePoll, useTicker } from "../hooks";

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
  const handle = useRef<BoardHandle | null>(null);
  const knownVersion = useRef<number | null>(null);
  const fingerprint = useRef<string>("");

  const power = state?.you?.power || "";

  const refresh = useCallback(async () => {
    try {
      const next = await client.state();
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
  the units and empty home centres — and keeps the answers. That set is what is
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
      const actionable: Record<string, OptionTree> = {};
      for (const province of candidates(state, power, kind)) {
        try {
          const tree = await client.options(province);
          if (tree && Object.keys(tree).length) actionable[province] = tree;
        } catch {
          // A province the server refuses simply carries no order this phase.
        }
      }
      if (cancelled) return;
      setPlan({ kind: kind, power: power, actionable: actionable, duty: planDuty(actionable) });
    })();
    return () => {
      cancelled = true;
    };
    // state is read inside, but the board fingerprint is what decides a re-read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, power, kind, started, boardMark]);

  // The board island only ever talks to this seat's endpoints.
  const api = useMemo<BoardApi>(
    () => ({
      mapUrl: client.mapUrl,
      options: (province) => client.options(province),
      order: (province, parts) => client.order(province, parts),
    }),
    [client],
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
      </main>

      <aside className="side">
        <header className="seat-head">
          <h1>
            <span className="dot" style={{ background: POWER_COLORS[power] || "#666" }} />
            You are {power || "…"}
          </h1>
          <p className="muted">
            {state?.started ? phaseLabel(state.phase) : "The game has not started"}
            {state?.deadlineAt ? " · " + countdown(state.deadlineAt) : ""}
          </p>
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
              {resolutionRows.map((province) => (
                <li key={province}>
                  <span className="nation">{provinceName(province)}</span>
                  <span className="order-text">{resolutions[province]}</span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </aside>
    </div>
  );
}
