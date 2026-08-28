"use strict";

const NATION_COLORS = {
  Austria: "#e05252",
  England: "#7c5cd6",
  France: "#4fa3e0",
  Germany: "#8d8d8d",
  Italy: "#4fbf6a",
  Russia: "#e8e8e8",
  Turkey: "#e0b93f",
};

const SVG_NS = "http://www.w3.org/2000/svg";

/*
Province names for the classical map. The map SVG carries a names layer, but
its labels sit in their own coordinate space and cannot be matched back to the
hit shapes, so the table is kept here. Hints read as sentences, and a sentence
needs a name: "Vienna supports Budapest to hold", never "vie Support bud bud".
An abbreviation with no entry falls back to upper case.
*/
const PROVINCE_NAMES = {
  adr: "Adriatic Sea", aeg: "Aegean Sea", alb: "Albania", ank: "Ankara",
  apu: "Apulia", arm: "Armenia", bal: "Baltic Sea", bar: "Barents Sea",
  bel: "Belgium", ber: "Berlin", bla: "Black Sea", boh: "Bohemia",
  bot: "Gulf of Bothnia", bre: "Brest", bud: "Budapest", bul: "Bulgaria",
  bur: "Burgundy", cly: "Clyde", con: "Constantinople", den: "Denmark",
  eas: "Eastern Mediterranean", edi: "Edinburgh", eng: "English Channel",
  fin: "Finland", gal: "Galicia", gas: "Gascony", gol: "Gulf of Lyon",
  gre: "Greece", hel: "Helgoland Bight", hol: "Holland", ion: "Ionian Sea",
  iri: "Irish Sea", kie: "Kiel", lon: "London", lvn: "Livonia",
  lvp: "Liverpool", mar: "Marseilles", mid: "Mid-Atlantic Ocean",
  mos: "Moscow", mun: "Munich", naf: "North Africa", nap: "Naples",
  nat: "North Atlantic Ocean", nrg: "Norwegian Sea", nth: "North Sea",
  nwy: "Norway", par: "Paris", pic: "Picardy", pie: "Piedmont",
  por: "Portugal", pru: "Prussia", rom: "Rome", ruh: "Ruhr", rum: "Rumania",
  ser: "Serbia", sev: "Sevastopol", sil: "Silesia", ska: "Skagerrak",
  smy: "Smyrna", spa: "Spain", stp: "St Petersburg", swe: "Sweden",
  syr: "Syria", tri: "Trieste", tun: "Tunis", tus: "Tuscany", tyr: "Tyrolia",
  tys: "Tyrrhenian Sea", ukr: "Ukraine", ven: "Venice", vie: "Vienna",
  wal: "Wales", war: "Warsaw", wes: "Western Mediterranean", yor: "Yorkshire",
};

const COAST_NAMES = { nc: "north coast", sc: "south coast", ec: "east coast" };

// Anchor points of every province, keyed by abbreviation ("vie", "stp/sc").
const centers = new Map();

let svgRoot = null;
let state = null;
let builder = null;
let selectedOrder = null;

// Pan/zoom. baseBox is the map's own viewBox; view is the part on screen.
let orderEpoch = 0;
let gestureState = () => ({});

let baseBox = { x: 0, y: 0, w: 1524, h: 1357 };
let view = null;
const MAX_ZOOM = 8;
const NARROW_PX = 780;
const SHORT_PX = 500;
const TAP_SLOP_PX = 8;
// How long a finished gesture keeps the click it produced from landing.
const CLICK_BLOCK_MS = 250;

const el = {
  map: document.getElementById("map"),
  phase: document.getElementById("phase"),
  adjudicate: document.getElementById("adjudicate"),
  builder: document.getElementById("builder"),
  builderTitle: document.getElementById("builder-title"),
  builderPath: document.getElementById("builder-path"),
  builderButtons: document.getElementById("builder-buttons"),
  builderCancel: document.getElementById("builder-cancel"),
  orders: document.getElementById("orders"),
  resolutionsPane: document.getElementById("resolutions-pane"),
  resolutions: document.getElementById("resolutions"),
  status: document.getElementById("status"),
};

// --- HTTP -----------------------------------------------------------------

/*
Every endpoint is addressed relative to the page, so the same files serve the
default game at "/" and a numbered one at "/g/{id}/".
*/
function api(path) {
  return new URL(path, document.baseURI).toString();
}

async function getJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(url + " → " + res.status);
  return res.json();
}

async function postJSON(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(url + " → " + res.status + " " + (await res.text()));
  return res.json();
}

function setStatus(text, isError) {
  el.status.textContent = text || "";
  el.status.classList.toggle("error", Boolean(isError));
}

// --- Map ------------------------------------------------------------------

