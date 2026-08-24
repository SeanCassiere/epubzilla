import { useMemo, useRef, useState, type FormEvent } from "react";
import type { Book } from "@bindings/Book";
import type { NavPoint } from "@bindings/NavPoint";
import { useReader } from "../state/reader";
import { splitHref } from "../lib/toc";
import { useKeepCurrentVisible } from "../lib/sidebarScroll";

/**
 * Chapter management panel (M2.3): the spine in order, one row per item,
 * with add/remove/reorder affordances. Labels come from the nav tree where
 * a chapter's resource path is referenced (first match, document order),
 * falling back to the file stem of the resource path.
 *
 * Mutations flow through the reader-state helpers (applyEdit in
 * state/reader.tsx): the Book returned by the core is the truth, no
 * optimistic updates. EPUB 2 books are read-only (same convention as the
 * M2.2 metadata dialog), so the mutation affordances are hidden for them.
 */
export function ChapterPanel() {
  const { book, spineIndex, goTo, addChapter, removeChapter, moveSpineItem } =
    useReader();
  const [adding, setAdding] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  /** Spine item id awaiting removal confirmation (inline, no window.confirm). */
  const [confirming, setConfirming] = useState<string | null>(null);

  const labels = useMemo(
    () => (book === null ? new Map<string, string>() : navLabelsByPath(book.nav)),
    [book],
  );

  // Scroll rule (issue #89, see lib/sidebarScroll.ts): same behaviour as
  // TocSidebar — keep the current chapter visible with minimal movement
  // ONLY when it changes and is outside the panel viewport; never scroll
  // on clicks or (re)mount. Keyed by spine item id so reorders of other
  // rows do not count as a chapter change.
  const scrollerRef = useRef<HTMLElement | null>(null);
  const currentSpineId =
    book === null ? null : (book.spine[spineIndex]?.id ?? null);
  useKeepCurrentVisible(scrollerRef, currentSpineId);

  if (book === null) return null;
  const canEdit = book.epub_version !== "V2";

  const submitAdd = (event: FormEvent) => {
    event.preventDefault();
    const title = newTitle.trim();
    if (title === "") return;
    void addChapter(title).then((ok) => {
      if (ok) {
        setAdding(false);
        setNewTitle("");
      }
    });
  };

  return (
    <aside
      className="toc-sidebar chapter-panel"
      aria-label="Chapters"
      ref={scrollerRef}
    >
      <h2 className="toc-heading">Chapters</h2>
      <ol className="toc-list chapter-list">
        {book.spine.map((item, i) => {
          const label = spineItemLabel(book, i, labels);
          const isCurrent = i === spineIndex;
          return (
            <li key={item.id} aria-current={isCurrent ? "true" : undefined}>
              <div className={"toc-row" + (isCurrent ? " toc-current" : "")}>
                <button
                  type="button"
                  className="toc-link"
                  onClick={() => void goTo(i)}
                >
                  {label}
                </button>
                {!item.linear && (
                  <span className="chapter-badge">non-linear</span>
                )}
                {canEdit && (
                  <span className="chapter-actions">
                    <button
                      type="button"
                      className="chapter-action"
                      aria-label={`Move up: ${label}`}
                      disabled={i === 0}
                      onClick={() => void moveSpineItem(item.id, -1)}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      className="chapter-action"
                      aria-label={`Move down: ${label}`}
                      disabled={i === book.spine.length - 1}
                      onClick={() => void moveSpineItem(item.id, 1)}
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      className="chapter-action"
                      aria-label={`Remove: ${label}`}
                      onClick={() => setConfirming(item.id)}
                    >
                      ✕
                    </button>
                  </span>
                )}
              </div>
              {confirming === item.id && (
                <div className="chapter-confirm">
                  <span>Remove “{label}”?</span>
                  <button
                    type="button"
                    onClick={() => {
                      setConfirming(null);
                      void removeChapter(item.id);
                    }}
                  >
                    Confirm removal
                  </button>
                  <button type="button" onClick={() => setConfirming(null)}>
                    Cancel
                  </button>
                </div>
              )}
            </li>
          );
        })}
      </ol>
      {canEdit &&
        (adding ? (
          <form className="chapter-add" onSubmit={submitAdd}>
            <input
              aria-label="New chapter title"
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              autoFocus
            />
            <button type="submit">Add</button>
            <button
              type="button"
              onClick={() => {
                setAdding(false);
                setNewTitle("");
              }}
            >
              Cancel
            </button>
          </form>
        ) : (
          <button
            type="button"
            className="chapter-add-open"
            onClick={() => setAdding(true)}
          >
            Add chapter…
          </button>
        ))}
    </aside>
  );
}

/**
 * First nav label per resource path (fragments ignored, document order) —
 * the same "first match wins" rule findCurrentTocPath uses.
 */
function navLabelsByPath(
  nav: ReadonlyArray<NavPoint>,
  into: Map<string, string> = new Map(),
): Map<string, string> {
  for (const point of nav) {
    if (point.href !== null) {
      const { path } = splitHref(point.href);
      if (!into.has(path)) into.set(path, point.label);
    }
    navLabelsByPath(point.children, into);
  }
  return into;
}

/** `"OEBPS/text/ch1.xhtml"` -> `"ch1"`. */
function fileStem(path: string): string {
  const name = path.split("/").pop() ?? path;
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

function spineItemLabel(
  book: Book,
  index: number,
  labels: ReadonlyMap<string, string>,
): string {
  const item = book.spine[index];
  const resource = book.resources.find((r) => r.id === item.resource);
  if (resource === undefined) return item.resource;
  return labels.get(resource.path) ?? fileStem(resource.path);
}
