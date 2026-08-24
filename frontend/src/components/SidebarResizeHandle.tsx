import { useRef } from "react";
import {
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  SIDEBAR_RESIZE_STEP,
  SIDEBAR_WIDTH_KEY,
  clampSidebarWidth,
} from "../lib/sidebarWidth";

/**
 * Draggable divider between the sidebar and the content column (issue #61,
 * Stage 3). A hand-rolled pointer-capture handle: pointer capture keeps
 * the drag alive when the cursor leaves the 9px hit area (or crosses the
 * reader iframe — captured moves are retargeted to this element, and the
 * frame's pointer events are cut during the drag as a belt-and-braces).
 *
 * Constraints from the issue: the handle must NOT sit inside a
 * data-tauri-drag-region (a drag would move the window instead), and it
 * sits well inboard of the window edge so the OS resize zone can't steal
 * the gesture. Keyboard: it is a focusable separator — arrow keys nudge,
 * Home/End jump to the bounds, double-click resets to the default.
 */
export function SidebarResizeHandle({
  width,
  onResize,
}: {
  width: number;
  onResize: (width: number) => void;
}) {
  const dragRef = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null);

  const persist = (value: number) => {
    try {
      localStorage.setItem(SIDEBAR_WIDTH_KEY, String(value));
    } catch {
      // Persistence is best-effort; resizing still works for the session.
    }
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: width,
    };
    // Optional call: jsdom (vitest) has no pointer capture.
    event.currentTarget.setPointerCapture?.(event.pointerId);
    document.body.classList.add("sidebar-resizing");
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (drag === null || event.pointerId !== drag.pointerId) return;
    onResize(clampSidebarWidth(drag.startWidth + event.clientX - drag.startX));
  };

  const endDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (drag === null || event.pointerId !== drag.pointerId) return;
    dragRef.current = null;
    document.body.classList.remove("sidebar-resizing");
    persist(clampSidebarWidth(drag.startWidth + event.clientX - drag.startX));
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    let next: number | null = null;
    if (event.key === "ArrowLeft") next = width - SIDEBAR_RESIZE_STEP;
    else if (event.key === "ArrowRight") next = width + SIDEBAR_RESIZE_STEP;
    else if (event.key === "Home") next = SIDEBAR_MIN_WIDTH;
    else if (event.key === "End") next = SIDEBAR_MAX_WIDTH;
    if (next === null) return;
    event.preventDefault();
    const clamped = clampSidebarWidth(next);
    onResize(clamped);
    persist(clamped);
  };

  const reset = () => {
    onResize(SIDEBAR_DEFAULT_WIDTH);
    try {
      localStorage.removeItem(SIDEBAR_WIDTH_KEY);
    } catch {
      // best-effort
    }
  };

  return (
    <div
      className="sidebar-resize-handle"
      role="separator"
      aria-label="Resize sidebar"
      aria-orientation="vertical"
      aria-valuenow={width}
      aria-valuemin={SIDEBAR_MIN_WIDTH}
      aria-valuemax={SIDEBAR_MAX_WIDTH}
      tabIndex={0}
      title="Drag to resize the sidebar (double-click to reset)"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={handleKeyDown}
      onDoubleClick={reset}
    />
  );
}
