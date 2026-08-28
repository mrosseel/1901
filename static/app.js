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
  svgRoot.removeAttribute("height");
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

function renderUnits() {
  const layer = overlayLayer();
  layer.replaceChildren();
  const units = (state && state.units) || {};
  const orders = (state && state.orders) || {};

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
          point.x + "," + (point.y - 12),
          point.x + 11 + "," + (point.y + 8),
          point.x - 11 + "," + (point.y + 8),
        ].join(" ")
      );
    } else {
      shape = document.createElementNS(SVG_NS, "circle");
      shape.setAttribute("cx", point.x);
      shape.setAttribute("cy", point.y);
      shape.setAttribute("r", 11);
    }
    shape.setAttribute("fill", color);
    shape.setAttribute("class", orders[province] ? "unit ordered" : "unit");
    layer.appendChild(shape);

    const label = document.createElementNS(SVG_NS, "text");
    label.setAttribute("x", point.x);
    label.setAttribute("y", point.y + (isFleet ? 2 : 0));
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
  el.builderPath.textContent = builder.labels.length
    ? builder.labels.join(" → ") + " → ?"
    : "Pick an order type.";

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
  state = loaded;
  renderAll();
  setStatus("Click a unit to order it.");
}

window.__app = { init: init, centers: centers, getState: () => state, getBuilder: () => builder };

document.addEventListener("DOMContentLoaded", () => {
  init().catch((err) => {
    reportError(err);
    if (el.phase) el.phase.textContent = "Failed to load";
  });
});
