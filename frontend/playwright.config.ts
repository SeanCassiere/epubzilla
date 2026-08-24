// Engine-backed layout tests (issue #88): the paginated reading mode
// broke in the real Tauri/WebKit runtime while the whole jsdom suite
// stayed green, because jsdom performs no layout. This project runs the
// real pagination pipeline (prepareChapterHtml + lib/paginator.ts) against
// Playwright's WebKit — the same engine family as the Tauri webview — so
// multi-page geometry and actual page turns are verified on real
// fragmentation, not synthetic numbers. See e2e/paginated.spec.ts.
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  // Bundles src/lib via vite into an IIFE the test pages can load.
  globalSetup: "./e2e/global-setup.ts",
  projects: [{ name: "webkit", use: { browserName: "webkit" } }],
  reporter: process.env.CI === undefined ? "list" : [["list"], ["github"]],
});
