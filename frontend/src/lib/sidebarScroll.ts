// Sidebar panel scroll rule (issue #89), applied identically to the
// Contents (TocSidebar) and Chapters (ChapterPanel) panels:
//
// 1. Each panel keeps an INDEPENDENT scroll offset that survives sidebar
//    tab switches verbatim (Sidebar saves the outgoing panel's scrollTop
//    before a switch and restores the incoming panel's after it mounts).
// 2. A panel never scrolls in response to clicks or re-renders. It scrolls
//    only when the current chapter actually CHANGES and the current entry
//    is outside the panel's visible viewport — and then minimally, with
//    scrollIntoView({ block: "nearest" }). Clicking an entry that is
//    already visible therefore never repositions the panel.
// 3. On (re)mount a panel does not auto-scroll at all: the user's last
//    offset (restored by Sidebar) or the top for a fresh book stands.

import { useEffect, useRef, type RefObject } from "react";

/** True when `item` sits entirely inside `container`'s visible viewport. */
export function isFullyVisible(container: Element, item: Element): boolean {
  const c = container.getBoundingClientRect();
  const r = item.getBoundingClientRect();
  return r.top >= c.top && r.bottom <= c.bottom;
}

/**
 * Shared "keep the current chapter visible" behaviour (rule 2 above).
 * `currentKey` identifies the current chapter; when it changes — not on
 * mount, not on unrelated re-renders — and the `.toc-current` row inside
 * `scroller` is outside the visible viewport, the row is brought into view
 * with minimal movement. Both sidebar panels use this hook so Previous/
 * Next and direct navigation behave the same way in each.
 */
export function useKeepCurrentVisible(
  scroller: RefObject<HTMLElement | null>,
  currentKey: string | null,
): void {
  // `undefined` marks "no run yet" so a (re)mount never scrolls (rule 3);
  // `null` is a real value meaning "no current chapter".
  const previous = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    const before = previous.current;
    previous.current = currentKey;
    if (before === undefined) return; // first run after (re)mount
    if (currentKey === null || currentKey === before) return;
    const container = scroller.current;
    if (container === null) return;
    const item = container.querySelector<HTMLElement>(".toc-current");
    if (item === null || isFullyVisible(container, item)) return;
    item.scrollIntoView({ block: "nearest" });
  }, [scroller, currentKey]);
}
