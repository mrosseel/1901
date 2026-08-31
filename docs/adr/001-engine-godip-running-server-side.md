---
status: accepted
---

# ADR-001 — Engine: godip, running server-side

**Status:** accepted, r1
Take `zond/godip` as a vendored Go library. Rationale: 26 variants and 119
map SVGs available immediately; `Options()` and `Corroborate()` are already
nation-scoped, which makes the no-leak property structural rather than
something we enforce by hand; the regression corpus from real games is worth
more than a cleaner API.

Rejected: TedDriggs/diplomacy (Rust, MIT). Better license and type system,
but no variants and no map assets — several months of work we'd be adding to
get back to parity. Revisit only if ADR-002 (GPL) becomes a blocker.

Rejected: porting jDip's adjudicator to Rust/Zig. ~15–20k LOC of subtle
rules code, 2–4 months to DATC-green, reimplementing what godip already
proved against 5,000 real games. No upside.

## Revisions

From the revision log this decision used to live beside. Each line is
the sentence that revised it, with the document revision it came from.

- **r1, 2026-08-28** — Decisions ADR-001 through ADR-008 taken.
- **r1, 2026-08-28** — Q-001 through Q-006 open.
- **r1, 2026-08-28** — No code written.
