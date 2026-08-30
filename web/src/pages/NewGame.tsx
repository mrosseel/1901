import { useEffect, useState } from "react";
import { TopBar } from "../components/TopBar";
import { createGame, fetchVariants, refereePath } from "../api";
import { VariantGallery } from "../components/VariantGallery";
import { useMapStyle } from "../components/StylePicker";
import {
  DEFAULT_VARIANT,
  claimLine,
  findVariant,
  preferredVariant,
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

Order on the page: the name, then the rules, then the button, with the gallery
under all of them. The gallery is a screenful on a phone, so what sits below it
is a scroll away — and a game master taking the default map should not have to
scroll past every other map to reach the button. The picked map is named on the
line above the button, so the choice is read back where it is acted on.
*/
export function NewGame() {
  const [name, setName] = useState("");
  const [deadlineMinutes, setDeadlineMinutes] = useState(15);
  const [gmPlays, setGmPlays] = useState(true);
  /* On by default: the paper game takes any order you can spell, and taking
     that away is the change, not leaving it (D-029, illegal.ts). */
  const [illegalMoves, setIllegalMoves] = useState(true);
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
        setChosen(preferredVariant(list));
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
      const created = await createGame({
        name: name.trim(),
        deadlineMinutes: Math.max(0, Math.floor(deadlineMinutes) || 0),
        gmPlays: gmPlays,
        illegalMoves: illegalMoves,
        variant: chosen,
      });
      // The cookie the create set is the credential; the entry redirects
      // this browser on to the game master page and its own address.
      location.replace(
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
      <main className="page gallery">
        <h1>New game</h1>
        <p className="lead">
          Name the table, set the clock, and pass the invite around it.
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

            <label className="field">
              <span>Minutes for each phase</span>
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

            <label className="field check">
              <input
                type="checkbox"
                checked={gmPlays}
                onChange={(event) => setGmPlays(event.target.checked)}
              />
              <span>I play a power as well</span>
              <small>
                One power is held back for you and revealed when the game
                starts.
              </small>
            </label>

            <label className="field check">
              <input
                type="checkbox"
                checked={illegalMoves}
                onChange={(event) => setIllegalMoves(event.target.checked)}
              />
              <span>Allow illegal orders</span>
              <small>
                Players may write illegal orders to bluff; they resolve as
                holds.
              </small>
            </label>

            {/* The map is picked in the gallery below and named here, where the
              button is: the choice is out of sight from the button, so it is
              read back beside it. */}
            {picked ? (
              <p className="muted">
                {picked.name}
                {picked.powerCount
                  ? " — " + claimLine(picked.powerCount, gmPlays)
                  : ""}
              </p>
            ) : null}

            {error ? <p className="error">{error}</p> : null}

            <button type="submit" className="primary" disabled={busy}>
              {busy ? "Creating…" : "Create the game"}
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
          </section>
        </form>
      </main>
    </>
  );
}
