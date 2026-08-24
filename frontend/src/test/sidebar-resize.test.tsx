// Resizable sidebar tests (issue #61, Stage 3).
//
// The divider is a focusable separator between the sidebar and the content
// column: dragging (pointer events) and arrow keys change the width, which
// lives as --sidebar-width on the shell and persists in localStorage;
// double-click resets to the default. jsdom has no pointer capture, so the
// handle calls setPointerCapture optionally and the drag is simulated with
// plain pointer events on the handle itself.

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { clearMocks, mockConvertFileSrc, mockIPC } from "@tauri-apps/api/mocks";
import App from "../App";
import { epub3Fixture, type Fixture } from "./fixtures";
import {
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_RESIZE_STEP,
  SIDEBAR_WIDTH_KEY,
} from "../lib/sidebarWidth";

const fixturePath = (f: Fixture) => `/fixtures/${f.book.id}.epub`;

function mockBackend(fixtures: Fixture[]): void {
  const queue = [...fixtures];
  const byPath = new Map(fixtures.map((f) => [fixturePath(f), f]));
  const open = new Map<string, Fixture>();

  mockConvertFileSrc("linux");
  mockIPC((cmd, payload) => {
    const args = (payload ?? {}) as Record<string, unknown>;
    switch (cmd) {
      case "plugin:dialog|open": {
        const next = queue.shift();
        return next === undefined ? null : fixturePath(next);
      }
      case "open_book": {
        const fixture = byPath.get(args.path as string);
        if (fixture === undefined) {
          throw { kind: "Io", message: `no fixture at ${String(args.path)}` };
        }
        open.set(fixture.book.id, fixture);
        return fixture.book;
      }
      case "read_chapter": {
        const chapter = open
          .get(args.bookId as string)
          ?.chapters[args.resourceId as string];
        if (chapter === undefined) {
          throw { kind: "ResourceNotFound", id: String(args.resourceId) };
        }
        return chapter;
      }
      case "close_book":
        return undefined;
      default:
        throw { kind: "Io", message: `unexpected command ${cmd}` };
    }
  });
}

afterEach(() => {
  cleanup();
  clearMocks();
  localStorage.removeItem(SIDEBAR_WIDTH_KEY);
});

async function openBook(): Promise<void> {
  mockBackend([epub3Fixture()]);
  render(<App />);
  fireEvent.click(screen.getByRole("button", { name: "Open book…" }));
  await screen.findByRole("complementary", { name: "Table of contents" });
}

const handle = () => screen.getByRole("separator", { name: "Resize sidebar" });
const shellWidth = () =>
  document
    .querySelector<HTMLElement>(".app-shell")!
    .style.getPropertyValue("--sidebar-width");

describe("resizable sidebar", () => {
  it("renders the separator only when a book is open, at the default width", async () => {
    mockBackend([]);
    render(<App />);
    expect(screen.queryByRole("separator", { name: "Resize sidebar" })).toBe(
      null,
    );
    cleanup();
    clearMocks();

    await openBook();
    expect(handle().getAttribute("aria-valuenow")).toBe(
      String(SIDEBAR_DEFAULT_WIDTH),
    );
    expect(shellWidth()).toBe(`${SIDEBAR_DEFAULT_WIDTH}px`);
  });

  it("drags to a new width, clamps it, and persists on release", async () => {
    await openBook();
    const el = handle();
    fireEvent.pointerDown(el, { button: 0, pointerId: 1, clientX: 272 });
    fireEvent.pointerMove(el, { pointerId: 1, clientX: 372 });
    expect(shellWidth()).toBe(`${SIDEBAR_DEFAULT_WIDTH + 100}px`);
    expect(document.body.classList.contains("sidebar-resizing")).toBe(true);

    // Way past the max: clamped.
    fireEvent.pointerMove(el, { pointerId: 1, clientX: 5000 });
    expect(shellWidth()).toBe(`${SIDEBAR_MAX_WIDTH}px`);

    fireEvent.pointerUp(el, { pointerId: 1, clientX: 5000 });
    expect(document.body.classList.contains("sidebar-resizing")).toBe(false);
    expect(localStorage.getItem(SIDEBAR_WIDTH_KEY)).toBe(
      String(SIDEBAR_MAX_WIDTH),
    );
  });

  it("resizes with arrow keys and resets on double-click", async () => {
    await openBook();
    const el = handle();
    fireEvent.keyDown(el, { key: "ArrowRight" });
    expect(shellWidth()).toBe(
      `${SIDEBAR_DEFAULT_WIDTH + SIDEBAR_RESIZE_STEP}px`,
    );
    expect(localStorage.getItem(SIDEBAR_WIDTH_KEY)).toBe(
      String(SIDEBAR_DEFAULT_WIDTH + SIDEBAR_RESIZE_STEP),
    );

    fireEvent.doubleClick(el);
    expect(shellWidth()).toBe(`${SIDEBAR_DEFAULT_WIDTH}px`);
    expect(localStorage.getItem(SIDEBAR_WIDTH_KEY)).toBe(null);
  });

  it("restores a persisted width on mount", async () => {
    localStorage.setItem(SIDEBAR_WIDTH_KEY, "321");
    await openBook();
    expect(shellWidth()).toBe("321px");
    expect(handle().getAttribute("aria-valuenow")).toBe("321");
  });
});
