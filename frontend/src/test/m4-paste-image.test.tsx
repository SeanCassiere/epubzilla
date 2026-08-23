// Issue #54: EditorPane's paste-image pipeline over mocked IPC.
//
// Harness pattern from m3-editor.test.tsx: real <App/> (so EditorPane runs
// against the real reader state), editor surfaces mocked thin — the real
// Milkdown interception is exercised in m4-editor-images.test.tsx. Pinned
// here: the onPasteImage handler EditorPane wires into the WYSIWYG surface
// persists clipboard bytes via add_resource_from_bytes, adopts the returned
// Book, and resolves to the zip-relative ref for the added resource — and
// resolves null (inserting nothing) when the backend rejects the payload.

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
import { epub3Fixture, type Fixture } from "./fixtures";
import type { PastedImage } from "../components/MilkdownEditor";

type PasteHandler = (image: PastedImage) => Promise<string | null>;

const captured = vi.hoisted(() => ({
  onPasteImage: null as PasteHandler | null,
}));

vi.mock("../components/CodeEditor", () => ({
  CodeEditor: ({ value }: { value: string }) => (
    <textarea aria-label="chapter buffer" data-surface="source" value={value} readOnly />
  ),
}));

vi.mock("../components/MilkdownEditor", () => ({
  MilkdownEditor: ({
    value,
    onChange,
    onPasteImage,
  }: {
    value: string;
    onChange: (next: string) => void;
    onPasteImage?: PasteHandler;
  }) => {
    captured.onPasteImage = onPasteImage ?? null;
    return (
      <textarea
        aria-label="chapter buffer"
        data-surface="wysiwyg"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  },
}));

interface InvokeCall {
  cmd: string;
  args: Record<string, unknown>;
}

const MD = "# Chapter 1\n\nHello **markdown**.";

/**
 * Backend for the paste flow: serves the EPUB 3 fixture, ch1 as Markdown;
 * add_resource_from_bytes appends a pasted-image resource (image types) or
 * rejects with UnsupportedFeature (everything else) — mirroring the real
 * command contract.
 */
function mockBackend(fixture: Fixture): InvokeCall[] {
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
        if (args.prefer === "Markdown" && id === "ch1") {
          return { resource: id, format: "Markdown", content: MD };
        }
        const chapter = fixture.chapters[id];
        if (chapter === undefined) throw { kind: "ResourceNotFound", id };
        return chapter;
      }
      case "add_resource_from_bytes": {
        const mediaType = args.mediaType as string;
        if (!mediaType.startsWith("image/")) {
          throw {
            kind: "UnsupportedFeature",
            message: `${mediaType} is not a supported image media type`,
          };
        }
        const bytes = args.bytes as number[];
        book = {
          ...book,
          dirty: true,
          resources: [
            ...book.resources,
            {
              id: "pasted-1",
              path: "OEBPS/images/pasted-image.png",
              media_type: mediaType,
              size: BigInt(bytes.length),
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

beforeAll(() => {
  window.HTMLElement.prototype.scrollIntoView ??= () => undefined;
});

afterEach(() => {
  cleanup();
  clearMocks();
  sessionStorage.clear();
  captured.onPasteImage = null;
});

async function openFixtureAndEdit(calls: InvokeCall[]) {
  render(<App />);
  fireEvent.click(screen.getByRole("button", { name: /open book/i }));
  await waitFor(() =>
    expect(calls.some((c) => c.cmd === "read_chapter")).toBe(true),
  );
  fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
  await waitFor(() => expect(captured.onPasteImage).not.toBeNull());
}

describe("EditorPane paste-image pipeline (#54)", () => {
  it("persists pasted bytes via add_resource_from_bytes and resolves the zip-relative ref", async () => {
    const calls = mockBackend(epub3Fixture());
    await openFixtureAndEdit(calls);

    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 7, 7]);
    const ref = await captured.onPasteImage!({
      name: "image.png",
      type: "image/png",
      bytes,
    });

    // ch1 lives at OEBPS/text/ch1.xhtml; the image landed under
    // OEBPS/images/, so the ref is chapter-relative — the same shape the
    // toolbar insert produces (renders via the #52 resolver, serializes
    // relative; never blob:/data:/epub://).
    expect(ref).toBe("../images/pasted-image.png");

    const call = calls.find((c) => c.cmd === "add_resource_from_bytes");
    expect(call).toBeDefined();
    expect(call!.args.nameHint).toBe("image.png");
    expect(call!.args.mediaType).toBe("image/png");
    expect(call!.args.bytes).toEqual(Array.from(bytes));
  });

  it("resolves null when the backend rejects the payload", async () => {
    const calls = mockBackend(epub3Fixture());
    await openFixtureAndEdit(calls);

    const ref = await captured.onPasteImage!({
      name: "clip.mov",
      type: "video/quicktime",
      bytes: new Uint8Array([1, 2, 3]),
    });
    expect(ref).toBeNull();
  });
});
