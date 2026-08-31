---
status: accepted
---

# ADR-048 — A key the game master holds, and twelve words to recover it

**Status:** accepted, r49 (owner decision, closes Q-009). Extends ADR-004, ADR-041.
Built for the game master, with alternative 1 built beside it.

Today the game master role is a URL and a cookie. Both live on one device and
neither can be recovered: the create response carries no secret on purpose
(ADR-041), the referee door answers only the browser that made the game, and a
lost cookie plus a lost bookmark is a game nobody can run any more. The
handover link is not the answer either. It is single use, so a copy kept as a
backup dies the moment anyone redeems it, and minting one needs the role you
have already lost.

The second problem is larger and is the reason this is worth more than a
recovery code. ADR-004's commit-reveal hides orders from other players. It does
not hide them from whoever runs the server, and a game master who also plays
is a player with the box in their lap. The design says that is what
commit-reveal is for; the mechanism as written still asks the table to trust
the process rather than letting them check it.

**The proposal.** The game master holds a keypair. The browser makes it at
creation, the server is given the public half and never sees the private one,
and the private half is written down as twelve words from a standard wordlist.
The role stops being a link somebody has and becomes a key somebody holds.

- **Recovery is typing.** Any device, any time: enter the words, derive the
  key, sign what the server asks, get a fresh token. No cookie, no bookmark,
  no expiry.
- **The URL becomes a convenience.** It still works and is still the fast
  path. It is no longer the only copy of the role.
- **Handover keeps its shape (ADR-041).** The epoch and the one-use link stay.
  What changes is that the incoming game master arrives with their own key
  rather than inheriting a token, and the outgoing one signs the change, so
  the record says who handed it over and not merely that it happened.

**What it buys for full press.** ADR-023 leaves a full-press mode open. Press
without keys means the server can read every message and could write one, and
"the app does not show your messages to the game master" is a promise about
the screens rather than a fact about the system. With a key per player:

- A message carries a signature. A game master cannot forge one from another
  player, and a player cannot disown one they sent. At a table where the whole
  game is lying to each other, the one thing that must not be forgeable is who
  said it.
- Commit-reveal becomes checkable. The commit is signed by a key the server
  never held, so anybody can verify after the phase that the orders revealed
  are the orders committed, including against a game master who plays.

That is the case for doing this properly rather than shipping a recovery code:
the recovery is the small half, and the signature is the half that changes
what the app can honestly claim.

**What it costs.**

- **It adds the one thing this app does not have: something to keep.** ADR-012
  and ADR-020 sell no accounts, no names, no passwords, and a seat you get by
  scanning a code. Twelve words is a credential with all the failure modes of
  a password and some of its own — mistyped, photographed, left on the table,
  screenshotted into a phone gallery. Any version of this that reaches the
  players trades away the promise the project is built on.
- **So the first version is the game master only.** One person per game, the
  person who already carries the game, and the person for whom being locked
  out is fatal rather than annoying. A player's seat stays a link and a
  handover, unchanged.
- **Twelve words at a tournament is friction** in exactly the minutes that are
  most crowded. It has to be skippable: make the key, show the words once,
  and let the game master carry on without writing them down if they choose.
- **Browser crypto is not free.** Ed25519 is not in every WebCrypto
  implementation, which means either P-256 or a small vendored library, and
  the offline requirement rules out fetching one. A wordlist is 2048 entries
  of dictionary that ships in the bundle.
- **The words are for recovery, not for every visit.** Something still has to
  hold the key between page loads, which is the same storage question the
  cookie already answers, with a worse answer available (a private key in
  localStorage) if it is done carelessly.

**Alternatives, cheapest first.**

1. **Show the game master link on the game master page**, guarded like every
   other secret there. Photograph it once and any device is a key. Solves the
   lockout, costs an afternoon, buys nothing cryptographic. This should be
   done whatever is decided here.
2. **A one-time recovery code**, shown at creation and stored hashed. Solves
   the lockout for somebody who kept it, and is a password by another name.
3. **This entry, game master only.** Solves the lockout properly and lays the
   foundation the press mode needs.
4. **Keys for every seat.** Solves the most and costs ADR-020.

**Recommendation.** Take 1 now regardless. Take this only if full press is
actually on the road: the seed phrase earns its keep where signatures do, and
as a recovery mechanism alone it is a heavy answer to a light question.

**Answered at r49, as built.**

- **Ed25519**, from a vendored library rather than WebCrypto, and SHA-512 is
  handed to it explicitly. `crypto.subtle` needs a secure context and run.sh
  serves plain http on a LAN, so nothing here may depend on it.
  `crypto.getRandomValues` carries no such rule and is the one platform call
  the browser half makes.
- **The words are HKDF-SHA256 of the entropy under a named salt**, not BIP-39's
  own PBKDF2 seed. There is no wallet on the other end, no passphrase, and 128
  bits of real entropy needs no stretching. The salt is what stops the key
  being reused anywhere else.
- **On demand, never at creation.** The card sits on the game master's own
  screen, folded and guarded like every other secret there, and the words are
  drawn on a button press. A game master who never opens it plays the game
  they always played, with no way back.
- **The server stores nothing when it is declined.** No key means no recovery
  and the page says so.
- **A recovery rotates.** Fresh token, referee cookie dropped, role epoch past
  every link minted under the old one — exactly what a role handover does.
  Two game masters is a worse failure than one locked out.
- **Write-once.** A second, different key is refused. The token is not the
  credential the key protects: somebody holding a stolen token already has the
  role, and overwriting the key would lock the real game master out of their
  own recovery.
- **In one line, to a table that has never met a seed phrase:** *there is no
  password here, so these twelve words are the only way back into this game.*

**Still open.** Keys for the seats, which is alternative 4 and costs ADR-020. The
signature half — a signed commit under ADR-004, signed press under ADR-023 — is
what this was built for and is not built.
