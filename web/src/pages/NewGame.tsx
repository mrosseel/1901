import { useEffect, useState } from "react";
import { createGame, fetchVariants, type CreatedGame } from "../api";
import { LinkShare } from "../components/LinkShare";
import { VariantGallery } from "../components/VariantGallery";
import { StylePicker, useMapStyle } from "../components/StylePicker";
import {
  DEFAULT_VARIANT,
  claimLine,
  findVariant,
  preferredVariant,
  type Variant,
} from "../variants";

/*
The first screen: the GM picks the map, sets the two rules that exist today,
and gets back the two links that run the game. The GM link is a secret and is
the only way back into the controls, so the warning sits right next to it.

The gallery is the page's weight, so it is fetched as metadata only and the
maps are left to the cards (see VariantGallery). A server that does not answer
/variants yet is not an error worth stopping for: the page falls back to
creating a classical game, which is what it did before there were variants.
*/
export function NewGame() {
  const [deadlineMinutes, setDeadlineMinutes] = useState(15);
  const [gmPlays, setGmPlays] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [game, setGame] = useState<CreatedGame | null>(null);
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
        deadlineMinutes: Math.max(0, Math.floor(deadlineMinutes) || 0),
        gmPlays: gmPlays,
        variant: chosen,
      });
      setGame(created);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (game) {
    const gmUrl =
      game.gmUrl || new URL("/game/" + game.gameId + "/gm/" + game.gmToken + "/", location.origin).toString();
    const inviteUrl = new URL(game.inviteUrl, location.href).toString();
    return (
      <main className="page">
        <h1>The game is ready</h1>
        <p className="lead">
          Game {game.gameId}
          {picked ? " · " + picked.name : ""}.
        </p>

        <LinkShare
          title="Your game master link"
          url={gmUrl}
          qr={false}
          note={
            <>
              <strong>Bookmark this link now.</strong> It is the only way back to the
              controls, it is not shown again, and anyone who has it runs the game.
            </>
          }
        />

        <LinkShare
          title="Invite link"
          url={inviteUrl}
          note="Pass the phone around, or let the players scan this. Each one gets a power."
        />

        <p>
          <a className="cta" href={gmUrl}>
            Open the game master page
          </a>
        </p>
      </main>
    );
  }

  return (
    <main className="page gallery">
      <h1>New game</h1>
      <p className="lead">Pick a map, set the clock, and pass the invite around the table.</p>

      <section className="card">
        <h2>The map</h2>
        {loadingVariants ? (
          <p className="muted">Reading the maps…</p>
        ) : variants.length === 0 ? (
          <p className="muted">
            No map list from the server. The game is created on the classical map.
          </p>
        ) : (
          <>
            <div className="gallery-head">
              <p className="note">
                A tick marks a map that has been checked against its board. Tap a map to
                look at it closely; tap the card to pick it.
              </p>
              <StylePicker value={style} onChange={setStyle} />
            </div>
            <VariantGallery
              variants={variants}
              chosen={chosen}
              gmPlays={gmPlays}
              style={style}
              onChoose={setChosen}
            />
          </>
        )}
      </section>

      <form className="card" onSubmit={submit}>
        <h2>The rules</h2>
        <label className="field">
          <span>Minutes for each phase</span>
          <input
            type="number"
            min={0}
            max={1440}
            inputMode="numeric"
            value={deadlineMinutes}
            onChange={(event) => setDeadlineMinutes(Number(event.target.value))}
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
          <small>One power is held back for you and revealed when the game starts.</small>
        </label>

        {picked ? (
          <p className="muted">
            {picked.name}
            {picked.powerCount ? " — " + claimLine(picked.powerCount, gmPlays) : ""}
          </p>
        ) : null}

        {error ? <p className="error">{error}</p> : null}

        <button type="submit" className="primary" disabled={busy}>
          {busy ? "Creating…" : "Create the game"}
        </button>
      </form>
    </main>
  );
}
