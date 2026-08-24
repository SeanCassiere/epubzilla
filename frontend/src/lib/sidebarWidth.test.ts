import { describe, expect, it } from "vitest";
import {
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  clampSidebarWidth,
  parseSidebarWidth,
} from "./sidebarWidth";

describe("clampSidebarWidth", () => {
  it("passes through values inside the range", () => {
    expect(clampSidebarWidth(300)).toBe(300);
  });

  it("clamps to the bounds", () => {
    expect(clampSidebarWidth(0)).toBe(SIDEBAR_MIN_WIDTH);
    expect(clampSidebarWidth(10_000)).toBe(SIDEBAR_MAX_WIDTH);
  });
});

describe("parseSidebarWidth", () => {
  it("parses a stored pixel value", () => {
    expect(parseSidebarWidth("321")).toBe(321);
  });

  it("clamps stored values into range", () => {
    expect(parseSidebarWidth("50")).toBe(SIDEBAR_MIN_WIDTH);
    expect(parseSidebarWidth("9999")).toBe(SIDEBAR_MAX_WIDTH);
  });

  it("falls back to the default for garbage or missing values", () => {
    expect(parseSidebarWidth(null)).toBe(SIDEBAR_DEFAULT_WIDTH);
    expect(parseSidebarWidth("")).toBe(SIDEBAR_DEFAULT_WIDTH);
    expect(parseSidebarWidth("wide")).toBe(SIDEBAR_DEFAULT_WIDTH);
    expect(parseSidebarWidth(undefined)).toBe(SIDEBAR_DEFAULT_WIDTH);
  });

  it("rounds fractional stored values", () => {
    expect(parseSidebarWidth("300.6")).toBe(301);
  });
});
