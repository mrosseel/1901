import { powerColor } from "../board/provinces";

/*
A power, named, on its own colour.

The board has always identified a power by a small coloured dot beside a
sentence. That asks the reader to hold seven colour-to-name pairs in their head
before they can read a line — on a phone, at a table, under time. It also says
nothing at all to a player who cannot separate the reds from the greens, and
Diplomacy has both.

So the name is the mark. The colour is behind it, which is what ties the line
to the piece on the map, and the name is what makes the line readable without
the colour at all.

The ink is picked from the colour's own brightness, because the palette runs
from a near-black grey to a pale yellow and neither white nor black is legible
on both.
*/
export function PowerChip({
  power,
  small,
  title,
}: {
  power: string;
  /** For a list, where the chip sits inside a line of running text. */
  small?: boolean;
  title?: string;
}) {
  const background = powerColor(power);
  return (
    <span
      className={small ? "power-chip small" : "power-chip"}
      style={{ background: background, color: inkOn(background) }}
      title={title}
    >
      {power}
    </span>
  );
}

/*
Black or white, whichever can be read on this colour.

The threshold is on perceived brightness rather than on the raw average: the
eye reads green as far lighter than blue at the same value, and a palette with
England's purple and Italy's green in it lands on the wrong side of a naive
average.
*/
export function inkOn(color: string): string {
  const hex = color.replace("#", "");
  const full =
    hex.length === 3
      ? hex
          .split("")
          .map((c) => c + c)
          .join("")
      : hex;
  if (full.length !== 6) return "#14161a";
  const red = parseInt(full.slice(0, 2), 16);
  const green = parseInt(full.slice(2, 4), 16);
  const blue = parseInt(full.slice(4, 6), 16);
  const brightness = (red * 299 + green * 587 + blue * 114) / 1000;
  return brightness > 140 ? "#14161a" : "#ffffff";
}
