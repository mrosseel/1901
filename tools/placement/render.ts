/*
The before-and-after picture.

Both boards are drawn on one page and shot once, so the two halves are
guaranteed to be the same map at the same scale — a pair of separate
screenshots stitched afterwards is one resize away from lying.

A marker is drawn the way board.ts draws one: a circle of the same radius with
the same letter in it. What is added is the colour, which is the audit's
verdict rather than a power's identity — red for a marker that has left its
province, amber for one sitting on a name, green for one that is clean. The
point of the image is to see the verdict, not to look like a game in progress.
*/

import type { Page } from "playwright-core";
import type { PlacementTable, Violation } from "./audit.ts";

export interface Panel {
  title: string;
  subtitle: string;
  table: PlacementTable;
  violations: Violation[];
}

export interface RenderOptions {
  svgText: string;
  radius: number;
  left: Panel;
  right: Panel;
  /** Rendered width of each map, in CSS pixels. */
  width: number;
}

export async function renderComparison(page: Page, options: RenderOptions, outPath: string): Promise<void> {
  await page.setContent(shell(options), { waitUntil: "load" });
  await page.evaluate(draw, {
    radius: options.radius,
    left: { table: options.left.table, violations: options.left.violations },
    right: { table: options.right.table, violations: options.right.violations },
  });
  await page.waitForTimeout(250);
  const board = await page.$("#sheet");
  if (!board) throw new Error("the comparison sheet did not render");
  await board.screenshot({ path: outPath });
}

/* What the three marker colours mean, said once under each map. */
const LEGEND =
  '<div class="legend">' +
  '<span><i style="background:#6ede8a"></i>inside its province, clear of the names</span>' +
  '<span><i style="background:#ffba5c"></i>covers a name</span>' +
  '<span><i style="background:#ff5c5c"></i>not inside its province</span>' +
  "</div>";

function shell(options: RenderOptions): string {
  const panel = (id: string, side: Panel) =>
    '<figure class="panel"><figcaption><b>' +
    escapeHtml(side.title) +
    "</b><span>" +
    escapeHtml(side.subtitle) +
    '</span></figcaption><div class="map" id="' +
    id +
    '">' +
    options.svgText +
    "</div>" +
    LEGEND +
    "</figure>";

  return (
    "<!doctype html><html><head><meta charset='utf-8'><style>" +
    "*{box-sizing:border-box}" +
    "body{margin:0;background:#14161a;color:#e6e8ec;font:14px/1.4 system-ui,sans-serif}" +
    "#sheet{display:flex;gap:14px;padding:14px;width:" +
    (options.width * 2 + 42) +
    "px}" +
    ".panel{margin:0;flex:1 1 0;min-width:0}" +
    "figcaption{display:flex;flex-direction:column;gap:2px;padding:0 0 8px}" +
    "figcaption b{font-size:16px}" +
    "figcaption span{color:#9aa3b2;font-size:13px;font-variant-numeric:tabular-nums}" +
    ".map{background:#0e1013;border:1px solid #363c46;border-radius:8px;overflow:hidden}" +
    ".map svg{display:block;width:100%;height:auto}" +
    ".legend{display:flex;gap:16px;color:#9aa3b2;font-size:12px;padding:8px 0 0}" +
    ".legend i{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:6px;vertical-align:middle}" +
    "</style></head><body><div id='sheet'>" +
    panel("left", options.left) +
    panel("right", options.right) +
    "</div></body></html>"
  );
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (ch) =>
    ch === "&" ? "&amp;" : ch === "<" ? "&lt;" : ch === ">" ? "&gt;" : "&quot;",
  );
}

/*
Runs in the page: puts a marker on every province of both maps.

Drawing a unit in EVERY province at once is the whole trick of this picture.
A real game has a dozen units and hides the problem; a board with one marker
per province shows every anchor's verdict in one look.
*/
function draw(input: {
  radius: number;
  left: { table: PlacementTable; violations: Violation[] };
  right: { table: PlacementTable; violations: Violation[] };
}): void {
  const NS = "http://www.w3.org/2000/svg";
  const paint = (
    hostId: string,
    table: PlacementTable,
    violations: Violation[],
    radius: number,
  ) => {
    const svg = document.querySelector("#" + hostId + " svg") as SVGSVGElement;
    if (!svg) return;
    const verdicts = new Map(violations.map((v) => [v.key, v]));

    const layer = document.createElementNS(NS, "g");
    layer.setAttribute("id", "placement-overlay");

    for (const key of Object.keys(table)) {
      const spot = table[key];
      // A province too narrow for a full marker carries its own size; drawing
      // it full size here would make the picture lie about the placement.
      const r = radius * (spot.scale || 1);
      const verdict = verdicts.get(key);
      const outside = Boolean(verdict && (verdict.outside || verdict.missingShape));
      const onName = Boolean(verdict && verdict.coversName);
      const colour = outside ? "#ff5c5c" : onName ? "#ffba5c" : "#6ede8a";

      const circle = document.createElementNS(NS, "circle");
      circle.setAttribute("cx", String(spot.unit[0]));
      circle.setAttribute("cy", String(spot.unit[1]));
      circle.setAttribute("r", String(r));
      circle.setAttribute("fill", colour);
      circle.setAttribute("fill-opacity", "0.72");
      circle.setAttribute("stroke", "#0e1013");
      circle.setAttribute("stroke-width", String(Math.max(1, r * 0.16)));
      layer.appendChild(circle);

      const text = document.createElementNS(NS, "text");
      text.setAttribute("x", String(spot.unit[0]));
      text.setAttribute("y", String(spot.unit[1]));
      text.setAttribute("font-size", String(r * 1.1));
      text.setAttribute("text-anchor", "middle");
      text.setAttribute("dominant-baseline", "central");
      text.setAttribute("fill", "#0e1013");
      text.setAttribute("font-family", "system-ui, sans-serif");
      text.setAttribute("font-weight", "600");
      text.textContent = "A";
      layer.appendChild(text);
    }
    svg.appendChild(layer);
  };

  paint("left", input.left.table, input.left.violations, input.radius);
  paint("right", input.right.table, input.right.violations, input.radius);
}
