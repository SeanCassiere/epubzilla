import { describe, expect, it } from "vitest";
import {
  DEFAULT_CHAPTER_CSS,
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

  it("preserves UTF-8 text content", () => {
    const html = prepareChapterHtml(
      chapter(`<p>café にほん \u{1f4d6}</p>`),
      "OEBPS/ch1.xhtml",
      asset,
    );
    expect(html).toContain("café にほん \u{1f4d6}");
  });
});
