// M2 milestone verification (issue #22 acceptance flow, frontend half):
// create a book → add chapters → reorder → save. The REAL <App/> against a
// mocked backend that behaves like the core (every mutation returns the
// full updated Book with dirty: true; save_book clears dirty and sets
// source). The Rust half — that the real core round-trips these commands —
// is covered by the crates/app command tests.
//
// Dialogs run through the real lib/dialog wrappers here; the plugin's IPC
// commands (plugin:dialog|open / plugin:dialog|save) are mocked at the
// mockIPC layer like every other command.

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
import type { ChapterContent } from "@bindings/ChapterContent";
import type { Metadata } from "@bindings/Metadata";
import App from "../App";

interface InvokeCall {
  cmd: string;
  args: Record<string, unknown>;
}

interface OpenState {
  book: Book;
  chapters: Record<string, ChapterContent>;
}

/** Core-shaped mock backend for the full create→edit→save lifecycle. */
function mockBackend(savePath: string): InvokeCall[] {
  const calls: InvokeCall[] = [];
  const open = new Map<string, OpenState>();
  let nextChapter = 1;

  mockConvertFileSrc("linux");
  mockIPC((cmd, payload) => {
    const args = (payload ?? {}) as Record<string, unknown>;
    calls.push({ cmd, args });

    const current = () => {
      const state = open.get(args.bookId as string);
      if (state === undefined) {
        throw { kind: "Io", message: "unknown book" };
      }
      return state;
    };

    switch (cmd) {
      case "plugin:dialog|save":
        return savePath;
      case "create_book": {
        const metadata = args.metadata as Metadata;
        const book: Book = {
          id: "lifecycle-book",
          metadata: {
            ...metadata,
            identifier: "urn:uuid:11111111-2222-3333-4444-555555555555",
            modified: "2026-08-23T00:00:00Z",
          },
          spine: [{ id: "spine-title", resource: "titlepage", linear: true }],
          nav: [
            { label: "Title page", href: "OEBPS/titlepage.xhtml", children: [] },
          ],
          resources: [
            {
              id: "nav",
              path: "OEBPS/nav.xhtml",
              media_type: "application/xhtml+xml",
              size: 0n,
            },
            {
              id: "titlepage",
              path: "OEBPS/titlepage.xhtml",
              media_type: "application/xhtml+xml",
              size: 0n,
            },
          ],
          source: null,
          epub_version: "V3",
          dirty: true,
        };
        open.set(book.id, {
          book,
          chapters: {
            titlepage: {
              resource: "titlepage",
              format: "Xhtml",
              content: `<html><body><h1>${book.metadata.title}</h1></body></html>`,
            },
          },
        });
        return book;
      }
      case "add_chapter": {
        const state = current();
        const n = nextChapter;
        nextChapter += 1;
        const title = args.title as string;
        const resourceId = `ch-${n}`;
        const path = `OEBPS/text/ch-${n}.xhtml`;
        const spine = [...state.book.spine];
        const afterId = args.after as string | null;
        const at =
          afterId === null
            ? spine.length
            : spine.findIndex((s) => s.id === afterId) + 1;
        spine.splice(at, 0, {
          id: `spine-ch-${n}`,
          resource: resourceId,
          linear: true,
        });
        const updated: Book = {
          ...state.book,
          spine,
          nav: [...state.book.nav, { label: title, href: path, children: [] }],
          resources: [
            ...state.book.resources,
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
            ...state.chapters,
            [resourceId]: {
              resource: resourceId,
              format: "Xhtml",
              content: `<html><body><h1>${title}</h1></body></html>`,
            },
          },
        });
        return updated;
      }
      case "reorder_spine": {
        const state = current();
        const order = args.order as string[];
        const byId = new Map(state.book.spine.map((s) => [s.id, s]));
        if (
          order.length !== state.book.spine.length ||
          order.some((id) => !byId.has(id))
        ) {
          throw { kind: "Io", message: "order is not a permutation" };
        }
        const updated: Book = {
          ...state.book,
          spine: order.map((id) => byId.get(id)!),
          dirty: true,
        };
        open.set(updated.id, { ...state, book: updated });
        return updated;
      }
      case "save_book": {
        const state = current();
        const path = (args.path as string | null) ?? state.book.source;
        if (path === null) {
          throw { kind: "Io", message: "path required for a sourceless book" };
        }
        const saved: Book = { ...state.book, dirty: false, source: path };
        open.set(saved.id, { ...state, book: saved });
        return saved;
      }
      case "read_chapter": {
        const chapter = current().chapters[args.resourceId as string];
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

function chapterLabels(): string[] {
  const panel = screen.getByRole("complementary", { name: "Chapters" });
  return Array.from(panel.querySelectorAll("button.toc-link")).map(
    (b) => b.textContent ?? "",
  );
}

async function addChapter(title: string): Promise<void> {
  const panel = screen.getByRole("complementary", { name: "Chapters" });
  fireEvent.click(
    within(panel).getByRole("button", { name: "Add chapter…" }),
  );
  fireEvent.change(within(panel).getByLabelText("New chapter title"), {
    target: { value: title },
  });
  fireEvent.click(within(panel).getByRole("button", { name: "Add" }));
  await within(panel).findByRole("button", { name: title });
}

beforeAll(() => {
  window.HTMLElement.prototype.scrollIntoView = () => undefined;
  Object.defineProperty(window, "scrollTo", { value: () => undefined });
});

afterEach(() => {
  cleanup();
  clearMocks();
});

describe("M2 acceptance flow (create → add chapters → reorder → save)", () => {
  it("runs end to end and ends with a clean header", async () => {
    const calls = mockBackend("/out/nova-história.epub");
    render(<App />);

    // Create a new book through the wizard.
    fireEvent.click(screen.getByRole("button", { name: "New book…" }));
    const wizard = screen.getByRole("dialog", { name: "New book" });
    fireEvent.change(within(wizard).getByLabelText("Title"), {
      target: { value: "Nova História — 物語" },
    });
    fireEvent.change(within(wizard).getByLabelText("Author 1"), {
      target: { value: "João Ñandú" },
    });
    fireEvent.click(
      within(wizard).getByRole("button", { name: "Create book" }),
    );
    await screen.findByText("Nova História — 物語");

    // A brand-new book is dirty (unsaved) from the start.
    await screen.findByLabelText("(unsaved changes)");

    // Add two chapters from the chapter panel.
    fireEvent.click(screen.getByRole("tab", { name: "Chapters" }));
    await addChapter("Capítulo Um");
    await addChapter("Capítulo Dois");
    expect(chapterLabels()).toEqual([
      "Title page",
      "Capítulo Um",
      "Capítulo Dois",
    ]);

    // Reorder: move "Capítulo Dois" up one slot.
    fireEvent.click(
      screen.getByRole("button", { name: "Move up: Capítulo Dois" }),
    );
    await waitFor(() =>
      expect(chapterLabels()).toEqual([
        "Title page",
        "Capítulo Dois",
        "Capítulo Um",
      ]),
    );
    const reorder = calls.find((c) => c.cmd === "reorder_spine");
    expect(reorder?.args.order).toEqual([
      "spine-title",
      "spine-ch-2",
      "spine-ch-1",
    ]);

    // Save: sourceless book, so the save dialog runs (mocked pick) and
    // save_book gets the picked path.
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(calls.some((c) => c.cmd === "save_book")).toBe(true),
    );
    const save = calls.find((c) => c.cmd === "save_book");
    expect(save?.args).toEqual({
      bookId: "lifecycle-book",
      path: "/out/nova-história.epub",
    });

    // The saved Book (dirty: false) was adopted: header is clean, book and
    // chapter order intact.
    await waitFor(() =>
      expect(screen.queryByLabelText("(unsaved changes)")).toBeNull(),
    );
    screen.getByText("Nova História — 物語");
    expect(chapterLabels()).toEqual([
      "Title page",
      "Capítulo Dois",
      "Capítulo Um",
    ]);
  });
});
