/*
The map editor (D-030).

A variant's placement table used to be corrected in a standalone HTML file the
tool generated per variant — 26 pages, each a snapshot of the map at the moment
the tool ran, none of them the board. This is the same job on the board itself:
pick a variant, drag the three markers a province has, watch the violation
count move, and take the amended table away.

The convergence goal is the reason the drag log exists and is exported beside
the table. Every hand drag is a scoring bug: the optimizer put a marker
somewhere and a person disagreed, so there is a rule it does not know. The log
records the move with the count either side of it, and the end state of this
screen is an audit viewer whose drag count is zero.

D-017 holds here as everywhere: the board never enters the React tree. React
draws the panel, mounts the island once, and reaches the SVG for exactly one
thing the island does not offer — the drag handles, which live in their own
layer and are addressed in map units, so pan and zoom carry them along.
*/

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { mount } from "../board/board";
import { emptyPlan } from "../board/phases";
import { setProvinceNames } from "../board/provinces";
import type { BoardHandle, BoardState, Unit } from "../board/types";
import { normalizeVariant, type Variant } from "../variants";
import { standardRadius } from "../../../tools/placement/geometry.ts";
import {
  shippedPlacement,
  type MapGeometry,
  type PlacementTable,
  type TerrainKind,
} from "../../../tools/placement/rules.ts";
import { createGeometry, type MeasuredMap } from "./measure";
import {
  countByProvince,
  scorePlacements,
  type Field,
  type Geometry,
  type Violation,
} from "./violations";
import {
  buildBundle,
  changedNames,
  dragsFile,
  namesFile,
  placementFile,
  type DragRecord,
} from "./bundle";
import "../board/board.css";
import "./mapeditor.css";

const SVG_NS = "http://www.w3.org/2000/svg";
const HANDLE_LAYER = "editor-handles";
/** How big a grab target is, in CSS pixels, whatever the zoom. */
const HANDLE_PIXELS = 7;

const FIELDS: Field[] = ["unit", "dislodged", "brief"];
const FIELD_INK: Record<Field, string> = {
  unit: "#6ea8fe",
  dislodged: "#ff8b8b",
  brief: "#6ede8a",
};

interface Loaded {
  key: string;
  geometry: MeasuredMap;
  map: MapGeometry;
  terrain: TerrainKind;
  radius: number;
  names: Record<string, string>;
  table: PlacementTable;
}

async function getJSON<T>(url: string): Promise<T> {
  const answer = await fetch(url, { headers: { Accept: "application/json" } });
  if (!answer.ok) throw new Error(url + " answered " + answer.status);
  return (await answer.json()) as T;
}

/*
The containment tests, remembered.

Scoring a whole table asks the SVG engine whether some six thousand points are
inside some path, and a drag asks for that between two frames. All but one
province's answers are the same as they were a frame ago, so they are cached
on the position they were asked about; the dragged province is dropped from
the cache as it moves. Without this the count lags the finger by a second.
*/
function memoGeometry(geom: Geometry): Geometry & { forget(key: string): void } {
  const discs = new Map<string, boolean>();
  const boxes = new Map<string, boolean>();
  const stamp = (parts: Array<string | number>) => parts.join("|");
  return {
    insideDisc(key, centre, radius) {
      const id = stamp([key, centre.x, centre.y, radius]);
      const held = discs.get(id);
      if (held !== undefined) return held;
      const answer = geom.insideDisc(key, centre, radius);
      discs.set(id, answer);
      return answer;
    },
    insideBox(key, centre, halfW, halfH) {
      const id = stamp([key, centre.x, centre.y, halfW, halfH]);
      const held = boxes.get(id);
      if (held !== undefined) return held;
      const answer = geom.insideBox(key, centre, halfW, halfH);
      boxes.set(id, answer);
      return answer;
    },
    briefSize: (key, fontSize) => geom.briefSize(key, fontSize),
    forget(key) {
      for (const id of Array.from(discs.keys())) if (id.startsWith(key + "|")) discs.delete(id);
      for (const id of Array.from(boxes.keys())) if (id.startsWith(key + "|")) boxes.delete(id);
    },
  };
}

