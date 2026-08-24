// Sidebar scroll behaviour tests (issue #89).
//
// Rule under test (documented in lib/sidebarScroll.ts):
// 1. Contents and Chapters keep independent scroll offsets across sidebar
//    tab switches (Sidebar saves/restores scrollTop around the remount).
// 2. A panel never scrolls on clicks or (re)mounts; it scrolls only when
//    the current chapter CHANGES and its row is outside the panel's
//    visible viewport — minimally, scrollIntoView({ block: "nearest" }) —
//    identically in both panels.
//
// jsdom has no layout, so geometry is simulated: getBoundingClientRect is
// backed by a per-element rect map (default 0-height rect at 0, which the
// visibility check counts as "inside"), and scrollIntoView is a spy.

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { clearMocks, mockConvertFileSrc, mockIPC } from "@tauri-apps/api/mocks";
import App from "../App";
import { epub3Fixture, type Fixture } from "./fixtures";
import { isFullyVisible } from "../lib/sidebarScroll";

const fixturePath = (f: Fixture) => `/fixtures/${f.book.id}.epub`;

/** Minimal mock backend: open via dialog + read chapters. */
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

// ---- simulated geometry -------------------------------------------------

const domRect = (top: number, bottom: number): DOMRect =>
  ({
    top,
    bottom,
    left: 0,
    right: 200,
    width: 200,
    height: bottom - top,
    x: 0,
    y: top,
    toJSON: () => ({}),
  }) as DOMRect;

/** Per-element rects; elements not in the map get a 0-height rect at 0. */
const rects = new Map<Element, DOMRect>();
let scrollSpy: ReturnType<
  typeof vi.fn<(arg?: boolean | ScrollIntoViewOptions) => void>
>;

beforeAll(() => {
  Object.defineProperty(window, "scrollTo", { value: () => undefined });
  vi.spyOn(
    window.HTMLElement.prototype,
    "getBoundingClientRect",
  ).mockImplementation(function (this: HTMLElement) {
    return rects.get(this) ?? domRect(0, 0);
  });
});

beforeEach(() => {
  rects.clear();
  scrollSpy = vi.fn<(arg?: boolean | ScrollIntoViewOptions) => void>();
  window.HTMLElement.prototype.scrollIntoView = scrollSpy;
});

afterEach(() => {
  cleanup();
  clearMocks();
});

/** scrollIntoView calls whose receiver sits inside the given panel. */
const panelScrolls = (panel: HTMLElement) =>
  scrollSpy.mock.contexts.filter(
    (el) => el instanceof HTMLElement && panel.contains(el),
  );

// ---- harness ------------------------------------------------------------

async function openBook(): Promise<void> {
  mockBackend([epub3Fixture()]);
  render(<App />);
  fireEvent.click(screen.getByRole("button", { name: "Open book…" }));
  await screen.findByRole("complementary", { name: "Table of contents" });
}

const contentsPanel = () =>
  screen.getByRole("complementary", { name: "Table of contents" });
const chaptersPanel = () =>
  screen.getByRole("complementary", { name: "Chapters" });
const switchTab = (name: string) =>
  fireEvent.click(screen.getByRole("tab", { name }));

/** The `.toc-row` around the entry button with this accessible name. */
function rowOf(panel: HTMLElement, name: string): HTMLElement {
  const row = within(panel)
    .getByRole("button", { name })
    .closest<HTMLElement>(".toc-row");
  if (row === null) throw new Error(`no .toc-row for ${name}`);
  return row;
}

async function waitForCurrent(panel: HTMLElement, name: string): Promise<void> {
  await waitFor(() =>
    expect(rowOf(panel, name).className).toContain("toc-current"),
  );
}

// ---- tests --------------------------------------------------------------

describe("isFullyVisible", () => {
  const fake = (top: number, bottom: number): Element =>
    ({ getBoundingClientRect: () => domRect(top, bottom) }) as Element;

  it("is true only when the item is entirely inside the container", () => {
    const container = fake(0, 400);
    expect(isFullyVisible(container, fake(0, 20))).toBe(true); // top edge
    expect(isFullyVisible(container, fake(380, 400))).toBe(true); // bottom edge
    expect(isFullyVisible(container, fake(-10, 10))).toBe(false); // above
    expect(isFullyVisible(container, fake(390, 410))).toBe(false); // below
    expect(isFullyVisible(container, fake(500, 520))).toBe(false); // far below
  });
});

describe("independent scroll offsets across tab switches", () => {
  it("restores each panel's own offset and never auto-scrolls on remount", async () => {
    await openBook();

    // Scroll Contents, switch away, scroll Chapters, and bounce back.
    contentsPanel().scrollTop = 120;
    switchTab("Chapters");
    chaptersPanel().scrollTop = 260;
    switchTab("Contents");
    expect(contentsPanel().scrollTop).toBe(120);
    switchTab("Chapters");
    expect(chaptersPanel().scrollTop).toBe(260);
    switchTab("Contents");
    expect(contentsPanel().scrollTop).toBe(120);

    // Remounts must not re-center on the current chapter.
    expect(scrollSpy).not.toHaveBeenCalled();
  });
});

