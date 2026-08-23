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

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import type { MutableRefObject } from "react";
import { createRef } from "react";
import type { Editor } from "@milkdown/kit/core";
import { getMarkdown } from "@milkdown/kit/utils";
import { MilkdownEditor } from "../components/MilkdownEditor";

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
  } = {},
): Promise<{ editor: Editor; rerender: (v: string) => void }> {
  let editor: Editor | null = null;
  const props = {
    onChange: options.onChange ?? (() => undefined),
    insertImageRef: options.insertImageRef,
    resolveUrl: options.resolveUrl,
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
