---
status: accepted
---

# ADR-016 — New variants come via a jDip adjacency-XML translator, not by hand

**Status:** accepted, r4. Post-v1; nothing in M0–M5 depends on it.
When a variant that godip lacks is wanted (1900, Modern, Renaissance, …),
the route is a one-shot translator from jDip's variant data to a godip
variant package, not a hand-written port. Per variant, jDip ships:

- `*_adjacency.xml` — the full typed adjacency graph: one `PROVINCE` per
  province with `ADJACENCY` edges typed for army/fleet/coast movement
  (e.g. `<ADJACENCY type="xc" refs="apu ven tri bos mac-wc ion"/>`).
- `variants.xml` — starting units, supply centres, powers, victory
  conditions.
- A map SVG with `_abc` hit paths and `jdipNS:PROVINCE_DATA` placement
  coordinates (§2.1).

The translator generates the mechanical 80% of a godip variant: the graph
(`graph.go`-style edge declarations), starting positions, SC ownership,
and nation list, plus a converted map (ids renamed to godip's scheme,
`stp-sc` → `stp/sc`, label layers unhidden, placement table emitted).
Hand work remains for what XML cannot express: variant-specific rules,
phase oddities, and a DATC-style test file per variant. Restyling the flat
jDip art to godip's visual standard (§2.4) is a separate, optional effort.

Scope guard: build the translator the first time a concrete variant is
actually wanted, not speculatively. *Activated r14:* pilot variants are
**1900** (few special rules, popular) and **Sail Ho** (owner favorite).
Sources copied into `tools/jdip-import/source/`. Phase 1: translator +
map conversion (ids, labels, Center anchors generated from
PROVINCE_DATA) + registration as experimental variants. Phase 2:
LLM-assisted restyle to godip's visual style — deterministic script for
palette/pattern injection, vision model (via OpenRouter) for shape
classification and before/after QA; needs an OpenRouter key. Rejected alternative: porting variants
by hand from rulebooks — retypes an adjacency graph that already exists in
machine-readable form, and typos in adjacency data are exactly the bugs
that surface mid-game at a table.

---
