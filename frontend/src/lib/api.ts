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
