import { useEffect, useMemo, useRef, useState } from "react";
import {
  ApiError,
  GmClient,
  fetchVariants,
  mintHandover,
  resultsUrl,
  watchPath,
  type DrawProposal,
  type GameResult,
  type GmSeat,
  type GmState,
  type Handover,
  type Settings,
} from "../api";
import { GmKeyCard } from "../components/GmKeyCard";
import { PressPanel } from "../components/PressPanel";
import { readStoredKey } from "../gmkey";
import { GM_HOLDER, gmPressSecret, gmSigner } from "../press";
import { LinkShare } from "../components/LinkShare";
import { writeRecentGame } from "../recent";
import { setPowerPalette, setProvinceNames } from "../board/provinces";
import { PowerChip } from "../components/PowerChip";
import { countdown, settingsLines, useGameEvents, usePoll, useRefreshAt, useTicker } from "../hooks";
import { StylePicker, useMapStyle } from "../components/StylePicker";
import { PhaseName } from "../components/PhaseName";
import { illegalAllowed } from "../illegal";
import { SupportedMark } from "../components/SupportedMark";
import { StaleBuild } from "../components/StaleBuild";
import { noteBuild } from "../build";
import { noteServerTime } from "../clock";
import { Clock } from "../components/Clock";
import { ReviewOverlay } from "../components/ReviewOverlay";
import { GameOver } from "../components/GameOver";
import { RefereeGuide } from "../components/RefereeGuide";
import { ModalLayer } from "../components/ModalLayer";
import { refereeGuide } from "../referee";
import { dismiss, isDismissed, reviewKey, reviewPlan } from "../review";
import { EndYearField } from "../components/EndYearField";

/*
The game master's screen: the rules, the invite, how many have joined, who has
locked, and the two gated actions — start, and force adjudication. It holds
no orders and never can: the GM state carries booleans only.

Before the start it is the waiting room. The joined count is the largest thing
on it, because that is what a game master watches across a table while the
phones come in, and the invite stands open beside it with its QR, because
filling the seats is then the whole job. The count is live: the poll below runs
on arrival and every three seconds after it.

While seats are still open the count is all there is. A per-power list would
say which powers are taken, and the order they were taken in, on a screen the
whole table can read (ADR-013) — and seats are anonymous (ADR-020). The player
waiting screen shows a count for that reason, so this one does too. The list
appears when the last seat is claimed: from then on every power is in it and
it names no order.
*/
/*
Ending the game in a draw the table agreed (ADR-044, ADR-007).

The app cannot know that seven people shook hands, so this is the game master
writing down what happened in the room. It is behind a fold and behind a
confirm because it is not undoable: a game with a result is frozen and no
phase follows it.

Only powers still holding a supply centre may be named, which the server
enforces too. One power is a concession, and that is a real thing at a table.
*/
function DrawCard({ seats, result, proposal, onDraw, onWithdraw }: {
  seats: GmSeat[];
  result?: GameResult | null;
  proposal?: DrawProposal | null;
  onDraw: (powers: string[]) => void;
  onWithdraw: () => void;
}) {
  const [picked, setPicked] = useState<string[]>([]);
  const [confirming, setConfirming] = useState(false);

  if (result) return null;

  const survivors = seats.filter((seat) => (seat.centres ?? 1) > 0);
  const toggle = (power: string) =>
    setPicked((was) =>
      was.includes(power) ? was.filter((p) => p !== power) : was.concat(power),
    );

  return (
    <details className="card">
      <summary>End the game</summary>
      {proposal ? (
        <div className="draw-confirm">
          <p>Proposed result: <strong>{proposal.powers.join(", ")}</strong>.</p>
          <p className="note">
            Waiting for the excluded {proposal.required.length === 1 ? "power" : "powers"}: {" "}
            {proposal.required.map((power) =>
              proposal.confirmed.includes(power) ? power + " (confirmed)" : power,
            ).join(", ")}.
          </p>
          <button type="button" onClick={onWithdraw}>Withdraw proposal</button>
        </div>
      ) : (
        <>
      <p className="note">
        Include every surviving power for an agreed draw. Leaving a survivor out
        asks that power to confirm the exclusion on their own board. A solo is
        detected automatically.
      </p>
      <ul className="draw-picks">
        {survivors.map((seat) => (
          <li key={seat.power}>
            <label>
              <input
                type="checkbox"
                checked={picked.includes(seat.power)}
                onChange={() => toggle(seat.power)}
              />
              <PowerChip power={seat.power} small />
            </label>
          </li>
        ))}
      </ul>
      {confirming ? (
        <p className="draw-confirm">
          <span>
            {picked.length === survivors.length
              ? "This freezes the board and records the draw immediately."
              : "The game continues until every excluded survivor confirms."}
          </span>{" "}
          <button type="button" onClick={() => { onDraw(picked); setConfirming(false); }}>
            {picked.length === survivors.length ? "Record draw" : "Send proposal"}
          </button>{" "}
          <button type="button" onClick={() => setConfirming(false)}>
            Cancel
          </button>
        </p>
      ) : (
        <button type="button" disabled={!picked.length} onClick={() => setConfirming(true)}>
          {picked.length === survivors.length ? "Record agreed draw" : "Propose this result"}
        </button>
      )}
      <p className="note">
        A recorded result cannot be undone. Eliminated powers are not part of a draw.
      </p>
        </>
      )}
    </details>
  );
}

