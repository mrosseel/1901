import { useEffect, useRef } from "react";
import type { ReactNode } from "react";

/*
The one layer that answers a tap.

The review of the last phase and the referee guide are things a player READS.
While one is open, nothing behind it may be acted on — a player must not be
able to lock in this phase's orders with one hand while still reading last
turn with the other, and the two buttons must not sit in opposite corners of
the same screen competing for the same tap. So the page behind goes inert:
no pointer, no keyboard, no tab stop. The sheet holds the only primary
action, and that action is always in the same place.

Escape closes it, for the same reason the button says "Close review": leaving
this layer costs nothing and changes nothing in the game.
*/
export function ModalLayer({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  const holder = useRef<HTMLDivElement | null>(null);

  // The tap that opened this may have left focus on an element that is now
  // inert, which drops focus to the document. Moving it into the sheet keeps
  // the keyboard on the layer that can answer it.
  useEffect(() => {
    const first = holder.current?.querySelector<HTMLElement>("button, [href], input, select");
    first?.focus();
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="modal-layer" role="dialog" aria-modal="true" ref={holder}>
      {children}
    </div>
  );
}
