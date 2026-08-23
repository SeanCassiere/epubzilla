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
  const { book, spineIndex, stopEditing, writeChapter, setNavGuard } =
    useReader();
  const resourceId = book?.spine[spineIndex]?.resource ?? null;
  const bookId = book?.id ?? null;

  const [baseline, setBaseline] = useState<string | null>(null);
  const [buffer, setBuffer] = useState<string | null>(null);
  const [format, setFormat] = useState<ContentFormat>("Markdown");
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

  const resolveLeave = useCallback(
    (proceed: boolean) => {
      pendingLeave?.resolve(proceed);
      setPendingLeave(null);
    },
    [pendingLeave],
  );

  /** "Done": back to reading — via the same guard when modified. */
  const requestClose = useCallback(() => {
    if (!modifiedRef.current) {
      void stopEditing();
      return;
    }
    setPendingLeave({
      resolve: (proceed) => {
        if (proceed) void stopEditing();
      },
    });
  }, [stopEditing]);

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
            This chapter uses markup outside the Markdown subset, so it is
            edited as XHTML source to avoid losing anything.
          </span>
        )}
        <span className="editor-toolbar-spacer" />
        <button
          type="button"
          onClick={() => void apply()}
          disabled={!modified || applying}
          title="Write the buffer into the book (book still needs saving)"
        >
          Apply
        </button>
        <button type="button" onClick={requestClose}>
          Done
        </button>
      </div>
      {buffer === null ? (
        <p className="status" role="status">
          Loading chapter…
        </p>
      ) : format === "Markdown" && markdownMode === "wysiwyg" ? (
        <MilkdownEditor value={buffer} onChange={setBuffer} />
      ) : (
        <CodeEditor
          value={buffer}
          language={format === "Markdown" ? "markdown" : "xml"}
          onChange={setBuffer}
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
