// M2.4 component tests (issue #38): save, save-as, and the dirty-state
// guard.
//
// Same harness pattern as m2.test.tsx: the REAL <App/> against mocked
// Tauri IPC. The dialog module is mocked with vi.mock (the pickers are
// queue-driven test doubles); the window-close decision is the pure
// `interceptClose` helper, tested directly — the onCloseRequested wiring
// stays thin and untested by design.

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
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
import type { Metadata } from "@bindings/Metadata";
import App from "../App";
import { slugifyTitle } from "../lib/dialog";
import { interceptClose } from "../lib/window";
import { epub3Fixture, type Fixture } from "./fixtures";

// Queue-driven dialog doubles: tests push the "user's" picks.
const openPicks: Array<string | null> = [];
const savePicks: Array<string | null> = [];
const savePickCalls: string[] = [];

vi.mock("../lib/dialog", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/dialog")>();
  return {
    ...actual,
    pickEpubFile: vi.fn(async () => openPicks.shift() ?? null),
    pickSaveEpubPath: vi.fn(async (defaultFileName: string) => {
      savePickCalls.push(defaultFileName);
      return savePicks.shift() ?? null;
    }),
  };
});

interface InvokeCall {
  cmd: string;
  args: Record<string, unknown>;
}

const fixturePath = (f: Fixture) => `/fixtures/${f.book.id}.epub`;

/** epub3 fixture with `source` set, as if opened from disk. */
function savedEpub3Fixture(): Fixture {
  const fixture = epub3Fixture();
  return {
    ...fixture,
    book: { ...fixture.book, source: "/books/epubzilla.epub" },
  };
}

/**
 * M2.4 mock backend: open/read/create/update plus save_book behaving like
 * the core — path required when source is null, saved Book comes back with
 * `dirty` cleared and `source` set.
 */
function mockBackend(fixtures: Fixture[] = []): InvokeCall[] {
  const calls: InvokeCall[] = [];
  const byPath = new Map(fixtures.map((f) => [fixturePath(f), f]));
  const open = new Map<string, Fixture>();
  let nextBook = 1;

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
      case "open_book": {
        const fixture = byPath.get(args.path as string);
        if (fixture === undefined) {
          throw { kind: "Io", message: `no fixture at ${String(args.path)}` };
        }
        open.set(fixture.book.id, fixture);
        return fixture.book;
      }
      case "create_book": {
        const metadata = args.metadata as Metadata;
        const n = nextBook;
        nextBook += 1;
        const book: Book = {
          id: `new-book-${n}`,
          metadata: {
            ...metadata,
            identifier: `urn:uuid:0000000${n}-2222-3333-4444-555555555555`,
            modified: "2026-08-23T00:00:00Z",
          },
          spine: [{ id: `spine-t-${n}`, resource: "titlepage", linear: true }],
          nav: [
            { label: "Title page", href: "OEBPS/titlepage.xhtml", children: [] },
          ],
          resources: [
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
      case "update_metadata": {
        const fixture = current();
        const updated: Book = {
          ...fixture.book,
          metadata: args.metadata as Metadata,
          dirty: true,
        };
        open.set(updated.id, { ...fixture, book: updated });
        return updated;
      }
      case "save_book": {
        const fixture = current();
        const path = (args.path as string | null) ?? fixture.book.source;
        if (path === null) {
          throw { kind: "Io", message: "path required for a sourceless book" };
        }
        const saved: Book = { ...fixture.book, dirty: false, source: path };
        open.set(saved.id, { ...fixture, book: saved });
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

const saveBookCalls = (calls: InvokeCall[]) =>
  calls.filter((c) => c.cmd === "save_book");
const createBookCalls = (calls: InvokeCall[]) =>
  calls.filter((c) => c.cmd === "create_book");

/** Clicks "Open book…" and waits for the book title to appear. */
async function openViaDialog(fixture: Fixture, title: string): Promise<void> {
  openPicks.push(fixturePath(fixture));
  fireEvent.click(screen.getByRole("button", { name: "Open book…" }));
  await screen.findByText(title);
}

/** Creates a new (dirty, sourceless) book through the wizard. */
async function createViaWizard(title: string): Promise<void> {
  fireEvent.click(screen.getByRole("button", { name: "New book…" }));
  const dialog = await screen.findByRole("dialog", { name: "New book" });
  fireEvent.change(within(dialog).getByLabelText("Title"), {
    target: { value: title },
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "Create book" }));
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "New book" })).toBeNull(),
  );
  await screen.findByText(title);
}

