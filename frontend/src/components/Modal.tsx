// Shared modal wrapper for every in-app dialog (New Book, Edit metadata,
// the unsaved-changes sheet). Behaviour, not looks:
//  - Esc = Cancel (topmost modal only),
//  - optional Return = default action (HIG; Space still activates the
//    focused button),
//  - focus moves in on open (an autoFocus / [data-autofocus] element, else
//    the first control), Tab is trapped inside, and focus returns to
//    whatever had it before the modal opened.

import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { isTopModal, popModal, pushModal } from "../lib/modalStack";

const FOCUSABLE =
  "button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), " +
  "textarea:not(:disabled), summary, [tabindex]:not([tabindex='-1'])";

interface ModalProps {
  /** Visible heading; also the dialog's accessible name. */
  title: string;
  /** Esc (and the caller's Cancel button) — must not change anything. */
  onCancel: () => void;
  /** Return activates the default action (not inside a textarea). */
  onEnter?: () => void;
  role?: "dialog" | "alertdialog";
  /** Extra class on the dialog surface (e.g. "sheet"). */
  className?: string;
  /** id of the element describing the dialog (aria-describedby). */
  describedBy?: string;
  children: ReactNode;
}

function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => !el.closest("details:not([open]) > :not(summary)"),
  );
}

export function Modal({
  title,
  onCancel,
  onEnter,
  role = "dialog",
  className,
  describedBy,
  children,
}: ModalProps) {
  const titleId = useId();
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  // Captured during the first render — before any autoFocus child steals
  // focus at commit — so it is the control that opened the modal.
  const [returnFocus] = useState<Element | null>(() =>
    typeof document === "undefined" ? null : document.activeElement,
  );
  const idRef = useRef<number | null>(null);
  const handlersRef = useRef({ onCancel, onEnter });
  handlersRef.current = { onCancel, onEnter };

  useEffect(() => {
    const id = pushModal();
    idRef.current = id;
    const surface = surfaceRef.current;
    if (surface !== null && !surface.contains(document.activeElement)) {
      const preferred =
        surface.querySelector<HTMLElement>("[data-autofocus]") ??
        focusables(surface)[0] ??
        surface;
      preferred.focus();
    }
    return () => {
      popModal(id);
      idRef.current = null;
      if (returnFocus instanceof HTMLElement && returnFocus.isConnected) {
        returnFocus.focus();
      }
    };
  }, [returnFocus]);

  // Esc works wherever focus sits (it may be outside after a click on the
  // overlay); only the topmost modal answers.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const id = idRef.current;
      if (id === null || !isTopModal(id)) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        handlersRef.current.onCancel();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const id = idRef.current;
    if (id === null || !isTopModal(id)) return;
    const surface = surfaceRef.current;
    if (surface === null) return;
    if (event.key === "Tab") {
      const items = focusables(surface);
      if (items.length === 0) {
        event.preventDefault();
        surface.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !surface.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !surface.contains(active))) {
        event.preventDefault();
        first.focus();
      }
      return;
    }
    const onEnterHandler = handlersRef.current.onEnter;
    if (
      event.key === "Enter" &&
      onEnterHandler !== undefined &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey &&
      !event.shiftKey &&
      !(event.target instanceof HTMLTextAreaElement)
    ) {
      event.preventDefault();
      onEnterHandler();
    }
  };

  return (
    <div className="modal-overlay">
      <div
        ref={surfaceRef}
        className={className === undefined ? "modal" : `modal ${className}`}
        role={role}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={describedBy}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
      >
        <h2 className="modal-title" id={titleId}>
          {title}
        </h2>
        {children}
      </div>
    </div>
  );
}
