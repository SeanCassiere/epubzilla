import { useEffect } from "react";
import { ReaderProvider, useReader } from "./state/reader";
import { Header } from "./components/Header";
import { ReaderPane } from "./components/ReaderPane";
import { Sidebar } from "./components/Sidebar";
import { UpdateNotice } from "./components/UpdateNotice";
import { handleShortcutKeydown } from "./lib/shortcuts";
import { bridgeMenuEvents } from "./lib/menu";
import "./App.css";

// Shell body (issue #61): a full-height sidebar column on the left, with
// the header living INSIDE the right-hand content column so the sidebar
// runs from the window's top edge to its bottom edge (native macOS
// source-list layout). The sidebar is keyed by book.id so per-book
// tab/TOC expansion state resets on open.
function MainArea() {
  const { book } = useReader();
  return (
    <>
      {book !== null && <Sidebar key={book.id} />}
      <main className="app-content">
        <Header />
        <UpdateNotice />
        <ReaderPane />
      </main>
    </>
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
  // The macOS overlay-titlebar insets and vibrancy layering are gated by
  // the data-platform attribute main.tsx stamps on <html>.
  return (
    <ReaderProvider>
      <div className="app-shell">
        <MainArea />
      </div>
    </ReaderProvider>
  );
}

export default App;
