import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useReader, describeError } from "../state/reader";
import { needsUnsavedPrompt } from "../lib/editing";
import { pickEpubFile, pickSaveEpubPath, slugifyTitle } from "../lib/dialog";
import {
  beginTitlebarDrag,
  destroyWindow,
  interceptClose,
  onCloseRequested,
} from "../lib/window";
import { isMacOS } from "../lib/platform";
import { onShortcut } from "../lib/shortcuts";
import { MetadataForm } from "./MetadataForm";
import { CoverPicker } from "./CoverPicker";

type DialogKind = "new-book" | "edit-metadata" | null;

/** Minimal modal overlay for the metadata dialogs (M2.2). */
function ModalDialog({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="modal-overlay">
      <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <h2 className="modal-title">{title}</h2>
        {children}
      </div>
    </div>
  );
}

/** App chrome header: open/new/edit/save actions, book identity, status, errors. */
export function Header() {
  const {
    book,
    status,
    error,
    openBook,
    createBook,
    updateMetadata,
    saveBook,
    editing,
    startEditing,
    requestStopEditing,
    editorBufferModified,
    applyEditorBuffer,
  } = useReader();
  const [dialog, setDialog] = useState<DialogKind>(null);
  /**
   * Transition awaiting the unsaved-changes guard (M2.4). Non-null while
   * the Save / Discard / Cancel modal is up; the stored action runs when
   * the user picks Save (after a successful save) or Discard.
   */
  const [pendingAction, setPendingAction] = useState<(() => void) | null>(
    null,
  );

  /**
   * Unified save flow (M2.4 + M3.3, see lib/editing.ts saveSteps): an
   * unapplied editor buffer is applied (write_chapter) FIRST, then the book
   * is saved — in place when it has a source, save-as (native save dialog)
   * when it doesn't or when `alwaysPrompt` is set. Resolves true only when
   * everything was actually persisted (a failed apply or a cancelled dialog
   * resolves false and aborts).
   */
  const save = useCallback(
    async (alwaysPrompt = false): Promise<boolean> => {
      if (book === null) return false;
      if (!(await applyEditorBuffer())) return false;
      let path: string | undefined;
      if (alwaysPrompt || book.source === null) {
        const picked = await pickSaveEpubPath(
          `${slugifyTitle(book.metadata.title)}.epub`,
        );
        if (picked === null) return false;
        path = picked;
      }
      return saveBook(path);
    },
    [book, saveBook, applyEditorBuffer],
  );

  /**
   * Unsaved-changes guard (M2.4, unified in M3.3): destructive transitions
   * (open another book, create a new one, close the window) run through
   * here. Nothing pending — proceed immediately; a dirty book OR an
   * unapplied editor buffer — park the action behind ONE three-way modal
   * (Save all / Discard / Cancel).
   */
  const guardDirty = useCallback(
    (action: () => void) => {
      if (needsUnsavedPrompt(book?.dirty ?? false, editorBufferModified())) {
        setPendingAction(() => action);
      } else {
        action();
      }
    },
    [book, editorBufferModified],
  );

  // Window-close guard: intercept close-requested while dirty and route it
  // through the same modal; on proceed, destroy the window for real. The
  // listener registers once; refs keep it on the latest state/handlers.
  const dirtyRef = useRef(false);
  dirtyRef.current = book !== null && book.dirty;
  const guardRef = useRef(guardDirty);
  guardRef.current = guardDirty;
  useEffect(() => {
    const unlisten = onCloseRequested((event) => {
      // Consult the live editor buffer too (M3.3): keystrokes don't
      // re-render the Header, so the getter runs at close-request time.
      const pending = needsUnsavedPrompt(
        dirtyRef.current,
        editorBufferModified(),
      );
      if (interceptClose(pending, event)) {
        guardRef.current(() => void destroyWindow());
      }
    });
    return () => {
      void unlisten.then((stop) => stop());
    };
  }, [editorBufferModified]);

  const handleOpen = async () => {
    const path = await pickEpubFile();
    if (path !== null) {
      await openBook(path);
    }
  };

  // Header-owned app shortcuts (issue #74): Mod+S save (apply-then-save,
  // same flow as the Save button), Mod+Shift+S save-as, Mod+O open,
  // Mod+N new book, Mod+E toggle edit mode (leaving goes through the
  // editor's guard). Actions arrive on the shared bus — from window/iframe
  // keydown or from native menu accelerators (lib/shortcuts.ts) — so they
  // work wherever focus sits. The subscriber registers once and reads refs
  // so rapid toggles never hit a stale closure between a state change and
  // the effect re-registering.
  const shortcutsRef = useRef({
    save,
    editing,
    startEditing,
    requestStopEditing,
    guardDirty,
    handleOpen,
    hasBook: book !== null,
    busy: status === "opening",
  });
  shortcutsRef.current = {
    save,
    editing,
    startEditing,
    requestStopEditing,
    guardDirty,
    handleOpen,
    hasBook: book !== null,
    busy: status === "opening",
  };
  useEffect(
    () =>
      onShortcut((action) => {
        const current = shortcutsRef.current;
        switch (action) {
          case "save":
            if (!current.busy) void current.save();
            break;
          case "save-as":
            if (current.hasBook && !current.busy) void current.save(true);
            break;
          case "open-book":
            if (!current.busy) {
              current.guardDirty(() => void current.handleOpen());
            }
            break;
          case "new-book":
            if (!current.busy) {
              current.guardDirty(() => setDialog("new-book"));
            }
            break;
          case "toggle-edit":
            if (current.editing) {
              void current.requestStopEditing();
            } else {
              current.startEditing(); // self-guards: EPUB 3 + chapter open
            }
            break;
          default:
            break;
        }
      }),
    [],
  );

  // EPUB 2 books are read-only (mutations return UnsupportedFeature); the
  // editing affordance is disabled up front instead of relying on the error.
  const isEpub2 = book !== null && book.epub_version === "V2";

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
            <span className="book-title">{book.metadata.title}</span>
            {book.dirty && (
              <span
                className="dirty-indicator"
                role="status"
                aria-label="(unsaved changes)"
                title="Unsaved changes"
              >
                ●
              </span>
            )}
            {book.metadata.authors.length > 0 && (
              <span className="book-authors">
                {book.metadata.authors.join(", ")}
              </span>
            )}
          </div>
        )}
        {status === "opening" && (
          <span className="status" role="status">
            Opening…
          </span>
        )}
      </div>
      <div className="app-header-actions">
        <button
          type="button"
          onClick={() => guardDirty(() => setDialog("new-book"))}
          disabled={status === "opening"}
          title="Start a new book (Ctrl/Cmd+N)"
        >
          New book…
        </button>
        <button
          type="button"
          onClick={() => guardDirty(() => void handleOpen())}
          disabled={status === "opening"}
          title="Open an EPUB (Ctrl/Cmd+O)"
        >
          Open book…
        </button>
        {book !== null && (
          <>
            <button
              type="button"
              onClick={() => setDialog("edit-metadata")}
              disabled={isEpub2}
              title={isEpub2 ? "EPUB 2 books are read-only" : undefined}
            >
              Edit metadata…
            </button>
            <button
              type="button"
              onClick={() => void save()}
              disabled={status === "opening"}
              title="Save the book — applies the editor buffer first (Ctrl/Cmd+S)"
            >
              Save
            </button>
            <button
              type="button"
              onClick={() => void save(true)}
              disabled={status === "opening"}
              title="Save to a new file (Ctrl/Cmd+Shift+S)"
            >
              Save as…
            </button>
          </>
        )}
      </div>
      {error !== null && (
        <p className="error" role="alert">
          {describeError(error)}
        </p>
      )}
      {dialog === "new-book" && (
        <ModalDialog title="New book">
          <MetadataForm
            initial={null}
            submitLabel="Create book"
            onCancel={() => setDialog(null)}
            onSubmit={(metadata) => {
              void createBook(metadata).then((ok) => {
                if (ok) setDialog(null);
              });
            }}
          />
        </ModalDialog>
      )}
      {dialog === "edit-metadata" && book !== null && (
        <ModalDialog title="Edit metadata">
          <CoverPicker />
          <MetadataForm
            initial={book.metadata}
            submitLabel="Save metadata"
            onCancel={() => setDialog(null)}
            onSubmit={(metadata) => {
              void updateMetadata(metadata).then((ok) => {
                if (ok) setDialog(null);
              });
            }}
          />
        </ModalDialog>
      )}
      {pendingAction !== null && (
        <ModalDialog title="Unsaved changes">
          <p>
            “{book?.metadata.title ?? "This book"}” has unsaved changes. Save
            them before continuing?
          </p>
          <div className="modal-actions">
            <button
              type="button"
              onClick={() => {
                // Save all: apply the editor buffer (if any), then save the
                // book (incl. save-as when source is null), then proceed.
                // A failed apply or a cancelled save aborts the transition.
                void save().then((ok) => {
                  setPendingAction(null);
                  if (ok) pendingAction();
                });
              }}
            >
              Save all
            </button>
            <button
              type="button"
              onClick={() => {
                setPendingAction(null);
                pendingAction();
              }}
            >
              Discard
            </button>
            <button type="button" onClick={() => setPendingAction(null)}>
              Cancel
            </button>
          </div>
        </ModalDialog>
      )}
    </header>
  );
}
