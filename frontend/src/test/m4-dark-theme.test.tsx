// Dark reading theme (issue #78).
//
// When the system scheme (or the in-app "Theme" toggle) is dark, the reader
// renders chapters dark AT THE RENDER LAYER ONLY: the injected defaults
// block in the srcdoc pins `color-scheme: dark` so Canvas/CanvasText resolve
// to the UA's dark page/light text. Stored EPUB content is never modified.
// Books that bring their own styling (a stylesheet, embedded <style>, or
// inline color styles) keep the pinned-light #66 rendering even under a dark
// request — we never override author colors into unreadability. Same harness
// as m1.test.tsx: the real <App/> over mocked Tauri IPC serving snapshotted
// core fixtures. The epub2 fixture is the minimally-styled case (no CSS);
// the epub3 fixture links a book stylesheet.

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
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

/** The nav "Theme: …" toggle button. */
function themeButton(): HTMLElement {
  return screen.getByRole("button", { name: /^Theme: / });
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

describe("system dark scheme with a minimally-styled book (epub2, no CSS)", () => {
  it("renders the chapter dark at the render layer, stored content untouched", async () => {
    setSystemDark(true);
    const fixture = epub2Fixture();
    const stored = fixture.chapters["c1"].content;
    mockBackend(fixture);
    await openViaDialog("Ältere Bücher: eine EPUB-2-Probe");

    const srcdoc = chapterSrcdoc();
    expect(srcdoc).toContain('data-epubzilla-theme="dark"');
    expect(srcdoc).toContain("color-scheme: dark;");
    expect(srcdoc).not.toContain("color-scheme: light");
    // The #55 measure composes with the dark defaults.
    expect(srcdoc).toContain("max-width: 42rem");
    expect(srcdoc).toContain("margin-inline: auto");
    // The frame backdrop matches the effective dark rendering.
    expect(screen.getByTitle("Chapter content").className).toContain(
      "chapter-frame-dark",
    );
    // Render-layer only: stored chapter content stays byte-identical.
    expect(fixture.chapters["c1"].content).toBe(stored);
    expect(stored).not.toContain("color-scheme");
    expect(stored).not.toContain("data-epubzilla");
  });

  it("stays light when the system scheme is light", async () => {
    mockBackend(epub2Fixture());
    await openViaDialog("Ältere Bücher: eine EPUB-2-Probe");

    const srcdoc = chapterSrcdoc();
    expect(srcdoc).toContain('data-epubzilla-theme="light"');
    expect(srcdoc).toContain("color-scheme: light;");
    expect(screen.getByTitle("Chapter content").className).not.toContain(
      "chapter-frame-dark",
    );
  });

  it("reacts to a live system scheme change under Auto", async () => {
    mockBackend(epub2Fixture());
    await openViaDialog("Ältere Bücher: eine EPUB-2-Probe");
    expect(chapterSrcdoc()).toContain('data-epubzilla-theme="light"');

    act(() => setSystemDark(true));
    expect(chapterSrcdoc()).toContain('data-epubzilla-theme="dark"');
  });
});

describe("author-styled books keep their light rendering (epub3, stylesheet)", () => {
  it("stays pinned light even when the system is dark", async () => {
    setSystemDark(true);
    mockBackend(epub3Fixture());
    await openViaDialog("Épübzïlla — 世界の本 ✓");

    const srcdoc = chapterSrcdoc();
    expect(srcdoc).toContain('data-epubzilla-theme="light"');
    expect(srcdoc).toContain("color-scheme: light;");
    expect(srcdoc).not.toContain("color-scheme: dark");
    expect(screen.getByTitle("Chapter content").className).not.toContain(
      "chapter-frame-dark",
    );
  });
});

describe("in-app theme toggle", () => {
  it("cycles Auto -> Light -> Dark -> Auto and re-renders the chapter", async () => {
    mockBackend(epub2Fixture());
    await openViaDialog("Ältere Bücher: eine EPUB-2-Probe");

    expect(themeButton().textContent).toBe("Theme: Auto");
    expect(chapterSrcdoc()).toContain('data-epubzilla-theme="light"');

    fireEvent.click(themeButton());
    expect(themeButton().textContent).toBe("Theme: Light");
    expect(chapterSrcdoc()).toContain('data-epubzilla-theme="light"');

    fireEvent.click(themeButton());
    expect(themeButton().textContent).toBe("Theme: Dark");
    expect(chapterSrcdoc()).toContain('data-epubzilla-theme="dark"');

    fireEvent.click(themeButton());
    expect(themeButton().textContent).toBe("Theme: Auto");
    expect(chapterSrcdoc()).toContain('data-epubzilla-theme="light"');
  });

  it("forcing Light overrides a dark system scheme", async () => {
    setSystemDark(true);
    mockBackend(epub2Fixture());
    await openViaDialog("Ältere Bücher: eine EPUB-2-Probe");
    expect(chapterSrcdoc()).toContain('data-epubzilla-theme="dark"');

    fireEvent.click(themeButton()); // Auto -> Light
    expect(themeButton().textContent).toBe("Theme: Light");
    expect(chapterSrcdoc()).toContain('data-epubzilla-theme="light"');
  });

  it("persists the preference to localStorage", async () => {
    mockBackend(epub2Fixture());
    await openViaDialog("Ältere Bücher: eine EPUB-2-Probe");
    fireEvent.click(themeButton()); // Auto -> Light
    fireEvent.click(themeButton()); // Light -> Dark
    expect(window.localStorage.getItem("epubzilla.reading-theme")).toBe("dark");
  });
});
