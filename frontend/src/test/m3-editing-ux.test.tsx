// M3.3: editing UX (issue #45) — unified save/guard, shortcuts, image
// insertion.
//
// Same harness as m3-editor.test.tsx: the REAL <App/> over mocked IPC with
// both editor surfaces mocked to <textarea>s. The mocks also implement the
// M3.3 insertion contract: they register `insertImageRef` (appending the
// Markdown reference to the buffer, standing in for cursor insertion) and
// the WYSIWYG mock renders the "Insert image…" toolbar button. The dialog
// module is mocked with queue-driven pickers (m2-save pattern).

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
import type { MutableRefObject } from "react";
import type { Book } from "@bindings/Book";
import App from "../App";
import {
  imageMarkdown,
  needsUnsavedPrompt,
  relativeResourcePath,
  saveSteps,
} from "../lib/editing";
import { pickImageFile } from "../lib/dialog";
import { epub3Fixture, type Fixture } from "./fixtures";

// Queue-driven dialog doubles: tests push the "user's" picks.
const epubPicks: Array<string | null> = [];
const imagePicks: Array<string | null> = [];
const savePicks: Array<string | null> = [];

vi.mock("../lib/dialog", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/dialog")>();
  return {
    ...actual,
    pickEpubFile: vi.fn(async () => epubPicks.shift() ?? null),
    pickImageFile: vi.fn(async () => imagePicks.shift() ?? null),
    pickSaveEpubPath: vi.fn(async () => savePicks.shift() ?? null),
  };
});

type InsertRef = MutableRefObject<((src: string) => void) | null> | undefined;

interface SurfaceProps {
  value: string;
  onChange: (next: string) => void;
  language?: string;
  insertImageRef?: InsertRef;
  onInsertImage?: () => void;
}

