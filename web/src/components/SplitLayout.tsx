import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  clampSplit,
  defaultSplit,
  initialSplit,
  modeFor,
  splitAfterDrag,
  splitTrack,
  writeSplit,
  type SplitMode,
} from "../split";

/*
The map and the order panel, with a border you can move.

The two halves of this screen take turns being the important one, so the grid
track between them is a control. The handle writes the grid template straight
onto the container while a finger is down — no React state, no transition, so
the map follows the thumb at the frame rate — and only tells React and
localStorage once the finger comes off.

The map island is never remounted by any of this. It watches its own box and
refits itself (board.ts), which is what keeps the view centred on whatever the
player was looking at while the border moves.
*/

// How far a tap may wander and still count as a tap, and how long the pause
// between two of them may be for the pair to mean "put it back".
const TAP_SLOP_PX = 8;
const DOUBLE_TAP_MS = 400;

// One press of an arrow key.
const KEY_STEP: Record<SplitMode, number> = {
  portrait: 0.02,
  landscape: 0.02,
  desktop: 24,
};

function currentMode(): SplitMode {
  return modeFor(window.innerWidth, window.innerHeight);
}

export function SplitLayout({
  className,
  children,
}: {
  className?: string;
  /** Exactly two: the map pane, then the side panel. */
  children: ReactNode;
}) {
  const host = useRef<HTMLDivElement | null>(null);
  const [mode, setMode] = useState<SplitMode>(currentMode);
  const value = useRef<number>(0);

  const extentOf = useCallback((forMode: SplitMode): number => {
    const rect = host.current?.getBoundingClientRect();
    if (!rect) return forMode === "desktop" ? window.innerWidth : window.innerHeight;
    return forMode === "desktop" ? rect.width : rect.height;
  }, []);

  /* The one place the layout is written. Direct style, because this runs on
     every pointer move. */
  const apply = useCallback((forMode: SplitMode, next: number) => {
    const el = host.current;
    if (!el) return;
    value.current = next;
    const track = splitTrack(forMode, next);
    if (forMode === "desktop") {
      el.style.gridTemplateRows = "";
      el.style.gridTemplateColumns = "minmax(0, 1fr) var(--split-grip) " + track;
    } else {
      el.style.gridTemplateColumns = "";
      el.style.gridTemplateRows = track + " var(--split-grip) minmax(0, 1fr)";
    }
  }, []);

  /* The mode is read from the window, with the same thresholds the media
     queries use, so the inline template can never disagree with the CSS about
     which axis is being split. */
  useEffect(() => {
    const settle = () => {
      const next = currentMode();
      setMode(next);
      apply(next, initialSplit(next, extentOf(next)));
    };
    settle();
    window.addEventListener("resize", settle);
    window.addEventListener("orientationchange", settle);
    return () => {
      window.removeEventListener("resize", settle);
      window.removeEventListener("orientationchange", settle);
    };
  }, [apply, extentOf]);

  const reset = useCallback(() => {
    const next = defaultSplit(mode, extentOf(mode));
    apply(mode, next);
    writeSplit(mode, next);
  }, [apply, extentOf, mode]);

  const drag = useRef({ active: false, origin: 0, start: 0, extent: 0, moved: 0, lastUp: 0 });

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    // The middle and right buttons belong to the browser.
    if (event.button !== 0 && event.pointerType === "mouse") return;
    const grip = event.currentTarget;
    grip.setPointerCapture(event.pointerId);
    drag.current = {
      ...drag.current,
      active: true,
      origin: mode === "desktop" ? event.clientX : event.clientY,
      start: value.current,
      extent: extentOf(mode),
      moved: 0,
    };
    event.preventDefault();
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d.active) return;
    const at = mode === "desktop" ? event.clientX : event.clientY;
    const delta = at - d.origin;
    d.moved = Math.max(d.moved, Math.abs(delta));
    apply(mode, splitAfterDrag(mode, d.start, delta, d.extent));
  };

  const endDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d.active) return;
    d.active = false;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (d.moved > TAP_SLOP_PX) {
      writeSplit(mode, value.current);
      d.lastUp = 0;
      return;
    }
    // A tap that went nowhere. Two of them in a row put the border back.
    const now = Date.now();
    if (now - d.lastUp < DOUBLE_TAP_MS) {
      d.lastUp = 0;
      reset();
    } else {
      d.lastUp = now;
    }
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const step = KEY_STEP[mode];
    const horizontal = mode === "desktop";
    let next: number | null = null;
    if (event.key === (horizontal ? "ArrowLeft" : "ArrowUp")) {
      next = clampSplit(mode, value.current + (horizontal ? step : -step), extentOf(mode));
    } else if (event.key === (horizontal ? "ArrowRight" : "ArrowDown")) {
      next = clampSplit(mode, value.current + (horizontal ? -step : step), extentOf(mode));
    } else if (event.key === "Enter" || event.key === "Home") {
      reset();
      event.preventDefault();
      return;
    }
    if (next === null) return;
    event.preventDefault();
    apply(mode, next);
    writeSplit(mode, next);
  };

  const [map, side] = Array.isArray(children) ? children : [children, null];

  return (
    <div className={className} ref={host}>
      {map}
      <div
        className="split-grip"
        role="separator"
        tabIndex={0}
        aria-orientation={mode === "desktop" ? "vertical" : "horizontal"}
        aria-label="Resize the map and the order panel"
        title="Drag to resize. Double-tap to reset."
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={onKeyDown}
      >
        <span className="split-grip-bar" aria-hidden="true" />
      </div>
      {side}
    </div>
  );
}
