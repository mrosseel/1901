/*
The deadline clock, kept on the server's time rather than the device's.

A phone at a table can be minutes off, and a phone that is minutes fast shows
a deadline that has already passed while everyone else is still ordering. So
every state answer carries the server's own `now`, and the difference between
that and this device's clock is the offset every countdown is measured
against.

Nothing here is stored. The offset lives for as long as the page does, and a
refresh takes a fresh one from the first poll — which is the point: a
countdown that was written down would be wrong the moment the tab slept.
*/

let offsetMs = 0;
let known = false;

/** Takes the server's clock from a state answer. Anything unreadable is ignored. */
export function noteServerTime(now: string | null | undefined): void {
  if (!now) return;
  const at = Date.parse(now);
  if (Number.isNaN(at)) return;
  offsetMs = at - Date.now();
  known = true;
}

/** For tests, and for a page that wants to start over. */
export function resetServerTime(): void {
  offsetMs = 0;
  known = false;
}

/** Whether a server clock has been seen. Until then the device's own is used. */
export function serverTimeKnown(): boolean {
  return known;
}

export function serverOffsetMs(): number {
  return offsetMs;
}

/** Now, as the server would call it. */
export function serverNow(): number {
  return Date.now() + offsetMs;
}

/** How long is left, in milliseconds. Null means the game runs without a deadline. */
export function msLeft(deadlineAt: string | null | undefined): number | null {
  if (!deadlineAt) return null;
  const at = Date.parse(deadlineAt);
  if (Number.isNaN(at)) return null;
  return at - serverNow();
}

export type ClockTone = "calm" | "low" | "urgent" | "over";

/** Amber under five minutes, red under one, and plain once it has run out. */
export function clockTone(left: number | null): ClockTone {
  if (left === null) return "calm";
  if (left <= 0) return "over";
  if (left < 60_000) return "urgent";
  if (left < 5 * 60_000) return "low";
  return "calm";
}

/*
The big face: "4:32" under an hour, "1:04:32" over it. Seconds are always
shown, because the last minute is the one that decides a phase.
*/
export function clockFace(left: number | null): string {
  if (left === null) return "";
  if (left <= 0) return "0:00";
  const seconds = Math.floor(left / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  if (hours > 0) return hours + ":" + pad(minutes) + ":" + pad(rest);
  return minutes + ":" + pad(rest);
}

/** The words beside the face, and the whole line where there is no room for both. */
export function clockWords(left: number | null): string {
  if (left === null) return "No deadline";
  if (left <= 0) return "Deadline passed";
  return "left in this phase";
}

/** The one-line form, for a header that has no room for the big face. */
export function countdown(deadlineAt: string | null | undefined): string {
  const left = msLeft(deadlineAt);
  if (left === null) return "No deadline";
  if (left <= 0) return "Deadline passed";
  return clockFace(left) + " left";
}
