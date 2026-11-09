// Welcome state (no book open): the actionable starting point. Open and
// New go through the lifecycle controller like every other entry point;
// the recents list is the same one File ▸ Open Recent shows.

import { useEffect, useRef } from "react";
import { useLifecycle } from "../state/lifecycle";
import { fileName, parentFolder } from "../lib/lifecycle";

export function Welcome() {
  const { recents, requestOpen, requestNew, busy, activityLabel } =
    useLifecycle();
  const openRef = useRef<HTMLButtonElement | null>(null);

  // Keyboard users land on the primary action when the panel appears
  // (launch, or after Close Book).
  useEffect(() => {
    openRef.current?.focus();
  }, []);

  return (
    <section className="welcome" aria-label="Welcome">
      <div className="welcome-actions">
        <button
          ref={openRef}
          type="button"
          data-variant="primary"
          data-size="lg"
          onClick={() => requestOpen()}
          disabled={busy}
          title="Open an EPUB (Ctrl/Cmd+O)"
        >
          Open Book…
        </button>
        <button
          type="button"
          data-variant="secondary"
          data-size="lg"
          onClick={requestNew}
          disabled={busy}
          title="Start a new book (Ctrl/Cmd+N)"
        >
          New Book…
        </button>
      </div>
      <p className="welcome-hint">or drop an EPUB file here</p>
      {activityLabel !== null && (
        <p className="lifecycle-status" role="status">
          {activityLabel}
        </p>
      )}
      <section className="welcome-recents" aria-labelledby="welcome-recents-heading">
        <h2 className="welcome-recents-heading" id="welcome-recents-heading">
          Recent Books
        </h2>
        {recents.length === 0 ? (
          <p className="welcome-recents-empty">No recent books</p>
        ) : (
          <ul className="welcome-recents-list">
            {recents.map((path) => (
              <li key={path}>
                <button
                  type="button"
                  className="welcome-recent"
                  data-variant="plain"
                  title={path}
                  disabled={busy}
                  onClick={() => requestOpen(path)}
                >
                  <span className="welcome-recent-name">{fileName(path)}</span>
                  <span className="welcome-recent-folder">
                    {parentFolder(path)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </section>
  );
}
