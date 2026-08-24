// Engine-backed regression tests for the paginated reading mode
// (issue #88), run in real WebKit — the same engine family as the Tauri
// webview where the original body.scrollLeft implementation broke.
//
// The jsdom suite could never catch that bug: jsdom performs no layout,
// so multicol fragmentation, client rects, and scroll geometry are all
// synthetic there. These tests inject the PRODUCTION bundle
// (prepareChapterHtml + lib/paginator.ts, built by global-setup.ts) into
// a real page, load a long chapter into a sandboxed same-origin iframe
// exactly like ReaderPane does, and verify real multi-page geometry and
// actual page turns:
//
// - a long chapter measures as many pages, not 1 (the #88 collapse);
// - forward/backward turns reveal every page, with no content clipped or
//   unreachable, and the chapter-cross condition (target outside
//   [0, count)) only fires at the true first/last page;
// - fragment targets land on their page;
// - a resize re-snaps the current page under the new geometry;
// - scrolled mode stays a continuous vertical column.

import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

declare global {
  interface Window {
    EpubzillaReader: typeof import("./bundle-entry");
  }
}

/** The production reader bundle, built by global-setup.ts. */
const BUNDLE = readFileSync(
  new URL("./build/reader-bundle.iife.js", import.meta.url),
  "utf8",
);

/** Paragraphs in the long-chapter fixture (spans many viewports). */
const PARAGRAPH_COUNT = 60;

/**
 * Builds the long-chapter fixture, runs it through the real
 * prepareChapterHtml pipeline, and loads the resulting srcdoc into a
 * viewport-filling sandboxed same-origin iframe (ReaderPane's setup).
 */
async function loadChapter(
  page: Page,
  mode: "scrolled" | "paginated",
): Promise<void> {
  await page.setContent(
    `<body style="margin:0">
       <iframe id="chapter" title="Chapter content"
         style="position:fixed;inset:0;width:100%;height:100%;border:0"
         sandbox="allow-same-origin"></iframe>
     </body>`,
  );
  await page.addScriptTag({ content: BUNDLE });
  await page.evaluate(
    async ({ mode, count }) => {
      const paragraphs = Array.from(
        { length: count },
        (_, i) =>
          `<p id="p${i}">Paragraph ${i}: ${"lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor. ".repeat(3)}</p>`,
      ).join("\n");
      const xhtml = `<html><head><title>ch</title></head><body><h1 id="top">A long chapter</h1>${paragraphs}</body></html>`;
      const srcdoc = window.EpubzillaReader.prepareChapterHtml(
        xhtml,
        "OEBPS/ch1.xhtml",
        (p) => `epub://book/${p}`,
        new Set(),
        "light",
        mode,
      );
      const frame = document.getElementById("chapter") as HTMLIFrameElement;
      await new Promise<void>((resolve) => {
        frame.addEventListener("load", () => resolve(), { once: true });
        frame.srcdoc = srcdoc;
      });
    },
    { mode, count: PARAGRAPH_COUNT },
  );
}

test("a long chapter measures as multiple pages, not 1 (#88 regression)", async ({
  page,
}) => {
  await loadChapter(page, "paginated");
  const result = await page.evaluate(() => {
    const R = window.EpubzillaReader;
    const doc = (document.getElementById("chapter") as HTMLIFrameElement)
      .contentDocument as Document;
    const geom = R.measurePageGeometry(doc);
    const clip = doc.body.getBoundingClientRect();
    const rect = (id: string) =>
      doc.getElementById(id)?.getBoundingClientRect() ?? null;
    const visible = (id: string) => {
      const r = rect(id);
      return r !== null && r.right > clip.left + 1 && r.left < clip.right - 1;
    };
    return {
      geom,
      current: R.currentPage(doc),
      firstVisible: visible("top"),
      lastVisible: visible(`p${59}`),
    };
  });
  expect(result.geom).not.toBeNull();
  // The #88 failure mode: the measured count collapsed to 1, so the first
  // ArrowRight crossed into the next chapter.
  expect(result.geom?.count ?? 0).toBeGreaterThanOrEqual(3);
  expect(result.geom?.step ?? 0).toBeGreaterThan(0);
  expect(result.current).toBe(0);
  expect(result.firstVisible).toBe(true);
  // Later content is clipped on page 0 — reachable only by page turns.
  expect(result.lastVisible).toBe(false);
});

