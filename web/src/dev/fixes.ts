/*
The fixes the gallery can switch off, and the store behind the switches.

A proposed change to a screen is worth more when it can be seen on and off.
The store itself lives in @mrosseel/page-comments; this file only names the
fixes this app has, and hands the names over.

FOR EVERY FUTURE FIX
1. Register the comment id below, with one line of text.
2. Wrap the change so that OFF gives back the old look exactly.
   - Style only: write the new value as before, then add a rule
     `html[data-fix-off~="cXXX"] .thing { ...old values... }`.
   - Markup or logic: read `useFixEnabled("cXXX")` and draw the old branch
     when it is false.
3. Mark the comment proposed with `npm run feedback -- --propose cXXX "note"
   --toggle`. The flag checks that the id is in FIX_IDS.

*/

import { registerFixes } from "@mrosseel/page-comments/fixes";

/** Comment ids that carry a fix the reviewer can switch off, with a label. */
export const FIX_IDS: Record<string, string> = {
  c002: "Seat bar: the power name loses its box and sits centred in the bar",
  c003: "The map's review note replaces the green tick beside its name",
  c004: "Waiting room: the seat list is headed Seats, not At the table",
  c005: "Waiting room: the seat count reads as big figures and the rules as bullets, in the sidebar",
  c006: "The map's review note shows only in the variant gallery",
  c009: "The seat menu icon sits in a ring at full ink, centred with the name",
  c010: "Desktop gets its own spacing rhythm: more air between blocks, and a wider text column",
  c011: "Seat bar: the clock is bigger, and flashes red under thirty seconds",
  c013: "Seat bar: the orders count reads as a word, not an icon",
  c018: "The picked-map line under the button reads the same for every map",
  c014: "The top bar drops its tag line",
  c015: "Every rules summary is a bullet list, one fact per line, from one shared helper",
  c019: "The order notation switch names both states, Full orders and Abbreviated orders",
  c020: "Last phase: a resolved order reads as a green OK, and its order text sits a step larger",
  c021: "Each duty line is its own band: larger, padded, phase-coloured edge, air between them",
  c022: "The ready button drops the subtext where it only restates the main label",
  c023: "An ended game's panel leads with the result and drops the order entry, the ready button and the switch above it",
  c024: "The shared supply-centre table sits inside the game-over card, in place of an ad-hoc count of its own",
  c025: "The landing hero drops its eyebrow line",
  c026: "The landing tagline names all three ways to play, full press included",
  c027: "The ready button gets the sidebar's own gap from the line under it, and its all-in line reads as a notice",
  c028: "The variant name moves to the seat bar, in its own box beside the phase",
  c029: "An unreadable conversation says why in plain words, not key and device jargon",
  c030: "Seat bar: the variant name gets its own panel block, not just a trailing colour",
};

/* The same key the comment tool derives from its storage prefix, so the two
   registrations agree about where the switches are kept. */
registerFixes(FIX_IDS, { storeKey: "1901.dev.comments.fixes" });
