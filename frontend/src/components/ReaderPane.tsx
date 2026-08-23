import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useReader, findLinear } from "../state/reader";
import { prepareChapterHtml } from "../lib/chapter";
import {
  THEME_STORAGE_KEY,
  nextThemePreference,
  parseThemePreference,
  resolveReadingTheme,
  themePreferenceLabel,
  type ThemePreference,
} from "../lib/theme";
import {
  MODE_STORAGE_KEY,
  offsetForPage,
  pageAtOffset,
  pageCount,
  pageStep,
  parseReadingMode,
  readingModeLabel,
  toggleReadingMode,
  type ReadingMode,
} from "../lib/readingMode";
import { shouldHandleNavKey, splitHref } from "../lib/toc";
import { handleShortcutKeydown, onShortcut } from "../lib/shortcuts";
import * as api from "../lib/api";
import { EditorPane } from "./EditorPane";

/** Manifest media types rendered as chapters (inter-chapter link targets). */
const XHTML_MEDIA_TYPES: ReadonlySet<string> = new Set([
  "application/xhtml+xml",
  "text/html",
]);

/**
 * Delayed-spinner threshold (issue #56): chapter reads usually resolve in
 * ~1ms, so flashing "Loading chapter…" on every switch reads as flicker.
 * The indicator only appears when a load is still pending after this long.
 */
export const LOADING_INDICATOR_DELAY_MS = 150;

const DARK_SCHEME_QUERY = "(prefers-color-scheme: dark)";

