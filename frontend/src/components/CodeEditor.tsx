// CodeMirror 6 wrapper (ADR-0007): the raw-Markdown editing surface and the
// XHTML source mode for out-of-subset chapters. Deliberately thin — buffer
// state lives in EditorPane; this only hosts the view.

import { useEffect, useRef, type MutableRefObject } from "react";
import { basicSetup, EditorView } from "codemirror";
import { Compartment, EditorState } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { xml } from "@codemirror/lang-xml";
import { imageMarkdown, type InsertImage } from "../lib/editing";

export type CodeLanguage = "markdown" | "xml";

export function CodeEditor({
  value,
  language,
  onChange,
  insertImageRef,
  readOnly = false,
}: {
  value: string;
  language: CodeLanguage;
  onChange: (next: string) => void;
  /**
   * Lifecycle freeze: no edits while a lifecycle operation is pending.
   * Focus is given back when editing resumes if the editor had it.
   */
  readOnly?: boolean;
  /**
   * M3.3: while mounted, receives a function that inserts a Markdown image
   * reference for `src` at the current selection (EditorPane's insert-image
   * flow calls it after add_resource_from_path).
   */
  insertImageRef?: MutableRefObject<InsertImage | null>;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // (Re)create the view when the language changes; the initial document is
  // whatever `value` is at that moment (the sync effect below handles later
  // external replacements, e.g. a reloaded buffer).
  const initialValueRef = useRef(value);
  initialValueRef.current = value;
  const readOnlyRef = useRef(readOnly);
  readOnlyRef.current = readOnly;
  const editableCompartment = useRef(new Compartment());
  const editableExtension = (locked: boolean) => [
    EditorState.readOnly.of(locked),
    EditorView.editable.of(!locked),
  ];
  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    const view = new EditorView({
      doc: initialValueRef.current,
      parent: host,
      extensions: [
        basicSetup,
        language === "markdown" ? markdown() : xml(),
        EditorView.lineWrapping,
        editableCompartment.current.of(editableExtension(readOnlyRef.current)),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            onChangeRef.current(update.state.doc.toString());
          }
        }),
      ],
    });
    viewRef.current = view;
    return () => {
      viewRef.current = null;
      view.destroy();
    };
  }, [language]);

  // Lifecycle freeze: toggle read-only in place (no view rebuild, so the
  // selection survives) and hand focus back afterwards.
  const hadFocusRef = useRef(false);
  useEffect(() => {
    const view = viewRef.current;
    if (view === null) return;
    if (readOnly) hadFocusRef.current = view.hasFocus;
    view.dispatch({
      effects: editableCompartment.current.reconfigure(editableExtension(readOnly)),
    });
    if (!readOnly && hadFocusRef.current) {
      hadFocusRef.current = false;
      view.focus();
    }
  }, [readOnly]);

  // Cursor-aware image insertion (M3.3): dispatch the Markdown reference at
  // the current selection; the update listener reports the change upward.
  useEffect(() => {
    if (insertImageRef === undefined) return;
    insertImageRef.current = (src, alt = "") => {
      const view = viewRef.current;
      if (view === null) return;
      const { from, to } = view.state.selection.main;
      const text = imageMarkdown(src, alt);
      view.dispatch({
        changes: { from, to, insert: text },
        selection: { anchor: from + text.length },
      });
      view.focus();
    };
    return () => {
      insertImageRef.current = null;
    };
  }, [insertImageRef]);

  // External value replacement (buffer reload) — no-op for the view's own
  // edits, which already produced this value via the update listener.
  useEffect(() => {
    const view = viewRef.current;
    if (view !== null && view.state.doc.toString() !== value) {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: value },
      });
    }
  }, [value]);

  return (
    <div
      className="code-editor"
      ref={hostRef}
      aria-readonly={readOnly ? true : undefined}
    />
  );
}
