// M3.1: edit-mode foundation (issue #43).
//
// Real <App/> over mocked IPC (harness pattern from m1.test.tsx). The
// CodeMirror surface is mocked to a plain <textarea> — CM6 needs real
// layout APIs jsdom lacks; its wrapper is thin and the buffer logic under
// test lives in EditorPane/state.

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { clearMocks, mockConvertFileSrc, mockIPC } from "@tauri-apps/api/mocks";
import type { Book } from "@bindings/Book";
import App from "../App";
import { epub2Fixture, epub3Fixture, type Fixture } from "./fixtures";

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
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  ),
}));

interface InvokeCall {
  cmd: string;
  args: Record<string, unknown>;
}

/**
 * M3 backend: serves one fixture; read_chapter honors `prefer` — resources
 * in `markdown` come back as Markdown, everything else falls back to the
 * Xhtml snapshot (the out-of-subset case). write_chapter marks the book
 * dirty and records the payload.
 */
function mockBackend(
  fixture: Fixture,
  markdown: Record<string, string>,
): InvokeCall[] {
  const calls: InvokeCall[] = [];
  let book: Book = { ...fixture.book };

  mockConvertFileSrc("linux");
  mockIPC((cmd, payload) => {
    const args = (payload ?? {}) as Record<string, unknown>;
    calls.push({ cmd, args });
    switch (cmd) {
      case "plugin:dialog|open":
        return "/fixtures/book.epub";
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
      case "write_chapter": {
        book = { ...book, dirty: true };
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

async function openFixtureAndEdit(calls: InvokeCall[]) {
  render(<App />);
  fireEvent.click(screen.getByRole("button", { name: /open book/i }));
  await waitFor(() =>
    expect(calls.some((c) => c.cmd === "read_chapter")).toBe(true),
  );
  fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
}

const MD = "# Chapter 1\n\nHello **markdown**.";

beforeAll(() => {
  // jsdom lacks these; harmless stubs for modal/scroll paths.
  window.HTMLElement.prototype.scrollIntoView ??= () => undefined;
});

afterEach(() => {
  cleanup();
  clearMocks();
});

describe("M3.1 edit mode", () => {
  it("enters edit mode and loads the chapter as Markdown", async () => {
    const calls = mockBackend(epub3Fixture(), { ch1: MD });
    await openFixtureAndEdit(calls);

    const buffer = (await screen.findByLabelText(
      "chapter buffer",
    )) as HTMLTextAreaElement;
    expect(buffer.value).toBe(MD);
    expect(buffer.getAttribute("data-language")).toBe("markdown");
    const read = calls.filter(
      (c) => c.cmd === "read_chapter" && c.args.prefer === "Markdown",
    );
    expect(read[read.length - 1]?.args.resourceId).toBe("ch1");
  });

  it("applies the buffer via write_chapter and clears modified state", async () => {
    const calls = mockBackend(epub3Fixture(), { ch1: MD });
    await openFixtureAndEdit(calls);

    const buffer = await screen.findByLabelText("chapter buffer");
    const apply = screen.getByRole("button", { name: "Apply" }) as HTMLButtonElement;
    expect(apply.disabled).toBe(true);

    fireEvent.change(buffer, { target: { value: `${MD}\n\nMore.` } });
    expect(apply.disabled).toBe(false);
    fireEvent.click(apply);

    await waitFor(() => expect(apply.disabled).toBe(true));
    const write = calls.find((c) => c.cmd === "write_chapter");
    expect(write?.args.resourceId).toBe("ch1");
    expect(write?.args.content).toEqual({
      resource: "ch1",
      format: "Markdown",
      content: `${MD}\n\nMore.`,
    });
    // The returned dirty Book is adopted (M2.4 indicator shows it).
    expect(screen.getByLabelText("(unsaved changes)")).toBeTruthy();
  });

  it("falls back to XHTML source mode for out-of-subset chapters", async () => {
    // No markdown entry for ch1 → the mock serves the Xhtml snapshot.
    const calls = mockBackend(epub3Fixture(), {});
    await openFixtureAndEdit(calls);

    const buffer = await screen.findByLabelText("chapter buffer");
    expect(buffer.getAttribute("data-language")).toBe("xml");
    expect(screen.getByText(/outside the Markdown subset/)).toBeTruthy();
    fireEvent.change(buffer, { target: { value: "<p>edited</p>" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => {
      const write = calls.find((c) => c.cmd === "write_chapter");
      expect(write?.args.content).toMatchObject({ format: "Xhtml" });
    });
  });

  it("guards chapter navigation while the buffer has unapplied changes", async () => {
    const calls = mockBackend(epub3Fixture(), { ch1: MD });
    await openFixtureAndEdit(calls);

    const buffer = await screen.findByLabelText("chapter buffer");
    fireEvent.change(buffer, { target: { value: "changed" } });

    // Keep editing: navigation is cancelled, no new chapter read.
    const readsBefore = calls.filter((c) => c.cmd === "read_chapter").length;
    fireEvent.click(screen.getByRole("button", { name: /next/i }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Keep editing" }),
    );
    expect(calls.filter((c) => c.cmd === "read_chapter").length).toBe(
      readsBefore,
    );

    // Discard: navigation proceeds to ch2.
    fireEvent.click(screen.getByRole("button", { name: /next/i }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Discard changes" }),
    );
    await waitFor(() => {
      const reads = calls.filter((c) => c.cmd === "read_chapter");
      expect(reads[reads.length - 1]?.args.resourceId).toBe("ch2");
    });
    expect(calls.some((c) => c.cmd === "write_chapter")).toBe(false);
  });

  it("Done with a clean buffer returns to reading and re-reads the chapter", async () => {
    const calls = mockBackend(epub3Fixture(), { ch1: MD });
    await openFixtureAndEdit(calls);
    await screen.findByLabelText("chapter buffer");

    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() =>
      expect(screen.queryByLabelText("chapter buffer")).toBeNull(),
    );
    // Reading view re-read the chapter (Xhtml) after editing.
    const reads = calls.filter((c) => c.cmd === "read_chapter");
    expect(reads[reads.length - 1]?.args.prefer).toBe("Xhtml");
    expect(screen.getByTitle("Chapter content")).toBeTruthy();
  });

  it("offers no Edit button for EPUB 2 books", async () => {
    const calls = mockBackend(epub2Fixture(), {});
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /open book/i }));
    await waitFor(() =>
      expect(calls.some((c) => c.cmd === "read_chapter")).toBe(true),
    );
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
  });
});
