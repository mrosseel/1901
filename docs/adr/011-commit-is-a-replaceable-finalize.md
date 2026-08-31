---
status: accepted
---

# ADR-011 — Commit is a replaceable finalize

**Status:** accepted, r2. Built at r52 with ADR-004.
A re-commit replaces the seat's previous hash until the reveal window
opens; the server keeps only the latest hash per seat per phase, and the
event log records each re-commit without content. There is no draft state
on the server — drafts live only in the client.

Commit means finalize: the moment the last power commits, the reveal window
opens (ADR-008) and auto-reveal fires (ADR-009). The UI must label the action
accordingly ("Finalize orders — the turn resolves when all powers have
finalized"), because the last committer ends editing for the whole table.
## Revisions

Decisions this record changed, and alternatives it refused. Anything that was
only progress, a correction to the document, or a bug is gone.

- **r40, 2026-08-30** — Finalize was never true, because ADR-011 makes the commit replaceable until the phase resolves, and a lock is a thing you can open again.
