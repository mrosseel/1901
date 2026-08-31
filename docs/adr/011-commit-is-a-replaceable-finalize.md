---
status: accepted
---

# ADR-011 — Commit is a replaceable finalize

**Status:** accepted, r2
A re-commit replaces the seat's previous hash until the reveal window
opens; the server keeps only the latest hash per seat per phase, and the
event log records each re-commit without content. There is no draft state
on the server — drafts live only in the client.

Commit means finalize: the moment the last power commits, the reveal window
opens (ADR-008) and auto-reveal fires (ADR-009). The UI must label the action
accordingly ("Finalize orders — the turn resolves when all powers have
finalized"), because the last committer ends editing for the whole table.

## Revisions

From the revision log this decision used to live beside. Each line is
the sentence that revised it, with the document revision it came from.

- **r2, 2026-08-28** — ADR-011: commit is a replaceable finalize; last hash wins, no server-side drafts.
- **r40, 2026-08-30** — Finalize was never true, because ADR-011 makes the commit replaceable until the phase resolves, and a lock is a thing you can open again.
- **r40, 2026-08-30** — Commit and Reveal keep their names.
- **r40, 2026-08-30** — The decision entries above are left as they were written; CONTEXT.md carries the retired word.
