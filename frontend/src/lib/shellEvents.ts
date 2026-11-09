// Shell → frontend lifecycle events (crates/app/src/lifecycle.rs). Like
// lib/menu.ts, this is an adapter module allowed to import
// `@tauri-apps/api/event`; UI and state code go through these helpers.
//
// All subscriptions are best-effort: outside a real Tauri window (tests,
// plain browser) they resolve to a no-op unlisten instead of throwing.

import { listen } from "@tauri-apps/api/event";

/** Event names; must match the constants in lifecycle.rs. */
export const OPEN_FILES_EVENT = "open-files";
export const QUIT_REQUESTED_EVENT = "app-quit-requested";
export const RECENTS_CHANGED_EVENT = "recent-books-changed";

async function subscribe<T>(
  event: string,
  handler: (payload: T) => void,
): Promise<() => void> {
  try {
    const stop = await listen<T>(event, (e) => handler(e.payload));
    return () => {
      // The IPC bridge may already be gone (window teardown / tests);
      // unlistening is best-effort, sync or async.
      try {
        void Promise.resolve(stop() as unknown).catch(() => undefined);
      } catch {
        // ignore
      }
    };
  } catch {
    return () => undefined;
  }
}

/** Finder / Open With / File ▸ Open Recent asked to open these paths. */
export function onOpenFiles(
  handler: (paths: string[]) => void,
): Promise<() => void> {
  return subscribe<string[]>(OPEN_FILES_EVENT, (paths) =>
    handler(Array.isArray(paths) ? paths : []),
  );
}

/**
 * ⌘Q / Quit menu item: acknowledge (api.ackQuitRequest) with the request
 * id, run the guard, then api.quitApp(). The id is null if the payload is
 * missing (older shells, tests).
 */
export function onQuitRequested(
  handler: (request: number | null) => void,
): Promise<() => void> {
  return subscribe<unknown>(QUIT_REQUESTED_EVENT, (payload) =>
    handler(typeof payload === "number" ? payload : null),
  );
}

/** The shell's recent-books list changed (e.g. File ▸ Open Recent ▸ Clear Menu). */
export function onRecentBooksChanged(
  handler: (paths: string[]) => void,
): Promise<() => void> {
  return subscribe<string[]>(RECENTS_CHANGED_EVENT, (paths) =>
    handler(Array.isArray(paths) ? paths : []),
  );
}