/*
A board state that puts a piece in every province.

The editor is not showing a game — there is no game — but the board draws
markers from units, so a unit is invented for every province the table
mentions. Its type follows the terrain, so a coast shows the triangle a fleet
would stand there as, and the picture is the one a player will actually see.
*/
function boardState(
  table: PlacementTable,
  terrain: TerrainKind,
  nation: string,
  showUnits: boolean,
  showDislodged: boolean,
): BoardState {
  const units: Record<string, Unit> = {};
  for (const key of Object.keys(table)) {
    const base = key.includes("/") ? key.slice(0, key.indexOf("/")) : key;
    const sea = terrain[base] === "sea" || key !== base;
    units[key] = { type: sea ? "fleet" : "army", nation: nation };
  }
  return {
    placements: table,
    units: showUnits ? units : {},
    dislodged: showDislodged ? units : {},
  };
}

/** The position one field of one province currently holds. */
function positionOf(table: PlacementTable, key: string, field: Field): [number, number] | null {
  const placed = table[key];
  if (!placed) return null;
  if (field === "unit") return placed.unit;
  if (field === "dislodged") return placed.dislodged;
  return placed.brief || null;
}

function withPosition(
  table: PlacementTable,
  key: string,
  field: Field,
  to: [number, number],
): PlacementTable {
  const placed = table[key];
  if (!placed) return table;
  const next = { ...placed };
  if (field === "unit") next.unit = to;
  else if (field === "dislodged") next.dislodged = to;
  else next.brief = to;
  return { ...table, [key]: next };
}

