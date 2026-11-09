// The editor side of STANDARD-conversion: real Milkdown, no mocked parser.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { editorViewCtx, type Editor } from "@milkdown/kit/core";
import { getMarkdown, replaceAll } from "@milkdown/kit/utils";
import { createRef } from "react";
import { CodeEditor } from "../components/CodeEditor";
import { imageMarkdown, type InsertImage } from "../lib/editing";
import { EditorView } from "@codemirror/view";
import { DOMParser as ProseDOMParser } from "@milkdown/kit/prose/model";
import { EditorPane } from "../components/EditorPane";
import * as api from "../lib/api";
import { MilkdownEditor } from "../components/MilkdownEditor";

const reader = vi.hoisted(() => ({
  book: { id: "book-1", spine: [{ resource: "ch1" }], resources: [{ id: "ch1", path: "OEBPS/text/ch1.xhtml" }] },
  spineIndex: 0,
  stopEditing: vi.fn(), requestStopEditing: vi.fn(),
  writeChapter: vi.fn(async () => true), setNavGuard: vi.fn(),
  setEditorBuffer: vi.fn<(buffer: { modified: () => boolean } | null) => void>(),
  addResource: vi.fn(), addResourceBytes: vi.fn(),
}));
vi.mock("../state/reader", () => ({ useReader: () => reader, describeError: String }));
vi.mock("../lib/api", () => ({ readChapter: vi.fn(), resourceUrl: () => "epub://book-1/" }));

beforeAll(() => {
  window.HTMLElement.prototype.scrollIntoView ??= () => undefined;
  Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect ??= () =>
    ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }) as DOMRect;
});
afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.clearAllMocks();
});

const corpus: Record<string, string> = {
  "016-heading-id": "## T {#id .c}\n\n### Other {#other}\n",
  "017-link-image-title": '[t](https://example.org/a?q=1&b=2#x "T")\n\n[next](../text/ch02.xhtml#x "Next") [local](#id) [mail](mailto:a@b.c)\n\n![a](../images/a.png "Picture")\n',
  "018-table-alignment": "| Left | Center | Right | Default |\n| :--- | :---: | ---: | --- |\n| a | b | c | d |\n",
  "019-alerts": ["NOTE", "TIP", "IMPORTANT", "WARNING", "CAUTION"].map((kind) => `> [!${kind}]\n> Body **bold**.\n>\n> - One\n> - Two\n`).join("\n"),
  "020-task-list": "- [x] Done\n- [ ] Open\n- Normal\n  - [x] Nested\n\n- [ ] Loose\n\n  Second paragraph.\n",
  "021-footnote-multiblock": "Claim[^1], again[^1].\n\n[^1]: First paragraph.\n\n    Second paragraph.\n\n    - A\n    - B\n",
  "022-empty-paragraph": "Before.\n\n<br />\n\nAfter.\n\n<br />\n",
  "023-autolinks": "<https://example.org/a?q=1&b=2> <a@b.c>\n\nhttps://example.org/path. www.example.org a@example.org\n",
  "empty-paragraph-variants": "Before.\n\n<br>\n\n<br/>\n\n<br />\n",
  "literal-html": "Inline <br /> remains literal.\n\n<div>Literal HTML</div>\n",
  "basics": "# Title\n\n{.lead}\n\nSome **strong**, *em*, ~~gone~~, `a  b` and café 世界 🦖.\n\n> Quote\n\n3. Three\n4. Four\n\n```rust\nlet x = 1;\n```\n\nLine\\\nbreak\n\n---\n",
};
// Read the shared core fixtures too. New C1 fixtures join this corpus when
// the branches are combined; the cases above keep C2 independently testable.
const fixtures = import.meta.glob<string>(
  "../../../crates/core/tests/fixtures/roundtrip/*.md",
  { query: "?raw", import: "default", eager: true },
);

async function mount(value: string, onChange = vi.fn()) {
  let editor: Editor | undefined;
  const result = render(<MilkdownEditor value={value} onChange={onChange} onReady={(e) => { editor = e; }} />);
  await waitFor(() => expect(editor).toBeDefined());
  return { editor: editor!, onChange, ...result };
}

