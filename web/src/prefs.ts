/*
Preferences that belong to the DEVICE, not to the game.

Same rule as the map style in style.ts: nothing here goes to the server,
because nothing here changes what anybody else sees. localStorage can throw
outright in a locked-down browser, so every access is guarded and a preference
that cannot be read is simply the default.
*/

export const HIDE_ORDERS_KEY = "1901.hideOrders";

/*
Hiding your own pending arrows.

vDiplomacy's observation: drawing the pending orders on the map is the right
default — you check a picture instead of a list — but a board covered in your
own arrows is hard to read while you are still deciding what to do. So the
arrows come off on request. Only your own: this switch never touches the
review of a resolved phase, which is the picture everyone is reading together.
*/
export function readHideOrders(): boolean {
  try {
    return window.localStorage.getItem(HIDE_ORDERS_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeHideOrders(on: boolean): void {
  try {
    if (on) window.localStorage.setItem(HIDE_ORDERS_KEY, "1");
    else window.localStorage.removeItem(HIDE_ORDERS_KEY);
  } catch {
    // The switch still works for this page; it just will not be remembered.
  }
}
