import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/*
The build lands in web/dist, which the Go server serves: the shell at the four
page routes, the hashed files under /assets/. The pages live at three different
path depths, so the base must be absolute — a relative base would make
/game/{id}/seat/{token}/ ask for its script inside its own directory.

In development vite serves the shell and proxies everything the server owns.
The proxy list is written out rather than a blanket /game rule, because the
page routes themselves must stay with vite while the endpoints below them go
to Go.
*/
// Where the Go server listens in development. API_TARGET moves it, for a
// second server run beside the shared one.
const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
const API = env?.API_TARGET || "http://localhost:8190";

/*
What Go owns in development (ADR-050).

This used to be a hand-written list of every endpoint, and it drifted four
features behind: a request for JSON came back as the app's HTML, and the
failure surfaced as a parse error in an unrelated file. It cannot drift now,
because the transport is one prefix.

Beside it are the published reads, which are deliberately not prefixed and are
deliberately few: every address here is one we mean to keep working.
*/
const endpoints =
  "^/(api/" +
  // The map art. /variants itself is a page and stays with vite; the
  // catalogue behind it moved under /api/v1 with the rest of the transport.
  "|variants/[^/]+/(map\\.svg|provinces\\.json|placement\\.json)" +
  "|styles$" + // the map styles this server can draw in
  // The spectator page stays with vite; the board it reads goes to Go.
  "|game/[^/]+/(public|watch(/[0-9]+)?|map\\.svg)" +
  ")";

export default defineConfig({
  base: "/",
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    /* Nothing in the app imports from above web/ any more; the tests do, and
       they run through vitest.config.ts. Kept because a dev server that
       refuses what the test server allows is a difference nobody wants to
       find out about at the wrong moment. */
    fs: { allow: [".."] },
    proxy: {
      [endpoints]: {
        target: API,
        changeOrigin: false,
      },
    },
  },
});
