import { ReaderProvider, useReader } from "./state/reader";
import { Header } from "./components/Header";
import { ReaderPane } from "./components/ReaderPane";
import { TocSidebar } from "./components/TocSidebar";
import "./App.css";

// Main pane: TOC sidebar (when the open book has a nav tree) + reader.
// Keyed by book.id so per-book TOC expansion state resets on open.
function MainArea() {
  const { book } = useReader();
  const hasToc = book !== null && book.nav.length > 0;
  return (
    <main className={hasToc ? "app-main with-toc" : "app-main"}>
      {hasToc && <TocSidebar key={book.id} />}
      <ReaderPane />
    </main>
  );
}

// Layout shell: header + main pane.
function App() {
  return (
    <ReaderProvider>
      <div className="app-shell">
        <Header />
        <MainArea />
      </div>
    </ReaderProvider>
  );
}

export default App;
