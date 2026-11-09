import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";

type Request = {
  id: number;
  title: string;
  label: string;
  resolve: (value: string | null) => void;
};

/** Awaitable app-owned prompt: WKWebView does not implement window.prompt. */
export function useTextPrompt() {
  const [request, setRequest] = useState<Request | null>(null);
  const pending = useRef<Request | null>(null);
  const sequence = useRef(0);
  const mounted = useRef(true);
  const prompt = useCallback((title: string, label: string) => new Promise<string | null>((resolve) => {
    // File reads/pickers may finish after the editor has gone away.
    if (!mounted.current) { resolve(null); return; }
    pending.current?.resolve(null);
    const next = { id: ++sequence.current, title, label, resolve };
    pending.current = next;
    setRequest(next);
  }), []);
  const finish = useCallback((value: string | null) => {
    pending.current?.resolve(value);
    pending.current = null;
    setRequest(null);
  }, []);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      pending.current?.resolve(null);
      pending.current = null;
    };
  }, []);
  const promptImageAlt = useCallback(
    () => prompt("Image alt text", "Alt text (leave empty for a decorative image)"),
    [prompt],
  );
  return {
    prompt,
    promptImageAlt,
    dialog: request && createPortal(
      <PromptDialog key={request.id} request={request} finish={finish} />,
      document.body,
    ),
  };
}

function PromptDialog({ request, finish }: {
  request: Request;
  finish: (value: string | null) => void;
}) {
  const [value, setValue] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const id = useId();
  useEffect(() => {
    const previous = document.activeElement;
    input.current?.focus();
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);
  return (
    <div className="modal-overlay">
      <form
        ref={form}
        className="modal prompt-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        onSubmit={(event) => { event.preventDefault(); finish(value); }}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Enter" && event.target === input.current && !event.nativeEvent.isComposing) {
            event.preventDefault();
            finish(value);
          }
          if (event.key === "Escape") {
            event.preventDefault();
            finish(null);
          }
          if (event.key === "Tab") {
            const controls = form.current?.querySelectorAll<HTMLElement>("input, button");
            const first = controls?.[0];
            const last = controls?.[controls.length - 1];
            if (event.shiftKey && document.activeElement === first) {
              event.preventDefault();
              last?.focus();
            }
            if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault();
              first?.focus();
            }
          }
        }}
      >
        <h2 className="modal-title" id={`${id}-title`}>{request.title}</h2>
        <label className="prompt-dialog-label" htmlFor={`${id}-input`}>{request.label}</label>
        <input
          ref={input}
          id={`${id}-input`}
          className="prompt-dialog-input"
          type="text"
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
        <div className="modal-actions">
          <button type="button" onClick={() => finish(null)}>Cancel</button>
          <button type="submit" data-variant="primary">OK</button>
        </div>
      </form>
    </div>
  );
}
