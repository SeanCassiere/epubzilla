// M3 milestone verification (issue #23 acceptance criteria, frontend half;
// issue #46). The REAL <App/> over mocked IPC — but unlike the per-feature
// M3 suites, read_chapter(prefer: Markdown) here serves the REAL core
// conversion output: the `markdown` snapshots in the committed fixtures are
// produced by `epubzilla_core::Session` (crates/app/tests/gen_fixtures.rs),
// so in-subset chapters arrive as core-generated Markdown and out-of-subset
// chapters arrive as the core's Xhtml fallback. The Rust half — that the
// same command path round-trips through real XHTML serialization on disk —
// is crates/core/tests/epubcheck_fixtures.rs (edited-roundtrip.epub).
//
// Editor surfaces are mocked to <textarea>s per the established pattern
// (the real Milkdown surface is exercised in m3-milkdown.test.tsx).

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
import type { ChapterContent } from "@bindings/ChapterContent";
import type { Metadata } from "@bindings/Metadata";
import App from "../App";
import { epub3Fixture } from "./fixtures";

vi.mock("../components/CodeEditor", () => ({
  CodeEditor: ({
    value,
    language,
    onChange,
  }: {
    value: string;
    language: string;
    onChange: (next: string) => void;
  }) => (
    <textarea
      aria-label="chapter buffer"
      data-language={language}
      data-surface="source"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  ),
}));

vi.mock("../components/MilkdownEditor", () => ({
  MilkdownEditor: ({
    value,
    onChange,
  }: {
    value: string;
    onChange: (next: string) => void;
  }) => (
    <textarea
      aria-label="chapter buffer"
      data-surface="wysiwyg"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  ),
}));

interface InvokeCall {
  cmd: string;
  args: Record<string, unknown>;
}

// Real core output for the epub3 fixture (see gen_fixtures.rs): ch1 and ch2
// are outside the round-trip subset (script / fragment anchor), ch3 is
// inside it and converts to Markdown.
const fixture = epub3Fixture();
const CH3_MD = fixture.markdown.ch3.content;

/**
 * M3 backend over the epub3 fixture: read_chapter serves the REAL snapshots
 * (`prefer: Markdown` → the core's markdown/fallback output, otherwise the
 * Xhtml snapshot); write_chapter dirties, save_book cleans.
 */
function mockBackend(): InvokeCall[] {
  const calls: InvokeCall[] = [];
  let book: Book = { ...fixture.book, source: "/books/fixture.epub" };

  mockConvertFileSrc("linux");
  mockIPC((cmd, payload) => {
    const args = (payload ?? {}) as Record<string, unknown>;
    calls.push({ cmd, args });
    switch (cmd) {
      case "plugin:dialog|open":
        return "/books/fixture.epub";
      case "open_book":
        return book;
      case "read_chapter": {
        const id = args.resourceId as string;
        const snapshot =
          args.prefer === "Markdown"
            ? fixture.markdown[id]
            : fixture.chapters[id];
        if (snapshot === undefined) {
          throw { kind: "ResourceNotFound", id };
        }
        return snapshot;
      }
      case "write_chapter":
        book = { ...book, dirty: true };
        return book;
      case "save_book":
        book = {
          ...book,
          dirty: false,
          source: (args.path as string | null) ?? book.source,
        };
        return book;
      case "close_book":
        return null;
      default:
        throw { kind: "Io", message: `unmocked command ${cmd}` };
    }
  });
  return calls;
}

async function openFixture(calls: InvokeCall[]): Promise<void> {
  render(<App />);
  fireEvent.click(screen.getByRole("button", { name: /open book/i }));
  await waitFor(() =>
    expect(calls.some((c) => c.cmd === "read_chapter")).toBe(true),
  );
}

/** Navigate the reader from ch1 to ch3 (the in-subset chapter). */
async function goToCh3(calls: InvokeCall[]): Promise<void> {
  for (const target of ["ch2", "ch3"]) {
    fireEvent.click(screen.getByRole("button", { name: /next/i }));
    await waitFor(() => {
      const reads = calls.filter((c) => c.cmd === "read_chapter");
      expect(reads[reads.length - 1]?.args.resourceId).toBe(target);
    });
  }
}

const buffer = () =>
  screen.getByLabelText("chapter buffer") as HTMLTextAreaElement;

beforeAll(() => {
  window.HTMLElement.prototype.scrollIntoView ??= () => undefined;
});

afterEach(() => {
  cleanup();
  clearMocks();
  sessionStorage.clear();
});

