// The editor side of STANDARD-conversion: real Milkdown, no mocked parser.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { editorViewCtx, type Editor } from "@milkdown/kit/core";
import { getMarkdown, replaceAll } from "@milkdown/kit/utils";
import { createRef } from "react";
import { CodeEditor } from "../components/CodeEditor";
import { imageMarkdown, type InsertImage } from "../lib/editing";
import { EditorView } from "@codemirror/view";
import { TextSelection } from "@milkdown/kit/prose/state";
import { DOMParser as ProseDOMParser } from "@milkdown/kit/prose/model";
import { EditorPane } from "../components/EditorPane";
import * as api from "../lib/api";
import { pickImageFile } from "../lib/dialog";
import { MilkdownEditor } from "../components/MilkdownEditor";
import { richModeUnavailableReason } from "../lib/rich-mode";

const reader = vi.hoisted(() => ({
  book: { id: "book-1", spine: [{ resource: "ch1" }], resources: [{ id: "ch1", path: "OEBPS/text/ch1.xhtml" }] },
  spineIndex: 0,
  stopEditing: vi.fn(), requestStopEditing: vi.fn(),
  writeChapter: vi.fn(async () => true), setNavGuard: vi.fn(),
  setEditorBuffer: vi.fn<(buffer: { modified: () => boolean } | null) => void>(),
  addResource: vi.fn(), addResourceBytes: vi.fn(),
  notifyEditorModified: vi.fn(), frozen: false,
}));
vi.mock("../state/reader", () => ({ useReader: () => reader, describeError: String }));
vi.mock("../lib/dialog", () => ({ pickImageFile: vi.fn() }));
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
  "review-attributes": "## T {#chapter_one .some_class}\n\n## Stars {#a*b}\n\n## Entity {#a&copy;}\n\n{.lead_x}\n\nBody.\n",
  "review-alerts": "> [!note]  \n> Body\n\n> [!WARNING] \n> ---\n\n> [!TIP]\n> ===\n\n> [!caution]\t\n",
  "review-list-fillers": "- > Quote\n\n- > [!NOTE]\n  > Alert\n\n- ```js\n  code\n  ```\n",
  "review-empty-table": "| A | |\n| --- | --- |\n| | B |\n",
  "review-inline-breaks": "Text **<br />** more\n\n# <br />\n\n*<br />*\n\n[<br />](u)\n\n| A |\n| --- |\n| <br /> |\n",
  "review-empty-tasks": "- [x] \n- [ ] \n",
  "review-empty-task-newline": "- [X]\n- [ ]\n",
  "review-authored-nested-empty": "- <br />\n\n  > Quote\n\n> [!NOTE]\n>\n> <br />\n\nNote[^empty].\n\n[^empty]: <br />\n",
  "review-setext-attributes": "> [!NOTE]\n> **Title** {#chapter_one .some_class}\n> ---\n\nOther {#a&copy;}\n===\n",
  "review-nested-attributes": "> ## **Title** {#my_id .some_class}\n\n- ## Other {#a&copy;}\n",
  "review-title-breaks": '[link](x "one&#10;&#10;two") ![alt](x "one&#10;&#10;two")\n\n[CR](x "one&#13;two") ![CRLF](x "one&#13;&#10;two")\n',
  "review-title-escaping": '[link](x "quote&#34;&#10;slash&#92;&#10;literal &#38;#10;") ![alt](x "quote&#34;&#13;slash&#92;&#13;literal &#38;#13;")\n',
  "review-tight-empty-item": "- a\n- <br />\n",
  "review-footnote-spaces": "A[^my note]\n\n[^my note]: Second.\n",
  "review-footnote-short-spaces": "A[^a b].\n\n[^a b]: Note.\n",
  "review-footnote-punctuation": "A[^a&b].\n\n[^a&b]: Note.\n",

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
  "../../../crates/core/tests/fixtures/roundtrip/**/*.md",
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
  for (const pattern of [/\\\[!(?:NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/g, /\\\{#/g, /\\\[x\]/g, /\\\[\^/g]) {
    expect(out.match(pattern)?.length ?? 0).toBeLessThanOrEqual(original.match(pattern)?.length ?? 0);
  }
  if (name === "review-title-breaks") {
    expect(out).toContain('[link](x "one&#10;&#10;two")');
    expect(out).toContain('![alt](x "one&#10;&#10;two")');
    expect(out).toContain('[CR](x "one&#13;two")');
    expect(out).toContain('![CRLF](x "one&#13;&#10;two")');
    expect(document.querySelector('.milkdown-host a[href="x"]')?.getAttribute("title")).toBe("one\n\ntwo");
    expect(document.querySelector('.milkdown-host img[src="x"]')?.getAttribute("title")).toBe("one\n\ntwo");
  }
  if (name === "review-tight-empty-item") expect(out).toMatch(/\* a\n\* <br \/>/);
  if (name === "review-attributes") {
    for (const literal of ["{#chapter_one .some_class}", "{#a*b}", "{#a&copy;}", "{.lead_x}"]) expect(out).toContain(literal);
  }
  if (name === "review-alerts") {
    for (const kind of ["NOTE", "WARNING", "TIP", "CAUTION"]) expect(out).toContain(`> [!${kind}]`);
    expect(out).toContain("> ***");
    expect(document.querySelector('blockquote[data-kind="tip"] .editor-alert-body')?.textContent).toBe("===");
    expect(out).not.toContain("<br />");
    expect(document.querySelectorAll("blockquote[data-kind]")).toHaveLength(4);
  }
  if (name === "review-list-fillers") {
    expect(out).not.toContain("<br />");
    expect(out).toContain("> Quote");
    expect(out).toContain("> [!NOTE]");
    expect(out).toContain("```js");
  }
  if (name === "review-authored-nested-empty") {
    expect(out.match(/<br \/>/g)).toHaveLength(3);
    expect(out).toContain("> Quote");
  }
  if (name === "review-setext-attributes") {
    expect(out).toContain("**Title** {#chapter_one .some_class}");
    expect(out).toContain("{#a&copy;}");
    expect(out).toContain("> [!NOTE]");
  }
  if (name === "review-nested-attributes") {
    expect(out).toContain("**Title** {#my_id .some_class}");
    expect(out).toContain("{#a&copy;}");
  }
  if (name === "review-empty-table") expect(out).not.toContain("<br");
  if (name === "review-inline-breaks") {
    for (const literal of ["Text **<br />** more", "# <br />", "*<br />*", "[<br />](u)"]) expect(out).toContain(literal);
    expect(out.match(/<br \/>/g)).toHaveLength(5);
  }
  if (name.startsWith("review-empty-task")) {
    expect(out).toMatch(/^[*-] \[x\] /m);
    expect(out).toMatch(/^[*-] \[ \] /m);
    expect(out).not.toContain("<br />");
    expect(document.querySelectorAll('li[data-item-type="task"][data-checked="true"]')).toHaveLength(1);
    expect(document.querySelectorAll('li[data-item-type="task"][data-checked="false"]')).toHaveLength(1);
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
    // These must be exercised through the real pane: refusing rich mode is
    // part of the parity contract, not an excuse to skip legacy fixtures.
    const sourceOnly = name.startsWith("review-footnote-") ||
      name.endsWith("/028-encoded-footnote-labels.md") ||
      name.endsWith("/read/legacy-footnote-labels.md");
    if (sourceOnly) {
      expect(richModeUnavailableReason(markdown)).not.toBeNull();
      vi.mocked(api.readChapter).mockResolvedValue({ resource: "ch1", format: "Markdown", content: markdown });
      render(<EditorPane />);
      await waitFor(() => expect(document.querySelector(".cm-editor")).not.toBeNull());
      expect(screen.getByRole("status").textContent).toContain("footnote labels");
      const richButton = screen.getByRole("button", { name: "WYSIWYG" }) as HTMLButtonElement;
      expect(richButton.disabled).toBe(true);
      expect(screen.getByRole("button", { name: "Markdown" }).getAttribute("aria-pressed")).toBe("true");
      expect((screen.getByRole("button", { name: "Apply" }) as HTMLButtonElement).disabled).toBe(true);
      const view = EditorView.findFromDOM(document.querySelector(".cm-editor")! as HTMLElement)!;
      expect(view.state.doc.toString()).toBe(markdown);
      const prefix = "Unrelated edit.\n\n";
      act(() => view.dispatch({ changes: { from: 0, insert: prefix } }));
      fireEvent.click(richButton);
      expect(document.querySelector(".milkdown-host")).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Apply" }));
      await waitFor(() => expect(reader.writeChapter).toHaveBeenCalledWith({ resource: "ch1", format: "Markdown", content: prefix + markdown }));
      assertConstructs(name, view.state.doc.toString(), markdown);
      return;
    }
    expect(richModeUnavailableReason(markdown)).toBeNull();
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
    ">  [!NOTE]\n> Literal", ">     [!NOTE]\n> Literal",
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
  it("rechecks source edits before allowing WYSIWYG", async () => {
    vi.mocked(api.readChapter).mockResolvedValue({ resource: "ch1", format: "Markdown", content: "A[^my note].\n\n[^my note]: Note.\n" });
    render(<EditorPane />);
    await waitFor(() => expect(document.querySelector(".cm-editor")).not.toBeNull());
    const view = EditorView.findFromDOM(document.querySelector(".cm-editor")! as HTMLElement)!;
    const richButton = screen.getByRole("button", { name: "WYSIWYG" }) as HTMLButtonElement;
    expect(richButton.disabled).toBe(true);
    const safe = "A[^note].\n\n[^note]: Note.\n";
    act(() => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: safe } }));
    expect(richButton.disabled).toBe(false);
    expect(document.querySelector(".milkdown-host")).toBeNull();
    expect(screen.queryByText(/footnote labels with spaces/)).toBeNull();
    const unsafe = "A[^a&b].\n\n[^a&b]: Note.\n";
    act(() => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: unsafe } }));
    expect(richButton.disabled).toBe(true);
    fireEvent.click(richButton);
    expect(view.state.doc.toString()).toBe(unsafe);
    act(() => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: safe } }));
    fireEvent.click(richButton);
    await waitFor(() => expect(document.querySelector(".milkdown-host .ProseMirror")).not.toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Markdown" }));
    const returned = EditorView.findFromDOM(document.querySelector(".cm-editor")! as HTMLElement)!;
    expect(returned.state.doc.toString()).toBe(safe);
  });

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
    const original = Object.entries(corpus).filter(([name]) => !name.startsWith("review-footnote-")).map(([, value]) => value).join("\n");
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


