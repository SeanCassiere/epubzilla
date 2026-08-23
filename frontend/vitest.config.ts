import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@bindings": fileURLToPath(
        new URL("../crates/core/bindings", import.meta.url),
      ),
    },
  },
  test: {
    // chapter.ts uses DOMParser; jsdom stands in for the webview.
    environment: "jsdom",
    // matchMedia + localStorage stubs and per-test scheme/storage reset.
    setupFiles: ["src/test/setup.ts"],
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});
