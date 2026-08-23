import { describe, expect, it } from "vitest";
import {
  DARK_CHAPTER_CSS,
  DEFAULT_CHAPTER_CSS,
  PAGINATED_CHAPTER_CSS,
  chapterHasAuthorStyling,
  isExternalOrFragment,
  prepareChapterHtml,
  resolveChapterUrl,
} from "./chapter";

const asset = (path: string): string => `epub://book-1/${path}`;

describe("isExternalOrFragment", () => {
  it("treats scheme URLs as external", () => {
    expect(isExternalOrFragment("https://example.com/x.png")).toBe(true);
    expect(isExternalOrFragment("data:image/png;base64,AAAA")).toBe(true);
    expect(isExternalOrFragment("mailto:a@b.c")).toBe(true);
  });

  it("treats fragment-only and empty as untouchable", () => {
    expect(isExternalOrFragment("#note-3")).toBe(true);
    expect(isExternalOrFragment("")).toBe(true);
  });

  it("treats relative paths as internal", () => {
    expect(isExternalOrFragment("../images/a.png")).toBe(false);
    expect(isExternalOrFragment("style.css")).toBe(false);
    expect(isExternalOrFragment("/OEBPS/a.png")).toBe(false);
  });
});

describe("resolveChapterUrl", () => {
  it("resolves siblings against the chapter directory", () => {
    expect(resolveChapterUrl("OEBPS/text/ch1.xhtml", "style.css")).toEqual({
      path: "OEBPS/text/style.css",
      suffix: "",
    });
  });

  it("resolves ../ against nested chapter dirs", () => {
    expect(
      resolveChapterUrl("OEBPS/text/part1/ch1.xhtml", "../../images/a.png"),
    ).toEqual({ path: "OEBPS/images/a.png", suffix: "" });
  });

  it("resolves ./ segments", () => {
    expect(resolveChapterUrl("OEBPS/ch1.xhtml", "./img/./b.jpg")).toEqual({
      path: "OEBPS/img/b.jpg",
      suffix: "",
    });
  });

  it("resolves against a chapter at the archive root", () => {
    expect(resolveChapterUrl("ch1.xhtml", "images/a.png")).toEqual({
      path: "images/a.png",
      suffix: "",
    });
  });

  it("treats a leading slash as the archive root", () => {
    expect(resolveChapterUrl("OEBPS/text/ch1.xhtml", "/images/a.png")).toEqual(
      { path: "images/a.png", suffix: "" },
    );
  });

  it("returns null when ../ escapes the archive", () => {
    expect(resolveChapterUrl("ch1.xhtml", "../outside.png")).toBeNull();
    expect(
      resolveChapterUrl("OEBPS/ch1.xhtml", "../../../etc/passwd"),
    ).toBeNull();
  });

  it("returns null for external and fragment-only URLs", () => {
    expect(
      resolveChapterUrl("OEBPS/ch1.xhtml", "https://example.com/a.png"),
    ).toBeNull();
    expect(resolveChapterUrl("OEBPS/ch1.xhtml", "#top")).toBeNull();
  });

  it("keeps query/fragment suffixes verbatim", () => {
    expect(resolveChapterUrl("OEBPS/ch1.xhtml", "notes.xhtml#n1")).toEqual({
      path: "OEBPS/notes.xhtml",
      suffix: "#n1",
    });
    expect(resolveChapterUrl("OEBPS/ch1.xhtml", "a.png?v=2")).toEqual({
      path: "OEBPS/a.png",
      suffix: "?v=2",
    });
  });

  it("decodes percent-encoded path segments", () => {
    expect(resolveChapterUrl("OEBPS/ch1.xhtml", "my%20image.png")).toEqual({
      path: "OEBPS/my image.png",
      suffix: "",
    });
  });
});

