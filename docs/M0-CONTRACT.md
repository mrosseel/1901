# M0 spike — API contract and scope

> **Historical.** The M0 sandbox was removed after the React M1 flow
> replaced it (see DESIGN.md r13). Kept as a record of the spike's shape.


Scope: DESIGN.md §7 M0 only. One hardcoded classical game, in-memory, no
auth, no persistence, no commit-reveal, no GM. All seven powers are
operated from one screen. Success: play a full Spring 1901 movement phase
in the browser.

## Layout

- `go.mod` — module `spring1901/spike`, require `github.com/zond/godip`
- `main.go` (plus more files if useful) — HTTP server, port 8190
- `static/` — `index.html`, `app.js`, `app.css` (vanilla JS, no
  framework, no build step)

Run with: `nix shell nixpkgs#go -c go run .`

## Server endpoints

- `GET /` and `/static/*` — serve the frontend.
- `GET /map.svg` — the classical map, from godip:
  `variants/classical.Classical.SVGMap()` (bytes as-is,
  `Content-Type: image/svg+xml`).
- `GET /state` — JSON:
  `{"phase": {"season": "Spring", "year": 1901, "type": "Movement"},
    "units": {"vie": {"type": "Army", "nation": "Austria"}, ...},
    "orders": {"vie": "Army Vienna -> Trieste", ...},
    "resolutions": {"vie": "OK", ...}}`
  `orders` holds the orders entered this phase (human-readable strings);
  `resolutions` is empty until an adjudication happens, then holds godip's
  per-province resolution strings for the previous phase.
- `GET /options?province=vie` — the legal-order tree for the unit in that
  province, from `state.Phase().Options(state, nation)` filtered to that
  province, serialized as nested JSON exactly as godip returns it
  (`Options` is a recursive map). The frontend walks it to build an order
  by clicks alone.
- `POST /order` — body `{"province": "vie", "parts": ["Move", "tri"]}`
  or the shape the Options tree implies; server stores it with
  `state.SetOrders` semantics. Replacing an existing order for the same
  province is allowed. Return the updated `/state` JSON.
- `POST /adjudicate` — call `state.Next()`, return the updated `/state`
  JSON (with `resolutions` filled).

If godip's real API shapes make any field above awkward, follow godip and
note the deviation in your report — do not fight the library.

## Frontend behavior

- Render `/map.svg` inline (fetch, inject as DOM, not `<img>`), full
  width, pan/zoom NOT required.
- Overlay units as circles/triangles (army/fleet) at the `<abbr>Center`
  anchor coordinates read from the map SVG itself (each province has a
  path with id `<abbr>Center`; its path data starts `m X,Y`). Color by
  nation (any 7 distinguishable colors).
- Click a unit's province → fetch `/options` → show the option tree as
  tappable buttons (e.g. Move / Support / Hold, then target provinces).
  Clicking through builds the order; on completion POST `/order`.
- Provinces that are legal targets at the current step of order building
  get a highlight class; clicking the map instead of a button also works
  if cheap, buttons alone are acceptable.
- Entered orders are listed as text in a sidebar with the owning nation.
- An "Adjudicate" button POSTs `/adjudicate`, then re-renders units and
  shows the resolutions list.
- No framework, no bundler, no external CDN. Modern browsers only.

## Non-goals for M0

Do not add: sessions, tokens, SQLite, WebSockets, commit-reveal, deadlines,
retreat/build phase UI polish (adjudicating into autumn is fine; the UI
only needs movement orders to work), tests beyond `go vet`/compile, CI.
