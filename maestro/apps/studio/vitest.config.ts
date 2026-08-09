import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

/**
 * Test config is separate from vite.config.ts: the dev server config carries a
 * proxy and a port that tests must never inherit, and Vite's own config type no
 * longer accepts a `test` block.
 *
 * Vite is pinned to 7.x here on purpose. The repo standardises on vitest 3,
 * which bundles its own Vite 7; installing Vite 8 alongside it makes the plugin
 * types of the two copies mutually unassignable and typecheck fails. Moving to
 * Vite 8 means moving the whole monorepo to vitest 4 in one step.
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@maestro/config/i18n": fileURLToPath(
        new URL("../../packages/config/src/i18n.ts", import.meta.url),
      ),
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./test/setup.ts"],
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
  },
});