function injectMap(svgText) {
  const doc = new DOMParser().parseFromString(svgText, "image/svg+xml");
  const parseError = doc.querySelector("parsererror");
  if (parseError) throw new Error("map.svg did not parse");
  svgRoot = document.importNode(doc.documentElement, true);
  svgRoot.setAttribute("width", "100%");
  svgRoot.setAttribute("height", "100%");
  svgRoot.setAttribute("preserveAspectRatio", "xMidYMid meet");

  const box = (svgRoot.getAttribute("viewBox") || "0 0 1524 1357").trim().split(/[\s,]+/).map(Number);
  baseBox = { x: box[0], y: box[1], w: box[2], h: box[3] };
  view = null;

  el.map.replaceChildren(svgRoot);
}

/*
Reads the anchor of every "<abbr>Center" path. The rendered bounding box is
the true middle of the anchor glyph, so it is preferred; the "m X,Y" start of
the path data is the fallback. The center layers ship with display:none, which
zeroes getBBox, so they are briefly switched to visibility:hidden.
*/
function readCenters() {
  const nodes = svgRoot.querySelectorAll('[id$="Center"]');
  const layers = svgRoot.querySelectorAll("#supply-centers, #province-centers");
  const saved = [];
  layers.forEach((layer) => {
    saved.push([layer, layer.getAttribute("style")]);
    layer.setAttribute("style", "display:inline;visibility:hidden");
  });

  nodes.forEach((node) => {
    const abbr = node.id.slice(0, -"Center".length);
    if (!abbr) return;
    let point = null;
    try {
      const box = node.getBBox();
      if (box.width > 0 && box.height > 0) {
        point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      }
    } catch (err) {
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
function parseMoveTo(d) {
  if (!d) return null;
  const match = /^\s*[mM]\s*(-?[\d.]+)[\s,]+(-?[\d.]+)/.exec(d);
  if (!match) return null;
  return { x: parseFloat(match[1]), y: parseFloat(match[2]) };
}

function centerOf(province) {
  return centers.get(province) || centers.get(baseProvince(province)) || null;
}

function baseProvince(province) {
  const slash = province.indexOf("/");
  return slash === -1 ? province : province.slice(0, slash);
}

function provinceShape(province) {
  if (!svgRoot) return null;
  const layer = svgRoot.querySelector("#provinces");
  if (!layer) return null;
  return layer.querySelector('[id="' + CSS.escape(province) + '"]');
}

// --- Pan and zoom ---------------------------------------------------------
/*
Zoom and pan move the injected SVG's viewBox; nothing is transformed, so hit
testing, getBBox and the unit anchors all stay in map coordinates. The widest
allowed view is "fit all" for the current container shape, the narrowest is
MAX_ZOOM times closer.
*/

function mapRect() {
  return el.map.getBoundingClientRect();
}

// Width of the view that just fits the whole map into the container.
function fitAllWidth() {
  const rect = mapRect();
  if (!rect.width || !rect.height) return baseBox.w;
  return Math.max(baseBox.w, baseBox.h * (rect.width / rect.height));
}

function applyView() {
  if (!svgRoot || !view) return;
  svgRoot.setAttribute("viewBox", [view.x, view.y, view.w, view.h].join(" "));
}

/*
Sets the view from a wanted width and top-left corner. The height always
follows the container's aspect ratio, the width is clamped to the zoom range,
and the box is kept over the map (centred on any axis where it is larger).
*/
function clampedSize(wantedWidth) {
  const rect = mapRect();
  const aspect = rect.width && rect.height ? rect.height / rect.width : baseBox.h / baseBox.w;
  const widest = fitAllWidth();
  const w = Math.min(widest, Math.max(widest / MAX_ZOOM, wantedWidth));
  return { w: w, h: w * aspect };
}

function setView(x, y, wantedWidth) {
  const size = clampedSize(wantedWidth);
  const w = size.w;
  const h = size.h;

  view = {
    w: w,
    h: h,
    x: w >= baseBox.w ? baseBox.x + (baseBox.w - w) / 2 : clamp(x, baseBox.x, baseBox.x + baseBox.w - w),
    y: h >= baseBox.h ? baseBox.y + (baseBox.h - h) / 2 : clamp(y, baseBox.y, baseBox.y + baseBox.h - h),
  };
  applyView();
}

function clamp(value, low, high) {
  return Math.min(high, Math.max(low, value));
}

function zoomLevel() {
  return view ? fitAllWidth() / view.w : 1;
}

// Client coordinates → map coordinates.
function toMap(clientX, clientY) {
  const rect = mapRect();
  return {
    x: view.x + ((clientX - rect.left) / rect.width) * view.w,
    y: view.y + ((clientY - rect.top) / rect.height) * view.h,
  };
}

// Zooms by `factor` while the map point under (clientX, clientY) stays put.
function zoomAt(clientX, clientY, factor) {
  if (!view) return;
  const rect = mapRect();
  const anchor = toMap(clientX, clientY);
  const fx = (clientX - rect.left) / rect.width;
  const fy = (clientY - rect.top) / rect.height;
  const size = clampedSize(view.w / factor);
  setView(anchor.x - fx * size.w, anchor.y - fy * size.h, size.w);
  renderOverlays();
}

// Matches the mobile media query: a narrow screen or a short one.
function isNarrow() {
  return window.innerWidth <= NARROW_PX || window.innerHeight <= SHORT_PX;
}

/*
Wide screens open on the whole map. Narrow screens open at fit-width, stepped
in a little further, so provinces are big enough to tap straight away.
*/
function resetView() {
  const widest = fitAllWidth();
  const size = clampedSize(isNarrow() ? Math.min(widest, baseBox.w) / 1.6 : widest);
  const centre = { x: baseBox.x + baseBox.w / 2, y: baseBox.y + baseBox.h / 2 };
  setView(centre.x - size.w / 2, centre.y - size.h / 2, size.w);
  renderOverlays();
}

function bindGestures() {
  const pointers = new Map();
  let pinchDistance = 0;
  let moved = 0;
  let dragging = false;
  let suppressUntil = 0;
  let lastTap = 0;
  let lastTapPoint = { x: 0, y: 0 };

  const midpoint = () => {
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

  const spread = () => {
    const [a, b] = Array.from(pointers.values());
    return Math.hypot(a.x - b.x, a.y - b.y);
  };

  el.map.addEventListener("pointerdown", (event) => {
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
  });

  /*
  Move and release are watched on the window, not on the map, so a drag that
  leaves the map still finishes. Pointer capture would do the same, but it
  also retargets the click that follows a tap to the container, which would
  hide province clicks from the map handler.
  */
  window.addEventListener("pointermove", (event) => {
    const previous = pointers.get(event.pointerId);
    if (!previous || !view) return;
    const next = { x: event.clientX, y: event.clientY };

    if (pointers.size === 1 && dragging) {
      const rect = mapRect();
      const dx = ((next.x - previous.x) / rect.width) * view.w;
      const dy = ((next.y - previous.y) / rect.height) * view.h;
      moved += Math.hypot(next.x - previous.x, next.y - previous.y);
      if (moved > TAP_SLOP_PX) {
        blockNextClick();
        setView(view.x - dx, view.y - dy, view.w);
        renderOverlays();
      }
    }

    pointers.set(event.pointerId, next);

    if (pointers.size === 2) {
      const distance = spread();
      if (pinchDistance > 0 && distance > 0) {
        const middle = midpoint();
        zoomAt(middle.x, middle.y, distance / pinchDistance);
      }
      pinchDistance = distance;
    }
  });

  const release = (event) => {
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

  window.addEventListener("pointerup", release);
  window.addEventListener("pointercancel", release);

  // A pan must not also count as a province tap.
  el.map.addEventListener(
    "click",
    (event) => {
      if (Date.now() >= suppressUntil) return;
      suppressUntil = 0;
      event.stopPropagation();
      event.preventDefault();
    },
    true
  );

  el.map.addEventListener(
    "wheel",
    (event) => {
      if (!view) return;
      event.preventDefault();
      hideMenu();
      zoomAt(event.clientX, event.clientY, Math.exp(-event.deltaY * 0.0015));
    },
    { passive: false }
  );

  el.map.addEventListener("dblclick", (event) => event.preventDefault());

  // Lets the test harness see why a tap was or was not accepted.
  gestureState = () => ({ pointers: pointers.size, blockedFor: Math.max(0, suppressUntil - Date.now()), moved: moved });

  window.addEventListener("resize", () => {
    if (!view) return;
    setView(view.x, view.y, view.w);
    renderOverlays();
  });
}

function bindMapClicks() {
  const layer = svgRoot.querySelector("#provinces");
  if (!layer) throw new Error("map.svg has no #provinces layer");
  layer.addEventListener("click", (event) => {
    const shape = event.target.closest("[id]");
    if (shape && shape.parentNode === layer) {
      onProvinceClick(shape.id, event.clientX, event.clientY);
    }
  });
}

// --- Overlays -------------------------------------------------------------

// Orders are drawn under the unit markers, both in map coordinates.
function overlay(id) {
  let layer = svgRoot.querySelector("#" + id);
  if (!layer) {
    layer = document.createElementNS(SVG_NS, "g");
    layer.id = id;
    svgRoot.appendChild(layer);
  }
  return layer;
}

function overlayLayer() {
  const orders = overlay("order-overlay");
  const units = overlay("unit-overlay");
  if (orders.nextSibling !== units) svgRoot.insertBefore(orders, units);
  return units;
}

// Both map overlays follow the zoom, so they are redrawn together.
function renderOverlays() {
  renderOrders();
  renderUnits();
}

// Map units per screen pixel, so markers keep one size however far you zoom.
function unitsPerPixel() {
  const rect = mapRect();
  if (!view || !rect.width) return 1;
  return view.w / rect.width;
}

function renderUnits() {
  const layer = overlayLayer();
  layer.replaceChildren();
  const units = (state && state.units) || {};
  const orders = (state && state.orders) || {};
  const r = clamp(12 * unitsPerPixel(), 8, 60);

  Object.keys(units).forEach((province) => {
    const unit = units[province];
    const point = centerOf(province);
    if (!point) return;

    const color = NATION_COLORS[unit.nation] || "#bbbbbb";
    const isFleet = String(unit.type).toLowerCase() === "fleet";
    let shape;
    if (isFleet) {
      shape = document.createElementNS(SVG_NS, "polygon");
      shape.setAttribute(
        "points",
        [
          point.x + "," + (point.y - r * 1.1),
          point.x + r + "," + (point.y + r * 0.75),
          point.x - r + "," + (point.y + r * 0.75),
        ].join(" ")
      );
    } else {
      shape = document.createElementNS(SVG_NS, "circle");
      shape.setAttribute("cx", point.x);
      shape.setAttribute("cy", point.y);
      shape.setAttribute("r", r);
    }
    const ordered = Boolean(orders[province]);
    shape.setAttribute("fill", color);
    shape.setAttribute("stroke", ordered ? "#ffffff" : "#14161a");
    shape.setAttribute("stroke-width", Math.max(1, r * (ordered ? 0.28 : 0.16)));
    shape.setAttribute("class", ordered ? "unit ordered" : "unit");
    layer.appendChild(shape);

    const label = document.createElementNS(SVG_NS, "text");
    label.setAttribute("x", point.x);
    label.setAttribute("y", point.y + (isFleet ? r * 0.2 : 0));
    label.setAttribute("font-size", r * 1.1);
    label.setAttribute("class", "unit-label");
    label.textContent = isFleet ? "F" : "A";
    layer.appendChild(label);
  });
}

// --- Order graphics -------------------------------------------------------
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

function towards(from, to, distance) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy) || 1;
  return { x: from.x + (dx / length) * distance, y: from.y + (dy / length) * distance };
}

function midpoint(a, b) {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

// The unit vector across a line, for arrow wings and support bars.
function normalOf(a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.hypot(dx, dy) || 1;
  return { x: -dy / length, y: dx / length };
}

// A quadratic curve, bowed out to one side so it never hides under a move line.
function curvePath(from, to) {
  const mid = midpoint(from, to);
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy) || 1;
  const bow = length * 0.18;
  const control = { x: mid.x - (dy / length) * bow, y: mid.y + (dx / length) * bow };
  return "M " + from.x + " " + from.y + " Q " + control.x + " " + control.y + " " + to.x + " " + to.y;
}

/*
The arrow is one closed outline — shaft and head in a single polygon — so its
border runs unbroken from tail to tip. A marker-drawn head cannot do this: the
underlay stops where the marker starts and the border breaks at the neck.
*/
function arrowPoints(a, b, shaftHalf, headLength, headHalf) {
  const n = normalOf(a, b);
  const neck = towards(b, a, headLength);
  const at = (point, offset) => point.x + n.x * offset + "," + (point.y + n.y * offset);
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

function renderOrders() {
  const layer = overlay("order-overlay");
  layer.replaceChildren();
  const parts = (state && state.orderParts) || {};
  const units = (state && state.units) || {};
  const r = clamp(12 * unitsPerPixel(), 8, 60);
  const base = Math.max(1.5, r * 0.3);

  Object.keys(parts).forEach((province) => {
    const from = centerOf(province);
    const order = parts[province] || [];
    if (!from || !order.length) return;
    const unit = units[province];
    const color = NATION_COLORS[unit ? unit.nation : ""] || "#bbbbbb";
    // The picked order is drawn heavier; weights stay in map units so they
    // keep following the zoom.
    const width = base * (selectedOrder === province ? 1.9 : 1);
    const border = Math.max(1.2, width * 0.7);

    const group = document.createElementNS(SVG_NS, "g");
    group.setAttribute("class", "order");
    group.setAttribute("data-province", province);

    /*
    Every shape is built twice: once dark and fattened by the border width,
    once in the nation colour. All the dark passes are laid down before any
    coloured one, so no shape's underlay ever cuts across a neighbour.
    */
    const shapes = [];
    const paint = (node, halo, solid) => {
      if (solid) {
        node.setAttribute("fill", halo ? "#1b1b1b" : color);
        node.setAttribute("stroke", halo ? "#1b1b1b" : "none");
        node.setAttribute("stroke-width", halo ? border * 2 : 0);
        node.setAttribute("stroke-linejoin", "round");
      } else {
        node.setAttribute("fill", "none");
        node.setAttribute("stroke", halo ? "#1b1b1b" : color);
        node.setAttribute("stroke-width", halo ? width + border * 2 : width);
        node.setAttribute("stroke-linecap", "round");
      }
      node.setAttribute("class", halo ? "order-halo" : "order-line");
      return node;
    };

    const arrow = (a, b) => (halo) => {
      const node = document.createElementNS(SVG_NS, "polygon");
      node.setAttribute("points", arrowPoints(a, b, width / 2, r * 1.15, r * 0.62));
      return paint(node, halo, true);
    };
    const dashedCurve = (a, b) => (halo) => {
      const node = document.createElementNS(SVG_NS, "path");
      node.setAttribute("d", curvePath(a, b));
      node.setAttribute("stroke-dasharray", r * 0.55 + " " + r * 0.4);
      return paint(node, halo, false);
    };
    const ring = (at, radius) => (halo) => {
      const node = document.createElementNS(SVG_NS, "circle");
      node.setAttribute("cx", at.x);
      node.setAttribute("cy", at.y);
      node.setAttribute("r", radius);
      return paint(node, halo, false);
    };
    const segment = (a, b) => (halo) => {
      const node = document.createElementNS(SVG_NS, "line");
      node.setAttribute("x1", a.x);
      node.setAttribute("y1", a.y);
      node.setAttribute("x2", b.x);
      node.setAttribute("y2", b.y);
      return paint(node, halo, false);
    };

    const type = order[0];
    const anchorOf = (name) => centerOf(name) || centerOf(baseProvince(name));

    if (type === "Move" && order[1]) {
      const to = anchorOf(order[1]);
      if (!to) return;
      shapes.push(arrow(towards(from, to, r * 1.15), towards(to, from, r * 1.6)));
    } else if (type === "Hold") {
      shapes.push(ring(from, r * 1.5));
    } else if (type === "Support" || type === "Convoy") {
      const src = anchorOf(order[1] || "");
      if (!src) return;
      const holdSupport = order.length < 3 || order[2] === order[1];
      // For a hold the curve stops clear of the supported unit's marker, so
      // the ring at its end stays visible.
      const end = holdSupport ? towards(src, from, r * 2.6) : midpoint(src, anchorOf(order[2]) || src);
      const start = towards(from, end, r * 1.2);
      shapes.push(dashedCurve(start, end));
      if (holdSupport) {
        shapes.push(ring(end, r * 0.55));
      } else {
        // A bar across the end, so a support never reads as a move.
        const n = normalOf(start, end);
        const reach = r * 0.7;
        shapes.push(segment(
          { x: end.x - n.x * reach, y: end.y - n.y * reach },
          { x: end.x + n.x * reach, y: end.y + n.y * reach }
        ));
      }
    } else {
      return;
    }

    shapes.forEach((make) => group.appendChild(make(true)));
    shapes.forEach((make) => group.appendChild(make(false)));

    if (selectedOrder) group.classList.add(selectedOrder === province ? "hot" : "dim");
    layer.appendChild(group);
  });
}

// --- Option tree ----------------------------------------------------------
/*
godip serializes Options as a recursive map:
  { "<value>": { "Type": "OrderType"|"Province"|"SrcProvince"|"UnitType",
                 "Next": { ... }, "Filter": "..." } }
A leaf has an empty or null "Next".

The full server-side tree is province → OrderType → SrcProvince → targets, and
/options may hand back either the whole branch or the part below the province.
Both are handled: a lone "SrcProvince" node, or a lone root "Province" node
naming the clicked province, is selected automatically and left out of the
order parts. Every other choice the player clicks is appended to parts, so a
walk of Move → tri in "vie" posts {"province":"vie","parts":["Move","tri"]}.
*/

function isLeaf(node) {
  return !node || Object.keys(node).length === 0;
}

// Walks past the nodes the player should not have to click.
function skipAutoNodes(node, province, atRoot) {
  let current = node || {};
  let rootStep = atRoot;
  for (;;) {
    if (isLeaf(current)) return current;
    const keys = Object.keys(current);
    if (keys.length !== 1) return current;
    const key = keys[0];
    const entry = current[key] || {};
    const skippable =
      entry.Type === "SrcProvince" ||
      (rootStep && entry.Type === "Province" && key === province);
    if (!skippable) return current;
    current = entry.Next || {};
    rootStep = false;
  }
}

function autoAdvance() {
  builder.node = skipAutoNodes(builder.node, builder.province, builder.parts.length === 0);
}

/*
Ordering by map alone. Picking a unit highlights everywhere it can reach: the
provinces under "Move", plus the units it could support. Tapping an empty one
moves there. Tapping an occupied one raises a chip with whichever of Attack and
Support the tree actually allows — one option alone skips the chip. Support
then highlights the destinations of the supported unit, its own province
included, which is the support-hold. The bottom bar keeps every order type from
the tree, and using it drops these shortcuts and walks the tree plainly.
*/

// Targets under an order type, with the SrcProvince step skipped.
function branchOf(node, orderType, province) {
  const entry = node[orderType];
  if (!entry || entry.Type !== "OrderType") return null;
  const targets = skipAutoNodes(entry.Next || {}, province, false);
  return isLeaf(targets) ? null : targets;
}

function shortcutMode() {
  if (!builder) return null;
  if (builder.support) return "support";
  if (builder.moveNode || builder.supportNode) return "pick";
  return null;
}

// Provinces to highlight, and to accept a tap on, at this step.
function highlightKeys() {
  if (!builder) return [];
  const mode = shortcutMode();
  if (mode === "support") return Object.keys(builder.support.dests);
  if (mode === "pick") {
    const keys = Object.keys(builder.moveNode || {}).concat(Object.keys(builder.supportNode || {}));
    return keys.filter((key, i) => keys.indexOf(key) === i);
  }
  return Object.keys(builder.node);
}

function provinceName(province) {
  const base = baseProvince(province);
  const name = PROVINCE_NAMES[base] || base.toUpperCase();
  if (base === province) return name;
  const coast = COAST_NAMES[province.slice(base.length + 1)];
  return coast ? name + " (" + coast + ")" : name;
}

// "Army Vienna" — the unit standing in a province, named for a sentence.
function unitLabel(province) {
  const unit = (state.units || {})[province] || (state.units || {})[baseProvince(province)];
  return (unit ? unit.type + " " : "") + provinceName(province);
}

// What an order will read as once it is in: "Vienna supports Budapest to hold."
function describeOrder(province, parts) {
  const from = provinceName(province);
  const type = parts[0];
  if (type === "Move") return from + " moves to " + provinceName(parts[1]) + ".";
  if (type === "Hold") return from + " holds.";
  if (type === "Support" || type === "Convoy") {
    const verb = type === "Convoy" ? " convoys " : " supports ";
    const src = provinceName(parts[1]);
    if (parts.length < 3 || parts[2] === parts[1]) return from + verb + src + " to hold.";
    return from + verb + src + " to " + provinceName(parts[2]) + ".";
  }
  return from + " " + parts.map(provinceName).join(" ") + ".";
}

async function startOrder(province) {
  const epoch = ++orderEpoch;
  const options = await getJSON(api("options?province=" + encodeURIComponent(province)));
  if (epoch !== orderEpoch) return; // A later gesture took over.
  const root = skipAutoNodes(options || {}, province, true);
  if (isLeaf(root)) {
    builder = null;
    setStatus(unitLabel(province) + " has no legal orders.");
    renderAll();
    return;
  }
  builder = {
    province: province,
    node: root,
    parts: [],
    labels: [],
    moveNode: branchOf(root, "Move", province),
    supportNode: branchOf(root, "Support", province),
    support: null,
  };
  hideMenu();
  renderAll();
}

function dropShortcuts() {
  builder.moveNode = null;
  builder.supportNode = null;
  builder.support = null;
  hideMenu();
}

async function chooseOption(key) {
  const entry = builder.node[key] || {};
  dropShortcuts();
  builder.parts.push(key);
  builder.labels.push(key);
  builder.node = entry.Next || {};
  autoAdvance();

  if (isLeaf(builder.node)) {
    await submitOrder();
    return;
  }
  renderAll();
}

// Enters a branch the shortcut jumped to, then picks the tapped province.
async function chooseInBranch(orderType, node, key, extraParts) {
  builder.node = node;
  const head = [orderType].concat(extraParts || []);
  builder.parts = head.slice();
  builder.labels = head.slice();
  dropShortcuts();
  await chooseOption(key);
}

// Highlights where the supported unit may go, its own province included.
function enterSupport(srcKey) {
  const entry = builder.supportNode[srcKey] || {};
  const dests = skipAutoNodes(entry.Next || {}, builder.province, false);
  if (isLeaf(dests)) {
    setStatus("There is nothing to support in " + provinceName(srcKey) + ".");
    return;
  }
  builder.support = { src: srcKey, dests: dests };
  hideMenu();
  renderAll();
}

/*
Decides what a tap on a reachable province means. Both readings legal and a
unit standing there means the player has to say which, so the chip is raised
at the tap; otherwise the single legal reading is taken straight away.
*/
function offerChoice(moveKey, supportKey, clientX, clientY) {
  hideMenu();
  if (moveKey !== null && supportKey === null) {
    chooseInBranch("Move", builder.moveNode, moveKey).catch(reportError);
    return;
  }
  if (supportKey !== null && moveKey === null) {
    enterSupport(supportKey);
    return;
  }
  showMenu(clientX, clientY, [
    {
      label: "Attack",
      onPick: () => chooseInBranch("Move", builder.moveNode, moveKey).catch(reportError),
    },
    { label: "Support", onPick: () => enterSupport(supportKey) },
  ]);
  setStatus("Attack " + unitLabel(supportKey) + ", or support it?");
}

// Double tapping a unit is a Hold, no menu.
async function holdOrder(province) {
  const epoch = ++orderEpoch;
  const options = await getJSON(api("options?province=" + encodeURIComponent(province)));
  if (epoch !== orderEpoch) return;
  const root = skipAutoNodes(options || {}, province, true);
  if (!root.Hold) {
    setStatus(unitLabel(province) + " cannot hold.");
    return;
  }
  builder = { province: province, node: root, parts: [], labels: [], moveNode: null };
  await chooseOption("Hold");
}

async function submitOrder() {
  const body = { province: builder.province, parts: builder.parts };
  const sentence = describeOrder(builder.province, builder.parts);
  builder = null;
  try {
    state = await postJSON(api("order"), body);
    setStatus(sentence);
  } catch (err) {
    setStatus(String(err.message || err), true);
  }
  renderAll();
}

/*
An empty parts list is how the server is told to drop an order.
*/
async function cancelOrder(province) {
  hideMenu();
  if (builder && builder.province === province) builder = null;
  selectedOrder = null;
  try {
    state = await postJSON(api("order"), { province: province, parts: [] });
    setStatus("Order for " + provinceName(province) + " removed.");
  } catch (err) {
    setStatus(String(err.message || err), true);
  }
  renderAll();
}

// Drop the order, then reopen the unit ready for a new one.
async function changeOrder(province) {
  await cancelOrder(province);
  await startOrder(province);
}

function onProvinceClick(province, clientX, clientY) {
  const mode = shortcutMode();

  if (mode === "support") {
    const key = matchingKey(builder.support.dests, province);
    if (key !== null) {
      const src = builder.support.src;
      chooseInBranch("Support", builder.support.dests, key, [src]).catch(reportError);
      return;
    }
  } else if (mode === "pick") {
    const moveKey = matchingKey(builder.moveNode, province);
    const supportKey = matchingKey(builder.supportNode, province);
    if (moveKey !== null || supportKey !== null) {
      offerChoice(moveKey, supportKey, clientX, clientY);
      return;
    }
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
  if (!state || !state.units || !state.units[province]) {
    if (builder) {
      builder = null;
      setStatus("Nothing there. Order abandoned.");
      renderAll();
    } else {
      setStatus("No unit in " + province + ".");
    }
    return;
  }
  startOrder(province).catch(reportError);
}

// Finds the option key a clicked province stands for, coasts included.
function matchingKey(node, province) {
  const keys = Object.keys(node || {});
  if (keys.indexOf(province) !== -1) return province;
  const base = keys.filter((key) => baseProvince(key) === province);
  return base.length === 1 ? base[0] : null;
}

// The province hit shape under a screen point, if any.
function provinceAt(clientX, clientY) {
  const layer = svgRoot && svgRoot.querySelector("#provinces");
  if (!layer) return null;
  const hit = document.elementFromPoint(clientX, clientY);
  const shape = hit && hit.closest ? hit.closest("[id]") : null;
  return shape && shape.parentNode === layer ? shape.id : null;
}

// The province key of the unit standing in a province, coasts included.
function occupantOf(province) {
  const units = (state && state.units) || {};
  if (units[province]) return province;
  return Object.keys(units).find((key) => baseProvince(key) === baseProvince(province)) || null;
}

// A fleet on a coast is listed under "stp/sc" but drawn on "stp".
function unitAt(clientX, clientY) {
  const province = provinceAt(clientX, clientY);
  return province ? occupantOf(province) : null;
}

function reportError(err) {
  setStatus(String((err && err.message) || err), true);
}

// --- Anchored menu --------------------------------------------------------
/*
A small chip of buttons pinned near a point on the map, for the moments when
one tap has more than one meaning. Items are {label, onPick}, so the same chip
serves Attack/Support today and Convoy or anything else later.
*/

let menu = null;

function hideMenu() {
  if (!menu) return;
  menu.remove();
  menu = null;
}

function showMenu(clientX, clientY, items) {
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
    menu.appendChild(button);
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

// --- Rendering ------------------------------------------------------------

function renderBuilder() {
  if (!builder) {
    el.builder.hidden = true;
    el.builderButtons.replaceChildren();
    return;
  }
  el.builder.hidden = false;
  const unit = (state.units || {})[builder.province];
  el.builderTitle.textContent =
    (unit ? unit.type + " " : "") + builder.province.toUpperCase() +
    (unit ? " (" + unit.nation + ")" : "");
  const mode = shortcutMode();
  const me = unitLabel(builder.province);
  const here = provinceName(builder.province);
  let hint;
  if (mode === "support") {
    const src = builder.support.src;
    hint =
      "Supporting " + unitLabel(src) + " — tap where you are helping it go, " +
      "or tap " + provinceName(src) + " again to back its hold.";
  } else if (mode === "pick") {
    hint =
      me + ": tap a green province to move there. Occupied = attack or " +
      "support. Double-tap " + here + " to hold.";
  } else {
    const step = builder.labels[0];
    const naming = builder.labels.length === 1 && (step === "Support" || step === "Convoy");
    if (naming) {
      hint = me + ": tap the unit you want to " + step.toLowerCase() + ".";
    } else if (highlightKeys().length) {
      hint = me + ": tap a highlighted province, or use a button below.";
    } else {
      hint = me + ": pick an order type below.";
    }
  }
  // The bar is pinned to the bottom on a phone, where the status line under
  // the sidebar can be scrolled out of sight, so the hint is shown in both.
  el.builderPath.textContent = hint;
  setStatus(hint);

  const buttons = Object.keys(builder.node)
    .sort()
    .map((key) => {
      const button = document.createElement("button");
      button.type = "button";
      const entry = builder.node[key] || {};
      button.textContent = entry.Type === "Province" ? key.toUpperCase() : key;
      if (entry.Filter) button.title = entry.Filter;
      button.addEventListener("click", () => chooseOption(key).catch(reportError));
      return button;
    });
  el.builderButtons.replaceChildren(...buttons);
}

function renderHighlights() {
  const layer = svgRoot && svgRoot.querySelector("#provinces");
  if (!layer) return;
  Array.prototype.forEach.call(layer.children, (shape) => {
    shape.classList.remove("legal", "occupied", "selected", "support-src");
  });
  if (!builder) return;
  const selected = provinceShape(builder.province) || provinceShape(baseProvince(builder.province));
  if (selected) selected.classList.add("selected");

  const supporting = shortcutMode() === "support" ? builder.support.src : null;
  highlightKeys().forEach((key) => {
    const shape = provinceShape(key) || provinceShape(baseProvince(key));
    if (!shape) return;
    shape.classList.add("legal");
    // Green means "move here"; an occupied province means a choice instead.
    if (occupantOf(key)) shape.classList.add("occupied");
    // The unit being supported pulses: tapping it again backs its hold.
    if (supporting && baseProvince(key) === baseProvince(supporting)) {
      shape.classList.add("support-src");
    }
  });
}

function nationOf(province) {
  const unit = (state.units || {})[province];
  return unit ? unit.nation : "";
}

function renderList(target, entries, pickable) {
  const items = entries.map(([province, text]) => {
    const li = document.createElement("li");
    const nation = nationOf(province);
    const dot = document.createElement("span");
    dot.className = "dot";
    dot.style.background = NATION_COLORS[nation] || "transparent";
    const name = document.createElement("span");
    name.className = "nation";
    name.textContent = nation || provinceName(province);
    const body = document.createElement("span");
    body.className = "order-text";
    body.textContent = text;
    li.append(dot, name, body);

    // An order in the list and its drawing on the map are the same thing:
    // picking one here singles the other out. The buttons act on the order
    // itself, so they must not also toggle that highlight.
    if (pickable) {
      li.className = "pickable" + (selectedOrder === province ? " picked" : "");
      li.dataset.province = province;
      li.tabIndex = 0;
      li.addEventListener("click", () => selectOrder(province));
      li.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          selectOrder(province);
        }
      });

      const actions = document.createElement("span");
      actions.className = "row-actions";
      const act = (label, className, title, run) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = className;
        button.textContent = label;
        button.title = title;
        button.setAttribute("aria-label", title);
        button.addEventListener("click", (event) => {
          event.stopPropagation();
          run().catch(reportError);
        });
        return button;
      };
      actions.append(
        act("Change", "row-change", "Change the order for " + provinceName(province),
            () => changeOrder(province)),
        act("\u00d7", "row-cancel", "Remove the order for " + provinceName(province),
            () => cancelOrder(province))
      );
      li.appendChild(actions);
    }
    return li;
  });
  target.replaceChildren(...items);
}

function selectOrder(province) {
  selectedOrder = selectedOrder === province ? null : province;
  renderOrders();
  renderSidebar();
}

function renderSidebar() {
  const phase = (state && state.phase) || {};
  el.phase.textContent = [phase.season, phase.year, phase.type].filter(Boolean).join(" ") || "—";
  el.adjudicate.disabled = false;

  const orders = (state && state.orders) || {};
  const entries = Object.keys(orders).sort((a, b) => {
    const byNation = nationOf(a).localeCompare(nationOf(b));
    return byNation !== 0 ? byNation : a.localeCompare(b);
  });
  if (selectedOrder && !orders[selectedOrder]) selectedOrder = null;
  renderList(el.orders, entries.map((province) => [province, orders[province]]), true);

  const resolutions = (state && state.resolutions) || {};
  const resolved = Object.keys(resolutions).sort();
  el.resolutionsPane.hidden = resolved.length === 0;
  renderList(el.resolutions, resolved.map((province) => [province, resolutions[province]]));
}

function renderAll() {
  renderOrders();
  renderUnits();
  renderHighlights();
  renderBuilder();
  renderSidebar();
}

// --- Boot -----------------------------------------------------------------

async function adjudicate() {
  el.adjudicate.disabled = true;
  builder = null;
  try {
    state = await postJSON(api("adjudicate"), {});
    setStatus("Adjudicated.");
  } catch (err) {
    reportError(err);
  }
  renderAll();
}

/*
Escape backs out one step: the chip first, then a half-built support, then the
order itself.
*/
function escape() {
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

async function init() {
  el.builderCancel.addEventListener("click", escape);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") escape();
  });
  el.adjudicate.addEventListener("click", () => adjudicate());

  const [svgText, loaded] = await Promise.all([
    fetch(api("map.svg")).then((res) => res.text()),
    getJSON(api("state")),
  ]);
  injectMap(svgText);
  readCenters();
  bindMapClicks();
  bindGestures();
  state = loaded;
  resetView();
  renderAll();
  setStatus("Tap a unit on the map to order it. Drag to pan, pinch or scroll to zoom.");
}

async function refresh() {
  state = await getJSON(api("state"));
  renderAll();
}

window.__app = {
  init: init,
  refresh: refresh,
  centers: centers,
  getState: () => state,
  getBuilder: () => builder,
  getView: () => view,
  getZoom: zoomLevel,
  gesture: () => gestureState(),
  resetView: resetView,
  zoomAt: zoomAt,
};

document.addEventListener("DOMContentLoaded", () => {
  init().catch((err) => {
    reportError(err);
    if (el.phase) el.phase.textContent = "Failed to load";
  });
});
