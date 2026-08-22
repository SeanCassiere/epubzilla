import { describe, expect, it } from "vitest";
import type { NavPoint } from "@bindings/NavPoint";
import {
  ancestorKeys,
  countNavPoints,
  findCurrentTocPath,
  isNodeExpanded,
  pathKey,
  shouldHandleNavKey,
  splitHref,
} from "./toc";

const point = (
  label: string,
  href: string | null,
  children: NavPoint[] = [],
): NavPoint => ({ label, href, children });

// Part I (section header, no href)
//   ch1  -> OEBPS/ch1.xhtml
//     sec1.1 -> OEBPS/ch1.xhtml#s1
//   ch2  -> OEBPS/ch2.xhtml
// ch2-again -> OEBPS/ch2.xhtml#alt   (duplicate target, later in doc order)
const nav: NavPoint[] = [
  point("Part I", null, [
    point("Chapter 1", "OEBPS/ch1.xhtml", [
      point("Section 1.1", "OEBPS/ch1.xhtml#s1"),
    ]),
    point("Chapter 2", "OEBPS/ch2.xhtml"),
  ]),
  point("Chapter 2 again", "OEBPS/ch2.xhtml#alt"),
];

describe("splitHref", () => {
  it("splits path and fragment", () => {
    expect(splitHref("OEBPS/ch1.xhtml#s1")).toEqual({
      path: "OEBPS/ch1.xhtml",
      fragment: "s1",
    });
  });

  it("returns null fragment when absent or empty", () => {
    expect(splitHref("OEBPS/ch1.xhtml")).toEqual({
      path: "OEBPS/ch1.xhtml",
      fragment: null,
    });
    expect(splitHref("OEBPS/ch1.xhtml#")).toEqual({
      path: "OEBPS/ch1.xhtml",
      fragment: null,
    });
  });
});

describe("findCurrentTocPath", () => {
  it("finds a nested entry, ignoring the entry's fragment", () => {
    expect(findCurrentTocPath(nav, "OEBPS/ch1.xhtml")).toEqual([0, 0]);
  });

  it("returns the FIRST match in document order for duplicate targets", () => {
    expect(findCurrentTocPath(nav, "OEBPS/ch2.xhtml")).toEqual([0, 1]);
  });

  it("returns null when no entry points at the resource", () => {
    expect(findCurrentTocPath(nav, "OEBPS/nope.xhtml")).toBeNull();
  });

  it("never matches section headers (href null)", () => {
    expect(findCurrentTocPath([point("Part", null)], "Part")).toBeNull();
  });
});

describe("pathKey / ancestorKeys", () => {
  it("keys a path", () => {
    expect(pathKey([0, 2, 1])).toBe("0.2.1");
  });

  it("lists proper ancestors only", () => {
    expect(ancestorKeys([0, 2, 1])).toEqual(["0", "0.2"]);
    expect(ancestorKeys([3])).toEqual([]);
  });
});

describe("isNodeExpanded", () => {
  const none = new Map<string, boolean>();
  const noAuto = new Set<string>();

  it("expands depth 0 by default, collapses deeper", () => {
    expect(isNodeExpanded("0", 0, none, noAuto)).toBe(true);
    expect(isNodeExpanded("0.1", 1, none, noAuto)).toBe(false);
  });

  it("auto-expands ancestors of the current chapter", () => {
    expect(isNodeExpanded("0.1", 1, none, new Set(["0.1"]))).toBe(true);
  });

  it("manual toggles override both defaults and auto-expansion", () => {
    expect(isNodeExpanded("0", 0, new Map([["0", false]]), noAuto)).toBe(
      false,
    );
    expect(
      isNodeExpanded("0.1", 1, new Map([["0.1", false]]), new Set(["0.1"])),
    ).toBe(false);
    expect(isNodeExpanded("0.2", 1, new Map([["0.2", true]]), noAuto)).toBe(
      true,
    );
  });
});

describe("countNavPoints", () => {
  it("counts all depths", () => {
    expect(countNavPoints(nav)).toBe(5);
    expect(countNavPoints([])).toBe(0);
  });
});

describe("shouldHandleNavKey", () => {
  it("handles keys outside text-entry controls", () => {
    expect(shouldHandleNavKey("BODY", false)).toBe(true);
    expect(shouldHandleNavKey("BUTTON", false)).toBe(true);
    expect(shouldHandleNavKey(null, false)).toBe(true);
  });

  it("skips inputs, textareas, selects, contenteditable", () => {
    expect(shouldHandleNavKey("INPUT", false)).toBe(false);
    expect(shouldHandleNavKey("textarea", false)).toBe(false);
    expect(shouldHandleNavKey("SELECT", false)).toBe(false);
    expect(shouldHandleNavKey("DIV", true)).toBe(false);
  });
});
