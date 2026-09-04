import { useEffect, useRef, useState } from "react";
import {
  POWER_BANDS,
  bandCounts,
  filterByBand,
  offBand,
  variantCard,
  type Variant,
} from "../variants";
import { MapLightbox } from "./MapLightbox";
import { StylePicker } from "./StylePicker";
import { VariantNote } from "./VariantNote";
import { styledMapUrl } from "../style";

/*
The variant gallery: one card for each map godip can draw. On /new the picked
card is the game that gets created; on /variants it is the map the call to
action then offers to start a game on. Both pages show the same cards, so the
difference between them is props, not a second gallery.

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
  The map picks the card. The glass on it opens it big.

  The map used to be the button, and it was the wrong one: a card whose one
  picture cannot be tapped to choose it makes the picture look like it is not
  part of the card. Looking closely is the rarer thing to want, so it is the
  thing that gets its own control, and the control is big enough to hit with
  a thumb without hunting.

  data-no-select on the glass alone is what keeps its tap from also picking
  the card underneath it.
  */
  return (
    <div className="variant-map">
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
      <button
        type="button"
        className="map-zoom-chip"
        data-no-select="yes"
        disabled={!load}
        title={"Look at the " + name + " map"}
        aria-label={"Look at the " + name + " map"}
        onClick={onOpen}
      >
        <svg viewBox="0 0 16 16" width="19" height="19" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
          <circle cx="6.5" cy="6.5" r="4.5" />
          <line x1="10" y1="10" x2="14.2" y2="14.2" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  );
}

function VariantCardView({
  variant,
  mapUrl,
  picked,
  aside,
  notesOpen,
  onPick,
}: {
  variant: Variant;
  /** The card's map, in this device's style. */
  mapUrl: string;
  picked: boolean;
  /** True for the picked card the filter does not match. */
  aside: boolean;
  /** True where the page is for reading the maps rather than for filling a form. */
  notesOpen: boolean;
  onPick: () => void;
}) {
  const card = variantCard(variant);
  const box = useRef<HTMLLIElement | null>(null);
  const onScreen = useOnScreen(box);
  const [open, setOpen] = useState(notesOpen);
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
        {/* The card is outside the filter and stays anyway, so it says so. A
            tag on the one card, not a notice over the gallery. */}
        {aside ? <span className="variant-aside">Your pick</span> : null}
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
      {/* What somebody wrote about this map's review (ADR-061). It used to be
          a Verified / Not yet verified chip beside the name, which labelled
          twenty-five cards with a warning and told nobody anything. */}
      {card.note ? (
        <p className="variant-note muted">
          <VariantNote note={card.note} />
        </p>
      ) : null}

      {/*
      Everything else is folded away. Twenty-three cards of full godip notes is
      a wall of text nobody reads; the one card being considered is worth
      opening. A page that exists to be read starts them open instead.
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

/*
The table-size filter, in its two shapes.

On the create form it is a select: the filter is one line of a form that is
mostly other questions, and a row of eight buttons there would outweigh the
clock and the negotiation rule. On the showcase it is the way the page is
read, so every band is on the page with its count, one tap away.
*/
function BandPicker({
  band,
  counts,
  control,
  onBand,
}: {
  band: string;
  counts: Record<string, number>;
  control: "select" | "chips";
  onBand: (band: string) => void;
}) {
  if (control === "chips") {
    return (
      <div className="band-chips" role="group" aria-label="Show the variants for a table this size">
        {POWER_BANDS.map((one) => (
          <button
            key={one.id}
            type="button"
            className={one.id === band ? "band-chip on" : "band-chip"}
            aria-pressed={one.id === band}
            disabled={counts[one.id] === 0}
            onClick={() => onBand(one.id)}
          >
            {one.label} <span className="band-chip-count">{counts[one.id]}</span>
          </button>
        ))}
      </div>
    );
  }
  /* The count rides in the option text. A select shows one option at a time,
     so a count kept outside it would be invisible while closed — and the
     count is the reason the filter is worth opening. */
  return (
    <label className="band-picker">
      <span className="band-picker-label">Players</span>
      <select
        value={band}
        title="Show only the variants for a table this size"
        onChange={(event) => onBand(event.target.value)}
      >
        {POWER_BANDS.map((one) => (
          <option key={one.id} value={one.id} disabled={counts[one.id] === 0}>
            {one.label} ({counts[one.id]})
          </option>
        ))}
      </select>
    </label>
  );
}

export function VariantGallery({
  variants,
  chosen,
  style,
  bandControl = "select",
  notesOpen = false,
  onChoose,
  onStyle,
}: {
  variants: Variant[];
  chosen: string;
  /** This device's map style, or "" for whatever the server serves. */
  style?: string;
  /** How the table-size filter is drawn. See BandPicker. */
  bandControl?: "select" | "chips";
  /** Start every card with its notes unfolded. */
  notesOpen?: boolean;
  onChoose: (key: string) => void;
  onStyle: (style: string) => void;
}) {
  const [band, setBand] = useState("all");
  const counts = bandCounts(variants);
  const shown = filterByBand(variants, band, chosen);
  const aside = offBand(variants, band, chosen);

  return (
    <>
      {/*
      One row over the cards: what size of table you are looking for on the
      left, what the maps are drawn in on the right. The first narrows the
      gallery, the second only repaints it, so they are the two controls that
      belong above it and nothing else does.
      */}
      <div className={bandControl === "chips" ? "gallery-bar wrapped" : "gallery-bar"}>
        <BandPicker band={band} counts={counts} control={bandControl} onBand={setBand} />
        <StylePicker value={style || ""} onChange={onStyle} />
      </div>

      <ul className="variants">
        {shown.map((variant) => (
          <VariantCardView
            key={variant.key}
            variant={variant}
            mapUrl={styledMapUrl(variant.mapUrl, style || "")}
            picked={variant.key === chosen}
            aside={aside && variant.key === chosen}
            notesOpen={notesOpen}
            onPick={() => onChoose(variant.key)}
          />
        ))}
      </ul>
    </>
  );
}
