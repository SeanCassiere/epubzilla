// Chapter-switch loading indicator (issue #56).
//
// Chapter reads normally resolve in ~1ms, so the "Loading chapter…" status
// flashing on every switch read as flicker. The reader now keeps the
// previous chapter rendered while the next loads and only shows the
// indicator when a load is still pending after LOADING_INDICATOR_DELAY_MS
// (delayed-spinner pattern). Same harness as m1.test.tsx — the real <App/>
// over mocked Tauri IPC serving snapshotted core fixtures — plus fake
// timers, since the behavior under test is purely time-based.

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { clearMocks, mockConvertFileSrc, mockIPC } from "@tauri-apps/api/mocks";
import App from "../App";
import { LOADING_INDICATOR_DELAY_MS } from "../components/ReaderPane";
import { epub3Fixture, type Fixture } from "./fixtures";

/** A promise resolvable from the test body (gates one read_chapter call). */
interface Gate {
  promise: Promise<void>;
  open: () => void;
}

function gate(): Gate {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

/**
 * mockIPC backend serving one fixture. `holds` maps a spine resource id to
 * a Gate: read_chapter for that id stays pending until the gate is opened
 * (ungated reads resolve immediately, like the ~1ms real core read).
 */
function mockBackend(fixture: Fixture, holds: Record<string, Gate> = {}): void {
  mockConvertFileSrc("linux");
  mockIPC((cmd, payload) => {
    const args = (payload ?? {}) as Record<string, unknown>;
    switch (cmd) {
      case "plugin:dialog|open":
        return `/fixtures/${fixture.book.id}.epub`;
      case "open_book":
        return fixture.book;
      case "read_chapter": {
        const id = args.resourceId as string;
        const chapter = fixture.chapters[id];
        if (chapter === undefined) {
          throw { kind: "ResourceNotFound", id };
        }
        const hold = holds[id];
        return hold === undefined ? chapter : hold.promise.then(() => chapter);
      }
      case "close_book":
        return undefined;
      default:
        throw { kind: "Io", message: `unexpected command ${cmd}` };
    }
  });
}

/** Drain the microtask queue inside act (settles mocked-IPC promise chains). */
const flush = () => act(async () => {});

/** Advance fake timers by `ms` inside act. */
const elapse = (ms: number) =>
  act(() => {
    vi.advanceTimersByTime(ms);
  });

const indicator = () => screen.queryByText("Loading chapter…");

function chapterSrcdoc(): string {
  const srcdoc = screen
    .getByTitle("Chapter content")
    .getAttribute("srcdoc");
  expect(srcdoc).not.toBeNull();
  return srcdoc as string;
}

/** Open the epub3 fixture and settle on its first chapter. */
async function openBook(): Promise<void> {
  render(<App />);
  fireEvent.click(screen.getByRole("button", { name: "Open book…" }));
  await flush();
  screen.getByText("chapter 1 of 3");
}

beforeAll(() => {
  // jsdom implements neither; the reader uses both for scroll positioning.
  window.HTMLElement.prototype.scrollIntoView = () => undefined;
  Object.defineProperty(window, "scrollTo", { value: () => undefined });
});

afterEach(() => {
  cleanup();
  clearMocks();
  vi.useRealTimers();
});

describe("chapter-switch loading indicator (issue #56)", () => {
  it("rapid next/next/prev over immediately-resolving IPC never shows the indicator", async () => {
    vi.useFakeTimers();
    mockBackend(epub3Fixture());
    await openBook();
    expect(indicator()).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Next →" }));
    expect(indicator()).toBeNull();
    await flush();
    screen.getByText("chapter 2 of 3");
    expect(indicator()).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Next →" }));
    await flush();
    screen.getByText("chapter 3 of 3");
    expect(indicator()).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "← Previous" }));
    await flush();
    screen.getByText("chapter 2 of 3");
    expect(indicator()).toBeNull();

    // Every switch resolved before the delay: all timers were cleared, so
    // running out the clock must not surface a stale indicator.
    act(() => {
      vi.runAllTimers();
    });
    expect(indicator()).toBeNull();
  });

  it("keeps the previous chapter rendered and shows the indicator only after the delay", async () => {
    vi.useFakeTimers();
    const ch2 = gate();
    mockBackend(epub3Fixture(), { ch2 });
    await openBook();

    fireEvent.click(screen.getByRole("button", { name: "Next →" }));
    await flush();
    // Load pending, delay not yet elapsed: no indicator, and the previous
    // chapter is still rendered (nothing unmounted or cleared).
    expect(indicator()).toBeNull();
    expect(chapterSrcdoc()).toContain("<title>Chapter 1</title>");
    screen.getByText("chapter 1 of 3");

    // The delay elapses with the load still pending: indicator appears,
    // previous chapter STAYS rendered underneath it.
    await elapse(LOADING_INDICATOR_DELAY_MS);
    expect(indicator()).not.toBeNull();
    expect(chapterSrcdoc()).toContain("<title>Chapter 1</title>");

    // Resolve: indicator goes away, new chapter renders.
    ch2.open();
    await flush();
    expect(indicator()).toBeNull();
    expect(chapterSrcdoc()).toContain("<title>Chapter 2</title>");
    screen.getByText("chapter 2 of 3");
  });

  it("restarts the delay for each new load: only the latest load counts", async () => {
    vi.useFakeTimers();
    const ch2 = gate();
    const ch3 = gate();
    mockBackend(epub3Fixture(), { ch2, ch3 });
    await openBook();

    // First switch: resolves just before the delay elapses.
    fireEvent.click(screen.getByRole("button", { name: "Next →" }));
    await flush();
    await elapse(LOADING_INDICATOR_DELAY_MS - 50);
    expect(indicator()).toBeNull();
    ch2.open();
    await flush();
    screen.getByText("chapter 2 of 3");
    expect(indicator()).toBeNull();

    // Second switch begins immediately (via the TOC — Next is disabled
    // only while a load is in flight). Its delay starts from zero: 100ms
    // in (200ms since the first switch) there is still no indicator...
    fireEvent.click(screen.getByRole("button", { name: "Chapter 3" }));
    await flush();
    await elapse(LOADING_INDICATOR_DELAY_MS - 50);
    expect(indicator()).toBeNull();

    // ...and it appears once THIS load outlasts the full delay.
    await elapse(50);
    expect(indicator()).not.toBeNull();
    ch3.open();
    await flush();
    expect(indicator()).toBeNull();
    screen.getByText("chapter 3 of 3");
  });
});