describe("prepareChapterHtml", () => {
  const chapter = (body: string, head = ""): string =>
    `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>t</title>${head}</head><body>${body}</body></html>`;

  it("rewrites relative img src to the asset protocol", () => {
    const html = prepareChapterHtml(
      chapter(`<img src="../images/pic.png" alt="p"/>`),
      "OEBPS/text/ch1.xhtml",
      asset,
    );
    expect(html).toContain(`src="epub://book-1/OEBPS/images/pic.png"`);
  });

  it("rewrites stylesheet link href", () => {
    const html = prepareChapterHtml(
      chapter("", `<link rel="stylesheet" href="../css/book.css"/>`),
      "OEBPS/text/ch1.xhtml",
      asset,
    );
    expect(html).toContain(`href="epub://book-1/OEBPS/css/book.css"`);
  });

  it("leaves fragment-only anchor links alone", () => {
    const html = prepareChapterHtml(
      chapter(`<a href="#note-1">note</a>`),
      "OEBPS/ch1.xhtml",
      asset,
    );
    expect(html).toContain(`href="#note-1"`);
    expect(html).not.toContain("epub://book-1/OEBPS/ch1.xhtml#note-1");
  });

  it("leaves external URLs alone", () => {
    const html = prepareChapterHtml(
      chapter(`<img src="https://example.com/x.png"/>`),
      "OEBPS/ch1.xhtml",
      asset,
    );
    expect(html).toContain(`src="https://example.com/x.png"`);
  });

  it("strips script elements", () => {
    const html = prepareChapterHtml(
      chapter(`<p>hi</p><script>alert(1)</script>`, `<script src="x.js"></script>`),
      "OEBPS/ch1.xhtml",
      asset,
    );
    expect(html).not.toContain("<script");
    expect(html).not.toContain("alert(1)");
    expect(html).toContain("<p>hi</p>");
  });

  it("strips inline on* event handlers", () => {
    const html = prepareChapterHtml(
      chapter(`<p onclick="evil()" onmouseover="evil()">hi</p>`),
      "OEBPS/ch1.xhtml",
      asset,
    );
    expect(html).not.toContain("onclick");
    expect(html).not.toContain("onmouseover");
    expect(html).toContain("hi");
  });

  it("strips javascript: URLs", () => {
    const html = prepareChapterHtml(
      chapter(`<a href="javascript:evil()">x</a>`),
      "OEBPS/ch1.xhtml",
      asset,
    );
    expect(html).not.toContain("javascript:");
  });

  it("injects default styles before book stylesheets", () => {
    const html = prepareChapterHtml(
      chapter("", `<link rel="stylesheet" href="book.css"/>`),
      "OEBPS/ch1.xhtml",
      asset,
    );
    const styleIdx = html.indexOf('data-epubzilla="defaults"');
    const linkIdx = html.indexOf("epub://book-1/OEBPS/book.css");
    expect(styleIdx).toBeGreaterThan(-1);
    expect(linkIdx).toBeGreaterThan(-1);
    expect(styleIdx).toBeLessThan(linkIdx);
    expect(html).toContain("max-width: 42rem");
    expect(DEFAULT_CHAPTER_CSS).not.toContain("!important");
  });

  // Issue #55: minimally-styled books get a comfortable default reading
  // measure (max-width cap, centered column, edge padding) so they no
  // longer render as full-width left-aligned text.
  it("injects a default reading measure as the first style in <head>", () => {
    const html = prepareChapterHtml(
      chapter("<p>plain, unstyled book</p>"),
      "OEBPS/ch1.xhtml",
      asset,
    );
    expect(html).toContain("max-width: 42rem");
    expect(html).toContain("margin-inline: auto");
    expect(html).toContain("padding: 2rem 1.5rem 4rem");

    const doc = new DOMParser().parseFromString(html, "text/html");
    const first = doc.head.firstElementChild;
    expect(first?.tagName.toLowerCase()).toBe("style");
    expect(first?.getAttribute("data-epubzilla")).toBe("defaults");
  });

  it("keeps the measure low priority: book <style> rules come after, no !important", () => {
    const html = prepareChapterHtml(
      chapter("", `<style>body { max-width: none; margin: 0; }</style>`),
      "OEBPS/ch1.xhtml",
      asset,
    );
    const doc = new DOMParser().parseFromString(html, "text/html");
    const styles = Array.from(doc.head.querySelectorAll("style"));
    expect(styles).toHaveLength(2);
    // Injected defaults first; the book's own body rule follows and wins
    // at equal specificity (both are plain `body` element selectors).
    expect(styles[0]?.getAttribute("data-epubzilla")).toBe("defaults");
    expect(styles[1]?.textContent).toContain("max-width: none");
    expect(DEFAULT_CHAPTER_CSS).not.toContain("!important");
  });

  it("carries the measure and dark-mode isolation in the same defaults block", () => {
    // The #55 measure must not displace the #66 color-scheme isolation.
    expect(DEFAULT_CHAPTER_CSS).toContain("color-scheme: light;");
    expect(DEFAULT_CHAPTER_CSS).toContain("background-color: Canvas;");
    expect(DEFAULT_CHAPTER_CSS).toContain("color: CanvasText;");
    expect(DEFAULT_CHAPTER_CSS).toContain("max-width: 42rem;");
    expect(DEFAULT_CHAPTER_CSS).toContain("margin-inline: auto;");
  });

  // Issue #66: system dark mode must not leak into chapter rendering.
  it("pins the chapter document to a light color scheme with explicit defaults", () => {
    const html = prepareChapterHtml(chapter("<p>hi</p>"), "OEBPS/ch1.xhtml", asset);
    expect(html).toContain("color-scheme: light;");
    expect(html).not.toContain("color-scheme: light dark");
    // Explicit render-layer background/text defaults (light-scheme UA
    // values), overridable by book CSS at equal specificity.
    expect(DEFAULT_CHAPTER_CSS).toContain("background-color: Canvas;");
    expect(DEFAULT_CHAPTER_CSS).toContain("color: CanvasText;");
    expect(DEFAULT_CHAPTER_CSS).not.toContain("!important");
  });

  it("keeps theming presentation-only: input markup is not the source of the injected style", () => {
    const source = chapter("<p>body text</p>");
    const html = prepareChapterHtml(source, "OEBPS/ch1.xhtml", asset);
    // The stored chapter never contains the injected presentation layer…
    expect(source).not.toContain("data-epubzilla");
    expect(source).not.toContain("color-scheme");
    // …it exists only in the rendered srcdoc.
    expect(html).toContain('data-epubzilla="defaults"');
  });

  // Issue #78: dark reading theme at the render layer only.
  describe("dark reading theme", () => {
    it("pins a minimally-styled chapter to a dark color scheme", () => {
      const html = prepareChapterHtml(
        chapter("<p>plain book</p>"),
        "OEBPS/ch1.xhtml",
        asset,
        new Set(),
        "dark",
      );
      expect(html).toContain("color-scheme: dark;");
      expect(html).not.toContain("color-scheme: light");
      expect(html).toContain('data-epubzilla-theme="dark"');
      // Same Canvas/CanvasText mechanism as #66 — under the dark pin they
      // resolve to the UA's dark page/light text.
      expect(DARK_CHAPTER_CSS).toContain("background-color: Canvas;");
      expect(DARK_CHAPTER_CSS).toContain("color: CanvasText;");
      expect(DARK_CHAPTER_CSS).not.toContain("!important");
    });

    it("keeps the #55 reading measure in the dark defaults", () => {
      const html = prepareChapterHtml(
        chapter("<p>plain book</p>"),
        "OEBPS/ch1.xhtml",
        asset,
        new Set(),
        "dark",
      );
      expect(html).toContain("max-width: 42rem");
      expect(html).toContain("margin-inline: auto");
      expect(html).toContain("padding: 2rem 1.5rem 4rem");
      expect(DARK_CHAPTER_CSS).toContain("max-width: 42rem;");
    });

    it("keeps author-styled chapters light: linked stylesheet", () => {
      const html = prepareChapterHtml(
        chapter("", `<link rel="stylesheet" href="book.css"/>`),
        "OEBPS/ch1.xhtml",
        asset,
        new Set(),
        "dark",
      );
      expect(html).toContain("color-scheme: light;");
      expect(html).not.toContain("color-scheme: dark");
      expect(html).toContain('data-epubzilla-theme="light"');
    });

    it("keeps author-styled chapters light: embedded <style>", () => {
      const html = prepareChapterHtml(
        chapter("", `<style>p { color: #333; }</style>`),
        "OEBPS/ch1.xhtml",
        asset,
        new Set(),
        "dark",
      );
      expect(html).toContain("color-scheme: light;");
      expect(html).not.toContain("color-scheme: dark");
    });

    it("keeps author-styled chapters light: inline color styles", () => {
      const html = prepareChapterHtml(
        chapter(`<p style="color: navy">tinted</p>`),
        "OEBPS/ch1.xhtml",
        asset,
        new Set(),
        "dark",
      );
      expect(html).toContain("color-scheme: light;");
      expect(html).not.toContain("color-scheme: dark");
    });

    it("treats structural inline styles as minimally styled", () => {
      const html = prepareChapterHtml(
        chapter(`<p style="text-align: center; margin-top: 2em">hi</p>`),
        "OEBPS/ch1.xhtml",
        asset,
        new Set(),
        "dark",
      );
      expect(html).toContain("color-scheme: dark;");
    });

    it("theming stays presentation-only under dark too", () => {
      const source = chapter("<p>body text</p>");
      const html = prepareChapterHtml(
        source,
        "OEBPS/ch1.xhtml",
        asset,
        new Set(),
        "dark",
      );
      expect(source).not.toContain("data-epubzilla");
      expect(source).not.toContain("color-scheme");
      expect(html).toContain('data-epubzilla="defaults"');
    });

    it("defaults to light when no theme is passed (unchanged behavior)", () => {
      const html = prepareChapterHtml(
        chapter("<p>hi</p>"),
        "OEBPS/ch1.xhtml",
        asset,
      );
      expect(html).toContain("color-scheme: light;");
      expect(html).toContain('data-epubzilla-theme="light"');
    });
  });

  // Issue #75: paginated reading mode at the render layer only.
  describe("paginated reading mode", () => {
    it("defaults to scrolled: no pagination block is injected", () => {
      const html = prepareChapterHtml(
        chapter("<p>hi</p>"),
        "OEBPS/ch1.xhtml",
        asset,
      );
      expect(html).not.toContain('data-epubzilla="pagination"');
      expect(html).not.toContain("column-count");
    });

    it("injects the multicol pagination block last in <head>", () => {
      const html = prepareChapterHtml(
        chapter("<p>hi</p>", `<style>p { color: #333; }</style>`),
        "OEBPS/ch1.xhtml",
        asset,
        new Set(),
        "light",
        "paginated",
      );
      expect(html).toContain('data-epubzilla="pagination"');
      expect(html).toContain("column-count: 1;");
      expect(html).toContain("column-fill: auto;");
      // The user's explicit layout choice comes after author CSS.
      expect(html.indexOf('data-epubzilla="pagination"')).toBeGreaterThan(
        html.indexOf("color: #333"),
      );
      // Layout only — the pagination layer never sets colors.
      expect(PAGINATED_CHAPTER_CSS).not.toContain("color-scheme");
      expect(PAGINATED_CHAPTER_CSS).not.toContain("background");
    });

    it("composes with the #55 measure and the light pin", () => {
      const html = prepareChapterHtml(
        chapter("<p>hi</p>"),
        "OEBPS/ch1.xhtml",
        asset,
        new Set(),
        "light",
        "paginated",
      );
      expect(html).toContain("color-scheme: light;");
      expect(html).toContain("max-width: 42rem");
      expect(html).toContain("margin-inline: auto");
      expect(html).toContain('data-epubzilla="pagination"');
    });

    it("composes with the dark reading theme", () => {
      const html = prepareChapterHtml(
        chapter("<p>plain book</p>"),
        "OEBPS/ch1.xhtml",
        asset,
        new Set(),
        "dark",
        "paginated",
      );
      expect(html).toContain("color-scheme: dark;");
      expect(html).toContain('data-epubzilla-theme="dark"');
      expect(html).toContain('data-epubzilla="pagination"');
      expect(html).toContain("max-width: 42rem");
    });

    it("pagination stays presentation-only", () => {
      const source = chapter("<p>body text</p>");
      const html = prepareChapterHtml(
        source,
        "OEBPS/ch1.xhtml",
        asset,
        new Set(),
        "light",
        "paginated",
      );
      expect(source).not.toContain("data-epubzilla");
      expect(source).not.toContain("column");
      expect(html).toContain('data-epubzilla="pagination"');
    });

    it("the pagination block does not flip author-styling detection", () => {
      // A paginated render of a minimally-styled chapter must still count
      // as minimally styled next time (the injected block is marked).
      const html = prepareChapterHtml(
        chapter("<p>plain</p>"),
        "OEBPS/ch1.xhtml",
        asset,
        new Set(),
        "dark",
        "paginated",
      );
      expect(html).toContain('data-epubzilla-theme="dark"');
    });
  });

  it("preserves UTF-8 text content", () => {
    const html = prepareChapterHtml(
      chapter(`<p>café にほん \u{1f4d6}</p>`),
      "OEBPS/ch1.xhtml",
      asset,
    );
    expect(html).toContain("café にほん \u{1f4d6}");
  });
});

