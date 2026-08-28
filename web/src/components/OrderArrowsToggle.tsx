import { useState } from "react";
import { readHideOrders, writeHideOrders } from "../prefs";

/*
A switch for the player's own arrows.

Drawing the pending orders on the map is the right default: you check a
picture rather than a list. But while you are still deciding, a board covered
in your own arrows is the hardest board to read, so they come off on request.
Your units keep their "ordered" ring either way, so nothing is lost — only the
lines are.

This is presentation and this device's alone, like the map style: nothing goes
to the server and nobody else's screen moves.
*/
export function OrderArrowsToggle({
  value,
  onChange,
}: {
  value: boolean;
  onChange: (hidden: boolean) => void;
}) {
  return (
    <label className="arrows-toggle">
      <input
        type="checkbox"
        checked={value}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>Hide my order arrows</span>
    </label>
  );
}

/** The device's saved answer, and a setter that saves it. */
export function useHideOrders(): [boolean, (hidden: boolean) => void] {
  const [hidden, setHidden] = useState<boolean>(() => readHideOrders());
  return [
    hidden,
    (next: boolean) => {
      writeHideOrders(next);
      setHidden(next);
    },
  ];
}
