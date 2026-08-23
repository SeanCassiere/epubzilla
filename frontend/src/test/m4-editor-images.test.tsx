// Issue #52: images in the WYSIWYG editor.
//
// Real Milkdown under jsdom (harness pattern from m3-milkdown.test.tsx).
// Two guarantees pinned here:
//
// 1. RENDER: an image whose src is a zip-relative resource ref
//    (`../images/x.png`) displays through the render-time resolver
//    (mapped to the epub:// asset protocol by EditorPane) — the resolved
//    URL appears ONLY on the rendered <img> element.
// 2. PERSISTENCE: the buffer / serialized Markdown keeps the relative
//    path verbatim — an epub:// URL must never appear in anything Apply
//    would send (the Rust core pins the XHTML side via the round-trip
//    fixture 015-image-relative-empty-alt).
//
// The "vanish on editor re-entry" half of #52 was this same render
// defect: the image node survived the core round-trip and Milkdown's
// parse/serialize (also pinned below), but rendered invisibly because
// its relative src could not load.

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import type { MutableRefObject } from "react";
import { createRef } from "react";
import { editorViewCtx, type Editor } from "@milkdown/kit/core";
import { Slice } from "@milkdown/kit/prose/model";
import { getMarkdown } from "@milkdown/kit/utils";
import { MilkdownEditor, type PastedImage } from "../components/MilkdownEditor";

beforeAll(() => {
  // jsdom lacks layout; ProseMirror needs these to mount.
  window.HTMLElement.prototype.scrollIntoView ??= () => undefined;
  Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect ??= () =>
    ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }) as DOMRect;
});

afterEach(() => cleanup());

/** The resolver EditorPane provides, faked: relative ref → epub:// URL. */
const resolve = (src: string) =>
  /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(src)
    ? src
    : `epub://book-1/OEBPS/${src.replace(/^(\.\.\/)+/, "")}`;

async function mount(
  value: string,
  options: {
    onChange?: (next: string) => void;
    insertImageRef?: MutableRefObject<((src: string) => void) | null>;
    resolveUrl?: (src: string) => string;
    onPasteImage?: (image: PastedImage) => Promise<string | null>;
  } = {},
): Promise<{ editor: Editor; rerender: (v: string) => void }> {
  let editor: Editor | null = null;
  const props = {
    onChange: options.onChange ?? (() => undefined),
    insertImageRef: options.insertImageRef,
    resolveUrl: options.resolveUrl,
    onPasteImage: options.onPasteImage,
    onReady: (e: Editor) => {
      editor = e;
    },
  };
  const { rerender } = render(<MilkdownEditor value={value} {...props} />);
  await waitFor(() => expect(editor).not.toBeNull());
  return {
    editor: editor!,
    rerender: (v: string) => rerender(<MilkdownEditor value={v} {...props} />),
  };
}

const hostImg = () =>
  document.querySelector<HTMLImageElement>(".milkdown-host img");

describe("editor image rendering (#52)", () => {
  it("renders a relative image ref through the resolver, keeps it relative in the buffer", async () => {
    const md = "Before.\n\n![A pic](../images/x.png)\n\nAfter.\n";
    const { editor } = await mount(md, { resolveUrl: resolve });

    const img = hostImg();
    expect(img).not.toBeNull();
    expect(img!.getAttribute("src")).toBe("epub://book-1/OEBPS/images/x.png");
    expect(img!.getAttribute("alt")).toBe("A pic");

    // The serialized buffer keeps the zip-relative ref — never epub://.
    const out = editor.action(getMarkdown());
    expect(out).toContain("![A pic](../images/x.png)");
    expect(out).not.toContain("epub://");
  });

  it("keeps and renders the image on an external buffer replacement (editor re-entry)", async () => {
    const { editor, rerender } = await mount("placeholder\n", {
      resolveUrl: resolve,
    });
    // Reload the buffer with content read back from the core (re-entry).
    rerender("Text.\n\n![](../images/x.png)\n");
    await waitFor(() => expect(hostImg()).not.toBeNull());
    expect(hostImg()!.getAttribute("src")).toBe(
      "epub://book-1/OEBPS/images/x.png",
    );
    const out = editor.action(getMarkdown());
    expect(out).toContain("![](../images/x.png)");
    expect(out).not.toContain("epub://");
  });

  it("inserts a relative ref at the cursor and serializes it unresolved", async () => {
    const insertImageRef = createRef<((src: string) => void) | null>();
    let latest = "";
    const { editor } = await mount("Some text.\n", {
      onChange: (next) => {
        latest = next;
      },
      insertImageRef: insertImageRef as MutableRefObject<
        ((src: string) => void) | null
      >,
      resolveUrl: resolve,
    });
    await waitFor(() => expect(insertImageRef.current).not.toBeNull());
    insertImageRef.current!("../images/new.png");

    await waitFor(() => expect(latest).toContain("../images/new.png"));
    expect(latest).not.toContain("epub://");
    // And the inserted node RENDERS resolved, in place.
    expect(hostImg()!.getAttribute("src")).toBe(
      "epub://book-1/OEBPS/images/new.png",
    );
    expect(editor.action(getMarkdown())).toBe(latest);
  });

  it("leaves absolute (external) image URLs alone", async () => {
    await mount("![ext](https://example.com/pic.png)\n", {
      resolveUrl: resolve,
    });
    expect(hostImg()!.getAttribute("src")).toBe("https://example.com/pic.png");
  });

  it("renders the raw src when no resolver is provided", async () => {
    await mount("![](../images/x.png)\n", {});
    expect(hostImg()!.getAttribute("src")).toBe("../images/x.png");
  });
});