describe("chapterHasAuthorStyling", () => {
  const parse = (html: string): Document =>
    new DOMParser().parseFromString(html, "text/html");

  it("is false for a bare chapter", () => {
    expect(
      chapterHasAuthorStyling(parse("<html><head></head><body><p>x</p></body></html>")),
    ).toBe(false);
  });

  it("is true for any linked stylesheet (case-insensitive rel)", () => {
    expect(
      chapterHasAuthorStyling(
        parse(`<html><head><link rel="STYLESHEET" href="a.css"></head><body></body></html>`),
      ),
    ).toBe(true);
  });

  it("is true for an embedded style element", () => {
    expect(
      chapterHasAuthorStyling(
        parse(`<html><head><style>p{margin:0}</style></head><body></body></html>`),
      ),
    ).toBe(true);
  });

  it("ignores the reader's own injected defaults", () => {
    expect(
      chapterHasAuthorStyling(
        parse(
          `<html><head><style data-epubzilla="defaults">body{}</style></head><body></body></html>`,
        ),
      ),
    ).toBe(false);
  });

  it("is true for inline background styles", () => {
    expect(
      chapterHasAuthorStyling(
        parse(`<html><body><div style="background: #fff">x</div></body></html>`),
      ),
    ).toBe(true);
  });

  it("is false for structural inline styles", () => {
    expect(
      chapterHasAuthorStyling(
        parse(`<html><body><div style="text-align: right; padding: 1em">x</div></body></html>`),
      ),
    ).toBe(false);
  });
});

