// Error banner: one readable sentence naming the file, the raw command
// error under "Details", a Dismiss button, and an optional follow-up
// (Save As… after an in-place save failed). Lifecycle notices take
// precedence over other command errors from the reader state.

import { useLifecycle } from "../state/lifecycle";
import { describeError, useReader } from "../state/reader";

export function ErrorBanner() {
  const { notice, dismissNotice, save } = useLifecycle();
  const { error } = useReader();
  const shown =
    notice ??
    (error !== null && error !== undefined
      ? { message: describeError(error), details: null }
      : null);
  if (shown === null) return null;
  return (
    <div className="error-banner banner" data-tone="danger" role="alert">
      <p className="error-banner-message">{shown.message}</p>
      {shown.details !== null && (
        <details className="error-banner-details">
          <summary>Details</summary>
          <p>{shown.details}</p>
        </details>
      )}
      <div className="error-banner-actions">
        {"action" in shown && shown.action === "save-as" && (
          <button
            type="button"
            data-variant="secondary"
            onClick={() => void save(true)}
          >
            Save As…
          </button>
        )}
        <button
          type="button"
          className="error-banner-dismiss"
          data-variant="plain"
          data-icon
          aria-label="Dismiss"
          title="Dismiss"
          onClick={dismissNotice}
        >
          ×
        </button>
      </div>
    </div>
  );
}
