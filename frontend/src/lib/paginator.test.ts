// Unit tests for the pagination driver's pure math and DOM plumbing
// (issue #88). jsdom performs NO layout, so everything geometry-dependent
// (page counts from real column fragmentation, actual page turns, resize
// re-snapping) is covered by the engine-backed WebKit suite in
// e2e/paginated.spec.ts — the same functions driven against a real
// multicol layout. These tests pin the arithmetic and the attribute /
// transform bookkeeping with explicit geometry.

import { describe, expect, it } from "vitest";
import { prepareChapterHtml } from "./chapter";
import {
  PAGE_ATTR,
  applyPage,
  clampPage,
  currentPage,
  getPaginator,
  measurePageGeometry,
  pageCountFromExtent,
  pageFromOffset,
} from "./paginator";

/** A paginated chapter document, built via the real production pipeline. */
function paginatedDoc(): Document {
  const html = `<html><head><title>c</title></head><body>
    <p id="p1">one</p><p id="p2">two</p></body></html>`;
  const srcdoc = prepareChapterHtml(
    html,
    "OEBPS/ch1.xhtml",
    (p) => `epub://book/${p}`,
    new Set(),
    "light",
    "paginated",
  );
  return new DOMParser().parseFromString(srcdoc, "text/html");
}

describe("clampPage", () => {
  it("clamps into [0, count - 1]", () => {
    expect(clampPage(0, 4)).toBe(0);
    expect(clampPage(3, 4)).toBe(3);
    expect(clampPage(99, 4)).toBe(3);
    expect(clampPage(-1, 4)).toBe(0);
    expect(clampPage(5, 0)).toBe(0);
  });
});

describe("pageCountFromExtent", () => {
  // Concrete layout: 600px columns, 48px gap -> step 648.
  const step = 648;

  it("derives the count from the sentinel offset", () => {
    expect(pageCountFromExtent(0, step)).toBe(1); // sentinel on page 0
    expect(pageCountFromExtent(500, step)).toBe(1);
    expect(pageCountFromExtent(648, step)).toBe(2); // start of column 1
    expect(pageCountFromExtent(3 * 648 + 100, step)).toBe(4);
  });

  it("absorbs sub-pixel drift below a column boundary", () => {
    expect(pageCountFromExtent(648 - 0.4, step)).toBe(2);
    expect(pageCountFromExtent(3 * 648 - 0.25, step)).toBe(4);
  });

  it("never yields zero pages", () => {
    expect(pageCountFromExtent(-10, step)).toBe(1);
    expect(pageCountFromExtent(100, 0)).toBe(1);
  });
});

describe("pageFromOffset", () => {
  const step = 648;

  it("maps an element offset to its column", () => {
    expect(pageFromOffset(0, step)).toBe(0);
    expect(pageFromOffset(500, step)).toBe(0);
    expect(pageFromOffset(648, step)).toBe(1);
    expect(pageFromOffset(2 * 648 + 300, step)).toBe(2);
  });

  it("tolerates sub-pixel drift and degenerate input", () => {
    expect(pageFromOffset(648 - 0.4, step)).toBe(1);
    expect(pageFromOffset(-5, step)).toBe(0);
    expect(pageFromOffset(100, 0)).toBe(0);
  });
});

describe("wrapper plumbing (via prepareChapterHtml)", () => {
  it("finds the injected wrapper and starts at page 0", () => {
    const doc = paginatedDoc();
    expect(getPaginator(doc)).not.toBeNull();
    expect(currentPage(doc)).toBe(0);
  });

  it("has no wrapper in scrolled mode", () => {
    const srcdoc = prepareChapterHtml(
      "<html><head></head><body><p>x</p></body></html>",
      "OEBPS/ch1.xhtml",
      (p) => `epub://book/${p}`,
    );
    const doc = new DOMParser().parseFromString(srcdoc, "text/html");
    expect(getPaginator(doc)).toBeNull();
    expect(measurePageGeometry(doc)).toBeNull();
    expect(applyPage(doc, 3)).toBe(0);
  });

  it("returns null geometry without real layout (jsdom)", () => {
    // jsdom reports zero widths; the driver must treat that as "no
    // layout yet" rather than a one-page chapter.
    expect(measurePageGeometry(paginatedDoc())).toBeNull();
  });

  it("applyPage translates the wrapper and stamps the index", () => {
    const doc = paginatedDoc();
    const wrapper = getPaginator(doc);
    expect(wrapper).not.toBeNull();
    const geom = { step: 648, count: 4 };

    expect(applyPage(doc, 2, geom)).toBe(2);
    expect(wrapper?.getAttribute(PAGE_ATTR)).toBe("2");
    expect(wrapper?.style.transform).toBe("translateX(-1296px)");
    expect(currentPage(doc)).toBe(2);

    // Clamped at both ends; page 0 clears the transform entirely.
    expect(applyPage(doc, 99, geom)).toBe(3);
    expect(applyPage(doc, -1, geom)).toBe(0);
    expect(wrapper?.style.transform).toBe("");
    expect(currentPage(doc)).toBe(0);
  });

  it("currentPage ignores a malformed stamp", () => {
    const doc = paginatedDoc();
    getPaginator(doc)?.setAttribute(PAGE_ATTR, "bogus");
    expect(currentPage(doc)).toBe(0);
  });
});
