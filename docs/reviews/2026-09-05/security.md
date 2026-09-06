# Security review — 5 September 2026

> Implementation update: all four findings below are now addressed in the
> working tree. See [ADR-062](../../adr/062-authentication-proofs-are-single-use-and-private-state-is-bounded.md)
> for limits, protocol changes and rollout requirements. The review text and
> original probes below describe the pre-fix behavior; the executable regression
> tests in `internal/server/security_test.go`, `presslimits_test.go`, and
> `web/src/auth.test.ts` assert the repaired behavior.

## Verification after implementation

- Full Go suite and `go vet ./...`: passed.
- Server suite with race detection: passed.
- Frontend production build: passed; 39 test files and 604 tests passed.
- Dependency scans: zero npm advisories and zero reachable Go vulnerabilities.
  The Go scanner still reports three advisories in required modules whose
  affected packages are not imported.
- A real browser against a freshly built server and isolated SQLite database
  successfully exercised keyed joining, session reconnection, signed/encrypted
  press, paginated decryption, GM recovery, and keyed handover. The outgoing
  seat key was refused after handover.
- A restart regression exercised 225 stored messages, retained only the latest
  message in memory, preserved byte totals and unread counts, and returned
  unchanged envelopes across forward and backward pages.

The changes are implemented locally, not deployed. Deploy client and server
together; older open tabs may need a reload before keyed enrollment or handover.
The original findings and pre-fix evidence follow.


Review of the current Go/React checkout. No production behavior changed. Authentication probes ran against isolated in-memory test games; browser inspection used a temporary database. The existing change to `variants/generated/coldwar/placements.json` was left alone.

## Findings, in repair order

### 1. Medium — duplicate public keys corrupt seat identity

`internal/server/join.go:132` calls `bindSeatKey` without checking that the key is unclaimed or requiring proof of possession. `internal/server/seatkey.go:71–80` overwrites `bySignPub[signPub]` unconditionally. The handover binding uses the same helper.

An invite holder can submit another player's public signing key while a seat remains available. The new claim gets its own session, but future authentication by the original player resolves to the newly claimed power. The original seat remains bound to the same key in its row, with a contradictory reverse index. Existing sessions remain on their original powers. This is identity corruption and denial of access, not proof that the attacker immediately reads the victim's original orders. Public keys are not secrets; full-press participants receive signing keys.

**Reproduced:** a second join using the first seat's public key returned 200 and changed the reverse lookup from Austria to Russia without knowing the private key.

**Repair:** reject a public key already bound to any other power, under the same game lock, before mutating either seat. Enforce this on joining, handover, and loading persisted state. Add proof of key possession to enrollment. Acceptance: duplicate enrollment changes no seat, session, or index; the original signature still opens the original power.

### 2. Medium — signed recovery and session requests are replayable

`internal/server/gmkey.go:95–108` checks the HMAC and ten-minute deadline but does not consume the nonce. `handleRecoverClaim` rotates the GM token on every successful replay; `handleSeatSession` issues a new session for every replay.

Someone who obtains a valid signed request can replay it during its validity window without the seed. Recovery replays return a fresh GM URL and invalidate the holder's previous one. This requires capture of a legitimate request, such as through the explicitly supported plain-HTTP deployment or exposed request-body logs; it is not an unauthenticated signature forgery. HTTPS reduces capture risk but does not provide application-level replay protection.

**Reproduced:** the identical recovery body was accepted twice and rotated the GM token twice.

**Repair:** atomically consume successfully verified nonces, retain consumed hashes until expiry, and bind recovery challenges to the current role epoch. Do not consume a nonce before signature verification. Acceptance: the second request fails; two concurrent submissions produce exactly one success.

### 3. Medium — authenticated resource growth is unbounded

