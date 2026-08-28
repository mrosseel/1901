/*
The placement editor: one self-contained HTML file per map.

The audit says which anchors are wrong and the optimizer proposes better ones,
but neither can say whether the result looks right — and on a hand-placed map
that is the only question that matters. So the whole thing is handed over as a
page: the map, a marker on every province, a before/after toggle, and every
marker draggable, with the same three tests running live under the fingers.

Everything is inlined — the map, the measurements, the placements, the code —
because the file has to open from a file:// URL on someone else's machine with
no server, no network and no build step.

The live tests are the audit's tests, not an approximation of them. Whether a
marker is inside its province is asked of the browser with isPointInFill, the
same call the audit makes; the label and supply centre boxes are the ones the
audit measured, inlined as data. A marker that reads green here reads clean in
the report.
*/

import type { MapGeometry } from "./browser.ts";
import type { PlacementTable } from "./audit.ts";

export interface EditorOptions {
  variant: string;
  svgText: string;
  map: MapGeometry;
  radius: number;
  shipped: PlacementTable;
  optimized: PlacementTable;
}

/*
JSON safe to drop inside a <script> element. Escaping "<" kills "</script" and
"<!--" alike; the two line separators are escaped rather than removed, because
dropping a character silently changes the data it was in.
*/
function embed(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

export function buildEditor(options: EditorOptions): string {
  const data = {
    variant: options.variant,
    radius: options.radius,
    viewBox: options.map.viewBox,
    labels: options.map.labels.map((r) => [r.x, r.y, r.w, r.h]),
    supplyCentres: options.map.supplyCentres.map((r) => [r.x, r.y, r.w, r.h]),
    shipped: options.shipped,
    optimized: options.optimized,
    keys: Object.keys(options.optimized).sort(),
  };

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Placement editor — ${options.variant}</title>
<style>${STYLE}</style>
</head>
<body>
<header class="bar">
  <h1>Placement — <b>${options.variant}</b></h1>
  <div class="controls">
    <div class="seg" role="group" aria-label="Which placement to show">
      <button type="button" id="showBefore">Before</button>
      <button type="button" id="showAfter" class="on">After</button>
    </div>
    <label class="check"><input type="checkbox" id="showDislodged"> Dislodged markers</label>
    <label class="check"><input type="checkbox" id="showShipped" checked> Mark shipped anchors</label>
    <button type="button" id="reset">Reset view</button>
    <button type="button" id="revert">Undo all my drags</button>
    <button type="button" id="export" class="primary">Export JSON</button>
  </div>
</header>

<main>
  <div id="stage">
    <div id="map">${options.svgText}</div>
    <p class="hint" id="hint">Drag a marker to move it. Wheel to zoom, drag the map to pan.</p>
  </div>
  <aside id="side">
    <div class="tally" id="tally"></div>
    <div class="legend">
      <span><i class="sw green"></i>inside, clear of names</span>
      <span><i class="sw amber"></i>covers a name</span>
      <span><i class="sw red"></i>not inside its province</span>
      <span><i class="sw ring"></i>covers a supply centre glyph</span>
    </div>
    <h2>Problems</h2>
    <ul class="list" id="problems"></ul>
  </aside>
</main>

<dialog id="exportBox">
  <h2>Corrected placement</h2>
  <p class="note">The whole table, in the format the server will read. Copy it out — a file download is often blocked from a file:// page.</p>
  <textarea id="exportText" spellcheck="false" readonly></textarea>
  <div class="row">
    <button type="button" id="copy" class="primary">Copy</button>
    <span id="copied" class="note"></span>
    <button type="button" id="closeExport">Close</button>
  </div>
</dialog>

<script>
const DATA = ${embed(data)};
${SCRIPT}
</script>
</body>
</html>
`;
}

const STYLE = `
*{box-sizing:border-box}
html,body{height:100%}
body{margin:0;background:#14161a;color:#e6e8ec;font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;display:flex;flex-direction:column}
h1{font-size:15px;margin:0;font-weight:500;color:#9aa3b2}
h1 b{color:#e6e8ec}
h2{font-size:12px;margin:0 0 6px;color:#9aa3b2;text-transform:uppercase;letter-spacing:.06em}
.bar{display:flex;gap:16px;align-items:center;flex-wrap:wrap;padding:10px 14px;border-bottom:1px solid #363c46;background:#1d2026}
.controls{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-left:auto}
button{font:inherit;color:#e6e8ec;background:#262a32;border:1px solid #363c46;border-radius:6px;padding:7px 12px;cursor:pointer}
button:hover{border-color:#6ea8fe}
button.primary{background:#2c4a7c;border-color:#3f6cae}
.seg{display:flex;border:1px solid #363c46;border-radius:6px;overflow:hidden}
.seg button{border:none;border-radius:0;background:#1d2026}
.seg button.on{background:#2c4a7c}
.check{display:flex;align-items:center;gap:6px;color:#9aa3b2}
.check input{width:16px;height:16px}
main{flex:1;display:grid;grid-template-columns:minmax(0,1fr) 330px;min-height:0}
#stage{position:relative;min-width:0;overflow:hidden;background:#0e1013}
#map{position:absolute;inset:0}
#map svg{display:block;width:100%;height:100%;touch-action:none}
/* The hit shapes ship hidden. Keep their geometry live for isPointInFill and
   paint nothing, exactly as the board does. */
#map svg #provinces{display:inline!important;visibility:hidden}
.hint{position:absolute;left:10px;bottom:10px;margin:0;padding:6px 10px;border-radius:6px;background:rgba(20,22,26,.85);color:#9aa3b2;font-size:12px;pointer-events:none}
#side{border-left:1px solid #363c46;background:#1d2026;padding:12px;overflow:auto;display:flex;flex-direction:column;gap:10px}
.tally{display:grid;grid-template-columns:1fr auto;gap:2px 10px;font-size:13px}
.tally b{font-variant-numeric:tabular-nums}
.legend{display:flex;flex-direction:column;gap:3px;color:#9aa3b2;font-size:12px}
.sw{display:inline-block;width:11px;height:11px;border-radius:50%;margin-right:6px;vertical-align:-1px}
.sw.green{background:#6ede8a}.sw.amber{background:#ffba5c}.sw.red{background:#ff5c5c}
.sw.ring{background:transparent;border:2px dashed #6ea8fe}
.list{list-style:none;margin:0;padding:0;font-size:13px;overflow:auto}
.list li{display:flex;gap:8px;align-items:baseline;padding:4px 2px;border-bottom:1px solid #363c46;cursor:pointer}
.list li:hover{background:#262a32}
.list .key{font-family:ui-monospace,Menlo,monospace;min-width:64px}
.list .why{color:#9aa3b2;font-size:12px}
.list .why.bad{color:#ff8b8b}
.list .why.warn{color:#ffba5c}
.moved{color:#6ea8fe}
dialog{background:#1d2026;color:#e6e8ec;border:1px solid #363c46;border-radius:10px;width:min(760px,92vw);padding:16px}
dialog::backdrop{background:rgba(0,0,0,.6)}
textarea{width:100%;height:46vh;background:#0e1013;color:#e6e8ec;border:1px solid #363c46;border-radius:6px;font-family:ui-monospace,Menlo,monospace;font-size:12px;padding:8px}
.row{display:flex;gap:10px;align-items:center;margin-top:10px}
.note{color:#9aa3b2;font-size:12px;margin:0 0 8px}
`;

/*
The page's own code. It is written as one string rather than a module so the
file stays a single artefact with nothing to resolve — the whole point is that
it opens from a folder.
*/
const SCRIPT = String.raw`
const NS = "http://www.w3.org/2000/svg";
const svg = document.querySelector("#map svg");
const stage = document.getElementById("stage");
const provinceLayer = svg.querySelector("#provinces");
const R = DATA.radius;
const DISLODGED_BODY = 0.82;
const DISLODGED_RING = 1.45;
const COVER_TOLERANCE = 0.01;
const MARGIN = 0.12;

// Working copy: what the user is editing. Starts as the optimizer's answer.
let table = JSON.parse(JSON.stringify(DATA.optimized));
let mode = "after";
let showDislodged = false;
let showShipped = true;

// --- geometry, the same tests the audit runs -----------------------------

const base = (key) => (key.includes("/") ? key.slice(0, key.indexOf("/")) : key);

const shapeCache = new Map();
function shapesFor(key) {
  if (shapeCache.has(key)) return shapeCache.get(key);
  const found = [];
  if (provinceLayer) {
    for (const shape of provinceLayer.children) {
      if (typeof shape.isPointInFill !== "function") continue;
      if (shape.id === key) found.push(shape);
      else if (key === base(key) && base(shape.id) === key) found.push(shape);
    }
  }
  shapeCache.set(key, found);
  return found;
}

/* isPointInFill reads its point in the shape's own space; a layer under a
   transform needs the point carried into it. Worked out through the screen,
   which every element shares. */
const matrixCache = new Map();
function intoShape(shape) {
  if (matrixCache.has(shape)) return matrixCache.get(shape);
  let matrix = null;
  const own = shape.getScreenCTM();
  const root = svg.getScreenCTM();
  if (own && root) matrix = own.inverse().multiply(root);
  matrixCache.set(shape, matrix);
  return matrix;
}

const probe = svg.createSVGPoint();
function insideProvince(key, x, y) {
  const shapes = shapesFor(key);
  if (shapes.length === 0) return false;
  for (const shape of shapes) {
    const matrix = intoShape(shape);
    probe.x = x; probe.y = y;
    const local = matrix ? probe.matrixTransform(matrix) : probe;
    if (shape.isPointInFill(local)) return true;
  }
  return false;
}

function fitsInside(key, x, y, radius) {
  if (!insideProvince(key, x, y)) return false;
  for (let i = 0; i < 24; i++) {
    const angle = (2 * Math.PI * i) / 24;
    if (!insideProvince(key, x + Math.cos(angle) * radius, y + Math.sin(angle) * radius)) return false;
  }
  return true;
}

function coveredFraction(x, y, radius, boxes) {
  if (radius <= 0) return 0;
  const near = boxes.filter((b) => x - radius < b[0] + b[2] && b[0] < x + radius && y - radius < b[1] + b[3] && b[1] < y + radius);
  if (near.length === 0) return 0;
  // Must match coveredFraction() in geometry.ts, or the page and the report
  // disagree about the same marker.
  const steps = 15;
  const step = (radius * 2) / steps;
  const start = -radius + step / 2;
  let inside = 0, hit = 0;
  for (let i = 0; i < steps; i++) {
    for (let j = 0; j < steps; j++) {
      const dx = start + i * step, dy = start + j * step;
      if (dx * dx + dy * dy > radius * radius) continue;
      inside++;
      const px = x + dx, py = y + dy;
      if (near.some((b) => px >= b[0] && px <= b[0] + b[2] && py >= b[1] && py <= b[1] + b[3])) hit++;
    }
  }
  return inside === 0 ? 0 : hit / inside;
}

function verdictFor(key, spot) {
  /* A province too narrow for a full marker carries its own size, and every
     test has to use that size or the page and the report disagree. */
  const scale = spot.scale || 1;
  const radius = R * scale;
  const [x, y] = spot.unit;
  // A marker the placement deliberately let out over its border is not a
  // fault; the report names where it leans and why.
  const overhang = Boolean(spot.overhang);
  const outside = !overhang && !fitsInside(key, x, y, radius * (1 + MARGIN));
  const name = coveredFraction(x, y, radius, DATA.labels);
  const sc = coveredFraction(x, y, radius, DATA.supplyCentres);
  const [dx, dy] = spot.dislodged;
  return {
    scale: scale,
    overhang: overhang,
    outside: outside,
    name: name,
    sc: sc,
    coversName: name > COVER_TOLERANCE,
    coversSc: sc > COVER_TOLERANCE,
    dislodgedOutside: !overhang && !fitsInside(key, dx, dy, radius * DISLODGED_BODY * (1 + MARGIN)),
    dislodgedName: coveredFraction(dx, dy, radius * DISLODGED_RING, DATA.labels) > COVER_TOLERANCE,
  };
}

const verdicts = new Map();
function judge(key) {
  const spot = current()[key];
  if (!spot) return null;
  const verdict = verdictFor(key, spot);
  verdicts.set(key, verdict);
  return verdict;
}

function current() { return mode === "before" ? DATA.shipped : table; }

// --- drawing --------------------------------------------------------------

const overlay = document.createElementNS(NS, "g");
overlay.setAttribute("id", "placement-overlay");
svg.appendChild(overlay);

const dragLine = document.createElementNS(NS, "line");
dragLine.setAttribute("stroke", "#6ea8fe");
dragLine.setAttribute("stroke-dasharray", "6 6");
dragLine.setAttribute("stroke-width", String(Math.max(1, R * 0.12)));
dragLine.setAttribute("visibility", "hidden");
overlay.appendChild(dragLine);

const nodes = new Map();

function colourOf(verdict) {
  if (!verdict) return "#8d8d8d";
  if (verdict.outside) return "#ff5c5c";
  if (verdict.coversName) return "#ffba5c";
  return "#6ede8a";
}

function makeMarker(key, kind) {
  const group = document.createElementNS(NS, "g");
  group.setAttribute("class", "marker " + kind);
  group.dataset.key = key;
  group.dataset.kind = kind;
  group.style.cursor = "grab";

  const shipped = document.createElementNS(NS, "circle");
  shipped.setAttribute("fill", "none");
  shipped.setAttribute("stroke", "#6ea8fe");
  shipped.setAttribute("stroke-width", String(Math.max(0.8, R * 0.07)));
  shipped.setAttribute("stroke-dasharray", "3 5");
  shipped.setAttribute("class", "shippedMark");
  shipped.style.pointerEvents = "none";

  const body = document.createElementNS(NS, "circle");
  const scRing = document.createElementNS(NS, "circle");
  scRing.setAttribute("fill", "none");
  scRing.setAttribute("stroke", "#6ea8fe");
  scRing.setAttribute("stroke-dasharray", "4 4");
  scRing.setAttribute("class", "scRing");
  scRing.style.pointerEvents = "none";

  const text = document.createElementNS(NS, "text");
  text.setAttribute("text-anchor", "middle");
  text.setAttribute("dominant-baseline", "central");
  text.setAttribute("fill", "#0e1013");
  text.setAttribute("font-weight", "600");
  text.style.pointerEvents = "none";
  text.style.userSelect = "none";

  group.append(shipped, body, scRing, text);
  overlay.appendChild(group);
  return { group: group, body: body, scRing: scRing, text: text, shipped: shipped };
}

function drawAll() {
  // Deliberately not the working copy: Before shows the shipped anchors.
  const showing = current();
  for (const key of DATA.keys) {
    let node = nodes.get(key);
    if (!node) {
      node = { unit: makeMarker(key, "unit"), away: makeMarker(key, "dislodged") };
      nodes.set(key, node);
    }
    const spot = showing[key];
    const verdict = verdicts.get(key) || judge(key);
    const colour = colourOf(verdict);
    const radius = R * (spot.scale || 1);

    const u = node.unit;
    u.body.setAttribute("cx", spot.unit[0]);
    u.body.setAttribute("cy", spot.unit[1]);
    u.body.setAttribute("r", radius);
    u.body.setAttribute("fill", colour);
    u.body.setAttribute("fill-opacity", "0.75");
    u.body.setAttribute("stroke", "#0e1013");
    u.body.setAttribute("stroke-width", String(Math.max(1, radius * 0.16)));
    u.text.setAttribute("x", spot.unit[0]);
    u.text.setAttribute("y", spot.unit[1]);
    u.text.setAttribute("font-size", radius * 1.05);
    u.text.textContent = "A";
    u.scRing.setAttribute("cx", spot.unit[0]);
    u.scRing.setAttribute("cy", spot.unit[1]);
    u.scRing.setAttribute("r", radius * 1.3);
    u.scRing.setAttribute("stroke-width", String(Math.max(0.8, radius * 0.09)));
    u.scRing.setAttribute("visibility", verdict && verdict.coversSc ? "visible" : "hidden");

    const origin = DATA.shipped[key];
    u.shipped.setAttribute("visibility", showShipped && origin && mode === "after" ? "visible" : "hidden");
    if (origin) {
      u.shipped.setAttribute("cx", origin.unit[0]);
      u.shipped.setAttribute("cy", origin.unit[1]);
      u.shipped.setAttribute("r", radius * 0.5);
    }

    const a = node.away;
    a.group.setAttribute("visibility", showDislodged ? "visible" : "hidden");
    a.body.setAttribute("cx", spot.dislodged[0]);
    a.body.setAttribute("cy", spot.dislodged[1]);
    a.body.setAttribute("r", radius * DISLODGED_BODY);
    a.body.setAttribute("fill", verdict && verdict.dislodgedOutside ? "#ff5c5c" : verdict && verdict.dislodgedName ? "#ffba5c" : "#6ede8a");
    a.body.setAttribute("fill-opacity", "0.4");
    a.body.setAttribute("stroke", "#ff5c5c");
    a.body.setAttribute("stroke-width", String(Math.max(1, radius * 0.14)));
    a.text.setAttribute("x", spot.dislodged[0]);
    a.text.setAttribute("y", spot.dislodged[1]);
    a.text.setAttribute("font-size", radius * 0.8);
    a.text.textContent = "d";
    a.scRing.setAttribute("visibility", "hidden");
    a.shipped.setAttribute("visibility", "hidden");
    a.group.style.cursor = mode === "after" ? "grab" : "default";
    u.group.style.cursor = mode === "after" ? "grab" : "default";
  }
}

// --- the panel ------------------------------------------------------------

function refreshPanel() {
  const rows = [];
  let outside = 0, onName = 0, onSc = 0, clean = 0, dislodgedBad = 0;
  for (const key of DATA.keys) {
    const v = verdicts.get(key) || judge(key);
    if (!v) continue;
    if (v.outside) outside++;
    if (v.coversName) onName++;
    if (v.coversSc) onSc++;
    if (v.dislodgedOutside || v.dislodgedName) dislodgedBad++;
    const bad = v.outside || v.coversName || v.dislodgedOutside || v.dislodgedName;
    if (!bad) clean++;
    if (!bad && !v.coversSc && v.scale >= 1 && !v.overhang) continue;
    const why = [];
    if (v.outside) why.push(["bad", "leaves its province"]);
    if (v.coversName) why.push(["warn", "covers a name (" + Math.round(v.name * 100) + "%)"]);
    if (v.coversSc) why.push(["", "on a supply centre"]);
    if (v.scale < 1) why.push(["", "marker at " + v.scale.toFixed(2) + "x"]);
    if (v.overhang) why.push(["", "allowed to overhang"]);
    if (v.dislodgedOutside) why.push(["bad", "dislodged outside"]);
    else if (v.dislodgedName) why.push(["warn", "dislodged on a name"]);
    rows.push({ key: key, why: why, rank: (v.outside ? 0 : v.coversName ? 1 : 2) });
  }
  rows.sort((a, b) => a.rank - b.rank || a.key.localeCompare(b.key));

  const tally = document.getElementById("tally");
  const moved = DATA.keys.filter((k) => {
    const a = table[k], b = DATA.optimized[k];
    return a && b && (a.unit[0] !== b.unit[0] || a.unit[1] !== b.unit[1] || a.dislodged[0] !== b.dislodged[0] || a.dislodged[1] !== b.dislodged[1]);
  }).length;
  tally.innerHTML =
    "<span>provinces</span><b>" + DATA.keys.length + "</b>" +
    "<span>clean</span><b>" + clean + "</b>" +
    "<span>outside its province</span><b>" + outside + "</b>" +
    "<span>covers a name</span><b>" + onName + "</b>" +
    "<span>on a supply centre</span><b>" + onSc + "</b>" +
    "<span>dislodged with a problem</span><b>" + dislodgedBad + "</b>" +
    "<span class='moved'>moved by hand</span><b class='moved'>" + moved + "</b>";

  const list = document.getElementById("problems");
  list.replaceChildren();
  for (const row of rows) {
    const li = document.createElement("li");
    const key = document.createElement("span");
    key.className = "key";
    key.textContent = row.key;
    li.appendChild(key);
    const why = document.createElement("span");
    why.className = "why " + (row.why[0] ? row.why[0][0] : "");
    why.textContent = row.why.map((w) => w[1]).join(", ");
    li.appendChild(why);
    li.addEventListener("click", () => flash(row.key));
    list.appendChild(li);
  }
  if (rows.length === 0) {
    const li = document.createElement("li");
    li.textContent = "Nothing left to fix.";
    list.appendChild(li);
  }
}

function flash(key) {
  const node = nodes.get(key);
  if (!node) return;
  const spot = current()[key];
  centreOn(spot.unit[0], spot.unit[1]);
  const ring = document.createElementNS(NS, "circle");
  ring.setAttribute("cx", spot.unit[0]);
  ring.setAttribute("cy", spot.unit[1]);
  ring.setAttribute("r", R * 2.6);
  ring.setAttribute("fill", "none");
  ring.setAttribute("stroke", "#6ea8fe");
  ring.setAttribute("stroke-width", String(Math.max(1.5, R * 0.2)));
  overlay.appendChild(ring);
  setTimeout(() => ring.remove(), 900);
}

// --- view: pan and zoom ---------------------------------------------------

const box = DATA.viewBox;
let view = { x: box.x, y: box.y, w: box.w, h: box.h };

function applyView() {
  const rect = stage.getBoundingClientRect();
  const aspect = rect.height / rect.width || box.h / box.w;
  view.h = view.w * aspect;
  svg.setAttribute("viewBox", view.x + " " + view.y + " " + view.w + " " + view.h);
}

function centreOn(x, y) {
  view.x = x - view.w / 2;
  view.y = y - view.h / 2;
  applyView();
}

function resetView() {
  const rect = stage.getBoundingClientRect();
  const aspect = rect.height / rect.width || box.h / box.w;
  view.w = Math.max(box.w, box.h / aspect);
  view.x = box.x + (box.w - view.w) / 2;
  view.y = box.y;
  applyView();
  view.y = box.y + (box.h - view.h) / 2;
  applyView();
}

function toMap(clientX, clientY) {
  const ctm = svg.getScreenCTM().inverse();
  probe.x = clientX; probe.y = clientY;
  return probe.matrixTransform(ctm);
}

stage.addEventListener("wheel", (event) => {
  event.preventDefault();
  const at = toMap(event.clientX, event.clientY);
  const factor = event.deltaY > 0 ? 1.15 : 1 / 1.15;
  const next = Math.min(box.w * 2, Math.max(box.w / 40, view.w * factor));
  const scale = next / view.w;
  view.x = at.x - (at.x - view.x) * scale;
  view.y = at.y - (at.y - view.y) * scale;
  view.w = next;
  applyView();
}, { passive: false });

// --- dragging -------------------------------------------------------------

let drag = null;

svg.addEventListener("pointerdown", (event) => {
  const marker = event.target.closest ? event.target.closest(".marker") : null;
  if (marker && mode === "after") {
    const key = marker.dataset.key;
    const kind = marker.dataset.kind;
    const spot = table[key];
    const from = kind === "unit" ? spot.unit : spot.dislodged;
    drag = { key: key, kind: kind, from: [from[0], from[1]] };
    marker.style.cursor = "grabbing";
    dragLine.setAttribute("x1", from[0]);
    dragLine.setAttribute("y1", from[1]);
    dragLine.setAttribute("x2", from[0]);
    dragLine.setAttribute("y2", from[1]);
    dragLine.setAttribute("visibility", "visible");
    capture(event.pointerId);
    event.preventDefault();
    return;
  }
  // Anywhere else on the map is a pan.
  const start = toMap(event.clientX, event.clientY);
  drag = { pan: true, from: [start.x, start.y], view: { x: view.x, y: view.y } };
  capture(event.pointerId);
});

/* Capture keeps a drag alive when the pointer runs off the marker, which it
   always does. A pointer the browser will not give up — a synthetic event, an
   odd device — must not take the drag down with it. */
function capture(pointerId) {
  try { svg.setPointerCapture(pointerId); } catch (err) { /* drag still works */ }
}

svg.addEventListener("pointermove", (event) => {
  if (!drag) return;
  const at = toMap(event.clientX, event.clientY);
  if (drag.pan) {
    view.x = drag.view.x - (at.x - drag.from[0]);
    view.y = drag.view.y - (at.y - drag.from[1]);
    applyView();
    return;
  }
  const spot = table[drag.key];
  const point = [round(at.x), round(at.y)];
  if (drag.kind === "unit") {
    // The dislodged marker rides along, so its offset from its own unit is
    // kept unless the user moves it too.
    const dx = spot.dislodged[0] - spot.unit[0];
    const dy = spot.dislodged[1] - spot.unit[1];
    spot.unit = point;
    spot.dislodged = [round(point[0] + dx), round(point[1] + dy)];
  } else {
    spot.dislodged = point;
  }
  dragLine.setAttribute("x2", point[0]);
  dragLine.setAttribute("y2", point[1]);
  judge(drag.key);
  drawAll();
  refreshPanel();
});

function endDrag(event) {
  if (!drag) return;
  if (!drag.pan) {
    dragLine.setAttribute("visibility", "hidden");
    judge(drag.key);
    drawAll();
    refreshPanel();
  }
  try { svg.releasePointerCapture(event.pointerId); } catch (err) { /* already gone */ }
  drag = null;
}
svg.addEventListener("pointerup", endDrag);
svg.addEventListener("pointercancel", endDrag);

function round(value) { return Math.round(value * 100) / 100; }

// --- controls -------------------------------------------------------------

function setMode(next) {
  mode = next;
  document.getElementById("showBefore").classList.toggle("on", next === "before");
  document.getElementById("showAfter").classList.toggle("on", next === "after");
  document.getElementById("hint").textContent =
    next === "before"
      ? "Showing the anchors the map ships. Switch to After to edit."
      : "Drag a marker to move it. Wheel to zoom, drag the map to pan.";
  verdicts.clear();
  for (const key of DATA.keys) judge(key);
  drawAll();
  refreshPanel();
}

document.getElementById("showBefore").addEventListener("click", () => setMode("before"));
document.getElementById("showAfter").addEventListener("click", () => setMode("after"));
document.getElementById("showDislodged").addEventListener("change", (event) => {
  showDislodged = event.target.checked;
  drawAll();
});
document.getElementById("showShipped").addEventListener("change", (event) => {
  showShipped = event.target.checked;
  drawAll();
});
document.getElementById("reset").addEventListener("click", resetView);
document.getElementById("revert").addEventListener("click", () => {
  table = JSON.parse(JSON.stringify(DATA.optimized));
  setMode("after");
});

const dialog = document.getElementById("exportBox");
document.getElementById("export").addEventListener("click", () => {
  const out = {};
  for (const key of DATA.keys) {
    const spot = table[key];
    out[key] = { unit: spot.unit, scale: spot.scale || 1, dislodged: spot.dislodged };
    if (spot.overhang) out[key].overhang = spot.overhang;
  }
  document.getElementById("exportText").value = JSON.stringify(out, null, 2);
  document.getElementById("copied").textContent = "";
  dialog.showModal();
});
document.getElementById("closeExport").addEventListener("click", () => dialog.close());
document.getElementById("copy").addEventListener("click", async () => {
  const field = document.getElementById("exportText");
  field.select();
  let ok = false;
  try {
    await navigator.clipboard.writeText(field.value);
    ok = true;
  } catch (err) {
    // A file:// page is often refused the clipboard, so fall back to the old
    // command, and to "it is selected, press Ctrl+C" if that fails as well.
    try { ok = document.execCommand("copy"); } catch (err2) { ok = false; }
  }
  document.getElementById("copied").textContent = ok ? "Copied." : "Selected — press Ctrl+C.";
});

window.addEventListener("resize", applyView);

resetView();
for (const key of DATA.keys) judge(key);
drawAll();
refreshPanel();
`;
