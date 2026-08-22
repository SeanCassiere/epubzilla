import { useMemo } from "react";
import { useReader, findLinear } from "../state/reader";
import { prepareChapterHtml } from "../lib/chapter";
import * as api from "../lib/api";

/**
 * The reading surface: current chapter in a sandboxed iframe plus minimal
 * spine navigation (M1.4 replaces/extends navigation with the TOC).
 *
 * Sandboxing: `sandbox=""` (no allow-scripts, no allow-same-origin) so book
 * markup can neither run script nor touch app state; book CSS stays inside
 * the iframe so it cannot leak into app chrome. `allow-popups` is left off
 * too — external links simply do nothing in M1.3.
 */
export function ReaderPane() {
  const { book, chapter, spineIndex, status, nextChapter, previousChapter } =
    useReader();

  const srcdoc = useMemo(() => {
    if (book === null || chapter === null) return null;
    const resource = book.resources.find((r) => r.id === chapter.resource);
    if (resource === undefined) return null;
    return prepareChapterHtml(chapter.content, resource.path, (path) =>
      api.resourceUrl(book.id, path),
    );
  }, [book, chapter]);

  if (book === null) {
    return (
      <section className="reader-pane">
        <p className="empty">No book open. Use “Open book…” to pick an EPUB.</p>
      </section>
    );
  }

  const hasPrevious = findLinear(book, spineIndex - 1, -1) !== -1;
  const hasNext = findLinear(book, spineIndex + 1, 1) !== -1;
  const linearCount = book.spine.filter((s) => s.linear).length;
  const linearPosition =
    spineIndex >= 0
      ? book.spine.slice(0, spineIndex + 1).filter((s) => s.linear).length
      : 0;

  return (
    <section className="reader-pane">
      <nav className="chapter-nav" aria-label="Chapter navigation">
        <button
          type="button"
          onClick={() => void previousChapter()}
          disabled={!hasPrevious || status === "loading-chapter"}
        >
          ← Previous
        </button>
        <span className="chapter-position">
          {linearPosition} / {linearCount}
        </span>
        <button
          type="button"
          onClick={() => void nextChapter()}
          disabled={!hasNext || status === "loading-chapter"}
        >
          Next →
        </button>
      </nav>
      {status === "loading-chapter" && (
        <p className="status" role="status">
          Loading chapter…
        </p>
      )}
      {srcdoc !== null && (
        <iframe
          className="chapter-frame"
          title="Chapter content"
          sandbox=""
          srcDoc={srcdoc}
        />
      )}
    </section>
  );
}
