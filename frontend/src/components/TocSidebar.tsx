import { useMemo, useState } from "react";
import type { NavPoint } from "@bindings/NavPoint";
import { useReader } from "../state/reader";
import {
  ancestorKeys,
  findCurrentTocPath,
  isNodeExpanded,
  pathKey,
  splitHref,
} from "../lib/toc";

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

  if (book === null || book.nav.length === 0) return null;

  const toggle = (key: string, expanded: boolean) => {
    setManual((prev) => new Map(prev).set(key, expanded));
  };

  return (
    <aside className="toc-sidebar" aria-label="Table of contents">
      <h2 className="toc-heading">Contents</h2>
      <ul className="toc-list" role="tree">
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
            ref={
              isCurrent
                ? (el) => el?.scrollIntoView({ block: "nearest" })
                : undefined
            }
            onClick={() => onNavigate(point.href as string)}
          >
            {point.label}
          </button>
        ) : (
          // Section header without a target: the label itself toggles.
          <button
            type="button"
            className="toc-link toc-section"
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
