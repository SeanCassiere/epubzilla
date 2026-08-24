// Resizable-sidebar width rules (issue #61, Stage 3).
//
// Pure helpers so the clamp/persistence rules are unit-testable without
// DOM APIs. The width is a plain pixel number persisted in localStorage —
// trivial, non-authoritative UI state, same tier as the reading theme.

/** localStorage key for the persisted sidebar width. */
export const SIDEBAR_WIDTH_KEY = "epubzilla.sidebar-width";

/** Default width — matches the previous fixed 17rem (16px root font). */
export const SIDEBAR_DEFAULT_WIDTH = 272;

/** Clamp bounds: never so narrow the tabs wrap, never past half a window. */
export const SIDEBAR_MIN_WIDTH = 200;
export const SIDEBAR_MAX_WIDTH = 480;

/** Keyboard resize step for the separator's arrow keys. */
export const SIDEBAR_RESIZE_STEP = 16;

/** Clamps a candidate width into the allowed range. */
export function clampSidebarWidth(px: number): number {
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, px));
}

/** Narrows an unknown stored value to a valid width (default 272). */
export function parseSidebarWidth(value: unknown): number {
  // Note: Number("") is 0, so the empty string must be rejected up front.
  const px =
    typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  if (!Number.isFinite(px)) return SIDEBAR_DEFAULT_WIDTH;
  return clampSidebarWidth(Math.round(px));
}
