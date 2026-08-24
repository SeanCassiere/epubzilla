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

/**
 * Elements that must never start a window drag: interactive controls, and
 * anything inside a modal (the metadata/unsaved-changes dialogs render
 * inside the header element, so their padding would otherwise drag the
 * window).
 */
const DRAG_EXCLUDED =
  "button, a, input, select, textarea, [contenteditable], [role='tab'], .modal-overlay";

/**
 * Whole-surface titlebar drag (issue #61 follow-up). The declarative
 * data-tauri-drag-region attribute only fires when the mousedown TARGET is
 * the attributed element itself, and the header's background is almost
 * fully covered by children — so dragging only worked on padding slivers.
 * This handler goes on the header instead: any left mousedown that isn't
 * on an interactive control starts a window drag, and a double click
 * toggles maximize, matching native titlebar behaviour.
 */
export function beginTitlebarDrag(event: {
  button: number;
  detail: number;
  target: EventTarget | null;
}): void {
  if (event.button !== 0) return;
  const target = event.target;
  if (target instanceof Element && target.closest(DRAG_EXCLUDED) !== null) {
    return;
  }
  try {
    const window = getCurrentWindow();
    if (event.detail === 2) {
      void window.toggleMaximize();
    } else {
      void window.startDragging();
    }
  } catch {
    // Outside a real Tauri window (tests, plain browser): no-op.
  }
}
