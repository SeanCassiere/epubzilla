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
import { shouldHandleNavKey } from "../lib/toc";
import { handleChapterClick } from "../lib/chapterClick";
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
    );
  }, [book, chapter, readingTheme]);

  /** Backward navigation for keys. */
  const navigateBack = useCallback(() => {
    void actionsRef.current.previousChapter();
  }, []);

  /** Forward counterpart of navigateBack. */
  const navigateForward = useCallback(() => {
    void actionsRef.current.nextChapter();
  }, []);

  /** Scroll the iframe to the current fragment, or back to the start. */
  const applyScroll = useCallback(() => {
    const doc = frameRef.current?.contentDocument;
    if (doc === null || doc === undefined) return;
    const target = fragmentRef.current;
    const el =
      target === null
        ? null
        : (doc.getElementById(target) ??
          doc.querySelector(`a[name="${CSS.escape(target)}"]`));
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
   * Each srcdoc load creates a fresh document: wire up link interception
   * and keyboard shortcuts inside it, then position the scroll.
   */
  const handleFrameLoad = useCallback(() => {
    const doc = frameRef.current?.contentDocument;
    if (doc === null || doc === undefined) return;
    doc.addEventListener(
      "click",
      (event) => {
        // event.target belongs to the IFRAME's realm — all target checks
        // live in handleChapterClick, which is realm-agnostic (issue #84:
        // a parent-realm `instanceof Element` guard here silently killed
        // link interception and let the sandboxed frame navigate itself).
        handleChapterClick(event, {
          goToResource: (path, frag) => {
            void actionsRef.current.goToResource(path, frag);
          },
        });
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
      if (event.key === "ArrowLeft") {
        navigateBack();
      } else if (event.key === "ArrowRight") {
        navigateForward();
      }
    });
    applyScroll();
  }, [applyScroll, navigateBack, navigateForward]);

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
  // (Mod+Alt+Left/Right), theme cycle (Mod+Shift+T).
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
          case "cycle-theme":
            cycleThemePreference();
            break;
          default:
            break;
        }
      }),
    [cycleThemePreference],
  );

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
