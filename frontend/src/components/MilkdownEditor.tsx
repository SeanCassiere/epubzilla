// Milkdown WYSIWYG wrapper (M3.2, ADR-0007): the rich editing surface for
// in-subset Markdown chapters. Deliberately thin, mirroring CodeEditor —
// buffer state lives in EditorPane; the interchange format is always the
// Markdown STRING (the Rust core does all XHTML conversion).
//
// Contract syntax Milkdown does not model — Pandoc-style footnotes ([^1])
// and {.class} annotations — renders as literal text here (accepted
// ADR-0007 consequence). Verified by src/test/m3-milkdown.test.tsx: the
// serializer passes both through VERBATIM (no escaping, no loss), so no
// fallback gating is needed; the raw Markdown mode remains available for
// editing them comfortably.

import { useEffect, useRef, type MutableRefObject } from "react";
import "@milkdown/kit/prose/view/style/prosemirror.css";
import "@milkdown/kit/prose/tables/style/tables.css";
import {
  Editor,
  defaultValueCtx,
  editorViewOptionsCtx,
  rootCtx,
} from "@milkdown/kit/core";
import type { Node as ProseNode } from "@milkdown/kit/prose/model";
import {
  commonmark,
  createCodeBlockCommand,
  insertHrCommand,
  insertImageCommand,
  toggleEmphasisCommand,
  toggleLinkCommand,
  toggleStrongCommand,
  wrapInBlockquoteCommand,
  wrapInBulletListCommand,
  wrapInHeadingCommand,
  wrapInOrderedListCommand,
} from "@milkdown/kit/preset/commonmark";
import {
  gfm,
  insertTableCommand,
  toggleStrikethroughCommand,
} from "@milkdown/kit/preset/gfm";
import { history } from "@milkdown/kit/plugin/history";
import { listener, listenerCtx } from "@milkdown/kit/plugin/listener";
import { callCommand, getMarkdown, replaceAll } from "@milkdown/kit/utils";

type ToolbarAction = {
  label: string;
  title: string;
  run: (editor: Editor) => void;
};

const TOOLBAR: ToolbarAction[] = [
  ...[1, 2, 3].map((level) => ({
    label: `H${level}`,
    title: `Heading ${level}`,
    run: (e: Editor) => e.action(callCommand(wrapInHeadingCommand.key, level)),
  })),
  {
    label: "B",
    title: "Bold",
    run: (e) => e.action(callCommand(toggleStrongCommand.key)),
  },
  {
    label: "I",
    title: "Italic",
    run: (e) => e.action(callCommand(toggleEmphasisCommand.key)),
  },
  {
    label: "S̶",
    title: "Strikethrough",
    run: (e) => e.action(callCommand(toggleStrikethroughCommand.key)),
  },
  {
    label: "•",
    title: "Bullet list",
    run: (e) => e.action(callCommand(wrapInBulletListCommand.key)),
  },
  {
    label: "1.",
    title: "Ordered list",
    run: (e) => e.action(callCommand(wrapInOrderedListCommand.key)),
  },
  {
    label: "❝",
    title: "Blockquote",
    run: (e) => e.action(callCommand(wrapInBlockquoteCommand.key)),
  },
  {
    label: "</>",
    title: "Code block",
    run: (e) => e.action(callCommand(createCodeBlockCommand.key)),
  },
  {
    label: "Link",
    title: "Link (toggles on the selection)",
    run: (e) => {
      const href = window.prompt("Link target (href):", "");
      if (href === null || href === "") return;
      e.action(callCommand(toggleLinkCommand.key, { href }));
    },
  },
  {
    label: "Table",
    title: "Insert table",
    run: (e) => e.action(callCommand(insertTableCommand.key)),
  },
  {
    label: "―",
    title: "Horizontal rule",
    run: (e) => e.action(callCommand(insertHrCommand.key)),
  },
];

