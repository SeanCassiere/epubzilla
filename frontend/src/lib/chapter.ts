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
 * URLs. Anchor (`a href`) links are handled separately by
 * `annotateChapterLinks` (inter-chapter navigation, M1.4).
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
 * Annotates anchor links for M1.4 navigation:
 *
 * - Relative links whose resolved zip-internal path is another manifest
 *   XHTML document get `data-epub-link="path[#fragment]"` (query dropped,
 *   fragment kept). The original href stays for fidelity; ReaderPane
 *   intercepts clicks on annotated anchors and drives app navigation.
 * - External http(s) links would be dead clicks (the sandbox has no
 *   allow-popups and top navigation is blocked), so the href is stripped;
 *   the original URL is preserved in `data-epub-external` and surfaced
 *   via `title` so hovering still reveals the destination.
 * - Fragment-only links are untouched (in-document scroll works).
 */
export function annotateChapterLinks(
  doc: Document,
  chapterPath: string,
  xhtmlPaths: ReadonlySet<string>,
): void {
  for (const a of Array.from(doc.querySelectorAll("a[href]"))) {
    const href = a.getAttribute("href");
    if (href === null) continue;
    const trimmed = href.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    if (/^https?:/i.test(trimmed)) {
      a.removeAttribute("href");
      a.setAttribute("data-epub-external", trimmed);
      a.setAttribute("title", `External link: ${trimmed}`);
      continue;
    }
    const resolved = resolveChapterUrl(chapterPath, trimmed);
    if (resolved === null || !xhtmlPaths.has(resolved.path)) continue;
    const hash = resolved.suffix.indexOf("#");
    const fragment = hash === -1 ? "" : resolved.suffix.slice(hash);
    a.setAttribute("data-epub-link", resolved.path + fragment);
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
  // One static snapshot instead of a recursive walk over live `children`
  // collections (issue #76): live-HTMLCollection indexing degrades to
  // O(n²) on huge flat chapters in some DOM implementations, which made
  // multi-MB chapters visibly hang render prep. querySelectorAll("*")
  // includes the document element and is a static, linear pass.
  for (const el of Array.from(doc.querySelectorAll("*"))) {
    for (const attrName of el.getAttributeNames()) {
      const name = attrName.toLowerCase();
      if (name.startsWith("on")) {
        el.removeAttribute(attrName);
      } else if (
        (name === "href" || name === "src" || name === "xlink:href") &&
        (el.getAttribute(attrName) ?? "")
          .trim()
          .toLowerCase()
          .startsWith("javascript:")
      ) {
        el.removeAttribute(attrName);
      }
    }
  }
}

/** Render-layer reading theme requested by the reader UI. */
export type ReadingTheme = "light" | "dark";

/**
 * Shared reading defaults (issue #55): books with minimal or plain CSS
 * otherwise render as full-width, left-aligned text ("unstyled html").
 * The body gets a comfortable default measure — `max-width` cap, auto
 * horizontal margins to center the column, and padding so text never
 * touches the viewport edges. Deliberately LOW priority: plain element
 * selectors, no `!important`, first in <head> — a book rule that sets its
 * own body margins, width, or measure wins at equal specificity.
 */
const CHAPTER_BASE_CSS = `
body {
  background-color: Canvas;
  color: CanvasText;
  font-family: Georgia, "Times New Roman", serif;
  line-height: 1.6;
  max-width: 42rem;
  margin-block: 0;
  margin-inline: auto;
  padding: 2rem 1.5rem 4rem;
}
img, svg, video { max-width: 100%; height: auto; }
`.trim();

/**
 * Light reading defaults — the historical rendering.
 *
 * Color-scheme isolation (issue #66): the reader document is pinned to
 * `color-scheme: light` so the surrounding app's dark mode never leaks
 * UA dark-scheme text colors into the chapter (previously `light dark`
 * let macOS dark mode render white body text over the reader's white
 * background). Under the forced light scheme, `Canvas`/`CanvasText`
 * resolve to the UA's light defaults — identical to light-mode
 * rendering today — and book stylesheets still win because this style
 * comes first at equal specificity. Presentation-only: injected into
 * the rendered srcdoc at display time, never persisted into the EPUB.
 */
export const DEFAULT_CHAPTER_CSS = `
:root { color-scheme: light; }
${CHAPTER_BASE_CSS}
`.trim();

/**
 * Dark reading defaults (issue #78): same low-priority block, pinned to
 * `color-scheme: dark` so `Canvas`/`CanvasText` resolve to the UA's dark
 * defaults — dark page, light text, dark-scheme UA link colors. Identical
 * mechanism to the #66 light pin, just the opposite scheme; the #55
 * measure lives in the shared base so both themes compose with it.
 */
export const DARK_CHAPTER_CSS = `
:root { color-scheme: dark; }
${CHAPTER_BASE_CSS}
`.trim();

/**
 * True when the chapter brings visual styling of its own (issue #78):
 * a linked stylesheet, an embedded <style>, or an inline `style`
 * attribute that sets colors. Such books are rendered with the light
 * defaults even when a dark reading theme is requested — forcing a dark
 * canvas under author-chosen colors (dark text, tinted backgrounds)
 * would risk unreadable output, and we never rewrite author CSS.
 *
 * Conservative on purpose: linked stylesheets cannot be inspected here
 * (they are separate zip resources), so any stylesheet counts as author
 * styling. Inline `style` attributes only count when they mention color
 * or background — purely structural inline styles (text-align, margins)
 * are safe under either scheme.
 */
export function chapterHasAuthorStyling(doc: Document): boolean {
  if (doc.querySelector('link[rel~="stylesheet" i]') !== null) return true;
  if (doc.querySelector("style:not([data-epubzilla])") !== null) return true;
  for (const el of Array.from(doc.querySelectorAll("[style]"))) {
    const inline = el.getAttribute("style") ?? "";
    if (/(?:^|[\s;{])(?:background|color|border-color)/i.test(inline)) {
      return true;
    }
  }
  return false;
}

/**
 * Full pipeline: XHTML string -> sanitized, URL-rewritten HTML string
 * ready for `<iframe srcdoc>`. `chapterPath` is the chapter's own
 * zip-internal path (`Resource.path`); `resourceUrl` maps zip-internal
 * paths to asset-protocol URLs (api.resourceUrl bound to the book id).
 *
 * `theme` is the requested reading theme (default "light", the
 * historical rendering). A dark request is honored only for
 * minimally-styled chapters (see chapterHasAuthorStyling) — author-styled
 * books keep the pinned-light #66 rendering so their own colors stay
 * readable. Theming is presentation-only: it lives in the injected
 * defaults block of the rendered srcdoc and never touches stored EPUB
 * content.
 */
export function prepareChapterHtml(
  xhtml: string,
  chapterPath: string,
  resourceUrl: ResourceUrlResolver,
  xhtmlPaths: ReadonlySet<string> = new Set(),
  theme: ReadingTheme = "light",
): string {
  const doc = new DOMParser().parseFromString(xhtml, "text/html");
  stripActiveContent(doc);
  rewriteResourceUrls(doc, chapterPath, resourceUrl);
  annotateChapterLinks(doc, chapterPath, xhtmlPaths);

  const renderDark = theme === "dark" && !chapterHasAuthorStyling(doc);
  const style = doc.createElement("style");
  style.setAttribute("data-epubzilla", "defaults");
  style.setAttribute("data-epubzilla-theme", renderDark ? "dark" : "light");
  style.textContent = renderDark ? DARK_CHAPTER_CSS : DEFAULT_CHAPTER_CSS;
  const head = doc.head;
  head.insertBefore(style, head.firstChild);

  return "<!doctype html>\n" + (doc.documentElement?.outerHTML ?? "");
}
