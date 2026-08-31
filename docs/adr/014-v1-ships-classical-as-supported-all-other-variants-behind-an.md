---
status: accepted
---

# ADR-014 — v1 ships classical as supported, all other variants behind an experimental flag

**Status:** accepted, r2 (closes Q-006)
The placement-table generator (ADR-003) runs over all godip variants with an
`svg/` dir (17 as of 2026-08-28). Classical is hand-checked, playtested,
and presented as supported. The rest are selectable at game creation.
UI presentation (changed r15, owner call): supported variants show a
green checkmark; unverified ones show nothing — no experimental badge or
warning text. The supported flag itself remains in the API and still
gates the checkmark. Promoting a
variant to supported is data work only: check its generated table, remove
the flag.

## Revisions

From the revision log this decision used to live beside. Each line is
the sentence that revised it, with the document revision it came from.

- **r2, 2026-08-28** — ADR-014: classical supported in v1, other variants behind an experimental flag; closes Q-006.
- **r2, 2026-08-28** — Q-003 gains jDip's 201 KB map as a measured art fallback.
- **r15, 2026-08-28** — ADR-014 presentation: checkmark for supported, no experimental badge.
- **r15, 2026-08-28** — Restyle shipped as scripted theming (no LLM needed); style system with four named themes underway.
- **r15, 2026-08-28** — Placement pipeline (audit/optimize/editor/serving) complete for classical + sailho.
- **r16, 2026-08-28** — Experimental badge removed per ADR-014 presentation (r15).
