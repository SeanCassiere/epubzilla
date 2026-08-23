#!/usr/bin/env node
// Bump the app version in every file that carries it.
// Usage: pnpm bump X.Y.Z   (or: node scripts/bump-version.mjs X.Y.Z)
//
// Rewrites:
//   - package.json               (root)
//   - frontend/package.json
//   - Cargo.toml                 ([workspace.package] version)
//   - crates/app/tauri.conf.json
//
// No dependencies; string-surgical edits preserve formatting.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const version = process.argv[2];

if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error("Usage: pnpm bump X.Y.Z");
  process.exit(1);
}

/** Replace the first `"version": "..."` in a JSON file. */
function bumpJson(relPath) {
  const path = join(root, relPath);
  const src = readFileSync(path, "utf8");
  const out = src.replace(
    /("version"\s*:\s*")[^"]+(")/,
    `$1${version}$2`,
  );
  if (out === src) {
    throw new Error(`no "version" field found in ${relPath}`);
  }
  writeFileSync(path, out);
  console.log(`  ${relPath} -> ${version}`);
}

/** Replace `version = "..."` inside the [workspace.package] section. */
function bumpCargoWorkspace(relPath) {
  const path = join(root, relPath);
  const src = readFileSync(path, "utf8");
  const out = src.replace(
    /(\[workspace\.package\][^[]*?version\s*=\s*")[^"]+(")/,
    `$1${version}$2`,
  );
  if (out === src) {
    throw new Error(`no [workspace.package] version found in ${relPath}`);
  }
  writeFileSync(path, out);
  console.log(`  ${relPath} -> ${version}`);
}

console.log(`Bumping to ${version}:`);
bumpJson("package.json");
bumpJson("frontend/package.json");
bumpJson("crates/app/tauri.conf.json");
bumpCargoWorkspace("Cargo.toml");

console.log(`
Next steps:
  cargo check --workspace                 # refresh Cargo.lock with the new version
  git add -A && git commit -m "v${version}"
  git tag v${version}
  git push && git push --tags             # tag push triggers the release workflow
`);
