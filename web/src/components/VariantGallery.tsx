import { useEffect, useRef, useState } from "react";
import { claimLine, variantCard, type Variant } from "../variants";

/*
The variant gallery on /new: one card for each map godip can draw, and the
card that is picked is the game that gets created.

A gallery shows its maps, so every card draws one. What it must not do is
fetch twenty-three of them — 0.6 to 4.3 MB each — before anyone has scrolled.
So an IntersectionObserver watches each card and the <img> is only put on the
page once that card comes into view, a little ahead of the fold. Scrolling the
whole list does load every map, which is what looking at a gallery means; the
browser cache carries the ones already seen.

Later, for hosted play: the real fix is a small rastered thumbnail served
alongside the map — /variants/{key}/thumb.png or similar — so a card costs
kilobytes instead of megabytes. That is a server change, not this one.
*/

/** True once the card has been on screen, and it stays true after that. */
function useOnScreen(node: React.RefObject<HTMLElement | null>): boolean {
  const [seen, setSeen] = useState(false);

  useEffect(() => {
    if (seen) return;
    const target = node.current;
    if (!target) return;
    // Without an observer — an old browser, or a test — every card counts as
    // on screen, which is the safe way to fail: the gallery still works.
    if (typeof IntersectionObserver === "undefined") {
      setSeen(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setSeen(true);
      },
      { rootMargin: "120px" },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [node, seen]);

  return seen;
}

/*
The box keeps its height whether or not there is a map in it yet, so a card
never changes size and the page never jumps under a scrolling thumb.
*/
function MapPreview({ src, name, load }: { src: string; name: string; load: boolean }) {
  const [failed, setFailed] = useState(false);
  return (
    <div className="variant-map">
      {failed ? (
        <p className="muted">The map for this variant could not be drawn.</p>
      ) : load ? (
        <img
          className="variant-map-img"
          src={src}
          alt={"The " + name + " map"}
          loading="lazy"
          decoding="async"
          onError={() => setFailed(true)}
        />
      ) : null}
    </div>
  );
}

function VariantCardView({
  variant,
  picked,
  gmPlays,
  onPick,
}: {
  variant: Variant;
  picked: boolean;
  gmPlays: boolean;
  onPick: () => void;
}) {
  const card = variantCard(variant);
  const box = useRef<HTMLLIElement | null>(null);
  const onScreen = useOnScreen(box);
  const [open, setOpen] = useState(false);

  return (
    <li className={picked ? "variant picked" : "variant"} ref={box}>
      <label className="variant-pick">
        <input type="radio" name="variant" value={card.key} checked={picked} onChange={onPick} />
        <span className="variant-name">{card.name}</span>
        <span className={card.supported ? "badge in" : "badge warn"}>{card.badge}</span>
      </label>

      <MapPreview src={card.mapUrl} name={card.name} load={onScreen} />

      <p className="variant-powers">{card.powersLine}</p>
      {card.blurb ? <p className="variant-note">{card.blurb}</p> : null}
      {picked ? <p className="note">{claimLine(variant.powerCount, gmPlays)}</p> : null}

      {/*
      Everything else is folded away. Twenty-three cards of full godip notes is
      a wall of text nobody reads; the one card being considered is worth
      opening.
      */}
      <button
        type="button"
        className="link"
        aria-expanded={open}
        onClick={() => setOpen((was) => !was)}
      >
        {open ? "Hide the notes" : "Full notes"}
      </button>

      {open ? (
        <div className="variant-notes">
          {card.powerNames ? (
            <p className="muted">
              <span className="variant-label">Powers</span> {card.powerNames}
            </p>
          ) : null}
          {card.soloLine || card.startLine ? (
            <p className="muted">{[card.soloLine, card.startLine].filter(Boolean).join(" ")}</p>
          ) : null}
          {card.description ? <p>{card.description}</p> : null}
          {card.rules && card.rules !== card.description ? (
            <p className="muted">{card.rules}</p>
          ) : null}
          {card.credit ? <p className="note">{card.credit}</p> : null}
        </div>
      ) : null}
    </li>
  );
}

export function VariantGallery({
  variants,
  chosen,
  gmPlays,
  onChoose,
}: {
  variants: Variant[];
  chosen: string;
  gmPlays: boolean;
  onChoose: (key: string) => void;
}) {
  return (
    <ul className="variants">
      {variants.map((variant) => (
        <VariantCardView
          key={variant.key}
          variant={variant}
          picked={variant.key === chosen}
          gmPlays={gmPlays}
          onPick={() => onChoose(variant.key)}
        />
      ))}
    </ul>
  );
}