/** Tracks the OS/app color scheme reactively (issue #78). */
function useSystemDark(): boolean {
  const [dark, setDark] = useState(
    () => window.matchMedia(DARK_SCHEME_QUERY).matches,
  );
  useEffect(() => {
    const media = window.matchMedia(DARK_SCHEME_QUERY);
    const onChange = (event: MediaQueryListEvent) => setDark(event.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);
  return dark;
}

/** Reading-theme preference persisted across sessions (issue #78). */
function useThemePreference(): [ThemePreference, () => void] {
  const [preference, setPreference] = useState<ThemePreference>(() => {
    try {
      return parseThemePreference(localStorage.getItem(THEME_STORAGE_KEY));
    } catch {
      return "auto";
    }
  });
  const cycle = useCallback(() => {
    setPreference((current) => {
      const next = nextThemePreference(current);
      try {
        localStorage.setItem(THEME_STORAGE_KEY, next);
      } catch {
        // Persistence is best-effort; the in-session state still applies.
      }
      return next;
    });
  }, []);
  return [preference, cycle];
}

/** Reading-mode preference persisted across sessions (issue #75). */
function useReadingMode(): [ReadingMode, () => void] {
  const [mode, setMode] = useState<ReadingMode>(() => {
    try {
      return parseReadingMode(localStorage.getItem(MODE_STORAGE_KEY));
    } catch {
      return "scrolled";
    }
  });
  const toggle = useCallback(() => {
    setMode((current) => {
      const next = toggleReadingMode(current);
      try {
        localStorage.setItem(MODE_STORAGE_KEY, next);
      } catch {
        // Persistence is best-effort; the in-session state still applies.
      }
      return next;
    });
  }, []);
  return [mode, toggle];
}

/**
 * Measures the paginated iframe body's page geometry (issue #75): one
 * page is one overflow column, so the step between page left edges is
 * the body's content-box width plus the column gap, and the page count
 * follows from the scrollable range. Returns null when the document has
 * no usable layout yet (e.g. zero-width during load).
 */
function measurePages(
  body: HTMLElement,
  win: Window,
): { step: number; count: number } | null {
  const style = win.getComputedStyle(body);
  const gap = Number.parseFloat(style.columnGap) || 0;
  const padLeft = Number.parseFloat(style.paddingLeft) || 0;
  const padRight = Number.parseFloat(style.paddingRight) || 0;
  const contentWidth = body.clientWidth - padLeft - padRight;
  if (contentWidth <= 0) return null;
  const step = pageStep(contentWidth, gap);
  return { step, count: pageCount(body.scrollWidth, body.clientWidth, step) };
}

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
    editing,
    startEditing,
  } = useReader();

  // Delayed loading indicator (issue #56): the previous chapter stays
  // rendered while the next loads (`chapter` is only replaced on resolve),
  // and the indicator appears only when the load outlasts the delay. The
  // timer restarts with the effect on any status change, so on rapid
  // successive switches only the load in flight counts, and it is cleared
  // on resolve and on unmount by the effect cleanup.
  const [showLoading, setShowLoading] = useState(false);
  useEffect(() => {
    if (status !== "loading-chapter") {
      setShowLoading(false);
      return;
    }
    const timer = window.setTimeout(
      () => setShowLoading(true),
      LOADING_INDICATOR_DELAY_MS,
    );
    return () => window.clearTimeout(timer);
  }, [status]);

  const frameRef = useRef<HTMLIFrameElement | null>(null);
  // Latest handlers for listeners attached to each new iframe document.
  const actionsRef = useRef({ goToResource, nextChapter, previousChapter });
  actionsRef.current = { goToResource, nextChapter, previousChapter };
  const fragmentRef = useRef(fragment);
  fragmentRef.current = fragment;

  // Reading theme (issue #78): auto follows the system scheme; the nav
  // toggle cycles auto -> light -> dark. The resolved theme feeds the
  // render-layer defaults only — author-styled books stay pinned light
  // inside prepareChapterHtml, and stored EPUB content is never touched.
  const systemDark = useSystemDark();
  const [themePreference, cycleThemePreference] = useThemePreference();
  const readingTheme = resolveReadingTheme(themePreference, systemDark);

  // Reading mode (issue #75): scrolled is the historical default;
  // paginated injects the multicol render layer into the srcdoc and the
  // parent drives page turns via body.scrollLeft. Like theming this is
  // presentation-only — stored EPUB content is never touched.
  const [readingMode, toggleMode] = useReadingMode();
  const modeRef = useRef(readingMode);
  modeRef.current = readingMode;
  // Set when a backward page turn leaves the chapter: the previous
  // chapter should open at its LAST page. Consumed on the next frame load.
  const openAtEndRef = useRef(false);

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
      readingTheme,
      readingMode,
    );
  }, [book, chapter, readingTheme, readingMode]);

  /**
   * Turn one page in paginated mode. At the chapter edges this crosses
   * into the neighboring chapter (backwards lands on its last page).
   */
  const turnPage = useCallback((delta: 1 | -1) => {
    const doc = frameRef.current?.contentDocument;
    const body = doc?.body;
    const win = doc?.defaultView;
    if (body === null || body === undefined || win === null || win === undefined) {
      return;
    }
    const pages = measurePages(body, win);
    if (pages === null) return;
    const target = pageAtOffset(body.scrollLeft, pages.step) + delta;
    if (target < 0) {
      openAtEndRef.current = true;
      void actionsRef.current.previousChapter();
      return;
    }
    if (target >= pages.count) {
      void actionsRef.current.nextChapter();
      return;
    }
    body.scrollLeft = offsetForPage(target, pages.step, pages.count);
  }, []);

  /**
   * Backward navigation for keys: previous page in paginated mode
   * (crossing chapters at page 0), previous chapter otherwise.
   */
  const navigateBack = useCallback(() => {
    if (modeRef.current === "paginated") turnPage(-1);
    else void actionsRef.current.previousChapter();
  }, [turnPage]);

  /** Forward counterpart of navigateBack. */
  const navigateForward = useCallback(() => {
    if (modeRef.current === "paginated") turnPage(1);
    else void actionsRef.current.nextChapter();
  }, [turnPage]);

  /**
   * Scroll the iframe to the current fragment, or back to the start.
   * Paginated mode positions horizontally: the page containing the
   * fragment target, the last page when a backward chapter cross is
   * pending (openAtEndRef), or page 0.
   */
  const applyScroll = useCallback(() => {
    const doc = frameRef.current?.contentDocument;
    if (doc === null || doc === undefined) return;
    const target = fragmentRef.current;
    const el =
      target === null
        ? null
        : (doc.getElementById(target) ??
          doc.querySelector(`a[name="${CSS.escape(target)}"]`));
    if (modeRef.current === "paginated") {
      const body = doc.body;
      const win = doc.defaultView;
      if (body === null || win === null) return;
      const pages = measurePages(body, win);
      if (pages === null) return;
      if (el !== null) {
        // Page index from the element's horizontal offset within the
        // body's content box (columns start at multiples of the step).
        const contentLeft =
          body.getBoundingClientRect().left +
          (Number.parseFloat(win.getComputedStyle(body).paddingLeft) || 0);
        const x =
          el.getBoundingClientRect().left - contentLeft + body.scrollLeft;
        body.scrollLeft = offsetForPage(
          Math.floor(x / pages.step),
          pages.step,
          pages.count,
        );
        return;
      }
      body.scrollLeft = openAtEndRef.current
        ? offsetForPage(pages.count - 1, pages.step, pages.count)
        : 0;
      return;
    }
    if (el !== null) {
      el.scrollIntoView({ block: "start" });
      return;
    }
    doc.defaultView?.scrollTo(0, 0);
  }, []);

  // Re-scroll when the fragment changes within an already-loaded chapter.
  useEffect(() => {
    applyScroll();
  }, [applyScroll, fragment, srcdoc]);

  /**
   * Each srcdoc load creates a fresh document: wire up link interception,
   * keyboard shortcuts, and paginated click page-turns inside it, then
   * position the scroll.
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
        if (link !== null && link !== undefined) {
          // Navigate the app, never the iframe.
          event.preventDefault();
          const { path, fragment: frag } = splitHref(link);
          void actionsRef.current.goToResource(path, frag);
          return;
        }
        // Paginated click page-turn (issue #75): outer thirds of the
        // viewport turn the page; the middle third stays inert so text
        // selection and in-page links behave normally.
        if (modeRef.current !== "paginated") return;
        if (target.closest("a") !== null) return;
        const selection = doc.defaultView?.getSelection();
        if (selection !== null && selection !== undefined && !selection.isCollapsed) {
          return;
        }
        const width = doc.defaultView?.innerWidth ?? 0;
        if (width <= 0) return;
        if (event.clientX >= (width * 2) / 3) turnPage(1);
        else if (event.clientX <= width / 3) turnPage(-1);
      },
      true,
    );
    doc.addEventListener("keydown", (event) => {
      // App shortcuts first (issue #74): keydown inside the sandboxed
      // iframe never bubbles to the parent window, so forward matches to
      // the shared bus here. A match consumes the key.
      handleShortcutKeydown(event);
      if (event.defaultPrevented) return;
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      const paginated = modeRef.current === "paginated";
      if (event.key === "ArrowLeft") {
        navigateBack();
      } else if (event.key === "ArrowRight") {
        navigateForward();
      } else if (
        paginated &&
        (event.key === "PageDown" || (event.key === " " && !event.shiftKey))
      ) {
        event.preventDefault();
        turnPage(1);
      } else if (
        paginated &&
        (event.key === "PageUp" || (event.key === " " && event.shiftKey))
      ) {
        event.preventDefault();
        turnPage(-1);
      }
    });
    applyScroll();
    // A pending "open at last page" (backward chapter cross) is satisfied
    // by the applyScroll above; clear it only once the new doc has loaded.
    openAtEndRef.current = false;
  }, [applyScroll, navigateBack, navigateForward, turnPage]);

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
        navigateBack();
      } else {
        navigateForward();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [navigateBack, navigateForward]);

  // Reader-owned app shortcuts (issue #74), from the shared bus (window or
  // iframe keydown, native menu accelerators): whole-chapter navigation
  // (Mod+Alt+Left/Right — chapter-level even in paginated mode, unlike the
  // plain arrows), layout toggle (Mod+Shift+L), theme cycle (Mod+Shift+T).
  useEffect(
    () =>
      onShortcut((action) => {
        switch (action) {
          case "prev-chapter":
            void actionsRef.current.previousChapter();
            break;
          case "next-chapter":
            void actionsRef.current.nextChapter();
            break;
          case "toggle-layout":
            toggleMode();
            break;
          case "cycle-theme":
            cycleThemePreference();
            break;
          default:
            break;
        }
      }),
    [toggleMode, cycleThemePreference],
  );

  // Paginated mode: a window resize reflows the columns, so re-snap the
  // horizontal offset to the nearest page boundary under the new geometry.
  useEffect(() => {
    if (readingMode !== "paginated") return;
    const onResize = () => {
      const doc = frameRef.current?.contentDocument;
      const body = doc?.body;
      const win = doc?.defaultView;
      if (body === null || body === undefined || win === null || win === undefined) {
        return;
      }
      const pages = measurePages(body, win);
      if (pages === null) return;
      body.scrollLeft = offsetForPage(
        pageAtOffset(body.scrollLeft, pages.step),
        pages.step,
        pages.count,
      );
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [readingMode]);

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
          title="Previous chapter (ArrowLeft; Ctrl/Cmd+Alt+ArrowLeft anywhere)"
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
          title="Next chapter (ArrowRight; Ctrl/Cmd+Alt+ArrowRight anywhere)"
        >
          Next →
        </button>
        <button
          type="button"
          className="theme-toggle"
          onClick={cycleThemePreference}
          title="Reading theme (Ctrl/Cmd+Shift+T): Auto follows the system; Light/Dark force a scheme. Books with their own styling always render light."
        >
          {themePreferenceLabel(themePreference)}
        </button>
        <button
          type="button"
          className="mode-toggle"
          onClick={toggleMode}
          title="Reading layout (Ctrl/Cmd+Shift+L): Scrolled is a continuous column; Paginated turns viewport-height pages (arrow keys, PageUp/Down, Space, or click near the left/right edge)."
        >
          {readingModeLabel(readingMode)}
        </button>
        {book.epub_version === "V3" && spineIndex >= 0 && !editing && (
          <button
            type="button"
            className="edit-toggle"
            onClick={startEditing}
            disabled={status === "loading-chapter"}
            title="Edit this chapter (Ctrl/Cmd+E)"
          >
            Edit
          </button>
        )}
      </nav>
      {editing && <EditorPane />}
      {!editing && showLoading && (
        <p className="status" role="status">
          Loading chapter…
        </p>
      )}
      {!editing && srcdoc !== null && (
        <iframe
          ref={frameRef}
          className={
            // Match the frame's own backdrop to the EFFECTIVE chapter
            // rendering (the marker prepareChapterHtml stamps on the
            // injected defaults), so chapter switches never flash the
            // opposite scheme behind the loading document.
            srcdoc.includes('data-epubzilla-theme="dark"')
              ? "chapter-frame chapter-frame-dark"
              : "chapter-frame"
          }
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