describe("clicks on visible entries preserve the offset", () => {
  it("Contents: top- and bottom-edge visible clicks do not reposition", async () => {
    await openBook();
    const panel = contentsPanel();
    panel.scrollTop = 50;
    rects.set(panel, domRect(0, 400));

    // "Chapter 3" fully visible at the bottom edge of the viewport.
    rects.set(rowOf(panel, "Chapter 3"), domRect(380, 400));
    fireEvent.click(within(panel).getByRole("button", { name: "Chapter 3" }));
    await waitForCurrent(panel, "Chapter 3");
    expect(panelScrolls(panel)).toHaveLength(0);
    expect(panel.scrollTop).toBe(50);

    // "Chapter 1 — Ünïcode" fully visible at the top edge.
    rects.set(rowOf(panel, "Chapter 1 — Ünïcode"), domRect(0, 20));
    fireEvent.click(
      within(panel).getByRole("button", { name: "Chapter 1 — Ünïcode" }),
    );
    await waitForCurrent(panel, "Chapter 1 — Ünïcode");
    expect(panelScrolls(panel)).toHaveLength(0);
    expect(panel.scrollTop).toBe(50);
  });

  it("Chapters: top- and bottom-edge visible clicks do not reposition", async () => {
    await openBook();
    switchTab("Chapters");
    const panel = chaptersPanel();
    panel.scrollTop = 40;
    rects.set(panel, domRect(0, 400));

    rects.set(rowOf(panel, "Chapter 3"), domRect(380, 400)); // bottom edge
    fireEvent.click(within(panel).getByRole("button", { name: "Chapter 3" }));
    await waitForCurrent(panel, "Chapter 3");
    expect(panelScrolls(panel)).toHaveLength(0);
    expect(panel.scrollTop).toBe(40);

    rects.set(rowOf(panel, "Chapter 1 — Ünïcode"), domRect(0, 20)); // top edge
    fireEvent.click(
      within(panel).getByRole("button", { name: "Chapter 1 — Ünïcode" }),
    );
    await waitForCurrent(panel, "Chapter 1 — Ünïcode");
    expect(panelScrolls(panel)).toHaveLength(0);
    expect(panel.scrollTop).toBe(40);
  });
});

describe("crossing the visible viewport boundary", () => {
  it("Contents: Next past the viewport edge scrolls the row in minimally", async () => {
    await openBook();
    const panel = contentsPanel();
    rects.set(panel, domRect(0, 400));

    // Current is Chapter 1; Next lands on Chapter 2, whose row sits just
    // below the visible viewport.
    rects.set(rowOf(panel, "Chapter 2"), domRect(410, 430));
    fireEvent.click(screen.getByRole("button", { name: /Next/ }));
    await waitForCurrent(panel, "Chapter 2");
    await waitFor(() => expect(panelScrolls(panel)).toHaveLength(1));
    expect(scrollSpy).toHaveBeenCalledWith({ block: "nearest" });
    expect(panelScrolls(panel)[0]).toBe(rowOf(panel, "Chapter 2"));
  });

  it("Chapters: navigation to an off-viewport chapter scrolls identically", async () => {
    await openBook();
    switchTab("Chapters");
    const panel = chaptersPanel();
    rects.set(panel, domRect(0, 400));

    rects.set(rowOf(panel, "Chapter 3"), domRect(500, 520)); // below viewport
    fireEvent.click(within(panel).getByRole("button", { name: "Chapter 3" }));
    await waitForCurrent(panel, "Chapter 3");
    await waitFor(() => expect(panelScrolls(panel)).toHaveLength(1));
    expect(scrollSpy).toHaveBeenCalledWith({ block: "nearest" });
    expect(panelScrolls(panel)[0]).toBe(rowOf(panel, "Chapter 3"));
  });

  it("Chapters: Next past the viewport edge scrolls the new current row in", async () => {
    await openBook();
    switchTab("Chapters");
    const panel = chaptersPanel();
    rects.set(panel, domRect(0, 400));

    rects.set(rowOf(panel, "Chapter 2"), domRect(410, 430));
    fireEvent.click(screen.getByRole("button", { name: /Next/ }));
    await waitForCurrent(panel, "Chapter 2");
    await waitFor(() => expect(panelScrolls(panel)).toHaveLength(1));
    expect(panelScrolls(panel)[0]).toBe(rowOf(panel, "Chapter 2"));
  });
});

describe("whole-book bounds", () => {
  it("first and last entries stay reachable, with minimal movement only when off-viewport", async () => {
    await openBook();
    switchTab("Chapters");
    const panel = chaptersPanel();
    rects.set(panel, domRect(0, 400));

    // Jump to the last spine entry ("Notes"), below the viewport: scrolls.
    rects.set(rowOf(panel, "Notes"), domRect(500, 520));
    fireEvent.click(within(panel).getByRole("button", { name: "Notes" }));
    await waitForCurrent(panel, "Notes");
    await waitFor(() => expect(panelScrolls(panel)).toHaveLength(1));

    // Back to the first entry, above the viewport: scrolls again.
    rects.set(rowOf(panel, "Chapter 1 — Ünïcode"), domRect(-40, -20));
    fireEvent.click(
      within(panel).getByRole("button", { name: "Chapter 1 — Ünïcode" }),
    );
    await waitForCurrent(panel, "Chapter 1 — Ünïcode");
    await waitFor(() => expect(panelScrolls(panel)).toHaveLength(2));

    // Once visible at the extremes, re-clicking them never moves the panel.
    rects.set(rowOf(panel, "Chapter 1 — Ünïcode"), domRect(0, 20));
    fireEvent.click(
      within(panel).getByRole("button", { name: "Chapter 1 — Ünïcode" }),
    );
    expect(panelScrolls(panel)).toHaveLength(2);
  });
});
