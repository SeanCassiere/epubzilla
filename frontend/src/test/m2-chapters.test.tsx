// M2.3 component tests (issue #37): chapter management panel.
//
// Same harness pattern as m2.test.tsx: the REAL <App/> against mocked
// Tauri IPC. The mock backend implements add_chapter / remove_chapter /
// reorder_spine over the fixture books the way the core does: every
// mutation returns the full updated Book, which the frontend adopts as
// the truth (no optimistic updates).

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { clearMocks, mockConvertFileSrc, mockIPC } from "@tauri-apps/api/mocks";
import type { Book } from "@bindings/Book";
import App from "../App";
import { epub2Fixture, epub3Fixture, type Fixture } from "./fixtures";

interface InvokeCall {
  cmd: string;
  args: Record<string, unknown>;
}

const fixturePath = (f: Fixture) => `/fixtures/${f.book.id}.epub`;

/**
 * M2.3 mock backend: the open/read commands plus the three spine-editing
 * commands, applied to the in-memory fixture the way the core would.
 * Returns the invoke log for payload assertions.
 */
function mockBackend(fixtures: Fixture[]): InvokeCall[] {
  const calls: InvokeCall[] = [];
  const queue = [...fixtures];
  const byPath = new Map(fixtures.map((f) => [fixturePath(f), f]));
  const open = new Map<string, Fixture>();
  let nextChapter = 1;

  mockConvertFileSrc("linux");
  mockIPC((cmd, payload) => {
    const args = (payload ?? {}) as Record<string, unknown>;
    calls.push({ cmd, args });

    const current = () => {
      const fixture = open.get(args.bookId as string);
      if (fixture === undefined) {
        throw { kind: "Io", message: "unknown book" };
      }
      return fixture;
    };

    switch (cmd) {
      case "plugin:dialog|open": {
        const next = queue.shift();
        return next === undefined ? null : fixturePath(next);
      }
      case "open_book": {
        const fixture = byPath.get(args.path as string);
        if (fixture === undefined) {
          throw { kind: "Io", message: `no fixture at ${String(args.path)}` };
        }
        open.set(fixture.book.id, fixture);
        return fixture.book;
      }
      case "read_chapter": {
        const chapter = current().chapters[args.resourceId as string];
        if (chapter === undefined) {
          throw { kind: "ResourceNotFound", id: String(args.resourceId) };
        }
        return chapter;
      }
      case "add_chapter": {
        const fixture = current();
        const n = nextChapter;
        nextChapter += 1;
        const title = args.title as string;
        const resourceId = `new-ch-${n}`;
        const path = `OEBPS/text/new-ch-${n}.xhtml`;
        const spine = [...fixture.book.spine];
        const afterId = args.after as string | null;
        const at =
          afterId === null
            ? spine.length
            : spine.findIndex((s) => s.id === afterId) + 1;
        spine.splice(at, 0, {
          id: `spine-new-${n}`,
          resource: resourceId,
          linear: true,
        });
        const updated: Book = {
          ...fixture.book,
          spine,
          nav: [...fixture.book.nav, { label: title, href: path, children: [] }],
          resources: [
            ...fixture.book.resources,
            {
              id: resourceId,
              path,
              media_type: "application/xhtml+xml",
              size: 0n,
            },
          ],
          dirty: true,
        };
        open.set(updated.id, {
          book: updated,
          chapters: {
            ...fixture.chapters,
            [resourceId]: {
              resource: resourceId,
              format: "Xhtml",
              content: `<html><body><h1>${title}</h1></body></html>`,
            },
          },
        });
        return updated;
      }
      case "remove_chapter": {
        const fixture = current();
        const removed = fixture.book.spine.find(
          (s) => s.id === (args.spineItemId as string),
        );
        if (removed === undefined) {
          throw { kind: "ResourceNotFound", id: String(args.spineItemId) };
        }
        const resource = fixture.book.resources.find(
          (r) => r.id === removed.resource,
        );
        const updated: Book = {
          ...fixture.book,
          spine: fixture.book.spine.filter((s) => s.id !== removed.id),
          nav: fixture.book.nav.filter(
            (p) => p.href === null || !p.href.startsWith(resource?.path ?? ""),
          ),
          resources: fixture.book.resources.filter(
            (r) => r.id !== removed.resource,
          ),
          dirty: true,
        };
        open.set(updated.id, { ...fixture, book: updated });
        return updated;
      }
      case "reorder_spine": {
        const fixture = current();
        const order = args.order as string[];
        const byId = new Map(fixture.book.spine.map((s) => [s.id, s]));
        if (
          order.length !== fixture.book.spine.length ||
          order.some((id) => !byId.has(id))
        ) {
          throw { kind: "Io", message: "order is not a permutation" };
        }
        const updated: Book = {
          ...fixture.book,
          spine: order.map((id) => byId.get(id)!),
          dirty: true,
        };
        open.set(updated.id, { ...fixture, book: updated });
        return updated;
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

function showChaptersTab(): void {
  fireEvent.click(screen.getByRole("tab", { name: "Chapters" }));
}

/** Text of the chapter rows' navigation links, in spine order. */
function chapterLabels(panel: HTMLElement): string[] {
  return Array.from(panel.querySelectorAll("button.toc-link")).map(
    (b) => b.textContent ?? "",
  );
}

/** The chapter-panel list item currently marked as the reading position. */
function currentChapterItem(): Element {
  const panel = screen.getByRole("complementary", { name: "Chapters" });
  const current = panel.querySelector('li[aria-current="true"]');
  if (current === null) throw new Error("no current chapter row");
  return current;
}

beforeAll(() => {
  window.HTMLElement.prototype.scrollIntoView = () => undefined;
  Object.defineProperty(window, "scrollTo", { value: () => undefined });
});

afterEach(() => {
  cleanup();
  clearMocks();
});

describe("chapter panel listing", () => {
  it("lists spine items with nav labels, badges non-linear, navigates", async () => {
    mockBackend([epub3Fixture()]);
    render(<App />);
    await openViaDialog("Épübzïlla — 世界の本 ✓");
    showChaptersTab();

    const panel = screen.getByRole("complementary", { name: "Chapters" });
    // Labels resolved from nav by resource path; spine order preserved.
    expect(chapterLabels(panel)).toEqual([
      "Chapter 1 — Ünïcode",
      "Chapter 2",
      "Chapter 3",
      "Notes",
    ]);
    // The non-linear spine item (notes) is badged; linear ones are not.
    const badges = within(panel).getAllByText("non-linear");
    expect(badges).toHaveLength(1);
    expect(badges[0].closest("li")?.textContent).toContain("Notes");

    // Current chapter (first linear = ch1) is highlighted.
    expect(currentChapterItem().textContent).toContain("Chapter 1 — Ünïcode");

    // Clicking navigates the reader (existing goTo path).
    fireEvent.click(within(panel).getByRole("button", { name: "Chapter 3" }));
    await waitFor(() =>
      expect(currentChapterItem().textContent).toContain("Chapter 3"),
    );
    const frame = screen.getByTitle("Chapter content");
    expect(frame.getAttribute("srcdoc")).toContain("Chapter 3");
  });

  it("falls back to the resource file stem when nav has no entry", async () => {
    const fixture = epub3Fixture();
    // Strip the nav so no label resolves.
    fixture.book = { ...fixture.book, nav: [] };
    mockBackend([fixture]);
    render(<App />);
    await openViaDialog("Épübzïlla — 世界の本 ✓");
    showChaptersTab();

    const panel = screen.getByRole("complementary", { name: "Chapters" });
    within(panel).getByRole("button", { name: "ch1" });
    within(panel).getByRole("button", { name: "notes" });
  });
});

describe("add chapter", () => {
  it("adds after the current spine item and navigates to the new chapter", async () => {
    const calls = mockBackend([epub3Fixture()]);
    render(<App />);
    await openViaDialog("Épübzïlla — 世界の本 ✓");
    showChaptersTab();

    fireEvent.click(screen.getByRole("button", { name: "Add chapter…" }));
    fireEvent.change(screen.getByLabelText("New chapter title"), {
      target: { value: "Zwischenspiel — 間奏 ✓" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    // Payload: after = the CURRENT spine item id (ch1 = spine-0).
    await waitFor(() =>
      expect(calls.some((c) => c.cmd === "add_chapter")).toBe(true),
    );
    const add = calls.find((c) => c.cmd === "add_chapter");
    expect(add?.args).toEqual({
      bookId: "book-1",
      title: "Zwischenspiel — 間奏 ✓",
      after: "spine-0",
    });

    // The reader navigated to the new chapter (adopted Book is the truth).
    await waitFor(() =>
      expect(currentChapterItem().textContent).toContain(
        "Zwischenspiel — 間奏 ✓",
      ),
    );
    // It sits right after the old current chapter.
    const panel = screen.getByRole("complementary", { name: "Chapters" });
    expect(chapterLabels(panel)[1]).toBe("Zwischenspiel — 間奏 ✓");
    const frame = screen.getByTitle("Chapter content");
    await waitFor(() =>
      expect(frame.getAttribute("srcdoc")).toContain("Zwischenspiel — 間奏 ✓"),
    );
  });
});

describe("remove chapter", () => {
  it("requires confirmation and sends the right payload", async () => {
    const calls = mockBackend([epub3Fixture()]);
    render(<App />);
    await openViaDialog("Épübzïlla — 世界の本 ✓");
    showChaptersTab();

    fireEvent.click(
      screen.getByRole("button", { name: "Remove: Chapter 2" }),
    );
    // Nothing sent yet — inline confirm is required.
    expect(calls.some((c) => c.cmd === "remove_chapter")).toBe(false);

    // Cancel first: still nothing.
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(calls.some((c) => c.cmd === "remove_chapter")).toBe(false);

    fireEvent.click(
      screen.getByRole("button", { name: "Remove: Chapter 2" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Confirm removal" }));
    await waitFor(() =>
      expect(calls.some((c) => c.cmd === "remove_chapter")).toBe(true),
    );
    const remove = calls.find((c) => c.cmd === "remove_chapter");
    expect(remove?.args).toEqual({
      bookId: "book-1",
      spineItemId: "spine-1",
    });

    // The row is gone; the current chapter (ch1) is untouched.
    const panel = screen.getByRole("complementary", { name: "Chapters" });
    await waitFor(() =>
      expect(
        within(panel).queryByRole("button", { name: "Chapter 2" }),
      ).toBeNull(),
    );
    expect(currentChapterItem().textContent).toContain("Chapter 1 — Ünïcode");
  });

  it("falls back to a neighbor when the current chapter is removed", async () => {
    const calls = mockBackend([epub3Fixture()]);
    render(<App />);
    await openViaDialog("Épübzïlla — 世界の本 ✓");
    showChaptersTab();

    // Current is ch1 (spine-0); remove it.
    fireEvent.click(
      screen.getByRole("button", { name: "Remove: Chapter 1 — Ünïcode" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Confirm removal" }));

    await waitFor(() =>
      expect(calls.some((c) => c.cmd === "remove_chapter")).toBe(true),
    );
    // The reader moved to the next linear chapter (ch2).
    await waitFor(() =>
      expect(currentChapterItem().textContent).toContain("Chapter 2"),
    );
    const frame = screen.getByTitle("Chapter content");
    expect(frame.getAttribute("srcdoc")).toContain("Chapter 2");
  });
});

describe("reorder spine", () => {
  it("move down sends the exact full permutation with the two ids swapped", async () => {
    const calls = mockBackend([epub3Fixture()]);
    render(<App />);
    await openViaDialog("Épübzïlla — 世界の本 ✓");
    showChaptersTab();

    fireEvent.click(
      screen.getByRole("button", { name: "Move down: Chapter 1 — Ünïcode" }),
    );
    await waitFor(() =>
      expect(calls.some((c) => c.cmd === "reorder_spine")).toBe(true),
    );
    const reorder = calls.find((c) => c.cmd === "reorder_spine");
    expect(reorder?.args).toEqual({
      bookId: "book-1",
      order: ["spine-1", "spine-0", "spine-2", "spine-3"],
    });

    // Adopted order shows in the list; the current chapter followed its
    // spine item to the new slot (still ch1, no reload needed).
    const panel = screen.getByRole("complementary", { name: "Chapters" });
    await waitFor(() => {
      expect(chapterLabels(panel)).toEqual([
        "Chapter 2",
        "Chapter 1 — Ünïcode",
        "Chapter 3",
        "Notes",
      ]);
    });
    expect(currentChapterItem().textContent).toContain("Chapter 1 — Ünïcode");
  });

  it("disables move up on the first item and move down on the last", async () => {
    mockBackend([epub3Fixture()]);
    render(<App />);
    await openViaDialog("Épübzïlla — 世界の本 ✓");
    showChaptersTab();

    expect(
      screen.getByRole("button", { name: "Move up: Chapter 1 — Ünïcode" }),
    ).toHaveProperty("disabled", true);
    expect(
      screen.getByRole("button", { name: "Move down: Notes" }),
    ).toHaveProperty("disabled", true);
  });
});

describe("EPUB 2 read-only chapters", () => {
  it("hides all mutation affordances but keeps the list and navigation", async () => {
    mockBackend([epub2Fixture()]);
    render(<App />);
    await openViaDialog("Ältere Bücher: eine EPUB-2-Probe");
    showChaptersTab();

    const panel = screen.getByRole("complementary", { name: "Chapters" });
    within(panel).getByRole("button", { name: "Erstes Kapitel" });
    within(panel).getByRole("button", { name: "Zweites Kapitel" });
    expect(screen.queryByRole("button", { name: "Add chapter…" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Remove:/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Move up:/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Move down:/ })).toBeNull();

    // Navigation still works.
    fireEvent.click(
      within(panel).getByRole("button", { name: "Zweites Kapitel" }),
    );
    await waitFor(() =>
      expect(currentChapterItem().textContent).toContain("Zweites Kapitel"),
    );
  });
});

describe("sidebar tabs", () => {
  it("keeps the TOC tab working alongside the chapter panel", async () => {
    mockBackend([epub3Fixture()]);
    render(<App />);
    await openViaDialog("Épübzïlla — 世界の本 ✓");

    // Contents is the default tab: the TOC tree renders as before.
    screen.getByRole("complementary", { name: "Table of contents" });
    screen.getByText("Part I — Beginnings");

    // Switch to Chapters and back; TOC navigation still works.
    showChaptersTab();
    expect(
      screen.queryByRole("complementary", { name: "Table of contents" }),
    ).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "Contents" }));
    const toc = screen.getByRole("complementary", {
      name: "Table of contents",
    });
    fireEvent.click(within(toc).getByRole("button", { name: "Chapter 3" }));
    await waitFor(() => {
      const frame = screen.getByTitle("Chapter content");
      expect(frame.getAttribute("srcdoc")).toContain("Chapter 3");
    });
  });
});