vi.mock("../components/CodeEditor", () => ({
  CodeEditor: ({ value, language, onChange, insertImageRef }: SurfaceProps) => {
    if (insertImageRef !== undefined && insertImageRef !== null) {
      insertImageRef.current = (src: string) =>
        onChange(`${value}${imageMarkdown(src)}`);
    }
    return (
      <textarea
        aria-label="chapter buffer"
        data-language={language}
        data-surface="source"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  },
}));

vi.mock("../components/MilkdownEditor", () => ({
  MilkdownEditor: ({
    value,
    onChange,
    insertImageRef,
    onInsertImage,
  }: SurfaceProps) => {
    if (insertImageRef !== undefined && insertImageRef !== null) {
      insertImageRef.current = (src: string) =>
        onChange(`${value}${imageMarkdown(src)}`);
    }
    return (
      <div role="toolbar" aria-label="Formatting">
        <textarea
          aria-label="chapter buffer"
          data-surface="wysiwyg"
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
        {onInsertImage !== undefined && (
          <button type="button" onClick={onInsertImage}>
            Insert image…
          </button>
        )}
      </div>
    );
  },
}));

interface InvokeCall {
  cmd: string;
  args: Record<string, unknown>;
}

const MD = "# Chapter 1\n\nHello **markdown**.";

/**
 * M3.3 backend over the epub3 fixture (source set, as if opened from disk):
 * write_chapter dirties, save_book cleans, add_resource_from_path appends
 * an image resource under OEBPS/images/ and dirties.
 */
function mockBackend(markdown: Record<string, string>): InvokeCall[] {
  const calls: InvokeCall[] = [];
  const fixture: Fixture = epub3Fixture();
  let book: Book = { ...fixture.book, source: "/books/fixture.epub" };
  let nextImage = 1;

  mockConvertFileSrc("linux");
  mockIPC((cmd, payload) => {
    const args = (payload ?? {}) as Record<string, unknown>;
    calls.push({ cmd, args });
    switch (cmd) {
      case "open_book":
        return book;
      case "read_chapter": {
        const id = args.resourceId as string;
        if (args.prefer === "Markdown" && markdown[id] !== undefined) {
          return { resource: id, format: "Markdown", content: markdown[id] };
        }
        const chapter = fixture.chapters[id];
        if (chapter === undefined) {
          throw { kind: "ResourceNotFound", id };
        }
        return chapter;
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
      case "add_resource_from_path": {
        const n = nextImage;
        nextImage += 1;
        book = {
          ...book,
          dirty: true,
          resources: [
            ...book.resources,
            {
              id: `inserted-${n}`,
              path: `OEBPS/images/inserted-${n}.png`,
              media_type: "image/png",
              size: 8n,
            },
          ],
        };
        return book;
      }
      case "close_book":
        return null;
      default:
        throw { kind: "Io", message: `unmocked command ${cmd}` };
    }
  });
  return calls;
}

async function openFixture(calls: InvokeCall[]): Promise<void> {
  epubPicks.push("/books/fixture.epub");
  render(<App />);
  fireEvent.click(screen.getByRole("button", { name: /open book/i }));
  await waitFor(() =>
    expect(calls.some((c) => c.cmd === "read_chapter")).toBe(true),
  );
}

async function openFixtureAndEdit(calls: InvokeCall[]): Promise<void> {
  await openFixture(calls);
  fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
  await screen.findByLabelText("chapter buffer");
}

const buffer = () =>
  screen.getByLabelText("chapter buffer") as HTMLTextAreaElement;
const cmdIndex = (calls: InvokeCall[], cmd: string) =>
  calls.findIndex((c) => c.cmd === cmd);

beforeAll(() => {
  window.HTMLElement.prototype.scrollIntoView ??= () => undefined;
});

afterEach(() => {
  cleanup();
  clearMocks();
  sessionStorage.clear();
  epubPicks.length = 0;
  imagePicks.length = 0;
  savePicks.length = 0;
});

describe("pure editing helpers", () => {
  it("saveSteps applies before saving only when the buffer is modified", () => {
    expect(saveSteps(true)).toEqual(["apply", "save"]);
    expect(saveSteps(false)).toEqual(["save"]);
  });

  it("needsUnsavedPrompt fires on either pending layer", () => {
    expect(needsUnsavedPrompt(false, false)).toBe(false);
    expect(needsUnsavedPrompt(true, false)).toBe(true);
    expect(needsUnsavedPrompt(false, true)).toBe(true);
    expect(needsUnsavedPrompt(true, true)).toBe(true);
  });

  it("relativeResourcePath resolves across zip directories", () => {
    // Chapter in OEBPS/, image in OEBPS/images/ (task example).
    expect(
      relativeResourcePath("OEBPS/ch1.xhtml", "OEBPS/images/foo.png"),
    ).toBe("images/foo.png");
    // Chapter one level deeper (the epub3 fixture layout).
    expect(
      relativeResourcePath("OEBPS/text/ch1.xhtml", "OEBPS/images/foo.png"),
    ).toBe("../images/foo.png");
    expect(relativeResourcePath("OEBPS/a.xhtml", "OEBPS/b.png")).toBe("b.png");
    expect(relativeResourcePath("root.xhtml", "images/pïc ✓.png")).toBe(
      "images/pïc ✓.png",
    );
    expect(imageMarkdown("images/foo.png")).toBe("![](images/foo.png)");
  });
});

describe("unified save (Cmd/Ctrl+S)", () => {
  it("applies the modified buffer, then saves the book — one keystroke, no dialog", async () => {
    const calls = mockBackend({ ch1: MD });
    await openFixtureAndEdit(calls);

    fireEvent.change(buffer(), { target: { value: `${MD}\n\nMore.` } });
    fireEvent.keyDown(window, { key: "s", ctrlKey: true });

    await waitFor(() => expect(cmdIndex(calls, "save_book")).not.toBe(-1));
    // Order: write_chapter strictly before save_book.
    const wrote = cmdIndex(calls, "write_chapter");
    expect(wrote).not.toBe(-1);
    expect(wrote).toBeLessThan(cmdIndex(calls, "save_book"));
    expect(calls.filter((c) => c.cmd === "write_chapter")).toHaveLength(1);
    expect(calls.filter((c) => c.cmd === "save_book")).toHaveLength(1);
    // No guard dialog was involved, and the buffer is applied (clean).
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "Apply" }) as HTMLButtonElement)
          .disabled,
      ).toBe(true),
    );
    // The saved Book (dirty: false) was adopted.
    expect(screen.queryByLabelText("(unsaved changes)")).toBeNull();
  });

  it("saves without write_chapter when the buffer is clean", async () => {
    const calls = mockBackend({ ch1: MD });
    await openFixtureAndEdit(calls);

    fireEvent.keyDown(window, { key: "s", metaKey: true });
    await waitFor(() => expect(cmdIndex(calls, "save_book")).not.toBe(-1));
    expect(calls.some((c) => c.cmd === "write_chapter")).toBe(false);
  });
});