describe("M3 acceptance: edit round-trip with real core output", () => {
  it("loads the REAL core-produced markdown, applies an edit, and the reader reflects dirty", async () => {
    const calls = mockBackend();
    await openFixture(calls);
    await goToCh3(calls);
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));

    // The buffer holds exactly what the core converted ch3 to.
    const b = (await screen.findByLabelText(
      "chapter buffer",
    )) as HTMLTextAreaElement;
    expect(fixture.markdown.ch3.format).toBe("Markdown");
    expect(b.value).toBe(CH3_MD);
    expect(b.getAttribute("data-surface")).toBe("wysiwyg");
    const read = calls.filter(
      (c) => c.cmd === "read_chapter" && c.args.prefer === "Markdown",
    );
    expect(read[read.length - 1]?.args.resourceId).toBe("ch3");

    // Edit and Apply: the write_chapter payload carries the edited markdown.
    const edited = `${CH3_MD}\nA new *closing* line ✓.\n`;
    fireEvent.change(b, { target: { value: edited } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() =>
      expect(calls.some((c) => c.cmd === "write_chapter")).toBe(true),
    );
    const write = calls.find((c) => c.cmd === "write_chapter");
    expect(write?.args.bookId).toBe(fixture.book.id);
    expect(write?.args.resourceId).toBe("ch3");
    expect(write?.args.content).toEqual({
      resource: "ch3",
      format: "Markdown",
      content: edited,
    });
    // The mock echoed a dirty Book; the header (reader chrome) reflects it.
    expect(screen.getByLabelText("(unsaved changes)")).toBeTruthy();
  });

  it("opens the out-of-subset chapter in source mode with the REAL Xhtml fallback and a notice", async () => {
    const calls = mockBackend();
    await openFixture(calls);
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));

    // ch1 contains a <script>, so the core's prefer:Markdown read fell back
    // to format: Xhtml — the snapshot proves it, the UI must honor it.
    expect(fixture.markdown.ch1.format).toBe("Xhtml");
    const b = (await screen.findByLabelText(
      "chapter buffer",
    )) as HTMLTextAreaElement;
    expect(b.getAttribute("data-surface")).toBe("source");
    expect(b.getAttribute("data-language")).toBe("xml");
    expect(b.value).toBe(fixture.markdown.ch1.content);
    expect(screen.getByText(/outside the Markdown subset/)).toBeTruthy();
    // No lossy conversion offered: the WYSIWYG/Markdown switcher is absent.
    expect(screen.queryByRole("group", { name: "Editing mode" })).toBeNull();
  });

  it("preserves the buffer exactly across WYSIWYG ⇄ Markdown mode switches", async () => {
    const calls = mockBackend();
    await openFixture(calls);
    await goToCh3(calls);
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    await screen.findByLabelText("chapter buffer");

    const edited = `${CH3_MD}\nEdited in WYSIWYG — ünïcode ✓.`;
    fireEvent.change(buffer(), { target: { value: edited } });

    fireEvent.click(screen.getByRole("button", { name: "Markdown" }));
    expect(buffer().getAttribute("data-surface")).toBe("source");
    expect(buffer().getAttribute("data-language")).toBe("markdown");
    expect(buffer().value).toBe(edited);

    fireEvent.click(screen.getByRole("button", { name: "WYSIWYG" }));
    expect(buffer().getAttribute("data-surface")).toBe("wysiwyg");
    expect(buffer().value).toBe(edited);
    // Switching is not navigation: no guard, no write.
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(calls.some((c) => c.cmd === "write_chapter")).toBe(false);
  });
});

