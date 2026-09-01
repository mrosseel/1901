# Security review record

This file records the security review of 2026-08-28. It lists the fixes that
review produced, the risks we accept, and the checks that keep the record
true. Read it before you change the auth model, the serving path, or the
persistence layer.

Note on the name: GitHub treats SECURITY.md as a vulnerability disclosure
policy. This file is a review record, not one. Add a disclosure section when
the project has a public face.

## Scope and method

The review read every Go file, the network layer of `web/src` with a pattern
search over the rest of it, the CI workflow, and the flake. The tools were
`go vet`, `govulncheck` 1.7.0, `npm audit`, and a manual read of every HTTP
handler. A smoke test exercised the fixes on the packaged binary.

Not reviewed: godip itself. The adjudication engine is third-party code and
trusted; a review of its parsing and adjudication is separate work.

## The threat model

1901 runs at a physical table. Players scan QR codes on a LAN. The server
holds no accounts, no passwords, and no personal data. A seat's whole
identity is one random token in one URL (ADR-020).

The design accepts these facts:

- Tokens travel in URLs over plain HTTP. Anyone on the network who reads a
  seat URL owns that seat. The design trades this leak for QR simplicity,
  because the server must run with zero setup on someone's laptop.
- The SQLite file stores tokens in plaintext. Anyone who reads the file owns
  every seat in every game.
- The spectator view and the watch URLs are public by design (ADR-013). No
  draft order ever reaches them.
- A player holds one token and acts for one power. The GM holds the GM token
  and can force adjudication (ADR-010) and change settings.

The review asked four questions. Can a stranger read another power's draft
orders? Can a player act for another power? Can an anonymous client exhaust
the server? Can an attacker on the network redirect the links the GM shares?

## Fixed findings

1. Stalled clients held connections forever. The server used
   `http.ListenAndServe`, which sets no timeouts. Fix: `main.go` builds an
   `http.Server` with a 10 second header timeout, a 30 second read, a 60
   second write, and a 2 minute idle timeout. This also closed
   GO-2026-6089, the one reachable stdlib vulnerability.

2. Request bodies had no size limit. Every JSON handler decoded the whole
   body into memory. Fix: the `limitBody` middleware wraps the whole mux
   with `http.MaxBytesReader` at 64 KB. An oversized body now fails with
   400 instead of costing memory.

3. Anyone could create unlimited games. `POST /games` needs no secret, each
   game holds memory forever, and nothing expires. Fix: the registry
   refuses a create at its cap and answers 503. `MAX_GAMES` sets the cap,
   with a default of 100. A bad value is a startup error, not a silent
   default.

4. Generated links trusted the request's Host header. `baseURL` built the
   invite, seat, and GM URLs from `r.Host` and `X-Forwarded-Proto`. An
   attacker who can change traffic on the table network can make the GM's
   next state poll return links that point at their own machine, and the
   players then scan QR codes that leave the table. Fix: `BASE_URL` pins
   the origin at startup. When set, the host and forwarded headers of the
   request are never read. `pinBaseURL` validates the value and refuses one
   without an http or https scheme. The startup log states which origin is
   in use.

5. The toolchain carried four known stdlib vulnerabilities.
   `govulncheck` flagged GO-2026-6089 (net/http), GO-2026-6090
   (crypto/tls), GO-2026-6088 (encoding/xml), and GO-2026-5972
   (encoding/asn1) on go1.26.5. Only the net/http one was reachable from
   the serving path. Fix: `go.mod` demands go1.26.6 or newer. The flake
   pins go1.26.7. CI runs `govulncheck ./...` and fails the build on a
   reachable vulnerability.

6. A player-issued seat handover reused the outgoing holder's seed so the new
   phone could release an already-sealed envelope. That same seed was also the
   seat's signing identity, so the former holder could immediately sign back
   in after the server dropped their session. Fix: the recipient authenticates
   with a fresh seed and retains only the current phase's derived order key.

7. A game-master role handover rotated the URL token and referee cookie but
   kept the outgoing holder's recovery public key. Their twelve words could
   therefore take the role straight back. Fix: role handover retires that key;
   the incoming game master may enroll a fresh recovery key.

## Changes since the review

Two changes landed on the same day, both with a bearing on this file.

- The GM link is gone from the creation screen. The creating browser gets
  a referee cookie instead, and `GET /game/{id}/referee/` opens the GM
  view for that browser only. The GM token reaches one more place than
  before: the seat state of the GM's own power, which is the seat that
  already holds the GM rights.
