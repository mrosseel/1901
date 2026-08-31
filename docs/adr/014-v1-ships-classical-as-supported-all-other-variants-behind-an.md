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
