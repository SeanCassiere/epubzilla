import { ReaderProvider } from "./state/reader";
import { Header } from "./components/Header";
import { ReaderPane } from "./components/ReaderPane";
import "./App.css";

// Layout shell: header + main pane. The <main> grid keeps an obvious slot
// for the M1.4 TOC sidebar (an <aside> as the first grid column).
function App() {
  return (
    <ReaderProvider>
      <div className="app-shell">
        <Header />
        <main className="app-main">
          {/* M1.4: TOC sidebar <aside> mounts here, before the reader pane. */}
          <ReaderPane />
        </main>
      </div>
    </ReaderProvider>
  );
}

export default App;
