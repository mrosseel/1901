import { useEffect, useState } from "react";
import { DEFAULT_MARKER_STYLE, MARKER_STYLES } from "../board/markers";
import { TopBar } from "../components/TopBar";
import { createGame, fetchVariants, refereePath } from "../api";
import { VariantGallery } from "../components/VariantGallery";
import { useMapStyle } from "../components/StylePicker";
import { EndYearField } from "../components/EndYearField";
import {
  DEFAULT_VARIANT,
  claimLine,
  findVariant,
  requestedVariant,
  startingVariant,
  type Variant,
} from "../variants";

/*
The first screen: the GM picks the map, sets the rules, and is handed
straight to the game master page, which is the waiting room the table fills
up. The GM secret never appears here: creating marks this browser as the
game master's, and the referee entry redirects from the cookie, so there is
nothing on this screen for a player to read.

The hand-off is location.replace, not a push. A created game has an address
of its own, and this form is not a place to come back to: pressing back from
the game master page must not land on a blank New game form while a game is
running. Replace leaves the game list behind the game master page instead.

The gallery is the page's weight, so it is fetched as metadata only and the
maps are left to the cards (see VariantGallery). A server that does not answer
/variants yet is not an error worth stopping for: the page falls back to
creating a classical game, which is what it did before there were variants.

?variant=<key> opens the form on that map. It is how the showcase hands a map
over: somebody who has already chosen should not have to choose again. A key
this server does not have is ignored rather than refused, because a stale link
is a bad address, not a reason to refuse to create a game.

The same form is /sandbox, asked for a board with no players (ADR-047). What a
sandbox has no use for goes away rather than being disabled: there is no clock
to set, no seat to hold back and no negotiation rule to declare, because there
is no second person for any of them to be about. The map is the whole of the
choice, and the answer is one link instead of an invite.

Order on the page: the name, then the rules, then the button, with the gallery
under all of them. The gallery is a screenful on a phone, so what sits below it
is a scroll away — and a game master taking the default map should not have to
scroll past every other map to reach the button. The picked map is named on the
line above the button, so the choice is read back where it is acted on.
*/
type PressMode = "ftf" | "gunboat" | "rulebook" | "fullpress";

/*
What each negotiation rule means, in the words of the thing that happens.

The first two are about the room and the app carries nothing. The last two are
the app carrying messages, and the difference between them is the one WDC 3b
draws: negotiation is forbidden during the retreats and the adjustments.
*/
const PRESS_HELP: Record<PressMode, string> = {
  ftf: "Negotiation happens in person. This app carries no messages.",
  gunboat: "No negotiation at all, and the seats stay anonymous.",
  rulebook:
    "Messages during movement phases only, and none during retreats and builds. " +
    "This is how a tournament board plays. Only the powers in a conversation " +
    "can read it; the server still knows who talks to whom, and when.",
  fullpress:
    "Messages in every phase. Best for a table that is not in one room. Only " +
    "the powers in a conversation can read it; the server still knows who " +
    "talks to whom, and when.",
};

