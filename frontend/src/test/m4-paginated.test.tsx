// Paginated reading view (issue #75).
//
// The reader gains a "Layout" toggle next to the theme toggle: Scrolled is
// the historical M1 rendering and stays the default; Paginated injects a
// render-layer multicol block into the chapter srcdoc (viewport-height
// pages, one column per page) that the parent drives via body.scrollLeft.
// Like theming, pagination is presentation-only — stored EPUB content is
// never modified — and it composes with the #55 reading measure and the
// #66/#78 color-scheme pins. jsdom performs no layout, so page-turn
// geometry is covered by the pure unit tests in lib/readingMode.test.ts;
// this file covers the mode toggle, persistence, and srcdoc composition.
// Same harness as m4-dark-theme.test.tsx: the real <App/> over mocked
// Tauri IPC serving snapshotted core fixtures.

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { clearMocks, mockConvertFileSrc, mockIPC } from "@tauri-apps/api/mocks";
import App from "../App";
import { epub2Fixture, epub3Fixture, type Fixture } from "./fixtures";
import { setSystemDark } from "./setup";

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

/** The nav "Layout: …" toggle button. */
function modeButton(): HTMLElement {
  return screen.getByRole("button", { name: /^Layout: / });
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

describe("reading-mode default", () => {
  it("renders scrolled (no pagination block) — M1 behavior unchanged", async () => {
    mockBackend(epub2Fixture());
    await openViaDialog("Ältere Bücher: eine EPUB-2-Probe");

    expect(modeButton().textContent).toBe("Layout: Scrolled");
    const srcdoc = chapterSrcdoc();
    expect(srcdoc).not.toContain('data-epubzilla="pagination"');
    expect(srcdoc).not.toContain("column-count");
    // The #55 measure and #66 light pin are still present.
    expect(srcdoc).toContain("max-width: 42rem");
    expect(srcdoc).toContain("color-scheme: light;");
  });
});

describe("mode toggle", () => {
  it("switches to paginated, injects the render layer, and back", async () => {
    const fixture = epub2Fixture();
    const stored = fixture.chapters["c1"].content;
    mockBackend(fixture);
    await openViaDialog("Ältere Bücher: eine EPUB-2-Probe");

    fireEvent.click(modeButton());
    expect(modeButton().textContent).toBe("Layout: Paginated");
    let srcdoc = chapterSrcdoc();
    expect(srcdoc).toContain('data-epubzilla="pagination"');
    expect(srcdoc).toContain("column-count: 1;");
    // Composes with the reading measure: each page IS the measure column.
    expect(srcdoc).toContain("max-width: 42rem");
    expect(srcdoc).toContain("margin-inline: auto");
    // Render-layer only: stored chapter content stays byte-identical.
    expect(fixture.chapters["c1"].content).toBe(stored);
    expect(stored).not.toContain("column");
    expect(stored).not.toContain("data-epubzilla");

    fireEvent.click(modeButton());
    expect(modeButton().textContent).toBe("Layout: Scrolled");
    srcdoc = chapterSrcdoc();
    expect(srcdoc).not.toContain('data-epubzilla="pagination"');
  });

  it("persists the mode to localStorage and restores it on next open", async () => {
    mockBackend(epub2Fixture());
    await openViaDialog("Ältere Bücher: eine EPUB-2-Probe");
    fireEvent.click(modeButton());
    expect(window.localStorage.getItem("epubzilla.reading-mode")).toBe(
      "paginated",
    );
    cleanup();
    clearMocks();

    // A fresh app render (new session) starts in the persisted mode.
    mockBackend(epub2Fixture());
    await openViaDialog("Ältere Bücher: eine EPUB-2-Probe");
    expect(modeButton().textContent).toBe("Layout: Paginated");
    expect(chapterSrcdoc()).toContain('data-epubzilla="pagination"');
  });
});

describe("composition with the reading theme", () => {
  it("paginates a dark-rendered chapter without touching its colors", async () => {
    setSystemDark(true);
    mockBackend(epub2Fixture());
    await openViaDialog("Ältere Bücher: eine EPUB-2-Probe");
    fireEvent.click(modeButton());

    const srcdoc = chapterSrcdoc();
    expect(srcdoc).toContain('data-epubzilla-theme="dark"');
    expect(srcdoc).toContain("color-scheme: dark;");
    expect(srcdoc).toContain('data-epubzilla="pagination"');
    // The pagination block itself is layout-only.
    const paginationBlock = srcdoc.slice(
      srcdoc.indexOf('data-epubzilla="pagination"'),
    );
    expect(paginationBlock).not.toContain("color-scheme");
    // The frame backdrop still matches the dark rendering.
    expect(screen.getByTitle("Chapter content").className).toContain(
      "chapter-frame-dark",
    );
  });

  it("paginates an author-styled (pinned light) book too", async () => {
    setSystemDark(true);
    mockBackend(epub3Fixture());
    await openViaDialog("Épübzïlla — 世界の本 ✓");
    fireEvent.click(modeButton());

    const srcdoc = chapterSrcdoc();
    expect(srcdoc).toContain('data-epubzilla-theme="light"');
    expect(srcdoc).toContain('data-epubzilla="pagination"');
    // The explicit layout choice is appended after author CSS references.
    expect(srcdoc.indexOf('data-epubzilla="pagination"')).toBeGreaterThan(
      srcdoc.indexOf("stylesheet"),
    );
  });
});
