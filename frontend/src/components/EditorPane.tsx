// Edit mode (M3.1, ADR-0007): the chapter buffer over CodeMirror.
//
// The buffer loads via read_chapter(prefer: Markdown): in-subset chapters
// edit as Markdown; out-of-subset chapters come back as Xhtml and edit in
// XML source mode with a notice (never lossy — content-roundtrip.md).
// Apply sends the buffer through write_chapter with the buffer's own
// format; the core does all Markdown↔XHTML conversion. Unapplied changes
// arm the reader's navigation guard: leaving the chapter (or edit mode)
// asks Apply / Discard / Cancel.
//
// M3.2: Markdown chapters get a [WYSIWYG | Markdown] mode switcher
// (WYSIWYG default, choice persisted per session). Both modes edit the SAME
// buffer string, so switching preserves content exactly and Apply sends an
// identical payload from either mode. Xhtml chapters keep source mode only.

import { useCallback, useEffect, useRef, useState } from "react";
import type { ContentFormat } from "@bindings/ContentFormat";
import { useReader, describeError } from "../state/reader";
import * as api from "../lib/api";
import { imageMarkdown, relativeResourcePath } from "../lib/editing";
import { resolveChapterUrl } from "../lib/chapter";
import { pickImageFile } from "../lib/dialog";
import { CodeEditor } from "./CodeEditor";
import { MilkdownEditor } from "./MilkdownEditor";

type PendingLeave = { resolve: (proceed: boolean) => void } | null;

type MarkdownMode = "wysiwyg" | "source";

// Session persistence for the Markdown mode choice (survives remounts, not
// meaningful across app restarts — sessionStorage scopes it naturally).
const MODE_KEY = "epubzilla.editor.markdownMode";

function storedMode(): MarkdownMode {
  try {
    return sessionStorage.getItem(MODE_KEY) === "source" ? "source" : "wysiwyg";
  } catch {
    return "wysiwyg";
  }
}

function storeMode(mode: MarkdownMode) {
  try {
    sessionStorage.setItem(MODE_KEY, mode);
  } catch {
    // Persistence is best-effort.
  }
}

