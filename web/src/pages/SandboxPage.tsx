import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { SandboxClient, type SandboxState } from "../api";
import { Board } from "../components/Board";
import { MapToolbar } from "../components/MapToolbar";
import { OrderNotationToggle } from "../components/OrderNotationToggle";
import { PhaseName } from "../components/PhaseName";
import { PowerChip } from "../components/PowerChip";
import { ReviewOverlay } from "../components/ReviewOverlay";
import { SplitLayout } from "../components/SplitLayout";
import { StaleBuild } from "../components/StaleBuild";
import { GameOver } from "../components/GameOver";
import { ModalLayer } from "../components/ModalLayer";
import { useMapStyle } from "../components/StylePicker";
import {
  candidates,
  dutyLine,
  dutyLineParts,
  emptyPlan,
  phaseKind,
  planDuty,
  type PhasePlan,
} from "../board/phases";
import { provinceName, setPowerPalette, setProvinceNames } from "../board/provinces";
import type { BoardApi, BoardHandle, BoardState, OptionTree, ReviewDraw, Unit } from "../board/types";
import { abbreviateOrders, unitsOf } from "../notation";
import { noteBuild } from "../build";
import { noteServerTime } from "../clock";
import { useBriefLabels, useBriefMoves, useHideOrders, useMarkerStyle, resolveMarkerStyle } from "../prefs";
import { orderText, reviewPlan } from "../review";
import { styledMapUrl } from "../style";
import { useFixEnabled } from "@mrosseel/page-comments/fixes";

