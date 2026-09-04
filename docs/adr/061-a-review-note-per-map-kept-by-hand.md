---
status: accepted
---

# ADR-061 — A review note per map, kept by hand beside the generated data

**Status:** accepted, r61. Softens ADR-014. Depends on ADR-051 for who owns
`variants/generated`.

ADR-014 gave every variant one bit: classical's opening position was checked,
and nothing else was. The screens drew that bit as a green tick beside the map
name, and the creation gallery spelled it out as **Verified** or **Not yet
verified**.

One bit was always too few. A person who has looked at a board wants to say
what they looked at — which rulebook, which edition of the map, that the coasts
are still unchecked, that the supply centres are right but two provinces have
the wrong long name. None of that fits in a tick, and a tick beside a name
invites the reader to think the check is a property of the software rather than
of somebody's afternoon.

**So each map may carry one sentence, written by a person.** `variants/notes.json`
maps a variant key to free text. The server reads it at startup and hands it to
the frontend as `note`, on the catalogue card and on the variant reference a
game carries. Screens print it, muted, after the map name, and print nothing
when there is nothing to print.

**The file is hand-kept, so it cannot live in `variants/generated`.** ADR-051
gave that directory to dipmap: the four files of a map are written together by
a tool, and anything else found there is on borrowed time. The note is the
opposite kind of fact — it is about the review, not about the board — so it sits
one level up, in a single file, tracked like source.

**One file, not one file per variant.** Twenty-six sentences are easier to read,
compare and correct as a list than as twenty-six directories to open, and the
list is the thing somebody reviews when they ask "which of these has anyone
looked at". A missing file is not an error: a checkout with no notes is a
server that says nothing about any board, which is what it said before.

**`supported` stays in the API and keeps its job.** It still sorts classical to
the top of the gallery, and it still puts the warning sentence beside the create
button when the picked map has not been checked. What it no longer does is
decorate a name. The tick is gone from the seat header, the waiting room, the
games list and the gallery card; the note takes its place where there is one.

**What this is not.** It is not a review workflow, a per-province checklist or a
signature. Nobody's name is attached and nothing is enforced. It is a sentence
in a file that a game master can read before deciding whether to trust a board,
which is what the tick was pretending to be.
