import { describe, expect, it } from "vitest";
import {
  MODE_STORAGE_KEY,
  offsetForPage,
  pageAtOffset,
  pageCount,
  pageStep,
  parseReadingMode,
  readingModeLabel,
  toggleReadingMode,
} from "./readingMode";

describe("parseReadingMode", () => {
  it("accepts paginated", () => {
    expect(parseReadingMode("paginated")).toBe("paginated");
  });

  it("falls back to scrolled for anything else", () => {
    expect(parseReadingMode("scrolled")).toBe("scrolled");
    expect(parseReadingMode(null)).toBe("scrolled");
    expect(parseReadingMode(undefined)).toBe("scrolled");
    expect(parseReadingMode("pages")).toBe("scrolled");
    expect(parseReadingMode(1)).toBe("scrolled");
  });
});

describe("toggleReadingMode", () => {
  it("flips between the two modes", () => {
    expect(toggleReadingMode("scrolled")).toBe("paginated");
    expect(toggleReadingMode("paginated")).toBe("scrolled");
  });
});

describe("readingModeLabel", () => {
  it("labels both modes", () => {
    expect(readingModeLabel("scrolled")).toBe("Layout: Scrolled");
    expect(readingModeLabel("paginated")).toBe("Layout: Paginated");
  });
});

describe("storage key", () => {
  it("is namespaced like the theme key", () => {
    expect(MODE_STORAGE_KEY).toBe("epubzilla.reading-mode");
  });
});

describe("pagination geometry", () => {
  // A concrete layout: content box 600px wide, 48px column gap.
  const step = pageStep(600, 48); // 648

  it("steps by content width plus gap", () => {
    expect(step).toBe(648);
    expect(pageStep(600, 0)).toBe(600);
  });

  it("derives the page count from the scrollable range", () => {
    // clientWidth includes padding: 600 content + 2*24 padding = 648.
    // Four pages: scrollWidth = clientWidth + 3 * step.
    expect(pageCount(648 + 3 * 648, 648, step)).toBe(4);
    // Single page: nothing scrollable.
    expect(pageCount(648, 648, step)).toBe(1);
    // Engines that drop trailing padding from scrollWidth round cleanly.
    expect(pageCount(648 + 3 * 648 - 24, 648, step)).toBe(4);
    // Degenerate geometry never yields zero pages.
    expect(pageCount(0, 0, 0)).toBe(1);
    expect(pageCount(100, 648, step)).toBe(1);
  });

  it("snaps offsets to the nearest page", () => {
    expect(pageAtOffset(0, step)).toBe(0);
    expect(pageAtOffset(648, step)).toBe(1);
    expect(pageAtOffset(650, step)).toBe(1); // sub-pixel drift
    expect(pageAtOffset(3 * 648 - 2, step)).toBe(3);
    expect(pageAtOffset(-5, step)).toBe(0);
    expect(pageAtOffset(100, 0)).toBe(0);
  });

  it("clamps target pages to the chapter", () => {
    expect(offsetForPage(0, step, 4)).toBe(0);
    expect(offsetForPage(2, step, 4)).toBe(2 * 648);
    expect(offsetForPage(99, step, 4)).toBe(3 * 648); // last page
    expect(offsetForPage(-1, step, 4)).toBe(0);
    expect(offsetForPage(5, step, 0)).toBe(0);
  });
});