/*
The sandbox: a board with no players (ADR-047).

One person holds the link. They pick a power, order it, pick the next one,
and press adjudicate. There is no clock, no lock, nobody to wait for and
nothing sealed, because there is no second player to keep a secret from.

Almost nothing here is new. The map island, the order builder, the review and
the map controls are the ones the seat page uses, and they are handed the same
shapes; what changes is where the power comes from. A seat's power is fixed by
its credential, so the seat page never has to say which one it means. Here the
power is a choice on the screen, and it is the only thing this page adds.

The board is shown one power at a time on purpose. Every drafted order is in
the answer and the panel counts them all, but the arrows the map draws are the
chosen power's, exactly as they are for a player — so what a sandbox draws is
what a table would have seen.
*/
export function SandboxPage({
  gameId,
  sandboxToken,
}: {
  gameId: string;
  sandboxToken: string;
}) {
  const client = useMemo(
    () => new SandboxClient(gameId, sandboxToken),
    [gameId, sandboxToken],
  );
  // c021: the duty line's unit or count is bold; the rest of the sentence is
  // lighter and grey. OFF keeps the sentence at one weight.
  const dutyUnitBold = useFixEnabled("c021");

  const [state, setState] = useState<SandboxState | null>(null);
  const [power, setPower] = useState("");
  const [plan, setPlan] = useState<PhasePlan>(emptyPlan(""));
  const [status, setStatus] = useState("");
  const [isError, setIsError] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [style, setStyle] = useMapStyle();
  const [hideOrders, setHideOrders] = useHideOrders();
  const [briefLabels, setBriefLabels] = useBriefLabels();
  const [markerStyle, setMarkerStyle] = useMarkerStyle();
  /* The game master says what the table opens on; this device may say
     otherwise, and then it wins (prefs.ts). */
  const tableMarkerStyle = state?.settings?.markerStyle;
  const drawnMarkers = resolveMarkerStyle(markerStyle, tableMarkerStyle);
  const [briefMoves, setBriefMoves] = useBriefMoves();
  const [illegalDrafts, setIllegalDrafts] = useState<string[]>([]);
  const handle = useRef<BoardHandle | null>(null);
  const latest = useRef<SandboxState | null>(null);

  const takeState = useCallback((next: SandboxState) => {
    latest.current = next;
    setState(next);
    noteBuild(next.build);
    noteServerTime(next.now);
    setProvinceNames(next.provinceNames || {});
    setPowerPalette(next.nations || []);
    return next;
  }, []);

  const say = useCallback((err: unknown) => {
    setStatus(err instanceof Error ? err.message : String(err));
    setIsError(true);
  }, []);

  useEffect(() => {
    let cancelled = false;
    client
      .state()
      .then((next) => {
        if (!cancelled) takeState(next);
      })
      .catch((err) => {
        if (!cancelled) say(err);
      });
    return () => {
      cancelled = true;
    };
  }, [client, takeState, say]);

  /*
  Which power the driver is playing. It settles on the first power of the
  variant when the board arrives, and it moves by itself when the phase asks
  that power for nothing: a retreat phase usually concerns one power, and
  landing the driver on a board with nothing to tap would read as a bug.
  */
  const powers = state?.nations || [];
  const idlePowers = useMemo(
    () => new Set<string>(state?.nothingToOrder || []),
    [state?.nothingToOrder],
  );

  useEffect(() => {
    if (!powers.length) return;
    if (power && !idlePowers.has(power)) return;
    const busyOne = powers.find((p: string) => !idlePowers.has(p));
    const next = busyOne || powers[0];
    if (next !== power) setPower(next);
  }, [powers, idlePowers, power]);

  const kind = phaseKind(state?.phase);

  /*
  The board this power sees: the whole position, with the drafted orders cut
  down to its own. The cut is what makes the map draw a seat's picture, and
  it is done here rather than on the server because the driver is entitled to
  every order in the answer — they wrote them.
  */
  const boardState = useMemo<BoardState | null>(() => {
    if (!state) return null;
    const orders: Record<string, string> = {};
    const parts: Record<string, string[]> = {};
    for (const province of Object.keys(state.orderParts || {})) {
      if (state.orderPowers[province] !== power) continue;
      orders[province] = (state.orders || {})[province];
      parts[province] = (state.orderParts || {})[province];
    }
    return {
      phase: state.phase,
      settings: state.settings,
      units: state.units || {},
      dislodged: state.dislodged || {},
      supplyCenters: state.supplyCenters || {},
      placements: state.placements,
      labels: state.labels,
      resolutions: state.resolutions,
      orders: orders,
      orderParts: parts,
    };
  }, [state, power]);

  /*
  Retreats and adjustments are decided per province and the server holds the
  rules, so the page asks it about the few provinces that could carry an order
  and keeps the answers. The same read as the seat page's, one power at a time.
  */
  const boardMark = JSON.stringify([
    state?.phase,
    state?.units,
    state?.dislodged,
    state?.orderParts,
    state?.supplyCenters,
  ]);

  useEffect(() => {
    if (!power) return;
    if (kind === "movement") {
      setPlan(emptyPlan(power, kind));
      return;
    }
    let cancelled = false;
    (async () => {
      const asked = candidates(boardState, power, kind);
      const trees = await Promise.all(
        asked.map((province) =>
          client.options(power, province).catch((): OptionTree => ({})),
        ),
      );
      const actionable: Record<string, OptionTree> = {};
      asked.forEach((province, i) => {
        if (trees[i] && Object.keys(trees[i]).length) actionable[province] = trees[i];
      });
      if (cancelled) return;
      setPlan({ kind: kind, power: power, actionable: actionable, duty: planDuty(actionable) });
    })();
    return () => {
      cancelled = true;
    };
    // boardState is read inside; the board fingerprint decides a re-read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, power, kind, boardMark]);

  const api = useMemo<BoardApi>(
    () => ({
      mapUrl: styledMapUrl(client.mapUrl, style),
      options: (province) => client.options(power, province),
      order: (province, parts) =>
        client.order(power, province, parts).then((next) => {
          takeState(next);
          return next as BoardState;
        }),
    }),
    [client, style, power, takeState],
  );

  /*
  A tap on another power's unit switches to that power rather than refusing
  it. That is the sandbox in one gesture: there is nobody else's unit here.
  */
  const canOrder = useCallback(
    (_province: string, unit: Unit | undefined) => Boolean(unit && unit.nation === power),
    [power],
  );
  const refusal = useCallback(
    (province: string, unit: Unit | undefined) => {
      if (unit) {
        setPower(unit.nation);
        return provinceName(province) + " is " + unit.nation + "'s. Switched to " + unit.nation + ".";
      }
      return "There is no unit in " + provinceName(province) + ".";
    },
    [],
  );

  const review = useMemo(() => reviewPlan(state?.previousPhase), [state?.previousPhase]);
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

  const adjudicate = useCallback(() => {
    setBusy(true);
    setStatus("");
    setIsError(false);
    client
      .adjudicate()
      .then((next) => {
        takeState(next);
        // The phase that just resolved is why anybody presses this, so the
        // review opens by itself rather than waiting to be found.
        setReviewing(true);
      })
      .catch(say)
      .finally(() => setBusy(false));
  }, [client, takeState, say]);

  /* The same two ways of saying an order the seat page offers, reading the
     same device preference: notation, or the server's own prose. */
  const orders = useMemo(() => {
    const parts = boardState?.orderParts || {};
    const prose = boardState?.orders || {};
    if (briefMoves) {
      return abbreviateOrders(
        parts,
        kind,
        unitsOf(boardState?.units, kind === "retreat" ? boardState?.dislodged : undefined),
      );
    }
    return Object.fromEntries(
      Object.keys(prose)
        .concat(Object.keys(parts))
        .map((province) => [
          province,
          orderText(province, parts[province], prose[province], kind),
        ]),
    );
  }, [boardState, briefMoves, kind]);
  const orderRows = Object.keys(orders).sort();
  const illegalHere = new Set(illegalDrafts);
  const drafted = Object.keys(state?.orderParts || {}).length;
  const duty = dutyLine(plan, boardState);
  const dutyParts = dutyLineParts(plan, boardState);
  const over = Boolean(state?.result);

  return (
    <>
      <StaleBuild beat={state} />
      <SplitLayout className="seat-layout sandbox">
        <main className="map-pane">
          {boardState ? (
            <Board
              api={api}
              state={boardState}
              plan={plan}
              review={reviewDraw}
              hideOrders={hideOrders}
              briefLabels={briefLabels}
              markerStyle={drawnMarkers}
              canOrder={canOrder}
              refusal={refusal}
              onState={() => undefined}
              onStatus={(text, bad) => {
                setStatus(text);
                setIsError(bad);
              }}
              onSelect={setSelected}
              onIllegal={setIllegalDrafts}
              onHandle={(next) => {
                handle.current = next;
              }}
            />
          ) : (
            <p className="watch-blank">{status || "Reading the board…"}</p>
          )}
          {boardState ? (
            <MapToolbar
              style={style}
              onStyle={setStyle}
              hideOrders={hideOrders}
              onHideOrders={setHideOrders}
              briefLabels={briefLabels}
              onBriefLabels={setBriefLabels}
              markerStyle={markerStyle}
              onMarkerStyle={setMarkerStyle}
              tableMarkerStyle={tableMarkerStyle}
            />
          ) : null}
        </main>

        <aside className="side">
          <header className="seat-head">
            <p className="phase-now">
              <PhaseName phase={state?.phase} />
            </p>
            <h1 className="sandbox-title">Sandbox</h1>
            <p className="muted">
              {state?.variant ? state.variant.name : ""}
              {" · no players, no clock"}
            </p>
            {duty ? (
              <p className={"duty duty-" + plan.kind}>
                {dutyUnitBold && dutyParts.unit ? (
                  <>
                    <strong>{dutyParts.unit}</strong>
                    <span className="duty-rest">{dutyParts.rest}</span>
                  </>
                ) : (
                  duty
                )}
              </p>
            ) : null}
          </header>

          {/* Who you are playing this moment. Every power is yours, so this is
              a switch and not a claim: nothing is taken and nothing is held. */}
          <section>
            <div className="list-head">
              <h2>Ordering as</h2>
              <span className="muted">{drafted} drafted</span>
            </div>
            <div className="power-switch">
              {powers.map((one: string) => (
                <button
                  key={one}
                  type="button"
                  className={one === power ? "power-pick picked" : "power-pick"}
                  aria-pressed={one === power}
                  title={idlePowers.has(one) ? one + " has nothing to order this phase" : one}
                  onClick={() => setPower(one)}
                >
                  <PowerChip power={one} small />
                  <span className="power-pick-count">
                    {idlePowers.has(one)
                      ? "—"
                      : Object.keys(state?.orderPowers || {}).filter(
                          (province) => state?.orderPowers[province] === one,
                        ).length}
                  </span>
                </button>
              ))}
            </div>
          </section>

          <section className="lock">
            <button
              type="button"
              className="lock-btn"
              disabled={busy || over || !state}
              onClick={adjudicate}
            >
              <span className="lock-main">{busy ? "Adjudicating…" : "Adjudicate"}</span>
              <span className="lock-sub">
                {over ? "The game has ended." : "A unit with no order holds."}
              </span>
            </button>
            {review && !reviewing ? (
              <button type="button" className="link" onClick={() => setReviewing(true)}>
                Review last phase
              </button>
            ) : null}
          </section>

          <p className={isError ? "status error" : "status"} role="status">
            {status}
          </p>

          <section>
            <div className="list-head">
              <h2>{power ? power + "'s orders" : "Orders"}</h2>
              <OrderNotationToggle value={briefMoves} onChange={setBriefMoves} />
            </div>
            {orderRows.length === 0 ? (
              <p className="muted">
                {idlePowers.has(power)
                  ? power + " has nothing to order this phase."
                  : kind === "retreat"
                    ? "No orders yet. Tap the dislodged unit, ringed in red."
                    : kind === "adjustment"
                      ? "No orders yet. Tap a highlighted province."
                      : "No orders yet. Tap one of this power's units on the map."}
              </p>
            ) : (
              <ul className="list">
                {orderRows.map((province) => (
                  <li
                    key={province}
                    className={
                      "pickable" +
                      (selected === province ? " picked" : "") +
                      (illegalHere.has(province) || illegalDrafts.includes(province)
                        ? " illegal"
                        : "")
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
                        title={"Drop the order for " + provinceName(province)}
                        onClick={(event) => {
                          event.stopPropagation();
                          handle.current?.cancelOrder(province);
                        }}
                      >
                        Drop
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="card sandbox-share">
            <h2>This link is the board</h2>
            <p className="note">
              Anybody with this address drives every power. The game id on its own
              opens the read-only <a href={"/watch/" + gameId}>spectator page</a>,
              which is public and permanent, exactly as a played game's is.
            </p>
          </section>
        </aside>
      </SplitLayout>

      {reviewing && review ? (
        <ModalLayer onClose={() => setReviewing(false)}>
          <ReviewOverlay
            plan={review}
            deadlineAt={null}
            onClose={() => setReviewing(false)}
            onMap={() => setReviewing(false)}
          />
        </ModalLayer>
      ) : null}

      {/* Fix c024: the sandbox's own board carries the same supply-centre
          table every other screen reuses here, in place of an ad-hoc count. */}
      {state?.result ? (
        <GameOver result={state.result} board={state} powers={state.nations} />
      ) : null}
    </>
  );
}
