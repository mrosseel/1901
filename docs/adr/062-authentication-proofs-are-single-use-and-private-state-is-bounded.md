# 062 — Authentication proofs are single-use and private state is bounded

Date: 2026-09-05

The September 5 security review reproduced duplicate signing-key enrollment
and replayable GM recovery. It also found unbounded seat sessions and message
history, and cookies that remained eligible for HTTP transport on HTTPS sites.

## Identity and authentication

A signing key has exactly one canonical base64url encoding and holds at most
one power per game. Join and handover reject duplicate bindings before changing
any seat, session, device claim or epoch. Handover also rejects reuse of the
outgoing holder's key. Startup refuses contradictory persisted bindings and
names the affected game; it never chooses one power silently.

The keyed join and handover API addresses now accept GET to obtain an enrollment
challenge. The proof is checked before the duplicate-key check, so the shared
invite link cannot ask which keys hold a seat. GET never takes a seat. POST carries the new public key, nonce, and
an Ed25519 signature over `1901 seat enrollment|game|purpose|nonce`. The purpose
is `join` or `handover:power:epoch`. The bearer invitation/handover link remains
required. Token-only legacy enrollment remains available; supplying a signing
key without proof is no longer accepted.

Session, enrollment and GM recovery challenges last ten minutes. Their HMAC
uses a process-local secret, separate from the persisted handover-link secret.
A successful proof atomically records the nonce's SHA-256 hash until expiry.
Bad signatures do not consume it. Recovery's HMAC purpose includes the current
GM epoch, so another recovery or role transfer invalidates outstanding proofs.
A restart invalidates all outstanding challenges.

Anonymous challenge issuance allocates no replay-cache records. Consumed hashes
are kept per game, capped at 256 per game and 32 per signing key. A key that
reaches its share is refused alone; a full game refuses issuance and
consumption for that game only, until hashes expire. Capacity checks walk one
game's bucket, never the whole cache. Memory is bounded by the live-game cap
times 256. No cache eviction makes an unexpired proof replayable. The client signs a locally constructed protocol
message and retries a rejected challenge once with fresh bytes.

Seat sessions expire on the server after seven days. At most eight sessions
may be open per power; a new one prunes expired records then evicts the oldest
active session if needed. Handovers still revoke every outgoing session.

## Press

Each game may store 16 MiB of message envelope data and metadata, counting the
UTF-8 bytes of ciphertext, signature, sender and timestamp, plus 32 bytes per
message for numeric/row bookkeeping. This is an application payload quota, not
an exact SQLite file-size limit. The quota is split evenly between the seats
and the game master, so one sender cannot fill the game for everyone. Existing
games beyond the quota stay readable; new messages are refused without deleting
history. The totals are rebuilt per sender with SQLite BLOB byte lengths on
restart, so Unicode cannot bypass them.

A sender has a burst of ten messages, replenished by one message every three
seconds. The bucket is per holder per game, shared across all rooms and notes.
429 responses include `Retry-After: 3`; quota refusals use 409. A rejection does
not advance the message sequence.

SQLite remains the message archive. Only the latest message per room is held
in memory; unread counts are cached separately and restored from the archive.
History responses contain at most 100 messages. With no cursor the response is
the latest page; `before` pages backward and an explicit `since` pages forward.
The original signed sequence and envelope are returned unchanged. `lastSeq`
still means the whole room's last sequence, not the end of a page. `hasOlder`
and `hasMore` identify additional history. The client offers older/latest
navigation and keeps a single page of decrypted messages at a time.

The existing 512-room and 32 KiB request limits remain in force. These limits
do not provide general HTTP rate limiting or cap all possible SQLite overhead.

## Transport and rollout

Every seat/admin/device/referee cookie uses one Secure policy: direct TLS or
an HTTPS `BASE_URL` requires Secure. With no pinned origin, only a configured
trusted proxy may assert HTTPS in the last `X-Forwarded-Proto` hop. An explicit
HTTP `BASE_URL` retains LAN HTTP mode (direct TLS still wins). Cookie deletion
uses the same policy and scope.

All `/api/v1` responses use `Cache-Control: no-store`, including errors. The
credential-bearing referee redirect also uses no-store.

Deploy the frontend and backend together. Already-loaded older clients may
need a reload to join or accept a keyed handover; no insecure proof bypass is
provided for them. Existing stored seat keys and message archives need no
schema migration. A contradictory legacy seat-key binding requires the owner
to resolve the affected saved game before startup can succeed.

CSP, HSTS deployment policy, general create/admin abuse protection and trusted
client distribution against a malicious hosting operator remain separate work.
