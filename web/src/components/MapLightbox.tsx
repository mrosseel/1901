import { useCallback, useEffect, useRef, useState } from "react";
import { MAX_ZOOM, centredView, pannedView, zoomedView, type Box } from "../board/viewbox";

/*
The gallery's map, big.

A card's preview is a postage stamp of a map that is often 7000 units wide, so
the one thing anyone wants from it is a closer look. This is that look and
nothing else: no orders, no state, no province hit testing — only pan, zoom,
and four ways out.

The map is an <img> pointing at the same URL the card already drew, so opening
this costs no download: the browser answers the second request from its cache.
An inline copy of the SVG would be sharper at high zoom and would also bring
the map's own stylesheet into the page, which is a price a preview should not
pay.

Pan and zoom go through board/viewbox.ts — the same arithmetic the board uses,
so the clamps behave the same way — and the view it computes is turned into
one CSS transform at the end.
*/

/** Below this the swipe-down is a dismissal rather than a pan. */
const SWIPE_CLOSE_PX = 90;
/** How far a gesture may wander and still count as a tap on the backdrop. */
const TAP_SLOP_PX = 8;

export function MapLightbox({
  src,
  name,
  onClose,
}: {
  src: string;
  name: string;
  onClose: () => void;
}) {
  const stage = useRef<HTMLDivElement | null>(null);
  const image = useRef<HTMLImageElement | null>(null);
  const [base, setBase] = useState<Box | null>(null);
  const [failed, setFailed] = useState(false);
  const view = useRef<Box | null>(null);
  const [drag, setDrag] = useState(0);

  const rect = useCallback((): DOMRect => {
    return (
      stage.current?.getBoundingClientRect() ||
      ({ left: 0, top: 0, width: 1, height: 1 } as DOMRect)
    );
  }, []);

  /*
  The view, as one transform.

  The image is laid out at its own map size and then scaled, so the numbers
  viewbox.ts works in are the image's own pixels — the same relationship the
  board has between map units and its viewBox.
  */
  const apply = useCallback(() => {
    const node = image.current;
    const box = view.current;
    if (!node || !box) return;
    const scale = rect().width / box.w;
    node.style.transform =
      "scale(" + scale + ") translate(" + -box.x + "px," + -box.y + "px)";
  }, [rect]);

  const reset = useCallback(() => {
    if (!base) return;
    const here = rect();
    view.current = centredView(base, here, Math.max(base.w, base.h * (here.width / here.height)));
    apply();
  }, [base, apply, rect]);

  useEffect(() => {
    reset();
  }, [reset]);

  // Esc is the keyboard's way out, and it works before the map has loaded.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // The page behind must not scroll while a full-screen map is over it.
  useEffect(() => {
    const had = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = had;
    };
  }, []);

  useEffect(() => {
    const onResize = () => reset();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [reset]);

  /*
  Gestures. One finger pans, two pinch, the wheel zooms about the pointer.

  A one-finger drag DOWN while the whole map is on screen is a dismissal
  instead — the phone gesture for "put this away". It only applies at fit-all,
  because once you have zoomed in, dragging down is how you look further up
  the map, and a dismissal there would be maddening.
  */
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef(0);
  const travel = useRef({ x: 0, y: 0, distance: 0 });

  const zoomed = (): boolean => {
    const box = view.current;
    if (!box || !base) return false;
    const here = rect();
    return box.w < Math.max(base.w, base.h * (here.width / here.height)) - 0.5;
  };

  const onPointerDown = (event: React.PointerEvent) => {
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.current.size === 1) travel.current = { x: 0, y: 0, distance: 0 };
    if (pointers.current.size === 2) {
      const [a, b] = Array.from(pointers.current.values());
      pinch.current = Math.hypot(a.x - b.x, a.y - b.y);
    }
  };

  const onPointerMove = (event: React.PointerEvent) => {
    const previous = pointers.current.get(event.pointerId);
    const box = view.current;
    if (!previous || !box || !base) return;
    const next = { x: event.clientX, y: event.clientY };
    const dx = next.x - previous.x;
    const dy = next.y - previous.y;
    pointers.current.set(event.pointerId, next);

    if (pointers.current.size === 1) {
      travel.current = {
        x: travel.current.x + dx,
        y: travel.current.y + dy,
        distance: travel.current.distance + Math.hypot(dx, dy),
      };
      if (!zoomed()) {
        // The card follows the finger, so the dismissal is visibly a drag.
        if (travel.current.y > 0 && Math.abs(travel.current.y) > Math.abs(travel.current.x)) {
          setDrag(travel.current.y);
        }
        return;
      }
      view.current = pannedView(base, rect(), box, dx, dy);
      apply();
      return;
    }

    if (pointers.current.size === 2) {
      const [a, b] = Array.from(pointers.current.values());
      const spread = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinch.current > 0 && spread > 0) {
        view.current = zoomedView(
          base,
          rect(),
          box,
          (a.x + b.x) / 2,
          (a.y + b.y) / 2,
          spread / pinch.current,
        );
        apply();
      }
      pinch.current = spread;
    }
  };

  const onPointerUp = (event: React.PointerEvent) => {
    const wasSingle = pointers.current.size === 1;
    pointers.current.delete(event.pointerId);
    if (pointers.current.size < 2) pinch.current = 0;
    if (!wasSingle) return;
    if (drag > SWIPE_CLOSE_PX) {
      onClose();
      return;
    }
    setDrag(0);
    /*
    A tap that never moved, and landed on the backdrop rather than the map,
    closes. Doing it here rather than on click is what makes it work on a
    phone, where the click after a touch is not always delivered.
    */
    if (travel.current.distance <= TAP_SLOP_PX) {
      const target = event.target as HTMLElement;
      if (target.dataset && target.dataset.backdrop === "yes") onClose();
    }
  };

  const onWheel = (event: React.WheelEvent) => {
    const box = view.current;
    if (!box || !base) return;
    view.current = zoomedView(
      base,
      rect(),
      box,
      event.clientX,
      event.clientY,
      Math.exp(-event.deltaY * 0.0015),
    );
    apply();
  };

  const onDoubleClick = (event: React.MouseEvent) => {
    const box = view.current;
    if (!box || !base) return;
    // Out at the top of the zoom, in everywhere else: one gesture, both ways.
    const here = rect();
    const widest = Math.max(base.w, base.h * (here.width / here.height));
    if (box.w <= widest / MAX_ZOOM + 0.5) {
      view.current = centredView(base, here, widest);
    } else {
      view.current = zoomedView(base, here, box, event.clientX, event.clientY, 2);
    }
    apply();
  };

  return (
    <div
      className="lightbox"
      data-backdrop="yes"
      role="dialog"
      aria-modal="true"
      aria-label={"The " + name + " map"}
      style={drag ? { transform: "translateY(" + drag + "px)", opacity: 1 - drag / 400 } : undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onWheel={onWheel}
      onDoubleClick={onDoubleClick}
    >
      <button
        type="button"
        className="lightbox-close"
        aria-label="Close the map"
        onClick={onClose}
      >
        ×
      </button>
      <div className="lightbox-stage" data-backdrop="yes" ref={stage}>
        {!base && !failed ? <p className="lightbox-note">Drawing the map…</p> : null}
        {failed ? <p className="lightbox-note">This map could not be drawn.</p> : null}
        <img
          ref={image}
          className="lightbox-map"
          src={src}
          alt={"The " + name + " map"}
          draggable={false}
          style={{
            width: base ? base.w + "px" : undefined,
            height: base ? base.h + "px" : undefined,
            visibility: base ? "visible" : "hidden",
          }}
          onLoad={(event) => {
            const node = event.currentTarget;
            setBase({
              x: 0,
              y: 0,
              w: node.naturalWidth || node.width || 1,
              h: node.naturalHeight || node.height || 1,
            });
          }}
          onError={() => setFailed(true)}
        />
      </div>
      <p className="lightbox-hint" data-backdrop="yes">
        {name} · drag to pan, pinch or scroll to zoom, Esc to close
      </p>
    </div>
  );
}