export function NewGame({ sandbox }: { sandbox?: boolean }) {
  const [name, setName] = useState("");
  const [deadlineMinutes, setDeadlineMinutes] = useState(15);
  const [retreatBuildPercent, setRetreatBuildPercent] = useState(50);
  const [graceMinutes, setGraceMinutes] = useState(0);
  const [firstTurnExtraMinutes, setFirstTurnExtraMinutes] = useState(0);
  const [pressMode, setPressMode] = useState<PressMode>("ftf");
  const [markerStyle, setMarkerStyle] = useState<string>(DEFAULT_MARKER_STYLE);
  /* WDC 4b2's writing minute: the last minute of a phase is for writing
     orders, in silence, and 4d puts a sanction behind it. */
  const [pressSilenceSeconds, setPressSilenceSeconds] = useState(60);
  const [gmPlays, setGmPlays] = useState(true);
  /* On by default: the paper game takes any order you can spell, and taking
     that away is the change, not leaving it (ADR-029, illegal.ts). */
  const [illegalMoves, setIllegalMoves] = useState(true);
  const [endYearEnabled, setEndYearEnabled] = useState(false);
  const [endYear, setEndYear] = useState<number | "">("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [variants, setVariants] = useState<Variant[]>([]);
  const [chosen, setChosen] = useState(DEFAULT_VARIANT);
  const [style, setStyle] = useMapStyle();
  const [loadingVariants, setLoadingVariants] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetchVariants()
      .then((list) => {
        if (cancelled) return;
        setVariants(list);
        // The showcase links here with the map already named (/new?variant=…).
        // It is only a starting point: the gallery below still decides.
        setChosen(startingVariant(list, requestedVariant(location.search)));
      })
      .catch(() => {
        // No catalogue: the game is still creatable, on the default map.
      })
      .finally(() => {
        if (!cancelled) setLoadingVariants(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const picked = findVariant(variants, chosen);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const created = await createGame(sandbox ? {
        name: name.trim(),
        sandbox: true,
        // A sandbox holds both of these at nothing, and the server enforces
        // it; they are sent because the shape asks for them, not as a rule.
        deadlineMinutes: 0,
        gmPlays: false,
        illegalMoves: illegalMoves,
        markerStyle: markerStyle,
        endYear: endYearEnabled ? Math.max(0, Math.floor(Number(endYear)) || 0) : 0,
        variant: chosen,
      } : {
        name: name.trim(),
        deadlineMinutes: Math.max(0, Math.floor(deadlineMinutes) || 0),
        retreatBuildPercent: Math.max(1, Math.min(100, Math.floor(retreatBuildPercent) || 50)),
        graceMinutes: Math.max(0, Math.floor(graceMinutes) || 0),
        firstTurnExtraMinutes: Math.max(0, Math.floor(firstTurnExtraMinutes) || 0),
        pressMode: pressMode,
        pressSilenceSeconds: Math.max(0, Math.floor(pressSilenceSeconds) || 0),
        gmPlays: gmPlays,
        illegalMoves: illegalMoves,
        markerStyle: markerStyle,
        endYear: endYearEnabled ? Math.max(0, Math.floor(Number(endYear)) || 0) : 0,
        variant: chosen,
      });
      // A sandbox has one link and it is in the answer (ADR-047). Anything
      // else goes through the referee entry: the cookie the create set is
      // the credential, and it redirects this browser to its own address.
      location.replace(
        created.sandboxUrl ||
          new URL(refereePath(created.gameId), location.origin).toString(),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <>
      <TopBar here="new" />
      <main className="page variant-gallery-page">
        <h1>{sandbox ? "New sandbox" : "New game"}</h1>
        <p className="lead">
          {sandbox
            ? "A board with no players. Pick a map, and you order every power yourself."
            : "Name the table, set the clock, and pass the invite around it."}
        </p>

        <form onSubmit={submit}>
          <section className="card">
            <h2>The game</h2>
            <label className="field">
              <span>Name of this game</span>
              <input
                type="text"
                name="gameName"
                maxLength={60}
                autoComplete="off"
                placeholder="Thursday table"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
              <small>Optional. A game with no name is known by its id.</small>
            </label>

            {sandbox ? null : (
            <label className="field">
              <span>Minutes for movement phases</span>
              <input
                type="number"
                min={0}
                max={1440}
                inputMode="numeric"
                value={deadlineMinutes}
                onChange={(event) =>
                  setDeadlineMinutes(Number(event.target.value))
                }
              />
              <small>Zero runs the game with no deadline.</small>
            </label>
            )}

            {sandbox ? null : (
            <details>
              <summary>Clock details</summary>
              <label className="field">
                <span>Retreat and adjustment clock</span>
                <input type="number" min={1} max={100} inputMode="numeric"
                  value={retreatBuildPercent}
                  onChange={(event) => setRetreatBuildPercent(Number(event.target.value))} />
                <small>Percentage of the movement clock; 50% gives 7½ minutes from a 15-minute movement phase.</small>
              </label>
              <label className="field">
                <span>Grace after the deadline (minutes)</span>
                <input type="number" min={0} max={600} inputMode="numeric"
                  value={graceMinutes}
                  onChange={(event) => setGraceMinutes(Number(event.target.value))} />
                <small>Orders remain open during grace; force adjudication stays unavailable.</small>
              </label>
              <label className="field">
                <span>Extra time for Spring 1901 (minutes)</span>
                <input type="number" min={0} max={600} inputMode="numeric"
                  value={firstTurnExtraMinutes}
                  onChange={(event) => setFirstTurnExtraMinutes(Number(event.target.value))} />
              </label>
            </details>
            )}

            {/*
            What the table opens on. Not a rule: every device may say
            otherwise on its own screen and nobody else sees it (prefs.ts).
            It is here anyway because the first thing a room sees when the
            projector goes up should be the pieces the game master meant,
            and a variant is often the reason — an ancient board wants
            triremes.
            */}
            <label className="field">
              <span>Pieces</span>
              <select value={markerStyle} onChange={(event) => setMarkerStyle(event.target.value)}>
                {MARKER_STYLES.map((one) => (
                  <option key={one.name} value={one.name}>{one.title}</option>
                ))}
              </select>
              <small>
                {MARKER_STYLES.find((one) => one.name === markerStyle)?.description}
                {" Anyone may change it on their own screen."}
              </small>
            </label>

            {sandbox ? null : (
            <>
            <label className="field">
              <span>Negotiation rule</span>
              <select value={pressMode} onChange={(event) =>
                setPressMode(event.target.value as PressMode)}
              >
                <option value="ftf">Face-to-face negotiations</option>
                <option value="gunboat">Gunboat, no negotiation</option>
                <option value="rulebook">In-app messages, movement phases only</option>
                <option value="fullpress">In-app messages, every phase</option>
              </select>
              <small>{PRESS_HELP[pressMode]}</small>
            </label>

            {/*
            The two settings that only mean something once the app carries
            messages. They are hidden otherwise rather than disabled: a game
            master choosing between two ways of talking at a table does not
            need to read past a writing-time field.
            */}
            {pressMode === "rulebook" || pressMode === "fullpress" ? (
              <>
                <label className="field">
                  <span>Writing time (seconds)</span>
                  <input type="number" min={0} max={600} inputMode="numeric"
                    value={pressSilenceSeconds}
                    onChange={(event) => setPressSilenceSeconds(Number(event.target.value))} />
                  <small>
                    Messages close this long before the deadline, so the last
                    of the phase is for writing orders. Zero keeps them open to
                    the end.
                  </small>
                </label>
                {/* Not offered here. The mailbox is opened with the game
                    master key, and that is made on the referee screen after
                    the game exists (ADR-048, ADR-054), so the switch lives
                    beside the key rather than in front of it. */}
                {gmPlays ? null : (
                  <p className="note">
                    A game master who does not play can be given every message to
                    read. Make the game master key on the next screen, then turn
                    it on there, before anybody joins.
                  </p>
                )}
              </>
            ) : null}
            </>
            )}

            <EndYearField
              enabled={endYearEnabled}
              year={endYear}
              startYear={picked?.startYear}
              onEnabledChange={setEndYearEnabled}
              onYearChange={setEndYear}
            />

            {sandbox ? null : (
            <label className="field check">
              <input
                type="checkbox"
                checked={gmPlays}
                onChange={(event) => setGmPlays(event.target.checked)}
              />
              <span>I play a power as well</span>
              <small>
                One power is held back for you and revealed when the game
                starts. “Game master” means this table's host/referee, not the
                tournament director.
              </small>
            </label>
            )}

            <label className="field check">
              <input
                type="checkbox"
                checked={illegalMoves}
                onChange={(event) => setIllegalMoves(event.target.checked)}
              />
              <span>Accept orders exactly as entered</span>
              <small>
                Invalid orders fail under the rules instead of being blocked during entry.
              </small>
            </label>

            {/* The map is picked in the gallery below and named here, where the
              button is: the choice is out of sight from the button, so it is
              read back beside it. */}
            {picked ? (
              <p className={picked.supported ? "muted" : "notice"}>
                {picked.name}
                {picked.powerCount
                  ? sandbox
                    ? " — " + picked.powerCount + " powers, all of them yours"
                    : " — " + claimLine(picked.powerCount, gmPlays)
                  : ""}
                {!picked.supported
                  ? " — its starting positions and board art have not yet been verified for live play."
                  : ""}
              </p>
            ) : null}

            {error ? <p className="error">{error}</p> : null}

            <button type="submit" className="primary" disabled={busy}>
              {busy ? "Creating…" : sandbox ? "Open the sandbox" : "Create the game"}
            </button>
          </section>

          <section className="card">
            <h2>The map</h2>
            {loadingVariants ? (
              <p className="muted">Reading the maps…</p>
            ) : variants.length === 0 ? (
              <p className="muted">
                No map list from the server. The game is created on the
                classical map.
              </p>
            ) : (
              <VariantGallery
                variants={variants}
                chosen={chosen}
                style={style}
                onChoose={setChosen}
                onStyle={setStyle}
              />
            )}
            {picked ? (
              <button type="submit" className="primary" disabled={busy}>
                {busy
                  ? "Creating…"
                  : (sandbox ? "Open a sandbox on " : "Create game with ") + picked.name}
              </button>
            ) : null}
          </section>
        </form>
      </main>
    </>
  );
}
