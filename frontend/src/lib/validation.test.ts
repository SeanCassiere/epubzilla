// Pure mapping helpers for the validation panel (issue #72).

import { describe, expect, it } from "vitest";
import type { ValidationIssue } from "@bindings/ValidationIssue";
import {
  countIssues,
  issueTargetPath,
  locationLabel,
  summarizeIssues,
} from "./validation";
import { epub3Fixture } from "../test/fixtures";

const issue = (
  severity: ValidationIssue["severity"],
  location: string | null,
  message = "boom",
): ValidationIssue => ({ severity, location, message });

describe("issueTargetPath", () => {
  const { book } = epub3Fixture();

  it("maps a spine chapter path to a click-through target", () => {
    expect(issueTargetPath(book, issue("Error", "OEBPS/text/ch2.xhtml"))).toBe(
      "OEBPS/text/ch2.xhtml",
    );
  });

  it("includes non-linear spine items (the reader can open them)", () => {
    expect(
      issueTargetPath(book, issue("Error", "OEBPS/text/notes.xhtml")),
    ).toBe("OEBPS/text/notes.xhtml");
  });

  it("is null for locations without a target", () => {
    // No location at all.
    expect(issueTargetPath(book, issue("Error", null))).toBeNull();
    // The OPF (or anything outside the manifest).
    expect(
      issueTargetPath(book, issue("Error", "OEBPS/content.opf")),
    ).toBeNull();
    // Manifest resources that are not spine chapters.
    expect(
      issueTargetPath(book, issue("Error", "OEBPS/images/pic.png")),
    ).toBeNull();
    expect(
      issueTargetPath(book, issue("Error", "OEBPS/nav.xhtml")),
    ).toBeNull();
  });
});

describe("countIssues / summarizeIssues", () => {
  it("counts by severity", () => {
    const issues = [
      issue("Error", null),
      issue("Warning", null),
      issue("Error", null),
    ];
    expect(countIssues(issues)).toEqual({ errors: 2, warnings: 1 });
  });

  it("summarizes with correct pluralization", () => {
    expect(summarizeIssues([])).toBe("No issues found");
    expect(summarizeIssues([issue("Error", null)])).toBe("1 error");
    expect(
      summarizeIssues([issue("Error", null), issue("Error", null)]),
    ).toBe("2 errors");
    expect(summarizeIssues([issue("Warning", null)])).toBe("1 warning");
    expect(
      summarizeIssues([
        issue("Error", null),
        issue("Warning", null),
        issue("Warning", null),
      ]),
    ).toBe("1 error, 2 warnings");
  });
});

describe("locationLabel", () => {
  it("shows the file name", () => {
    expect(locationLabel("OEBPS/text/ch1.xhtml")).toBe("ch1.xhtml");
    expect(locationLabel("mimetype")).toBe("mimetype");
  });
});