export function GmPage({ gameId, gmToken }: { gameId: string; gmToken: string }) {
  const client = useMemo(() => new GmClient(gameId, gmToken), [gameId, gmToken]);

  const [game, setGame] = useState<GmState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /* The link the game master last minted from a row of the Powers card, and
     what went wrong if nothing came back (ADR-041). */
  const [handover, setHandover] = useState<Handover | null>(null);
  const [handoverError, setHandoverError] = useState<string | null>(null);
  /* The two handover links the game master's own screen shows (ADR-041): the
     role, and the power they play once the start has dealt them one. They are
     separate pieces of state because they are separate acts, and the wording
     beside each has to be able to differ. */
  const [role, setRole] = useState<Handover | null>(null);
  /* The role's link again, shown beside a row of the Powers card when that
     row is the game master's own. It is its own piece of state so the card
     above and the row below never fight over one box. */
  const [rowRole, setRowRole] = useState<Handover | null>(null);
  const [confirmingForce, setConfirmingForce] = useState(false);

  /* The way back to this screen, for the bar on every ordinary page (ADR-043).
     A game master is the one person who cannot be handed their link again. */
  const gameLabel = game?.settings?.name || gameId;
  const loaded = Boolean(game);
  useEffect(() => {
    // On the identity, never on the poll: this page reloads its state every
    // few seconds, and a tab left open in the background would otherwise keep
    // overwriting whichever game the person is actually looking at.
    if (!loaded) return;
    writeRecentGame({ url: window.location.pathname, label: gameLabel });
  }, [loaded, gameId, gameLabel]);
  /*
  The two codes the Hand over card shows (ADR-041).

  They are fetched once rather than on a press, because a card that has to be
  clicked twice to show two codes is a card that gets shown one at a time by
  mistake. The role's link is there from the start; the power's appears when
  the start deals the game master one (ADR-021), which is what the second
  dependency watches for.
  */
  useEffect(() => {
    client
      .roleHandover()
      .then(setRole)
      .catch(() => setRole(null));
  }, [client]);
  const [gone, setGone] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [refereeing, setRefereeing] = useState(false);
  const [style, setStyle] = useMapStyle();

  const refresh = async () => {
    try {
      const next = await client.state();
      // The variant's own names and colours, before anything is drawn with
      // them; then the server's clock, which every countdown is measured
      // against.
      setProvinceNames(next.provinceNames);
      setPowerPalette(next.seats.map((seat) => seat.power));
      noteServerTime(next.now);
      noteBuild(next.build);
      setGame(next);
      setGone(false);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) setGone(true);
      throw err;
    }
  };

  const live = useGameEvents(client.eventsUrl, refresh, !gone);
  useRefreshAt(game?.graceUntil, refresh, live);
  usePoll(3000, refresh, !gone && !live);
  useTicker(Boolean(game?.deadlineAt));

  /*
  The phase that just resolved. The game master reads it on the same terms as
  every player: it opens once per adjudication on this device, and closing it
  puts it away here and nowhere else.
  */
  const review = useMemo(() => reviewPlan(game?.previousPhase), [game?.previousPhase]);
  /*
  The same adjudication, as physical acts. The game master's laptop is the
  screen the piece pusher stands at, so this is the page the guide matters
  most on — and it carries no order content the review does not, so ADR-013
  holds.
  */
  const guide = useMemo(() => refereeGuide(game?.previousPhase), [game?.previousPhase]);
  const seenKey = review ? reviewKey(gameId, game?.previousPhase) : "";
  const readKey = useRef<string | null>(null);

  useEffect(() => {
    if (!seenKey || readKey.current === seenKey) return;
    readKey.current = seenKey;
    setReviewing(!isDismissed(seenKey));
  }, [seenKey]);

  const closeReview = () => {
    if (seenKey) dismiss(seenKey);
    setReviewing(false);
  };

  const act = async (label: string, run: () => Promise<unknown>) => {
    setError(null);
    setNotice(null);
    try {
      await run();
      setNotice(label);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  if (gone) {
    return (
      <main className="page">
        <h1>Game not found</h1>
        <p>This link is wrong, the game is not on this server, or your game-master access has changed.</p>
      </main>
    );
  }

  if (!game) {
    return (
      <main className="page">
        <h1>Game master</h1>
        <p className="muted">Reading the game…</p>
      </main>
    );
  }

  const lockedCount = game.seats.filter((seat) => seat.locked).length;
  const allJoined = game.joinedCount >= game.totalSeats;

  /*
  The two halves of awaitingReveal, which the game master acts on differently
  (ADR-009).

  A seat that locked in holds the only key to an envelope the server already
  has, so waking that phone still saves its orders. A seat that never locked
  has nothing to wake: the window opened on the deadline instead, and the only
  way past it is to extend or to force, which makes that power an NMR.
  */
  const awaiting = new Set(game.awaitingReveal || []);
  const waiting = game.seats.filter((seat) => awaiting.has(seat.power));
  const asleep = waiting.filter((seat) => seat.locked).map((seat) => seat.power);
  const silent = waiting.filter((seat) => !seat.locked).map((seat) => seat.power);

  // The review and the guide are read, not acted on. While one is open the
  // controls behind it — the start, the extend, the forced adjudication — are
  // inert, so the only button on screen is the one that closes what is open.
  const reading = (refereeing && Boolean(guide)) || (reviewing && Boolean(review));
  const inviteUrl = new URL(game.inviteUrl, location.href).toString();
  const inviteHost = new URL(inviteUrl).hostname;
  const localOnlyInvite =
    inviteHost === "localhost" || inviteHost === "::1" || inviteHost === "::" ||
    inviteHost === "0.0.0.0" || /^127\./.test(inviteHost);
  const spectatorUrl = new URL(watchPath(gameId, null), location.origin).toString();

  return (
    <>
    <StaleBuild beat={game} />
    <main className="page wide" inert={reading || undefined}>
      <header className="page-head">
        <div>
          <h1>Game master</h1>
          {/* What the table calls this game, when it was named. A game master
              running two tables tells them apart here and on the game list. */}
          {game.settings.name ? <p className="game-name">{game.settings.name}</p> : null}
          {/* The phase, at the size the room reads it at — the same line the
              players carry at the top of their own boards. */}
          <p className="phase-now">
            {game.started ? <PhaseName phase={game.phase} /> : "The game has not started"}
          </p>
          <p className="muted">Game {game.gameId}</p>
          {game.variant ? (
            <p className="variant-line">
              <strong>{game.variant.name}</strong> <SupportedMark supported={game.variant.supported} />
            </p>
          ) : null}
        </div>
        <Clock deadlineAt={game.deadlineAt} />
        {game.started && game.gmPower ? (
          <p className="you-are">
            You are <strong>{game.gmPower}</strong>
            {game.gmSeatUrl ? (
              <>
                {" "}
                — <a href={game.gmSeatUrl}>open your board</a>
              </>
            ) : null}
          </p>
        ) : null}
      </header>

      {/*
      The screen for the rest of the room. This page names who holds which
      power, so it is the game master's alone; the spectator view is the same
      board with no seats in it and no token of any kind (ADR-013), which is
      what may go on a shared screen.
      */}
      <p className="head-links">
        <a className="link" href={spectatorUrl} target="_blank" rel="noreferrer">
          Open the spectator view
        </a>
        <span className="note">
          The board alone, for a shared screen. It names no player and gives no orders.
        </span>
      </p>

      {error ? <p className="error">{error}</p> : null}
      {notice ? <p className="notice">{notice}</p> : null}

      {review && !reviewing && !refereeing ? (
        <p className="head-links">
          <button type="button" className="link" onClick={() => setReviewing(true)}>
            Review last phase
          </button>
          {guide ? (
            <button type="button" className="link" onClick={() => setRefereeing(true)}>
              Move the pieces
            </button>
          ) : null}
        </p>
      ) : null}

      {/*
      The waiting room. The count is the headline, in the size a table reads
      it at, and the invite sits under it with its QR: before the start there
      is nothing else on this screen worth as much room.
      */}
      {!game.started ? (
        <section className="card lobby">
          <p className="joined-big">
            <strong>{game.joinedCount}</strong> of {game.totalSeats} players joined
          </p>
          {!allJoined ? (
            <p className="note">
              Which power each phone took is not shown while seats are open. The powers
              are listed once they are all claimed.
            </p>
          ) : null}
          <button
            type="button"
            className="primary"
            disabled={!allJoined}
            onClick={() => act("The game has started.", () => client.start())}
          >
            {allJoined ? "Start the game" : "Waiting for every power"}
          </button>
          {localOnlyInvite ? (
            <p className="banner error">
              This invite only opens on this computer. Restart with BASE_URL set to an
              address that players' phones can reach before seating the table.
            </p>
          ) : (
            <LinkShare
              title="Invite link"
              url={inviteUrl}
              note="Scan it once from a player's phone before seating the table. Each phone gets a power."
            />
          )}
          {/*
          The one handover that exists before the start. There is no list of
          powers yet, so this is the only place the role can be given away;
          once the game runs, every handover lives on its own power's row and
          this card is gone.
          */}
          {role ? (
            <LinkShare
              private
              title="Hand the game master role to somebody else"
              url={role.url}
              note="Whoever opens this runs the game. You stop being the game master the moment they do."
            />
          ) : null}
        </section>
      ) : null}

      {/*
      The powers, once they are all claimed. One row is one power, and the row
      is where the game master reaches it: today that is the handover of
      ADR-041, which is here rather than on the seat because the case it exists
      for is a phone that cannot open its own menu any more.
      */}
      {allJoined ? (
        <section className="card">
          <h2>Powers</h2>
          <ul className="seats">
            {game.seats.map((seat) => (
              <li key={seat.power} className="seat">
                <PowerChip power={seat.power} />
                {seat.isGm ? <span className="badge gm">Game master</span> : null}
                {game.started ? (
                  <span className={seat.locked ? "badge done" : "badge out"}>
                    {seat.locked ? "Ready" : "Still ordering"}
                  </span>
                ) : null}
                <button
                  type="button"
                  className="link"
                  onClick={() => {
                    setHandover(null);
                    setRowRole(null);
                    setHandoverError(null);
                    const fail = (err: unknown) =>
                      setHandoverError(err instanceof Error ? err.message : String(err));
                    mintHandover(gameId, gmToken, seat.power).then(setHandover).catch(fail);
                    // The game master's own row holds two things, not one: the
                    // seat and the role are handed on separately (ADR-041), so
                    // that row answers with both codes.
                    if (seat.isGm) client.roleHandover().then(setRowRole).catch(fail);
                  }}
                >
                  Hand over
                </button>
              </li>
            ))}
          </ul>
          {/*
          The link the game master just minted. It is one at a time on purpose:
          two codes on one screen is how the wrong seat gets handed over.
          Minting is an enumerated, logged act (ADR-007) and appears in the log
          below, because a game master who can mint for any power can take any
          seat and the record is what keeps that visible.
          */}
          {handoverError ? <p className="error">{handoverError}</p> : null}
          <div className="handovers">
            {handover ? (
              <LinkShare
                private
                title={"Hand " + handover.power + " to another phone"}
                url={handover.url}
                note={
                  <>
                    Whoever opens this takes {handover.power}. The device holding it now
                    loses the seat the moment they do. Any orders {handover.power} entered
                    on the old device this phase are lost. When the player initiates the
                    move from their own seat, locked orders can travel with it. Use this
                    for device recovery or a replacement allowed by your house or tournament rules.
                  </>
                }
              />
            ) : null}
            {rowRole ? (
              <LinkShare
                private
                title="The game master role"
                url={rowRole.url}
                note={
                  <>
                    Whoever opens this becomes the table's game master. They may already
                    hold a power; the role and the power remain separate.
                  </>
                }
              />
            ) : null}
          </div>
          {/* Before the start the count is the headline above; here only the
              running game needs a line, and it counts every power in play. */}
          {game.started ? (
            <p className="muted">
              {game.seats.filter((seat) => seat.joined).length} powers in play ·{" "}
              {lockedCount} players ready
            </p>
          ) : null}
        </section>
      ) : null}


      {/*
      The backup, which is the opposite act to a handover (ADR-048).

      Every other credential card here gives something away and takes it off
      this device. This one gives nothing away and holds one thing: the twelve
      words. It used to offer this page's address beside them, which made a
      third card that looked like the two handover cards and was not one.

      The address was the weaker copy anyway. It dies with the next handover
      or recovery, and it is already in this browser's history and address bar.
      The words survive both, and any device can type them.
      */}
      {/*
      The referee's mailbox (ADR-054), and only in a game whose game master
      does not play and was declared to read press.

      It is folded away and it says why on the outside. ADR-013 makes the game
      master view safe on a shared screen, and the board still is; this one
      screen is not, so it takes a deliberate tap to open and warns before it
      does.
      */}
      {game.pressReads ? (
        <details className="card">
          <summary>Messages between the powers</summary>
          <p className="note">
            Everything the powers have written to each other. Do not open this on
            a screen the table can see. You read every room and speak only in the
            ones you open yourself.
          </p>
          <GmMailbox
            gameId={gameId}
            client={client}
            phaseIndex={game.phaseIndex ?? 0}
            powers={game.seats.map((seat) => seat.power)}
          />
        </details>
      ) : null}

      <details className="card">
        <summary>Back up the game master key</summary>
        <p className="note">
          This gives nothing away. There is no account here and no password to reset, so
          the words are the only copy of this role that outlives this browser.
        </p>
        <GmKeyCard
          gameId={gameId}
          client={client}
          hasKey={Boolean(game.hasGmKey)}
          onMade={() => {
            refresh().catch(() => setError("The key was made, but the page could not reload."));
          }}
        />
      </details>

      {/*
      The invite, folded away once the game runs — before the start it is open
      in the waiting room above. It is needed again exactly when someone has
      left their seat page: opened on their own phone, the join hands them
      their own power back.
      */}
      {game.started ? (
        <details className="card">
          <summary>Invite link and QR code</summary>
          <LinkShare
            private
            title="Invite link"
            url={inviteUrl}
            note="A player who opens this on their own phone lands back on their power. On a new device it takes the next free one."
          />
        </details>
      ) : null}

      {/* The result, first, because a finished game has nothing else worth
          reading at the top of this page (ADR-044). */}
      <GameOver result={game.result} />

      <SettingsCard
        settings={game.settings}
        started={game.started}
        hasKey={Boolean(game.hasGmKey)}
        onSave={(patch) => act("The rules were changed.", () => client.settings(patch))}
      />

      {game.started && !game.result ? (
        <section className="card">
          <h2>The clock</h2>
          <p>{countdown(game.deadlineAt)}</p>
          <ExtendRow onExtend={(minutes) => act("The deadline moved.", () => client.extend(minutes))} />
          {confirmingForce ? (
            <p className="draw-confirm">
              <span>
                This resolves now. Every unrevealed or unready power records an NMR and
                receives no submitted orders.
              </span>{" "}
              <button type="button" onClick={() => {
                setConfirmingForce(false);
                act("The phase was adjudicated.", () => client.force());
              }}>
                Force this phase
              </button>{" "}
              <button type="button" onClick={() => setConfirmingForce(false)}>Cancel</button>
            </p>
          ) : (
            <button type="button" disabled={!game.canForce} onClick={() => setConfirmingForce(true)}>
              Force adjudication
            </button>
          )}
          <p className="note">
            {game.canForce
              ? "Powers that are not ready or have not revealed record an NMR."
              : "Available after the deadline and any grace period have passed."}
          </p>
          {/*
          A phone that locked in and then died holds the only copy of its
          orders (ADR-004), so the board cannot resolve without it. The game
          master's three ways out are wait, extend, and force — and forcing
          writes an NMR against exactly the seats named here (ADR-009).
          */}
          {game.revealOpen && asleep.length ? (
            <p className="note reveal-wait">
              {silent.length
                ? "The deadline has passed and the orders are going up."
                : "Every power is ready."}{" "}
              Still waiting for {asleep.join(", ")} to send their orders — ask them to
              wake the phone, or force the phase and record an NMR.
            </p>
          ) : null}
          {/*
          A seat that never locked in has no envelope on the server, so no
          phone can save it. Waking it is not the way out; extending the
          deadline or forcing the phase is.
          */}
          {game.revealOpen && silent.length ? (
            <p className="note reveal-wait">
              {silent.join(", ")} was not ready before the deadline, so there is
              nothing to send for {silent.length === 1 ? "that seat" : "those seats"}.
              Extend the deadline, or force the phase and record an NMR.
            </p>
          ) : null}
        </section>
      ) : null}

      {game.started ? (
        <DrawCard
          seats={game.seats}
          result={game.result}
          proposal={game.drawProposal}
          onDraw={(powers) => act("The draw decision was recorded.", () => client.draw(powers))}
          onWithdraw={() => act("The draw proposal was withdrawn.", () => client.drawWithdraw())}
        />
      ) : null}

      {/* What a tournament director takes away (ADR-046). Public addresses,
          so the link works from their machine and not only from this one. */}
      {game.started ? (
        <section className="card">
          <h2>Supply centre counts</h2>
          <p className="note">
            Every year, every power, as a file. dipvis and any other scoring
            tool can read these addresses without an account.
          </p>
          <p className="results-links">
            <a href={resultsUrl(gameId, "csv")}>results.csv</a>{" "}
            <a href={resultsUrl(gameId, "json")}>results.json</a>
          </p>
        </section>
      ) : null}

      {/*
      This device, not this game. The style is presentation: it belongs to the
      screen looking at the map, so the game master's laptop and a player's
      phone can each draw the board the way that room needs. Saved here, it is
      the style the game master's own board opens in.
      */}
      <section className="card">
        <h2>This device</h2>
        <StylePicker value={style} onChange={setStyle} />
        <p className="note">
          Only this screen. It changes nothing any other player sees, and nothing about the game.
        </p>
      </section>

      {game.events && game.events.length ? (
        <section className="card">
          <h2>What happened</h2>
          <ul className="events">
            {game.events
              .slice()
              .reverse()
              .map((line, i) => (
                <li key={game.events!.length - i}>{line}</li>
              ))}
          </ul>
        </section>
      ) : null}
    </main>

    {refereeing && guide ? (
      <ModalLayer onClose={() => setRefereeing(false)}>
        <RefereeGuide guide={guide} onClose={() => setRefereeing(false)} />
      </ModalLayer>
    ) : reviewing && review ? (
      <ModalLayer onClose={closeReview}>
        <ReviewOverlay
          plan={review}
          deadlineAt={game.deadlineAt}
          onClose={closeReview}
          onReferee={guide ? () => setRefereeing(true) : undefined}
        />
      </ModalLayer>
    ) : null}
    </>
  );
}

/* The rules editor. gmPlays decides how many powers are held for joiners, so
   the server freezes it once the game starts. */
function SettingsCard({
  settings,
  started,
  hasKey,
  onSave,
}: {
  settings: Settings;
  started: boolean;
  /* Whether this game has a game master key (ADR-048). The mailbox is opened
     with it, so the setting that fills the mailbox needs one first. */
  hasKey: boolean;
  onSave: (patch: Partial<Settings> & { deadlineMinutes: number }) => void;
}) {
  const [minutes, setMinutes] = useState(settings.deadlineMinutes);
  const [retreatPercent, setRetreatPercent] = useState(settings.retreatBuildPercent ?? 50);
  const [grace, setGrace] = useState(settings.graceMinutes ?? 0);
  const [firstExtra, setFirstExtra] = useState(settings.firstTurnExtraMinutes ?? 0);
  const [pressMode, setPressMode] = useState(settings.pressMode ?? "ftf");
  const [silence, setSilence] = useState(settings.pressSilenceSeconds ?? 60);
  const [gmReads, setGmReads] = useState(Boolean(settings.gmReadsPress));
  const [plays, setPlays] = useState(settings.gmPlays);
  const allowIllegal = illegalAllowed(settings);
  const [illegal, setIllegal] = useState(allowIllegal);
  const savedEndYear = settings.endYear || 0;
  const [endYearEnabled, setEndYearEnabled] = useState(savedEndYear > 0);
  const [endYear, setEndYear] = useState<number | "">(savedEndYear || "");
  const [startYear, setStartYear] = useState(0);

  // A change made from another device wins over an untouched form.
  useEffect(() => setMinutes(settings.deadlineMinutes), [settings.deadlineMinutes]);
  useEffect(() => setRetreatPercent(settings.retreatBuildPercent ?? 50), [settings.retreatBuildPercent]);
  useEffect(() => setGrace(settings.graceMinutes ?? 0), [settings.graceMinutes]);
  useEffect(() => setFirstExtra(settings.firstTurnExtraMinutes ?? 0), [settings.firstTurnExtraMinutes]);
  useEffect(() => setPressMode(settings.pressMode ?? "ftf"), [settings.pressMode]);
  useEffect(() => setSilence(settings.pressSilenceSeconds ?? 60), [settings.pressSilenceSeconds]);
  useEffect(() => setGmReads(Boolean(settings.gmReadsPress)), [settings.gmReadsPress]);
  useEffect(() => setPlays(settings.gmPlays), [settings.gmPlays]);
  useEffect(() => setIllegal(allowIllegal), [allowIllegal]);
  useEffect(() => {
    setEndYearEnabled(savedEndYear > 0);
    setEndYear(savedEndYear || "");
  }, [savedEndYear]);
  useEffect(() => {
    let cancelled = false;
    fetchVariants()
      .then((variants) => {
        const variant = variants.find((one) => one.key === (settings.variant || "classical"));
        if (!cancelled) setStartYear(variant?.startYear || 0);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [settings.variant]);

  const dirty =
    minutes !== settings.deadlineMinutes ||
    retreatPercent !== (settings.retreatBuildPercent ?? 50) ||
    grace !== (settings.graceMinutes ?? 0) ||
    firstExtra !== (settings.firstTurnExtraMinutes ?? 0) ||
    pressMode !== (settings.pressMode ?? "ftf") ||
    silence !== (settings.pressSilenceSeconds ?? 60) ||
    gmReads !== Boolean(settings.gmReadsPress) ||
    plays !== settings.gmPlays ||
    (endYearEnabled ? Number(endYear) || 0 : 0) !== savedEndYear ||
    illegal !== allowIllegal;
  const endYearValid = !endYearEnabled || (
    Number.isFinite(Number(endYear)) &&
    Number(endYear) >= (startYear || 1) &&
    Number(endYear) <= 9999
  );

  return (
    <section className="card">
      <h2>The rules</h2>
      {settingsLines(settings).map((line) => (
        <p key={line} className="muted">
          {line}
        </p>
      ))}
      <label className="field">
        <span>Minutes for movement phases</span>
        <input
          type="number"
          min={0}
          max={1440}
          inputMode="numeric"
          value={minutes}
          onChange={(event) => setMinutes(Number(event.target.value))}
        />
      </label>
      <details>
        <summary>Clock details</summary>
        <label className="field">
          <span>Retreat and adjustment clock (%)</span>
          <input type="number" min={1} max={100} inputMode="numeric" value={retreatPercent}
            onChange={(event) => setRetreatPercent(Number(event.target.value))} />
        </label>
        <label className="field">
          <span>Grace after deadline (minutes)</span>
          <input type="number" min={0} max={600} inputMode="numeric" value={grace}
            onChange={(event) => setGrace(Number(event.target.value))} />
        </label>
        <label className="field">
          <span>Extra time for Spring 1901 (minutes)</span>
          <input type="number" min={0} max={600} inputMode="numeric" value={firstExtra}
            onChange={(event) => setFirstExtra(Number(event.target.value))} />
        </label>
      </details>
      <label className="field">
        <span>Negotiation rule</span>
        <select value={pressMode} disabled={started} onChange={(event) =>
          setPressMode(event.target.value as NonNullable<Settings["pressMode"]>)}>
          <option value="ftf">Face-to-face negotiations</option>
          <option value="gunboat">Gunboat, no negotiation</option>
          <option value="rulebook">In-app messages, movement phases only</option>
          <option value="fullpress">In-app messages, every phase</option>
        </select>
        <small>
          {started
            ? "Fixed once the game has started."
            : pressMode === "rulebook"
              ? "Messages during movement phases only, and none during retreats and builds."
              : pressMode === "fullpress"
                ? "Messages in every phase. Best for a table that is not in one room."
                : "Negotiation happens in person. This app carries no messages."}
        </small>
      </label>
      {/* The two settings that only mean something once the app carries
          messages (ADR-054, ADR-055). */}
      {pressMode === "rulebook" || pressMode === "fullpress" ? (
        <>
          <label className="field">
            <span>Writing time (seconds)</span>
            <input type="number" min={0} max={600} inputMode="numeric" value={silence}
              onChange={(event) => setSilence(Number(event.target.value))} />
            <small>
              Messages close this long before the deadline, so the last of the
              phase is for writing orders.
            </small>
          </label>
          <label className="field check">
            <input
              type="checkbox"
              checked={!plays && gmReads}
              disabled={started || plays || !hasKey}
              onChange={(event) => setGmReads(event.target.checked)}
            />
            <span>The game master reads every message</span>
            <small>
              {started
                ? "Fixed once the game has started: the room keys already sent name who can read them."
                : plays
                  ? "Only a game master who does not play may be offered this."
                  : !hasKey
                    ? "Make the game master key first — the mailbox is opened with it."
                    : "The referee is in every conversation, and the join page says so."}
            </small>
          </label>
        </>
      ) : null}
      <EndYearField
        enabled={endYearEnabled}
        year={endYear}
        startYear={startYear}
        onEnabledChange={setEndYearEnabled}
        onYearChange={setEndYear}
      />
      <label className="field check">
        <input
          type="checkbox"
          checked={plays}
          disabled={started}
          onChange={(event) => setPlays(event.target.checked)}
        />
        <span>The game master plays a power</span>
        {started ? <small>Fixed once the game has started.</small> : null}
      </label>
      <label className="field check">
        <input
          type="checkbox"
          checked={illegal}
          onChange={(event) => setIllegal(event.target.checked)}
        />
        <span>Accept orders exactly as entered</span>
        <small>Invalid orders fail under the rules instead of being blocked during entry.</small>
      </label>
      <button
        type="button"
        disabled={!dirty || !endYearValid}
        onClick={() =>
          onSave(
            started
              ? {
                  deadlineMinutes: Math.max(0, Math.floor(minutes) || 0),
                  retreatBuildPercent: Math.max(1, Math.min(100, Math.floor(retreatPercent) || 50)),
                  graceMinutes: Math.max(0, Math.floor(grace) || 0),
                  firstTurnExtraMinutes: Math.max(0, Math.floor(firstExtra) || 0),
                  illegalMoves: illegal,
                  pressSilenceSeconds: Math.max(0, Math.floor(silence) || 0),
                  endYear: endYearEnabled ? Math.max(0, Math.floor(Number(endYear)) || 0) : 0,
                }
              : {
                  deadlineMinutes: Math.max(0, Math.floor(minutes) || 0),
                  retreatBuildPercent: Math.max(1, Math.min(100, Math.floor(retreatPercent) || 50)),
                  graceMinutes: Math.max(0, Math.floor(grace) || 0),
                  firstTurnExtraMinutes: Math.max(0, Math.floor(firstExtra) || 0),
                  pressMode: pressMode,
                  pressSilenceSeconds: Math.max(0, Math.floor(silence) || 0),
                  gmReadsPress: !plays && gmReads,
                  gmPlays: plays,
                  illegalMoves: illegal,
                  endYear: endYearEnabled ? Math.max(0, Math.floor(Number(endYear)) || 0) : 0,
                },
          )
        }
      >
        Save the rules
      </button>
      <p className="note">Every player sees a "the rules changed" banner.</p>
    </section>
  );
}

/*
The referee's mailbox, which is the press panel with the game master's keys.

The box key and the signature both come from the key of ADR-048, so the twelve
words recover the mailbox with the game, and a ruling is checked against the
same public half that proves who the game master is. A game master whose
browser has lost the key sees nothing it can open, and the words are the way
back.
*/
function GmMailbox({
  gameId,
  client,
  phaseIndex,
  powers,
}: {
  gameId: string;
  client: GmClient;
  phaseIndex: number;
  powers: string[];
}) {
  const entropy = useMemo(() => readStoredKey(gameId), [gameId]);
  const secret = useMemo(() => gmPressSecret(gameId, entropy), [gameId, entropy]);
  const sign = useMemo(() => gmSigner(entropy), [entropy]);
  if (!entropy) {
    return (
      <p className="notice">
        This browser does not hold the game master key, so it cannot open any of
        these rooms. Recover it with the twelve words.
      </p>
    );
  }
  return (
    <PressPanel
      gameId={gameId}
      you={GM_HOLDER}
      api={client}
      secret={secret}
      sign={sign}
      phaseIndex={phaseIndex}
      powers={powers}
      readOnly
    />
  );
}

function ExtendRow({ onExtend }: { onExtend: (minutes: number) => void }) {
  const [minutes, setMinutes] = useState(5);
  return (
    <div className="row">
      <label className="field inline">
        <span>Extend by</span>
        <input
          type="number"
          min={1}
          max={600}
          inputMode="numeric"
          value={minutes}
          onChange={(event) => setMinutes(Number(event.target.value))}
        />
        <span>minutes</span>
      </label>
      <button type="button" onClick={() => onExtend(Math.max(1, Math.floor(minutes) || 1))}>
        Extend
      </button>
    </div>
  );
}
