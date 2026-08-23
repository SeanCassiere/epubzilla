// Default reading measure for minimally-styled books (issue #55).
//
// Live-testing feedback: books with minimal/plain CSS rendered as
// full-width left-aligned text ("unstyled html"), while generated books
// (whose stylesheet sets a centered measure) read comfortably. The reader
// injects a default measure — max-width cap, auto horizontal margins,
// comfortable padding — into the chapter body as LOW-priority CSS (the
// first <style> in <head>, plain element selectors, no !important) so any
// book rule still wins. Display-time only: stored EPUB content is never
// modified. Same harness as m1.test.tsx — the real <App/> over mocked
// Tauri IPC serving snapshotted core fixtures. The epub2 fixture is the
// minimally-styled case (no CSS at all); the epub3 fixture links a book
// stylesheet and exercises the priority ordering.

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { clearMocks, mockConvertFileSrc, mockIPC } from "@tauri-apps/api/mocks";
import App from "../App";
import { DEFAULT_CHAPTER_CSS } from "../lib/chapter";
import { epub2Fixture, epub3Fixture, type Fixture } from "./fixtures";

/** mockIPC backend serving one fixture (subset of the m1 harness). */
function mockBackend(fixture: Fixture): void {
  mockConvertFileSrc("linux");
  mockIPC((cmd, payload) => {
    const args = (payload ?? {}) as Record<string, unknown>;
    switch (cmd) {
      case "plugin:dialog|open":
        return `/fixtures/${fixture.book.id}.epub`;
      case "open_book":
        return fixture.book;
      case "read_chapter": {
        const chapter = fixture.chapters[args.resourceId as string];
        if (chapter === undefined) {
          throw { kind: "ResourceNotFound", id: String(args.resourceId) };
        }
        return chapter;
      }
      case "close_book":
        return undefined;
      default:
        throw { kind: "Io", message: `unexpected command ${cmd}` };
    }
  });
}

/** Clicks "Open book…" and waits for the book title to appear. */
async function openViaDialog(title: string): Promise<void> {
  render(<App />);
  fireEvent.click(screen.getByRole("button", { name: "Open book…" }));
  await screen.findByText(title);
}

/** The current chapter's srcdoc markup (the sandboxed iframe's content). */
function chapterSrcdoc(): string {
  const srcdoc = screen.getByTitle("Chapter content").getAttribute("srcdoc");
  expect(srcdoc).not.toBeNull();
  return srcdoc as string;
}

beforeAll(() => {
  // jsdom implements neither; the reader uses both for scroll positioning.
  window.HTMLElement.prototype.scrollIntoView = () => undefined;
  Object.defineProperty(window, "scrollTo", { value: () => undefined });
});

afterEach(() => {
  cleanup();
  clearMocks();
});

describe("reading measure for a minimally-styled book (epub2 fixture, no CSS)", () => {
  it("renders the chapter with the default measure, stored content untouched", async () => {
    const fixture = epub2Fixture();
    const stored = fixture.chapters["c1"].content;
    // The fixture really is the minimally-styled case: no CSS of its own.
    expect(stored).not.toContain("<style");
    expect(stored).not.toContain("stylesheet");

    mockBackend(fixture);
    await openViaDialog("Ältere Bücher: eine EPUB-2-Probe");

    const srcdoc = chapterSrcdoc();
    // The measure is present in the rendered document…
    expect(srcdoc).toContain('data-epubzilla="defaults"');
    expect(srcdoc).toContain("max-width: 42rem");
    expect(srcdoc).toContain("margin-inline: auto");
    expect(srcdoc).toContain("padding: 2rem 1.5rem 4rem");
    // …as the first element of <head>, without !important…
    const doc = new DOMParser().parseFromString(srcdoc, "text/html");
    const first = doc.head.firstElementChild;
    expect(first?.getAttribute("data-epubzilla")).toBe("defaults");
    expect(first?.textContent).not.toContain("!important");
    // …with the dark-mode isolation (#66) still intact alongside it.
    expect(first?.textContent).toContain("color-scheme: light;");
    expect(first?.textContent).toContain("background-color: Canvas;");

    // Display-time only: the stored chapter content is byte-identical.
    expect(fixture.chapters["c1"].content).toBe(stored);
    expect(stored).not.toContain("data-epubzilla");
    expect(stored).not.toContain("max-width");
  });
});

describe("reading measure priority against a book stylesheet (epub3 fixture)", () => {
  it("injects the measure before the book stylesheet so book rules win", async () => {
    mockBackend(epub3Fixture());
    await openViaDialog("Épübzïlla — 世界の本 ✓");

    const srcdoc = chapterSrcdoc();
    const doc = new DOMParser().parseFromString(srcdoc, "text/html");
    // First head element is the injected defaults; the book's stylesheet
    // link follows, so any book rule wins at equal specificity.
    const defaults = doc.head.firstElementChild;
    expect(defaults?.getAttribute("data-epubzilla")).toBe("defaults");
    const bookCss = doc.head.querySelector('link[rel="stylesheet"]');
    expect(bookCss).not.toBeNull();
    const position = (defaults as Element).compareDocumentPosition(
      bookCss as Node,
    );
    expect(position & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The injected block itself carries no !important escape hatch.
    expect(DEFAULT_CHAPTER_CSS).not.toContain("!important");
  });
});
