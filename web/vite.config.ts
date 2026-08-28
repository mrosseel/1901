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

const endpoints =
  "^/(games$" +
  "|variants$|variants/[^/]+/map\\.svg" + // the variant catalogue and its maps
  "|g/" +
  "|map\\.svg|state|options|order|adjudicate" + // the M0 sandbox's own routes
  // The spectator page stays with vite; its feed goes to Go.
  "|game/[^/]+/watch(/[0-9]+)?" +
  "|game/[^/]+/(public" +
  "|map\\.svg" +
  "|join/[^/]+" +
  "|gm/[^/]+/(state|settings|start|adjudicate|extend|map\\.svg)" +
  "|seat/[^/]+/(state|options|order|finalize|unfinalize|map\\.svg))" +
  ")";

export default defineConfig({
  base: "/",
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    proxy: {
      [endpoints]: { target: API, changeOrigin: false },
    },
  },
});