describe("unified unsaved-changes guard", () => {
  it("prompts ONCE for an unapplied buffer; Save all applies, saves, then proceeds", async () => {
    const calls = mockBackend({ ch1: MD });
    await openFixtureAndEdit(calls);

    // Only the editor buffer is pending (the book itself is clean).
    fireEvent.change(buffer(), { target: { value: `${MD}\n\nPending.` } });
    epubPicks.push("/books/fixture.epub");
    fireEvent.click(screen.getByRole("button", { name: "Open book…" }));

    // Exactly one dialog — the unified guard, not the editor's own.
    const guard = await screen.findByRole("dialog", {
      name: "Unsaved changes",
    });
    expect(screen.getAllByRole("dialog")).toHaveLength(1);

    fireEvent.click(within(guard).getByRole("button", { name: "Save all" }));
    // The FIRST open_book opened the fixture; the guard's proceed is the
    // second one.
    await waitFor(() =>
      expect(calls.filter((c) => c.cmd === "open_book")).toHaveLength(2),
    );

    // apply → save → open, strictly in that order.
    const wrote = cmdIndex(calls, "write_chapter");
    const saved = cmdIndex(calls, "save_book");
    const opened = calls.map((c) => c.cmd).lastIndexOf("open_book");
    expect(wrote).not.toBe(-1);
    expect(wrote).toBeLessThan(saved);
    expect(saved).toBeLessThan(opened);
    expect(write(calls)?.args.content).toMatchObject({
      content: `${MD}\n\nPending.`,
    });
    // The transition landed: back to reading on the (re)opened book.
    await waitFor(() =>
      expect(screen.queryByLabelText("chapter buffer")).toBeNull(),
    );
  });

  it("Discard proceeds without applying or saving (both layers dropped)", async () => {
    const calls = mockBackend({ ch1: MD });
    await openFixtureAndEdit(calls);

    fireEvent.change(buffer(), { target: { value: "doomed" } });
    epubPicks.push("/books/fixture.epub");
    fireEvent.click(screen.getByRole("button", { name: "Open book…" }));
    const guard = await screen.findByRole("dialog", {
      name: "Unsaved changes",
    });
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

  it("Cancel keeps editing with the buffer intact", async () => {
    const calls = mockBackend({ ch1: MD });
    await openFixtureAndEdit(calls);

    fireEvent.change(buffer(), { target: { value: "keep me" } });
    fireEvent.click(screen.getByRole("button", { name: "Open book…" }));
    const guard = await screen.findByRole("dialog", {
      name: "Unsaved changes",
    });
    fireEvent.click(within(guard).getByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(buffer().value).toBe("keep me");
    // open_book never ran (the only earlier open was the fixture itself).
    expect(calls.filter((c) => c.cmd === "open_book")).toHaveLength(1);
  });
});

describe("Cmd/Ctrl+E edit-mode toggle", () => {
  it("enters and leaves edit mode; leaving dirty goes through the guard", async () => {
    const calls = mockBackend({ ch1: MD });
    await openFixture(calls);

    // Enter via keyboard.
    fireEvent.keyDown(window, { key: "e", ctrlKey: true });
    await screen.findByLabelText("chapter buffer");

    // Clean buffer: leaving is immediate.
    fireEvent.keyDown(window, { key: "e", ctrlKey: true });
    await waitFor(() =>
      expect(screen.queryByLabelText("chapter buffer")).toBeNull(),
    );

    // Re-enter, modify, leave: the Apply/Discard/Keep-editing guard shows.
    fireEvent.keyDown(window, { key: "e", metaKey: true });
    await screen.findByLabelText("chapter buffer");
    fireEvent.change(buffer(), { target: { value: "changed" } });
    fireEvent.keyDown(window, { key: "e", metaKey: true });
    const guard = await screen.findByRole("dialog", {
      name: "Unapplied changes",
    });
    fireEvent.click(
      within(guard).getByRole("button", { name: "Keep editing" }),
    );
    expect(buffer().value).toBe("changed");
  });
});

describe("image insertion", () => {
  it("WYSIWYG: picks a file, adds the resource, inserts the relative reference", async () => {
    const calls = mockBackend({ ch1: MD });
    await openFixtureAndEdit(calls);
    expect(buffer().getAttribute("data-surface")).toBe("wysiwyg");

    imagePicks.push("/photos/Sünset.png");
    fireEvent.click(screen.getByRole("button", { name: "Insert image…" }));

    await waitFor(() =>
      expect(cmdIndex(calls, "add_resource_from_path")).not.toBe(-1),
    );
    const add = calls.find((c) => c.cmd === "add_resource_from_path");
    expect(add?.args).toEqual({
      bookId: "book-1",
      osPath: "/photos/Sünset.png",
    });
    // Chapter at OEBPS/text/ch1.xhtml, image at OEBPS/images/…: the buffer
    // gains the Markdown reference with the correct RELATIVE path.
    await waitFor(() =>
      expect(buffer().value).toContain("![](../images/inserted-1.png)"),
    );
    // The dirty Book was adopted (resource added marks the book dirty).
    expect(screen.getByLabelText("(unsaved changes)")).toBeTruthy();
  });

  it("Markdown source mode: the toolbar row has the same flow", async () => {
    const calls = mockBackend({ ch1: MD });
    await openFixtureAndEdit(calls);
    fireEvent.click(screen.getByRole("button", { name: "Markdown" }));
    expect(buffer().getAttribute("data-surface")).toBe("source");

    imagePicks.push("/photos/pic.jpg");
    fireEvent.click(screen.getByRole("button", { name: "Insert image…" }));
    await waitFor(() =>
      expect(buffer().value).toContain("![](../images/inserted-1.png)"),
    );
  });

  it("cancelling the picker adds nothing", async () => {
    const calls = mockBackend({ ch1: MD });
    await openFixtureAndEdit(calls);

    imagePicks.push(null);
    fireEvent.click(screen.getByRole("button", { name: "Insert image…" }));
    await waitFor(() =>
      expect(vi.mocked(pickImageFile)).toHaveBeenCalled(),
    );
    expect(calls.some((c) => c.cmd === "add_resource_from_path")).toBe(false);
    expect(buffer().value).toBe(MD);
  });
});

function write(calls: InvokeCall[]): InvokeCall | undefined {
  return calls.find((c) => c.cmd === "write_chapter");
}
