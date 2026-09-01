---
status: accepted
---

# ADR-014 — v1 ships classical as supported, all other variants behind an experimental flag

**Status:** accepted, r2 (closes Q-006)
The placement-table generator (ADR-003) runs over all godip variants with an
`svg/` dir (17 as of 2026-08-28). Classical is hand-checked, playtested,
and presented as supported. The rest are selectable at game creation.
UI presentation: every creation card says **Verified** or **Not yet
verified**. Choosing an unverified map repeats the warning beside the create
action. Other screens may keep the compact green checkmark. The supported
flag remains in the API. Promoting a
variant to supported is data work only: check its generated table, remove
the flag.
## Revisions

Decisions this record changed, and alternatives it refused. Anything that was
only progress, a correction to the document, or a bug is gone.

- **r15, 2026-08-28** — ADR-014 presentation: checkmark for supported, no experimental badge.
- **r55, 2026-09-01** — Creation no longer treats silence as disclosure.
  Unsupported variants are explicit where the choice is made.