`internal/server/presshttp.go:508–512` persists every accepted message and retains it in `t.messages`. `internal/server/pressstore.go` loads all messages on restart. The 32 KiB request limit and 512-room cap do not cap messages or total bytes. `handlePressThread` can return the entire history while holding the game lock. A legitimate seat can continually send correctly sized messages during writable press phases, growing both memory and disk. A malicious user can also create their own full-press game on the public create endpoint.

Separately, `internal/server/seatkey.go:95–101` retains every opened session indefinitely; cookie MaxAge is not a server-side expiry and `sessionPower` checks only map membership. Repeated authenticated logins grow this map until handover or restart.

**Evidence:** code-path review, not a destructive exhaustion test.

**Repair:** per-sender rate limits and per-game stored-byte quotas, paginated history loaded on demand, server-side session expiry and a bounded device/session count. Acceptance: sustained authenticated traffic reaches a documented limit without growing memory indefinitely, and copied expired cookies fail authorization.

### 4. Medium on HTTPS deployments — credentials lack Secure cookies

`internal/server/seatkey.go:114–122`, `internal/server/admin.go:setAdminCookie`, and device/referee cookie setters omit `Secure`. Consequently even a deployment used over HTTPS can send bearer cookies on a matching HTTP request. SameSite and HttpOnly do not prevent this. Exploitation requires an HTTP request to that host/path and an observer of the cleartext traffic; this adds risk to HTTPS deployments beyond the accepted local HTTP mode.

**Repair:** set Secure whenever the deployment's trusted external origin is HTTPS, including reverse-proxy operation, and retain an explicit local HTTP mode. Add transport tests for both modes. Consider HSTS for public HTTPS deployment.

## Other observations

- Sensitive JSON has no explicit `Cache-Control: no-store`; only the SPA shell sets it. Add it to authenticated state, recovery/session, and admin responses. No shared-cache leak was demonstrated.
- No app-level CSP or anti-framing headers were found. Add `frame-ancestors 'self'` (the screen gallery uses same-origin iframes), `X-Content-Type-Options: nosniff`, and a deliberate Referrer-Policy. Missing headers alone are not evidence of an XSS exploit.
- The create endpoint is intentionally public. The game cap bounds allocation but an anonymous caller can fill remaining capacity; decide whether hosted deployments need create authorization or rate limits.
- The one-second admin-login sleep delays individual attempts but is not a concurrent rate limiter.
- Public board/history and plaintext local HTTP are documented design choices. A server that delivers the JavaScript can also replace the cryptographic client; end-to-end guarantees against that operator require independently trusted client distribution. This review does not claim to solve that trust model.

## Previous review reconciliation

Current code now signs room manifests, authenticates wraps, retains signing-key pins and requires confirmation for unsigned key changes, pads messages/orders, and separates public/authenticated WebSocket quotas. The headline room-wrap flaw from the September 2 review should not be carried forward as if those fixes did not exist. The global socket cap is still shared. `SECURITY.md` also contains outdated claims (all seats are URL tokens, deletion needs manual SQL, and device claims can grow without regard to available seats).

## Verification and limits

- `nix develop -c go test ./internal/server ./internal/svgsafe`: passed.
- `npm test`: 38 files, 598 tests passed; gallery tests emitted fixture-map warnings.
- `npm audit --json`: zero reported vulnerabilities.
- `nix develop -c govulncheck ./...`: zero reachable vulnerabilities; three advisories in required modules, none in imported packages or called code according to the scanner.
- Two temporary reproduction tests passed by asserting the vulnerable behavior. Source is retained as `auth-probes.go.txt`, outside the test suite so vulnerable behavior is not installed as a regression requirement. To reproduce, copy it into `internal/server/security_review_probe_test.go`, run `nix develop -c go test ./internal/server -run TestReview -v`, then remove that temporary copy.

This is a targeted source review with isolated probes, not a full cryptographic audit, deployment penetration test, or certification. Third-party adjudication internals and the production reverse-proxy configuration were not audited.
