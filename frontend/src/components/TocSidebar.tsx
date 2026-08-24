import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { NavPoint } from "@bindings/NavPoint";
import { useReader } from "../state/reader";
import {
  ancestorKeys,
  findCurrentTocPath,
  isNodeExpanded,
  parentKey,
  pathKey,
  splitHref,
  tocKeyIntent,
} from "../lib/toc";
import { useKeepCurrentVisible } from "../lib/sidebarScroll";

/**
 * Collapsible TOC tree over `Book.nav`. Section headers (href === null)
 * are expandable labels; entries with an href navigate via goToResource.
 *
 * Performance: children of collapsed nodes are NOT mounted, and only
 * depth-0 nodes start expanded, so a 500-chapter book renders a shallow
 * tree until the user (or current-position auto-expansion) opens branches.
 * Mount keyed by book.id (App.tsx) so manual toggles reset per book.
 */
export function TocSidebar() {
  const { book, spineIndex, goToResource } = useReader();
  // Explicit user toggles; they override the default/auto expansion.
  const [manual, setManual] = useState<ReadonlyMap<string, boolean>>(
    () => new Map(),
  );

  const currentResourcePath = useMemo(() => {
    if (book === null || spineIndex < 0) return null;
    const item = book.spine[spineIndex];
    if (item === undefined) return null;
    return (
      book.resources.find((r) => r.id === item.resource)?.path ?? null
    );
  }, [book, spineIndex]);

  const currentTocPath = useMemo(
    () =>
      book === null || currentResourcePath === null
        ? null
        : findCurrentTocPath(book.nav, currentResourcePath),
    [book, currentResourcePath],
  );
  const currentKey = currentTocPath === null ? null : pathKey(currentTocPath);
  const autoExpanded = useMemo(
    () =>
      new Set(currentTocPath === null ? [] : ancestorKeys(currentTocPath)),
    [currentTocPath],
  );

  // Tree keyboard navigation (issue #74): standard tree-view keys over the
  // VISIBLE rows (collapsed subtrees are unmounted, so a DOM query in
  // document order is exactly the visible list). Handled on the tree root
  // via bubbling; stopPropagation keeps ArrowLeft/Right away from the
  // reader's chapter-nav listener while focus is in the tree.
  const treeRef = useRef<HTMLUListElement | null>(null);

  // Scroll rule (issue #89, see lib/sidebarScroll.ts): keep the current
  // entry visible with minimal movement ONLY when the chapter changes and
  // it is outside the panel viewport; never scroll on clicks or (re)mount.
  const scrollerRef = useRef<HTMLElement | null>(null);
  useKeepCurrentVisible(scrollerRef, currentKey);

  if (book === null || book.nav.length === 0) return null;

  const toggle = (key: string, expanded: boolean) => {
    setManual((prev) => new Map(prev).set(key, expanded));
  };

  const handleTreeKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const intent = tocKeyIntent(event.key);
    const tree = treeRef.current;
    if (intent === null || tree === null) return;
    const rows = Array.from(
      tree.querySelectorAll<HTMLElement>("[data-toc-key]"),
    );
    if (rows.length === 0) return;
    event.preventDefault();
    event.stopPropagation();
    const index = rows.indexOf(document.activeElement as HTMLElement);
    const focusAt = (i: number) =>
      rows[Math.max(0, Math.min(rows.length - 1, i))].focus();
    switch (intent) {
      case "next":
        focusAt(index + 1); // index -1 (nothing focused) lands on row 0
        return;
      case "previous":
        focusAt(index <= 0 ? 0 : index - 1);
        return;
      case "first":
        focusAt(0);
        return;
      case "last":
        focusAt(rows.length - 1);
        return;
      case "expand-or-next": {
        if (index === -1) return focusAt(0);
        const row = rows[index];
        if (row.dataset.hasChildren === "true") {
          if (row.dataset.expanded !== "true") {
            toggle(row.dataset.tocKey as string, true);
            return;
          }
          return focusAt(index + 1); // already open: enter the subtree
        }
        return;
      }
      case "collapse-or-parent": {
        if (index === -1) return focusAt(0);
        const row = rows[index];
        if (row.dataset.expanded === "true") {
          toggle(row.dataset.tocKey as string, false);
          return;
        }
        const parent = parentKey(row.dataset.tocKey as string);
        if (parent === null) return;
        const parentRow = tree.querySelector<HTMLElement>(
          `[data-toc-key="${parent}"]`,
        );
        parentRow?.focus();
        return;
      }
    }
  };

  return (
    <aside
      className="toc-sidebar"
      aria-label="Table of contents"
      ref={scrollerRef}
    >
      <h2 className="toc-heading">Contents</h2>
      <ul
        className="toc-list"
        role="tree"
        ref={treeRef}
        onKeyDown={handleTreeKeyDown}
      >
        {book.nav.map((point, i) => (
          <TocNode
            key={i}
            point={point}
            path={[i]}
            depth={0}
            manual={manual}
            autoExpanded={autoExpanded}
            currentKey={currentKey}
            onToggle={toggle}
            onNavigate={(href) => {
              const { path, fragment } = splitHref(href);
              void goToResource(path, fragment);
            }}
          />
        ))}
      </ul>
    </aside>
  );
}

interface TocNodeProps {
  point: NavPoint;
  path: number[];
  depth: number;
  manual: ReadonlyMap<string, boolean>;
  autoExpanded: ReadonlySet<string>;
  currentKey: string | null;
  onToggle: (key: string, expanded: boolean) => void;
  onNavigate: (href: string) => void;
}

function TocNode({
  point,
  path,
  depth,
  manual,
  autoExpanded,
  currentKey,
  onToggle,
  onNavigate,
}: TocNodeProps) {
  const key = pathKey(path);
  const hasChildren = point.children.length > 0;
  const expanded =
    hasChildren && isNodeExpanded(key, depth, manual, autoExpanded);
  const isCurrent = currentKey === key;

  return (
    <li
      role="treeitem"
      aria-expanded={hasChildren ? expanded : undefined}
      aria-current={isCurrent ? "true" : undefined}
    >
      <div className={"toc-row" + (isCurrent ? " toc-current" : "")}>
        {hasChildren && (
          <button
            type="button"
            className="toc-caret"
            aria-label={expanded ? "Collapse section" : "Expand section"}
            onClick={() => onToggle(key, !expanded)}
          >
            {expanded ? "▾" : "▸"}
          </button>
        )}
        {point.href !== null ? (
          <button
            type="button"
            className="toc-link"
            data-toc-key={key}
            data-has-children={hasChildren ? "true" : "false"}
            data-expanded={expanded ? "true" : "false"}
            onClick={() => onNavigate(point.href as string)}
          >
            {point.label}
          </button>
        ) : (
          // Section header without a target: the label itself toggles.
          <button
            type="button"
            className="toc-link toc-section"
            data-toc-key={key}
            data-has-children={hasChildren ? "true" : "false"}
            data-expanded={expanded ? "true" : "false"}
            onClick={hasChildren ? () => onToggle(key, !expanded) : undefined}
          >
            {point.label}
          </button>
        )}
      </div>
      {/* Lazy subtree: collapsed children are never mounted. */}
      {expanded && (
        <ul className="toc-list" role="group">
          {point.children.map((child, i) => (
            <TocNode
              key={i}
              point={child}
              path={[...path, i]}
              depth={depth + 1}
              manual={manual}
              autoExpanded={autoExpanded}
              currentKey={currentKey}
              onToggle={onToggle}
              onNavigate={onNavigate}
            />
          ))}
        </ul>
      )}
    </li>
  );
}
