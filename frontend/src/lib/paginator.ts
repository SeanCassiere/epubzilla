// Parent-side pagination driver for the chapter iframe (issues #75, #88).
//
// In paginated mode the chapter srcdoc contains a wrapper element
// (`[data-epubzilla-paginator]`, injected by prepareChapterHtml) that is a
// viewport-height single-column multicol container: overflowing content
// fragments into horizontal overflow columns, one column per page, each
// exactly the wrapper's width. The functions here run in the PARENT window
// against the sandboxed iframe's same-origin document and drive page turns
// by translating the wrapper with a CSS transform.
//
// Why transforms and getBoundingClientRect, not scrollLeft/scrollWidth
// (issue #88): WebKit — the engine behind the Tauri webview — clips a
// multicol container's overflow columns but does not reliably expose them
// through the container's scrollWidth/scrollLeft. The original
// body.scrollLeft implementation therefore measured a page count of 1 in
// the real app, and the first forward turn skipped to the next chapter.
// Everything here is derived from client rects (real layout geometry every
// engine reports) and applied via `transform`, which no engine clamps.
//
// The page count comes from the end-of-content sentinel
// (`[data-epubzilla-sentinel]`, the wrapper's last child): its horizontal
// offset from the wrapper's left edge marks where the fragmented content
// ends. Both rects carry the same translation, so the measurement is
// independent of the current page.
//
// The current page index is stamped on the wrapper as an attribute so it
// survives re-measurement and is derived from the document itself rather
// than parent-side state (the srcdoc reloads on theme/mode changes).

import { PAGINATOR_ATTR, SENTINEL_ATTR } from "./chapter";

export { PAGINATOR_ATTR, SENTINEL_ATTR } from "./chapter";

/** Attribute on the wrapper holding the current 0-based page index. */
export const PAGE_ATTR = "data-epubzilla-current-page";

/** Page geometry measured from the live chapter layout. */
export interface PageGeometry {
  /** Horizontal distance between the left edges of consecutive pages. */
  step: number;
  /** Total number of pages in the chapter. */
  count: number;
}

/** Clamps a page index into [0, count - 1]. */
export function clampPage(page: number, count: number): number {
  return Math.min(Math.max(page, 0), Math.max(count - 1, 0));
}

/**
 * Page count from the sentinel's horizontal offset within the wrapper.
 * The sentinel sits in the last column, whose left edge is an exact
 * multiple of `step`; the +1px tolerance absorbs sub-pixel layout drift
 * just below a column boundary.
 */
export function pageCountFromExtent(extent: number, step: number): number {
  if (step <= 0) return 1;
  return Math.max(1, Math.floor((extent + 1) / step) + 1);
}

/**
 * Page index (0-based) for a horizontal offset within the wrapper (an
 * element's distance from the wrapper's left edge). Same +1px sub-pixel
 * tolerance as pageCountFromExtent.
 */
export function pageFromOffset(offset: number, step: number): number {
  if (step <= 0) return 0;
  return Math.max(0, Math.floor((offset + 1) / step));
}

/** The pagination wrapper of a chapter document, if it is paginated. */
export function getPaginator(doc: Document): HTMLElement | null {
  return doc.querySelector(`[${PAGINATOR_ATTR}]`);
}

/**
 * Measures the chapter's page geometry from real layout. Returns null
 * when the document is not paginated or has no usable layout yet (e.g.
 * zero-width during load, or jsdom which performs no layout).
 */
export function measurePageGeometry(doc: Document): PageGeometry | null {
  const wrapper = getPaginator(doc);
  const win = doc.defaultView;
  if (wrapper === null || win === null) return null;
  // clientWidth is the wrapper's padding-box width and is unaffected by
  // the transform; the wrapper has no padding, so it is the column width.
  const width = wrapper.clientWidth;
  if (width <= 0) return null;
  const gap =
    Number.parseFloat(win.getComputedStyle(wrapper).columnGap) || 0;
  const step = width + gap;
  const sentinel = wrapper.querySelector(`[${SENTINEL_ATTR}]`);
  if (sentinel === null) return null;
  const extent =
    sentinel.getBoundingClientRect().left -
    wrapper.getBoundingClientRect().left;
  return { step, count: pageCountFromExtent(extent, step) };
}

/** The current page index stamped on the wrapper (0 when absent). */
export function currentPage(doc: Document): number {
  const raw = getPaginator(doc)?.getAttribute(PAGE_ATTR);
  const page = raw === null || raw === undefined ? 0 : Number.parseInt(raw, 10);
  return Number.isFinite(page) && page > 0 ? page : 0;
}

/**
 * Shows a page: clamps the index into the measured range, translates the
 * wrapper, and stamps the applied index. Re-measures when no geometry is
 * passed, so calling `applyPage(doc, currentPage(doc))` after a resize
 * re-snaps the layout under the new geometry. Returns the applied index
 * (0 when the document is not paginated / not laid out).
 */
export function applyPage(
  doc: Document,
  page: number,
  geometry?: PageGeometry | null,
): number {
  const wrapper = getPaginator(doc);
  if (wrapper === null) return 0;
  const geom = geometry ?? measurePageGeometry(doc);
  if (geom === null) return 0;
  const applied = clampPage(page, geom.count);
  wrapper.setAttribute(PAGE_ATTR, String(applied));
  wrapper.style.transform =
    applied === 0 ? "" : `translateX(${-applied * geom.step}px)`;
  return applied;
}

/**
 * Page index of the column containing an element (a fragment target),
 * from its horizontal offset within the wrapper. Both rects carry the
 * current translation, so the result is translation-independent. Returns
 * null when the document is not paginated or not laid out.
 */
export function pageForElement(doc: Document, el: Element): number | null {
  const wrapper = getPaginator(doc);
  const geom = measurePageGeometry(doc);
  if (wrapper === null || geom === null) return null;
  const offset =
    el.getBoundingClientRect().left - wrapper.getBoundingClientRect().left;
  return clampPage(pageFromOffset(offset, geom.step), geom.count);
}