/** Makes the open fixture dirty via a metadata edit (title unchanged). */
async function dirtyViaMetadataEdit(): Promise<void> {
  fireEvent.click(screen.getByRole("button", { name: "Edit metadata…" }));
  fireEvent.click(screen.getByRole("button", { name: "Save metadata" }));
  await screen.findByLabelText("(unsaved changes)");
}

const dirtyIndicator = () => screen.queryByLabelText("(unsaved changes)");

beforeAll(() => {
  window.HTMLElement.prototype.scrollIntoView = () => undefined;
  Object.defineProperty(window, "scrollTo", { value: () => undefined });
});

afterEach(() => {
  cleanup();
  clearMocks();
  openPicks.length = 0;
  savePicks.length = 0;
  savePickCalls.length = 0;
});

describe("slugifyTitle", () => {
  it("keeps unicode, dashes whitespace, strips filesystem-hostile chars", () => {
    expect(slugifyTitle("Épübzïlla — 世界の本 ✓")).toBe("Épübzïlla-—-世界の本-✓");
    expect(slugifyTitle('a/b\\c:d*e?f"g<h>i|j')).toBe("a-b-c-d-e-f-g-h-i-j");
    expect(slugifyTitle("   ")).toBe("untitled");
    expect(slugifyTitle("--x--")).toBe("x");
  });
});

describe("interceptClose (pure window-close decision)", () => {
  it("lets a clean book close without preventDefault", () => {
    let prevented = false;
    const result = interceptClose(false, {
      preventDefault: () => {
        prevented = true;
      },
    });
    expect(result).toBe(false);
    expect(prevented).toBe(false);
  });

  it("prevents the close and reports interception when dirty", () => {
    let prevented = false;
    const result = interceptClose(true, {
      preventDefault: () => {
        prevented = true;
      },
    });
    expect(result).toBe(true);
    expect(prevented).toBe(true);
  });
});

describe("dirty indicator and save in place", () => {
  it("shows dirty after a mutation, saves in place (no path), then clears", async () => {
    const calls = mockBackend([savedEpub3Fixture()]);
    render(<App />);
    await openViaDialog(savedEpub3Fixture(), "Épübzïlla — 世界の本 ✓");

    // Clean on open: no indicator.
    expect(dirtyIndicator()).toBeNull();

    await dirtyViaMetadataEdit();

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(saveBookCalls(calls)).toHaveLength(1));

    // In place: book_id and a null path; no save dialog involved.
    expect(saveBookCalls(calls)[0].args).toEqual({
      bookId: "book-1",
      path: null,
    });
    expect(savePickCalls).toHaveLength(0);

    // The saved Book (dirty: false) was adopted: indicator gone.
    await waitFor(() => expect(dirtyIndicator()).toBeNull());
  });

  it("Cmd/Ctrl+S runs the same save flow", async () => {
    const calls = mockBackend([savedEpub3Fixture()]);
    render(<App />);
    await openViaDialog(savedEpub3Fixture(), "Épübzïlla — 世界の本 ✓");
    await dirtyViaMetadataEdit();

    fireEvent.keyDown(window, { key: "s", ctrlKey: true });
    await waitFor(() => expect(saveBookCalls(calls)).toHaveLength(1));
    expect(saveBookCalls(calls)[0].args.path).toBeNull();
    await waitFor(() => expect(dirtyIndicator()).toBeNull());
  });
});