// ---------------------------------------------------------------------------
// Issue #54: pasted/dropped images must persist as book resources, not as
// transient blob/data URLs. The onPasteImage handler (EditorPane) persists
// the bytes via add_resource_from_bytes and returns the zip-relative ref;
// the editor intercepts the payload before ProseMirror's default handling
// and inserts that ref — which then renders through the #52 resolver and
// serializes relative, exactly like the toolbar insert.
// ---------------------------------------------------------------------------

const PNG_BYTES = [0x89, 0x50, 0x4e, 0x47, 1, 2, 3];

function pngFile(name: string): File {
  return new File([new Uint8Array(PNG_BYTES)], name, { type: "image/png" });
}

/** A paste event carrying a jsdom-safe DataTransfer stand-in. */
function pasteEvent(data: { files?: File[]; text?: string }): Event {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: {
      files: data.files ?? [],
      items: [],
      types: data.text !== undefined ? ["text/plain"] : [],
      getData: (type: string) =>
        type === "text/plain" ? (data.text ?? "") : "",
    },
  });
  return event;
}

const proseMirrorHost = (): HTMLElement =>
  document.querySelector<HTMLElement>(".milkdown-host [contenteditable]")!;

describe("pasted image persistence (#54)", () => {
  it("routes a pasted image through the handler and inserts the returned relative ref", async () => {
    const seen: PastedImage[] = [];
    let latest = "";
    await mount("Some text.\n", {
      onChange: (next) => {
        latest = next;
      },
      resolveUrl: resolve,
      onPasteImage: (image) => {
        seen.push(image);
        return Promise.resolve("../images/pasted-image.png");
      },
    });

    proseMirrorHost().dispatchEvent(
      pasteEvent({ files: [pngFile("shot.png")] }),
    );

    await waitFor(() =>
      expect(latest).toContain("![](../images/pasted-image.png)"),
    );
    // The handler received the actual clipboard payload.
    expect(seen).toHaveLength(1);
    expect(seen[0].name).toBe("shot.png");
    expect(seen[0].type).toBe("image/png");
    expect(Array.from(seen[0].bytes)).toEqual(PNG_BYTES);
    // Nothing transient ever reaches the buffer.
    expect(latest).not.toMatch(/blob:|data:|epub:\/\//);
    // And the inserted ref renders resolved, like any other book image.
    expect(hostImg()!.getAttribute("src")).toBe(
      "epub://book-1/OEBPS/images/pasted-image.png",
    );
  });

  it("lets non-image paste fall through to normal handling", async () => {
    const onPasteImage = vi.fn<(image: PastedImage) => Promise<string | null>>(
      () => Promise.resolve("../images/never.png"),
    );
    let latest = "Some text.\n";
    const { editor } = await mount("Some text.\n", {
      onChange: (next) => {
        latest = next;
      },
      resolveUrl: resolve,
      onPasteImage,
    });

    proseMirrorHost().dispatchEvent(pasteEvent({ text: "plain words" }));

    // The default paste handling inserted the text; the image handler was
    // never consulted.
    await waitFor(() => expect(latest).toContain("plain words"));
    expect(onPasteImage).not.toHaveBeenCalled();
    expect(editor.action(getMarkdown())).not.toContain("![");
  });

  it("inserts nothing when persisting fails (handler resolves null)", async () => {
    const onPasteImage = vi.fn<(image: PastedImage) => Promise<string | null>>(
      () => Promise.resolve(null),
    );
    const { editor } = await mount("Some text.\n", {
      resolveUrl: resolve,
      onPasteImage,
    });

    proseMirrorHost().dispatchEvent(
      pasteEvent({ files: [pngFile("bad.png")] }),
    );

    await waitFor(() => expect(onPasteImage).toHaveBeenCalledTimes(1));
    expect(editor.action(getMarkdown())).not.toContain("![");
  });

  it("persists dropped image files through the same pipeline", async () => {
    let latest = "";
    const { editor } = await mount("Drop target.\n", {
      onChange: (next) => {
        latest = next;
      },
      resolveUrl: resolve,
      onPasteImage: () => Promise.resolve("../images/dropped.png"),
    });

    // jsdom cannot deliver a real drag session; invoke the registered
    // handleDrop prop the way ProseMirror would.
    const view = editor.ctx.get(editorViewCtx);
    const event = {
      dataTransfer: { files: [pngFile("dropped.png")], items: [] },
      clientX: 0,
      clientY: 0,
    } as unknown as DragEvent;
    const handled = view.someProp("handleDrop", (f) =>
      f(view, event, Slice.empty, false),
    );
    expect(handled).toBe(true);

    await waitFor(() => expect(latest).toContain("![](../images/dropped.png)"));
    expect(latest).not.toMatch(/blob:|data:|epub:\/\//);
    expect(hostImg()!.getAttribute("src")).toBe(
      "epub://book-1/OEBPS/images/dropped.png",
    );
  });

  it("does not intercept image paste when no handler is wired", async () => {
    let latest = "Some text.\n";
    await mount("Some text.\n", {
      onChange: (next) => {
        latest = next;
      },
      resolveUrl: resolve,
    });
    proseMirrorHost().dispatchEvent(
      pasteEvent({ files: [pngFile("shot.png")] }),
    );
    // Nothing crashes and nothing is inserted by OUR path (default
    // handling owns the event as before the fix).
    await new Promise((r) => setTimeout(r, 20));
    expect(latest).not.toContain("pasted-image");
  });
});
