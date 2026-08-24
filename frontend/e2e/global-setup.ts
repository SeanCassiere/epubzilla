// Playwright global setup: bundle the production reader modules
// (bundle-entry.ts -> src/lib/chapter.ts + src/lib/paginator.ts) into a
// single IIFE at e2e/build/reader-bundle.iife.js. The specs inject it into
// real WebKit pages with addScriptTag, so the engine tests drive the exact
// code ReaderPane uses in the app.
import { fileURLToPath } from "node:url";
import { build } from "vite";

export default async function globalSetup(): Promise<void> {
  await build({
    configFile: false,
    logLevel: "warn",
    build: {
      lib: {
        entry: fileURLToPath(new URL("./bundle-entry.ts", import.meta.url)),
        name: "EpubzillaReader",
        formats: ["iife"],
        fileName: () => "reader-bundle.iife.js",
      },
      outDir: fileURLToPath(new URL("./build", import.meta.url)),
      emptyOutDir: true,
      minify: false,
    },
  });
}
