import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useReader, describeError } from "../state/reader";
import { pickEpubFile, pickSaveEpubPath, slugifyTitle } from "../lib/dialog";
import { destroyWindow, interceptClose, onCloseRequested } from "../lib/window";
import { MetadataForm } from "./MetadataForm";

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
   * Save flow: in place when the book has a source, save-as (native save
   * dialog) when it doesn't or when `alwaysPrompt` is set. Resolves true
   * only when the book was actually saved (dialog cancel resolves false).
   */
  const save = useCallback(
    async (alwaysPrompt = false): Promise<boolean> => {
      if (book === null) return false;
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
    [book, saveBook],
  );

  /**
   * Dirty guard (M2.4): destructive transitions (open another book, create
   * a new one, close the window) run through here. Clean book — proceed
   * immediately; dirty — park the action behind the three-way modal.
   */
  const guardDirty = useCallback(
    (action: () => void) => {
      if (book !== null && book.dirty) {
        setPendingAction(() => action);
      } else {
        action();
      }
    },
    [book],
  );

  // Cmd/Ctrl+S saves (same flow as the Save button).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void save();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [save]);

  // Window-close guard: intercept close-requested while dirty and route it
  // through the same modal; on proceed, destroy the window for real. The
  // listener registers once; refs keep it on the latest state/handlers.
  const dirtyRef = useRef(false);
  dirtyRef.current = book !== null && book.dirty;
  const guardRef = useRef(guardDirty);
  guardRef.current = guardDirty;
  useEffect(() => {
    const unlisten = onCloseRequested((event) => {
      if (interceptClose(dirtyRef.current, event)) {
        guardRef.current(() => void destroyWindow());
      }
    });
    return () => {
      void unlisten.then((stop) => stop());
    };
  }, []);

  const handleOpen = async () => {
    const path = await pickEpubFile();
    if (path !== null) {
      await openBook(path);
    }
  };

  // EPUB 2 books are read-only (mutations return UnsupportedFeature); the
  // editing affordance is disabled up front instead of relying on the error.
  const isEpub2 = book !== null && book.epub_version === "V2";

  return (
    <header className="app-header">
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
        >
          New book…
        </button>
        <button
          type="button"
          onClick={() => guardDirty(() => void handleOpen())}
          disabled={status === "opening"}
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
            >
              Save
            </button>
            <button
              type="button"
              onClick={() => void save(true)}
              disabled={status === "opening"}
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
                // Save (incl. save-as when source is null), then proceed.
                // A failed or cancelled save aborts the transition.
                void save().then((ok) => {
                  setPendingAction(null);
                  if (ok) pendingAction();
                });
              }}
            >
              Save
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