export function MilkdownEditor({
  value,
  onChange,
  onReady,
  onInsertImage,
  insertImageRef,
  resolveUrl,
}: {
  value: string;
  onChange: (next: string) => void;
  /** Test hook: called with the live editor once created. */
  onReady?: (editor: Editor) => void;
  /** M3.3: renders an "Insert image…" toolbar button running this flow. */
  onInsertImage?: () => void;
  /**
   * M3.3: while mounted, receives a function that inserts an image node
   * for `src` at the cursor (EditorPane's insert-image flow calls it after
   * add_resource_from_path).
   */
  insertImageRef?: MutableRefObject<((src: string) => void) | null>;
  /**
   * Issue #52: render-time URL resolver for image sources. The DOCUMENT
   * keeps whatever the Markdown says (zip-relative refs like
   * `../images/x.png` — never rewritten, never serialized differently);
   * only the rendered <img> element gets the resolved (epub:// asset
   * protocol) URL so the image actually displays inside the editor.
   */
  resolveUrl?: (src: string) => string;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<Editor | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  const resolveUrlRef = useRef(resolveUrl);
  resolveUrlRef.current = resolveUrl;

  // The last markdown this editor holds — what it emitted, or the serialized
  // form of what was pushed into it. Breaks external-replacement feedback
  // loops: pushes must never re-emit (a mode switch or buffer reload is not
  // a user edit and must not dirty the buffer).
  const heldRef = useRef(value);
  const initialValueRef = useRef(value);
  initialValueRef.current = value;

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    heldRef.current = initialValueRef.current;
    let destroyed = false;
    const editor = Editor.make()
      .config((ctx) => {
        ctx.set(rootCtx, host);
        ctx.set(defaultValueCtx, initialValueRef.current);
        ctx.get(listenerCtx).markdownUpdated((_ctx, markdown) => {
          if (markdown === heldRef.current) return;
          heldRef.current = markdown;
          onChangeRef.current(markdown);
        });
        // Render-time image resolution (#52): a node view that maps the
        // node's (relative) src through resolveUrl for DISPLAY only. The
        // ProseMirror document — and therefore the serialized Markdown —
        // keeps the relative path untouched. Node views without update()
        // are recreated whenever the node's attrs change, so edits to the
        // src re-resolve automatically.
        ctx.update(editorViewOptionsCtx, (prev) => ({
          ...prev,
          nodeViews: {
            ...prev.nodeViews,
            image: (node: ProseNode) => {
              const img = document.createElement("img");
              const src = String(node.attrs.src ?? "");
              img.src = resolveUrlRef.current?.(src) ?? src;
              const alt = String(node.attrs.alt ?? "");
              if (alt !== "") img.alt = alt;
              const title = String(node.attrs.title ?? "");
              if (title !== "") img.title = title;
              return { dom: img };
            },
          },
        }));
      })
      .use(commonmark)
      .use(gfm)
      .use(history)
      .use(listener);
    void editor.create().then(() => {
      if (destroyed) {
        void editor.destroy();
        return;
      }
      editorRef.current = editor;
      onReadyRef.current?.(editor);
    });
    return () => {
      destroyed = true;
      editorRef.current = null;
      void editor.destroy();
    };
  }, []);

  // Cursor-aware image insertion (M3.3): insert an image node at the
  // cursor; the markdownUpdated listener reports the change upward.
  useEffect(() => {
    if (insertImageRef === undefined) return;
    insertImageRef.current = (src: string) => {
      const editor = editorRef.current;
      if (editor === null) return;
      editor.action(callCommand(insertImageCommand.key, { src }));
    };
    return () => {
      insertImageRef.current = null;
    };
  }, [insertImageRef]);

  // External value replacement (buffer reload) — no-op for the editor's own
  // edits, which already set heldRef via the markdownUpdated listener. After
  // a push, hold the *serialized* form of the new document so the listener's
  // (possibly normalized) echo of the replace is absorbed, not emitted.
  useEffect(() => {
    const editor = editorRef.current;
    if (editor !== null && value !== heldRef.current) {
      editor.action(replaceAll(value));
      heldRef.current = editor.action(getMarkdown());
    }
  }, [value]);

  return (
    <div className="milkdown-editor">
      <div className="milkdown-toolbar" role="toolbar" aria-label="Formatting">
        {TOOLBAR.map((action) => (
          <button
            key={action.title}
            type="button"
            title={action.title}
            aria-label={action.title}
            onMouseDown={(e) => e.preventDefault() /* keep the selection */}
            onClick={() => {
              const editor = editorRef.current;
              if (editor !== null) action.run(editor);
            }}
          >
            {action.label}
          </button>
        ))}
        {onInsertImage !== undefined && (
          <button
            type="button"
            title="Add an image to the book and reference it at the cursor"
            onMouseDown={(e) => e.preventDefault() /* keep the selection */}
            onClick={onInsertImage}
          >
            Insert image…
          </button>
        )}
      </div>
      <div className="milkdown-host" ref={hostRef} />
    </div>
  );
}
