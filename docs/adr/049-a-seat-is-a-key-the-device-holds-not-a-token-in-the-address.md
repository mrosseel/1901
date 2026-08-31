---
status: accepted
---

# ADR-049 — A seat is a key the device holds, not a token in the address

**Status:** accepted, r50 (owner request). Extends ADR-012, ADR-020, ADR-041, ADR-048.
Built for access; the signature half is not.

A seat was a secret in an address. Whoever read `/game/{id}/seat/{token}` was
that power, and the same string sat in the `seat` table. So a copied `1901.db`,
a laptop backup, or a server somebody kept after the tournament was a set of
working seats — for as long as the game ran, and afterwards for anybody
replaying it.

**The change.** The joining device makes 32 random bytes, derives an Ed25519
key from them, and sends the public half with its claim. The server stores 32
public bytes and can open nothing with them. The seed stays on the phone.

Three questions ran together in the first draft and are answered apart:

- **Who makes it.** The device, at the moment of claiming. The server never
  makes one and never sees one.
- **Where it lives.** The device's own storage, one entry per game, so a closed
  tab does not lose the seat.
- **How it travels.** The fragment of a URL, and only when somebody asks for
  the seat's link. A browser never puts the part after `#` in a request, so the
  seed reaches no server, no log and no `Referer` header. It is read once at
  start-up and taken out of the address.

Storage alone would be tidier and would break what this app is for: a second
device, passing the phone round the table, a bookmark, a scanned code. The
address is the seat (ADR-012), so the address has to be able to carry it.

**Access and authorship are two different jobs.** Signing every request is slow
and buys little. Signing in once — a challenge the server mints, a signature,
an HttpOnly session cookie — is enough to read the board and write a draft. The
signature that will matter is the one over a sealed order (ADR-004), and that is
not built. So a stolen cookie reads a screen and dies at the next handover; it
is not the key, and it cannot produce a signed order.

Sessions live in memory and not in the database. A restart ends them and every
device signs back in without being asked, because the seed is on the device.
What a restart must never do is leave a credential in a file that can be
copied, which is the whole point.

**No migration.** A seat row holds a token or a public key, never both. Games
made before this keep their tokens and keep working; games made after it get
keys. A game lasts an evening, so the token path can be deleted when the last
game that uses it is over rather than migrated. One rule holds it together:
nothing anywhere may ask whether a seat has a token to decide whether it is
claimed — `seat.claimed()` is the only predicate, and it reads both.

**What is not keyed.** The game master's own seat. It is dealt at the start
from the game master's page, which already holds a stronger credential
(ADR-048), and giving it a key would mean minting one on a screen that is often
on a beamer. It keeps a token, and the exception is written here so nobody
reads the mixed state as a bug.

**What this buys before any sealed order.** A stolen database stops being a set
of seats. That is worth having on its own.

**What it does not buy.** The server still ships the JavaScript. A game master
who wants the orders can serve a page that posts them twice. The claim this
earns is *the server does not need your orders, and no copy of the database
gives them up later* — not "nobody can read them".
