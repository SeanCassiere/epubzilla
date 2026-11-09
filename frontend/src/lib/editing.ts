// Pure decision helpers for the unified editing UX (M3.3).
//
// The unified guard treats "unsaved work" as ONE concept with two layers:
// the editor's unapplied chapter buffer and the book's dirty flag. Cmd/Ctrl+S
// (and the guard's "Save all") always applies the buffer first, then saves
// the book; the M2.4 dirty guard prompts when EITHER layer has pending work,
// so a destructive transition never double-prompts. All logic here is pure
// and unit-tested; the components only wire it up.

/** One step of the unified save flow, in execution order. */
export type SaveStep = "apply" | "save";

/**
 * Ordered steps for Cmd/Ctrl+S, the Save button, and the guard's "Save all":
 * an unapplied buffer is applied (write_chapter) before the book is saved,
 * so one keystroke persists everything.
 */
export function saveSteps(bufferModified: boolean): SaveStep[] {
  return bufferModified ? ["apply", "save"] : ["save"];
}

/**
 * Whether a destructive transition (open/new/window-close) must stop at the
 * Save all / Discard / Cancel dialog: pending work in either layer counts.
 */
export function needsUnsavedPrompt(
  bookDirty: boolean,
  bufferModified: boolean,
): boolean {
  return bookDirty || bufferModified;
}

/**
 * Relative reference from one zip-internal path to another, for use inside
 * the chapter at `fromPath` (e.g. `OEBPS/text/ch1.xhtml` →
 * `OEBPS/images/pic.png` gives `../images/pic.png`). Both inputs are
 * `/`-separated zip paths, never OS paths.
 */
export function relativeResourcePath(fromPath: string, toPath: string): string {
  const fromDirs = fromPath.split("/").slice(0, -1);
  const toParts = toPath.split("/");
  let common = 0;
  while (
    common < fromDirs.length &&
    common < toParts.length - 1 &&
    fromDirs[common] === toParts[common]
  ) {
    common += 1;
  }
  const ups = fromDirs.length - common;
  return [...Array<string>(ups).fill(".."), ...toParts.slice(common)].join("/");
}

/** Shared cursor insertion contract; an empty alt describes decoration. */
export type InsertImage = (src: string, alt?: string) => void;

/** Keep labels literal and destinations intact through CommonMark parsing. */
export function imageMarkdown(relativePath: string, alt = ""): string {
  const label = alt.replace(/\r?\n/g, " ").replace(/[\\[\]`*_~&<>]/g, "\\$&");
  const path = relativePath
    .replace(/[\r\n]/g, (char) => encodeURIComponent(char))
    .replace(/[\\<>&]/g, "\\$&");
  const destination = /[\s()<>]/.test(relativePath) ? `<${path}>` : path;
  return `![${label}](${destination})`;
}
