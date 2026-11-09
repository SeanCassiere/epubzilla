// Milkdown WYSIWYG wrapper (M3.2, ADR-0007): the rich editing surface for
// in-subset Markdown chapters. Deliberately thin, mirroring CodeEditor —
// buffer state lives in EditorPane; the interchange format is always the
// Markdown STRING (the Rust core does all XHTML conversion).
//
// GFM models footnotes, tasks, titles and aligned tables. Heading attributes
// and {.class} annotations remain editable literal syntax. The conversion
// extensions preserve alerts and intentional empty paragraphs; real-editor
// parity tests cover every construct after an unrelated edit.

import { useEffect, useRef, type MutableRefObject } from "react";
import "@milkdown/kit/prose/view/style/prosemirror.css";
import "@milkdown/kit/prose/tables/style/tables.css";
import {
  Editor,
  defaultValueCtx,
  editorViewCtx,
  editorViewOptionsCtx,
  rootCtx,
} from "@milkdown/kit/core";
import type { Node as ProseNode } from "@milkdown/kit/prose/model";
import { TextSelection } from "@milkdown/kit/prose/state";
import {
  commonmark,
  createCodeBlockCommand,
  insertHrCommand,
  insertImageCommand,
  remarkPreserveEmptyLinePlugin,
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
import type { InsertImage } from "../lib/editing";
import {
  configureConversionSchemas,
  remarkConversion,
} from "../lib/milkdown-conversion";
import { useTextPrompt } from "./PromptDialog";

/**
 * An image arriving via clipboard paste or drag-and-drop (issue #54): the
 * raw bytes plus what little identity the DataTransfer carries. The handler
 * persists it as a book resource and returns the zip-relative Markdown ref
 * to insert (or null when persisting failed).
 */
export type PastedImage = {
  /** Clipboard/file name — often generic ("image.png") or empty. */
  name: string;
  /** MIME type as reported by the DataTransfer (e.g. "image/png"). */
  type: string;
  bytes: Uint8Array;
};

/**
 * Image files in a paste/drop DataTransfer. `files` is authoritative when
 * populated; some WebKit paste payloads only surface through `items`.
 */
function imageFiles(data: DataTransfer | null): File[] {
  if (data === null) return [];
  const files = Array.from(data.files ?? []).filter((f) =>
    f.type.startsWith("image/"),
  );
  if (files.length > 0) return files;
  const fromItems: File[] = [];
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind !== "file" || !item.type.startsWith("image/")) continue;
    const file = item.getAsFile();
    if (file !== null) fromItems.push(file);
  }
  return fromItems;
}

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
  onPasteImage,
  readOnly = false,
}: {
  value: string;
  onChange: (next: string) => void;
  /**
   * Lifecycle freeze: no edits (typing, toolbar, paste/drop) while a
   * lifecycle operation is pending. Focus is given back when editing
   * resumes if the editor had it.
   */
  readOnly?: boolean;
  /** Test hook: called with the live editor once created. */
  onReady?: (editor: Editor) => void;
  /** M3.3: renders an "Insert image…" toolbar button running this flow. */
  onInsertImage?: () => void;
  /**
   * M3.3: while mounted, receives a function that inserts an image node
   * for `src` at the cursor (EditorPane's insert-image flow calls it after
   * add_resource_from_path).
   */
  insertImageRef?: MutableRefObject<InsertImage | null>;
  /**
   * Issue #52: render-time URL resolver for image sources. The DOCUMENT
   * keeps whatever the Markdown says (zip-relative refs like
   * `../images/x.png` — never rewritten, never serialized differently);
   * only the rendered <img> element gets the resolved (epub:// asset
   * protocol) URL so the image actually displays inside the editor.
   */
  resolveUrl?: (src: string) => string;
  /**
   * Issue #54: persistence hook for images arriving via clipboard paste or
   * drag-and-drop. When set, image payloads are intercepted BEFORE
   * ProseMirror's default paste/drop handling (which would hold them as
   * transient blob/data URLs that never persist): the handler adds the
   * bytes to the book and resolves to the zip-relative ref to insert —
   * the same ref shape as the toolbar insert, so it renders through
   * `resolveUrl` and serializes relative. Resolving null inserts nothing
   * (persisting failed). Non-image payloads always fall through to the
   * default handling.
   */
  onPasteImage?: (image: PastedImage) => Promise<string | null>;
}) {
  const { prompt, promptImageAlt, dialog } = useTextPrompt();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<Editor | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  const resolveUrlRef = useRef(resolveUrl);
  resolveUrlRef.current = resolveUrl;
  const onPasteImageRef = useRef(onPasteImage);
  onPasteImageRef.current = onPasteImage;
  const readOnlyRef = useRef(readOnly);
  readOnlyRef.current = readOnly;

  // Persist pasted/dropped image files and insert their refs at the cursor.
  // Sequential on purpose: each insert lands at the selection left by the
  // previous one, and the Book adoption in the handler is serialized.
  const persistImages = (files: File[]): void => {
    void (async () => {
      for (const file of files) {
        const handler = onPasteImageRef.current;
        if (handler === undefined || readOnlyRef.current) return;
        let bytes: Uint8Array;
        try {
          bytes = new Uint8Array(await file.arrayBuffer());
        } catch {
          continue; // unreadable payload: skip it, keep the rest
        }
        const alt = await promptImageAlt();
        if (alt === null) continue;
        const src = await handler({
          name: file.name,
          type: file.type,
          bytes,
        });
        if (src === null) continue;
        const editor = editorRef.current;
        if (editor === null) return;
        editor.action(callCommand(insertImageCommand.key, { src, alt }));
      }
    })();
  };
  const persistImagesRef = useRef(persistImages);
  persistImagesRef.current = persistImages;

  // The last markdown this editor holds — what it emitted, or the serialized
  // form of what was pushed into it. Breaks external-replacement feedback
  // loops: pushes must never re-emit (a mode switch or buffer reload is not
  // a user edit and must not dirty the buffer).
  const heldRef = useRef(value);
  const heldDocumentRef = useRef<ProseNode | null>(null);
  const initialValueRef = useRef(value);
  initialValueRef.current = value;

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    heldRef.current = initialValueRef.current;
    let destroyed = false;
    const editor = Editor.make()
      .config((ctx) => {
        configureConversionSchemas(ctx);
        ctx.set(rootCtx, host);
        ctx.set(defaultValueCtx, initialValueRef.current);
        ctx.get(listenerCtx).markdownUpdated((ctx, markdown) => {
          heldDocumentRef.current = ctx.get(editorViewCtx).state.doc;
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
          editable: () => !readOnlyRef.current,
          // Clipboard/drop image persistence (#54): image payloads are
          // consumed here — persisted as book resources, then inserted as
          // zip-relative refs — so ProseMirror's default handling never
          // materializes a transient blob/data URL in the document. Anything
          // without an image file (plain text, HTML, ...) falls through.
          handlePaste: (view, event, slice) => {
            if (onPasteImageRef.current !== undefined) {
              const files = imageFiles(event.clipboardData);
              if (files.length > 0) {
                persistImagesRef.current(files);
                return true;
              }
            }
            return prev.handlePaste?.(view, event, slice) ?? false;
          },
          handleDrop: (view, event, slice, moved) => {
            if (onPasteImageRef.current !== undefined && !moved) {
              const files = imageFiles(event.dataTransfer);
              if (files.length > 0) {
                // Drop inserts at the drop point, not the old cursor. When
                // the position cannot be determined (no layout), the current
                // selection is the honest fallback.
                let pos: { pos: number } | null = null;
                try {
                  pos = view.posAtCoords({
                    left: event.clientX,
                    top: event.clientY,
                  });
                } catch {
                  pos = null; // no layout (tests): keep the selection
                }
                if (pos != null) {
                  const tr = view.state.tr.setSelection(
                    TextSelection.near(view.state.doc.resolve(pos.pos)),
                  );
                  view.dispatch(tr);
                }
                persistImagesRef.current(files);
                return true;
              }
            }
            return prev.handleDrop?.(view, event, slice, moved) ?? false;
          },
          nodeViews: {
            ...prev.nodeViews,
            image: (node: ProseNode) => {
              const img = document.createElement("img");
              const src = String(node.attrs.src ?? "");
              img.src = resolveUrlRef.current?.(src) ?? src;
              const alt = String(node.attrs.alt ?? "");
              img.alt = alt;
              const title = String(node.attrs.title ?? "");
              if (title !== "") img.title = title;
              return { dom: img };
            },
          },
        }));
      })
      .use(remarkConversion)
      .use(commonmark.filter(
        (plugin) => plugin !== remarkPreserveEmptyLinePlugin.plugin &&
          plugin !== remarkPreserveEmptyLinePlugin.options,
      ))
      .use(gfm)
      .use(history)
      .use(listener);
    void editor.create().then(() => {
      if (destroyed) {
        void editor.destroy();
        return;
      }
      editorRef.current = editor;
      heldDocumentRef.current = editor.ctx.get(editorViewCtx).state.doc;
      onReadyRef.current?.(editor);
    });
    return () => {
      destroyed = true;
      // Milkdown debounces markdownUpdated by 200 ms. A fast mode switch
      // must flush a real pending edit, but never normalize an untouched
      // buffer just because the component unmounts.
      if (editorRef.current === editor) {
        const doc = editor.ctx.get(editorViewCtx).state.doc;
        if (heldDocumentRef.current && !doc.eq(heldDocumentRef.current)) {
          const markdown = editor.action(getMarkdown());
          if (markdown !== heldRef.current) onChangeRef.current(markdown);
        }
      }
      editorRef.current = null;
      heldDocumentRef.current = null;
      void editor.destroy();
    };
  }, []);

  // Cursor-aware image insertion (M3.3): insert an image node at the
  // cursor; the markdownUpdated listener reports the change upward.
  useEffect(() => {
    if (insertImageRef === undefined) return;
    insertImageRef.current = (src, alt = "") => {
      const editor = editorRef.current;
      if (editor === null) return;
      editor.action(callCommand(insertImageCommand.key, { src, alt }));
    };
    return () => {
      insertImageRef.current = null;
    };
  }, [insertImageRef]);

  // Lifecycle freeze: re-evaluate `editable` now (ProseMirror reads it on
  // update) and hand focus back afterwards.
  const hadFocusRef = useRef(false);
  useEffect(() => {
    const editor = editorRef.current;
    if (editor === null) return;
    editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      if (readOnly) hadFocusRef.current = view.hasFocus();
      view.setProps({ editable: () => !readOnlyRef.current });
      if (!readOnly && hadFocusRef.current) {
        hadFocusRef.current = false;
        view.focus();
      }
    });
  }, [readOnly]);

  // External value replacement (buffer reload) — no-op for the editor's own
  // edits, which already set heldRef via the markdownUpdated listener. After
  // a push, hold the *serialized* form of the new document so the listener's
  // (possibly normalized) echo of the replace is absorbed, not emitted.
  useEffect(() => {
    const editor = editorRef.current;
    if (editor !== null && value !== heldRef.current) {
      editor.action(replaceAll(value));
      heldRef.current = editor.action(getMarkdown());
      heldDocumentRef.current = editor.ctx.get(editorViewCtx).state.doc;
    }
  }, [value]);

  return (
    <div className="milkdown-editor">
      <div className="milkdown-toolbar" role="toolbar" aria-label="Formatting">
        {TOOLBAR.map((action) => (
          <button
            key={action.title}
            type="button"
            data-variant="plain"
            data-size="sm"
            title={action.title}
            aria-label={action.title}
            disabled={readOnly}
            onMouseDown={(e) => e.preventDefault() /* keep the selection */}
            onClick={() => {
              const editor = editorRef.current;
              if (editor !== null && !readOnlyRef.current) action.run(editor);
            }}
          >
            {action.label}
          </button>
        ))}
        <button
          type="button"
          title="Link (toggles on the selection)"
          aria-label="Link (toggles on the selection)"
          onMouseDown={(event) => event.preventDefault() /* keep the selection */}
          onClick={() => {
            void (async () => {
              const href = await prompt("Link target", "Link target (href)");
              const editor = editorRef.current;
              if (editor && href) editor.action(callCommand(toggleLinkCommand.key, { href }));
            })();
          }}
        >
          Link
        </button>
        {onInsertImage !== undefined && (
          <button
            type="button"
            data-variant="plain"
            data-size="sm"
            title="Add an image to the book and reference it at the cursor"
            disabled={readOnly}
            onMouseDown={(e) => e.preventDefault() /* keep the selection */}
            onClick={onInsertImage}
          >
            Insert image…
          </button>
        )}
      </div>
      <div className="milkdown-host" ref={hostRef} />
      {dialog}
    </div>
  );
}
