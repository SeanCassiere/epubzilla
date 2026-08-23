import { ReaderProvider, useReader } from "./state/reader";
import { Header } from "./components/Header";
import { ReaderPane } from "./components/ReaderPane";
import { Sidebar } from "./components/Sidebar";
import "./App.css";

// Main pane: tabbed sidebar (TOC + chapter panel, M2.3) + reader.
// Keyed by book.id so per-book tab/TOC expansion state resets on open.
function MainArea() {
  const { book } = useReader();
  return (
    <main className={book !== null ? "app-main with-toc" : "app-main"}>
      {book !== null && <Sidebar key={book.id} />}
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
