// M1 milestone integration harness (issue #29).
//
// Drives the REAL <App/> against mocked Tauri IPC (`mockIPC` from
// @tauri-apps/api/mocks — the documented Tauri frontend-testing approach;
// tauri-driver/WebDriver has no macOS support and a real webview is brittle
// on CI). The data served over the mock is NOT hand-typed: it is snapshotted
// real command output from `epubzilla_core::Session` — see fixtures.ts.
//
// Covered M1 acceptance criteria: metadata + TOC display for EPUB 3 and
// EPUB 2 (NCX), chapter rendering with rewritten epub:// CSS/image URLs and
// scripts stripped, TOC-click navigation with current-position highlight and
// fragment handling, next/prev in spine order skipping non-linear items, and
// readable CoreError surfacing. Left to a live manual run: the OS file
// dialog itself and the 500-chapter performance budget.

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { clearMocks, mockConvertFileSrc, mockIPC } from "@tauri-apps/api/mocks";
import type { CoreError } from "@bindings/CoreError";
import App from "../App";
import { epub2Fixture, epub3Fixture, type Fixture } from "./fixtures";

interface InvokeCall {
  cmd: string;
  args: Record<string, unknown>;
}

interface BackendOptions {
  /** Fixtures the dialog offers, in click order; keyed to open_book paths. */
  fixtures?: Fixture[];
  /** When set, open_book rejects with this CoreError. */
  openError?: CoreError;
}

const fixturePath = (f: Fixture) => `/fixtures/${f.book.id}.epub`;

/**
 * Wires mockIPC to behave like the M1 backend: the dialog hands out one
 * fixture path per click, open_book/read_chapter serve the snapshotted
 * command results, failures are thrown as typed CoreError objects (the IPC
 * error contract). Returns the invoke log for assertions.
 */
