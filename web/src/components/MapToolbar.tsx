import { StylePicker } from "./StylePicker";

/*
The switches that change the map, over the map.

They were at the bottom of the panel, under the order list and the last
phase's resolutions — three unrelated controls in the one place a player
scrolls past. Every one of them changes what the MAP draws and nothing else,
so the map is where they belong: you flip one and watch the thing you flipped
it for, with no eye trip across the screen and back.

The bar is deliberately quiet. It sits on the top edge, it is translucent
until it is pointed at, and it holds nothing that changes the game — every
switch here is this device's alone, saved in this browser and sent to nobody
(prefs.ts, style.ts). Two of them are on-or-off and one is a list, so the two
are pressed buttons that say which way they are and the list stays a select.

On a phone the words come off and the marks stand alone. That is not a smaller
version of the bar; it is the same bar with the room a phone actually has, and
the words survive in the title and the accessible name.
*/
export function MapToolbar({
  style,
  onStyle,
  hideOrders,
  onHideOrders,
  briefLabels,
  onBriefLabels,
}: {
  style: string;
  onStyle: (style: string) => void;
  /* Absent on a screen with no orders of its own to hide — the spectator
     board draws a resolved phase, which is the picture the room is reading. */
  hideOrders?: boolean;
  onHideOrders?: (hidden: boolean) => void;
  briefLabels: boolean;
  onBriefLabels: (brief: boolean) => void;
}) {
  return (
    <div className="map-toolbar" role="group" aria-label="Map controls">
      {onHideOrders ? (
        <button
          type="button"
          className={hideOrders ? "map-tool off" : "map-tool"}
          aria-pressed={!hideOrders}
          title={hideOrders ? "Show my order arrows" : "Hide my order arrows"}
          onClick={() => onHideOrders(!hideOrders)}
        >
          <span className="map-tool-mark" aria-hidden="true">
            ↗
          </span>
          <span className="map-tool-word">{hideOrders ? "Arrows off" : "Arrows"}</span>
        </button>
      ) : null}

      <button
        type="button"
        className={briefLabels ? "map-tool" : "map-tool off"}
        aria-pressed={briefLabels}
        title={briefLabels ? "Show full province names" : "Show province codes"}
        onClick={() => onBriefLabels(!briefLabels)}
      >
        <span className="map-tool-mark" aria-hidden="true">
          Ab
        </span>
        <span className="map-tool-word">{briefLabels ? "Codes" : "Names"}</span>
      </button>

      <StylePicker value={style} onChange={onStyle} label="Style" />
    </div>
  );
}
