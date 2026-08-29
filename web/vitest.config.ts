import { defineConfig } from "vitest/config";

export default defineConfig({
  /* The map editor's tests import tools/placement, which sits above web/.
     Same reason as vite.config.ts: shared rules, one copy. */
  server: { fs: { allow: [".."] } },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});
