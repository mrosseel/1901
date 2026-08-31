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

From the revision log this decision used to live beside. Each line is
the sentence that revised it, with the document revision it came from.

- **r2, 2026-08-28** — ADR-011: commit is a replaceable finalize; last hash wins, no server-side drafts.
- **r40, 2026-08-30** — Finalize was never true, because ADR-011 makes the commit replaceable until the phase resolves, and a lock is a thing you can open again.
- **r40, 2026-08-30** — Commit and Reveal keep their names.
- **r40, 2026-08-30** — The decision entries above are left as they were written; CONTEXT.md carries the retired word.
- **r53, 2026-08-31** — The commitment became an envelope (ADR-004). Nothing here changes: locking again replaces it, unlocking deletes it, and both stop at the window for the same reason.
- **r52, 2026-08-31** — Built. Locking again replaces the digest and unlocking deletes it, both only until the window opens: a seat that could re-commit after that could read the other reveals first and change its mind, which is the whole thing this exists to prevent. A withdrawn lock deletes the hash rather than keeping it beside a false flag, or a phone could reveal against a commitment it had abandoned.
