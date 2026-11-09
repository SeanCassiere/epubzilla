// Adapter tests for the native lifecycle plumbing, against Tauri's own
// IPC/event mocks: shell events (Finder / Open Recent, Quit, recents),
// webview file drag-drop, the window title, and the modal registry. These
// stand in for on-device verification of the wiring on the JS side; the
// Rust side is covered by crates/app unit tests.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearMocks, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";
import {
  onOpenFiles,
  onQuitRequested,
  onRecentBooksChanged,
} from "./shellEvents";
import { onFileDragDrop, type FileDragEvent } from "./dragDrop";
import { setWindowTitle } from "./window";
import {
  anyModalOpen,
  isTopModal,
  popModal,
  pushModal,
  subscribeModals,
} from "./modalStack";

const invoked: Array<{ cmd: string; args: unknown }> = [];

beforeEach(() => {
  invoked.length = 0;
  mockWindows("main");
  mockIPC(
    (cmd, args) => {
      invoked.push({ cmd, args });
      return undefined;
    },
    { shouldMockEvents: true },
  );
});

afterEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  clearMocks();
});

describe("shell events", () => {
  it("delivers open-files payloads and tolerates bad payloads", async () => {
    const seen: string[][] = [];
    const stop = await onOpenFiles((paths) => seen.push(paths));
    await emit("open-files", ["/Livros/Café.epub"]);
    await emit("open-files", "not-an-array");
    expect(seen).toEqual([["/Livros/Café.epub"], []]);
    stop();
  });

  it("delivers quit requests and recents changes", async () => {
    let quits = 0;
    const lists: string[][] = [];
    const stopQuit = await onQuitRequested(() => {
      quits += 1;
    });
    const stopRecents = await onRecentBooksChanged((list) => lists.push(list));
    await emit("app-quit-requested");
    await emit("recent-books-changed", ["/a.epub"]);
    expect(quits).toBe(1);
    expect(lists).toEqual([["/a.epub"]]);
    stopQuit();
    stopRecents();
  });

  it("is a no-op outside Tauri", async () => {
    clearMocks();
    const stop = await onOpenFiles(() => undefined);
    expect(typeof stop).toBe("function");
  });
});

describe("file drag-drop adapter", () => {
  it("maps webview drag events to the app's shape", async () => {
    const seen: FileDragEvent[] = [];
    const stop = await onFileDragDrop((event) => seen.push(event));
    const position = { x: 1, y: 2 };
    await emit("tauri://drag-enter", { paths: ["/b.epub"], position });
    await emit("tauri://drag-over", { position });
    await emit("tauri://drag-drop", { paths: ["/b.epub", "/c.png"], position });
    await emit("tauri://drag-leave", null);
    expect(seen).toEqual([
      { type: "enter", paths: ["/b.epub"] },
      { type: "over" },
      { type: "drop", paths: ["/b.epub", "/c.png"] },
      { type: "leave" },
    ]);
    stop();
  });
});

describe("setWindowTitle", () => {
  it("sets the native title through the window plugin", async () => {
    await setWindowTitle("Minha História");
    expect(invoked).toContainEqual({
      cmd: "plugin:window|set_title",
      args: { label: "main", value: "Minha História" },
    });
  });
});

describe("modal registry", () => {
  it("tracks the topmost modal and notifies subscribers", () => {
    let notified = 0;
    const stop = subscribeModals(() => {
      notified += 1;
    });
    expect(anyModalOpen()).toBe(false);
    const a = pushModal();
    const b = pushModal();
    expect(isTopModal(b)).toBe(true);
    expect(isTopModal(a)).toBe(false);
    popModal(b);
    expect(isTopModal(a)).toBe(true);
    popModal(a);
    popModal(a);
    expect(anyModalOpen()).toBe(false);
    expect(notified).toBe(4);
    stop();
  });
});
