/*
The map island.

Everything that touches the SVG is here, in plain TypeScript with no React:
map injection, pan and zoom, the unit and order overlays, province highlights,
and the tap grammar that turns taps into orders. React mounts it once, feeds it
state, and draws the panels around it (D-017).

The board is driven through a small interface — mount(), update(), destroy() —
and reports back through callbacks: the hint line, the order builder to draw,
the state that came back from an order post, and which order is singled out.
*/

import {
  baseProvince,
  describeOrder,
  powerColor,
  provinceName,
  unitLabel,
} from "./provinces";
import { describeInPhase, emptyPlan } from "./phases";
import type { PhasePlan } from "./phases";
import { optionsHint, shortcutsFor } from "./hints";
import {
  inkForStyle,
  outcomeOf,
  outcomePaint,
  supportBow,
  supportRanks,
  type Ink,
} from "./outcome";
import { fitEnds, fitHead, orderRadius, orderStroke, type Head } from "./scale";
import { mapCode } from "../notation";
import { illegalAllowed } from "../illegal";
import type {
  BoardApi,
  BoardCallbacks,
  BoardHandle,
  BoardState,
  BuilderView,
  OptionNode,
  OptionTree,
  Placement,
  ReviewDraw,
  Unit,
} from "./types";
import {
  baseBoxOf,
  centredView,
  clamp,
  clampedSize,
  fitAllWidth,
  pannedView,
  placeView,
  zoomedView,
  type Box,
  type Point,
} from "./viewbox";

const SVG_NS = "http://www.w3.org/2000/svg";
/*
The colour of an order this page knows is not legal (D-029). Amber, and only
ever on the live board: a review draws what everybody sees, and what everybody
sees about an illegal order is a unit that held.
*/
const ILLEGAL_INK = "#e5a51f";
const NARROW_PX = 780;
const SHORT_PX = 500;
const TAP_SLOP_PX = 8;
// How long a finished gesture keeps the click it produced from landing.
const CLICK_BLOCK_MS = 250;


interface Builder {
  province: string;
  node: OptionTree;
  parts: string[];
  labels: string[];
  moveNode: OptionTree | null;
  supportNode: OptionTree | null;
  support: { src: string; dests: OptionTree } | null;
}

/* One button in the bottom bar: it either steps one level into the tree, or
   stands for a whole path, such as Build → Army. */
interface Choice {
  id: string;
  label: string;
  path: string[];
  descend: boolean;
  filter?: string;
  danger?: boolean;
  /** The keyboard letter that presses this button, where it has one. */
  key?: string;
}

/*
The style a map URL was asked for.

The board is handed a URL, not a style, and a label has to know which end of
the scale its ground sits at before any review has told it. Parsing it back out
is cheaper than a second channel saying the same thing twice.
*/
function styleOfUrl(mapUrl: string): string {
  const query = String(mapUrl || "");
  const mark = query.indexOf("?");
  if (mark === -1) return "";
  return new URLSearchParams(query.slice(mark + 1)).get("style") || "";
}

