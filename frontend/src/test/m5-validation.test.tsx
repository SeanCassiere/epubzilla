// Validation panel component tests (issue #72): the sidebar "Checks" tab
// surfacing the core's native `validate` subset (ADR-0003).
//
// Same harness pattern as m2-save.test.tsx: the REAL <App/> against mocked
// Tauri IPC, with queue-driven dialog doubles. The `validate` command is
// queue-driven too: tests push the findings the "core" reports next.

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { clearMocks, mockConvertFileSrc, mockIPC } from "@tauri-apps/api/mocks";
import type { Book } from "@bindings/Book";
import type { Metadata } from "@bindings/Metadata";
import type { ValidationIssue } from "@bindings/ValidationIssue";
import App from "../App";
import { epub3Fixture, type Fixture } from "./fixtures";

const openPicks: Array<string | null> = [];

vi.mock("../lib/dialog", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/dialog")>();
  return {
    ...actual,
    pickEpubFile: vi.fn(async () => openPicks.shift() ?? null),
    pickSaveEpubPath: vi.fn(async () => null),
  };
});

interface InvokeCall {
  cmd: string;
  args: Record<string, unknown>;
}

const fixturePath = (f: Fixture) => `/fixtures/${f.book.id}.epub`;

/** epub3 fixture with `source` set, as if opened from disk. */
function savedEpub3Fixture(): Fixture {
  const fixture = epub3Fixture();
  return {
    ...fixture,
    book: { ...fixture.book, source: "/books/epubzilla.epub" },
  };
}

/** Findings the mocked `validate` command reports, in call order. */
const validatePicks: ValidationIssue[][] = [];

/**
 * Mock backend: open/read/save/update plus a queue-driven `validate`
 * (empty findings when the queue runs dry — a clean book).
 */
function mockBackend(fixtures: Fixture[]): InvokeCall[] {
  const calls: InvokeCall[] = [];
  const byPath = new Map(fixtures.map((f) => [fixturePath(f), f]));
  const open = new Map<string, Fixture>();

  mockConvertFileSrc("linux");
  mockIPC((cmd, payload) => {
    const args = (payload ?? {}) as Record<string, unknown>;
    calls.push({ cmd, args });

    const current = () => {
      const fixture = open.get(args.bookId as string);
      if (fixture === undefined) {
        throw { kind: "Io", message: "unknown book" };
      }
      return fixture;
    };

    switch (cmd) {
      case "open_book": {
        const fixture = byPath.get(args.path as string);
        if (fixture === undefined) {
          throw { kind: "Io", message: `no fixture at ${String(args.path)}` };
        }
        open.set(fixture.book.id, fixture);
        return fixture.book;
      }
      case "read_chapter": {
        const chapter = current().chapters[args.resourceId as string];
        if (chapter === undefined) {
          throw { kind: "ResourceNotFound", id: String(args.resourceId) };
        }
        return chapter;
      }
      case "save_book": {
        const fixture = current();
        const path = (args.path as string | null) ?? fixture.book.source;
        if (path === null) {
          throw { kind: "Io", message: "path required for a sourceless book" };
        }
        const saved: Book = { ...fixture.book, dirty: false, source: path };
        open.set(saved.id, { ...fixture, book: saved });
        return saved;
      }
      case "update_metadata": {
        const fixture = current();
        const updated: Book = {
          ...fixture.book,
          metadata: args.metadata as Metadata,
          dirty: true,
        };
        open.set(updated.id, { ...fixture, book: updated });
        return updated;
      }
      case "validate":
        return validatePicks.shift() ?? [];
      case "close_book":
        return undefined;
      default:
        throw { kind: "Io", message: `unexpected command ${cmd}` };
    }
  });
  return calls;
}

const validateCalls = (calls: InvokeCall[]) =>
  calls.filter((c) => c.cmd === "validate");

async function openViaDialog(fixture: Fixture): Promise<void> {
  openPicks.push(fixturePath(fixture));
  fireEvent.click(screen.getByRole("button", { name: "Open book…" }));
  await screen.findByText(fixture.book.metadata.title);
}

