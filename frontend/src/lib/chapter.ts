// Pure chapter-markup preparation for the reader iframe (M1.3).
//
// Everything here is DOM-string-in / DOM-string-out so it can be unit
// tested without Tauri. The reader renders the result as an <iframe
// srcdoc> with `sandbox` (no allow-scripts), so this module also strips
// active content defensively — the sandbox is the real barrier, the
// stripping keeps the markup honest.

/** Maps a zip-internal resource path to a servable URL (epub:// asset protocol). */
export type ResourceUrlResolver = (path: string) => string;

/** True for URLs we must not touch: absolute (has a scheme) or fragment-only. */
export function isExternalOrFragment(url: string): boolean {
  if (url === "" || url.startsWith("#")) return true;
  // RFC 3986 scheme: ALPHA *( ALPHA / DIGIT / "+" / "-" / "." ) ":"
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url);
}

/**
 * Resolves a URL found in chapter markup against the chapter's own
 * zip-internal directory, returning a normalized zip-internal path
 * (no leading slash) plus any query/fragment suffix, or `null` when the
 * URL should be left alone (external, fragment-only, empty, or escaping
 * the archive root).
 */
export function resolveChapterUrl(
  chapterPath: string,
  url: string,
): { path: string; suffix: string } | null {
  if (isExternalOrFragment(url)) return null;

  // Split off ?query and/or #fragment; keep them verbatim.
  const match = /^([^?#]*)([?#].*)?$/.exec(url);
  const rawPath = match?.[1] ?? url;
  const suffix = match?.[2] ?? "";
  if (rawPath === "") return null;

  let decoded: string;
  try {
    decoded = decodeURI(rawPath);
  } catch {
    decoded = rawPath;
  }

  // Base directory of the chapter inside the zip ("" at archive root).
  const chapterDir = chapterPath.includes("/")
    ? chapterPath.slice(0, chapterPath.lastIndexOf("/"))
    : "";

  // A leading slash means "archive root" (rare, but seen in the wild).
  const startsAtRoot = decoded.startsWith("/");
  const segments = decoded.split("/").filter((s) => s !== "" && s !== ".");
  const stack = startsAtRoot
    ? []
    : chapterDir === ""
      ? []
      : chapterDir.split("/");

  for (const segment of segments) {
    if (segment === "..") {
      if (stack.length === 0) return null; // escapes the archive
      stack.pop();
    } else {
      stack.push(segment);
    }
  }
  if (stack.length === 0) return null;
  return { path: stack.join("/"), suffix };
}

/** Attribute/element pairs whose URLs point at book resources. */
const URL_ATTRS: ReadonlyArray<{ selector: string; attr: string }> = [
  { selector: "img", attr: "src" },
  { selector: "link", attr: "href" },
  { selector: "source", attr: "src" },
  { selector: "source", attr: "srcset" },
  { selector: "image", attr: "href" },
  { selector: "image", attr: "xlink:href" },
  { selector: "audio", attr: "src" },
  { selector: "video", attr: "src" },
  { selector: "video", attr: "poster" },
  { selector: "object", attr: "data" },
  { selector: "embed", attr: "src" },
  { selector: "iframe", attr: "src" },
];

/**
 * Rewrites relative resource URLs in the parsed chapter to asset-protocol
 * URLs. Anchor (`a href`) links are deliberately untouched: fragment-only
 * links stay as-is, and inter-chapter navigation is M1.4's job.
 */
export function rewriteResourceUrls(
  doc: Document,
  chapterPath: string,
  resourceUrl: ResourceUrlResolver,
): void {
  for (const { selector, attr } of URL_ATTRS) {
    for (const el of Array.from(doc.querySelectorAll(selector))) {
      const value = el.getAttribute(attr);
      if (value === null) continue;
      const resolved = resolveChapterUrl(chapterPath, value.trim());
      if (resolved !== null) {
        el.setAttribute(attr, resourceUrl(resolved.path) + resolved.suffix);
      }
    }
  }
}

/**
 * Removes active content: <script> elements (any namespace), inline on*
 * event handler attributes, and javascript: URLs. Defense in depth — the
 * iframe sandbox (no allow-scripts) is the actual enforcement.
 */
export function stripActiveContent(doc: Document): void {
  for (const script of Array.from(doc.querySelectorAll("script"))) {
    script.remove();
  }
  const walk = (el: Element): void => {
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      if (name.startsWith("on")) {
        el.removeAttribute(attr.name);
      } else if (
        (name === "href" || name === "src" || name === "xlink:href") &&
        attr.value.trim().toLowerCase().startsWith("javascript:")
      ) {
        el.removeAttribute(attr.name);
      }
    }
    for (const child of Array.from(el.children)) walk(child);
  };
  if (doc.documentElement) walk(doc.documentElement);
}

/**
 * Minimal reading defaults for chapters that bring no CSS of their own.
 * Injected as the FIRST style in <head> so any book stylesheet that
 * follows wins on equal specificity, and kept to low-impact properties.
 */
export const DEFAULT_CHAPTER_CSS = `
:root { color-scheme: light dark; }
body {
  font-family: Georgia, "Times New Roman", serif;
  line-height: 1.6;
  max-width: 42rem;
  margin: 0 auto;
  padding: 2rem 1.5rem 4rem;
}
img, svg, video { max-width: 100%; height: auto; }
`.trim();

/**
 * Full pipeline: XHTML string -> sanitized, URL-rewritten HTML string
 * ready for `<iframe srcdoc>`. `chapterPath` is the chapter's own
 * zip-internal path (`Resource.path`); `resourceUrl` maps zip-internal
 * paths to asset-protocol URLs (api.resourceUrl bound to the book id).
 */
export function prepareChapterHtml(
  xhtml: string,
  chapterPath: string,
  resourceUrl: ResourceUrlResolver,
): string {
  const doc = new DOMParser().parseFromString(xhtml, "text/html");
  stripActiveContent(doc);
  rewriteResourceUrls(doc, chapterPath, resourceUrl);

  const style = doc.createElement("style");
  style.setAttribute("data-epubzilla", "defaults");
  style.textContent = DEFAULT_CHAPTER_CSS;
  const head = doc.head;
  head.insertBefore(style, head.firstChild);

  return "<!doctype html>\n" + (doc.documentElement?.outerHTML ?? "");
}
