import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Studio runs on 7000; the BFF (apps/bff) runs on 7001. The BFF registers no
// CORS plugin (see apps/bff/RAPOR.md), so every /api call must go through this
// same-origin proxy in dev. `rewrite` strips the /api prefix because the BFF
// serves its routes at the root (/auth/login, /runs, ...), not under /api.
const BFF_ORIGIN = process.env["MAESTRO_BFF_ORIGIN"] ?? "http://localhost:7001";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // The @maestro/config barrel re-exports env.ts, which reads process.env
      // and pulls zod in. The browser only needs the message catalog, so we
      // alias straight to the i18n module and keep Node code out of the bundle.
      "@maestro/config/i18n": fileURLToPath(
        new URL("../../packages/config/src/i18n.ts", import.meta.url),
      ),
    },
  },
  server: {
    port: 7000,
    strictPort: true,
    proxy: {
      "/api": {
        target: BFF_ORIGIN,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
    },
  },
  preview: { port: 7000, strictPort: true },
  build: { outDir: "dist", sourcemap: true },
});
