import { defineConfig } from "vitest/config";

export default defineConfig({
  /* The board's label tests read the frozen map, its placement table and its
     descriptor straight off disk, from testdata/ above web/. Vitest serves
     nothing above its own root unless it is told to. */
  server: { fs: { allow: [".."] } },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});
