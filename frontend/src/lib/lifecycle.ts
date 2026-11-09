// Pure helpers for the book lifecycle (opening, creating, switching,
// closing). No IPC here — state/lifecycle.tsx wires these up; every
// decision that can be expressed as a plain function lives here so it is
// unit-tested without rendering the app.

import { isCoreError } from "./api";

/** App name: the window title with no book open. */
export const APP_NAME = "epubzilla";

/** Shown when a drop / Finder batch contains no EPUB at all. */
export const EPUB_ONLY_MESSAGE = "epubzilla opens EPUB files only.";

/** Last path component; accepts both separators (OS paths). */
export function fileName(path: string): string {
  const parts = path.split(/[/\\]/);
  return parts[parts.length - 1] || path;
}

/** Name of the folder containing `path` ("" at the root). */
export function parentFolder(path: string): string {
  const parts = path.split(/[/\\]/).filter((p) => p !== "");
  return parts.length >= 2 ? parts[parts.length - 2] : "";
}

/** File name without its final extension ("Book.v2.epub" → "Book.v2"). */
export function stripExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

/** Case-insensitive `.epub` check (core parsing validates the content). */
export function isEpubPath(path: string): boolean {
  return /\.epub$/i.test(path);
}

/**
 * Batch policy for drops and Finder opens: open the first `.epub`, ignore
 * everything else; with no `.epub` at all, explain instead.
 */
export function firstEpub(
  paths: readonly string[],
): { path: string } | { error: string } | null {
  if (paths.length === 0) return null;
  const path = paths.find(isEpubPath);
  return path === undefined ? { error: EPUB_ONLY_MESSAGE } : { path };
}

/** The slice of Book the identity helpers read. */
export interface BookIdentity {
  source: string | null;
  metadata: { title: string };
}

/**
 * Native window title: the file name (no extension) for a saved book, the
 * book title for one that is not on disk yet, the app name at welcome.
 */
export function windowTitleFor(book: BookIdentity | null): string {
  if (book === null) return APP_NAME;
  if (book.source !== null) return stripExtension(fileName(book.source));
  const title = book.metadata.title.trim();
  return title === "" ? APP_NAME : title;
}

/** Whether two OS paths name the same file (exact; no case folding). */
export function samePath(a: string | null, b: string | null): boolean {
  return a !== null && b !== null && a === b;
}

/** A user-facing failure: one readable sentence plus raw details. */
export interface LifecycleNotice {
  message: string;
  /** The raw command error, shown as secondary "Details". */
  details: string | null;
  /** Offer a follow-up action (in-place save failed: try Save As…). */
  action?: "save-as";
}

/** Raw `Kind: message` form of a command rejection. */
export function rawError(error: unknown): string {
  if (isCoreError(error)) {
    switch (error.kind) {
      case "ResourceNotFound":
        return `${error.kind}: ${error.id}`;
      case "ValidationFailed":
        return `${error.kind}: ${error.issues.length} issue(s)`;
      case "ConversionLossy":
        return `${error.kind}: ${error.detail}`;
      default:
        return `${error.kind}: ${error.message}`;
    }
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * Whether an `Io` rejection means "the file is not there". Matches the
 * locale-independent errno suffix std::io::Error appends (ENOENT is 2 on
 * macOS/Linux, ERROR_FILE/PATH_NOT_FOUND are 2/3 on Windows) rather than
 * the localized message text.
 */
export function isNotFound(error: unknown): boolean {
  return (
    isCoreError(error) &&
    error.kind === "Io" &&
    /\(os error [23]\)/.test(error.message)
  );
}

/** Readable message for a failed open of `path`. */
export function describeOpenError(
  error: unknown,
  path: string,
): LifecycleNotice {
  const name = `“${fileName(path)}”`;
  const details = rawError(error);
  if (!isCoreError(error)) {
    return { message: `${name} couldn’t be opened.`, details };
  }
  switch (error.kind) {
    case "NotAnEpub":
      return { message: `${name} isn’t a valid EPUB file.`, details };
    case "MalformedPackage":
      return {
        message: `${name} couldn’t be opened because its package is damaged.`,
        details,
      };
    case "UnsupportedFeature":
      return {
        message: `${name} uses features epubzilla can’t open yet.`,
        details,
      };
    case "Io":
      return isNotFound(error)
        ? {
            message: `${name} couldn’t be found. It may have been moved or deleted.`,
            details,
          }
        : { message: `${name} couldn’t be read.`, details };
    default:
      return { message: `${name} couldn’t be opened.`, details };
  }
}

/** Readable message for a failed save; offers Save As… for in-place Io. */
export function describeSaveError(
  error: unknown,
  path: string | null,
  inPlace: boolean,
): LifecycleNotice {
  const name = path === null ? "The book" : `“${fileName(path)}”`;
  const details = rawError(error);
  if (isCoreError(error) && error.kind === "Io") {
    return inPlace
      ? {
          message: `${name} couldn’t be saved to its original location.`,
          details,
          action: "save-as",
        }
      : { message: `${name} couldn’t be written.`, details };
  }
  if (isCoreError(error) && error.kind === "UnsupportedFeature") {
    return { message: `${name} can’t be saved: it is read-only.`, details };
  }
  return { message: `${name} couldn’t be saved.`, details };
}

/** Readable message for a failed New Book. */
export function describeCreateError(error: unknown): LifecycleNotice {
  return { message: "The book couldn’t be created.", details: rawError(error) };
}