describe("app-owned prompts in the real editor", () => {
  it.each(["wysiwyg", "source"])("inserts an image through the %s dialog and retains alt text after another rich edit", async (mode) => {
    vi.mocked(api.readChapter).mockResolvedValue({ resource: "ch1", format: "Markdown", content: "Before.\n" });
    vi.mocked(pickImageFile).mockResolvedValue("/photos/diagram.png");
    reader.addResource.mockResolvedValue({ ...reader.book, resources: [...reader.book.resources, { id: "img1", path: "OEBPS/images/diagram.png" }] });
    sessionStorage.setItem("epubzilla.editor.markdownMode", mode);
    const pane = render(<EditorPane />);
    await waitFor(() => expect(document.querySelector(mode === "source" ? ".cm-editor" : ".milkdown-host .ProseMirror")).not.toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Insert image…" }));
    const input = await screen.findByRole("textbox", { name: /Alt text/ });
    await waitFor(() => expect(document.activeElement).toBe(input));
    expect(reader.addResource).not.toHaveBeenCalled();
    const alt = mode === "source" ? "" : "A [diagram] &copy;";
    fireEvent.change(input, { target: { value: alt } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect((screen.getByRole("button", { name: "Apply" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(reader.writeChapter).toHaveBeenCalled());
    const saved = (reader.writeChapter.mock.calls as unknown as [{ content: string }][])[0][0].content;
    pane.unmount();
    const { editor } = await mount(saved);
    const view = editor.ctx.get(editorViewCtx);
    view.dispatch(view.state.tr.insert(0, view.state.schema.nodes.paragraph.create(null, view.state.schema.text("Unrelated edit."))));
    const out = editor.action(getMarkdown());
    editor.action(replaceAll(out));
    expect(editor.action(getMarkdown())).toBe(out);
    expect(document.querySelector<HTMLImageElement>(".milkdown-host img")?.alt).toBe(alt);
    expect(out).toContain("../images/diagram.png");
  });

  it("opens the link dialog, traps focus, submits with Enter, and preserves the selection", async () => {
    const { editor } = await mount("Link text.\n");
    const view = editor.ctx.get(editorViewCtx);
    act(() => {
      view.focus();
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1, 5)));
    });
    fireEvent.click(screen.getByRole("button", { name: "Link (toggles on the selection)" }));
    const input = await screen.findByRole("textbox", { name: "Link target (href)" });
    await waitFor(() => expect(document.activeElement).toBe(input));
    expect(screen.getByRole("dialog").getAttribute("aria-modal")).toBe("true");
    fireEvent.keyDown(input, { key: "Tab", shiftKey: true });
    const ok = screen.getByRole("button", { name: "OK" });
    expect(document.activeElement).toBe(ok);
    expect(ok.getAttribute("data-variant")).toBe("primary");
    fireEvent.keyDown(ok, { key: "Tab" });
    expect(document.activeElement).toBe(input);
    fireEvent.change(input, { target: { value: "https://example.org" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(editor.action(getMarkdown())).toContain("[Link](https://example.org) text."));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(view.dom);
    // The inserted link must also survive an unrelated edit and reparse.
    view.dispatch(view.state.tr.insert(view.state.doc.content.size, view.state.schema.nodes.paragraph.create(null, view.state.schema.text("Unrelated edit."))));
    const out = editor.action(getMarkdown());
    editor.action(replaceAll(out));
    expect(editor.action(getMarkdown())).toBe(out);
    expect(out).toContain("[Link](https://example.org)");
  });

  it("Escape cancels the link dialog without changing the document", async () => {
    const { editor, onChange } = await mount("Original.\n");
    fireEvent.click(screen.getByRole("button", { name: "Link (toggles on the selection)" }));
    const input = await screen.findByRole("textbox", { name: "Link target (href)" });
    fireEvent.change(input, { target: { value: "https://example.org" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(editor.action(getMarkdown())).toBe("Original.\n");
    expect(onChange).not.toHaveBeenCalled();
  });
});