- `GET /games` lists every game with public facts only. This gives up the
  secrecy of game ids: anyone on the network can enumerate games and open
  their watch views. What still protects a seat, the invite, and the GM
  controls is the tokens, not the id. The list itself marks the games the
  requesting browser created, and that mark is readable only with the
  referee cookie.

## Accepted risks and open findings

Each item here stands for now. A change to the threat model reopens it.

- No security headers yet. The app sends no CSP, no
  `X-Content-Type-Options`, no `frame-ancestors`, and no
  `Referrer-Policy`. Tokens live in URL paths, so a Referer leak hands a
  seat away. Nothing navigates off origin today, so the leak has no path.
  Add the headers as one middleware when the app grows any external link.
- The SVG map serves as a top level document, and SVG scripts run in the
  origin. The art comes from the binary and from checked-in style data, so
  no untrusted input reaches it today. Give the map responses a locked
  down CSP if that ever changes.
- Seat token lookup is not constant time. The GM token gets a constant time
  compare in `serveTokenScope`; seat tokens go through a map. With 24
  random bytes the timing leak is not practical to exploit. Index seats by
  `sha256(token)` if this ever matters.
- `handleJoin` accepts any device cookie value as a map key. Anyone with
  the invite token can fill the device map and the database with junk.
  Validate the value against the token shape.
- Tokens sit in plaintext in the SQLite file and its WAL. Fine on a trusted
  box, wrong once the file leaves it. Keep the DB out of synced folders.
- No rate limiting exists. Game IDs carry about 49 bits of entropy, so
  guessing a watch URL is impractical. Revisit only if the server leaves
  the LAN.
- Games never expire. The cap stops memory growth, not the eventual 503.
  Deleting a game is currently a manual database edit. An expiry policy or
  a GM delete endpoint needs a design decision.

## Checked and clean

The review verified each of these and found no defect. Do not undo them
without a reason.

- Every SQL query is parameterized. No string-built SQL exists.
- `serveSPAAsset` cleans paths, rejects `..`, and Go's mux normalizes the
  URL before the handler runs.
- The frontend uses no `dangerouslySetInnerHTML`. React escapes every
  server string, including the event log (ADR-007).
- Seat and GM actions require the token in the URL path, which a cross-site
  attacker cannot know. The device cookie is SameSite Lax, so cross-site
  joins cannot ride it. The model needs no CSRF token.
- The server re-checks ownership on every order and options request
  (`ownsProvince`). Seat state filters draft orders to the seat's power.
  No public endpoint carries a draft order.
- The event log and stdout carry no tokens.
- All tokens come from `crypto/rand` with 24 bytes.
- CI triggers on `pull_request`, not `pull_request_target`, and holds no
  secrets.

## Re-running the checks

Run these from the repo root. Every command must pass with no findings.

```
nix develop -c go vet ./...
nix develop -c go test ./...
nix develop -c govulncheck ./...
nix build .#default
```

```
cd web
npm audit
npm test
```

Then repeat the smoke test against the packaged binary. Use a throwaway
port and a throwaway database.

```
DB=/tmp/1901-audit.db ADDR=:8199 BASE_URL=https://dip.example MAX_GAMES=2 \
  ./result/bin/1901
```

The create response must name dip.example, whatever Host the request
claims.

```
curl -s -X POST localhost:8199/games -H 'Host: evil.example' -d '{}'
```

The third create must answer 503, because the cap is 2.

```
curl -s -o /dev/null -w '%{http_code}\n' -X POST localhost:8199/games -d '{}'
curl -s -o /dev/null -w '%{http_code}\n' -X POST localhost:8199/games -d '{}'
curl -s -o /dev/null -w '%{http_code}\n' -X POST localhost:8199/games -d '{}'
```

A body over 64 KB must answer 400.

```
head -c 100000 /dev/zero | tr '\0' a | \
  curl -s -o /dev/null -w '%{http_code}\n' -X POST localhost:8199/games \
  -H 'Content-Type: application/json' --data-binary @-
```

## Configuration

- `BASE_URL` pins the origin for every generated link. Set it behind a
  proxy, or anywhere the host can differ from what clients send.
- Without `BASE_URL`, a loopback host in the request becomes the server's
  own LAN address, so the QR code opens on a phone. The address comes from
  the kernel's routing table, never from the request, so this trusts nothing
  new. Every other host is passed through as before.
- `MAX_GAMES` caps live games. Default 100.
- `ADDR` and `DB` set the listen address and the database path.
- `SPADIR` and `PLACEMENTS` point at the frontend build and the placement
  tables. The nix package sets both.
