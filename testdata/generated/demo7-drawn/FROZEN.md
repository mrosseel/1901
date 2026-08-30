# demo7-drawn — frozen, never regenerate

This is the last export that draws its names and supply centres in the art
**and** states the same positions as records in `placements.json`. Both came
out of one placement search, in one coordinate space, in one run.

That is the only thing that makes `web/src/board/labels.test.ts` an
independent check. It strips the two layers out of this art to force data
mode, then asserts the board redraws each name where the art had drawn it.
Against records alone the test would be the reader reading what the reader was
given, and it would pass whatever the reader did with the numbers.

The exporter no longer writes these layers. Regenerating this directory
destroys the evidence and cannot be undone by re-running anything.

`demo7/` beside it is the live fixture and is regenerated freely.
