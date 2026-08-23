// Reading-mode preference and pagination geometry for the reader (issue #75).
//
// Pure helpers so the mode persistence rules and the page math are
// unit-testable without DOM layout. The mode is what the user picked in
// the reader UI ("scrolled" is the historical M1 rendering and stays the
// default); "paginated" renders the chapter as viewport-height pages via
// CSS multi-column inside the sandboxed iframe (see PAGINATED_CHAPTER_CSS
// in chapter.ts) and the parent drives page turns by setting the body's
// horizontal scroll offset.

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

// --- Pagination geometry -------------------------------------------------
//
// In paginated mode the body is a single-column multicol container with a
// fixed height: overflowing content is fragmented into overflow column
// boxes laid out horizontally, each exactly the body's content-box width
// (`contentWidth`), separated by `columnGap`. One column == one page, so
// stepping a page means moving scrollLeft by contentWidth + columnGap.

/** Horizontal distance between the left edges of consecutive pages. */
export function pageStep(contentWidth: number, columnGap: number): number {
  return contentWidth + columnGap;
}

/**
 * Number of pages, derived from how far the body can scroll: each page
 * past the first adds exactly one `step` of scrollable range. Rounding
 * absorbs sub-pixel layout and engines that drop trailing padding from
 * scrollWidth.
 */
export function pageCount(
  scrollWidth: number,
  clientWidth: number,
  step: number,
): number {
  if (step <= 0) return 1;
  const maxScrollLeft = Math.max(0, scrollWidth - clientWidth);
  return Math.max(1, Math.round(maxScrollLeft / step) + 1);
}

/** Page index (0-based) for a scroll offset, snapped to the nearest page. */
export function pageAtOffset(scrollLeft: number, step: number): number {
  if (step <= 0) return 0;
  return Math.max(0, Math.round(scrollLeft / step));
}

/** Clamped scroll offset for a target page index. */
export function offsetForPage(
  page: number,
  step: number,
  count: number,
): number {
  const clamped = Math.min(Math.max(page, 0), Math.max(count - 1, 0));
  return clamped * step;
}