describe("M3 acceptance: unified unsaved-changes guard", () => {
  async function editCh3WithPendingBuffer(
    calls: InvokeCall[],
  ): Promise<string> {
    await openFixture(calls);
    await goToCh3(calls);
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    await screen.findByLabelText("chapter buffer");
    const pending = `${CH3_MD}\nPending edit.`;
    fireEvent.change(buffer(), { target: { value: pending } });
    fireEvent.click(screen.getByRole("button", { name: /open book/i }));
    await screen.findByRole("dialog", { name: "Unsaved changes" });
    return pending;
  }

  it("Save all applies the buffer, then saves, then proceeds — in that order", async () => {
    const calls = mockBackend();
    const pending = await editCh3WithPendingBuffer(calls);

    const guard = screen.getByRole("dialog", { name: "Unsaved changes" });
    fireEvent.click(within(guard).getByRole("button", { name: "Save all" }));
    await waitFor(() =>
      expect(calls.filter((c) => c.cmd === "open_book")).toHaveLength(2),
    );

    const wrote = calls.findIndex((c) => c.cmd === "write_chapter");
    const saved = calls.findIndex((c) => c.cmd === "save_book");
    const opened = calls.map((c) => c.cmd).lastIndexOf("open_book");
    expect(wrote).not.toBe(-1);
    expect(wrote).toBeLessThan(saved);
    expect(saved).toBeLessThan(opened);
    const write = calls.find((c) => c.cmd === "write_chapter");
    expect(write?.args.content).toMatchObject({
      format: "Markdown",
      content: pending,
    });
    await waitFor(() =>
      expect(screen.queryByLabelText("chapter buffer")).toBeNull(),
    );
  });

  it("Discard proceeds without applying or saving", async () => {
    const calls = mockBackend();
    await editCh3WithPendingBuffer(calls);

    const guard = screen.getByRole("dialog", { name: "Unsaved changes" });
    fireEvent.click(within(guard).getByRole("button", { name: "Discard" }));
    await waitFor(() =>
      expect(calls.filter((c) => c.cmd === "open_book")).toHaveLength(2),
    );
    expect(calls.some((c) => c.cmd === "write_chapter")).toBe(false);
    expect(calls.some((c) => c.cmd === "save_book")).toBe(false);
    await waitFor(() =>
      expect(screen.queryByLabelText("chapter buffer")).toBeNull(),
    );
  });

  it("Cancel aborts: still editing, buffer intact, nothing invoked", async () => {
    const calls = mockBackend();
    const pending = await editCh3WithPendingBuffer(calls);

    const guard = screen.getByRole("dialog", { name: "Unsaved changes" });
    fireEvent.click(within(guard).getByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(buffer().value).toBe(pending);
    expect(calls.some((c) => c.cmd === "write_chapter")).toBe(false);
    expect(calls.some((c) => c.cmd === "save_book")).toBe(false);
    // Only the original fixture open — the guarded open never ran.
    expect(calls.filter((c) => c.cmd === "open_book")).toHaveLength(1);
  });
});

describe("M3 acceptance: full lifecycle (create → edit → apply → save)", () => {
  const TITLE_MD = "# Livro Novo — 新しい本\n\nA capa gerada.\n";

  /** Core-shaped backend for a created (sourceless) book. */
  function lifecycleBackend(savePath: string): InvokeCall[] {
    const calls: InvokeCall[] = [];
    let book: Book | null = null;

    mockConvertFileSrc("linux");
    mockIPC((cmd, payload) => {
      const args = (payload ?? {}) as Record<string, unknown>;
      calls.push({ cmd, args });
      switch (cmd) {
        case "plugin:dialog|save":
          return savePath;
        case "create_book": {
          const metadata = args.metadata as Metadata;
          book = {
            id: "lifecycle-book",
            metadata: {
              ...metadata,
              identifier: "urn:uuid:11111111-2222-3333-4444-555555555555",
              modified: "2026-08-23T00:00:00Z",
            },
            spine: [{ id: "spine-title", resource: "titlepage", linear: true }],
            nav: [
              {
                label: "Title page",
                href: "OEBPS/titlepage.xhtml",
                children: [],
              },
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
          return book;
        }
        case "read_chapter": {
          const content: ChapterContent =
            args.prefer === "Markdown"
              ? { resource: "titlepage", format: "Markdown", content: TITLE_MD }
              : {
                  resource: "titlepage",
                  format: "Xhtml",
                  content:
                    "<html><body><h1>Livro Novo — 新しい本</h1></body></html>",
                };
          return content;
        }
        case "write_chapter":
          book = { ...book!, dirty: true };
          return book;
        case "save_book":
          book = {
            ...book!,
            dirty: false,
            source: (args.path as string | null) ?? book!.source,
          };
          return book;
        case "close_book":
          return null;
        default:
          throw { kind: "Io", message: `unmocked command ${cmd}` };
      }
    });
    return calls;
  }

  it("creates a book, edits its chapter markdown, applies, saves — header ends clean", async () => {
    const calls = lifecycleBackend("/out/livro-novo.epub");
    render(<App />);

    // Create through the wizard.
    fireEvent.click(screen.getByRole("button", { name: "New book…" }));
    const wizard = screen.getByRole("dialog", { name: "New book" });
    fireEvent.change(within(wizard).getByLabelText("Title"), {
      target: { value: "Livro Novo — 新しい本" },
    });
    fireEvent.change(within(wizard).getByLabelText("Author 1"), {
      target: { value: "Ãna Autora" },
    });
    fireEvent.click(
      within(wizard).getByRole("button", { name: "Create book" }),
    );
    await screen.findByText("Livro Novo — 新しい本");
    await screen.findByLabelText("(unsaved changes)");

    // Edit the title chapter's markdown and apply.
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    const b = (await screen.findByLabelText(
      "chapter buffer",
    )) as HTMLTextAreaElement;
    expect(b.value).toBe(TITLE_MD);
    const edited = `${TITLE_MD}\nDedicatória ✓.\n`;
    fireEvent.change(b, { target: { value: edited } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() =>
      expect(calls.some((c) => c.cmd === "write_chapter")).toBe(true),
    );
    expect(
      calls.find((c) => c.cmd === "write_chapter")?.args.content,
    ).toEqual({
      resource: "titlepage",
      format: "Markdown",
      content: edited,
    });

    // Save: sourceless book → save dialog (mocked pick) → save_book.
    fireEvent.keyDown(window, { key: "s", ctrlKey: true });
    await waitFor(() =>
      expect(calls.some((c) => c.cmd === "save_book")).toBe(true),
    );
    expect(calls.find((c) => c.cmd === "save_book")?.args).toEqual({
      bookId: "lifecycle-book",
      path: "/out/livro-novo.epub",
    });

    // The saved Book (dirty: false) was adopted: header is clean.
    await waitFor(() =>
      expect(screen.queryByLabelText("(unsaved changes)")).toBeNull(),
    );
    screen.getByText("Livro Novo — 新しい本");
  });
});