describe("annotateChapterLinks (via prepareChapterHtml)", () => {
  const chapter = (body: string): string =>
    `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>t</title></head><body>${body}</body></html>`;

  const xhtmlPaths = new Set([
    "OEBPS/text/ch1.xhtml",
    "OEBPS/text/ch2.xhtml",
    "OEBPS/notes.xhtml",
  ]);

  it("annotates a sibling chapter link with the zip-internal path", () => {
    const html = prepareChapterHtml(
      chapter(`<a href="ch2.xhtml">next</a>`),
      "OEBPS/text/ch1.xhtml",
      asset,
      xhtmlPaths,
    );
    expect(html).toContain(`data-epub-link="OEBPS/text/ch2.xhtml"`);
  });

  it("resolves ../ and keeps the fragment (query dropped)", () => {
    const html = prepareChapterHtml(
      chapter(`<a href="../notes.xhtml?v=1#n3">note</a>`),
      "OEBPS/text/ch1.xhtml",
      asset,
      xhtmlPaths,
    );
    expect(html).toContain(`data-epub-link="OEBPS/notes.xhtml#n3"`);
  });

  it("does not annotate links to non-XHTML resources", () => {
    const html = prepareChapterHtml(
      chapter(`<a href="../images/map.png">map</a>`),
      "OEBPS/text/ch1.xhtml",
      asset,
      xhtmlPaths,
    );
    expect(html).not.toContain("data-epub-link");
  });

  it("leaves fragment-only links untouched", () => {
    const html = prepareChapterHtml(
      chapter(`<a href="#top">top</a>`),
      "OEBPS/text/ch1.xhtml",
      asset,
      xhtmlPaths,
    );
    expect(html).toContain(`href="#top"`);
    expect(html).not.toContain("data-epub-link");
  });

  it("strips external http(s) hrefs and marks them", () => {
    const html = prepareChapterHtml(
      chapter(`<a href="https://example.com/x">site</a>`),
      "OEBPS/text/ch1.xhtml",
      asset,
      xhtmlPaths,
    );
    expect(html).not.toContain(`href="https://example.com/x"`);
    expect(html).toContain(`data-epub-external="https://example.com/x"`);
    expect(html).toContain(`title="External link: https://example.com/x"`);
  });

  it("leaves non-http schemes (mailto:) alone", () => {
    const html = prepareChapterHtml(
      chapter(`<a href="mailto:a@b.c">mail</a>`),
      "OEBPS/text/ch1.xhtml",
      asset,
      xhtmlPaths,
    );
    expect(html).toContain(`href="mailto:a@b.c"`);
  });

  it("annotates nothing when xhtmlPaths is omitted (default arg)", () => {
    const html = prepareChapterHtml(
      chapter(`<a href="ch2.xhtml">next</a>`),
      "OEBPS/text/ch1.xhtml",
      asset,
    );
    expect(html).not.toContain("data-epub-link");
  });
});
