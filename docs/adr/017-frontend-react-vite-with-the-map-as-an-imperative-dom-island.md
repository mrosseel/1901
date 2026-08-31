---
status: accepted
---

# ADR-017 — Frontend: React + Vite, with the map as an imperative DOM island

**Status:** accepted, r5 (closes Q-002). Amended r12: applies from M1, not
M2 — the M1 flow pages are exactly the component-heavy chrome React was
chosen for, and building them twice (vanilla, then ported) buys nothing.
TypeScript. The M0 sandbox at /g/{id}/ stays vanilla until the React seat
board fully replaces it. Only the board core moves from static/app.js into
the island module — everything it learned (gestures, graphics, integration
fixes) carries over.
React with Vite for dev server/HMR and production build; build output is
embedded in the Go binary per ADR-006. Owner preference: familiarity,
component ecosystem, and the amount of chrome UI ahead (order panels, seat
views, GM view, audit feed).

Non-negotiable constraint that answers Q-002's performance worry: the map
SVG never enters the React tree. It is injected once into a ref'd
container and driven imperatively — unit overlay, highlight classes, and
viewBox pan/zoom by direct DOM manipulation, as the M0 spike does. React
renders around the map, not through it. If this rule is ever broken,
Q-002's VDOM-overhead concern returns with it.

Considered: Svelte and SolidJS — equally capable here and equally served
by Vite; rejected on familiarity, not on merit. Note autoreload was no
tiebreaker: Vite HMR works for all three.
