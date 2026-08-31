---
status: accepted
---

# ADR-039 — There will be no jDip maps, only 1901 maps

**Status:** accepted, r31 (owner decision). Sets the end state for ADR-016,
ADR-024, ADR-033 and ADR-038.
The jDip importer is a migration, not a supported input. Every map it converts
becomes an ordinary 1901 map, and when the last one has crossed, jDip is gone
from this project: no jDip art, no jDip code path, no jDip shaped plan.

The tool itself may outlive the migration. It lives in dipmap, and keeping it
there costs 1901 nothing, because what it produces is an ordinary 1901 map. If
a jDip map nobody knew about turns up in a year, it is imported and it arrives
in data mode like any other. That is the point of the distinction: the format
dies here, the tool need not die there. Nothing in this repository should be
kept alive on the theory that another jDip map might appear.

This is what ADR-016 was always for. It called the translator a way to add
variants, and the variants it added kept jDip's shape for as long as they
lived. They no longer do. A converted map is finished when nothing about it
says where it came from.

**What this deletes, once no jDip art remains.** The second style applier and
everything only it needs: `applyJDipStyle`, `jdipPlan`, the label scale and
the legibility floor, `carryLabel`, the label metrics and classes, and the
typography and supply-centre tokens the jDip path alone reads. On the board:
the layer pair it switches between, and the code that reads a name or an
anchor out of the art. A style plan stops having two shapes.

So the two appliers do collapse. Not because labels move to data, which was
the earlier reading and was wrong: the reason there are two is ADR-024, one
matching fills by value and one writing class rules, and that survives labels
leaving. They collapse because one of the two kinds stops existing.

**The hybrid in ADR-038 is a stage, not a resting place.** A map keeps its names
layer only until it is re-authored. The end state has every map in data mode
and no fallback path at all.

**Four maps need a person, not a pass.** Gateway West, North Sea Wars, Sengoku
and Vietnam War draw their names as outlined shapes carrying no string, and an
automatic recovery reached 39 of 53 provinces on one of them while merging and
splitting names. Those are re-authored in dipmap or dropped. Ancient
Mediterranean and Unconstitutional never drew names and simply gain them.

**Order.** Nothing here is urgent, and none of the deletions may happen while
one jDip art is still served. The sequence is: the importer moves (ADR-033), the
maps cross one at a time, the last crossing removes the art, and only then the
code that read it goes. A deletion made early is a variant nobody can play.
## Revisions

Decisions this record changed, and alternatives it refused. Anything that was
only progress, a correction to the document, or a bug is gone.

- **r32, 2026-08-30** — ADR-039 refined: the importer may outlive the migration, in dipmap, because what it produces is an ordinary 1901 map.
