import { useEffect, useMemo, useRef, useState } from "react";
import {
  ApiError,
  GmClient,
  mintHandover,
  watchPath,
  type GmState,
  type Handover,
} from "../api";
import { GmKeyCard } from "../components/GmKeyCard";
import { LinkShare } from "../components/LinkShare";
import { writeRecentGame } from "../recent";
import { setPowerPalette, setProvinceNames } from "../board/provinces";
import { PowerChip } from "../components/PowerChip";
import { countdown, settingsLines, usePoll, useTicker } from "../hooks";
import { StylePicker, useMapStyle } from "../components/StylePicker";
import { PhaseName } from "../components/PhaseName";
import { illegalAllowed } from "../illegal";
import { SupportedMark } from "../components/SupportedMark";
import { StaleBuild } from "../components/StaleBuild";
import { noteBuild } from "../build";
import { noteServerTime } from "../clock";
import { Clock } from "../components/Clock";
import { ReviewOverlay } from "../components/ReviewOverlay";
import { RefereeGuide } from "../components/RefereeGuide";
import { ModalLayer } from "../components/ModalLayer";
import { refereeGuide } from "../referee";
import { dismiss, isDismissed, reviewKey, reviewPlan } from "../review";

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
  const [ownSeat, setOwnSeat] = useState<Handover | null>(null);
  /* The role's link again, shown beside a row of the Powers card when that
     row is the game master's own. It is its own piece of state so the card
     above and the row below never fight over one box. */
  const [rowRole, setRowRole] = useState<Handover | null>(null);

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
  const gmPower = game?.gmPower || "";
  useEffect(() => {
    client
      .roleHandover()
      .then(setRole)
      .catch(() => setRole(null));
  }, [client]);
  useEffect(() => {
    if (!gmPower) {
      setOwnSeat(null);
      return;
    }
    mintHandover(gameId, gmToken, gmPower)
      .then(setOwnSeat)
      .catch(() => setOwnSeat(null));
  }, [gameId, gmToken, gmPower]);
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

  usePoll(3000, refresh, !gone);
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
        <p>This link is wrong, or the game is gone. Games live only as long as the server runs.</p>
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

  // The review and the guide are read, not acted on. While one is open the
  // controls behind it — the start, the extend, the forced adjudication — are
  // inert, so the only button on screen is the one that closes what is open.
  const reading = (refereeing && Boolean(guide)) || (reviewing && Boolean(review));
  const inviteUrl = new URL(game.inviteUrl, location.href).toString();
  // This page's own address, which is the role itself. It is read from the
  // browser rather than built, because the token is only ever here.
  const selfUrl = window.location.href;
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
            Review last turn
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
          <LinkShare
            title="Invite link"
            url={inviteUrl}
            note="Pass the phone around, or let the players scan this. Each one gets a power."
          />
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
                    {seat.locked ? "Locked in" : "Still ordering"}
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
                    Whoever opens this takes {handover.power}. The phone holding it now
                    loses the seat the moment they do.
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
                    That row is your own, and it holds two things. This one hands on the
                    rights; the code beside it hands on the seat.
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
              {lockedCount} players locked in
            </p>
          ) : null}
        </section>
      ) : null}

      {/*
      The two handovers, which are two acts and not one (ADR-041). The role and
      the power fail differently: a game master who gives away their power
      still runs the game, and one who gives away the role and keeps their
      power becomes an ordinary player. So there are two codes, side by side,
      worded differently and never merged into one.

      Before the start there is only one, because there is no power yet: the
      game master plays the leftover and it is dealt when the game begins
      (ADR-021). The card says so rather than showing an empty box.
      */}
      <details className="card">
        <summary>Hand over</summary>
        <p className="note">
          The role is the rights: the deadline, the start, forcing a phase, handing out
          seats. The power is a seat at the board. Handing over one leaves the other
          exactly where it is.
        </p>
        <p className="note">
          Both are hidden until you ask for them. Either one gives away what it names to
          whoever reads it off the screen, and this screen is often the one on the beamer.
        </p>
        {handoverError ? <p className="error">{handoverError}</p> : null}
        <div className="handovers">
          {role ? (
            <LinkShare
              private
              title="The game master role"
              url={role.url}
              note={
                <>
                  Whoever opens this runs the game. You stop being the game master the
                  moment they do, and keep whatever power you play.
                </>
              }
            />
          ) : null}
          {ownSeat ? (
            <LinkShare
              private
              title={"Your power · " + ownSeat.power}
              url={ownSeat.url}
              note={
                <>
                  Whoever opens this plays {ownSeat.power}. You keep the game master role
                  and stop having a seat at the board.
                </>
              }
            />
          ) : game.gmPower ? null : (
            <p className="note">
              You get a power when the game starts: the game master plays whichever one is
              left over. Its code appears here then.
            </p>
          )}
        </div>
      </details>

      {/*
      The two ways this game survives losing this screen (ADR-048).

      The role is a URL and a cookie, and both live here. Nothing else in the
      app is like that: a player who loses their seat asks the game master for
      a link, and the game master has nobody to ask. So this card holds the
      cheap answer and the real one — the address itself, which any second
      device can keep, and a key whose twelve words work from any device at
      all, including one that has never seen this game.

      Folded and guarded like everything else on this screen. Both halves are
      credentials and this laptop is often the one on the beamer.
      */}
      <details className="card">
        <summary>If you lose this screen</summary>
        <p className="note">
          There is no account here and no password to reset. This address is the game
          master role, and a browser that forgets it is a game nobody can run.
        </p>
        <LinkShare
          private
          title="This page"
          url={selfUrl}
          note="Keep it on a second device. It does not hand the role away: every device that has it runs the game."
        />
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

      <SettingsCard
        settings={game.settings}
        started={game.started}
        onSave={(patch) => act("The rules were changed.", () => client.settings(patch))}
      />

      {game.started ? (
        <section className="card">
          <h2>The clock</h2>
          <p>{countdown(game.deadlineAt)}</p>
          <ExtendRow onExtend={(minutes) => act("The deadline moved.", () => client.extend(minutes))} />
          <button
            type="button"
            disabled={!game.canForce}
            onClick={() => act("The phase was adjudicated.", () => client.force())}
          >
            Force adjudication
          </button>
          <p className="note">
            {game.canForce
              ? "Powers that have not locked in keep no orders: their units hold."
              : "Possible once the deadline passes, or when every power but one has locked in."}
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
  onSave,
}: {
  settings: { deadlineMinutes: number; gmPlays: boolean; illegalMoves?: boolean };
  started: boolean;
  onSave: (patch: {
    deadlineMinutes: number;
    gmPlays?: boolean;
    illegalMoves?: boolean;
  }) => void;
}) {
  const [minutes, setMinutes] = useState(settings.deadlineMinutes);
  const [plays, setPlays] = useState(settings.gmPlays);
  const allowIllegal = illegalAllowed(settings);
  const [illegal, setIllegal] = useState(allowIllegal);

  // A change made from another device wins over an untouched form.
  useEffect(() => setMinutes(settings.deadlineMinutes), [settings.deadlineMinutes]);
  useEffect(() => setPlays(settings.gmPlays), [settings.gmPlays]);
  useEffect(() => setIllegal(allowIllegal), [allowIllegal]);

  const dirty =
    minutes !== settings.deadlineMinutes ||
    plays !== settings.gmPlays ||
    illegal !== allowIllegal;

  return (
    <section className="card">
      <h2>The rules</h2>
      {settingsLines(settings).map((line) => (
        <p key={line} className="muted">
          {line}
        </p>
      ))}
      <label className="field">
        <span>Minutes for each phase</span>
        <input
          type="number"
          min={0}
          max={1440}
          inputMode="numeric"
          value={minutes}
          onChange={(event) => setMinutes(Number(event.target.value))}
        />
      </label>
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
        <span>Allow illegal orders</span>
        <small>Players may write illegal orders to bluff; they resolve as holds.</small>
      </label>
      <button
        type="button"
        disabled={!dirty}
        onClick={() =>
          onSave(
            started
              ? {
                  deadlineMinutes: Math.max(0, Math.floor(minutes) || 0),
                  illegalMoves: illegal,
                }
              : {
                  deadlineMinutes: Math.max(0, Math.floor(minutes) || 0),
                  gmPlays: plays,
                  illegalMoves: illegal,
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
