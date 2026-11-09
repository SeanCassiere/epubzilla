// OS file drag-and-drop onto the window (Tauri webview drag-drop events).
// Adapter module: the only place that may import `@tauri-apps/api/webview`.
//
// Tauri reports native file drags with their OS paths (HTML5 drag events
// never carry paths). The app uses them to open a dropped `.epub` through
// the guarded lifecycle controller; image drops into the chapter editor
// keep going through the editor's own HTML5 handlers.

import { getCurrentWebview } from "@tauri-apps/api/webview";

/** The slice of Tauri's DragDropEvent the app reads. */
export type FileDragEvent =
  | { type: "enter"; paths: string[] }
  | { type: "over" }
  | { type: "drop"; paths: string[] }
  | { type: "leave" };

/**
 * Subscribe to native file drags over the window. Best-effort: outside a
 * real Tauri window this resolves to a no-op unlisten.
 */
export async function onFileDragDrop(
  handler: (event: FileDragEvent) => void,
): Promise<() => void> {
  try {
    return await getCurrentWebview().onDragDropEvent((event) => {
      const payload = event.payload;
      switch (payload.type) {
        case "enter":
          handler({ type: "enter", paths: payload.paths });
          break;
        case "over":
          handler({ type: "over" });
          break;
        case "drop":
          handler({ type: "drop", paths: payload.paths });
          break;
        case "leave":
          handler({ type: "leave" });
          break;
        default:
          break;
      }
    });
  } catch {
    return () => undefined;
  }
}
