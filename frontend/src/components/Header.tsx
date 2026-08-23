import { useState, type ReactNode } from "react";
import { useReader, describeError } from "../state/reader";
import { pickEpubFile } from "../lib/dialog";
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

/** App chrome header: open/new/edit actions, book identity, status, errors. */
export function Header() {
  const { book, status, error, openBook, createBook, updateMetadata } =
    useReader();
  const [dialog, setDialog] = useState<DialogKind>(null);

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
          onClick={() => setDialog("new-book")}
          disabled={status === "opening"}
        >
          New book…
        </button>
        <button
          type="button"
          onClick={() => void handleOpen()}
          disabled={status === "opening"}
        >
          Open book…
        </button>
        {book !== null && (
          <button
            type="button"
            onClick={() => setDialog("edit-metadata")}
            disabled={isEpub2}
            title={isEpub2 ? "EPUB 2 books are read-only" : undefined}
          >
            Edit metadata…
          </button>
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
    </header>
  );
}
