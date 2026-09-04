---
status: accepted
---

# ADR-060 — Admin is one secret from the environment

**Status:** accepted, r59. Extends ADR-020. Depends on ADR-050 for where the
addresses live.

The person who runs the server is not a player. They started the process, the
database is their disk, and a public address collects test games the way a
table collects empty glasses. Somebody has to be able to throw one away, and
until now nobody could: the only way to delete a game was to stop the server
and edit the file.

**One shared secret, read from `ADMIN_TOKEN` at startup.** No account, no
username, no row in the database. ADR-020 says there are no accounts and that
still holds: this is not a person the server knows, it is the environment the
process was started in. Whoever can set an environment variable on that box can
already delete `1901.db` with `rm`, so nothing here hands out a power that was
being withheld.

**Unset means there is no door.** Every address under `/api/v1/admin` answers
404 on a server with no token, and the page says admin is not enabled. A server
nobody meant to administer should look like a build that never had the feature,
so nothing tells a stranger there is a login to find. The `/admin` page itself
is served everywhere, because it is one more route of the same shell and the
shell knows nothing.

**The session is a cookie, and the cookie is a random value this process
remembers.** Not a signature over the token, and not the token itself. A
restart ends every session and the owner types the token again, which is the
right way round for a credential typed by hand: nothing photographed, backed up
or copied out of a cookie jar outlives the binary that issued it. The cookie is
HttpOnly, scoped to the admin path, and SameSite strict rather than lax,
because nothing links into this surface from anywhere and a delete button
should not be pressable from somebody else's page. A wrong token costs a
second, which stops a script from turning one address into thousands of tries.

**The only power is deleting a game.** Not editing one, not reading orders, not
taking a seat. That matters more than it sounds: ADR-004 seals orders because
the person running the server is usually sitting at the board, and an admin who
could open a game would undo it. So the token opens a list and a delete, and a
game master's key stays the only way into a game master's view.

A delete takes the game row, and the schema takes the rest: every table that
hangs off a game names `game_id` with `ON DELETE CASCADE` and the connection
runs with foreign keys on. The game leaves the registry first and every open
socket on it is cut, or a phone would sit watching a board that no longer
exists. A sandbox is a game with a flag (ADR-047), so it deletes like one.

**Why this is enough.** The thing being protected is a handful of Diplomacy
games on one box. The failure this feature prevents is a game list nobody can
clean. Accounts, roles and an audit log would cost more to build than the whole
of what they guard, and the audit log in particular has nothing to record: one
person holds the token, and if two people hold it the log cannot tell them
apart anyway. When a second power is wanted here, that is the moment to ask
whether the answer is still one secret.

**What this is not.** It is not a hosted-multi-tenant login (ADR-018), which
would need real accounts and is a different decision. It is not a way into a
game. And it is not a reason for the game list to grow an owner's column: the
list is public and stays public, with the delete control appearing only for the
browser that holds the session.
