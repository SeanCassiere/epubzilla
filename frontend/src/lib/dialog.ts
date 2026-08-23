// Native dialog wrappers. Like lib/api.ts, this is the only module that
// may import the dialog plugin — UI components go through these helpers.

import { open, save } from "@tauri-apps/plugin-dialog";

/** Native open-file dialog filtered to .epub. Resolves null on cancel. */
export async function pickEpubFile(): Promise<string | null> {
  const picked = await open({
    multiple: false,
    directory: false,
    filters: [{ name: "EPUB", extensions: ["epub"] }],
  });
  return picked;
}

/**
 * Native save-file dialog filtered to .epub (save / save-as, M2.4).
 * Resolves null on cancel.
 */
export async function pickSaveEpubPath(
  defaultFileName: string,
): Promise<string | null> {
  return save({
    defaultPath: defaultFileName,
    filters: [{ name: "EPUB", extensions: ["epub"] }],
  });
}

/**
 * Filesystem-safe default filename stem from a book title. Keeps Unicode
 * letters (UTF-8 safe) but strips path separators and characters that are
 * invalid on common filesystems; whitespace becomes single dashes.
 */
export function slugifyTitle(title: string): string {
  const slug = title
    .replace(/[/\\:*?"<>|]/g, " ")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug === "" ? "untitled" : slug;
}
