import { clockFace, clockTone, clockWords, msLeft } from "../clock";
import { useTicker } from "../hooks";

/*
The deadline, big enough to read across a table.

It is recomputed from the server's deadline every second — never counted down
from a number held here — so a refresh, a tab that slept, and a phone whose
own clock is wrong all end up showing the same time as everyone else's phone.
*/
export function Clock({ deadlineAt }: { deadlineAt: string | null | undefined }) {
  useTicker(Boolean(deadlineAt));
  const left = msLeft(deadlineAt);
  if (left === null) return null;

  const tone = clockTone(left);
  return (
    <div className={"clock clock-" + tone} role="timer" aria-live="off">
      <span className="clock-face">{clockFace(left)}</span>
      <span className="clock-words">{clockWords(left)}</span>
    </div>
  );
}
