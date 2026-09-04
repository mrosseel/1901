import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, SeatClient, fetchPublic, type SeatState } from "../api";
import { Board } from "../components/Board";
import { StaleBuild } from "../components/StaleBuild";
import { SeatMenu } from "../components/SeatMenu";
import { Standings } from "../components/Standings";
import { writeRecentGame } from "../recent";
import { readSeatSeed, takeSeedFromAddress } from "../seatkey";
import { SplitLayout } from "../components/SplitLayout";
import { provinceName, setPowerPalette, setProvinceNames } from "../board/provinces";
import {
  candidates,
  dutyLine,
  dutyLineParts,
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
import {
  settingsLines,
  useGameEvents,
  usePoll,
  useRefreshAt,
  useTicker,
} from "../hooks";
import { ruleLines } from "../rules";
import { noteBuild } from "../build";
import { noteServerTime } from "../clock";
import { SeatBar } from "../components/SeatBar";
import { PressPanel } from "../components/PressPanel";
import { pressSecret, seatSigner } from "../press";
import { useMapStyle } from "../components/StylePicker";
import { MapToolbar } from "../components/MapToolbar";
import { OrderNotationToggle } from "../components/OrderNotationToggle";
import { abbreviateOrders, unitsOf } from "../notation";
import { illegalAllowed, illegalDraftNote } from "../illegal";
import { SupportedMark } from "../components/SupportedMark";
import { VariantNote } from "../components/VariantNote";
import { useFixEnabled } from "@mrosseel/page-comments/fixes";
import { styledMapUrl } from "../style";
import { ReviewOverlay, ReviewPeekBar } from "../components/ReviewOverlay";
import { ModalLayer } from "../components/ModalLayer";
import { GameOver } from "../components/GameOver";
import { KeepYourSeat } from "../components/KeepYourSeat";
import { RefereeGuide } from "../components/RefereeGuide";
import { SeatWaiting } from "../components/SeatWaiting";
import { useBriefLabels, useBriefMoves, useHideOrders, useMarkerStyle, resolveMarkerStyle } from "../prefs";
import {
  discardInheritedEnvelopeKey,
  forgetOldDrafts,
  readDraft,
  commitBody,
  sealDraft,
  writeDraft,
  type Draft,
} from "../sealed";
import { refereeGuide } from "../referee";
import {
  dismiss,
  failureReason,
  isDismissed,
  isFailure,
  orderText,
  reviewKey,
  reviewPlan,
} from "../review";

const NORMAL_POLL_MS = 3000;
const REVEAL_POLL_MS = 500;

/*
One player's board.

The server hands this page its own power's orders and nothing else, and refuses
any request about another power. The page holds the same line one step earlier:
a tap on someone else's unit is answered with a sentence, not a 403.
*/
/*
Every power of this variant, in a stable order.

The seat state names them all in `locked`, because the panel already has to
say how many powers are in and how many are still out. That is the same list
the press composer offers, so nothing new is fetched to draw it.
*/
function powersOf(state: SeatState | null | undefined): string[] {
  return Object.keys(state?.locked || {}).sort();
}

export function SeatPage({ gameId, seatToken }: { gameId: string; seatToken: string }) {
  // c003: the map carries the review note somebody wrote, not a green tick.
  const noteInsteadOfTick = useFixEnabled("c003");
  // c006: the review note belongs to the variant gallery alone, not to a
  // running game.
  const noteGoneHere = useFixEnabled("c006");
  const bulletRules = useFixEnabled("c015");
  // c020: a resolved order reads as a plain OK, in green, not a sentence.
  const okNotSentence = useFixEnabled("c020");
  // c019: the switch names both states, so the "Your orders" heading above
  // it is redundant. OFF keeps the heading.
  const orderNotationHeading = !useFixEnabled("c019");
  // c022: the ready button's subtext only restates the main label in the
  // default and idle states. OFF keeps every subtext.
  const dropRedundantSub = useFixEnabled("c022");
  // c021: the duty line's unit or count is bold; the rest of the sentence is
  // lighter and grey. OFF keeps the sentence at one weight.
  const dutyUnitBold = useFixEnabled("c021");
  // c023: an ended game's panel is the result and the record of it. The
  // ready button, the missing-order count, the order entry and the switch
  // that rewrites it all belong to a phase that is over. OFF keeps them.
  const outcomeInsteadOfLock = useFixEnabled("c023");
  // c024: GameOver carries the supply-centre table itself, so the one
  // further down the panel does not repeat it. OFF keeps both tables.
  const standingsInGameOver = useFixEnabled("c024");
  // c027: the ready button gets the sidebar's own spacing from the line
  // under it, and "All orders are in" reads as a notice, not flat grey.
  // OFF keeps the old spacing and colour.
  const livelyLockPanel = useFixEnabled("c027");
  // c028: the variant name moved to the bar above the map, so the muted
  // line that used to carry it here drops out. OFF keeps the old line.
  const variantInTopBar = useFixEnabled("c028");
  const client = useMemo(() => new SeatClient(gameId, seatToken), [gameId, seatToken]);
  /*
  A keyed seat (ADR-049). The address carries no token: the seed does the work,
  and it arrives either from this device's storage or, once, from the fragment
  of the link that was opened. Reading it here is what moves it into storage
  and takes it out of the address bar.

  It is read before anything else on this page runs, because every request
  below needs a session and a session needs the seed.
  */
  const [heldSeat] = useState(() =>
    seatToken === "me" ? Boolean(takeSeedFromAddress(gameId) || readSeatSeed(gameId)) : true,
  );
  const [state, setState] = useState<SeatState | null>(null);
  const [status, setStatus] = useState("");
  const [isError, setIsError] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [rulesChanged, setRulesChanged] = useState(false);
  const [gone, setGone] = useState(false);
  const [connectionLost, setConnectionLost] = useState(() =>
    typeof navigator !== "undefined" ? !navigator.onLine : false,
  );
  const [plan, setPlan] = useState<PhasePlan>(emptyPlan(""));
  const [reviewing, setReviewing] = useState(false);
  /* Whether the panel below the divider is showing messages instead of
     orders, and the badge count while it is (the seat state's own count is
     one poll behind a message read inside the panel). */
  const [pressOpen, setPressOpen] = useState(false);
  const [pressUnread, setPressUnread] = useState<number | null>(null);
  /* This device's press key and signature, derived once (ADR-054). Both are
     cheap and neither depends on any state, so they are made here rather than
     inside a panel that is mounted and unmounted by a tap. */
  const pressBox = useMemo(() => pressSecret(gameId), [gameId]);
  const seatSign = useMemo(() => seatSigner(gameId), [gameId]);
  /* The review with the sheet put away, so the map behind it can be read and
     panned. It is still the review: the board takes no orders and the panel
     stays inert. */
  const [peeking, setPeeking] = useState(false);
  const [refereeing, setRefereeing] = useState(false);
  /* One count per answer the public summary gives, and only before the start:
     it is what the waiting screen's live mark is drawn from. */
  const [beat, setBeat] = useState(0);
  const [style, setStyle] = useMapStyle();
  const [hideOrders, setHideOrders] = useHideOrders();
  const [briefLabels, setBriefLabels] = useBriefLabels();
  const [markerStyle, setMarkerStyle] = useMarkerStyle();
  /* The game master says what the table opens on; this device may say
     otherwise, and then it wins (prefs.ts). */
  const tableMarkerStyle = state?.settings?.markerStyle;
  const drawnMarkers = resolveMarkerStyle(markerStyle, tableMarkerStyle);
  const [briefMoves, setBriefMoves] = useBriefMoves();
  /*
  The drafts this device knows the rules refuse (ADR-029). It comes from the
  board, which is the only thing that saw the options tree the target was not
  in, and it goes no further than this panel: nothing about it is sent, and no
  other seat is told. That is the point of writing one.
  */
  const [illegalDrafts, setIllegalDrafts] = useState<string[]>([]);
  const handle = useRef<BoardHandle | null>(null);
  const knownVersion = useRef<number | null>(null);
  const fingerprint = useRef<string>("");
  /*
  This phase's orders, in a sealed game (ADR-004).

  They live here and in this device's storage, and the server is sent a digest
  of them when the player locks in. Everything below reads them off the state
  as it always did, because takeState lays them over the server's answer at the
  one place a state arrives.

  A ref and not a hook: the board asks for the new state synchronously when it
  posts an order, and a value that arrives on the next render would be one tap
  behind.
  */
  const draft = useRef<Draft>({ key: "", orders: {} });
  const draftPhase = useRef<number>(-1);
  const latest = useRef<SeatState | null>(null);

  const power = state?.you?.power || "";

  /*
  The way back to this board (ADR-043).

  A player who leaves the seat to look at the list or read the questions has
  no account to find it again with: the address in the bar is the only copy of
  their token. So the device notes where it was, and the bar on every ordinary
  page offers it back.
  */
  const gameName = state?.settings?.name || gameId;
  useEffect(() => {
    if (!power) return;
    writeRecentGame({ url: window.location.pathname, label: gameName, power: power });
  }, [gameName, power]);

  /*
  Every state answer comes through here.

  In a sealed game the server's answer carries no current-phase order, because
  it has none (ADR-004), so this phone's own draft is laid over it. A phase
  that has moved on brings its own empty draft, and the drafts of phases that
  are over are dropped: they were revealed when the phase resolved and are
  public now, so keeping them would only fill the phone up.
  */
  const takeState = useCallback(
    (next: SeatState): SeatState => {
      if (next.sealed) {
        const at = next.phaseIndex ?? 0;
        if (draftPhase.current !== at) {
          draftPhase.current = at;
          draft.current = readDraft(gameId, at);
          forgetOldDrafts(gameId, at);
        }
        next = { ...next, orderParts: draft.current.orders, orders: {} };
      }
      latest.current = next;
      setState(next);
      return next;
    },
    [gameId],
  );

  const refresh = useCallback(async () => {
    try {
      const next = await client.state();
      /*
      The variant's long names and its colours come with the state, and every
      sentence the board writes needs them, so they are taken before the state
      is put on screen.
      */
      setProvinceNames(next.provinceNames);
      setPowerPalette(Object.keys(next.locked || {}));
      // Every countdown on this page is measured against the server's clock,
      // never this device's.
      noteServerTime(next.now);
      noteBuild(next.build);
      takeState(next);
      setConnectionLost(false);
      if (knownVersion.current !== null && next.settingsVersion !== knownVersion.current) {
        setRulesChanged(true);
      }
      knownVersion.current = next.settingsVersion;
      return next;
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) setGone(true);
      else setConnectionLost(true);
      throw err;
    }
  }, [client, takeState]);

  useEffect(() => {
    if (!heldSeat) return;
    refresh().catch((err: unknown) => {
      setStatus(err instanceof Error ? err.message : String(err));
      setIsError(true);
    });
  }, [refresh, heldSeat]);

  useEffect(() => {
    const lost = () => setConnectionLost(true);
    const restored = () => {
      setConnectionLost(false);
      refresh().catch(() => setConnectionLost(true));
    };
    window.addEventListener("offline", lost);
    window.addEventListener("online", restored);
    return () => {
      window.removeEventListener("offline", lost);
      window.removeEventListener("online", restored);
    };
  }, [refresh]);

  /*
  The cheap public endpoint is the liveness poll. The seat state — which is the
  bigger answer and the one that can move the board under a player's fingers —
  is only re-read when that summary actually changed.

  Once this phone has entered the reveal window, poll briefly at table speed:
  the final reveal adjudicates synchronously, and the players who revealed
  earlier should see that result within half a second rather than waiting for
  another ordinary three-second tick. The normal cadence resumes with the new
  phase, so this does not add traffic while players are writing orders.
  */
  const live = useGameEvents(client.eventsUrl, refresh, !gone && heldSeat);
  useRefreshAt(state?.graceUntil, refresh, live && Boolean(state?.sealed));
  usePoll(
    state?.sealed && state.revealOpen ? REVEAL_POLL_MS : NORMAL_POLL_MS,
    async () => {
      let summary;
      try {
        summary = await fetchPublic(gameId);
        setConnectionLost(false);
      } catch (err) {
        setConnectionLost(true);
        throw err;
      }
      noteServerTime(summary.now);
      noteBuild(summary.build);
      if (!summary.started) setBeat((n) => n + 1);
      const mark = JSON.stringify([
        summary.started,
        // A power claimed is a change the waiting screen must show.
        summary.joinedCount,
        summary.settingsVersion,
        summary.phase,
        summary.locked,
        summary.deadlineAt,
        // The moment the phones should send what they locked in (ADR-004).
        // Without it this seat would learn the window had opened only when
        // something else about the game happened to change.
        summary.revealOpen,
        // A draw the GM proposed asks this seat a question. Nothing else in
        // this list moves when it opens, closes, or gains a reply.
        summary.drawProposal,
      ]);
      if (mark === fingerprint.current) return;
      fingerprint.current = mark;
      await refresh();
    },
    !gone && heldSeat && !live,
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
  /*
  Writing one order down.

  In a sealed game nothing is sent (ADR-004): the order goes into this phase's
  draft and into storage, and the board is handed back the state it would have
  got from the server. The board cannot tell the difference, which is the point
  — it asks for the new state and draws it, here as everywhere.

  An unsealed game is a game made before commit-reveal existed, and it still
  posts every order as it is written.
  */
  const writeOrder = useCallback(
    async (province: string, parts: string[]): Promise<BoardState> => {
      const orders = { ...draft.current.orders };
      if (parts.length === 0) {
        delete orders[province];
      } else {
        orders[province] = parts;
      }
      draft.current = { ...draft.current, orders: orders };
      writeDraft(gameId, draftPhase.current, draft.current);
      const base = latest.current;
      if (!base) throw new Error("the board is not loaded yet");
      const next = { ...base, orderParts: orders, orders: {} };
      latest.current = next;
      setState(next);
      return next;
    },
    [gameId],
  );

  const sealed = Boolean(state?.sealed);
  const api = useMemo<BoardApi>(
    () => ({
      mapUrl: styledMapUrl(client.mapUrl, style),
      options: (province) => client.options(province),
      order: sealed
        ? (province, parts) => writeOrder(province, parts)
        : (province, parts) => client.order(province, parts),
    }),
    [client, style, sealed, writeOrder],
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
    // page's copy as well as the board's. In a sealed game the board is
    // handing back what writeOrder just built, which is already here.
    setState((current) => {
      const merged = (current ? { ...current, ...next } : next) as SeatState;
      latest.current = merged;
      return merged;
    });
  }, []);

  /*
  Releasing what this phone locked in (ADR-004, ADR-009).

  No player presses anything. The window opens when every seat has committed,
  or when the deadline runs out, and the next poll finds it — so waking a
  locked phone is enough to unstick a table that is waiting on it.

  A reveal that is refused leaves the seat unrevealed on purpose. Either this
  device has lost the draft behind its digest, in which case the game master
  forcing the phase is the way out (ADR-009), or the two sides disagree about
  the digest, which is a bug and must not be papered over by sending something
  else.
  */
  useEffect(() => {
    if (!state?.sealed || !state.revealOpen || state.youRevealed || !power) return;
    let cancelled = false;
    (async () => {
      try {
        // A handover may inherit the key to an envelope the former holder
        // wrote. It opens that commitment only; any envelope this device
        // writes uses its fresh key instead.
        const next = await client.reveal(draft.current.revealKey || draft.current.key);
        if (!cancelled) takeState(next);
      } catch (err) {
        if (cancelled) return;
        setStatus(err instanceof Error ? err.message : String(err));
        setIsError(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, power, state?.sealed, state?.revealOpen, state?.youRevealed, takeState]);

  const toggleLock = async () => {
    if (!state) return;
    const wanted = !state.youLocked;
    if (wanted) {
      const orderCount = Object.keys(state.orderParts || {}).length;
      let expected = 0;
      if (kind === "movement") {
        expected = Object.values(state.units || {}).filter((unit) => unit.nation === power).length;
      } else if (plan.duty) {
        expected = plan.duty.count;
      } else {
        expected = Object.keys(plan.actionable).length;
      }
      const warnings: string[] = [];
      if (orderCount < expected) {
        const missing = expected - orderCount;
        warnings.push(kind === "adjustment" && plan.duty?.type === "Build"
          ? `${missing} ${missing === 1 ? "build is" : "builds are"} unused. Unused builds are waived.`
          : `${missing} ${missing === 1 ? "required order is" : "required orders are"} missing. ` +
            (kind === "movement"
              ? "Any unordered unit will hold."
              : kind === "retreat"
                ? "Any unit without a valid retreat will be disbanded."
                : "Normal adjustment rules will apply to anything missing."));
      }
      if (state.lockedCount === state.totalSeats - 1) {
        warnings.push("You are the last player. Marking ready may resolve the phase immediately.");
      }
      if (warnings.length && !window.confirm(warnings.join("\n\n") + "\n\nMark ready anyway?")) {
        return;
      }
    }
    try {
      /*
      In a sealed game the lock is the commitment (ADR-011): what goes up is
      this phone's orders encrypted under a key it keeps, so the server holds
      them and cannot read them. It is the same button and the same word,
      which is why there is no second one.
      */
      const sealedOrders =
        state.sealed && wanted
          ? sealDraft(gameId, state.phaseIndex ?? 0, power, draft.current)
          : undefined;
      /* Signed as well as sealed (ADR-058). The orders are about to become
         public; this is what lets the table check afterwards that they came
         out of the envelope this seat committed. */
      const answer = await client.lock(
        wanted,
        sealedOrders,
        sealedOrders
          ? seatSign(commitBody(gameId, state.phaseIndex ?? 0, power, sealedOrders))
          : undefined,
      );
      // Unlocking removes the inherited envelope; locking replaces it. In
      // either case the former holder's phase key has no further job and must
      // not remain the key used for this device's future commitment.
      if (state.sealed && draft.current.revealKey) {
        draft.current = discardInheritedEnvelopeKey(draft.current);
        writeDraft(gameId, draftPhase.current, draft.current);
      }
      const next = takeState(answer);
      /*
      Locking last resolves the phase at once (ADR-008) — through the reveal,
      in a sealed game — and that clears every flag, so a false flag after
      asking to lock means "it adjudicated", not "it did not take".
      */
      if (wanted && !next.youLocked) {
        setStatus("Every power was ready. The phase was adjudicated.");
      } else if (next.youLocked && next.sealed) {
        setStatus(
          "Ready. The server has your orders sealed, and no key to them. "
            + "You can withdraw readiness while the others are still ordering.",
        );
      } else if (next.youLocked) {
        setStatus("Ready. You can withdraw readiness until the phase resolves.");
      } else {
        setStatus("Readiness withdrawn. Mark ready again before the deadline.");
      }
      setIsError(false);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
      setIsError(true);
    }
  };

  if (!heldSeat) {
    return (
      <main className="page">
        <h1>This device holds no seat here</h1>
        <p>
          A seat lives on the phone that claimed it, not in this address (ADR-049). This
          browser has no key for game {gameId}: it never claimed a power here, or its
          storage was cleared.
        </p>
        <p>
          If another device still has the seat, open its menu and use{" "}
          <strong>Back up or open this seat on another device</strong>. Otherwise ask the game master to
          hand the power over, which gives it to whichever phone scans the code.
        </p>
      </main>
    );
  }

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
  for. Both are built from the raw parts and the units on the board, never
  one from the other — a sentence cannot be unwritten into notation, and the
  two would drift the first time either changed.

  The long form is the board's own sentence, the same one the review writes.
  It used to be the server's prose, which is godip's words joined with spaces:
  "Fleet Norwegian Sea Convoy Quebec Norway". That string is still the
  fallback, for an order shape this device does not know how to say.
  */
  const orderParts = state?.orderParts || {};
  const serverProse = state?.orders || {};
  const orders = briefMoves
    ? abbreviateOrders(
        orderParts,
        kind,
        unitsOf(state?.units, kind === "retreat" ? state?.dislodged : undefined),
      )
    : Object.fromEntries(
        Object.keys(serverProse)
          .concat(Object.keys(orderParts))
          .map((province) => [
            province,
            orderText(province, orderParts[province], serverProse[province], kind),
          ]),
      );
  const orderRows = Object.keys(orders).sort();
  const expectedOrders =
    kind === "movement"
      ? Object.values(state?.units || {}).filter((unit) => unit.nation === power).length
      : plan.duty?.count ?? Object.keys(plan.actionable).length;
  const missingOrders = Math.max(0, expectedOrders - orderRows.length);
  /* Only while the rule is on: a server that refuses illegal orders has none
     to mark, and a stale mark would be a lie about a live draft. */
  const illegalHere = illegalAllowed(state?.settings)
    ? new Set(illegalDrafts)
    : new Set<string>();
  const duty = dutyLine(plan, state);
  const dutyParts = dutyLineParts(plan, state);
  /*
  The reveal window is open (ADR-009), so this phase takes no more locks.

  The envelopes on the server are what the keys are checked against from this
  moment, and the server refuses a lock, a relock and an unlock alike. The
  button says that instead of sending a tap that comes back as a refusal.
  */
  const revealClosed = Boolean(state?.sealed && state?.revealOpen);
  /* The deadline ran out with this seat unlocked (ADR-009). It has no envelope
     to release, so it is waiting for nothing: the way out is the game master. */
  const missedLock = revealClosed && !state?.youLocked;
  const missedOutcome =
    kind === "movement"
      ? power + " gives no orders and its units hold."
      : kind === "retreat"
        ? power + " gives no retreat orders and its dislodged units are disbanded."
        : power + " gives no adjustment orders and normal adjustment rules apply.";
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
  Fix c023. The game has a result, so the panel is a record and not a turn:
  the result card leads the column, and everything the phase needed — the
  ready button, the order entry, and the switch that rewrites its list —
  leaves it. The server refuses an order here anyway.
  */
  const overAndRecorded = started && Boolean(state?.result) && outcomeInsteadOfLock;

  /*
  The result, on the one screen a player is certainly looking at when the game
  ends (ADR-044). It is written once and placed twice: at the top of the panel
  once the game is over (fix c023), and where it always sat otherwise. Fix
  c024: it carries this board's own supply-centre table, so the table at the
  foot of the panel drops out rather than repeating it.
  */
  const resultCard = (
    <GameOver
      result={state?.result}
      board={state}
      powers={Object.keys(state?.locked || {})}
      you={power}
    />
  );

  /*
  A review or a guide is a thing to read, and while one is open it owns the
  screen. The board and the panel behind it go inert — so the phase
  commitment and a "close this view" button can never be reachable at the
  same moment, at any size.
  */
  const reading = (refereeing && Boolean(guide)) || (reviewing && Boolean(review));
  /* While the map is being read the map itself answers: pan and zoom are the
     point of looking at it. Only the order panel stays out of reach, because
     locking in this phase half-read is the thing that must not happen. */
  const mapFrozen = reading && !peeking;

  /*
  Press owns the panel or the orders do, never both (ADR-053). The map and the
  divider are untouched by the switch, so the board a message is about is
  still on the screen, at whatever size this player dragged it to.
  */
  const pressEnabled = Boolean(state?.pressEnabled);
  const showingPress = pressOpen && pressEnabled;
  const unread = pressUnread ?? state?.pressUnread ?? 0;

  return (
    <>
    <StaleBuild beat={state ?? null} />
    <div className="seat-shell">
    {power ? (
      <SeatBar
        power={power}
        phase={state?.phase}
        started={started}
        variant={state?.variant?.name}
        ordersIn={orderRows.length}
        ordersExpected={expectedOrders}
        locked={Boolean(state?.youLocked)}
        deadlineAt={state?.deadlineAt}
        unread={unread}
        pressEnabled={pressEnabled}
        pressShowing={showingPress}
        onPress={() => {
          setPressOpen(!showingPress);
          if (!showingPress) setPressUnread(null);
        }}
        menu={
          <SeatMenu
            gameId={gameId}
            power={power}
            turns={state?.turns}
            createdAt={state?.createdAt}
            isGameMaster={state?.youAreGm}
            seat={client}
          />
        }
      />
    ) : null}
    <SplitLayout className="seat-layout" frozen={reading}>
      <main className="map-pane" inert={mapFrozen || undefined}>
        <Board
          api={api}
          state={state}
          plan={plan}
          review={reviewDraw}
          hideOrders={hideOrders}
          briefLabels={briefLabels}
          markerStyle={drawnMarkers}
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
          markerStyle={markerStyle}
          onMarkerStyle={setMarkerStyle}
          tableMarkerStyle={tableMarkerStyle}
        />
      </main>

      <aside className="side" inert={reading || undefined}>
        {showingPress && power ? (
          <PressPanel
            gameId={gameId}
            you={power}
            api={client}
            secret={pressBox}
            sign={seatSign}
            phaseIndex={state?.phaseIndex ?? 0}
            powers={powersOf(state)}
            onUnread={setPressUnread}
          />
        ) : (
        <>
        {/* Fix c023: on a finished game the result is what the column is
            for, so it is the first thing in it. */}
        {overAndRecorded ? resultCard : null}
        {connectionLost ? (
          <div className="banner">
            <div>
              <strong>{navigator.onLine ? "Game server unreachable." : "You are offline."}</strong>
              <div>Your saved draft remains on this device. This page will reconnect automatically.</div>
            </div>
            <button type="button" className="link" onClick={() =>
              refresh().catch(() => setConnectionLost(true))}>
              Try now
            </button>
          </div>
        ) : null}
        {!started ? <SeatWaiting state={state} beat={beat} connected={live} /> : (
          <header className="seat-head">
            {/* The phase, the power, the order count and the deadline are in
                the bar above the map now (SeatBar): they are read in glances
                between conversations, and hunting for them below a map that
                is fighting for every pixel was the thing to fix. What is left
                here is what a player reads once and then acts on. Fix c028:
                the variant's name went up to the bar too, in its own box
                beside the phase, so this line carries only what did not — the
                review note or tick, when one of those still shows here. */}
            {state?.variant && (!variantInTopBar || !noteGoneHere) ? (
              <p className="muted">
                {variantInTopBar ? null : state.variant.name + " "}
                {noteGoneHere ? null : noteInsteadOfTick ? (
                  <VariantNote note={state.variant.note} />
                ) : (
                  <SupportedMark supported={state.variant.supported} />
                )}
              </p>
            ) : null}
            {review && !reviewing ? (
              <span className="head-links">
                <button type="button" className="link" onClick={() => setReviewing(true)}>
                  Review last phase
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
              <p className={"duty duty-" + plan.kind + (idle ? " idle" : "")}>
                {dutyUnitBold && dutyParts.unit ? (
                  <>
                    <strong>{dutyParts.unit}</strong>
                    <span className="duty-rest">{dutyParts.rest}</span>
                  </>
                ) : (
                  duty
                )}
                {plan.duty && !idle ? " (" + done + " of " + plan.duty.count + " in)" : ""}
              </p>
            ) : null}
          </header>
        )}

        {rulesChanged ? (
          <div className="banner">
            <div>
              <strong>The rules changed.</strong>
              {bulletRules ? (
                <ul className="rule-list">
                  {ruleLines(state?.settings).map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              ) : (
                settingsLines(state?.settings).map((line) => (
                  <div key={line}>{line}</div>
                ))
              )}
            </div>
            <button type="button" className="link" onClick={() => setRulesChanged(false)}>
              Dismiss
            </button>
          </div>
        ) : null}

        {state?.drawProposal ? (
          <section className="card draw-confirm">
            <h2>Draw proposal</h2>
            {state.drawProposal.required.includes(power) ? (
              <>
                <p>
                  The proposed result includes{" "}
                  <strong>{state.drawProposal.powers.join(", ")}</strong> and excludes {power}.
                </p>
                {state.drawProposal.confirmed.includes(power) ? (
                  <p className="notice">
                    You confirmed this exclusion. Waiting for the other replies.
                  </p>
                ) : (
                  <>
                    <p className="note">
                      Accept only if you consent to the game ending without {power} in the result.
                      Rejecting cancels the proposal; play continues either way until all
                      exclusions agree.
                    </p>
                    <button type="button" onClick={() => {
                      client.drawResponse(true).then(takeState).catch((err) => {
                        setStatus(err instanceof Error ? err.message : String(err));
                        setIsError(true);
                      });
                    }}>Accept exclusion</button>{" "}
                    <button type="button" onClick={() => {
                      client.drawResponse(false).then(takeState).catch((err) => {
                        setStatus(err instanceof Error ? err.message : String(err));
                        setIsError(true);
                      });
                    }}>Reject proposal</button>
                  </>
                )}
              </>
            ) : (
              /* A power inside the proposal is asked nothing, and still needs
                 to see that the table is deciding whether the game ends. */
              <>
                <p>
                  The GM proposed a result of{" "}
                  <strong>{state.drawProposal.powers.join(", ")}</strong>.
                </p>
                <p className="note">
                  The game ends when {state.drawProposal.required.join(", ")} accept the
                  exclusion. Play continues until they answer.
                </p>
              </>
            )}
          </section>
        ) : null}

        {overAndRecorded ? (
          /*
          Fix c023: the game took its last order already. A missing-order
          count and a "mark ready" button both describe a phase that no
          longer exists, and the line that replaced them only pointed at the
          result card. The card is at the top of the column now, so nothing
          stands here at all.
          */
          null
        ) : state?.started && state.nothingToOrder ? (
          <section className="lock">
            {/*
            No button, because there is no choice being declined: the phase
            asks this power for nothing, and the table is already past it.
            */}
            <div className="lock-btn locked auto">
              <span className="lock-main">
                Nothing to order — {state.lockedCount} of {state.totalSeats} players ready
              </span>
            </div>
          </section>
        ) : state?.started ? (
          <section className="lock">
            {expectedOrders > 0 ? (
              // c027: "All orders are in" is a milestone, not a caption, so
              // it reads in the same colour as the missing-orders line
              // instead of flat grey. OFF keeps the old muted line.
              <p className={livelyLockPanel || missingOrders ? "notice" : "muted"}>
                {missingOrders === 0
                  ? "All orders are in"
                  : missingOrders + (missingOrders === 1 ? " order missing" : " orders missing")}
              </p>
            ) : null}
            {/*
            The one control on this page that commits this power to the phase.
            It is the loudest thing in the panel on purpose: a first-time
            player must never confuse it with a button that only closes a view.
            */}
            <button
              type="button"
              className={state.youLocked ? "lock-btn locked" : "lock-btn"}
              aria-pressed={state.youLocked}
              disabled={revealClosed}
              onClick={toggleLock}
            >
              <span className="lock-main">
                {state.youLocked
                  ? "Ready. " +
                    state.lockedCount +
                    " of " +
                    state.totalSeats +
                    " players ready"
                  : missedLock
                    ? "Orders closed. The phase is being revealed"
                    : idle
                      ? "Nothing to order. Mark ready"
                      : "Mark my orders ready"}
              </span>
              {state.youLocked ? (
                <span className="lock-sub">
                  {state.revealOpen
                    ? "Everybody is in · the orders are going up now"
                    : "Tap to withdraw readiness"}
                </span>
              ) : missedLock ? (
                <span className="lock-sub">The deadline passed with this seat unlocked</span>
              ) : state.sealed ? (
                <span className="lock-sub">
                  Orders stay on this device until you mark them ready
                </span>
              ) : dropRedundantSub ? null : (
                <span className="lock-sub">Mark ready when your orders are complete</span>
              )}
            </button>
            {state.youLocked ? null : (
              <p className="muted">
                {state.lockedCount} of {state.totalSeats} players ready
              </p>
            )}
            {/*
            The window is open and the board is waiting on somebody's phone
            (ADR-009). Naming them is what turns "it has hung" into a thing
            the table can fix by saying it out loud, which is how nearly every
            one of these ends.
            */}
            {state.revealOpen && (state.awaitingReveal || []).length ? (
              <p className="muted reveal-wait">
                {missedLock
                  ? "This seat has nothing to send: it never locked in. Ask the game"
                    + " master to extend the deadline, or to force the phase. Then"
                    + " " + missedOutcome
                  : state.youRevealed
                    ? "Waiting for " + (state.awaitingReveal || []).join(", ")
                      + " to send their orders."
                    : "Sending your orders…"}
              </p>
            ) : null}
          </section>
        ) : null}

        <p className={isError ? "status error" : "status"} role="status">
          {status}
        </p>


        {/* No orders before the start: no phase has asked for one and the
            server refuses one. So the list, its heading and the switch that
            rewrites it are not on the screen at all. Fix c023: the same is
            true after the end, where "no orders yet" promises a phase that
            will never come. */}
        {started && !overAndRecorded ? (
          <section>
            {/* The switch belongs to the list it rewrites, not to the map.
                Fix c019: the two-option switch already says what this section
                holds, so the redundant heading is gone; OFF keeps it. */}
            <div className="list-head">
              {orderNotationHeading ? <h2>Your orders</h2> : null}
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
                        <span className="illegal-note">{illegalDraftNote(kind)}</span>
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
        ) : null}

        {resolutionRows.length ? (
          <section>
            <h2>Last phase</h2>
            <ul className="list resolution-list">
              {/* A failure is said in the review's words, not godip's code. */}
              {resolutionRows.map((province) => (
                <li key={province}>
                  <span className="nation">{provinceName(province)}</span>
                  <span className="order-text">
                    {isFailure(resolutions[province]) ? (
                      failureReason(resolutions[province])
                    ) : okNotSentence ? (
                      <span className="ok-result">OK</span>
                    ) : (
                      "resolved without an order error"
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {/* Where the result sits while the fix is off: after the orders, in
            the order the panel grew. Fix c023 lifts it to the top of the
            column instead. */}
        {overAndRecorded ? null : resultCard}

        {/* Asked once, at the start, and never again (ADR-004). A copy of
            this seat on another device is what saves the orders of a phone
            that dies after locking in. */}
        {started && !state?.result ? <KeepYourSeat gameId={gameId} power={power} /> : null}

        {/* Last on the panel, because it is read between turns and never
            during one: the orders and the lock are what a player reaches for
            under the clock. Every power's supply centres, counted off the
            board this screen is already drawing. Fix c024: once the game
            has ended, GameOver above already carries this table. */}
        {started && !(state?.result && standingsInGameOver) ? (
          <Standings state={state} you={power} powers={Object.keys(state?.locked || {})} />
        ) : null}

        </>
        )}
      </aside>
    </SplitLayout>
    </div>

    {refereeing && guide ? (
      <ModalLayer onClose={() => setRefereeing(false)}>
        <RefereeGuide guide={guide} onClose={() => setRefereeing(false)} />
      </ModalLayer>
    ) : reviewing && review ? (
      peeking ? (
        <ReviewPeekBar
          title={review.title}
          onMoves={() => setPeeking(false)}
          onClose={closeReview}
        />
      ) : (
        <ModalLayer onClose={closeReview}>
          <ReviewOverlay
            plan={review}
            deadlineAt={state?.deadlineAt}
            onClose={closeReview}
            onReferee={guide ? () => setRefereeing(true) : undefined}
            onMap={() => setPeeking(true)}
          />
        </ModalLayer>
      )
    ) : null}
    </>
  );
}
