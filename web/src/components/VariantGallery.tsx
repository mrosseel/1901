import { useEffect, useRef, useState } from "react";
import {
  POWER_BANDS,
  bandCounts,
  filterByBand,
  variantCard,
  type Variant,
} from "../variants";
import { MapLightbox } from "./MapLightbox";
import { StylePicker } from "./StylePicker";
import { SupportedMark } from "./SupportedMark";
import { styledMapUrl } from "../style";

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
function MapPreview({
  src,
  name,
  load,
  onOpen,
}: {
  src: string;
  name: string;
  load: boolean;
  onOpen: () => void;
}) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <div className="variant-map">
        <p className="muted">The map for this variant could not be drawn.</p>
      </div>
    );
  }
  /*
  The map is its own tap target, and it is a button.

  Tapping the card picks the variant; tapping the map opens it big. Those are
  two different things to want from a card, so they are two different targets
  — and data-no-select is what keeps the map's tap from also picking the card
  it sits in. A button rather than a div, so a keyboard reaches it too.
  */
  return (
    <button
      type="button"
      className="variant-map"
      data-no-select="yes"
      disabled={!load}
      title={"Look at the " + name + " map"}
      aria-label={"Look at the " + name + " map"}
      onClick={onOpen}
    >
      {load ? (
        <img
          className="variant-map-img"
          src={src}
          alt={"The " + name + " map"}
          loading="lazy"
          decoding="async"
          onError={() => setFailed(true)}
        />
      ) : null}
      <span className="map-zoom-chip" aria-hidden="true">
        <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.8">
          <circle cx="6.5" cy="6.5" r="4.5" />
          <line x1="10" y1="10" x2="14.2" y2="14.2" strokeLinecap="round" />
        </svg>
      </span>
    </button>
  );
}

function VariantCardView({
  variant,
  mapUrl,
  picked,
  onPick,
}: {
  variant: Variant;
  /** The card's map, in this device's style. */
  mapUrl: string;
  picked: boolean;
  onPick: () => void;
}) {
  const card = variantCard(variant);
  const box = useRef<HTMLLIElement | null>(null);
  const onScreen = useOnScreen(box);
  const [open, setOpen] = useState(false);
  const [looking, setLooking] = useState(false);

  /*
  Anywhere on the card picks it, except the two things that are not a choice
  of variant: the map, which opens big, and the notes, which unfold. Both are
  marked data-no-select, so this handler can tell them apart without knowing
  what they are.
  */
  const pickUnlessHandled = (event: React.MouseEvent) => {
    const target = event.target as HTMLElement | null;
    if (target && target.closest("[data-no-select]")) return;
    onPick();
  };

  return (
    <li className={picked ? "variant picked" : "variant"} ref={box} onClick={pickUnlessHandled}>
      {/*
      No visible control. The whole card is the target and the card itself is
      the answer: the picked one is a different, saturated surface, which reads
      across a gallery of twenty-six at a glance where a row of small circles
      does not.

      The radio is still here, off screen. It is what makes the gallery one
      group to a keyboard and to a screen reader — arrow keys walk it, the
      group announces "3 of 26" — and reimplementing that on a <li> with
      aria-pressed would be a worse copy of what the browser already does. The
      card carries the focus ring for it, so the focus is visible even though
      the control is not.
      */}
      <label className="variant-pick">
        <input
          type="radio"
          className="visually-hidden"
          name="variant"
          value={card.key}
          checked={picked}
          onChange={onPick}
        />
        <span className="variant-name">{card.name}</span>
        <SupportedMark supported={card.supported} />
      </label>

      <MapPreview
        src={mapUrl}
        name={card.name}
        load={onScreen}
        onOpen={() => setLooking(true)}
      />
      {looking ? (
        <MapLightbox src={mapUrl} name={card.name} onClose={() => setLooking(false)} />
      ) : null}

      {/* No line appears or disappears with the choice: the rules form below
          already says how many powers the picked variant hands out, and a card
          that grows when it is tapped shoves the whole grid down. */}
      <p className="variant-powers">{card.powersLine}</p>
      {card.blurb ? <p className="variant-note">{card.blurb}</p> : null}

      {/*
      Everything else is folded away. Twenty-three cards of full godip notes is
      a wall of text nobody reads; the one card being considered is worth
      opening.
      */}
      <button
        type="button"
        className="link notes-toggle"
        data-no-select="yes"
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
  style,
  onChoose,
  onStyle,
}: {
  variants: Variant[];
  chosen: string;
  /** This device's map style, or "" for whatever the server serves. */
  style?: string;
  onChoose: (key: string) => void;
  onStyle: (style: string) => void;
}) {
  const [band, setBand] = useState("all");
  const counts = bandCounts(variants);
  const shown = filterByBand(variants, band, chosen);

  return (
    <>
      {/*
      One row over the cards: what size of table you are looking for on the
      left, what the maps are drawn in on the right. The first narrows the
      gallery, the second only repaints it, so they are the two controls that
      belong above it and nothing else does.
      */}
      <div className="gallery-bar">
        <div className="band-chips" role="group" aria-label="Filter by number of powers">
          {POWER_BANDS.map((one) => (
            <button
              key={one.id}
              type="button"
              className={one.id === band ? "chip on" : "chip"}
              aria-pressed={one.id === band}
              disabled={counts[one.id] === 0}
              onClick={() => setBand(one.id)}
            >
              {one.label}
              <span className="chip-count">{counts[one.id]}</span>
            </button>
          ))}
        </div>
        <StylePicker value={style || ""} onChange={onStyle} />
      </div>

      <ul className="variants">
        {shown.map((variant) => (
          <VariantCardView
            key={variant.key}
            variant={variant}
            mapUrl={styledMapUrl(variant.mapUrl, style || "")}
            picked={variant.key === chosen}
            onPick={() => onChoose(variant.key)}
          />
        ))}
      </ul>
    </>
  );
}
