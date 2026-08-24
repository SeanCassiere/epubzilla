// Reading-mode preference helpers for the reader (issue #75).
//
// Pure helpers so the mode persistence rules are unit-testable without
// DOM layout. The mode is what the user picked in the reader UI
// ("scrolled" is the historical M1 rendering and stays the default);
// "paginated" renders the chapter as viewport-height pages via CSS
// multi-column inside the sandboxed iframe (see PAGINATED_CHAPTER_CSS in
// chapter.ts) and the parent drives page turns by translating the
// pagination wrapper (see lib/paginator.ts, issue #88).

import type { ReadingMode } from "./chapter";

export type { ReadingMode } from "./chapter";

/** localStorage key for the persisted reading-mode preference. */
export const MODE_STORAGE_KEY = "epubzilla.reading-mode";

/** Narrows an unknown stored value to a ReadingMode (default "scrolled"). */
export function parseReadingMode(value: unknown): ReadingMode {
  return value === "paginated" ? "paginated" : "scrolled";
}

/** The mode toggle flips between the two modes. */
export function toggleReadingMode(mode: ReadingMode): ReadingMode {
  return mode === "scrolled" ? "paginated" : "scrolled";
}

/** Button label for the current mode. */
export function readingModeLabel(mode: ReadingMode): string {
  return mode === "scrolled" ? "Layout: Scrolled" : "Layout: Paginated";
}
