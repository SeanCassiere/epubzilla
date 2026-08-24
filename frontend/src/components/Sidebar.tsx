import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useReader } from "../state/reader";
import { resourceUrl } from "../lib/api";
import { onShortcut } from "../lib/shortcuts";
import { TocSidebar } from "./TocSidebar";
import { ChapterPanel } from "./ChapterPanel";
import { ValidationPanel } from "./ValidationPanel";

type Tab = "contents" | "chapters" | "checks";

/**
 * Sidebar column with three tabs: "Contents" is the M1.4 TOC tree
 * (unchanged), "Chapters" is the M2.3 chapter management panel, "Checks"
 * is the issue #72 validation panel. Mounted keyed by book.id (App.tsx)
 * so tab choice and TOC expansion reset per book; only the active panel
 * is mounted, but each panel's scroll offset is saved before a tab switch
 * and restored after remount so the offsets stay independent (issue #89,
 * rule documented in lib/sidebarScroll.ts).
 */
export function Sidebar() {
  const { book } = useReader();
  const [tab, setTab] = useState<Tab>("contents");

  // Per-tab scroll offsets (issue #89). Every panel's root element is the
  // `.toc-sidebar` scroll container inside the focus wrapper.
  const scrollOffsets = useRef(new Map<Tab, number>());
  const tabRef = useRef<Tab>(tab);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const panelScroller = () =>
    rootRef.current?.querySelector<HTMLElement>(
      ".sidebar-panel-focus > .toc-sidebar",
    ) ?? null;
  const selectTab = useCallback((next: Tab) => {
    const prev = tabRef.current;
    if (next === prev) return;
    const scroller = panelScroller();
    if (scroller !== null) scrollOffsets.current.set(prev, scroller.scrollTop);
    tabRef.current = next;
    setTab(next);
  }, []);
  useLayoutEffect(() => {
    const saved = scrollOffsets.current.get(tab);
    if (saved === undefined) return; // never visited: keep the natural top
    const scroller = panelScroller();
    if (scroller !== null) scroller.scrollTop = saved;
  }, [tab]);

  // Sidebar shortcuts (issue #74): Mod+1/2/3 select a tab AND move focus
  // into its panel so the keyboard lands where the eyes do (the TOC tree
  // focuses its current entry; other panels focus their first control).
  useEffect(
    () =>
      onShortcut((action) => {
        const target: Tab | null =
          action === "sidebar-contents"
            ? "contents"
            : action === "sidebar-chapters"
              ? "chapters"
              : action === "sidebar-checks"
                ? "checks"
                : null;
        if (target === null) return;
        selectTab(target);
        // Focus after the panel for the (possibly new) tab has mounted.
        requestAnimationFrame(() => {
          const root = rootRef.current;
          if (root === null) return;
          const el = root.querySelector<HTMLElement>(
            ".toc-current .toc-link, " +
              ".sidebar-panel-focus button, .sidebar-panel-focus a[href], " +
              ".sidebar-panel-focus input, .sidebar-panel-focus select",
          );
          el?.focus();
        });
      }),
    [selectTab],
  );

  if (book === null) return null;

  const tabButton = (id: Tab, label: string) => (
    <button
      type="button"
      role="tab"
      aria-selected={tab === id}
      className={"sidebar-tab" + (tab === id ? " sidebar-tab-active" : "")}
      onClick={() => selectTab(id)}
    >
      {label}
    </button>
  );

  // Current cover (issue #73), shown above the tabs when the book has one.
  const cover =
    book.metadata.cover_resource !== null
      ? (book.resources.find((r) => r.id === book.metadata.cover_resource) ??
        null)
      : null;

  return (
    <div className="sidebar" ref={rootRef}>
      {/* Overlay-titlebar inset (issue #61): reserves the traffic-light
          zone at the top of the sidebar on macOS (zero height elsewhere)
          and doubles as a window drag handle. */}
      <div className="titlebar-drag-zone" data-tauri-drag-region />
      {cover !== null && (
        <img
          className="sidebar-cover"
          src={resourceUrl(book.id, cover.path)}
          alt={`Cover of ${book.metadata.title}`}
        />
      )}
      <div className="sidebar-tabs" role="tablist" aria-label="Sidebar panels">
        {tabButton("contents", "Contents")}
        {tabButton("chapters", "Chapters")}
        {tabButton("checks", "Checks")}
      </div>
      <div className="sidebar-panel-focus">
        {tab === "contents" ? (
          <TocSidebar />
        ) : tab === "chapters" ? (
          <ChapterPanel />
        ) : (
          <ValidationPanel />
        )}
      </div>
    </div>
  );
}
