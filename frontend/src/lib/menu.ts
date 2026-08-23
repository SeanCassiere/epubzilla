// Native-menu bridge (issue #74). Like lib/api.ts / lib/dialog.ts /
// lib/window.ts, this is the only module that may import
// `@tauri-apps/api/event` — UI code goes through this helper.
//
// The Rust shell (crates/app/src/menu.rs) emits `app-menu` with the
// activated menu-item id; ids are ShortcutAction names, so the bridge just
// maps and re-dispatches on the shared shortcut bus. dispatchShortcut's
// dedupe absorbs platforms where a menu accelerator ALSO reaches the DOM.

import { listen } from "@tauri-apps/api/event";
import { dispatchShortcut, menuActionFor } from "./shortcuts";

/**
 * Route native menu activations onto the shortcut bus. Best-effort:
 * outside a real Tauri window (tests, plain browser) this resolves to a
 * no-op unlisten instead of throwing.
 */
export async function bridgeMenuEvents(): Promise<() => void> {
  try {
    return await listen<string>("app-menu", (event) => {
      const action = menuActionFor(event.payload);
      if (action !== null) dispatchShortcut(action, "menu");
    });
  } catch {
    return () => undefined;
  }
}
