// App-wide keyboard shortcuts (issue #74). Pure, unit-testable matching
// plus a tiny window-scoped action bus.
//
// Two delivery paths feed the SAME actions:
//  1. DOM keydown — matched by `matchShortcut` and dispatched on the bus.
//     Installed on the app window (App.tsx) AND inside each chapter-iframe
//     document (ReaderPane), because keydown inside the sandboxed iframe
//     never bubbles to the parent window.
//  2. Native menu accelerators (crates/app/src/menu.rs) — the Rust shell
//     emits an `app-menu` event with the menu-item id; lib/menu.ts maps it
//     through `menuActionFor` onto the same bus.
// On macOS the native menu consumes its accelerators before the webview
// sees them; on other platforms both paths may fire for one keypress, so
// `dispatchShortcut` dedupes identical actions within a short window.
//
// Reader-local keys (plain ArrowLeft/Right, PageUp/Down, Space — PR #83)
// are deliberately NOT routed through this module: they stay modifier-free
// and are guarded per-context in ReaderPane. Everything here requires
// Cmd (macOS) / Ctrl, so the two layers cannot collide.

/** Every app-level shortcut action. One id namespace shared with the menu. */
export type ShortcutAction =
  | "new-book"
  | "open-book"
  | "save"
  | "save-as"
  | "toggle-edit"
  | "prev-chapter"
  | "next-chapter"
  | "cycle-theme"
  | "sidebar-contents"
  | "sidebar-chapters"
  | "sidebar-checks";

/** The slice of KeyboardEvent the matcher reads (testable without DOM). */
export interface KeyCombo {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/**
 * Match one keydown against the app shortcut table. Every binding requires
 * the platform primary modifier (Cmd on macOS, Ctrl elsewhere — either
 * accepted, matching the pre-existing Cmd/Ctrl+S handling), so shortcuts
 * keep working while focus sits in a text input or the chapter editor:
 * none of them collide with plain typing.
 *
 * Table (Mod = Cmd/Ctrl):
 *   Mod+N              new book        Mod+O              open book
 *   Mod+S              save            Mod+Shift+S        save as
 *   Mod+E              toggle editor
 *   Mod+Alt+ArrowLeft  prev chapter    Mod+Alt+ArrowRight next chapter
 *   Mod+Shift+T        cycle theme
 *   Mod+1 / Mod+2 / Mod+3              sidebar Contents / Chapters / Checks
 */
export function matchShortcut(combo: KeyCombo): ShortcutAction | null {
  const mod = combo.metaKey || combo.ctrlKey;
  if (!mod) return null;
  const key = combo.key.length === 1 ? combo.key.toLowerCase() : combo.key;
  if (combo.altKey) {
    // Alt participates only in the chapter-nav chords.
    if (combo.shiftKey) return null;
    if (key === "ArrowLeft") return "prev-chapter";
    if (key === "ArrowRight") return "next-chapter";
    return null;
  }
  if (combo.shiftKey) {
    if (key === "s") return "save-as";
    if (key === "t") return "cycle-theme";
    return null;
  }
  switch (key) {
    case "n":
      return "new-book";
    case "o":
      return "open-book";
    case "s":
      return "save";
    case "e":
      return "toggle-edit";
    case "1":
      return "sidebar-contents";
    case "2":
      return "sidebar-chapters";
    case "3":
      return "sidebar-checks";
    default:
      return null;
  }
}

/** Menu-item id (crates/app/src/menu.rs) -> action. Ids ARE action names. */
export function menuActionFor(id: string): ShortcutAction | null {
  const actions: ReadonlyArray<ShortcutAction> = [
    "new-book",
    "open-book",
    "save",
    "save-as",
    "toggle-edit",
    "prev-chapter",
    "next-chapter",
    "cycle-theme",
    "sidebar-contents",
    "sidebar-chapters",
    "sidebar-checks",
  ];
  return actions.find((a) => a === id) ?? null;
}

/** Where a dispatch came from: DOM keydown or native menu activation. */
export type ShortcutSource = "key" | "menu";

/**
 * Dedupe window: one physical keypress can arrive via BOTH the native menu
 * accelerator and the DOM keydown (platform-dependent). Those duplicates
 * land within a few milliseconds and always from DIFFERENT sources — so
 * only cross-source repeats are suppressed, and genuine same-source
 * repeats (fast double-taps, key repeat) always pass.
 */
export const DEDUPE_WINDOW_MS = 100;

/** Last dispatch of one action: when and via which path. */
export interface DispatchRecord {
  time: number;
  source: ShortcutSource;
}

/**
 * Pure dedupe decision: suppress only when the SAME action arrived within
 * the window from the OTHER source (menu echo of a keypress or vice
 * versa). `last` is mutated on an allowed dispatch.
 */
export function shouldDispatch(
  action: ShortcutAction,
  source: ShortcutSource,
  now: number,
  last: Map<ShortcutAction, DispatchRecord>,
): boolean {
  const previous = last.get(action);
  if (
    previous !== undefined &&
    previous.source !== source &&
    now - previous.time < DEDUPE_WINDOW_MS
  ) {
    return false;
  }
  last.set(action, { time: now, source });
  return true;
}

const EVENT_NAME = "epubzilla:shortcut";

const lastDispatch = new Map<ShortcutAction, DispatchRecord>();

/** Fire one action on the app bus (deduped, see shouldDispatch). */
export function dispatchShortcut(
  action: ShortcutAction,
  source: ShortcutSource = "key",
): void {
  if (!shouldDispatch(action, source, Date.now(), lastDispatch)) return;
  window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: action }));
}

/**
 * Subscribe to app shortcut actions. Returns the unsubscribe function.
 * Handlers receive every action; subscribers filter for the ones they own.
 */
export function onShortcut(
  handler: (action: ShortcutAction) => void,
): () => void {
  const listener = (event: Event) => {
    handler((event as CustomEvent<ShortcutAction>).detail);
  };
  window.addEventListener(EVENT_NAME, listener);
  return () => window.removeEventListener(EVENT_NAME, listener);
}

/**
 * Keydown handler body shared by the app window and each chapter-iframe
 * document: match, and on a hit prevent the default (e.g. the browser's
 * own Ctrl+S / Ctrl+N) and dispatch on the parent-window bus.
 */
export function handleShortcutKeydown(event: KeyboardEvent): void {
  const action = matchShortcut(event);
  if (action === null) return;
  event.preventDefault();
  dispatchShortcut(action);
}
