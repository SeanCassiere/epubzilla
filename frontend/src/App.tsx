import type { Book } from "@bindings/Book";
import "./App.css";

// Placeholder shell — the reader lands with M1.3 (#27). The typed prop
// proves the generated-bindings import path end to end.
function BookSummary({ book }: { book: Book | null }) {
  if (!book) {
    return <p className="empty">No book open. Opening files lands with M1.3.</p>;
  }
  return (
    <p>
      {book.metadata.title} — {book.metadata.authors.join(", ")}
    </p>
  );
}

function App() {
  return (
    <main className="container">
      <h1>epubzilla</h1>
      <BookSummary book={null} />
    </main>
  );
}

export default App;
