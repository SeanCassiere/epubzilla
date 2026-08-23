// Typed IPC layer over the Tauri commands (core-api.md).
//
// RULE (ADR-0006): this module is the only place `invoke` and command
// strings may appear. UI components import these wrappers — never
// `@tauri-apps/api` directly.

import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import type { Book } from "@bindings/Book";
import type { ChapterContent } from "@bindings/ChapterContent";
import type { ContentFormat } from "@bindings/ContentFormat";
import type { CoreError } from "@bindings/CoreError";
import type { Metadata } from "@bindings/Metadata";
import type { ValidationIssue } from "@bindings/ValidationIssue";

const CORE_ERROR_KINDS: ReadonlySet<string> = new Set([
  "Io",
  "NotAnEpub",
  "MalformedPackage",
  "ResourceNotFound",
  "UnsupportedFeature",
  "ValidationFailed",
  "ConversionLossy",
]);

/**
 * Type guard for rejections from these wrappers: command failures cross IPC
 * as the serde form of `CoreError` (tagged with `kind`), never as strings.
 */
export function isCoreError(value: unknown): value is CoreError {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    typeof (value as { kind: unknown }).kind === "string" &&
    CORE_ERROR_KINDS.has((value as { kind: string }).kind)
  );
}

/** Parse an EPUB from an OS path into the session. Rejects with `CoreError`. */
export function openBook(path: string): Promise<Book> {
  return invoke<Book>("open_book", { path });
}

/** Current model snapshot of an open book. */
export function getBook(bookId: string): Promise<Book> {
  return invoke<Book>("get_book", { bookId });
}

/**
 * One chapter body, decompressed on demand. `prefer: "Markdown"` may still
 * come back as `format: "Xhtml"` when conversion would be lossy.
 */
export function readChapter(
  bookId: string,
  resourceId: string,
  prefer: ContentFormat,
): Promise<ChapterContent> {
  return invoke<ChapterContent>("read_chapter", { bookId, resourceId, prefer });
}

/** Raw bytes of any manifest resource (images, CSS, fonts, ...). */
export async function readResource(
  bookId: string,
  resourceId: string,
): Promise<Uint8Array> {
  const buffer = await invoke<ArrayBuffer>("read_resource", {
    bookId,
    resourceId,
  });
  return new Uint8Array(buffer);
}

/** Drop session state for one book. Unsaved-changes confirmation is on us. */
export function closeBook(bookId: string): Promise<void> {
  return invoke<void>("close_book", { bookId });
}

/** New in-memory EPUB 3 book (generated title page + nav); `source` is null. */
export function createBook(metadata: Metadata): Promise<Book> {
  return invoke<Book>("create_book", { metadata });
}

/**
 * Atomic save. `path` is required when the book has no `source` (save-as);
 * omit it to save in place. Untouched entries are copied, not re-encoded.
 */
export function saveBook(bookId: string, path?: string): Promise<Book> {
  return invoke<Book>("save_book", { bookId, path: path ?? null });
}

/** Write one chapter body (Markdown is converted to XHTML on write). */
export function writeChapter(
  bookId: string,
  resourceId: string,
  content: ChapterContent,
): Promise<Book> {
  return invoke<Book>("write_chapter", { bookId, resourceId, content });
}

/** Replace book metadata; a generated title page is regenerated. */
export function updateMetadata(
  bookId: string,
  metadata: Metadata,
): Promise<Book> {
  return invoke<Book>("update_metadata", { bookId, metadata });
}

/** Add a chapter after the given spine item (or at the end). */
export function addChapter(
  bookId: string,
  title: string,
  after?: string,
): Promise<Book> {
  return invoke<Book>("add_chapter", { bookId, title, after: after ?? null });
}

/** Remove a spine entry, its nav entries, and its resource if unreferenced. */
export function removeChapter(
  bookId: string,
  spineItemId: string,
): Promise<Book> {
  return invoke<Book>("remove_chapter", { bookId, spineItemId });
}

/** Reorder the spine; `order` must be a permutation of current spine ids. */
export function reorderSpine(bookId: string, order: string[]): Promise<Book> {
  return invoke<Book>("reorder_spine", { bookId, order });
}

/**
 * Read an image file from an OS path and add it to the book (M3.3). The
 * backend reads the bytes and infers the media type from the extension, so
 * file content never crosses IPC twice.
 */
export function addResourceFromPath(
  bookId: string,
  osPath: string,
): Promise<Book> {
  return invoke<Book>("add_resource_from_path", { bookId, osPath });
}

/**
 * Add an image to the book from in-memory bytes (issue #54: clipboard paste
 * and drag-and-drop in the editor, where no OS path exists). `nameHint` is
 * the clipboard/file name (used to derive the zip-internal path; the backend
 * normalizes unreliable names) and `mediaType` the image MIME type — anything
 * that is not a supported image type rejects with `UnsupportedFeature`.
 */
export function addResourceFromBytes(
  bookId: string,
  nameHint: string,
  mediaType: string,
  bytes: Uint8Array,
): Promise<Book> {
  return invoke<Book>("add_resource_from_bytes", {
    bookId,
    nameHint,
    mediaType,
    bytes: Array.from(bytes),
  });
}

/**
 * Set, replace, or clear the book's cover image (issue #73). `resourceId`
 * must name an existing `image/*` manifest resource; null clears the cover.
 * The manifest item gets the EPUB 3 `cover-image` property on save; a
 * replaced session-added cover is cleaned up by the core.
 */
export function setCover(
  bookId: string,
  resourceId: string | null,
): Promise<Book> {
  return invoke<Book>("set_cover", { bookId, resourceId });
}

/**
 * Read an image file from an OS path, add it to the book, and make it the
 * cover in one command (issue #73) — bytes never cross IPC. Media type is
 * inferred from the extension like `add_resource_from_path`.
 */
export function setCoverFromPath(
  bookId: string,
  osPath: string,
): Promise<Book> {
  return invoke<Book>("set_cover_from_path", { bookId, osPath });
}

/** Native validation subset (ADR-0003). Findings are values, not rejections. */
export function validateBook(bookId: string): Promise<ValidationIssue[]> {
  return invoke<ValidationIssue[]>("validate", { bookId });
}

/**
 * URL under the `epub://` asset protocol for one manifest resource, for use
 * in rendered chapter markup (img/src, CSS url(), fonts — M1.3).
 *
 * `path` is the resource's zip-internal path (`Resource.path`). Canonically
 * `epub://<bookId>/<path>`; `convertFileSrc` maps that to whatever the
 * platform webview actually serves (e.g. `http://epub.localhost/...` on
 * Windows), so never hardcode the base URL.
 */
export function resourceUrl(bookId: string, path: string): string {
  return convertFileSrc(`${bookId}/${path}`, "epub");
}
