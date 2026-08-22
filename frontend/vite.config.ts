import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

export default defineConfig(async () => ({
  plugins: [react()],
  resolve: {
    alias: {
      // Generated ts-rs bindings — the only source of model types (ADR-0006).
      "@bindings": fileURLToPath(
        new URL("../crates/core/bindings", import.meta.url),
      ),
    },
  },
  // Vite options tailored for Tauri development.
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    fs: {
      // Allow serving the bindings directory, which sits outside frontend/.
      allow: [".", "../crates/core/bindings"],
    },
    watch: {
      ignored: ["**/crates/**", "!**/crates/core/bindings/**"],
    },
  },
}));