export function EditorPane() {
  const {
    book,
    spineIndex,
    stopEditing,
    requestStopEditing,
    writeChapter,
    setNavGuard,
    setEditorBuffer,
    addResource,
  } = useReader();
  const resourceId = book?.spine[spineIndex]?.resource ?? null;
  const bookId = book?.id ?? null;
  const chapterPath =
    book?.resources.find((r) => r.id === resourceId)?.path ?? null;

  // Render-time URL resolver (#52): maps relative resource refs in the
  // buffer (e.g. `../images/x.png`) to epub:// asset-protocol URLs so
  // images display inside the editor — mirroring the Reader's rewrite
  // (prepareChapterHtml). Display only: the buffer and everything Apply
  // sends keep the relative path; epub:// URLs are never persisted.
  const resolveEditorUrl = useCallback(
    (src: string): string => {
      if (bookId === null || chapterPath === null) return src;
      const resolved = resolveChapterUrl(chapterPath, src);
      if (resolved === null) return src; // external/fragment/escaping: leave alone
      return api.resourceUrl(bookId, resolved.path) + resolved.suffix;
    },
    [bookId, chapterPath],
  );

  const [baseline, setBaseline] = useState<string | null>(null);
  const [buffer, setBuffer] = useState<string | null>(null);
  const [format, setFormat] = useState<ContentFormat>("Markdown");
  const [fallbackReason, setFallbackReason] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [applying, setApplying] = useState(false);
  const [pendingLeave, setPendingLeave] = useState<PendingLeave>(null);
  const [markdownMode, setMarkdownMode] = useState<MarkdownMode>(storedMode);

  const chooseMode = useCallback((mode: MarkdownMode) => {
    setMarkdownMode(mode);
    storeMode(mode);
  }, []);

  const modified = buffer !== null && buffer !== baseline;
  const modifiedRef = useRef(modified);
  modifiedRef.current = modified;

  // Load the chapter buffer, preferring Markdown (format tells us what we got).
  useEffect(() => {
    if (bookId === null || resourceId === null) return;
    let stale = false;
    setBaseline(null);
    setBuffer(null);
    setLoadError(null);
    api
      .readChapter(bookId, resourceId, "Markdown")
      .then((content) => {
        if (stale) return;
        setFormat(content.format);
        setFallbackReason(content.fallback_reason ?? null);
        setBaseline(content.content);
        setBuffer(content.content);
      })
      .catch((err) => {
        if (!stale) setLoadError(err);
      });
    return () => {
      stale = true;
    };
  }, [bookId, resourceId]);

  // Arm the navigation guard while mounted: unapplied changes require an
  // explicit Apply / Discard / Cancel choice before leaving the chapter.
  useEffect(() => {
    setNavGuard(() => {
      if (!modifiedRef.current) return Promise.resolve(true);
      return new Promise<boolean>((resolve) => {
        setPendingLeave({ resolve });
      });
    });
    return () => setNavGuard(null);
  }, [setNavGuard]);

  const apply = useCallback(async (): Promise<boolean> => {
    if (buffer === null || resourceId === null) return false;
    setApplying(true);
    try {
      const ok = await writeChapter({
        resource: resourceId,
        format,
        content: buffer,
      });
      if (ok) setBaseline(buffer);
      return ok;
    } finally {
      setApplying(false);
    }
  }, [buffer, resourceId, format, writeChapter]);

  // Register the live buffer with the reader (M3.3) so the Header's
  // unified save flow (Cmd/Ctrl+S) and unsaved-changes guard can apply or
  // account for unapplied changes. Methods read refs, so one registration
  // stays current for the pane's lifetime.
  const applyRef = useRef(apply);
  applyRef.current = apply;
  useEffect(() => {
    setEditorBuffer({
      modified: () => modifiedRef.current,
      apply: () => applyRef.current(),
    });
    return () => setEditorBuffer(null);
  }, [setEditorBuffer]);

  const resolveLeave = useCallback(
    (proceed: boolean) => {
      pendingLeave?.resolve(proceed);
      setPendingLeave(null);
    },
    [pendingLeave],
  );

  // Insert-image plumbing (M3.3): the active surface registers a
  // cursor-aware inserter; picking a file adds the resource to the book
  // and drops a Markdown image reference into the buffer.
  const insertImageRef = useRef<((src: string) => void) | null>(null);
  const handleInsertImage = useCallback(async () => {
    if (book === null || resourceId === null) return;
    const osPath = await pickImageFile();
    if (osPath === null) return;
    const known = new Set(book.resources.map((r) => r.id));
    const updated = await addResource(osPath);
    if (updated === null) return;
    // The one resource we didn't know before is the added image.
    const added = updated.resources.find((r) => !known.has(r.id));
    const chapterPath = updated.resources.find(
      (r) => r.id === resourceId,
    )?.path;
    if (added === undefined || chapterPath === undefined) return;
    const reference = relativeResourcePath(chapterPath, added.path);
    const insert = insertImageRef.current;
    if (insert !== null) {
      insert(reference);
    } else {
      // Surface not ready: append at the end rather than dropping the ref.
      setBuffer((current) =>
        current === null
          ? current
          : `${current}\n\n${imageMarkdown(reference)}\n`,
      );
    }
  }, [book, resourceId, addResource]);

  if (loadError !== null) {
    return (
      <div className="editor-pane">
        <p className="error" role="alert">
          Could not load chapter for editing: {describeError(loadError)}
        </p>
        <button type="button" onClick={() => void stopEditing()}>
          Back to reading
        </button>
      </div>
    );
  }

  return (
    <div className="editor-pane">
      <div className="editor-toolbar">
        {format === "Markdown" ? (
          <div
            className="editor-mode-switch"
            role="group"
            aria-label="Editing mode"
          >
            <button
              type="button"
              aria-pressed={markdownMode === "wysiwyg"}
              onClick={() => chooseMode("wysiwyg")}
            >
              WYSIWYG
            </button>
            <button
              type="button"
              aria-pressed={markdownMode === "source"}
              onClick={() => chooseMode("source")}
            >
              Markdown
            </button>
          </div>
        ) : (
          <span className="editor-mode">XHTML source</span>
        )}
        {format === "Xhtml" && (
          <span className="editor-notice">
            This chapter uses markup outside the Markdown subset
            {fallbackReason !== null && <> ({fallbackReason})</>}, so it is
            edited as XHTML source to avoid losing anything.
          </span>
        )}
        {format === "Markdown" && markdownMode === "source" && (
          <button
            type="button"
            onClick={() => void handleInsertImage()}
            title="Add an image to the book and reference it at the cursor"
          >
            Insert image…
          </button>
        )}
        <span className="editor-toolbar-spacer" />
        <button
          type="button"
          onClick={() => void apply()}
          disabled={!modified || applying}
          title="Write the buffer into the book (book still needs saving; Ctrl/Cmd+S saves everything)"
        >
          Apply
        </button>
        <button
          type="button"
          onClick={() => void requestStopEditing()}
          title="Back to reading (Ctrl/Cmd+E)"
        >
          Done
        </button>
      </div>
      {buffer === null ? (
        <p className="status" role="status">
          Loading chapter…
        </p>
      ) : format === "Markdown" && markdownMode === "wysiwyg" ? (
        <MilkdownEditor
          value={buffer}
          onChange={setBuffer}
          insertImageRef={insertImageRef}
          onInsertImage={() => void handleInsertImage()}
          resolveUrl={resolveEditorUrl}
        />
      ) : (
        <CodeEditor
          value={buffer}
          language={format === "Markdown" ? "markdown" : "xml"}
          onChange={setBuffer}
          insertImageRef={format === "Markdown" ? insertImageRef : undefined}
        />
      )}
      {pendingLeave !== null && (
        <div className="modal-overlay">
          <div className="modal" role="dialog" aria-label="Unapplied changes">
            <h2 className="modal-title">Unapplied changes</h2>
            <p>This chapter has changes that haven’t been applied.</p>
            <div className="modal-actions">
              <button
                type="button"
                disabled={applying}
                onClick={() => {
                  void apply().then((ok) => resolveLeave(ok));
                }}
              >
                Apply &amp; continue
              </button>
              <button type="button" onClick={() => resolveLeave(true)}>
                Discard changes
              </button>
              <button type="button" onClick={() => resolveLeave(false)}>
                Keep editing
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
