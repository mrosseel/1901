import { useEffect, useState } from "react";
import { TopBar } from "../components/TopBar";
import { fetchVariants } from "../api";
import { VariantGallery } from "../components/VariantGallery";
import { useMapStyle } from "../components/StylePicker";
import { findVariant, type Variant } from "../variants";

/*
The showcase at /variants: every map this server can draw, and nothing to
fill in.

The link on the landing page used to open the create form, which asked for a
game name and a clock before it showed a single map. Reading a catalogue and
starting a game are two different errands, and the second one is the one with
the form. So this page only shows: the same cards as the gallery on /new, with
the notes already unfolded, because a page somebody came to in order to read
should not make them open twenty-six things first.

Nothing is picked when the page opens. Picking a card is a statement — this is
the map I want — and it is answered at once by the bar at the foot of the
screen, which carries the two ways to open a board on it. The bar is at the
foot because a phone holds one card and a half of the screen, and a call to
action above the gallery would be scrolled away before anybody had seen
anything worth acting on.
*/
export function VariantsPage() {
  const [variants, setVariants] = useState<Variant[]>([]);
  const [chosen, setChosen] = useState("");
  const [style, setStyle] = useMapStyle();
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetchVariants()
      .then((list) => {
        if (!cancelled) setVariants(list);
      })
      .catch(() => {
        // No catalogue: the page says so below rather than showing an error.
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const picked = findVariant(variants, chosen);
  const key = picked ? encodeURIComponent(picked.key) : "";

  return (
    <>
      <TopBar here="variants" />
      <main className="page variant-gallery-page">
        <h1>The maps</h1>
        <p className="lead">
          Every board this server can adjudicate. Pick one to start a game on it.
        </p>

        {loading ? (
          <p className="muted">Reading the maps…</p>
        ) : variants.length === 0 ? (
          <p className="muted">
            No map list from the server. A game can still be created on the classical
            map.
          </p>
        ) : (
          <VariantGallery
            variants={variants}
            chosen={chosen}
            style={style}
            bandControl="chips"
            notesOpen
            onChoose={setChosen}
            onStyle={setStyle}
          />
        )}

        {/* Sticky rather than fixed: it holds the foot of the screen while
            there is gallery left to scroll, and comes to rest at the end of
            the page instead of covering the last card. */}
        {picked ? (
          <div className="variant-cta">
            <p className="variant-cta-name">{picked.name}</p>
            <div className="variant-cta-links">
              <a className="cta-primary" href={"/new?variant=" + key}>
                Start a game on {picked.name}
              </a>
              <a className="cta-secondary" href={"/sandbox?variant=" + key}>
                Open a sandbox on {picked.name}
              </a>
            </div>
          </div>
        ) : null}
      </main>
    </>
  );
}
