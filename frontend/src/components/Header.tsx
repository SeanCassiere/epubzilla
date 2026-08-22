import { useReader, describeError } from "../state/reader";
import { pickEpubFile } from "../lib/dialog";

/** App chrome header: open button, book identity, status, errors. */
export function Header() {
  const { book, status, error, openBook } = useReader();

  const handleOpen = async () => {
    const path = await pickEpubFile();
    if (path !== null) {
      await openBook(path);
    }
  };

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
          onClick={() => void handleOpen()}
          disabled={status === "opening"}
        >
          Open book…
        </button>
      </div>
      {error !== null && (
        <p className="error" role="alert">
          {describeError(error)}
        </p>
      )}
    </header>
  );
}
