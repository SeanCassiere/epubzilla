import { useReader } from "../state/reader";
import {
  issueTargetPath,
  locationLabel,
  summarizeIssues,
} from "../lib/validation";

/**
 * Validation panel (issue #72): surfaces the core's native `validate`
 * subset (ADR-0003 — container structure, manifest/spine/nav consistency,
 * XML well-formedness, required metadata, resource resolution) in the
 * sidebar's "Checks" tab.
 *
 * Findings run on demand here and automatically after every save
 * (state/reader.tsx); the reader state clears them whenever the model
 * changes so nothing stale is ever shown. Issues whose location resolves
 * to a spine chapter click through to it; other locations (the OPF,
 * non-chapter resources) render as plain text.
 */
export function ValidationPanel() {
  const { book, validation, validating, runValidation, goToResource } =
    useReader();
  if (book === null) return null;

  return (
    <aside className="toc-sidebar validation-panel" aria-label="Checks">
      <h2 className="toc-heading">Checks</h2>
      <div className="validation-controls">
        <button
          type="button"
          className="validation-run"
          disabled={validating}
          onClick={() => void runValidation()}
        >
          {validating ? "Checking…" : "Run checks"}
        </button>
      </div>
      {validation === null ? (
        <p className="validation-hint">
          Not checked yet. Checks also run automatically after every save.
        </p>
      ) : (
        <>
          <p className="validation-summary" role="status">
            {summarizeIssues(validation)}
          </p>
          {validation.length > 0 && (
            <ul className="validation-list">
              {validation.map((issue, i) => {
                const target = issueTargetPath(book, issue);
                return (
                  <li
                    key={`${issue.location ?? ""}:${issue.message}:${i}`}
                    className="validation-issue"
                  >
                    <span
                      className={
                        "validation-severity " +
                        (issue.severity === "Error"
                          ? "validation-severity-error"
                          : "validation-severity-warning")
                      }
                    >
                      {issue.severity === "Error" ? "Error" : "Warning"}
                    </span>
                    <span className="validation-message">{issue.message}</span>
                    {issue.location !== null &&
                      (target !== null ? (
                        <button
                          type="button"
                          className="validation-location"
                          title={issue.location}
                          onClick={() => void goToResource(target, null)}
                        >
                          {locationLabel(issue.location)}
                        </button>
                      ) : (
                        <span
                          className="validation-location-plain"
                          title={issue.location}
                        >
                          {locationLabel(issue.location)}
                        </span>
                      ))}
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </aside>
  );
}
