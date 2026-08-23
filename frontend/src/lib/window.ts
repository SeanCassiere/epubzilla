// Window-lifecycle wrappers (M2.4). Like lib/api.ts and lib/dialog.ts,
// this is the only module that may import `@tauri-apps/api/window` — UI
// components go through these helpers.

import { getCurrentWindow } from "@tauri-apps/api/window";

/** The slice of Tauri's CloseRequestedEvent the guard decision needs. */
export interface CloseRequest {
  preventDefault(): void;
}

/**
 * Pure close-guard decision: a dirty book means the close must be
 * intercepted (preventDefault) and routed through the unsaved-changes
 * guard; a clean one closes straight away. Returns true when intercepted.
 */
export function interceptClose(dirty: boolean, event: CloseRequest): boolean {
  if (!dirty) return false;
  event.preventDefault();
  return true;
}

/**
 * Register a close-requested listener on the current window. Best-effort:
 * outside a real Tauri window (tests, plain browser) this resolves to a
 * no-op unlisten instead of throwing.
 */
export async function onCloseRequested(
  handler: (event: CloseRequest) => void,
): Promise<() => void> {
  try {
    return await getCurrentWindow().onCloseRequested(handler);
  } catch {
    return () => undefined;
  }
}

/**
 * Actually close the window after the guard allowed it. `destroy` skips the
 * close-requested event, so the guard doesn't re-trigger itself.
 */
export function destroyWindow(): Promise<void> {
  return getCurrentWindow().destroy();
}
