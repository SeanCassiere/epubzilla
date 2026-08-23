import { useEffect } from "react";
import { ReaderProvider, useReader } from "./state/reader";
import { Header } from "./components/Header";
import { ReaderPane } from "./components/ReaderPane";
import { Sidebar } from "./components/Sidebar";
import { handleShortcutKeydown } from "./lib/shortcuts";
import { bridgeMenuEvents } from "./lib/menu";
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
  // App-wide keyboard shortcuts (issue #74): one window keydown matcher
  // dispatching on the shortcut bus, plus the native-menu bridge so Tauri
  // menu accelerators land on the same bus. Components subscribe to the
  // actions they own (Header: file actions; Sidebar: tabs; ReaderPane:
  // chapter nav, layout, theme).
  useEffect(() => {
    window.addEventListener("keydown", handleShortcutKeydown);
    const unlisten = bridgeMenuEvents();
    return () => {
      window.removeEventListener("keydown", handleShortcutKeydown);
      void unlisten.then((stop) => stop());
    };
  }, []);
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
