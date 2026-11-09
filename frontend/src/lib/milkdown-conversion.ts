// Editor-only extensions for the Markdown contract. XHTML remains core-owned.
import type { Ctx } from "@milkdown/kit/ctx";
import type { MarkdownNode } from "@milkdown/kit/transformer";
import { blockquoteSchema, paragraphSchema } from "@milkdown/kit/preset/commonmark";
import { $remark } from "@milkdown/kit/utils";

const ALERT_KINDS = new Set(["note", "tip", "important", "warning", "caution"]);

function alertKind(value: unknown): string | null {
  return typeof value === "string" && ALERT_KINDS.has(value) ? value : null;
}

// Inspect the source as well as the AST: remark decodes both [!NOTE] and
// \[!NOTE] into identical text. Only the unescaped, standalone first line
// is an alert; entities, inline code and unknown markers stay ordinary prose.
export const remarkConversion = $remark("epubzilla-conversion", () => () => (tree, file) => {
  const source = String(file);
  const isEmptyParagraph = (node: MarkdownNode | undefined) =>
    node?.type === "html" && typeof node.value === "string" &&
    ["<br>", "<br/>", "<br />"].includes(node.value.trim());
  const visit = (node: MarkdownNode, parentType?: string) => {
    // The bundled empty-line plugin also deletes inline <br> text. The
    // contract only treats a block containing a single br as an empty
    // paragraph; all other HTML must survive as literal source.
    if (node.type === "paragraph" && node.children?.length === 1 && isEmptyParagraph(node.children[0])) {
      node.children = [];
    } else if (isEmptyParagraph(node) && parentType !== "paragraph") {
      node.type = "paragraph";
      node.children = [];
      delete node.value;
    }
    if (node.type === "blockquote") {
      const paragraph = node.children?.[0];
      const first = paragraph?.children?.[0];
      // Milkdown splits soft breaks into nodes and drops text positions.
      // The containing paragraph still points at the original first byte.
      const offset = paragraph?.position?.start.offset;
      const match = first?.type === "text" && typeof first.value === "string"
        ? /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\](?:\r?\n|$)/.exec(first.value)
        : null;
      if (paragraph?.type === "paragraph" && match && offset !== undefined &&
          /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\](?:\r?\n|$)/.test(source.slice(offset))) {
        node.kind = match[1].toLowerCase();
        first!.value = (first!.value as string).slice(match[0].length);
        if (first!.value === "") {
          paragraph.children!.shift();
          if (paragraph.children?.[0]?.type === "break") paragraph.children.shift();
        }
        if (paragraph.children!.length === 0) node.children!.shift();
        // ProseMirror blockquotes need a block even for a marker-only alert.
        if (node.children!.length === 0) node.children!.push({ type: "paragraph", children: [] });
      }
    }
    node.children?.forEach((child) => visit(child, node.type));
  };
  visit(tree as MarkdownNode);
});

export function configureConversionSchemas(ctx: Ctx) {
  ctx.update(blockquoteSchema.key, (previous) => (schemaCtx) => {
    const base = previous(schemaCtx);
    return {
      ...base,
      attrs: { ...base.attrs, kind: { default: null } },
      parseDOM: [
        {
          tag: "blockquote[data-kind]",
          getAttrs: (dom) => ({ kind: alertKind(dom.getAttribute("data-kind")) }),
          contentElement: ".editor-alert-body",
        },
        ...(base.parseDOM ?? []),
      ],
      toDOM: (node) => {
        const kind = alertKind(node.attrs.kind);
        if (kind === null) return base.toDOM!(node);
        return [
          "blockquote", { "data-kind": kind },
          ["div", { class: "editor-alert-label", contenteditable: "false" }, kind[0].toUpperCase() + kind.slice(1)],
          ["div", { class: "editor-alert-body" }, 0],
        ];
      },
      parseMarkdown: {
        ...base.parseMarkdown,
        runner: (state, node, type) => {
          state.openNode(type, { kind: alertKind(node.kind) }).next(node.children).closeNode();
        },
      },
      toMarkdown: {
        ...base.toMarkdown,
        runner: (state, node) => {
          state.openNode("blockquote");
          const kind = alertKind(node.attrs.kind);
          // A generated raw mdast node bypasses remark's phrasing escapes.
          // Its value comes only from the five known kinds, never user HTML.
          if (kind !== null) state.addNode("html", undefined, `[!${kind.toUpperCase()}]`);
          state.next(node.content).closeNode();
        },
      },
    };
  });

  ctx.update(paragraphSchema.key, (previous) => (schemaCtx) => {
    const base = previous(schemaCtx);
    return {
      ...base,
      toMarkdown: {
        ...base.toMarkdown,
        runner: (state, node) => {
          // Milkdown normally discards the final empty paragraph. In the
          // conversion contract it is authored content, even at chapter end.
          if (node.content.size === 0) {
            state.openNode("paragraph").addNode("html", undefined, "<br />").closeNode();
          } else {
            base.toMarkdown.runner(state, node);
          }
        },
      },
    };
  });
}
