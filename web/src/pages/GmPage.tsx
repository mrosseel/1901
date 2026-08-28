import { useEffect, useMemo, useRef, useState } from "react";
import { ApiError, GmClient, type GmState } from "../api";
import { LinkShare } from "../components/LinkShare";
import { phaseLabel, powerColor, setPowerPalette, setProvinceNames } from "../board/provinces";
import { countdown, settingsLines, usePoll, useTicker } from "../hooks";
import { StylePicker, useMapStyle } from "../components/StylePicker";
import { SupportedMark } from "../components/SupportedMark";
import { noteServerTime } from "../clock";
import { Clock } from "../components/Clock";
import { ReviewOverlay } from "../components/ReviewOverlay";
import { RefereeGuide } from "../components/RefereeGuide";
import { refereeGuide } from "../referee";
import { dismiss, isDismissed, reviewKey, reviewPlan } from "../review";

/*
The game master's screen: the rules, the invite, who has joined, who has
finalized, and the two gated actions — start, and force adjudication. It holds
no orders and never can: the GM state carries booleans only.
*/
export function GmPage({ gameId, gmToken }: { gameId: string; gmToken: string }) {
  const client = useMemo(() => new GmClient(gameId, gmToken), [gameId, gmToken]);
  const [game, setGame] = useState<GmState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
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
  every player: it opens once per adjudication on this device, and Continue
  puts it away here and nowhere else.
  */
  const review = useMemo(() => reviewPlan(game?.previousPhase), [game?.previousPhase]);
  /*
  The same adjudication, as physical acts. The game master's laptop is the
  screen the piece pusher stands at, so this is the page the guide matters
  most on — and it carries no order content the review does not, so D-013
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

  const finalizedCount = game.seats.filter((seat) => seat.finalized).length;
  const allJoined = game.joinedCount >= game.totalSeats;

  return (
    <main className="page wide">
      <header className="page-head">
        <div>
          <h1>Game master</h1>
          <p className="muted">
            Game {game.gameId} · {game.started ? phaseLabel(game.phase) : "not started"}
          </p>
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

      {error ? <p className="error">{error}</p> : null}
      {notice ? <p className="notice">{notice}</p> : null}

      {refereeing && guide ? (
        <RefereeGuide guide={guide} onClose={() => setRefereeing(false)} />
      ) : reviewing && review ? (
        <ReviewOverlay
          plan={review}
          deadlineAt={game.deadlineAt}
          onContinue={closeReview}
          onReferee={guide ? () => setRefereeing(true) : undefined}
        />
      ) : review ? (
        <p className="head-links">
          <button type="button" className="link" onClick={() => setReviewing(true)}>
            Last turn
          </button>
          {guide ? (
            <button type="button" className="link" onClick={() => setRefereeing(true)}>
              Referee guide
            </button>
          ) : null}
        </p>
      ) : null}

      <section className="card">
        <h2>Powers</h2>
        <ul className="seats">
          {game.seats.map((seat) => (
            <li key={seat.power} className={seat.joined ? "seat joined" : "seat"}>
              <span className="dot" style={{ background: powerColor(seat.power) }} />
              <span className="seat-name">{seat.power}</span>
              {seat.isGm ? <span className="badge gm">Game master</span> : null}
              <span className={seat.joined ? "badge in" : "badge out"}>
                {seat.joined ? "Joined" : "Waiting"}
              </span>
              {game.started ? (
                <span className={seat.finalized ? "badge done" : "badge out"}>
                  {seat.finalized ? "Finalized" : "Ordering"}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
        {/* Before the start the count that matters is the one the invite
            fills; after it, every power in play, the GM's included. */}
        <p className="muted">
          {game.started
            ? game.seats.filter((seat) => seat.joined).length +
              " powers in play · " +
              finalizedCount +
              " finalized"
            : game.joinedCount + " of " + game.totalSeats + " joined"}
        </p>
        {!game.started ? (
          <button
            type="button"
            className="primary"
            disabled={!allJoined}
            onClick={() => act("The game has started.", () => client.start())}
          >
            {allJoined ? "Start the game" : "Waiting for every power"}
          </button>
        ) : null}
      </section>

      <LinkShare
        title="Invite link"
        url={new URL(game.inviteUrl, location.href).toString()}
        note="Anyone who scans this gets the next free power."
      />

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
              ? "Powers that have not finalized keep no orders: their units hold."
              : "Possible once the deadline passes, or when every power but one has finalized."}
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
  );
}

/* The rules editor. gmPlays decides how many powers are held for joiners, so
   the server freezes it once the game starts. */
function SettingsCard({
  settings,
  started,
  onSave,
}: {
  settings: { deadlineMinutes: number; gmPlays: boolean };
  started: boolean;
  onSave: (patch: { deadlineMinutes: number; gmPlays?: boolean }) => void;
}) {
  const [minutes, setMinutes] = useState(settings.deadlineMinutes);
  const [plays, setPlays] = useState(settings.gmPlays);

  // A change made from another device wins over an untouched form.
  useEffect(() => setMinutes(settings.deadlineMinutes), [settings.deadlineMinutes]);
  useEffect(() => setPlays(settings.gmPlays), [settings.gmPlays]);

  const dirty = minutes !== settings.deadlineMinutes || plays !== settings.gmPlays;

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
      <button
        type="button"
        disabled={!dirty}
        onClick={() =>
          onSave(
            started
              ? { deadlineMinutes: Math.max(0, Math.floor(minutes) || 0) }
              : { deadlineMinutes: Math.max(0, Math.floor(minutes) || 0), gmPlays: plays },
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