function assertConstructs(name: string, out: string, original: string) {
  // Existing literal escapes are content. Only newly introduced escapes
  // would demote supported syntax (including in future shared C1 fixtures).
  for (const pattern of [/\\\[!(?:NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/g, /\\\{#/g, /\\\[x\]/g]) {
    expect(out.match(pattern)?.length ?? 0).toBeLessThanOrEqual(original.match(pattern)?.length ?? 0);
  }
  if (name === "016-heading-id") {
    expect(out).toContain("## T {#id .c}");
    expect(out).toContain("### Other {#other}");
  }
  if (name === "017-link-image-title") {
    expect(out).toMatch(/\[t\]\(https:\/\/example\.org\/a\?q=1\\?&b=2#x "T"\)/);
    expect(out).toContain('[next](../text/ch02.xhtml#x "Next")');
    expect(out).toContain('![a](../images/a.png "Picture")');
  }
  if (name === "018-table-alignment") expect(out).toMatch(/\|\s*:-+\s*\|\s*:-+:\s*\|\s*-+:\s*\|\s*-+\s*\|/);
  if (name === "019-alerts") for (const kind of ["NOTE", "TIP", "IMPORTANT", "WARNING", "CAUTION"]) expect(out).toContain(`> [!${kind}]`);
  if (name === "020-task-list") {
    expect(out).toContain("[x] Done");
    expect(out).toContain("[ ] Open");
    expect(out).toContain("[x] Nested");
    expect(out).toContain("[ ] Loose");
  }
  if (name === "021-footnote-multiblock") {
    expect(out).toContain("Claim[^1], again[^1]");
    expect(out).toContain("[^1]: First paragraph.");
    expect(out).toMatch(/^ {4}Second paragraph\./m);
    expect(out).toMatch(/^ {4}[-*] A/m);
  }
  if (name === "022-empty-paragraph") expect(out.match(/<br \/>/g)).toHaveLength(2);
  if (name === "empty-paragraph-variants") expect(out.match(/<br \/>/g)).toHaveLength(3);
  if (name === "literal-html") {
    expect(out).toContain("Inline <br /> remains literal.");
    expect(out).toContain("<div>Literal HTML</div>");
  }
  if (name === "023-autolinks") {
    expect(out).toContain("<https://example.org/a?q=1&b=2>");
    expect(out).toContain("<a@b.c>");
    expect(out).toContain("<https://example.org/path>.");
    expect(out).toContain("[www.example.org](http://www.example.org)");
    expect(out).toContain("<a@example.org>");
  }
}

describe("conversion parity", () => {
  it.each(Object.entries({ ...fixtures, ...corpus }))("preserves %s after an unrelated edit and reaches a fixed point", async (name, markdown) => {
    const { editor, onChange } = await mount(markdown);
    // Allow the debounced listener to run: mounting must never dirty a buffer.
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(onChange).not.toHaveBeenCalled();
    editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const paragraph = view.state.schema.nodes.paragraph.create(null, view.state.schema.text("Unrelated edit."));
      view.dispatch(view.state.tr.insert(0, paragraph));
    });
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    const out = editor.action(getMarkdown());
    expect(onChange).toHaveBeenLastCalledWith(out);
    assertConstructs(name, out, markdown);
    const before = editor.ctx.get(editorViewCtx).state.doc.toJSON();
    editor.action(replaceAll(out));
    expect(editor.action(getMarkdown())).toBe(out);
    expect(editor.ctx.get(editorViewCtx).state.doc.toJSON()).toEqual(before);
  });
});

describe("rich representations", () => {
  it("renders all alert labels and retains their kind through DOM copy/paste", async () => {
    const { editor } = await mount(corpus["019-alerts"]);
    for (const kind of ["note", "tip", "important", "warning", "caution"]) {
      const quote = document.querySelector(`blockquote[data-kind="${kind}"]`)!;
      expect(quote).not.toBeNull();
      expect(quote.querySelector(".editor-alert-label")?.textContent).toBe(kind[0].toUpperCase() + kind.slice(1));
      expect(quote.querySelector(".editor-alert-body")?.textContent).toContain("Body bold.");
    }
    const view = editor.ctx.get(editorViewCtx);
    const copied = ProseDOMParser.fromSchema(view.state.schema).parse(view.dom);
    expect(copied.toJSON()).toEqual(view.state.doc.toJSON());
  });

  it.each([
    "> \\[!NOTE]\n> Literal", "> &#91;!NOTE]\n> Literal",
    "> [!UNKNOWN]\n> Literal", "> `[!NOTE]`\n> Literal",
    "> [!NOTE] ordinary text", "> [!NOTE]**bold**",
    "> First paragraph.\n>\n> [!NOTE]\n> Literal",
  ])("keeps ordinary blockquotes ordinary: %s", async (markdown) => {
    const { editor } = await mount(markdown);
    expect(document.querySelector("blockquote[data-kind]")).toBeNull();
    const out = editor.action(getMarkdown());
    editor.action(replaceAll(out));
    expect(document.querySelector("blockquote[data-kind]")).toBeNull();
    expect(editor.action(getMarkdown())).toBe(out);
  });

  it("preserves empty and nested alerts", async () => {
    const { editor } = await mount("> [!NOTE]\n\n> [!TIP]\n>\n> > [!WARNING]\n> > Nested.\n");
    expect(document.querySelectorAll("blockquote[data-kind]")).toHaveLength(3);
    const out = editor.action(getMarkdown());
    editor.action(replaceAll(out));
    expect(editor.action(getMarkdown())).toBe(out);
    expect(document.querySelectorAll("blockquote[data-kind]")).toHaveLength(3);
  });

  it("exposes checked and unchecked task states without marking ordinary items", async () => {
    await mount(corpus["020-task-list"]);
    expect(document.querySelectorAll('li[data-item-type="task"][data-checked="true"]')).toHaveLength(2);
    expect(document.querySelectorAll('li[data-item-type="task"][data-checked="false"]')).toHaveLength(2);
    expect(Array.from(document.querySelectorAll("li")).find((li) => li.textContent?.startsWith("Normal"))?.getAttribute("data-item-type")).not.toBe("task");
  });
});

describe("real editor mode switching", () => {
  it("flushes a pending rich edit when switching away before the listener debounce", async () => {
    const { editor, onChange, unmount } = await mount("Before.\n");
    editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      view.dispatch(view.state.tr.insertText("Edited ", 1));
    });
    const edited = editor.action(getMarkdown());
    unmount();
    expect(onChange).toHaveBeenLastCalledWith(edited);
  });

  it.each(["wysiwyg", "source"])("preserves the exact clean and edited buffer starting in %s", async (mode) => {
    const original = Object.values(corpus).join("\n");
    vi.mocked(api.readChapter).mockResolvedValue({ resource: "ch1", format: "Markdown", content: original });
    sessionStorage.setItem("epubzilla.editor.markdownMode", mode);
    render(<EditorPane />);
    const settleRich = async () => {
      await waitFor(() => expect(document.querySelector(".milkdown-host .ProseMirror")).not.toBeNull());
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 250)); });
    };
    const sourceView = () => EditorView.findFromDOM(document.querySelector(".cm-editor")! as HTMLElement)!;
    if (mode === "wysiwyg") await settleRich();
    fireEvent.click(screen.getByRole("button", { name: "Markdown" }));
    await waitFor(() => expect(document.querySelector(".cm-editor")).not.toBeNull());
    expect(sourceView().state.doc.toString()).toBe(original);
    fireEvent.click(screen.getByRole("button", { name: "WYSIWYG" }));
    await settleRich();
    expect((screen.getByRole("button", { name: "Apply" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Markdown" }));
    expect(sourceView().state.doc.toString()).toBe(original);
    const edited = `Unrelated source edit.\n\n${original}`;
    act(() => sourceView().dispatch({ changes: { from: 0, insert: "Unrelated source edit.\n\n" } }));
    fireEvent.click(screen.getByRole("button", { name: "WYSIWYG" }));
    await settleRich();
    fireEvent.click(screen.getByRole("button", { name: "Markdown" }));
    expect(sourceView().state.doc.toString()).toBe(edited);
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(reader.writeChapter).toHaveBeenCalledWith({ resource: "ch1", format: "Markdown", content: edited }));
  });
});

describe("image syntax in both real editors", () => {
  it.each([
    ["../images/space name (1).png", "A [bracket] and \\ slash"],
    ["../images/x.png", ""],
    ["../images/a&copy;.png", "Literal &copy; *stars* _underscores_"],
    ["../images/a<b>.png", "<angle> `code`"],
  ])("inserts and reparses %s with alt %s", async (src, alt) => {
    const insertImageRef = createRef<InsertImage | null>();
    const onChange = vi.fn();
    const source = render(<CodeEditor value="" language="markdown" onChange={onChange} insertImageRef={insertImageRef} />);
    act(() => insertImageRef.current!(src, alt));
    expect(onChange).toHaveBeenLastCalledWith(imageMarkdown(src, alt));
    source.unmount();
    const { editor } = await mount(imageMarkdown(src, alt));
    const img = document.querySelector<HTMLImageElement>(".milkdown-host img")!;
    expect(img.getAttribute("src")).toBe(src);
    expect(img.getAttribute("alt")).toBe(alt);
    const out = editor.action(getMarkdown());
    editor.action(replaceAll(out));
    expect(document.querySelector<HTMLImageElement>(".milkdown-host img")!.getAttribute("src")).toBe(src);
    expect(document.querySelector<HTMLImageElement>(".milkdown-host img")!.alt).toBe(alt);
    expect(editor.action(getMarkdown())).toBe(out);
  });
});