describe("save-as", () => {
  it("prompts for a path when source is null and clears dirty on success", async () => {
    const calls = mockBackend();
    render(<App />);
    await createViaWizard("Novo Livro — 新しい本");
    expect(dirtyIndicator()).not.toBeNull();

    savePicks.push("/out/novo.epub");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(saveBookCalls(calls)).toHaveLength(1));
    // Slugified default filename went to the save dialog.
    expect(savePickCalls).toEqual(["Novo-Livro-—-新しい本.epub"]);
    expect(saveBookCalls(calls)[0].args).toEqual({
      bookId: "new-book-1",
      path: "/out/novo.epub",
    });
    await waitFor(() => expect(dirtyIndicator()).toBeNull());
  });

  it("cancelling the save dialog saves nothing and stays dirty", async () => {
    const calls = mockBackend();
    render(<App />);
    await createViaWizard("Cancelled");

    savePicks.push(null);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(savePickCalls).toHaveLength(1));
    expect(saveBookCalls(calls)).toHaveLength(0);
    expect(dirtyIndicator()).not.toBeNull();
  });

  it("'Save as…' always prompts, even when the book has a source", async () => {
    const calls = mockBackend([savedEpub3Fixture()]);
    render(<App />);
    await openViaDialog(savedEpub3Fixture(), "Épübzïlla — 世界の本 ✓");

    savePicks.push("/out/copy.epub");
    fireEvent.click(screen.getByRole("button", { name: "Save as…" }));

    await waitFor(() => expect(saveBookCalls(calls)).toHaveLength(1));
    expect(savePickCalls).toHaveLength(1);
    expect(saveBookCalls(calls)[0].args.path).toBe("/out/copy.epub");
  });
});

describe("dirty guard on 'New book…'", () => {
  it("Cancel aborts the transition: no wizard, no create_book", async () => {
    const calls = mockBackend();
    render(<App />);
    await createViaWizard("First book");
    expect(createBookCalls(calls)).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "New book…" }));
    const guard = await screen.findByRole("dialog", {
      name: "Unsaved changes",
    });
    fireEvent.click(within(guard).getByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(createBookCalls(calls)).toHaveLength(1);
    expect(saveBookCalls(calls)).toHaveLength(0);
  });

  it("Discard proceeds without saving and closes the replaced book", async () => {
    const calls = mockBackend();
    render(<App />);
    await createViaWizard("First book");

    fireEvent.click(screen.getByRole("button", { name: "New book…" }));
    const guard = await screen.findByRole("dialog", {
      name: "Unsaved changes",
    });
    fireEvent.click(within(guard).getByRole("button", { name: "Discard" }));

    // Guard gone, wizard open: complete the creation.
    const wizard = await screen.findByRole("dialog", { name: "New book" });
    fireEvent.change(within(wizard).getByLabelText("Title"), {
      target: { value: "Second book" },
    });
    fireEvent.click(
      within(wizard).getByRole("button", { name: "Create book" }),
    );
    await screen.findByText("Second book");

    expect(saveBookCalls(calls)).toHaveLength(0);
    expect(createBookCalls(calls)).toHaveLength(2);
    // Session hygiene: the replaced book was closed.
    await waitFor(() =>
      expect(
        calls.some(
          (c) => c.cmd === "close_book" && c.args.bookId === "new-book-1",
        ),
      ).toBe(true),
    );
  });

  it("Save saves first (save-as for a sourceless book), then proceeds", async () => {
    const calls = mockBackend();
    render(<App />);
    await createViaWizard("First book");

    fireEvent.click(screen.getByRole("button", { name: "New book…" }));
    const guard = await screen.findByRole("dialog", {
      name: "Unsaved changes",
    });
    savePicks.push("/out/first.epub");
    fireEvent.click(within(guard).getByRole("button", { name: "Save" }));

    // save_book ran (save-as path) and the wizard opened afterwards.
    await waitFor(() => expect(saveBookCalls(calls)).toHaveLength(1));
    expect(saveBookCalls(calls)[0].args).toEqual({
      bookId: "new-book-1",
      path: "/out/first.epub",
    });
    const wizard = await screen.findByRole("dialog", { name: "New book" });
    fireEvent.change(within(wizard).getByLabelText("Title"), {
      target: { value: "Second book" },
    });
    fireEvent.click(
      within(wizard).getByRole("button", { name: "Create book" }),
    );
    await screen.findByText("Second book");
    expect(createBookCalls(calls)).toHaveLength(2);
  });

  it("no guard when the book is clean", async () => {
    mockBackend([savedEpub3Fixture()]);
    render(<App />);
    await openViaDialog(savedEpub3Fixture(), "Épübzïlla — 世界の本 ✓");

    fireEvent.click(screen.getByRole("button", { name: "New book…" }));
    // Straight to the wizard — no unsaved-changes modal.
    await screen.findByRole("dialog", { name: "New book" });
    expect(
      screen.queryByRole("dialog", { name: "Unsaved changes" }),
    ).toBeNull();
  });
});