test("forward turns reveal every page; the chapter cross fires only at the last page", async ({
  page,
}) => {
  await loadChapter(page, "paginated");
  const result = await page.evaluate(() => {
    const R = window.EpubzillaReader;
    const doc = (document.getElementById("chapter") as HTMLIFrameElement)
      .contentDocument as Document;
    const geom = R.measurePageGeometry(doc);
    if (geom === null) return null;
    const clip = doc.body.getBoundingClientRect();
    const ids = [
      "top",
      ...Array.from({ length: 60 }, (_, i) => `p${i}`),
    ];
    const seen = new Set<string>();
    const collect = () => {
      for (const id of ids) {
        const r = doc.getElementById(id)?.getBoundingClientRect();
        if (r && r.right > clip.left + 1 && r.left < clip.right - 1) {
          seen.add(id);
        }
      }
    };
    // ReaderPane's turnPage(+1) loop: turn until the target leaves the
    // page range — that (and only that) is the next-chapter condition.
    let turns = 0;
    let prematureCross = false;
    collect();
    for (;;) {
      const target = R.currentPage(doc) + 1;
      if (target >= geom.count) {
        prematureCross = R.currentPage(doc) !== geom.count - 1;
        break;
      }
      R.applyPage(doc, target, geom);
      turns += 1;
      collect();
    }
    return {
      count: geom.count,
      turns,
      prematureCross,
      missing: ids.filter((id) => !seen.has(id)),
      finalPage: R.currentPage(doc),
    };
  });
  expect(result).not.toBeNull();
  // Every page was visited by in-chapter turns before the cross condition.
  expect(result?.turns).toBe((result?.count ?? 0) - 1);
  expect(result?.finalPage).toBe((result?.count ?? 0) - 1);
  expect(result?.prematureCross).toBe(false);
  // No content clipped or unreachable: every element was visible somewhere.
  expect(result?.missing).toEqual([]);
});

test("backward turns from the last page reach page 0; the previous-chapter cross fires only there", async ({
  page,
}) => {
  await loadChapter(page, "paginated");
  const result = await page.evaluate(() => {
    const R = window.EpubzillaReader;
    const doc = (document.getElementById("chapter") as HTMLIFrameElement)
      .contentDocument as Document;
    const geom = R.measurePageGeometry(doc);
    if (geom === null) return null;
    // Open at the last page (what ReaderPane does when a backward chapter
    // cross lands here).
    R.applyPage(doc, geom.count - 1, geom);
    const clip = doc.body.getBoundingClientRect();
    const last = doc.getElementById("p59")?.getBoundingClientRect();
    const lastVisibleAtEnd =
      last !== undefined &&
      last.right > clip.left + 1 &&
      last.left < clip.right - 1;
    let turns = 0;
    for (;;) {
      const target = R.currentPage(doc) - 1;
      if (target < 0) break; // the previous-chapter condition
      R.applyPage(doc, target, geom);
      turns += 1;
    }
    const top = doc.getElementById("top")?.getBoundingClientRect();
    return {
      count: geom.count,
      lastVisibleAtEnd,
      turns,
      finalPage: R.currentPage(doc),
      topVisible:
        top !== undefined &&
        top.right > clip.left + 1 &&
        top.left < clip.right - 1,
    };
  });
  expect(result).not.toBeNull();
  expect(result?.lastVisibleAtEnd).toBe(true);
  expect(result?.turns).toBe((result?.count ?? 0) - 1);
  expect(result?.finalPage).toBe(0);
  expect(result?.topVisible).toBe(true);
});