function download(name: string, body: string): void {
  const url = URL.createObjectURL(new Blob([body], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

export function MapEditorPage() {
  const [variants, setVariants] = useState<Variant[]>([]);
  const [key, setKey] = useState("");
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [table, setTable] = useState<PlacementTable>({});
  const [nameEdits, setNameEdits] = useState<Record<string, string>>({});
  const [drags, setDrags] = useState<DragRecord[]>([]);
  const [violations, setViolations] = useState<Violation[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [fields, setFields] = useState<Field[]>(["unit"]);
  const [showUnits, setShowUnits] = useState(true);
  const [showDislodged, setShowDislodged] = useState(false);
  const [showBrief, setShowBrief] = useState(true);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");

  const host = useRef<HTMLDivElement | null>(null);
  const board = useRef<BoardHandle | null>(null);
  const memo = useRef<(Geometry & { forget(key: string): void }) | null>(null);
  /* The drag's own copy of the table. React state is a frame behind a
     pointermove, and the handle has to follow the finger, not the render. */
  const live = useRef<PlacementTable>({});
  /*
  What the drag reads instead of closing over it.

  A pointer gesture outlives many renders — the count changes on every frame
  of it — and an effect that depended on those would rebind its listeners
  mid-drag and drop the gesture it was in the middle of. So the drag effect
  depends on the loaded variant and nothing else, and reaches the current
  scorer, the current redraw and the current count through this box.
  */
  const now = useRef({ score: (_next: PlacementTable) => [] as Violation[], draw: () => {}, count: 0 });

  useEffect(() => {
    getJSON<Array<Partial<Variant>>>("/variants")
      .then((raw) => {
        const list = raw.map(normalizeVariant).filter((one) => one.key);
        setVariants(list);
        setKey((held) => held || list[0]?.key || "");
      })
      .catch((err) => setError(String(err)));
  }, []);

  // --- loading one variant --------------------------------------------------
  useEffect(() => {
    if (!key) return;
    let dropped = false;
    let geometry: MeasuredMap | null = null;
    setLoaded(null);
    setStatus("measuring " + key + "…");
    setError("");

    const load = async () => {
      const mapUrl = "/variants/" + encodeURIComponent(key) + "/map.svg";
      const answer = await fetch(mapUrl);
      if (!answer.ok) throw new Error("no map for " + key);
      const svgText = await answer.text();
      const provinces = await getJSON<Array<{ key: string; type: string }>>(
        "/variants/" + encodeURIComponent(key) + "/provinces.json",
      );
      const terrain: TerrainKind = {};
      for (const one of provinces) {
        terrain[one.key] = one.type === "sea" ? "sea" : one.type === "land" ? "land" : "unknown";
      }
      const names = await getJSON<Record<string, string>>(
        "/variants/" + encodeURIComponent(key) + "/names.json",
      );
      const served = await getJSON<PlacementTable | null>(
        "/variants/" + encodeURIComponent(key) + "/placement.json",
      );
      if (dropped) return;
      geometry = createGeometry(svgText, terrain);
      const radius = standardRadius(geometry.map.viewBox);
      /* A variant with no approved table starts on the map's own anchors,
         which is exactly what its board draws today. */
      const start = served && Object.keys(served).length
        ? served
        : shippedPlacement(geometry.map, radius);
      if (dropped) {
        geometry.destroy();
        return;
      }
      setLoaded({
        key: key,
        geometry: geometry,
        map: geometry.map,
        terrain: terrain,
        radius: radius,
        names: names,
        table: start,
      });
      setTable(start);
      live.current = start;
      setNameEdits({});
      setDrags([]);
      setSelected(null);
      memo.current = memoGeometry(geometry);
      setProvinceNames(names);
      setStatus("");
    };

    load().catch((err) => {
      if (!dropped) setError(String(err));
    });
    return () => {
      dropped = true;
      geometry?.destroy();
    };
  }, [key]);

  // --- scoring --------------------------------------------------------------
  const score = useCallback(
    (next: PlacementTable): Violation[] => {
      if (!loaded || !memo.current) return [];
      return scorePlacements(loaded.map, next, loaded.radius, memo.current);
    },
    [loaded],
  );

  useEffect(() => {
    if (!loaded) return;
    setViolations(score(loaded.table));
  }, [loaded, score]);

  const counts = useMemo(() => countByProvince(violations), [violations]);

  // --- the board island -----------------------------------------------------
  useEffect(() => {
    if (!loaded || !host.current) return;
    const handle = mount(
      host.current,
      {
        mapUrl: "/variants/" + encodeURIComponent(loaded.key) + "/map.svg",
        // There is no game here, so there is nothing to order and nothing to
        // ask about. The island's order paths are simply never reached.
        options: () => Promise.resolve({}),
        order: () => Promise.reject(new Error("the map editor has no game")),
      },
      {
        status: () => undefined,
        builder: () => undefined,
        state: () => undefined,
        select: () => undefined,
        canOrder: () => false,
        refusal: () => "the map editor has no game",
      },
    );
    board.current = handle;
    handle.ready.catch((err) => setError(String(err)));
    return () => {
      board.current = null;
      handle.destroy();
    };
  }, [loaded]);

  const state = useMemo(
    () =>
      loaded
        ? boardState(table, loaded.terrain, variants.find((v) => v.key === loaded.key)?.powers[0] || "Editor", showUnits, showDislodged)
        : null,
    [loaded, table, variants, showUnits, showDislodged],
  );

  useEffect(() => {
    if (!board.current || !state) return;
    board.current.setBriefLabels(showBrief);
    board.current.update(state, emptyPlan(""));
  }, [state, showBrief]);

  // --- the drag handles -----------------------------------------------------
  /*
  One layer of grab targets, in map units, appended to the island's own SVG.

  Map units are the whole trick: the board pans and zooms by rewriting the
  SVG's viewBox and transforms nothing, so a child written in map coordinates
  follows the map for free. Only the RADIUS has to be revised as the zoom
  changes, because a grab target is a fact about fingers and stays the same
  size on screen.
  */
  const drawHandles = useCallback(() => {
    const svg = host.current?.querySelector("svg");
    const view = board.current?.debug.view();
    if (!svg || !view || !loaded) return;
    const width = host.current?.getBoundingClientRect().width || 1;
    const grab = HANDLE_PIXELS * (view.w / width);

    let layer = svg.querySelector<SVGGElement>("#" + HANDLE_LAYER);
    if (!layer) {
      layer = document.createElementNS(SVG_NS, "g");
      layer.id = HANDLE_LAYER;
    }
    // Last child, so a handle is never buried under a marker it moves.
    if (layer.parentNode !== svg || svg.lastChild !== layer) svg.appendChild(layer);
    layer.replaceChildren();

    for (const province of Object.keys(live.current)) {
      for (const field of fields) {
        const at = positionOf(live.current, province, field);
        if (!at) continue;
        const dot = document.createElementNS(SVG_NS, "circle");
        dot.setAttribute("cx", String(at[0]));
        dot.setAttribute("cy", String(at[1]));
        dot.setAttribute("r", String(grab));
        dot.setAttribute("class", "editor-handle" + (counts.get(province) ? " at-fault" : ""));
        dot.setAttribute("stroke", FIELD_INK[field]);
        dot.setAttribute("stroke-width", String(grab * 0.28));
        dot.dataset.province = province;
        dot.dataset.field = field;
        layer.appendChild(dot);
      }
    }
  }, [fields, counts, loaded]);

  useEffect(() => {
    drawHandles();
  }, [drawHandles, table, state]);

  /*
  The zoom is the island's own business and it reports no changes, so the
  handles watch for one instead: a frame that finds a different view redraws
  them at the size that view asks for. It costs one object comparison a frame
  and it is the only way to stay the same size on screen without asking the
  island for a callback it does not have.
  */
  useEffect(() => {
    if (!loaded) return;
    let frame = 0;
    let last = "";
    const tick = () => {
      const view = board.current?.debug.view();
      const stamp = view ? [view.x, view.y, view.w, view.h].join(",") : "";
      if (stamp && stamp !== last) {
        last = stamp;
        drawHandles();
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [loaded, drawHandles]);

  now.current = { score: score, draw: drawHandles, count: violations.length };

  // --- dragging -------------------------------------------------------------
  useEffect(() => {
    const pane = host.current;
    if (!pane || !loaded) return;

    let dragging: { province: string; field: Field; from: [number, number]; before: number } | null =
      null;
    let pending = 0;

    /*
    The listeners go on the pane, in the CAPTURE phase, and that is not a
    detail.

    They cannot go on the SVG: the island injects it after its own fetch, so
    at the moment this effect runs there is nothing to bind to. And they
    cannot bubble: the island binds its pan gesture to this same pane, it
    bound it first, and a bubbling handler cannot stop a listener that has
    already run. Capturing puts this one ahead of it, so stopPropagation here
    means a drag on a handle never reaches the pan.
    */
    const toMap = (event: PointerEvent): [number, number] | null => {
      const svg = pane.querySelector("svg") as SVGSVGElement | null;
      const ctm = svg?.getScreenCTM();
      if (!svg || !ctm) return null;
      const probe = svg.createSVGPoint();
      probe.x = event.clientX;
      probe.y = event.clientY;
      const at = probe.matrixTransform(ctm.inverse());
      return [at.x, at.y];
    };

    const down = (event: PointerEvent) => {
      const dot = event.target as SVGElement;
      const province = dot.dataset?.province;
      const field = dot.dataset?.field as Field | undefined;
      if (!province || !field) return;
      // The island pans on any pointerdown it sees. It must not see this one.
      event.stopPropagation();
      event.preventDefault();
      const from = positionOf(live.current, province, field);
      if (!from) return;
      dragging = { province: province, field: field, from: from, before: now.current.count };
      setSelected(province);
      dot.setPointerCapture?.(event.pointerId);
    };

    const move = (event: PointerEvent) => {
      if (!dragging) return;
      event.stopPropagation();
      const to = toMap(event);
      if (!to) return;
      live.current = withPosition(live.current, dragging.province, dragging.field, to);
      memo.current?.forget(dragging.province);
      now.current.draw();
      if (pending) return;
      // One recompute a frame. The finger outruns the scorer otherwise, and
      // every skipped frame's answer is stale the moment it lands.
      pending = requestAnimationFrame(() => {
        pending = 0;
        setTable(live.current);
        setViolations(now.current.score(live.current));
      });
    };

    const up = (event: PointerEvent) => {
      if (!dragging) return;
      event.stopPropagation();
      const held = dragging;
      dragging = null;
      if (pending) {
        cancelAnimationFrame(pending);
        pending = 0;
      }
      const to = positionOf(live.current, held.province, held.field);
      if (!to || (to[0] === held.from[0] && to[1] === held.from[1])) return;
      const after = now.current.score(live.current);
      setTable(live.current);
      setViolations(after);
      setDrags((held0) => [
        ...held0,
        {
          province: held.province,
          field: held.field,
          from: held.from,
          to: to,
          violationsBefore: held.before,
          violationsAfter: after.length,
        },
      ]);
    };

    const kinds: Array<[string, (event: PointerEvent) => void]> = [
      ["pointerdown", down],
      ["pointermove", move],
      ["pointerup", up],
      ["pointercancel", up],
    ];
    kinds.forEach(([kind, handler]) => pane.addEventListener(kind, handler as EventListener, true));
    return () => {
      kinds.forEach(([kind, handler]) =>
        pane.removeEventListener(kind, handler as EventListener, true),
      );
      if (pending) cancelAnimationFrame(pending);
    };
  }, [loaded]);

  // --- export ---------------------------------------------------------------
  const overrides = useMemo(
    () => (loaded ? changedNames(loaded.names, nameEdits) : {}),
    [loaded, nameEdits],
  );

  const saveToDisk = async () => {
    if (!loaded) return;
    setStatus("saving…");
    try {
      const answer = await fetch("/mapeditor/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildBundle(loaded.key, table, overrides, drags)),
      });
      const body = (await answer.json()) as { written?: string[]; error?: string };
      if (!answer.ok) throw new Error(body.error || "the server refused the save");
      setStatus("wrote " + (body.written || []).join(", "));
    } catch (err) {
      setError(String(err));
      setStatus("");
    }
  };

  const chosen = selected ? table[selected] : null;
  const shown = violations.slice(0, 200);

  return (
    <div className="mapeditor">
      <main className="map-pane">
        <div className="board-host" ref={host} />
      </main>
      <aside className="side">
        <header className="page-head">
          <h1>Map editor</h1>
          <span className={violations.length ? "count bad" : "count good"}>
            {violations.length} violation{violations.length === 1 ? "" : "s"}
          </span>
        </header>

        <label className="field">
          <span>Variant</span>
          <select value={key} onChange={(event) => setKey(event.target.value)}>
            {variants.map((one) => (
              <option key={one.key} value={one.key}>
                {one.name}
                {one.supported ? " ✓" : ""}
              </option>
            ))}
          </select>
        </label>

        <div className="row">
          {FIELDS.map((field) => (
            <label key={field} className="field inline">
              <input
                type="checkbox"
                checked={fields.includes(field)}
                onChange={(event) =>
                  setFields((held) =>
                    event.target.checked
                      ? [...held, field]
                      : held.filter((one) => one !== field),
                  )
                }
              />
              <span style={{ color: FIELD_INK[field] }}>{field}</span>
            </label>
          ))}
        </div>

        <div className="row">
          <label className="field inline">
            <input
              type="checkbox"
              checked={showUnits}
              onChange={(event) => setShowUnits(event.target.checked)}
            />
            <span>draw units</span>
          </label>
          <label className="field inline">
            <input
              type="checkbox"
              checked={showDislodged}
              onChange={(event) => setShowDislodged(event.target.checked)}
            />
            <span>draw dislodged</span>
          </label>
          <label className="field inline">
            <input
              type="checkbox"
              checked={showBrief}
              onChange={(event) => setShowBrief(event.target.checked)}
            />
            <span>draw codes</span>
          </label>
        </div>

        {error ? <p className="error">{error}</p> : null}
        {status ? <p className="notice">{status}</p> : null}

        {selected && chosen ? (
          <section className="card chosen">
            <h2>{selected}</h2>
            <label className="field">
              <span>Display name</span>
              <input
                value={nameEdits[selected] ?? loaded?.names[selected] ?? ""}
                onChange={(event) =>
                  setNameEdits((held) => ({ ...held, [selected]: event.target.value }))
                }
              />
            </label>
            <p className="note">
              unit {chosen.unit[0].toFixed(2)}, {chosen.unit[1].toFixed(2)} · scale{" "}
              {chosen.scale}
            </p>
          </section>
        ) : null}

        <section className="violations">
          <h2>
            Violations{" "}
            <span className="muted">
              {drags.length} drag{drags.length === 1 ? "" : "s"} logged
            </span>
          </h2>
          {violations.length === 0 && loaded ? (
            <p className="notice">Nothing to fix. This table passes the audit.</p>
          ) : null}
          <ul>
            {shown.map((one) => (
              <li
                key={one.key + one.field + one.rule}
                className={selected === one.key ? "chosen" : ""}
                onClick={() => setSelected(one.key)}
              >
                <b>{one.key}</b> <i>{one.field}</i> <em>{one.rule}</em>
                <small>{one.detail}</small>
              </li>
            ))}
          </ul>
          {violations.length > shown.length ? (
            <p className="note">…and {violations.length - shown.length} more.</p>
          ) : null}
        </section>

        <section className="buttons">
          <button onClick={() => download(key + ".json", placementFile(table))}>
            Placements
          </button>
          <button onClick={() => download(key + ".names.json", namesFile(overrides))}>
            Names
          </button>
          <button onClick={() => download(key + ".drags.json", dragsFile(drags))}>
            Drag log
          </button>
          <button
            onClick={() => {
              navigator.clipboard?.writeText(placementFile(table));
              setStatus("placements copied");
            }}
          >
            Copy
          </button>
          {import.meta.env.DEV ? (
            <button className="primary" onClick={saveToDisk}>
              Save to disk
            </button>
          ) : null}
        </section>
      </aside>
    </div>
  );
}
