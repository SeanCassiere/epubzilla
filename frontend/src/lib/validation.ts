// Pure helpers for the validation panel (issue #72, ADR-0003).
//
// The native `validate` command reports issues with an optional
// zip-internal `location` (the OPF path, a resource path, or null). These
// helpers map that wire form onto what the UI needs: click-through targets
// (only spine chapters are openable in the reader) and display labels.

import type { Book } from "@bindings/Book";
import type { ValidationIssue } from "@bindings/ValidationIssue";

export interface IssueCounts {
  errors: number;
  warnings: number;
}

export function countIssues(issues: ReadonlyArray<ValidationIssue>): IssueCounts {
  let errors = 0;
  let warnings = 0;
  for (const issue of issues) {
    if (issue.severity === "Error") errors += 1;
    else warnings += 1;
  }
  return { errors, warnings };
}

/**
 * Zip-internal resource path the reader can navigate to for this issue,
 * or null when there is no click-through target: the location is absent,
 * names something outside the manifest (e.g. the OPF itself), or names a
 * manifest resource that is not a spine chapter (images, CSS, fonts).
 */
export function issueTargetPath(
  book: Book,
  issue: ValidationIssue,
): string | null {
  if (issue.location === null) return null;
  const resource = book.resources.find((r) => r.path === issue.location);
  if (resource === undefined) return null;
  const inSpine = book.spine.some((s) => s.resource === resource.id);
  return inSpine ? issue.location : null;
}

/** Short display form of a location: the file name. */
export function locationLabel(location: string): string {
  return location.split("/").pop() ?? location;
}

/** One-line summary for the panel: "2 errors, 1 warning" / "No issues found". */
export function summarizeIssues(issues: ReadonlyArray<ValidationIssue>): string {
  if (issues.length === 0) return "No issues found";
  const { errors, warnings } = countIssues(issues);
  const parts: string[] = [];
  if (errors > 0) parts.push(`${errors} ${errors === 1 ? "error" : "errors"}`);
  if (warnings > 0) {
    parts.push(`${warnings} ${warnings === 1 ? "warning" : "warnings"}`);
  }
  return parts.join(", ");
}
