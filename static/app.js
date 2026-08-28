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

// Anchor points of every province, keyed by abbreviation ("vie", "stp/sc").
const centers = new Map();

let svgRoot = null;
let state = null;
let builder = null;

// Pan/zoom. baseBox is the map's own viewBox; view is the part on screen.
let baseBox = { x: 0, y: 0, w: 1524, h: 1357 };
let view = null;
const MAX_ZOOM = 8;
const NARROW_PX = 780;
const TAP_SLOP_PX = 8;

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
  renderUnits();
}

function isNarrow() {
  return window.innerWidth <= NARROW_PX;
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
  renderUnits();
}

function bindGestures() {
  const pointers = new Map();
  let pinchDistance = 0;
  let moved = 0;
  let dragging = false;
  let suppressClick = false;
  let lastTap = 0;
  let lastTapPoint = { x: 0, y: 0 };

  const midpoint = () => {
    const points = Array.from(pointers.values());
    const sum = points.reduce((acc, p) => ({ x: acc.x + p.x, y: acc.y + p.y }), { x: 0, y: 0 });
    return { x: sum.x / points.length, y: sum.y / points.length };
  };
  const spread = () => {
    const [a, b] = Array.from(pointers.values());
    return Math.hypot(a.x - b.x, a.y - b.y);
  };

  el.map.addEventListener("pointerdown", (event) => {
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.size === 1) {
      moved = 0;
      dragging = true;
      // A pan emits no click, so the flag must be cleared per gesture,
      // otherwise the tap after a pan gets swallowed.
      suppressClick = false;
    } else if (pointers.size === 2) {
      pinchDistance = spread();
      dragging = false;
      suppressClick = true;
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
        suppressClick = true;
        setView(view.x - dx, view.y - dy, view.w);
        renderUnits();
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

    // A second quick tap near the first one zooms in a step.
    const now = Date.now();
    const near = Math.hypot(event.clientX - lastTapPoint.x, event.clientY - lastTapPoint.y) < 30;
    if (now - lastTap < 300 && near) {
      suppressClick = true;
      zoomAt(event.clientX, event.clientY, 1.8);
      lastTap = 0;
      return;
    }
    lastTap = now;
    lastTapPoint = { x: event.clientX, y: event.clientY };
  };

  window.addEventListener("pointerup", release);
  window.addEventListener("pointercancel", release);

  // A pan must not also count as a province tap.
  el.map.addEventListener(
    "click",
    (event) => {
      if (!suppressClick) return;
      suppressClick = false;
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
      zoomAt(event.clientX, event.clientY, Math.exp(-event.deltaY * 0.0015));
    },
    { passive: false }
  );

  el.map.addEventListener("dblclick", (event) => event.preventDefault());

  window.addEventListener("resize", () => {
    if (!view) return;
    setView(view.x, view.y, view.w);
    renderUnits();
  });
}

function bindMapClicks() {
  const layer = svgRoot.querySelector("#provinces");
  if (!layer) throw new Error("map.svg has no #provinces layer");
  layer.addEventListener("click", (event) => {
    const shape = event.target.closest("[id]");
    if (shape && shape.parentNode === layer) onProvinceClick(shape.id);
  });
}

// --- Unit overlay ---------------------------------------------------------

function overlayLayer() {
  let layer = svgRoot.querySelector("#unit-overlay");
  if (!layer) {
    layer = document.createElementNS(SVG_NS, "g");
    layer.id = "unit-overlay";
    svgRoot.appendChild(layer);
  }
  return layer;
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

// Skips the nodes the player should not have to click. Mutates builder.node.
function autoAdvance() {
  for (;;) {
    const node = builder.node;
    if (isLeaf(node)) return;
    const keys = Object.keys(node);
    if (keys.length !== 1) return;
    const key = keys[0];
    const entry = node[key] || {};
    const skippable =
      entry.Type === "SrcProvince" ||
      (entry.Type === "Province" && builder.parts.length === 0 && key === builder.province);
    if (!skippable) return;
    builder.node = entry.Next || {};
  }
}

async function startOrder(province) {
  const options = await getJSON("/options?province=" + encodeURIComponent(province));
  builder = { province: province, node: options || {}, parts: [], labels: [] };
  autoAdvance();
  if (isLeaf(builder.node)) {
    setStatus("No legal orders for " + province + ".");
    builder = null;
    renderAll();
    return;
  }
  setStatus("");
  renderAll();
}

async function chooseOption(key) {
  const entry = builder.node[key] || {};
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

async function submitOrder() {
  const body = { province: builder.province, parts: builder.parts };
  const label = builder.province + " " + builder.labels.join(" ");
  builder = null;
  try {
    state = await postJSON("/order", body);
    setStatus("Ordered: " + label);
  } catch (err) {
    setStatus(String(err.message || err), true);
  }
  renderAll();
}

function onProvinceClick(province) {
  if (builder) {
    // A province that is a legal choice at this step acts like its button.
    const key = matchingKey(province);
    if (key !== null) {
      chooseOption(key).catch(reportError);
      return;
    }
  }
  if (!state || !state.units || !state.units[province]) {
    if (!builder) setStatus("No unit in " + province + ".");
    return;
  }
  startOrder(province).catch(reportError);
}

// Finds the option key a clicked province stands for, coasts included.
function matchingKey(province) {
  const keys = Object.keys(builder.node);
  if (keys.indexOf(province) !== -1) return province;
  const base = keys.filter((key) => baseProvince(key) === province);
  return base.length === 1 ? base[0] : null;
}

function reportError(err) {
  setStatus(String((err && err.message) || err), true);
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
  const targetsAreProvinces = Object.keys(builder.node).some(
    (key) => (builder.node[key] || {}).Type === "Province"
  );
  el.builderPath.textContent = builder.labels.length
    ? builder.labels.join(" → ") + " → ?"
    : "Pick an order type.";
  setStatus(
    targetsAreProvinces
      ? "Tap a highlighted province on the map, or use a button."
      : "Pick an order type below."
  );

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
    shape.classList.remove("legal", "selected");
  });
  if (!builder) return;
  const selected = provinceShape(builder.province);
  if (selected) selected.classList.add("selected");
  Object.keys(builder.node).forEach((key) => {
    const shape = provinceShape(key) || provinceShape(baseProvince(key));
    if (shape) shape.classList.add("legal");
  });
}

function nationOf(province) {
  const unit = (state.units || {})[province];
  return unit ? unit.nation : "";
}

function renderList(target, entries) {
  const items = entries.map(([province, text]) => {
    const li = document.createElement("li");
    const nation = nationOf(province);
    const dot = document.createElement("span");
    dot.className = "dot";
    dot.style.background = NATION_COLORS[nation] || "transparent";
    const name = document.createElement("span");
    name.className = "nation";
    name.textContent = nation || province.toUpperCase();
    const body = document.createElement("span");
    body.textContent = text;
    li.append(dot, name, body);
    return li;
  });
  target.replaceChildren(...items);
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
  renderList(el.orders, entries.map((province) => [province, orders[province]]));

  const resolutions = (state && state.resolutions) || {};
  const resolved = Object.keys(resolutions).sort();
  el.resolutionsPane.hidden = resolved.length === 0;
  renderList(el.resolutions, resolved.map((province) => [province, resolutions[province]]));
}

function renderAll() {
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
    state = await postJSON("/adjudicate", {});
    setStatus("Adjudicated.");
  } catch (err) {
    reportError(err);
  }
  renderAll();
}

async function init() {
  el.builderCancel.addEventListener("click", () => {
    builder = null;
    setStatus("");
    renderAll();
  });
  el.adjudicate.addEventListener("click", () => adjudicate());

  const [svgText, loaded] = await Promise.all([
    fetch("/map.svg").then((res) => res.text()),
    getJSON("/state"),
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

window.__app = {
  init: init,
  centers: centers,
  getState: () => state,
  getBuilder: () => builder,
  getView: () => view,
  getZoom: zoomLevel,
  resetView: resetView,
  zoomAt: zoomAt,
};

document.addEventListener("DOMContentLoaded", () => {
  init().catch((err) => {
    reportError(err);
    if (el.phase) el.phase.textContent = "Failed to load";
  });
});
