import { useEffect, useRef, useState } from "react";
import { useReader } from "../state/reader";
import { useLifecycle } from "../state/lifecycle";
import { beginTitlebarDrag } from "../lib/window";
import { isMacOS } from "../lib/platform";
import { onShortcut } from "../lib/shortcuts";
import { Modal } from "./Modal";
import { MetadataForm } from "./MetadataForm";
import { CoverPicker } from "./CoverPicker";

/**
 * App chrome header: book identity (title, unsaved and "Not saved" state,
 * authors), activity status, and the document actions. Open / New / Save
 * go through the lifecycle controller (state/lifecycle.tsx) like every
 * other entry point; with no book open the welcome panel carries Open and
 * New instead.
 */
export function Header() {
  const {
    book,
    updateMetadata,
    editing,
    startEditing,
    requestStopEditing,
    editorDirty,
  } = useReader();
  const { busy, activityLabel, requestOpen, requestNew, save } = useLifecycle();
  const [editingMetadata, setEditingMetadata] = useState(false);

  // Header-owned shortcut (issue #74): Mod+E toggles edit mode (leaving
  // goes through the editor's guard). File actions (open/new/close/save)
  // are handled by the lifecycle controller. The subscriber registers once
  // and reads refs so rapid toggles never hit a stale closure.
  const editRef = useRef({ editing, startEditing, requestStopEditing });
  editRef.current = { editing, startEditing, requestStopEditing };
  useEffect(
    () =>
      onShortcut((action) => {
        if (action !== "toggle-edit") return;
        const current = editRef.current;
        if (current.editing) {
          void current.requestStopEditing();
        } else {
          current.startEditing(); // self-guards: EPUB 3 + chapter open
        }
      }),
    [],
  );

  // EPUB 2 books are read-only (mutations return UnsupportedFeature); the
  // editing and saving affordances are disabled up front.
  const isEpub2 = book !== null && book.epub_version === "V2";
  const unsaved = book !== null && (book.dirty || editorDirty);

  return (
    // With the macOS overlay titlebar (issue #61) the whole header is the
    // window drag surface — beginTitlebarDrag ignores mousedowns on the
    // buttons/inputs/modals inside, so those keep working normally.
    <header
      className="app-header"
      onMouseDown={isMacOS() ? beginTitlebarDrag : undefined}
    >
      <div className="app-header-main">
        <h1 className="app-title">epubzilla</h1>
        {book !== null && (
          <div className="book-identity">
            <span
              className="book-title"
              title={book.source ?? "Not saved yet"}
            >
              {book.metadata.title}
            </span>
            {unsaved && (
              <span
                className="dirty-indicator"
                role="status"
                aria-label="(unsaved changes)"
                title="Unsaved changes"
              >
                ●
              </span>
            )}
            {book.source === null && (
              <span className="book-not-saved" role="status">
                Not saved
              </span>
            )}
            {isEpub2 && (
              <span className="book-read-only" title="EPUB 2 books are read-only">
                EPUB 2 — read-only
              </span>
            )}
            {book.metadata.authors.length > 0 && (
              <span className="book-authors">
                {book.metadata.authors.join(", ")}
              </span>
            )}
          </div>
        )}
        {book !== null && activityLabel !== null && (
          <span className="lifecycle-status status" role="status">
            {activityLabel}
          </span>
        )}
      </div>
      {book !== null && (
        <div className="app-header-actions">
          <button
            type="button"
            onClick={requestNew}
            disabled={busy}
            title="Start a new book (Ctrl/Cmd+N)"
          >
            New Book…
          </button>
          <button
            type="button"
            onClick={() => requestOpen()}
            disabled={busy}
            title="Open an EPUB (Ctrl/Cmd+O)"
          >
            Open Book…
          </button>
          <button
            type="button"
            onClick={() => setEditingMetadata(true)}
            disabled={isEpub2 || busy}
            title={isEpub2 ? "EPUB 2 books are read-only" : undefined}
          >
            Edit metadata…
          </button>
          <button
            type="button"
            onClick={() => void save()}
            disabled={busy || isEpub2}
            title="Save the book — applies the editor buffer first (Ctrl/Cmd+S)"
          >
            Save
          </button>
          <button
            type="button"
            onClick={() => void save(true)}
            disabled={busy || isEpub2}
            title="Save to a new file (Ctrl/Cmd+Shift+S)"
          >
            Save as…
          </button>
        </div>
      )}
      {editingMetadata && book !== null && (
        <Modal title="Edit metadata" onCancel={() => setEditingMetadata(false)}>
          <CoverPicker />
          <MetadataForm
            initial={book.metadata}
            submitLabel="Save metadata"
            onCancel={() => setEditingMetadata(false)}
            onSubmit={(metadata) => {
              void updateMetadata(metadata).then((ok) => {
                if (ok) setEditingMetadata(false);
              });
            }}
          />
        </Modal>
      )}
    </header>
  );
}
