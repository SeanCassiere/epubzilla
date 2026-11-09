// Drop target shown while an .epub is dragged over the window.

import { useLifecycle } from "../state/lifecycle";

export function DropOverlay() {
  const { dropActive } = useLifecycle();
  if (!dropActive) return null;
  return (
    <div className="drop-overlay" aria-hidden="true">
      <p className="drop-overlay-label">Drop to open the EPUB</p>
    </div>
  );
}
