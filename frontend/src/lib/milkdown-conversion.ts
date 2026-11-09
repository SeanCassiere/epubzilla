// Editor-only extensions for the Markdown contract. XHTML remains core-owned.
import type { Ctx } from "@milkdown/kit/ctx";
import type { MarkdownNode } from "@milkdown/kit/transformer";
import { blockquoteSchema, paragraphSchema } from "@milkdown/kit/preset/commonmark";
import { $remark } from "@milkdown/kit/utils";

const ALERT_KINDS = new Set(["note", "tip", "important", "warning", "caution"]);

function alertKind(value: unknown): string | null {
  return typeof value === "string" && ALERT_KINDS.has(value) ? value : null;
}

// Run before Milkdown's phrasing transforms: positions must still refer to
// the source, before entities, hard breaks and setext headings obscure syntax.
export const remarkConversion = $remark("epubzilla-conversion", () => function () {
  const processor = this;
  return (tree, file) => {
    const source = String(file);
    const alerts = new Map<number, string>();
    const attributes = new Map<number, string>();
    const edits: { start: number; end: number; value: string }[] = [];
    const scan = (node: MarkdownNode, phase: "alerts" | "attributes") => {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start !== undefined && end !== undefined) {
        const raw = source.slice(start, end);
        if (phase === "alerts" && node.type === "blockquote") {
          const marker = /^>[ \t]?\[!(note|tip|important|warning|caution)\][ \t\v\f]*(?:\r\n|[\r\n]|$)/i.exec(raw);
          if (marker) {
            alerts.set(start, marker[1].toLowerCase());
            const length = marker[0].replace(/[\r\n]+$/, "").length;
            edits.push({ start: start + 1, end: start + length, value: " ".repeat(length - 1) });
          }
        }
        if (phase === "attributes" && node.type === "heading") {
          // The last inline node ends before closing # markers or a setext
          // underline, even when the heading is nested in a quote or list.
          const last = node.children?.[node.children.length - 1];
          const inline = source.slice(start, last?.position?.end.offset ?? end);
          const annotation = /(?:^|[ \t]+)(\{[^{}\r\n]+\})[ \t]*$/.exec(inline);
          if (annotation) {
            const offset = start + annotation.index + annotation[0].indexOf(annotation[1]);
            attributes.set(start, annotation[1]);
            // An inert, same-length placeholder keeps the heading and all
            // source positions intact, even for entity or emphasis tokens.
            edits.push({ start: offset, end: offset + annotation[1].length, value: "z".repeat(annotation[1].length) });
          }
        }
      }
      node.children?.forEach((child) => scan(child, phase));
    };
    let masked = source;
    let result = tree;
    // Alerts can expose new setext headings in their bodies, so resolve
    // block structure first, then protect the heading attribute tokens.
    for (const phase of ["alerts", "attributes"] as const) {
      edits.length = 0;
      scan(result as MarkdownNode, phase);
      for (const edit of edits.sort((a, b) => b.start - a.start)) {
        masked = masked.slice(0, edit.start) + edit.value + masked.slice(edit.end);
      }
      if (edits.length) result = processor.parse(masked) as typeof tree;
    }
    // Offsets still refer to the original file, which later Milkdown plugins
    // use to retain strong/emphasis delimiter characters.
    const visit = (node: MarkdownNode, parentType?: string) => {
      const start = node.position?.start.offset;
      const raw = start === undefined ? "" : source.slice(start, node.position?.end.offset);
      const kind = start === undefined ? undefined : alerts.get(start);
      if (node.type === "blockquote" && kind) {
        node.kind = kind;
        if (!node.children?.length) node.children = [{ type: "paragraph", children: [] }];
      }
      const annotation = start === undefined ? undefined : attributes.get(start);
      if (node.type === "heading" && annotation) {
        const last = node.children?.[node.children.length - 1];
        if (last?.type === "text" && typeof last.value === "string") {
          last.value = last.value.slice(0, -annotation.length);
          node.children!.push({ type: "html", value: annotation });
        }
      }
      if (node.type === "paragraph" && /^\{\.[A-Za-z][A-Za-z0-9_-]*\}$/.test(raw)) {
        node.children = [{ type: "html", value: raw }];
      }
      if (node.type === "listItem" && node.checked == null) {
        const paragraph = node.children?.[0];
        const offset = paragraph?.position?.start.offset;
        const marker = offset === undefined ? null : /^\[([xX \t])\](?:[ \t]*(?:\r\n|[\r\n])|[ \t]+$)/.exec(source.slice(offset));
        if (paragraph?.type === "paragraph" && marker) {
          node.checked = marker[1].toLowerCase() === "x";
          const first = paragraph.children?.[0];
          if (first?.type === "text" && typeof first.value === "string") {
            first.value = first.value.replace(/^\[[xX \t]\](?:[ \t]*(?:\r\n|[\r\n]))?/, "");
            if (!first.value) paragraph.children!.shift();
          }
        }
      }
      // Only standalone HTML blocks have the core's empty-paragraph meaning.
      // Inline HTML in marks, links, headings and table cells stays literal.
      if (node.type === "html" && ["root", "blockquote", "listItem", "footnoteDefinition"].includes(parentType ?? "") &&
          typeof node.value === "string" && ["<br>", "<br/>", "<br />"].includes(node.value.trim())) {
        node.type = "paragraph";
        node.authoredEmpty = true;
        node.children = [];
        delete node.value;
      }
      node.children?.forEach((child) => visit(child, node.type));
    };
    visit(result as MarkdownNode);
    return result;
  };
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
          const fillerOnly = kind !== null && node.childCount === 1 &&
            node.firstChild?.type.name === "paragraph" && node.firstChild.content.size === 0 && !node.firstChild.attrs.authoredEmpty;
          if (!fillerOnly) state.next(node.content);
          state.closeNode();
        },
      },
    };
  });

  ctx.update(paragraphSchema.key, (previous) => (schemaCtx) => {
    const base = previous(schemaCtx);
    return {
      ...base,
      attrs: { ...base.attrs, authoredEmpty: { default: false } },
      parseDOM: [{ tag: "p", getAttrs: (dom) => ({ authoredEmpty: dom.hasAttribute("data-authored-empty") }) }],
      toDOM: (node) => ["p", node.attrs.authoredEmpty ? { "data-authored-empty": "true" } : {}, 0],
      parseMarkdown: {
        ...base.parseMarkdown,
        runner: (state, node, type) => {
          state.openNode(type, { authoredEmpty: node.authoredEmpty === true }).next(node.children).closeNode();
        },
      },
      toMarkdown: {
        ...base.toMarkdown,
        runner: (state, node) => {
          const parent = state.top()?.type;
          const leading = !state.top()?.children?.length;
          if (node.content.size === 0 && (parent === "tableCell" || (parent === "listItem" && leading && !node.attrs.authoredEmpty))) {
            // A task's first paragraph is required by remark's GFM writer.
            // A literal marker supplies the trailing space that its empty
            // paragraph handler would otherwise trim away.
            const item = state.top();
            if (parent === "listItem" && typeof item?.props.checked === "boolean") {
              const checked = item.props.checked;
              delete item.props.checked;
              state.addNode("paragraph", [{ type: "html", value: `[${checked ? "x" : " "}] ` }]);
            } else {
              state.addNode("paragraph", []);
            }
            return;
          }
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
