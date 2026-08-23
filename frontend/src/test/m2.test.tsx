// M2.2 component tests (issue #36): new-book wizard and metadata form.
//
// Same harness pattern as m1.test.tsx: the REAL <App/> against mocked
// Tauri IPC. Fixture books are the M1.5 snapshots; the Book returned by
// the mocked create_book is constructed here to mirror what the core
// produces for a new book (generated title page + nav, urn:uuid
// identifier, source null, dirty true).

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { clearMocks, mockConvertFileSrc, mockIPC } from "@tauri-apps/api/mocks";
import type { Book } from "@bindings/Book";
import type { Metadata } from "@bindings/Metadata";
import App from "../App";
import { epub2Fixture, epub3Fixture, type Fixture } from "./fixtures";

interface InvokeCall {
  cmd: string;
  args: Record<string, unknown>;
}

const fixturePath = (f: Fixture) => `/fixtures/${f.book.id}.epub`;

/** What the core builds for create_book: title page + nav, fresh urn:uuid. */
function newBookFromMetadata(metadata: Metadata): Book {
  return {
    id: "new-book-1",
    metadata: {
      ...metadata,
      identifier:
        metadata.identifier === ""
          ? "urn:uuid:11111111-2222-3333-4444-555555555555"
          : metadata.identifier,
      modified: "2026-08-23T00:00:00Z",
    },
    spine: [{ id: "spine-0", resource: "titlepage", linear: true }],
    nav: [{ label: "Title page", href: "OEBPS/titlepage.xhtml", children: [] }],
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
}

/**
 * M2 mock backend: everything the M1 harness served, plus create_book and
 * update_metadata. Returns the invoke log for assertions.
 */
function mockBackend(fixtures: Fixture[] = []): InvokeCall[] {
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
        const fixture = byPath.get(args.path as string);
        if (fixture === undefined) {
          throw { kind: "Io", message: `no fixture at ${String(args.path)}` };
        }
        open.set(fixture.book.id, fixture);
        return fixture.book;
      }
      case "create_book": {
        const book = newBookFromMetadata(args.metadata as Metadata);
        open.set(book.id, {
          book,
          markdown: {},
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
        const fixture = open.get(args.bookId as string);
        if (fixture === undefined) {
          throw { kind: "Io", message: "unknown book" };
        }
        const updated: Book = {
          ...fixture.book,
          metadata: args.metadata as Metadata,
          dirty: true,
        };
        open.set(updated.id, { ...fixture, book: updated });
        return updated;
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

function openNewBookDialog(): void {
  fireEvent.click(screen.getByRole("button", { name: "New book…" }));
  screen.getByRole("dialog", { name: "New book" });
}

function setTitleInput(value: string): void {
  fireEvent.change(screen.getByLabelText("Title"), { target: { value } });
}

beforeAll(() => {
  window.HTMLElement.prototype.scrollIntoView = () => undefined;
  Object.defineProperty(window, "scrollTo", { value: () => undefined });
});

afterEach(() => {
  cleanup();
  clearMocks();
});

describe("new-book wizard", () => {
  it("creates a book with the right Metadata shape (unicode input) and opens it", async () => {
    const calls = mockBackend();
    render(<App />);
    openNewBookDialog();

    // Identifier is not editable for a new book — generated by the core.
    screen.getByText("(generated on create)");

    setTitleInput("Novo Livro — 新しい本 ✓");
    fireEvent.change(screen.getByLabelText("Author 1"), {
      target: { value: "José Ærø" },
    });
    fireEvent.change(screen.getByLabelText("Language"), {
      target: { value: "pt" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create book" }));

    // create_book got the exact Metadata contract shape: empty identifier
    // (core generates a urn:uuid), nulls for the untouched optionals.
    await waitFor(() =>
      expect(calls.some((c) => c.cmd === "create_book")).toBe(true),
    );
    const created = calls.find((c) => c.cmd === "create_book");
    expect(created?.args.metadata).toEqual({
      title: "Novo Livro — 新しい本 ✓",
      authors: ["José Ærø"],
      language: "pt",
      identifier: "",
      modified: null,
      description: null,
      publisher: null,
      cover_resource: null,
    });

    // The new book slots into the reader: header identity + title page.
    await screen.findByText("Novo Livro — 新しい本 ✓");
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => {
      const frame = screen.getByTitle("Chapter content");
      expect(frame.getAttribute("srcdoc")).toContain("Novo Livro — 新しい本 ✓");
    });
    // Nav shows (generated title-page entry).
    screen.getByRole("button", { name: "Title page" });
  });

  it("blocks an empty title client-side (no IPC)", () => {
    const calls = mockBackend();
    render(<App />);
    openNewBookDialog();

    setTitleInput("   ");
    fireEvent.click(screen.getByRole("button", { name: "Create book" }));

    screen.getByText("Title is required.");
    expect(calls.some((c) => c.cmd === "create_book")).toBe(false);
    // Dialog stays open for correction.
    screen.getByRole("dialog", { name: "New book" });
  });

  it("adds and removes author rows; blanks are dropped on submit", async () => {
    const calls = mockBackend();
    render(<App />);
    openNewBookDialog();
    setTitleInput("Authors test");

    fireEvent.click(screen.getByRole("button", { name: "Add author" }));
    fireEvent.click(screen.getByRole("button", { name: "Add author" }));
    fireEvent.change(screen.getByLabelText("Author 1"), {
      target: { value: "First Author" },
    });
    fireEvent.change(screen.getByLabelText("Author 2"), {
      target: { value: "To Be Removed" },
    });
    fireEvent.change(screen.getByLabelText("Author 3"), {
      target: { value: "Third Åuthor" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Remove author 2" }));
    // Row 3 shifted up into slot 2.
    expect(screen.queryByLabelText("Author 3")).toBeNull();
    expect(
      (screen.getByLabelText("Author 2") as HTMLInputElement).value,
    ).toBe("Third Åuthor");

    fireEvent.click(screen.getByRole("button", { name: "Create book" }));
    await waitFor(() =>
      expect(calls.some((c) => c.cmd === "create_book")).toBe(true),
    );
    const created = calls.find((c) => c.cmd === "create_book");
    expect((created?.args.metadata as Metadata).authors).toEqual([
      "First Author",
      "Third Åuthor",
    ]);
  });
});

describe("edit metadata (EPUB 3)", () => {
  it("pre-fills the form and carries the identifier through the update", async () => {
    const fixture = epub3Fixture();
    const calls = mockBackend([fixture]);
    render(<App />);
    await openViaDialog("Épübzïlla — 世界の本 ✓");

    fireEvent.click(screen.getByRole("button", { name: "Edit metadata…" }));
    screen.getByRole("dialog", { name: "Edit metadata" });

    // Pre-filled from book.metadata; identifier shown read-only.
    expect((screen.getByLabelText("Title") as HTMLInputElement).value).toBe(
      "Épübzïlla — 世界の本 ✓",
    );
    expect(
      (screen.getByLabelText("Author 1") as HTMLInputElement).value,
    ).toBe("Åsa Öberg");
    const identifier = screen.getByLabelText(
      "Identifier (read-only)",
    ) as HTMLInputElement;
    expect(identifier.value).toBe(fixture.book.metadata.identifier);
    expect(identifier.readOnly).toBe(true);

    setTitleInput("Épübzïlla, second edition — 改訂版");
    fireEvent.click(screen.getByRole("button", { name: "Save metadata" }));

    await waitFor(() =>
      expect(calls.some((c) => c.cmd === "update_metadata")).toBe(true),
    );
    const update = calls.find((c) => c.cmd === "update_metadata");
    expect(update?.args.bookId).toBe(fixture.book.id);
    const payload = update?.args.metadata as Metadata;
    // NEVER an empty identifier for an existing book: the fixture's own
    // identifier must ride through the payload untouched.
    expect(payload.identifier).toBe(fixture.book.metadata.identifier);
    expect(payload.title).toBe("Épübzïlla, second edition — 改訂版");
    expect(payload.modified).toBe(fixture.book.metadata.modified);

    // Updated Book replaced state: header shows the new title, dialog gone.
    await screen.findByText("Épübzïlla, second edition — 改訂版");
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("EPUB 2 read-only affordances", () => {
  it("disables Edit metadata with an explanatory tooltip", async () => {
    mockBackend([epub2Fixture()]);
    render(<App />);
    await openViaDialog("Ältere Bücher: eine EPUB-2-Probe");

    const edit = screen.getByRole("button", { name: "Edit metadata…" });
    expect(edit).toHaveProperty("disabled", true);
    expect(edit.getAttribute("title")).toBe("EPUB 2 books are read-only");
  });

  it("keeps Edit metadata enabled for EPUB 3", async () => {
    mockBackend([epub3Fixture()]);
    render(<App />);
    await openViaDialog("Épübzïlla — 世界の本 ✓");

    const edit = screen.getByRole("button", { name: "Edit metadata…" });
    expect(edit).toHaveProperty("disabled", false);
    expect(edit.getAttribute("title")).toBeNull();
  });
});
