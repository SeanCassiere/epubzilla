// M3.2: real Milkdown round-trip behavior (issue #44).
//
// Unlike the integration tests (which vi.mock the editor surfaces), this
// file mounts the actual Milkdown editor under jsdom — ProseMirror works
// there with the layout stubs below — and pins down what parse+serialize
// does to buffers. The load-bearing verdict: Pandoc-style footnotes and
// {.class} annotations (contract syntax Milkdown does NOT model —
// docs/contracts/content-roundtrip.md) pass through the serializer
// VERBATIM as literal text. Nothing is escaped or lost, so EditorPane can
// offer WYSIWYG for such chapters (ADR-0007 consequence: they render as
// literal syntax, editable, still round-tripping via the core). If a
// Milkdown upgrade breaks this test, WYSIWYG must be gated off for such
// content instead.

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import type { Editor } from "@milkdown/kit/core";
import { editorViewCtx } from "@milkdown/kit/core";
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

/** Mount the real component; resolve with the live editor instance. */
async function mount(
  value: string,
  onChange: (next: string) => void,
): Promise<{ editor: Editor; rerender: (v: string) => void }> {
  let editor: Editor | null = null;
  const { rerender } = render(
    <MilkdownEditor
      value={value}
      onChange={onChange}
      onReady={(e) => {
        editor = e;
      }}
    />,
  );
  await waitFor(() => expect(editor).not.toBeNull());
  return {
    editor: editor!,
    rerender: (v: string) =>
      rerender(
        <MilkdownEditor
          value={v}
          onChange={onChange}
          onReady={(e) => {
            editor = e;
          }}
        />,
      ),
  };
}

/** Parse+serialize through the component's own editor (no edits). */
async function roundTrip(markdown: string): Promise<string> {
  const { editor } = await mount(markdown, () => undefined);
  const out = editor.action(getMarkdown());
  cleanup();
  return out;
}

describe("Milkdown markdown round-trip", () => {
  it("preserves the supported subset semantically", async () => {
    const md = [
      "# Title",
      "",
      "Some **strong** and *em* and ~~gone~~ and `code`.",
      "",
      "> quoted",
      "",
      "* one",
      "* two",
      "",
      "| a | b |",
      "| --- | --- |",
      "| 1 | 2 |",
      "",
      "---",
      "",
      "[link](https://example.com/)",
      "",
      "UTF-8 safe: café, 世界, 🦖.",
    ].join("\n");
    const out = await roundTrip(md);
    expect(out).toContain("# Title");
    expect(out).toContain("**strong**");
    expect(out).toContain("*em*");
    expect(out).toContain("~~gone~~");
    expect(out).toContain("`code`");
    expect(out).toContain("> quoted");
    expect(out).toMatch(/[*-] one/);
    expect(out).toContain("| 1");
    expect(out).toMatch(/^(---|\*\*\*|___)$/m); // hr survives (as some marker)
    expect(out).toContain("[link](https://example.com/)");
    expect(out).toContain("café, 世界, 🦖");
    // Stability: serializing its own output must be a fixed point.
    expect(await roundTrip(out)).toBe(out);
  });

  it("passes footnotes and {.class} annotations through verbatim", async () => {
    // Milkdown has no footnote/attribute syntax; it treats these as plain
    // text — and, verified here, its serializer does NOT escape or mangle
    // them. They render as literal text in WYSIWYG (documented ADR-0007
    // consequence) and survive Apply byte-for-byte.
    const md = "A claim.[^1]\n\n[^1]: The footnote.\n\nPara. {.lead}\n";
    const out = await roundTrip(md);
    expect(out).toContain("A claim.[^1]");
    expect(out).toContain("[^1]: The footnote.");
    expect(out).toContain("{.lead}");
    expect(out).not.toContain("\\[");
    expect(out).not.toContain("\\{");
  });
});

describe("MilkdownEditor component", () => {
  it("does not emit on mount and absorbs external replacement silently", async () => {
    const onChange = vi.fn();
    const { rerender } = await mount("# One\n", onChange);
    // Mounting must not emit (mode switches may not dirty the buffer).
    expect(onChange).not.toHaveBeenCalled();

    // External value replacement (e.g. buffer reload) updates the document
    // without echoing back through onChange — even though the serializer
    // would normalize the pushed string (no trailing newline here).
    rerender("## Two");
    await waitFor(() =>
      expect(
        document.querySelector(".milkdown-host .ProseMirror")?.textContent,
      ).toContain("Two"),
    );
    expect(onChange).not.toHaveBeenCalled();
  });

  it("emits the serialized markdown string on a real document edit", async () => {
    let latest: string | null = null;
    const { editor } = await mount("Hello **markdown**.\n", (next) => {
      latest = next;
    });
    editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      view.dispatch(view.state.tr.insertText("Hi! ", 1, 1));
    });
    await waitFor(() => expect(latest).not.toBeNull());
    expect(latest!).toContain("Hi!");
    expect(latest!).toContain("**markdown**");
    // The emission and the editor's own serialization agree — the buffer
    // interchange is exactly Milkdown's markdown string.
    expect(editor.action(getMarkdown())).toBe(latest!);
  });

  it("renders the formatting toolbar", async () => {
    await mount("x\n", () => undefined);
    const toolbar = document.querySelector(".milkdown-toolbar");
    expect(toolbar).not.toBeNull();
    for (const title of ["Bold", "Italic", "Strikethrough", "Insert table"]) {
      expect(toolbar!.querySelector(`button[title="${title}"]`)).not.toBeNull();
    }
  });
});
