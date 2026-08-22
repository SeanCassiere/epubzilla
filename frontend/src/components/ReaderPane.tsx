import { useCallback, useEffect, useMemo, useRef } from "react";
import { useReader, findLinear } from "../state/reader";
import { prepareChapterHtml } from "../lib/chapter";
import { shouldHandleNavKey, splitHref } from "../lib/toc";
import * as api from "../lib/api";

/** Manifest media types rendered as chapters (inter-chapter link targets). */
const XHTML_MEDIA_TYPES: ReadonlySet<string> = new Set([
  "application/xhtml+xml",
  "text/html",
]);

/**
 * The reading surface: current chapter in a sandboxed iframe plus spine
 * navigation (previous/next, position, ArrowLeft/ArrowRight shortcuts).
 *
 * Sandboxing (M1.4 tradeoff): `sandbox="allow-same-origin"` WITHOUT
 * `allow-scripts`. Nothing can execute inside the frame — the sandbox
 * denies script execution, and prepareChapterHtml strips <script>, on*
 * handlers, and javascript: URLs as defense in depth — so granting
 * same-origin is safe and is what lets the parent reach
 * `iframe.contentDocument` to scroll to `#fragment` targets, reset scroll
 * on chapter change, and intercept clicks on inter-chapter links.
 * `allow-popups` stays off: external links cannot open windows (their
 * hrefs are also stripped and surfaced via title=).
 */
export function ReaderPane() {
  const {
    book,
    chapter,
    fragment,
    spineIndex,
    status,
    goToResource,
    nextChapter,
    previousChapter,
  } = useReader();

  const frameRef = useRef<HTMLIFrameElement | null>(null);
  // Latest handlers for listeners attached to each new iframe document.
  const actionsRef = useRef({ goToResource, nextChapter, previousChapter });
  actionsRef.current = { goToResource, nextChapter, previousChapter };
  const fragmentRef = useRef(fragment);
  fragmentRef.current = fragment;

  const srcdoc = useMemo(() => {
    if (book === null || chapter === null) return null;
    const resource = book.resources.find((r) => r.id === chapter.resource);
    if (resource === undefined) return null;
    const xhtmlPaths = new Set(
      book.resources
        .filter((r) => XHTML_MEDIA_TYPES.has(r.media_type))
        .map((r) => r.path),
    );
    return prepareChapterHtml(
      chapter.content,
      resource.path,
      (path) => api.resourceUrl(book.id, path),
      xhtmlPaths,
    );
  }, [book, chapter]);

  /** Scroll the iframe to the current fragment, or back to the top. */
  const applyScroll = useCallback(() => {
    const doc = frameRef.current?.contentDocument;
    if (doc === null || doc === undefined) return;
    const target = fragmentRef.current;
    if (target !== null) {
      const el =
        doc.getElementById(target) ??
        doc.querySelector(`a[name="${CSS.escape(target)}"]`);
      if (el !== null) {
        el.scrollIntoView({ block: "start" });
        return;
      }
    }
    doc.defaultView?.scrollTo(0, 0);
  }, []);

  // Re-scroll when the fragment changes within an already-loaded chapter.
  useEffect(() => {
    applyScroll();
  }, [applyScroll, fragment, srcdoc]);

  /**
   * Each srcdoc load creates a fresh document: wire up link interception
   * and keyboard shortcuts inside it, then position the scroll.
   */
  const handleFrameLoad = useCallback(() => {
    const doc = frameRef.current?.contentDocument;
    if (doc === null || doc === undefined) return;
    doc.addEventListener(
      "click",
      (event) => {
        const target = event.target;
        if (!(target instanceof Element)) return;
        const anchor = target.closest("a[data-epub-link]");
        const link = anchor?.getAttribute("data-epub-link");
        if (link === null || link === undefined) return;
        // Navigate the app, never the iframe.
        event.preventDefault();
        const { path, fragment: frag } = splitHref(link);
        void actionsRef.current.goToResource(path, frag);
      },
      true,
    );
    doc.addEventListener("keydown", (event) => {
      if (event.key === "ArrowLeft") {
        void actionsRef.current.previousChapter();
      } else if (event.key === "ArrowRight") {
        void actionsRef.current.nextChapter();
      }
    });
    applyScroll();
  }, [applyScroll]);

  // App-level ArrowLeft/ArrowRight shortcuts (skipped in text inputs).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      const target = event.target;
      const el = target instanceof HTMLElement ? target : null;
      if (!shouldHandleNavKey(el?.tagName ?? null, el?.isContentEditable ?? false)) {
        return;
      }
      if (event.key === "ArrowLeft") {
        void actionsRef.current.previousChapter();
      } else {
        void actionsRef.current.nextChapter();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

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
          title="Previous chapter (ArrowLeft)"
        >
          ← Previous
        </button>
        <span className="chapter-position">
          chapter {linearPosition} of {linearCount}
        </span>
        <button
          type="button"
          onClick={() => void nextChapter()}
          disabled={!hasNext || status === "loading-chapter"}
          title="Next chapter (ArrowRight)"
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
          ref={frameRef}
          className="chapter-frame"
          title="Chapter content"
          // Same-origin, NO scripts: see the component doc comment.
          sandbox="allow-same-origin"
          srcDoc={srcdoc}
          onLoad={handleFrameLoad}
        />
      )}
    </section>
  );
}
