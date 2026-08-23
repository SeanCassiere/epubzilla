// Update discovery and release handoff boundary. This is the only frontend
// module allowed to import the updater or opener plugins. Phase one never
// downloads or installs the updater resource.

import { openUrl } from "@tauri-apps/plugin-opener";
import { check } from "@tauri-apps/plugin-updater";

export const LATEST_RELEASE_URL =
  "https://github.com/SeanCassiere/epubzilla/releases/latest";

export type UpdateState =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "unavailable" }
  | { status: "available"; version: string }
  | { status: "failed" };

let launchCheck: Promise<UpdateState> | null = null;
let releaseOpen: Promise<void> | null = null;

async function checkOnce(): Promise<UpdateState> {
  try {
    const update = await check({ timeout: 10_000 });
    if (update === null) return { status: "unavailable" };

    try {
      // Keep only the display metadata. The native resource must not survive
      // this function because phase one has no download/install operation.
      return { status: "available", version: update.version };
    } finally {
      await update.close();
    }
  } catch (error) {
    // Launch checks are deliberately silent in the UI, but retain a useful
    // diagnostic in development tools for offline/malformed/timeout failures.
    console.warn("Update check failed", error);
    return { status: "failed" };
  }
}

/** Start (or join) the sole updater check for this app session. */
export function checkForUpdateAfterLaunch(): Promise<UpdateState> {
  launchCheck ??= checkOnce();
  return launchCheck;
}

/** Open the manual-download page at most once in this app session. */
export function openLatestRelease(): Promise<void> {
  releaseOpen ??= openUrl(LATEST_RELEASE_URL).catch((error: unknown) => {
    console.warn("Could not open the latest release", error);
  });
  return releaseOpen;
}

/** Reset module session guards between unit tests. */
export function resetUpdaterSessionForTests(): void {
  if (import.meta.env.MODE !== "test") return;
  launchCheck = null;
  releaseOpen = null;
}