export function mount(
  host: HTMLElement,
  api: BoardApi,
  callbacks: BoardCallbacks,
): BoardHandle {
  // Anchor points of every province, keyed by abbreviation ("vie", "stp/sc").
  const centers = new Map<string, Point>();
  const unbind: Array<() => void> = [];

  let svgRoot: SVGSVGElement | null = null;
  let state: BoardState | null = null;
  let plan: PhasePlan = emptyPlan("");
  let builder: Builder | null = null;
  let choices: Choice[] = [];
  let selectedOrder: string | null = null;
  /* The phase that just resolved, while it is being shown instead of the live
     one. Set means the map is a picture, not a form. */
  let review: ReviewDraw | null = null;
  let reviewFailed = new Set<string>();
  let reviewIllegal = new Set<string>();
  /* Which end of the scale the map's own art sits at, so a resolved phase is
     drawn in ink that survives it. */
  let ink: Ink = inkForStyle(styleOfUrl(api.mapUrl));
  /* This device's own switch: your pending arrows off while you think. It
     never applies to a review, which is the picture the table is reading. */
  let hideOrders = false;
  /* This device's other switch: province codes on the map instead of names. */
  let briefLabels = false;
  /*
  Provinces whose drafted order this page KNOWS is not legal: the target was
  not in the tree the server offered, and it was sent anyway (D-029).

  It is knowledge about this seat's own draft and it stays on this device. The
  server is not asked and no other seat is told — the whole point of writing an
  illegal order is that nobody can tell it from one that was tried and bounced.
  The set is dropped when the phase changes, because the drafts do.
  */
  let knownIllegal = new Set<string>();
  let orderEpoch = 0;
  let menu: HTMLDivElement | null = null;
  let destroyed = false;

  // baseBox is the map's own viewBox; view is the part on screen.
  let baseBox: Box = { x: 0, y: 0, w: 1524, h: 1357 };
  let view: Box | null = null;

  function listen(
    target: EventTarget,
    type: string,
    handler: EventListenerOrEventListenerObject,
    options?: AddEventListenerOptions,
  ): void {
    target.addEventListener(type, handler, options);
    unbind.push(() => target.removeEventListener(type, handler, options));
  }

  function setStatus(text: string, isError?: boolean): void {
    callbacks.status(text, Boolean(isError));
  }

  function reportError(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    setStatus(message, true);
  }

  // --- Map ----------------------------------------------------------------

  function injectMap(svgText: string): void {
    const doc = new DOMParser().parseFromString(svgText, "image/svg+xml");
    if (doc.querySelector("parsererror")) throw new Error("the map did not parse");
    svgRoot = document.importNode(doc.documentElement, true) as unknown as SVGSVGElement;
    svgRoot.setAttribute("width", "100%");
    svgRoot.setAttribute("height", "100%");
    svgRoot.setAttribute("preserveAspectRatio", "xMidYMid meet");

    baseBox = baseBoxOf(svgRoot, baseBox);
    view = null;

    host.replaceChildren(svgRoot);
  }

  /*
  Reads the anchor of every "<abbr>Center" path. The rendered bounding box is
  the true middle of the anchor glyph, so it is preferred; the "m X,Y" start of
  the path data is the fallback. The center layers ship with display:none, which
  zeroes getBBox, so they are briefly switched to visibility:hidden.
  */
  function readCenters(): void {
    if (!svgRoot) return;
    const nodes = svgRoot.querySelectorAll<SVGGraphicsElement>('[id$="Center"]');
    const layers = svgRoot.querySelectorAll("#supply-centers, #province-centers");
    const saved: Array<[Element, string | null]> = [];
    layers.forEach((layer) => {
      saved.push([layer, layer.getAttribute("style")]);
      layer.setAttribute("style", "display:inline;visibility:hidden");
    });

    nodes.forEach((node) => {
      const abbr = node.id.slice(0, -"Center".length);
      if (!abbr) return;
      let point: Point | null = null;
      try {
        const box = node.getBBox();
        if (box.width > 0 && box.height > 0) {
          point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
        }
      } catch {
        point = null;
      }
      if (!point) point = parseMoveTo(node.getAttribute("d"));
      if (point) centers.set(abbr, point);
    });

    saved.forEach(([layer, style]) => {
      if (style === null) layer.removeAttribute("style");
      else layer.setAttribute("style", style);
    });
  }

  // "m X,Y ..." — the first pair of a moveto is absolute even when lowercase.
  function parseMoveTo(d: string | null): Point | null {
    if (!d) return null;
    const match = /^\s*[mM]\s*(-?[\d.]+)[\s,]+(-?[\d.]+)/.exec(d);
    if (!match) return null;
    return { x: parseFloat(match[1]), y: parseFloat(match[2]) };
  }

  /*
  Where a province's unit marker goes.

  The approved placement table wins where it has an entry, because it was
  measured against the drawn map and the anchors were not: an anchor can sit
  on a province name, half outside its own province, or — the case that made
  the table necessary — three map units from the base province it is supposed
  to be a coast of.

  The fallback is per province, not per table. A table that has "stp" but not
  "stp/nc" leaves stp/nc on its own anchor rather than borrowing stp's
  position, which would put the coast marker back on top of the province.
  */
  function placementOf(province: string): Placement | null {
    const table = state?.placements;
    if (!table) return null;
    const spot = table[province];
    return spot && Array.isArray(spot.unit) ? spot : null;
  }

  function centerOf(province: string): Point | null {
    const own = placementOf(province);
    if (own) return { x: own.unit[0], y: own.unit[1] };
    const anchor = centers.get(province);
    if (anchor) return anchor;
    const base = placementOf(baseProvince(province));
    if (base) return { x: base.unit[0], y: base.unit[1] };
    return centers.get(baseProvince(province)) || null;
  }

  /*
  The size of one province's marker. A province the table had to shrink a
  marker for — Denmark at 0.8, Gascony at 0.95 — carries the figure with it,
  and every measurement taken around that marker has to use it or the drawing
  comes apart: an arrow would start inside the piece it points away from.
  */
  function scaleOf(province: string): number {
    const spot = placementOf(province) || placementOf(baseProvince(province));
    const scale = spot ? spot.scale : 1;
    return scale > 0 ? scale : 1;
  }

  /*
  Every hit shape a province key stands for.

  A map draws a province with a coast as several shapes — "wca", "wca/nc",
  "wca/wc" — and the coast shapes come later in the layer, so they are painted
  over the base one. On the classical map the coast shapes are thin strips and
  nobody noticed; on the cold war map "wca/nc" covers nearly all of west
  Canada, so a tap in the middle of the province lands on the coast shape.

  So a key never resolves to one element. A base province claims its own shape
  and every coast shape under it, which is what makes the whole province light
  up and the whole province tappable. A coast key claims only its own shape,
  because only that coast is legal.
  */
  function provinceShapes(province: string): Element[] {
    const layer = svgRoot?.querySelector("#provinces");
    if (!layer) return [];
    const exact = layer.querySelector('[id="' + CSS.escape(province) + '"]');
    const found: Element[] = exact ? [exact] : [];
    if (province === baseProvince(province)) {
      Array.prototype.forEach.call(layer.children, (shape: Element) => {
        if (shape !== exact && baseProvince(shape.id) === province) found.push(shape);
      });
    }
    if (found.length === 0) warnUnresolved(province);
    return found;
  }

  /*
  A province key the map cannot draw is how the cold war tap bug hid: the
  highlight simply did not appear and the tap did nothing, with no complaint.
  In development it now says so, once per key.

  Only keys the variant itself calls provinces are worth a line. The same
  lookup carries order types — "Build", "Disband" — which no map draws and
  which the province-name table does not know.
  */
  const unresolved = new Set<string>();
  function warnUnresolved(province: string): void {
    if (!import.meta.env.DEV || unresolved.has(province)) return;
    if (provinceName(province) === baseProvince(province).toUpperCase()) return;
    unresolved.add(province);
    console.warn(
      "[board] this map has no hit shape for province " +
        JSON.stringify(province) +
        " (" + provinceName(province) + ") — it cannot be highlighted or tapped",
    );
  }

  // --- Pan and zoom -------------------------------------------------------
  /*
  Zoom and pan move the injected SVG's viewBox; nothing is transformed, so hit
  testing, getBBox and the unit anchors all stay in map coordinates. The widest
  allowed view is "fit all" for the current container shape, the narrowest is
  MAX_ZOOM times closer.

  The arithmetic lives in viewbox.ts, because the gallery lightbox needs the
  same rules and two copies of a clamp like this one would drift. What stays
  here is everything the ORDERING needs — which gesture counts as a tap, what
  a second tap means on one of your own units — and none of that is shared.
  */

  function mapRect(): DOMRect {
    return host.getBoundingClientRect();
  }

  function applyView(): void {
    if (!svgRoot || !view) return;
    svgRoot.setAttribute("viewBox", [view.x, view.y, view.w, view.h].join(" "));
  }

  /*
  How big a unit marker is, in map units.

  A marker is a constant twelve pixels on screen, so its size in map units
  falls out of the zoom — that part is right and stays. What was wrong was the
  ceiling: a flat 60 map units, chosen on the classical map where 60 is a
  third of France and the cap never binds. On sailho, whose viewBox is 7300
  units wide against classical's 1524, 60 units is under a hundredth of the
  map, and every marker came out as a dot no thicker than a border.

  So the ceiling is a fraction of the map instead of a count of its units. A
  twenty-fifth of the width lands at 60.96 on classical — over the 18.42 the
  laptop pane actually asks for, so classical is unchanged to the decimal —
  and at 292 on sailho, which lets that map's markers reach the 104 units they
  should. The floor stays absolute: it exists to keep a marker tappable at
  full zoom, which is a fact about fingers, not about maps.

  tools/placement/geometry.ts computes this same number to decide where a
  marker will fit. The two must not drift apart, or the placement table is
  measured for a marker the board does not draw.
  */
  const MARKER_PIXELS = 12;
  const MARKER_MIN_UNITS = 8;
  const MARKER_MAX_FRACTION = 1 / 25;

  function markerRadius(): number {
    return clamp(
      MARKER_PIXELS * unitsPerPixel(),
      MARKER_MIN_UNITS,
      // A map narrower than 200 units would put the ceiling under the floor,
      // and clamp() would then answer with the ceiling. The floor wins.
      Math.max(MARKER_MIN_UNITS, baseBox.w * MARKER_MAX_FRACTION),
    );
  }

  function zoomLevel(): number {
    return view ? fitAllWidth(baseBox, mapRect()) / view.w : 1;
  }

  /*
  The same view, in a pane that changed shape.

  The height of a view follows the container's aspect, so a pane that grows
  taller has to be given a new box. Keeping the top-left corner would slide the
  map up the screen; the middle is what the player was looking at, so the
  middle is what is held still. Nothing is reloaded and no element is replaced:
  it is one viewBox attribute and the overlays that are measured against it.
  */
  function refit(): void {
    if (!view) return;
    const middleX = view.x + view.w / 2;
    const middleY = view.y + view.h / 2;
    const size = clampedSize(baseBox, mapRect(), view.w);
    view = placeView(baseBox, size, middleX - size.w / 2, middleY - size.h / 2);
    applyView();
    renderOverlays();
  }

  // Client coordinates → map coordinates.

  // Zooms by `factor` while the map point under (clientX, clientY) stays put.
  function zoomAt(clientX: number, clientY: number, factor: number): void {
    if (!view) return;
    view = zoomedView(baseBox, mapRect(), view, clientX, clientY, factor);
    applyView();
    renderOverlays();
  }

  // Matches the mobile media query: a narrow screen or a short one.
  function isNarrow(): boolean {
    return window.innerWidth <= NARROW_PX || window.innerHeight <= SHORT_PX;
  }

  /*
  Wide screens open on the whole map. Narrow screens open at fit-width, stepped
  in a little further, so provinces are big enough to tap straight away.
  */
  function resetView(): void {
    const rect = mapRect();
    const widest = fitAllWidth(baseBox, rect);
    view = centredView(baseBox, rect, isNarrow() ? Math.min(widest, baseBox.w) / 1.6 : widest);
    applyView();
    renderOverlays();
  }

  function bindGestures(): void {
    const pointers = new Map<number, Point>();
    let pinchDistance = 0;
    let moved = 0;
    let dragging = false;
    let suppressUntil = 0;
    let lastTap = 0;
    let lastTapPoint: Point = { x: 0, y: 0 };

    const midpointOfPointers = (): Point => {
      const points = Array.from(pointers.values());
      const sum = points.reduce((acc, p) => ({ x: acc.x + p.x, y: acc.y + p.y }), { x: 0, y: 0 });
      return { x: sum.x / points.length, y: sum.y / points.length };
    };
    /*
    Blocks the click a finished gesture would otherwise produce. The block
    expires on its own, so a gesture that never produces a click (a pan, a
    pinch) cannot swallow some unrelated click much later.
    */
    const blockNextClick = () => { suppressUntil = Date.now() + CLICK_BLOCK_MS; };

    const spread = (): number => {
      const [a, b] = Array.from(pointers.values());
      return Math.hypot(a.x - b.x, a.y - b.y);
    };

    listen(host, "pointerdown", ((event: PointerEvent) => {
      // The chip is pinned to a point on the map, so any new touch dismisses it.
      hideMenu();
      /*
      A primary pointer means no other finger is down, so anything still tracked
      is a pointerup the page never saw. Without this sweep the next tap counts
      as a second finger, is read as a pinch, and its click is thrown away.
      */
      if (event.isPrimary) pointers.clear();
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (pointers.size === 1) {
        moved = 0;
        dragging = true;
        // A pan emits no click, so the block must be cleared per gesture,
        // otherwise the tap after a pan gets swallowed.
        suppressUntil = 0;
      } else if (pointers.size === 2) {
        pinchDistance = spread();
        dragging = false;
        blockNextClick();
      }
    }) as EventListener);

    /*
    Move and release are watched on the window, not on the map, so a drag that
    leaves the map still finishes. Pointer capture would do the same, but it
    also retargets the click that follows a tap to the container, which would
    hide province clicks from the map handler.
    */
    listen(window, "pointermove", ((event: PointerEvent) => {
      const previous = pointers.get(event.pointerId);
      if (!previous || !view) return;
      const next = { x: event.clientX, y: event.clientY };

      if (pointers.size === 1 && dragging) {
        moved += Math.hypot(next.x - previous.x, next.y - previous.y);
        if (moved > TAP_SLOP_PX) {
          blockNextClick();
          view = pannedView(baseBox, mapRect(), view, next.x - previous.x, next.y - previous.y);
          applyView();
          renderOverlays();
        }
      }

      pointers.set(event.pointerId, next);

      if (pointers.size === 2) {
        const distance = spread();
        if (pinchDistance > 0 && distance > 0) {
          const middle = midpointOfPointers();
          zoomAt(middle.x, middle.y, distance / pinchDistance);
        }
        pinchDistance = distance;
      }
    }) as EventListener);

    const release = (event: PointerEvent): void => {
      if (!pointers.has(event.pointerId)) return;
      const wasSingle = pointers.size === 1;
      pointers.delete(event.pointerId);
      if (pointers.size < 2) pinchDistance = 0;
      if (pointers.size === 0) dragging = false;

      if (event.type !== "pointerup" || !wasSingle) return;
      if (moved > TAP_SLOP_PX) return;

      /*
      A second quick tap near the first one zooms in a step — except on one of
      your own units, where it is the shortcut for Hold. Either way the click
      that follows is swallowed, so the order builder is left alone.
      */
      const now = Date.now();
      const near = Math.hypot(event.clientX - lastTapPoint.x, event.clientY - lastTapPoint.y) < 30;
      // Building a support asks for a second tap on the supported unit, which
      // must mean "support its hold", not "make it hold".
      const shortcut = shortcutMode() !== "support";
      if (shortcut && now - lastTap < 300 && near) {
        blockNextClick();
        const unit = unitAt(event.clientX, event.clientY);
        if (unit) {
          hideMenu();
          builder = null;
          renderAll();
          holdOrder(unit).catch(reportError);
        } else {
          zoomAt(event.clientX, event.clientY, 1.8);
        }
        lastTap = 0;
        return;
      }
      lastTap = now;
      lastTapPoint = { x: event.clientX, y: event.clientY };

      /*
      A touch tap is resolved here rather than from the click that follows it.
      Chrome withholds that click when a tap lands soon after another touch at
      nearly the same spot — which is exactly what ordering on a phone looks
      like — so the province would silently ignore every other tap. Mouse input
      keeps using the click, which carries the real target element.
      */
      if (event.pointerType !== "mouse") {
        blockNextClick();
        const province = provinceAt(event.clientX, event.clientY);
        if (province) onProvinceClick(province, event.clientX, event.clientY);
      }
    };

    listen(window, "pointerup", release as EventListener);
    listen(window, "pointercancel", release as EventListener);

    // A pan must not also count as a province tap.
    listen(
      host,
      "click",
      ((event: MouseEvent) => {
        if (Date.now() >= suppressUntil) return;
        suppressUntil = 0;
        event.stopPropagation();
        event.preventDefault();
      }) as EventListener,
      { capture: true },
    );

    listen(
      host,
      "wheel",
      ((event: WheelEvent) => {
        if (!view) return;
        event.preventDefault();
        hideMenu();
        zoomAt(event.clientX, event.clientY, Math.exp(-event.deltaY * 0.0015));
      }) as EventListener,
      { passive: false },
    );

    listen(host, "dblclick", ((event: Event) => event.preventDefault()) as EventListener);

    listen(window, "resize", refit);

    /*
    The pane can also change shape while the window does not: the border
    between the map and the order panel is draggable (SplitLayout). Watching
    the host covers both, and covers them before the frame is painted, so the
    map never lags a drag by a frame.
    */
    if (typeof ResizeObserver === "function") {
      const watcher = new ResizeObserver(() => refit());
      watcher.observe(host);
      unbind.push(() => watcher.disconnect());
    }
  }

  function bindMapClicks(): void {
    const layer = svgRoot?.querySelector("#provinces");
    if (!layer) throw new Error("the map has no #provinces layer");
    listen(layer, "click", ((event: MouseEvent) => {
      const shape = (event.target as Element).closest("[id]");
      if (shape && shape.parentNode === layer) {
        onProvinceClick(shape.id, event.clientX, event.clientY);
      }
    }) as EventListener);
  }

  // --- Overlays -----------------------------------------------------------

  // Orders are drawn under the unit markers, both in map coordinates.
  function overlay(id: string): SVGGElement {
    let layer = svgRoot!.querySelector<SVGGElement>("#" + id);
    if (!layer) {
      layer = document.createElementNS(SVG_NS, "g");
      layer.id = id;
      svgRoot!.appendChild(layer);
    }
    return layer;
  }

  function overlayLayer(): SVGGElement {
    const orders = overlay("order-overlay");
    const units = overlay("unit-overlay");
    if (orders.nextSibling !== units) svgRoot!.insertBefore(orders, units);
    return units;
  }

  // Both map overlays follow the zoom, so they are redrawn together.
  function renderOverlays(): void {
    if (!svgRoot) return;
    renderOrders();
    renderUnits();
    renderBriefLabels();
  }

  // --- Province labels ----------------------------------------------------
  /*
  Full names, or the codes that fit.

  "Mid-Atlantic Ocean" does not fit the province it names at fit-all zoom, so a
  map either overflows the name into its neighbours or draws it too small to
  read. Three letters fit every province on every map, and they are the same
  three letters the abbreviated order list writes, so a player who has turned
  both on is reading one language.

  Which layers a map has decides how this is done, and the two kinds of map in
  play answer differently:

    jDip-converted maps ship BOTH sets already drawn, in BriefLabelLayer and
    FullLabelLayer. Nothing is drawn here; one layer is shown and the other
    hidden, and the codes land exactly where the map's own author put them.

    godip maps have one "names" layer and no brief one. That layer is hidden
    and the codes are drawn at the province anchors instead — the same anchors
    the unit markers use, so a code never lands in a province it does not
    belong to. They are drawn at the size the markers are drawn at, which is
    why they are redrawn with the overlays rather than once.

  A map with neither is left alone: it keeps whatever names it has, which says
  less than the switch promised but nothing false.
  */
  const BRIEF_LAYER = "brief-labels";

  /* An inkscape layer is switched with its style's display, which is the
     property its own author set. */
  function display(node: SVGElement | null, on: boolean): void {
    if (node) node.style.display = on ? "inline" : "none";
  }

  /*
  Shows the pair a jDip map ships with, and says whether it had one.

  These two are switched with the visibility ATTRIBUTE, because that is what
  jDip's own exporter wrote on them and what its own viewer flips. Setting
  display instead leaves visibility="hidden" standing underneath, and the layer
  stays invisible while claiming to be shown.
  */
  function applyDrawnLabelLayers(): boolean {
    const brief = svgRoot?.querySelector<SVGElement>("#BriefLabelLayer") || null;
    const full = svgRoot?.querySelector<SVGElement>("#FullLabelLayer") || null;
    if (!brief || !full) return false;
    brief.setAttribute("visibility", briefLabels ? "visible" : "hidden");
    full.setAttribute("visibility", briefLabels ? "hidden" : "visible");
    return true;
  }

  function renderBriefLabels(): void {
    if (!svgRoot) return;
    if (applyDrawnLabelLayers()) {
      // The map draws its own codes. Anything this file drew before the map
      // was known would now be a second set on top of them.
      svgRoot.querySelector("#" + BRIEF_LAYER)?.remove();
      return;
    }

    const names = svgRoot.querySelector<SVGElement>("#names");
    display(names, !briefLabels);
    const layer = overlay(BRIEF_LAYER);
    layer.replaceChildren();
    if (!briefLabels) return;
    // Under the units, so a marker is never read through a label.
    const units = overlay("unit-overlay");
    if (layer.nextSibling !== units) svgRoot.insertBefore(layer, units);

    const r = markerRadius();
    const standing = state?.units || {};
    const keys = new Set<string>(centers.keys());
    Object.keys(state?.placements || {}).forEach((key) => keys.add(key));

    Array.from(keys)
      .filter((province) => province === baseProvince(province))
      .forEach((province) => {
        const point = centerOf(province);
        if (!point) return;
        const rp = r * scaleOf(province);
        /*
        The approved table's answer when it has one, and the offset heuristic
        when it does not.

        A measured position beats the heuristic on everything the heuristic
        cannot see: whether the spot below the marker is still inside the
        province, whether it is under the supply centre glyph, and whether it
        is under a NEIGHBOURING province's marker, which is where most of the
        collisions were. It is also one position rather than two, because it
        is already clear of this province's own marker — so a code no longer
        jumps when a unit moves in or out.
        */
        const held = placementOf(province)?.brief;
        const spot = Array.isArray(held) ? held : null;
        const at = spot
          ? { x: spot[0], y: spot[1] }
          : { x: point.x, y: standing[province] ? point.y + rp * 1.95 : point.y };
        const text = document.createElementNS(SVG_NS, "text");
        text.setAttribute("x", String(at.x));
        text.setAttribute("y", String(at.y));
        text.setAttribute("font-size", String(r * 0.95));
        text.setAttribute("stroke-width", String(r * 0.16));
        text.setAttribute("class", "brief-label " + (ink === "dark" ? "on-light" : "on-dark"));
        text.textContent = mapCode(province);
        layer.appendChild(text);
      });
  }

  // Map units per screen pixel, so markers keep one size however far you zoom.
  function unitsPerPixel(): number {
    const rect = mapRect();
    if (!view || !rect.width) return 1;
    return view.w / rect.width;
  }

  // A unit marker: a circle for an army, a triangle for a fleet.
  function unitShape(point: Point, r: number, isFleet: boolean): SVGElement {
    if (!isFleet) {
      const circle = document.createElementNS(SVG_NS, "circle");
      circle.setAttribute("cx", String(point.x));
      circle.setAttribute("cy", String(point.y));
      circle.setAttribute("r", String(r));
      return circle;
    }
    const polygon = document.createElementNS(SVG_NS, "polygon");
    polygon.setAttribute(
      "points",
      [
        point.x + "," + (point.y - r * 1.1),
        point.x + r + "," + (point.y + r * 0.75),
        point.x - r + "," + (point.y + r * 0.75),
      ].join(" "),
    );
    return polygon;
  }

  function unitLetter(point: Point, r: number, isFleet: boolean): SVGElement {
    const label = document.createElementNS(SVG_NS, "text");
    label.setAttribute("x", String(point.x));
    label.setAttribute("y", String(point.y + (isFleet ? r * 0.2 : 0)));
    label.setAttribute("font-size", String(r * 1.1));
    label.setAttribute("class", "unit-label");
    label.textContent = isFleet ? "F" : "A";
    return label;
  }

  /*
  A dislodged unit shares its province with the unit that threw it out, so it
  is drawn up and to the right of the anchor. Without the offset the two
  markers would sit on top of each other and the board would lie.
  */
  function dislodgedPoint(point: Point, r: number): Point {
    return { x: point.x + r * 1.15, y: point.y - r * 1.15 };
  }

  /*
  Where the dislodged marker actually goes. The offset above is the default
  and it is often wrong: in a narrow province it lands outside the border, and
  in a crowded one it lands on a name. The table carries a corrected point per
  province, and falls back to the offset where it has none.
  */
  function awayPoint(province: string, anchor: Point, r: number): Point {
    const spot = placementOf(province);
    if (spot && Array.isArray(spot.dislodged)) {
      return { x: spot.dislodged[0], y: spot.dislodged[1] };
    }
    return dislodgedPoint(anchor, r);
  }

  function renderUnits(): void {
    const layer = overlayLayer();
    layer.replaceChildren();
    const units = state?.units || {};
    /* A review rings the units the phase under review threw out, which is not
       the same set as the ones standing dislodged right now. */
    const dislodged = review ? review.dislodged : state?.dislodged || {};
    const orders = review ? {} : state?.orders || {};
    const r = markerRadius();

    Object.keys(units).forEach((province) => {
      const unit = units[province];
      const point = centerOf(province);
      if (!point) return;

      const rp = r * scaleOf(province);
      const isFleet = String(unit.type).toLowerCase() === "fleet";
      const shape = unitShape(point, rp, isFleet);
      const ordered = Boolean(orders[province]) && !dislodged[province];
      shape.setAttribute("fill", powerColor(unit.nation));
      shape.setAttribute("stroke", ordered ? "#ffffff" : "#14161a");
      shape.setAttribute("stroke-width", String(Math.max(1, rp * (ordered ? 0.28 : 0.16))));
      shape.setAttribute("class", ordered ? "unit ordered" : "unit");
      layer.appendChild(shape);
      layer.appendChild(unitLetter(point, rp, isFleet));
    });

    // The dislodged markers go on top, each with a red ring, so a province
    // holding two units reads as two units.
    Object.keys(dislodged).forEach((province) => {
      const unit = dislodged[province];
      const anchor = centerOf(province);
      if (!anchor) return;
      const rp = r * scaleOf(province);
      const point = awayPoint(province, anchor, rp);
      const isFleet = String(unit.type).toLowerCase() === "fleet";

      const ring = document.createElementNS(SVG_NS, "circle");
      ring.setAttribute("cx", String(point.x));
      ring.setAttribute("cy", String(point.y));
      ring.setAttribute("r", String(rp * 1.45));
      ring.setAttribute("fill", "none");
      ring.setAttribute("stroke", "#ff5c5c");
      ring.setAttribute("stroke-width", String(Math.max(1.5, rp * 0.22)));
      ring.setAttribute("class", "dislodged-ring");
      layer.appendChild(ring);

      const shape = unitShape(point, rp * 0.82, isFleet);
      shape.setAttribute("fill", powerColor(unit.nation));
      shape.setAttribute("stroke", "#14161a");
      shape.setAttribute("stroke-width", String(Math.max(1, rp * 0.14)));
      shape.setAttribute("class", "unit dislodged");
      layer.appendChild(shape);
      layer.appendChild(unitLetter(point, rp * 0.82, isFleet));
    });
  }

  // --- Order graphics -----------------------------------------------------
  /*
  One graphic per ordered unit, drawn from the raw parts in state.orderParts —
  never from the prose strings. Everything is in map coordinates, so pan and
  zoom carry it along; only the stroke weights are rescaled, the same way the
  unit markers are, so the drawing stays readable at any zoom.

    Move          straight arrow, unit anchor → target anchor
    Hold          ring around the unit marker
    Support move  dashed curve to the middle of the supported move, T-bar end
    Support hold  dashed curve to the supported unit, open circle end
    Convoy        dashed curve to the middle of the convoyed move
  */

  function towards(from: Point, to: Point, distance: number): Point {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const length = Math.hypot(dx, dy) || 1;
    return { x: from.x + (dx / length) * distance, y: from.y + (dy / length) * distance };
  }

  function midpoint(a: Point, b: Point): Point {
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  }

  function distance(a: Point, b: Point): number {
    return Math.hypot(b.x - a.x, b.y - a.y);
  }

  // The unit vector across a line, for arrow wings and support bars.
  function normalOf(a: Point, b: Point): Point {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const length = Math.hypot(dx, dy) || 1;
    return { x: -dy / length, y: dx / length };
  }

  /*
  A quadratic curve, bowed perpendicular to its own span so it never hides
  under a move line — and, where several supports back the same move, so it
  never hides under its neighbours either. The fraction is signed and comes
  from outcome.ts, which hands out one rank per support of a given move.
  */
  function curvePath(from: Point, to: Point, fraction: number): string {
    const mid = midpoint(from, to);
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const length = Math.hypot(dx, dy) || 1;
    const bow = length * fraction;
    const control = { x: mid.x - (dy / length) * bow, y: mid.y + (dx / length) * bow };
    return "M " + from.x + " " + from.y + " Q " + control.x + " " + control.y + " " + to.x + " " + to.y;
  }

  /*
  The arrow is one closed outline — shaft and head in a single polygon — so its
  border runs unbroken from tail to tip. A marker-drawn head cannot do this: the
  underlay stops where the marker starts and the border breaks at the neck.
  */
  function arrowPoints(a: Point, b: Point, shaftHalf: number, headLength: number, headHalf: number): string {
    const n = normalOf(a, b);
    const neck = towards(b, a, headLength);
    const at = (point: Point, offset: number) => point.x + n.x * offset + "," + (point.y + n.y * offset);
    return [
      at(a, shaftHalf),
      at(neck, shaftHalf),
      at(neck, headHalf),
      b.x + "," + b.y,
      at(neck, -headHalf),
      at(neck, -shaftHalf),
      at(a, -shaftHalf),
    ].join(" ");
  }

  function renderOrders(): void {
    const layer = overlay("order-overlay");
    layer.replaceChildren();
    /*
    A review draws the phase that just resolved — every power's orders, from
    the server's public record — where the live board draws only this seat's.
    Everything below is the same drawing either way; only where the parts, the
    colours and the phase wording come from changes.
    */
    const parts = review ? review.orderParts : state?.orderParts || {};
    // Your own arrows, hidden while you think. The unit markers keep their
    // "ordered" ring, so you can still see which units are spoken for.
    if (!review && hideOrders) return;
    const units = state?.units || {};
    const kind = review ? review.kind : plan.kind;
    const upp = unitsPerPixel();
    /*
    Order graphics take the marker radius back into screen pixels and hold it
    inside a band of their own. Where markerRadius() has hit its floor in map
    units or its ceiling as a fraction of the map it has stopped following the
    zoom, and an order measured straight off it would stop following too —
    invisible on a map with a huge viewBox, clownish at full zoom on a small
    one. The stroke is clamped the same way, in pixels rather than in map
    units, which is the only unit a stroke can be judged in (scale.ts).
    */
    const r = orderRadius(markerRadius(), upp);
    const base = orderStroke(r, upp);

    const dislodged = review ? review.dislodged : state?.dislodged || {};
    // One rank per support or convoy of the same move, so parallel supports
    // fan out instead of drawing on top of each other.
    const ranks = supportRanks(parts);

    Object.keys(parts).forEach((province) => {
      const anchor = centerOf(province);
      const order = parts[province] || [];
      if (!anchor || !order.length) return;
      /*
      A retreat is drawn from the dislodged marker, not from the anchor, which
      by now belongs to the unit that threw it out. A build has no unit at all,
      so the colour falls back to the power whose board this is.
      */
      const leaving = dislodged[province];
      /* Every offset around this order's own end is taken at this province's
         marker size, so an arrow leaving a shrunken marker still starts at
         its edge rather than inside it. */
      const rp = r * scaleOf(province);
      const from = leaving ? awayPoint(province, anchor, rp) : anchor;
      const unit = leaving || units[province];
      const ordering = review ? review.powers[province] || "" : "";
      const color = powerColor(ordering || (unit ? unit.nation : plan.power));
      const missed = reviewFailed.has(province);
      /*
      A draft this page knows the rules refuse (D-029). It is drawn in its own
      amber with a dashed rim — the same arrow, visibly provisional — so the
      player who wrote it can see that the app knows. It is never drawn in a
      review, because a review is what everybody else sees.
      */
      const bluff = !review && knownIllegal.has(province);
      /*
      In a review the OUTCOME is the loud channel — ink for an order that came
      off, red for one that did not, orange for a retreat — and the power's
      colour drops to a thin inner stroke. On the live board there is only one
      power's orders on screen, so the outcome channel would say nothing and
      the power's colour stays the whole of it.
      */
      const never = reviewIllegal.has(province);
      const tone = review ? outcomePaint(outcomeOf(kind, order, missed, never), ink) : null;
      const haloColor = tone ? tone.halo : "#1b1b1b";
      const lineColor = bluff ? ILLEGAL_INK : tone ? tone.line : color;
      // The picked order is drawn heavier; weights stay in map units so they
      // keep following the zoom.
      const width = base * (selectedOrder === province ? 1.9 : 1);
      const border = Math.max(1.2, width * 0.7);

      const group = document.createElementNS(SVG_NS, "g");
      group.setAttribute(
        "class",
        "order" +
          (missed ? " failed" : "") +
          (bluff || never ? " illegal" : ""),
      );
      group.setAttribute("data-province", province);
      /* Where the cross goes on an order that did not come off: the far end,
         which is the claim the adjudication refused. */
      let missPoint: Point = from;

      /*
      Every shape is built once per pass: a fattened halo in the contrast
      colour, the order itself, and — in a review — a thin inner stroke in the
      power's colour. All the halo passes are laid down before any other, so
      no shape's underlay ever cuts across a neighbour.
      */
      type Pass = "halo" | "line" | "nation";
      const passes: Pass[] = review ? ["halo", "line", "nation"] : ["halo", "line"];
      const shapes: Array<(pass: Pass) => SVGElement> = [];
      const paint = (node: SVGElement, pass: Pass, solid: boolean): SVGElement => {
        /* The rim of an illegal draft is broken, which is the one thing about
           an arrow that reads as "this will not happen" without a legend. */
        if ((bluff || never) && pass === "halo") {
          node.setAttribute("stroke-dasharray", r * 0.42 + " " + r * 0.3);
        }
        if (solid && pass !== "nation") {
          node.setAttribute("fill", pass === "halo" ? haloColor : lineColor);
          node.setAttribute("stroke", pass === "halo" ? haloColor : "none");
          node.setAttribute("stroke-width", String(pass === "halo" ? border * 2 : 0));
          node.setAttribute("stroke-linejoin", "round");
        } else if (solid) {
          // The power's colour traced just inside a filled arrow's edge. It
          // has to stay thin against the shaft it runs along, or the quiet
          // channel becomes the loud one again.
          node.setAttribute("fill", "none");
          node.setAttribute("stroke", color);
          node.setAttribute("stroke-width", String(Math.max(0.5, width * 0.3)));
          node.setAttribute("stroke-linejoin", "round");
        } else {
          node.setAttribute("fill", "none");
          node.setAttribute(
            "stroke",
            pass === "halo" ? haloColor : pass === "nation" ? color : lineColor,
          );
          node.setAttribute(
            "stroke-width",
            String(
              pass === "halo"
                ? width + border * 2
                : pass === "nation"
                  ? Math.max(0.5, width * 0.3)
                  : width,
            ),
          );
          node.setAttribute("stroke-linecap", "round");
        }
        node.setAttribute(
          "class",
          pass === "halo" ? "order-halo" : pass === "nation" ? "order-nation" : "order-line",
        );
        return node;
      };

      const arrow = (a: Point, b: Point, cap: Head) => (pass: Pass) => {
        const node = document.createElementNS(SVG_NS, "polygon");
        node.setAttribute("points", arrowPoints(a, b, width / 2, cap.length, cap.half));
        return paint(node, pass, true);
      };
      const dashedCurve = (a: Point, b: Point, bow: number) => (pass: Pass) => {
        const node = document.createElementNS(SVG_NS, "path");
        node.setAttribute("d", curvePath(a, b, bow));
        node.setAttribute("stroke-dasharray", r * 0.55 + " " + r * 0.4);
        return paint(node, pass, false);
      };
      const ring = (at: Point, radius: number) => (pass: Pass) => {
        const node = document.createElementNS(SVG_NS, "circle");
        node.setAttribute("cx", String(at.x));
        node.setAttribute("cy", String(at.y));
        node.setAttribute("r", String(radius));
        return paint(node, pass, false);
      };
      const segment = (a: Point, b: Point) => (pass: Pass) => {
        const node = document.createElementNS(SVG_NS, "line");
        node.setAttribute("x1", String(a.x));
        node.setAttribute("y1", String(a.y));
        node.setAttribute("x2", String(b.x));
        node.setAttribute("y2", String(b.y));
        return paint(node, pass, false);
      };

      // A retreat: a dashed run to the destination with a solid head, so it
      // never reads as an ordinary move.
      const dashedRun = (a: Point, b: Point) => (pass: Pass) => {
        const node = document.createElementNS(SVG_NS, "line");
        node.setAttribute("x1", String(a.x));
        node.setAttribute("y1", String(a.y));
        node.setAttribute("x2", String(b.x));
        node.setAttribute("y2", String(b.y));
        node.setAttribute("stroke-dasharray", r * 0.5 + " " + r * 0.38);
        return paint(node, pass, false);
      };
      const head = (a: Point, b: Point, cap: Head) => (pass: Pass) => {
        const node = document.createElementNS(SVG_NS, "polygon");
        const n = normalOf(a, b);
        const neck = towards(b, a, cap.length);
        const at = (point: Point, offset: number) =>
          point.x + n.x * offset + "," + (point.y + n.y * offset);
        node.setAttribute(
          "points",
          [at(neck, cap.half), b.x + "," + b.y, at(neck, -cap.half)].join(" "),
        );
        return paint(node, pass, true);
      };
      // A disband: a cross over the unit that goes away.
      const cross = (at: Point, reach: number) => (pass: Pass) => {
        const node = document.createElementNS(SVG_NS, "path");
        node.setAttribute(
          "d",
          "M " + (at.x - reach) + " " + (at.y - reach) + " L " + (at.x + reach) + " " + (at.y + reach) +
            " M " + (at.x + reach) + " " + (at.y - reach) + " L " + (at.x - reach) + " " + (at.y + reach),
        );
        return paint(node, pass, false);
      };
      // A build: the outline of the unit that will stand there.
      const outline = (at: Point, isFleet: boolean) => (pass: Pass) => {
        const node = unitShape(at, rp * 0.95, isFleet);
        return paint(node, pass, false);
      };

      const type = order[0];
      const anchorOf = (name: string) => centerOf(name) || centerOf(baseProvince(name));

      // The far end's clearance belongs to the far end's marker: a move into
      // Denmark stops short of Denmark's 0.8x piece, not of a full-size one.
      const rAt = (name: string) => r * scaleOf(name);

      if (kind === "retreat" && type === "Move" && order[1]) {
        const to = anchorOf(order[1]);
        if (!to) return;
        /* Two provinces that touch are a short span at fit-all zoom, and the
           clearance around the two markers does not shrink with it. Both ends
           give way rather than leaving nothing to draw (scale.ts). */
        const fit = fitEnds(distance(from, to), rp * 1.0, rAt(order[1]) * 1.4);
        const tail = towards(from, to, fit.start);
        const end = towards(to, from, fit.end);
        const cap = fitHead(fit.body, r * 0.95, r * 0.5);
        // The dashes stop under the head, so the two never overprint.
        shapes.push(dashedRun(tail, towards(end, tail, cap.length * 0.9)));
        shapes.push(head(tail, end, cap));
        missPoint = end;
      } else if (type === "Disband") {
        shapes.push(cross(from, rp * 1.15));
      } else if (type === "Build") {
        shapes.push(outline(anchor, String(order[1]).toLowerCase() === "fleet"));
      } else if (type === "Move" && order[1]) {
        const to = anchorOf(order[1]);
        if (!to) return;
        /* Paris to Burgundy: the span between two provinces that touch is
           fixed in map units, so on screen it shrinks with the zoom while the
           clearance around the markers does not. Granting both clearances in
           full left nothing to draw and turned the arrow outline inside out.
           Now they give way in proportion and the head follows (scale.ts). */
        const fit = fitEnds(distance(from, to), rp * 1.15, rAt(order[1]) * 1.6);
        const tail = towards(from, to, fit.start);
        const tip = towards(to, from, fit.end);
        shapes.push(arrow(tail, tip, fitHead(fit.body, r * 1.15, r * 0.62)));
        missPoint = tip;
      } else if (type === "Hold") {
        shapes.push(ring(from, rp * 1.5));
      } else if (type === "Support" || type === "Convoy") {
        const src = anchorOf(order[1] || "");
        if (!src) return;
        const holdSupport = order.length < 3 || order[2] === order[1];
        /* For a hold the curve stops clear of the supported unit's marker, so
           the ring at its end stays visible. For a move it runs to the middle
           of the move it backs, which needs no clearance of its own. Either
           way a neighbour's support is a short span, so both ends give way
           together rather than crossing over (scale.ts). */
        const target = holdSupport ? src : midpoint(src, anchorOf(order[2]) || src);
        const fit = fitEnds(
          distance(from, target),
          rp * 1.2,
          holdSupport ? rAt(order[1] || "") * 2.6 : 0,
          0.45,
        );
        const start = towards(from, target, fit.start);
        const end = towards(target, from, fit.end);
        shapes.push(dashedCurve(start, end, supportBow(ranks[province] || 0)));
        missPoint = end;
        if (holdSupport) {
          shapes.push(ring(end, r * 0.55));
        } else {
          // A bar across the end, so a support never reads as a move.
          const n = normalOf(start, end);
          const reach = r * 0.7;
          shapes.push(
            segment(
              { x: end.x - n.x * reach, y: end.y - n.y * reach },
              { x: end.x + n.x * reach, y: end.y + n.y * reach },
            ),
          );
        }
      } else {
        return;
      }

      passes.forEach((pass) => shapes.forEach((make) => group.appendChild(make(pass))));

      /*
      An order that did not come off is drawn in red for its whole length and
      crossed at the end it did not reach, so the board reads at a glance as
      what worked and what did not — no legend, and no need to find the same
      province in a list.
      */
      if (missed) {
        const reach = r * 0.72;
        const mark = document.createElementNS(SVG_NS, "path");
        mark.setAttribute(
          "d",
          "M " + (missPoint.x - reach) + " " + (missPoint.y - reach) +
            " L " + (missPoint.x + reach) + " " + (missPoint.y + reach) +
            " M " + (missPoint.x + reach) + " " + (missPoint.y - reach) +
            " L " + (missPoint.x - reach) + " " + (missPoint.y + reach),
        );
        mark.setAttribute("fill", "none");
        mark.setAttribute("stroke", haloColor);
        mark.setAttribute("stroke-width", String(width + border * 2));
        mark.setAttribute("stroke-linecap", "round");
        group.appendChild(mark);
        const over = mark.cloneNode() as SVGElement;
        over.setAttribute("stroke", lineColor);
        over.setAttribute("stroke-width", String(Math.max(width, r * 0.28)));
        over.setAttribute("class", "order-miss");
        group.appendChild(over);
      }

      if (selectedOrder) group.classList.add(selectedOrder === province ? "hot" : "dim");
      layer.appendChild(group);
    });
  }

  // --- Option tree --------------------------------------------------------
  /*
  The full server-side tree is province → OrderType → SrcProvince → targets, and
  the options endpoint may hand back either the whole branch or the part below
  the province. Both are handled: a lone "SrcProvince" node, or a lone root
  "Province" node naming the clicked province, is selected automatically and
  left out of the order parts. Every other choice the player taps is appended,
  so a walk of Move → tri in "vie" posts {province:"vie", parts:["Move","tri"]}.
  */

  function isLeaf(node: OptionTree | null | undefined): boolean {
    return !node || Object.keys(node).length === 0;
  }

  // Walks past the nodes the player should not have to tap.
  function skipAutoNodes(node: OptionTree, province: string, atRoot: boolean): OptionTree {
    let current: OptionTree = node || {};
    let rootStep = atRoot;
    for (;;) {
      if (isLeaf(current)) return current;
      const keys = Object.keys(current);
      if (keys.length !== 1) return current;
      const key = keys[0];
      const entry: OptionNode = current[key] || {};
      const skippable =
        entry.Type === "SrcProvince" ||
        (rootStep && entry.Type === "Province" && key === province);
      if (!skippable) return current;
      current = entry.Next || {};
      rootStep = false;
    }
  }

  function autoAdvance(): void {
    builder!.node = skipAutoNodes(builder!.node, builder!.province, builder!.parts.length === 0);
  }

  // Targets under an order type, with the SrcProvince step skipped.
  function branchOf(node: OptionTree, orderType: string, province: string): OptionTree | null {
    const entry = node[orderType];
    if (!entry || entry.Type !== "OrderType") return null;
    const targets = skipAutoNodes(entry.Next || {}, province, false);
    return isLeaf(targets) ? null : targets;
  }

  function shortcutMode(): "support" | "pick" | null {
    if (!builder) return null;
    if (builder.support) return "support";
    if (builder.moveNode || builder.supportNode) return "pick";
    return null;
  }

  // Provinces to highlight, and to accept a tap on, at this step.
  function highlightKeys(): string[] {
    if (!builder) return [];
    const mode = shortcutMode();
    if (mode === "support") return Object.keys(builder.support!.dests);
    if (mode === "pick") {
      const keys = Object.keys(builder.moveNode || {}).concat(Object.keys(builder.supportNode || {}));
      return keys.filter((key, i) => keys.indexOf(key) === i);
    }
    return Object.keys(builder.node);
  }

  /*
  Ordering by map alone. Picking a unit highlights everywhere it can reach: the
  provinces under "Move", plus the units it could support. Tapping an empty one
  moves there. Tapping an occupied one raises a chip with whichever of Attack and
  Support the tree actually allows — one option alone skips the chip. Support
  then highlights the destinations of the supported unit, its own province
  included, which is the support-hold. The button row keeps every order type
  from the tree, and using it drops these shortcuts and walks the tree plainly.
  */
  async function startOrder(province: string): Promise<void> {
    const epoch = ++orderEpoch;
    // A retreat or adjustment phase has already read the whole plan, so the
    // tree is in hand and the unit opens with no request at all.
    const cached = plan.actionable[province];
    const options = cached || (await api.options(province));
    if (epoch !== orderEpoch || destroyed) return; // A later gesture took over.
    const root = skipAutoNodes(options || {}, province, true);
    if (isLeaf(root)) {
      builder = null;
      setStatus(unitLabel(state, province, plan.kind === "retreat") + " has no legal orders.");
      renderAll();
      return;
    }
    // The map shortcuts are the movement grammar: everywhere this unit can
    // reach, and the units it could support. A retreat has destinations but no
    // supports; an adjustment has neither.
    const shortcuts = plan.kind === "movement" || plan.kind === "retreat";
    builder = {
      province: province,
      node: root,
      parts: [],
      labels: [],
      moveNode: shortcuts ? branchOf(root, "Move", province) : null,
      supportNode: plan.kind === "movement" ? branchOf(root, "Support", province) : null,
      support: null,
    };
    hideMenu();
    renderAll();
  }

  function dropShortcuts(): void {
    builder!.moveNode = null;
    builder!.supportNode = null;
    builder!.support = null;
    hideMenu();
  }

  async function chooseOption(key: string): Promise<void> {
    if (!builder) return;
    const entry: OptionNode = builder.node[key] || {};
    dropShortcuts();
    builder.parts.push(key);
    builder.labels.push(key);
    builder.node = entry.Next || {};
    autoAdvance();

    if (isLeaf(builder.node)) {
      await postOrder();
      return;
    }
    renderAll();
  }

  // Walks several steps at once, for a button that stands for a whole path.
  async function applyPath(keys: string[]): Promise<void> {
    if (!builder) return;
    dropShortcuts();
    for (const key of keys) {
      const entry: OptionNode = builder.node[key] || {};
      builder.parts.push(key);
      builder.labels.push(key);
      builder.node = entry.Next || {};
      autoAdvance();
    }
    if (isLeaf(builder.node)) {
      await postOrder();
      return;
    }
    renderAll();
  }

  // Enters a branch the shortcut jumped to, then picks the tapped province.
  async function chooseInBranch(
    orderType: string,
    node: OptionTree,
    key: string,
    extraParts?: string[],
  ): Promise<void> {
    builder!.node = node;
    const head = [orderType].concat(extraParts || []);
    builder!.parts = head.slice();
    builder!.labels = head.slice();
    dropShortcuts();
    await chooseOption(key);
  }

  // Highlights where the supported unit may go, its own province included.
  function enterSupport(srcKey: string): void {
    const entry: OptionNode = builder!.supportNode![srcKey] || {};
    const dests = skipAutoNodes(entry.Next || {}, builder!.province, false);
    if (isLeaf(dests)) {
      setStatus("There is nothing to support in " + provinceName(srcKey) + ".");
      return;
    }
    builder!.support = { src: srcKey, dests: dests };
    hideMenu();
    renderAll();
  }

  /*
  Decides what a tap on a reachable province means. Both readings legal and a
  unit standing there means the player has to say which, so the chip is raised
  at the tap; otherwise the single legal reading is taken straight away.
  */
  function offerChoice(
    moveKey: string | null,
    supportKey: string | null,
    clientX: number,
    clientY: number,
  ): void {
    hideMenu();
    if (moveKey !== null && supportKey === null) {
      chooseInBranch("Move", builder!.moveNode!, moveKey).catch(reportError);
      return;
    }
    if (supportKey !== null && moveKey === null) {
      enterSupport(supportKey);
      return;
    }
    showMenu(clientX, clientY, [
      {
        label: "Attack",
        onPick: () => chooseInBranch("Move", builder!.moveNode!, moveKey!).catch(reportError),
      },
      { label: "Support", onPick: () => enterSupport(supportKey!) },
    ]);
    setStatus("Attack " + unitLabel(state, supportKey!) + ", or support it?");
  }

  /*
  A tap the tree does not offer, taken as an order anyway (D-029).

  This is the whole of "illegal orders are allowed" as the player meets it: the
  highlights still say what is legal, and they are still the guide, but they
  have stopped being a fence. A tap outside them builds the same parts the
  legal path would have built and posts them; the server keeps the order, the
  adjudicator throws it out, and the unit holds.

  Two taps keep their old meaning rather than becoming bluffs, because losing
  them would cost more than the bluff is worth:

    your own unit    stays the way you switch to ordering that unit, which is
                     the gesture the map is built around
    a coast whose
    province is
    already offered  is already handled above by matchingKey

  Everything else answers the way a legal tap does: an empty province is a
  move, an occupied one raises the same Attack-or-Support chip, because a
  bluffed support has to be as easy to write as a bluffed attack.

  Answers false when nothing was taken, so the caller falls through to the
  behaviour a server with the setting off keeps.
  */
  function offerIllegal(province: string, clientX: number, clientY: number): boolean {
    if (!illegalAllowed(state?.settings)) return false;
    if (!builder) return false;
    const mode = shortcutMode();

    if (mode === "support") {
      const src = builder.support!.src;
      postIllegal(["Support", src, province]);
      return true;
    }
    if (mode !== "pick") return false;

    const occupant = occupantOf(province);
    // Your own units are how you change your mind, not how you bluff.
    if (occupant && (state?.units || {})[occupant]?.nation === plan.power) return false;
    if (!occupant) {
      postIllegal(["Move", province]);
      return true;
    }

    hideMenu();
    showMenu(clientX, clientY, [
      { label: "Attack", onPick: () => postIllegal(["Move", province]) },
      {
        label: "Support",
        onPick: () => {
          // A support of a unit the tree never offered: the destination is
          // asked for the same way a legal one is, so the two feel alike.
          builder!.support = { src: occupant, dests: {} };
          hideMenu();
          renderAll();
        },
      },
    ]);
    setStatus("Attack " + unitLabel(state, occupant) + ", or support it? Neither is legal.");
    return true;
  }

  /*
  Posts an order this page knows the rules refuse, and remembers that it did.

  The province is noted BEFORE the post and dropped again if the post fails, so
  the map never marks an order the server does not hold. Nothing about the mark
  goes anywhere: it is drawn from this set, which lives in this tab.
  */
  function postIllegal(parts: string[]): void {
    if (!builder) return;
    const province = builder.province;
    builder = null;
    knownIllegal.add(province);
    reportIllegal();
    hideMenu();
    api
      .order(province, parts)
      .then((next) => {
        state = next;
        callbacks.state(next);
        setStatus(
          (describeInPhase(province, parts, plan.kind) || describeOrder(province, parts)) +
            " It is not legal: the unit will hold.",
        );
      })
      .catch((err: unknown) => {
        knownIllegal.delete(province);
        reportIllegal();
        reportError(err);
      })
      .finally(() => renderAll());
  }

  function reportIllegal(): void {
    if (callbacks.illegal) callbacks.illegal(Array.from(knownIllegal).sort());
  }

  /*
  Double tapping a unit is a Hold, no menu — in a movement phase only. The
  shortcut for the other phases would be a disband, which is far too easy to
  do by accident, so those need the button.
  */
  async function holdOrder(province: string): Promise<void> {
    if (plan.kind !== "movement") return;
    if (!allowed(province)) return;
    const epoch = ++orderEpoch;
    const options = await api.options(province);
    if (epoch !== orderEpoch || destroyed) return;
    const root = skipAutoNodes(options || {}, province, true);
    if (!root.Hold) {
      setStatus(unitLabel(state, province) + " cannot hold.");
      return;
    }
    builder = {
      province: province,
      node: root,
      parts: [],
      labels: [],
      moveNode: null,
      supportNode: null,
      support: null,
    };
    await chooseOption("Hold");
  }

  async function postOrder(): Promise<void> {
    const province = builder!.province;
    const parts = builder!.parts.slice();
    const sentence = describeInPhase(province, parts, plan.kind) || describeOrder(province, parts);
    builder = null;
    try {
      const next = await api.order(province, parts);
      state = next;
      callbacks.state(next);
      setStatus(sentence);
    } catch (err) {
      reportError(err);
    }
    renderAll();
  }

  // An empty parts list is how the server is told to drop an order.
  async function cancelOrder(province: string): Promise<void> {
    hideMenu();
    if (builder && builder.province === province) builder = null;
    setSelected(null);
    try {
      const next = await api.order(province, []);
      state = next;
      callbacks.state(next);
      setStatus("Order for " + provinceName(province) + " removed.");
    } catch (err) {
      reportError(err);
    }
    renderAll();
  }

  /*
  Drop the order, then reopen the unit ready for a new one. The reopening asks
  the server again rather than trusting the plan, because dropping the order
  is exactly what gives the province its options back.
  */
  async function changeOrder(province: string): Promise<void> {
    await cancelOrder(province);
    await startOrder(province);
  }

  /*
  Seat mode never offers another power's units. The server refuses them too,
  but a tap that only produces a 403 teaches the player nothing.

  Outside a movement phase the plan already lists every province this power may
  order, so that list is the answer: a unit with nothing to do this phase is
  turned away as plainly as another power's unit.
  */
  function allowed(province: string): boolean {
    if (plan.kind !== "movement") {
      if (plan.actionable[province]) return true;
      /*
      A province this seat already has an order in stays open, whatever the
      plan says. Once the last build is spent the server stops offering it, and
      without this the player could remove the order but never replace it.
      */
      if ((state?.orderParts || {})[province]) return true;
      hideMenu();
      if (builder) {
        builder = null;
        renderAll();
      }
      setStatus(refuseOutOfPhase(province));
      return false;
    }
    if (!callbacks.canOrder) return true;
    const units = state?.units || {};
    const unit: Unit | undefined = units[province] || units[baseProvince(province)];
    if (callbacks.canOrder(province, unit)) return true;
    const refusal = callbacks.refusal
      ? callbacks.refusal(province, unit)
      : "That unit is not yours.";
    hideMenu();
    if (builder) {
      builder = null;
      renderAll();
    }
    setStatus(refusal);
    return false;
  }

  function refuseOutOfPhase(province: string): string {
    const here = provinceName(province);
    const unit = (state?.units || {})[province];
    if (plan.kind === "retreat") {
      if (unit && unit.nation !== plan.power) return here + " is " + unit.nation + "'s.";
      return "Only a dislodged unit can be ordered in a retreat phase.";
    }
    if (unit && unit.nation !== plan.power) return here + " is " + unit.nation + "'s.";
    if (plan.duty && plan.duty.type === "Build") {
      return "You can only build in an empty supply centre this variant allows.";
    }
    return "Nothing to order in " + here + " this phase.";
  }

  function onProvinceClick(province: string, clientX: number, clientY: number): void {
    // While the last phase is on screen the map takes no orders. Pan and zoom
    // still work, because reading it is the point.
    if (review) return;
    const mode = shortcutMode();

    if (mode === "support") {
      const key = matchingKey(builder!.support!.dests, province);
      if (key !== null) {
        const src = builder!.support!.src;
        chooseInBranch("Support", builder!.support!.dests, key, [src]).catch(reportError);
        return;
      }
      /* Anywhere else is a support for a move that cannot happen. It is still
         an order, and writing it is the point (D-029). */
      if (offerIllegal(province, clientX, clientY)) return;
    } else if (mode === "pick") {
      const moveKey = matchingKey(builder!.moveNode, province);
      const supportKey = matchingKey(builder!.supportNode, province);
      if (moveKey !== null || supportKey !== null) {
        offerChoice(moveKey, supportKey, clientX, clientY);
        return;
      }
      if (offerIllegal(province, clientX, clientY)) return;
    } else if (builder) {
      // A province that is a legal choice at this step acts like its button.
      const key = matchingKey(builder.node, province);
      if (key !== null) {
        chooseOption(key).catch(reportError);
        return;
      }
    }

    // Nothing legal here: dismiss whatever is open and start over if a unit
    // was tapped.
    hideMenu();
    /*
    Outside a movement phase the plan decides, not the units map: a build is
    ordered on an empty province, and a retreat on a province whose unit now
    belongs to somebody else.
    */
    if (plan.kind !== "movement") {
      if (builder) {
        builder = null;
        renderAll();
      }
      // The shape tapped may be a coast of the province the phase asks about.
      const asked = actionableKey(province);
      if (!allowed(asked)) return;
      startOrder(asked).catch(reportError);
      return;
    }
    /*
    A unit on a coast is filed under "len/sc" but fills the whole of
    Leningrad, and the shape under the finger may be either. The occupant
    lookup spans both spellings, and its key — not the shape's id — is what
    gets ordered.
    */
    const occupant = state ? occupantOf(province) : null;
    if (!occupant) {
      if (builder) {
        builder = null;
        setStatus("Nothing there. Order abandoned.");
        renderAll();
      } else {
        setStatus("No unit in " + provinceName(province) + ".");
      }
      return;
    }
    if (!allowed(occupant)) return;
    startOrder(occupant).catch(reportError);
  }

  /** The province this phase asks about that the tapped shape stands for. */
  function actionableKey(province: string): string {
    const keys = Object.keys(plan.actionable);
    if (keys.indexOf(province) !== -1) return province;
    const base = baseProvince(province);
    const same = keys.filter((key) => baseProvince(key) === base);
    return same.length === 1 ? same[0] : province;
  }

  /*
  Finds the option key a tapped province stands for, coasts included. The
  shape under a finger and the key in the options tree need not be spelled the
  same: a tap can land on "wca/nc" when the army's move is offered as "wca",
  or on "spa" when the fleet's move is offered as "spa/nc". So the match runs
  both ways — exact, then the base, then the one coast of that base — and only
  gives up when a province offers two coasts, where the buttons must decide.
  */
  function matchingKey(node: OptionTree | null, province: string): string | null {
    const keys = Object.keys(node || {});
    if (keys.indexOf(province) !== -1) return province;
    const base = baseProvince(province);
    if (keys.indexOf(base) !== -1) return base;
    const coasts = keys.filter((key) => baseProvince(key) === base);
    return coasts.length === 1 ? coasts[0] : null;
  }

  // The province hit shape under a screen point, if any.
  function provinceAt(clientX: number, clientY: number): string | null {
    const layer = svgRoot?.querySelector("#provinces");
    if (!layer) return null;
    const hit = document.elementFromPoint(clientX, clientY);
    const shape = hit && hit.closest ? hit.closest("[id]") : null;
    return shape && shape.parentNode === layer ? shape.id : null;
  }

  // The province key of the unit standing in a province, coasts included.
  function occupantOf(province: string): string | null {
    const units = state?.units || {};
    if (units[province]) return province;
    return Object.keys(units).find((key) => baseProvince(key) === baseProvince(province)) || null;
  }

  // A fleet on a coast is listed under "stp/sc" but drawn on "stp".
  function unitAt(clientX: number, clientY: number): string | null {
    const province = provinceAt(clientX, clientY);
    return province ? occupantOf(province) : null;
  }

  // --- Anchored menu ------------------------------------------------------
  /*
  A small chip of buttons pinned near a point on the map, for the moments when
  one tap has more than one meaning. It stays inside the island because it is
  pinned to map coordinates, not to the page.
  */

  function hideMenu(): void {
    if (!menu) return;
    menu.remove();
    menu = null;
  }

  function showMenu(
    clientX: number,
    clientY: number,
    items: Array<{ label: string; onPick: () => void }>,
  ): void {
    hideMenu();
    menu = document.createElement("div");
    menu.id = "chip";
    items.forEach((item) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = item.label;
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        hideMenu();
        item.onPick();
      });
      menu!.appendChild(button);
    });
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "chip-close";
    cancel.textContent = "×";
    cancel.setAttribute("aria-label", "Dismiss");
    cancel.addEventListener("click", (event) => {
      event.stopPropagation();
      hideMenu();
      renderAll();
    });
    menu.appendChild(cancel);

    document.body.appendChild(menu);
    const box = menu.getBoundingClientRect();
    const left = clamp(clientX - box.width / 2, 8, window.innerWidth - box.width - 8);
    const top = clamp(clientY - box.height - 14, 8, window.innerHeight - box.height - 8);
    menu.style.left = left + "px";
    menu.style.top = top + "px";
  }

  // --- Rendering ----------------------------------------------------------

  function renderHighlights(): void {
    const layer = svgRoot?.querySelector("#provinces");
    if (!layer) return;
    Array.prototype.forEach.call(layer.children, (shape: Element) => {
      shape.classList.remove("legal", "occupied", "selected", "support-src", "todo");
    });
    // A review is a picture of what happened, so nothing on it invites a tap.
    if (review) return;
    /*
    A retreat or an adjustment asks for a small, known set of provinces, so
    they are marked before anything is tapped — otherwise a player would have
    to hunt for the one unit that must move.
    */
    const mark = (province: string, ...classes: string[]) => {
      const shapes = provinceShapes(province);
      const fallback = shapes.length ? shapes : provinceShapes(baseProvince(province));
      fallback.forEach((shape) => shape.classList.add(...classes));
      return fallback.length > 0;
    };

    if (!builder && plan.kind !== "movement") {
      Object.keys(plan.actionable).forEach((province) => mark(province, "todo"));
      return;
    }
    if (!builder) return;
    mark(builder.province, "selected");

    const supporting = shortcutMode() === "support" ? builder.support!.src : null;
    highlightKeys().forEach((key) => {
      const classes = ["legal"];
      // Green means "move here"; an occupied province means a choice instead.
      if (occupantOf(key)) classes.push("occupied");
      // The unit being supported pulses: tapping it again backs its hold.
      if (supporting && baseProvince(key) === baseProvince(supporting)) {
        classes.push("support-src");
      }
      mark(key, ...classes);
    });
  }

  /*
  The hint line, which is also the builder's own caption.

  It ENUMERATES what may be done at this step — "Army Berlin: move (m),
  support (s), hold (h) — or tap a highlighted province" — rather than naming
  the state the builder is in. The player then reads the answer instead of
  deducing it, and the letters in the line are the same letters printed on the
  buttons and bound to the keyboard.

  Two steps are instructions rather than lists, and keep their own words: a
  half-built support, where the next tap is on a unit and not on a button, and
  a dislodged unit with nowhere to go.
  */
  function builderHint(list: Choice[]): string {
    const mode = shortcutMode();
    const me = unitLabel(state, builder!.province, plan.kind === "retreat");

    if (mode === "support") {
      const src = builder!.support!.src;
      return (
        "Supporting " + unitLabel(state, src) + " — tap where you are helping it go, " +
        "or tap " + provinceName(src) + " again to back its hold."
      );
    }
    const atRoot = builder!.parts.length === 0;
    if (plan.kind === "retreat" && atRoot && !Object.keys(builder!.moveNode || {}).length) {
      return me + " is dislodged and has nowhere to go: it must disband.";
    }
    const step = builder!.labels[0];
    if (builder!.labels.length === 1 && (step === "Support" || step === "Convoy")) {
      return me + ": tap the unit you want to " + step.toLowerCase() + ".";
    }

    /*
    Whether the tail is true. A map shortcut is always highlighting real
    provinces; a step below the root is too. The root of an adjustment is not
    — its keys are order types, which no province on the map is named after —
    so it gets no invitation to tap.
    */
    const highlighted = mode !== null || (!atRoot && highlightKeys().length > 0);
    const subject = plan.kind === "retreat" ? me + " is dislodged" : me;
    return optionsHint(
      subject,
      list.map((choice) => ({ label: choice.label, key: choice.key })),
      highlighted,
    );
  }

  /*
  The buttons for the step the builder is on.

  Most of them step one level into the tree, the way the movement grammar has
  always worked. Two shapes are collapsed instead, because their extra step
  carries no choice: a build names its unit type right away ("Build Army"), and
  a retreat lists its destinations beside Disband, so a dislodged unit is one
  tap from either fate.
  */
  function builderChoices(): Choice[] {
    const node = builder!.node;
    const province = builder!.province;
    const atRoot = builder!.parts.length === 0;
    const out: Choice[] = [];

    Object.keys(node)
      .sort()
      .forEach((key) => {
        const entry: OptionNode = node[key] || {};
        const next = entry.Next || {};
        const unitTypes = Object.keys(next).filter((name) => next[name]?.Type === "UnitType");

        if (unitTypes.length) {
          unitTypes.sort().forEach((type) => {
            out.push({
              id: key + ":" + type,
              label: key + " " + type,
              path: [key, type],
              descend: false,
              filter: entry.Filter,
            });
          });
          return;
        }

        // A retreat's destinations belong on the bar, not one level down.
        if (atRoot && plan.kind === "retreat" && key === "Move" && builder!.moveNode) {
          Object.keys(builder!.moveNode)
            .sort()
            .forEach((dst) => {
              out.push({
                id: "Move:" + dst,
                label: provinceName(dst),
                path: ["Move", dst],
                descend: false,
              });
            });
          return;
        }

        const rest = skipAutoNodes(next, province, false);
        out.push({
          id: key,
          label: entry.Type === "Province" ? provinceName(key) : key,
          path: [key],
          descend: !isLeaf(rest),
          filter: entry.Filter,
          danger: key === "Disband",
        });
      });

    /*
    The keyboard letters, claimed in the order the buttons are drawn — and
    only by a button that IS an order type. A retreat's destinations are drawn
    as ["Move", dst] pairs, and giving Adriatic Sea the letter m because its
    path begins with Move would be a shortcut that lies.
    */
    shortcutsFor(out.map((choice) => (choice.path.length === 1 ? choice.path[0] : ""))).forEach(
      (key, i) => {
        out[i].key = key;
      },
    );
    return out;
  }

  function renderBuilder(): void {
    if (!builder) {
      choices = [];
      callbacks.builder(null);
      return;
    }
    const dislodged = plan.kind === "retreat";
    const unit = (dislodged ? state?.dislodged : state?.units)?.[builder.province];
    // The hint reads the buttons, so the buttons are built first.
    choices = builderChoices();
    const hint = builderHint(choices);
    const view: BuilderView = {
      province: builder.province,
      title:
        (unit ? unit.type + " " : "") + provinceName(builder.province) +
        (unit ? " (" + unit.nation + (dislodged ? ", dislodged" : "") + ")" : ""),
      hint: hint,
      options: choices.map((choice) => ({
        id: choice.id,
        label: choice.label,
        filter: choice.filter,
        danger: choice.danger,
        key: choice.key,
      })),
    };
    callbacks.builder(view);
    setStatus(hint);
  }

  function renderAll(): void {
    if (!svgRoot) return;
    renderOrders();
    renderUnits();
    renderBriefLabels();
    renderHighlights();
    renderBuilder();
  }

  /** Presses one of the bottom bar's buttons, whether by tap or by key. */
  function take(choice: Choice): void {
    if (choice.descend) chooseOption(choice.path[0]).catch(reportError);
    else applyPath(choice.path).catch(reportError);
  }

  function setSelected(province: string | null): void {
    selectedOrder = province;
    callbacks.select(province);
  }

  /*
  Escape backs out one step: the chip first, then a half-built support, then the
  order itself.
  */
  function escape(): void {
    if (menu) {
      hideMenu();
      renderAll();
      return;
    }
    if (builder && builder.support) {
      builder.support = null;
      renderAll();
      return;
    }
    builder = null;
    setStatus("");
    renderAll();
  }

  // --- Boot ---------------------------------------------------------------

  const ready = (async () => {
    const res = await fetch(api.mapUrl, { credentials: "same-origin" });
    if (!res.ok) throw new Error("the map could not be loaded (" + res.status + ")");
    const svgText = await res.text();
    if (destroyed) return;
    injectMap(svgText);
    readCenters();
    bindMapClicks();
    bindGestures();
    resetView();
    renderAll();
  })();

  return {
    update(next: BoardState, nextPlan: PhasePlan) {
      // A new phase throws away a half-built order: its tree belongs to a
      // board that no longer exists.
      if (nextPlan.kind !== plan.kind) {
        builder = null;
        hideMenu();
      }
      /* A draft this page marked illegal is only ever the draft still on the
         board: an order the server no longer holds is not one of ours. */
      const held = next.orderParts || {};
      const kept = Array.from(knownIllegal).filter((province) => held[province]);
      if (kept.length !== knownIllegal.size) {
        knownIllegal = new Set(kept);
        reportIllegal();
      }
      state = next;
      plan = nextPlan;
      if (selectedOrder && !(next.orders || {})[selectedOrder]) setSelected(null);
      renderAll();
    },
    showReview(view: ReviewDraw | null) {
      review = view;
      reviewFailed = new Set(view ? view.failed : []);
      reviewIllegal = new Set(view ? view.illegal || [] : []);
      if (view) ink = inkForStyle(view.style);
      if (view) {
        // A half-built order belongs to the live board, not to the picture of
        // the last one.
        builder = null;
        hideMenu();
        setSelected(null);
        callbacks.builder(null);
      }
      renderAll();
    },
    choose(id: string) {
      const choice = choices.find((option) => option.id === id);
      if (!choice) return;
      take(choice);
    },
    press(key: string) {
      const wanted = String(key || "").toLowerCase();
      const choice = choices.find((option) => option.key === wanted);
      if (!choice) return false;
      take(choice);
      return true;
    },
    /* Both switches can be flipped before the map has arrived — a device with
       a saved preference sets them on the first render. The flag is kept
       either way; only the redraw waits for something to draw on. */
    setHideOrders(on: boolean) {
      if (hideOrders === on) return;
      hideOrders = on;
      if (svgRoot) renderOrders();
    },
    setBriefLabels(on: boolean) {
      if (briefLabels === on) return;
      briefLabels = on;
      if (svgRoot) renderBriefLabels();
    },
    escape: escape,
    cancelOrder: cancelOrder,
    changeOrder: changeOrder,
    selectOrder(province: string | null) {
      setSelected(selectedOrder === province ? null : province);
      renderOrders();
    },
    resetView: resetView,
    refit: refit,
    ready: ready,
    destroy() {
      destroyed = true;
      hideMenu();
      unbind.splice(0).forEach((off) => off());
      host.replaceChildren();
      svgRoot = null;
    },
    debug: {
      centers: centers,
      view: () => view,
      zoom: zoomLevel,
      state: () => state,
      plan: () => plan,
    },
  };
}