test("a fragment target lands on the page containing it", async ({ page }) => {
  await loadChapter(page, "paginated");
  const result = await page.evaluate(() => {
    const R = window.EpubzillaReader;
    const doc = (document.getElementById("chapter") as HTMLIFrameElement)
      .contentDocument as Document;
    const geom = R.measurePageGeometry(doc);
    const el = doc.getElementById("p40");
    if (geom === null || el === null) return null;
    const clip = doc.body.getBoundingClientRect();
    const visible = () => {
      const r = el.getBoundingClientRect();
      return r.right > clip.left + 1 && r.left < clip.right - 1;
    };
    const visibleBefore = visible();
    const target = R.pageForElement(doc, el);
    if (target === null) return null;
    R.applyPage(doc, target, geom);
    return {
      visibleBefore,
      target,
      visibleAfter: visible(),
      current: R.currentPage(doc),
    };
  });
  expect(result).not.toBeNull();
  expect(result?.visibleBefore).toBe(false);
  expect(result?.target ?? 0).toBeGreaterThan(0);
  expect(result?.visibleAfter).toBe(true);
  expect(result?.current).toBe(result?.target);
});

test("a resize re-snaps the current page under the new geometry", async ({
  page,
}) => {
  await loadChapter(page, "paginated");
  const before = await page.evaluate(() => {
    const R = window.EpubzillaReader;
    const doc = (document.getElementById("chapter") as HTMLIFrameElement)
      .contentDocument as Document;
    const geom = R.measurePageGeometry(doc);
    if (geom === null) return null;
    R.applyPage(doc, 2, geom);
    return { count: geom.count, current: R.currentPage(doc) };
  });
  expect(before?.current).toBe(2);

  await page.setViewportSize({ width: 700, height: 500 });
  const after = await page.evaluate(() => {
    const R = window.EpubzillaReader;
    const doc = (document.getElementById("chapter") as HTMLIFrameElement)
      .contentDocument as Document;
    // ReaderPane's resize handler: re-apply the current index under the
    // re-measured geometry (re-clamped if the count shrank).
    R.applyPage(doc, R.currentPage(doc));
    const geom = R.measurePageGeometry(doc);
    if (geom === null) return null;
    const clip = doc.body.getBoundingClientRect();
    const ids = ["top", ...Array.from({ length: 60 }, (_, i) => `p${i}`)];
    const anyVisible = ids.some((id) => {
      const r = doc.getElementById(id)?.getBoundingClientRect();
      return (
        r !== undefined && r.right > clip.left + 1 && r.left < clip.right - 1
      );
    });
    return { count: geom.count, current: R.currentPage(doc), anyVisible };
  });
  expect(after).not.toBeNull();
  // The narrower, shorter viewport reflows into a different page count...
  expect(after?.count).not.toBe(before?.count);
  // ...the page index survives (clamped into the new range)...
  expect(after?.current).toBeLessThanOrEqual((after?.count ?? 1) - 1);
  // ...and the re-applied page shows content (aligned, nothing blank).
  expect(after?.anyVisible).toBe(true);
});

test("scrolled mode remains a continuous vertically scrollable column", async ({
  page,
}) => {
  await loadChapter(page, "scrolled");
  const result = await page.evaluate(() => {
    const R = window.EpubzillaReader;
    const frame = document.getElementById("chapter") as HTMLIFrameElement;
    const doc = frame.contentDocument as Document;
    const win = doc.defaultView as Window;
    win.scrollTo(0, 800);
    return {
      hasPaginator: R.getPaginator(doc) !== null,
      geometry: R.measurePageGeometry(doc),
      scrollable:
        (doc.scrollingElement?.scrollHeight ?? 0) > win.innerHeight,
      scrolledTo: win.scrollY,
    };
  });
  expect(result.hasPaginator).toBe(false);
  expect(result.geometry).toBeNull();
  expect(result.scrollable).toBe(true);
  expect(result.scrolledTo).toBe(800);
});
