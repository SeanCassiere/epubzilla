import { describe, expect, it } from "vitest";
import {
  MODE_STORAGE_KEY,
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
