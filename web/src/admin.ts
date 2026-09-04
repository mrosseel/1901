/*
Whether this browser has logged in as the owner, remembered on the device.

The bar on every page needs to know, and the honest answer lives behind a
request to /api/v1/admin/me. Asking on every page load would put a fetch in
front of every player's first paint for a link almost nobody can use, so the
bar reads this flag instead: nothing, until somebody logs in at /admin.

It can be stale. A session expires after twelve hours and a restart ends every
one of them, so the link may still be there when the session is not. That is
the cheap failure: the link opens /admin, /admin asks the server, and the token
form comes back. Nothing is authorized by this flag — the cookie is.

sessionStorage rather than localStorage: the flag lasts as long as the tab
does, which is close enough to how long the session does.
*/

const KEY = "1901.admin";

export function readAdminFlag(): boolean {
  try {
    return window.sessionStorage.getItem(KEY) === "1";
  } catch {
    // A browser with storage turned off simply never shows the link.
    return false;
  }
}

export function writeAdminFlag(admin: boolean): void {
  try {
    if (admin) window.sessionStorage.setItem(KEY, "1");
    else window.sessionStorage.removeItem(KEY);
  } catch {
    // Nothing here is worth failing a login over.
  }
}