function mockBackend({ fixtures = [], openError }: BackendOptions): InvokeCall[] {
  const calls: InvokeCall[] = [];
  const queue = [...fixtures];
  const byPath = new Map(fixtures.map((f) => [fixturePath(f), f]));
  const open = new Map<string, Fixture>();

  mockConvertFileSrc("linux");
  mockIPC((cmd, payload) => {
    const args = (payload ?? {}) as Record<string, unknown>;
    calls.push({ cmd, args });

    switch (cmd) {
      case "plugin:dialog|open": {
        const next = queue.shift();
        return next === undefined ? null : fixturePath(next);
      }
      case "open_book": {
        if (openError !== undefined) throw openError;
        const fixture = byPath.get(args.path as string);
        if (fixture === undefined) {
          throw { kind: "Io", message: `no fixture at ${String(args.path)}` };
        }
        open.set(fixture.book.id, fixture);
        return fixture.book;
      }
      case "read_chapter": {
        const chapter = open
          .get(args.bookId as string)
          ?.chapters[args.resourceId as string];
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
  return calls;
}

/** Clicks "Open book…" and waits for the book title to appear. */
async function openViaDialog(title: string): Promise<void> {
  fireEvent.click(screen.getByRole("button", { name: "Open book…" }));
  await screen.findByText(title);
}

/** The current chapter's srcdoc markup (the sandboxed iframe's content). */
function chapterSrcdoc(): string {
  const frame = screen.getByTitle("Chapter content");
  const srcdoc = frame.getAttribute("srcdoc");
  expect(srcdoc).not.toBeNull();
  return srcdoc as string;
}

function readChapterCalls(calls: InvokeCall[]): InvokeCall[] {
  return calls.filter((c) => c.cmd === "read_chapter");
}

/** The TOC treeitem currently marked as the reading position. */
function currentTocItem(): Element {
  const current = document.querySelector('[role="treeitem"][aria-current="true"]');
  expect(current).not.toBeNull();
  return current as Element;
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

describe("open an EPUB 3 (real fixture data over mocked IPC)", () => {
  it("shows unicode metadata and the nested TOC tree", async () => {
    const calls = mockBackend({ fixtures: [epub3Fixture()] });
    render(<App />);
    await openViaDialog("Épübzïlla — 世界の本 ✓");

    // open_book received the dialog's path.
    const opened = calls.find((c) => c.cmd === "open_book");
    expect(opened?.args.path).toBe("/fixtures/book-1.epub");

    // Unicode authors from dc:creator.
    screen.getByText("Åsa Öberg, 李雷");

    // Nested tree: the section header and its depth-1 children render;
    // deeper levels stay unmounted until expanded.
    screen.getByText("Part I — Beginnings");
    screen.getByRole("button", { name: "Chapter 1 — Ünïcode" });
    screen.getByRole("button", { name: "Chapter 3" });
    expect(screen.queryByText("Section 2.1")).toBeNull();
    const carets = screen.getAllByRole("button", { name: "Expand section" });
    fireEvent.click(carets[carets.length - 1]); // "Chapter 2" branch
    screen.getByRole("button", { name: "Section 2.1" });

    // First linear chapter loaded automatically.
    expect(readChapterCalls(calls).map((c) => c.args.resourceId)).toEqual([
      "ch1",
    ]);
    screen.getByText("chapter 1 of 3");
  });

  it("renders the chapter with rewritten epub:// URLs, scripts stripped, links annotated", async () => {
    mockBackend({ fixtures: [epub3Fixture()] });
    render(<App />);
    await openViaDialog("Épübzïlla — 世界の本 ✓");

    const srcdoc = chapterSrcdoc();
    // Image and stylesheet resolve through the epub:// asset protocol
    // (mockConvertFileSrc("linux"): epub://localhost/<encoded book-scoped path>).
    expect(srcdoc).toContain(
      `epub://localhost/${encodeURIComponent("book-1/OEBPS/images/pic.png")}`,
    );
    expect(srcdoc).toContain(
      `epub://localhost/${encodeURIComponent("book-1/OEBPS/styles/book.css")}`,
    );
    // Active content is stripped.
    expect(srcdoc).not.toContain("<script");
    expect(srcdoc).not.toContain("must be stripped");
    // Inter-chapter link annotated for app navigation, fragment kept.
    expect(srcdoc).toContain('data-epub-link="OEBPS/text/ch2.xhtml#sec21"');
    // External links are disarmed but preserved for hover.
    expect(srcdoc).toContain('data-epub-external="https://example.com/"');
    expect(srcdoc).not.toContain('href="https://example.com/"');
  });

  // Issue #66: with the OS in dark mode the app chrome goes dark, but the
  // reader document must stay isolated on a light color scheme so UA
  // dark-scheme text colors never render white-on-white chapter text.
  it("isolates the reader iframe on a light color scheme without touching stored chapter content", async () => {
    const fixture = epub3Fixture();
    const storedContent = fixture.chapters["ch1"].content;
    mockBackend({ fixtures: [fixture] });
    render(<App />);
    await openViaDialog("Épübzïlla — 世界の本 ✓");

    const srcdoc = chapterSrcdoc();
    // Presentation layer present in the rendered iframe doc only.
    expect(srcdoc).toContain('data-epubzilla="defaults"');
    expect(srcdoc).toContain("color-scheme: light;");
    expect(srcdoc).not.toContain("color-scheme: light dark");
    // Stored chapter content is byte-identical: no theme styles persisted.
    expect(fixture.chapters["ch1"].content).toBe(storedContent);
    expect(storedContent).not.toContain("data-epubzilla");
    expect(storedContent).not.toContain("color-scheme");
  });

  it("navigates on TOC clicks: right resource, fragment handling, moving highlight", async () => {
    const calls = mockBackend({ fixtures: [epub3Fixture()] });
    render(<App />);
    await openViaDialog("Épübzïlla — 世界の本 ✓");
    expect(currentTocItem().textContent).toContain("Chapter 1 — Ünïcode");

    // Jump to Chapter 3.
    fireEvent.click(screen.getByRole("button", { name: "Chapter 3" }));
    await waitFor(() =>
      expect(readChapterCalls(calls).map((c) => c.args.resourceId)).toEqual([
        "ch1",
        "ch3",
      ]),
    );
    expect(chapterSrcdoc()).toContain("The end.");
    expect(currentTocItem().textContent).toContain("Chapter 3");
    screen.getByText("chapter 3 of 3");

    // A fragment entry loads the right chapter (fragment passed through the
    // href split)...
    const carets = screen.getAllByRole("button", { name: "Expand section" });
    fireEvent.click(carets[carets.length - 1]);
    fireEvent.click(screen.getByRole("button", { name: "Section 2.1" }));
    await waitFor(() =>
      expect(readChapterCalls(calls).map((c) => c.args.resourceId)).toEqual([
        "ch1",
        "ch3",
        "ch2",
      ]),
    );
    expect(currentTocItem().textContent).toContain("Chapter 2");
    screen.getByText("chapter 2 of 3");

    // ...and a fragment within the CURRENT chapter only re-scrolls: no reload.
    fireEvent.click(screen.getByRole("button", { name: "Section 2.1" }));
    expect(readChapterCalls(calls)).toHaveLength(3);
  });

  it("next/prev follow spine order and skip the non-linear item", async () => {
    const calls = mockBackend({ fixtures: [epub3Fixture()] });
    render(<App />);
    await openViaDialog("Épübzïlla — 世界の本 ✓");
    screen.getByText("chapter 1 of 3");
    expect(
      screen.getByRole("button", { name: "← Previous" }),
    ).toHaveProperty("disabled", true);

    fireEvent.click(screen.getByRole("button", { name: "Next →" }));
    await screen.findByText("chapter 2 of 3");
    fireEvent.click(screen.getByRole("button", { name: "Next →" }));
    await screen.findByText("chapter 3 of 3");

    // "notes" is spine index 3 but linear="no": Next must now be disabled,
    // and the non-linear chapter was never requested.
    expect(screen.getByRole("button", { name: "Next →" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(readChapterCalls(calls).map((c) => c.args.resourceId)).toEqual([
      "ch1",
      "ch2",
      "ch3",
    ]);

    fireEvent.click(screen.getByRole("button", { name: "← Previous" }));
    await screen.findByText("chapter 2 of 3");
    expect(readChapterCalls(calls).map((c) => c.args.resourceId)).toEqual([
      "ch1",
      "ch2",
      "ch3",
      "ch2",
    ]);
  });
});

describe("open an EPUB 2 (NCX-derived nav)", () => {
  it("shows metadata, the NCX TOC tree, and navigates", async () => {
    const calls = mockBackend({ fixtures: [epub2Fixture()] });
    render(<App />);
    await openViaDialog("Ältere Bücher: eine EPUB-2-Probe");

    screen.getByText("Grüße Müller");
    // NCX navMap became the same NavPoint tree: nested child visible under
    // the expanded-by-default depth-0 entry.
    screen.getByRole("button", { name: "Erstes Kapitel" });
    screen.getByRole("button", { name: "Abschnitt Eins" });
    screen.getByText("chapter 1 of 2");
    expect(chapterSrcdoc()).toContain("Grüße aus einem EPUB-2-Buch.");

    fireEvent.click(screen.getByRole("button", { name: "Zweites Kapitel" }));
    await screen.findByText("chapter 2 of 2");
    expect(readChapterCalls(calls).map((c) => c.args.resourceId)).toEqual([
      "c1",
      "c2",
    ]);
    expect(currentTocItem().textContent).toContain("Zweites Kapitel");
  });
});

describe("failure surfaces", () => {
  it("shows a readable error when open_book rejects with a CoreError", async () => {
    mockBackend({
      fixtures: [epub3Fixture()],
      openError: { kind: "NotAnEpub", message: "missing mimetype entry" },
    });
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Open book…" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("NotAnEpub: missing mimetype entry");
    // Nothing opened: the reader still shows the empty state.
    screen.getByText("No book open. Use “Open book…” to pick an EPUB.");
  });
});