/** Switch the sidebar to the Checks tab and return the panel element. */
async function openChecksTab(): Promise<HTMLElement> {
  fireEvent.click(screen.getByRole("tab", { name: "Checks" }));
  return screen.findByRole("complementary", { name: "Checks" });
}

const chapterIssue: ValidationIssue = {
  severity: "Error",
  location: "OEBPS/text/ch2.xhtml",
  message: 'resource "ch2" is not well-formed XML: mismatched tag',
};
const opfIssue: ValidationIssue = {
  severity: "Error",
  location: "OEBPS/content.opf",
  message: "missing required metadata: dc:title",
};
const nowhereIssue: ValidationIssue = {
  severity: "Warning",
  location: null,
  message: 'nav entry "Notes" targets "missing.xhtml"',
};

beforeAll(() => {
  window.HTMLElement.prototype.scrollIntoView = () => undefined;
  Object.defineProperty(window, "scrollTo", { value: () => undefined });
});

afterEach(() => {
  cleanup();
  clearMocks();
  openPicks.length = 0;
  validatePicks.length = 0;
});

describe("validation panel (issue #72)", () => {
  it("runs checks on demand and lists findings with severity and location", async () => {
    const calls = mockBackend([epub3Fixture()]);
    render(<App />);
    await openViaDialog(epub3Fixture());

    const panel = await openChecksTab();
    // Nothing runs until asked: the panel shows the not-checked hint.
    expect(within(panel).getByText(/Not checked yet/)).toBeTruthy();
    expect(validateCalls(calls)).toHaveLength(0);

    validatePicks.push([chapterIssue, opfIssue, nowhereIssue]);
    fireEvent.click(within(panel).getByRole("button", { name: "Run checks" }));

    await within(panel).findByText("2 errors, 1 warning");
    expect(validateCalls(calls)).toHaveLength(1);
    expect(within(panel).getAllByText("Error")).toHaveLength(2);
    expect(within(panel).getAllByText("Warning")).toHaveLength(1);
    expect(within(panel).getByText(chapterIssue.message)).toBeTruthy();
    expect(within(panel).getByText(opfIssue.message)).toBeTruthy();
    expect(within(panel).getByText(nowhereIssue.message)).toBeTruthy();

    // A spine-chapter location is a click-through button; the OPF is not.
    expect(
      within(panel).getByRole("button", { name: "ch2.xhtml" }),
    ).toBeTruthy();
    expect(
      within(panel).queryByRole("button", { name: "content.opf" }),
    ).toBeNull();
    expect(within(panel).getByText("content.opf")).toBeTruthy();
  });

  it("clicks through an issue location to the offending chapter", async () => {
    const calls = mockBackend([epub3Fixture()]);
    render(<App />);
    await openViaDialog(epub3Fixture());

    const panel = await openChecksTab();
    validatePicks.push([chapterIssue]);
    fireEvent.click(within(panel).getByRole("button", { name: "Run checks" }));
    fireEvent.click(
      await within(panel).findByRole("button", { name: "ch2.xhtml" }),
    );

    await waitFor(() => {
      const reads = calls.filter((c) => c.cmd === "read_chapter");
      expect(reads[reads.length - 1]?.args.resourceId).toBe("ch2");
    });
  });

  it("re-runs checks automatically after a save", async () => {
    const calls = mockBackend([savedEpub3Fixture()]);
    render(<App />);
    await openViaDialog(savedEpub3Fixture());

    const panel = await openChecksTab();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await within(panel).findByText("No issues found");
    expect(validateCalls(calls)).toHaveLength(1);
  });

  it("clears findings when the model changes so nothing stale shows", async () => {
    mockBackend([epub3Fixture()]);
    render(<App />);
    const fixture = epub3Fixture();
    await openViaDialog(fixture);

    const panel = await openChecksTab();
    validatePicks.push([chapterIssue]);
    fireEvent.click(within(panel).getByRole("button", { name: "Run checks" }));
    await within(panel).findByText("1 error");

    // A metadata edit changes the model; the old findings disappear.
    fireEvent.click(screen.getByRole("button", { name: "Edit metadata…" }));
    fireEvent.click(screen.getByRole("button", { name: "Save metadata" }));

    await within(panel).findByText(/Not checked yet/);
    expect(within(panel).queryByText(chapterIssue.message)).toBeNull();
  });
});
