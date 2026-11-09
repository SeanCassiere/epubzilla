// Book lifecycle UX standard (opening, creating, switching, closing):
// integration tests against the REAL <App/> over mocked Tauri IPC with
// event mocking on, so native entry points (menu, Open Recent / Finder,
// file drops, Quit, the red close button) are driven by emitting the same
// events the Rust shell / webview emit.
//
// Native dialogs go through the real lib/dialog wrappers; the plugin IPC
// (plugin:dialog|open / |save) answers from queues, and a queued Promise
// keeps a picker "open" for lock tests. Editors are mocked to textareas
// (m3-editing-ux pattern).

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import {
  clearMocks,
  mockConvertFileSrc,
  mockIPC,
  mockWindows,
} from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";
import type { Book } from "@bindings/Book";
import type { Metadata } from "@bindings/Metadata";
import App from "../App";
import { DEDUPE_WINDOW_MS } from "../lib/shortcuts";
import { epub2Fixture, epub3Fixture } from "./fixtures";

// The mocks honour `readOnly` like the real surfaces. fireEvent.change
// still reaches onChange on a read-only textarea, which is how tests make
// an edit "slip through" to exercise the revision re-check.
vi.mock("../components/CodeEditor", () => ({
  CodeEditor: ({
    value,
    onChange,
    readOnly,
  }: {
    value: string;
    onChange: (next: string) => void;
    readOnly?: boolean;
  }) => (
    <textarea
      aria-label="chapter buffer"
      value={value}
      readOnly={readOnly}
      onChange={(e) => onChange(e.target.value)}
    />
  ),
}));

vi.mock("../components/MilkdownEditor", () => ({
  MilkdownEditor: ({
    value,
    onChange,
    readOnly,
  }: {
    value: string;
    onChange: (next: string) => void;
    readOnly?: boolean;
  }) => (
    <textarea
      aria-label="chapter buffer"
      value={value}
      readOnly={readOnly}
      onChange={(e) => onChange(e.target.value)}
    />
  ),
}));

// ---- mock backend -----------------------------------------------------

interface InvokeCall {
  cmd: string;
  args: Record<string, unknown>;
}

type Pick = string | null | Promise<string | null>;

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface Backend {
  calls: InvokeCall[];
  openPicks: Pick[];
  savePicks: Pick[];
  recents: string[];
  pending: string[];
  /** open_book rejects for these paths. */
  openErrors: Map<string, unknown>;
  /** open_book waits on this when set (consumed once). */
  openGate: Promise<void> | null;
  /** read_chapter for this resource waits on the gate (consumed once). */
  chapterGate: { resourceId: string; gate: Promise<void> } | null;
  /** Every read_chapter takes this long (real IPC latency). */
  chapterDelayMs: number;
  /** save_book waits on this when set (consumed once). */
  saveGate: Promise<void> | null;
  /** update_metadata waits on this when set (consumed once). */
  metadataGate: Promise<void> | null;
  saveError: unknown;
  createError: unknown;
  /** Book served for opens; defaults to the EPUB 3 fixture. */
  fixture: "epub3" | "epub2";
}

const stem = (path: string) =>
  (path.split("/").pop() ?? path).replace(/\.epub$/i, "");
const titleFor = (path: string) => `Book ${stem(path)}`;

function mockBackend(): Backend {
  const backend: Backend = {
    calls: [],
    openPicks: [],
    savePicks: [],
    recents: [],
    pending: [],
    openErrors: new Map(),
    openGate: null,
    chapterGate: null,
    chapterDelayMs: 0,
    saveGate: null,
    metadataGate: null,
    saveError: null,
    createError: null,
    fixture: "epub3",
  };
  const books = new Map<string, Book>();
  let created = 0;

  mockConvertFileSrc("linux");
  mockWindows("main");
  mockIPC(
    async (cmd, payload) => {
      const args = (payload ?? {}) as Record<string, unknown>;
      backend.calls.push({ cmd, args });
      const fixture =
        backend.fixture === "epub2" ? epub2Fixture() : epub3Fixture();
      const current = () => {
        const book = books.get(args.bookId as string);
        if (book === undefined) throw { kind: "Io", message: "unknown book" };
        return book;
      };
      switch (cmd) {
        case "plugin:dialog|open":
          return (await backend.openPicks.shift()) ?? null;
        case "plugin:dialog|save":
          return (await backend.savePicks.shift()) ?? null;
        case "open_book": {
          const path = args.path as string;
          if (backend.openGate !== null) {
            const gate = backend.openGate;
            backend.openGate = null;
            await gate;
          }
          const error = backend.openErrors.get(path);
          if (error !== undefined) throw error;
          const book: Book = {
            ...fixture.book,
            id: `id:${path}`,
            source: path,
            dirty: false,
            metadata: { ...fixture.book.metadata, title: titleFor(path) },
          };
          books.set(book.id, book);
          return book;
        }
        case "create_book": {
          if (backend.createError !== null) throw backend.createError;
          created += 1;
          const metadata = args.metadata as Metadata;
          const book: Book = {
            ...epub3Fixture().book,
            id: `new-${created}`,
            source: null,
            dirty: true,
            metadata: { ...metadata, identifier: `urn:uuid:${created}` },
          };
          books.set(book.id, book);
          return book;
        }
        case "read_chapter": {
          const id = args.resourceId as string;
          const gate = backend.chapterGate;
          if (gate !== null && gate.resourceId === id) {
            backend.chapterGate = null;
            await gate.gate;
          }
          if (backend.chapterDelayMs > 0) {
            await new Promise((r) => setTimeout(r, backend.chapterDelayMs));
          }
          const source =
            args.prefer === "Markdown" ? fixture.markdown : fixture.chapters;
          const chapter = source[id] ?? fixture.chapters[id];
          if (chapter === undefined) {
            throw { kind: "ResourceNotFound", id };
          }
          return {
            ...chapter,
            content:
              args.prefer === "Markdown"
                ? chapter.content
                : chapter.content.replace(
                    "</body>",
                    `<p>served-for ${String(args.bookId)}</p></body>`,
                  ),
          };
        }
        case "update_metadata": {
          if (backend.metadataGate !== null) {
            const gate = backend.metadataGate;
            backend.metadataGate = null;
            await gate;
          }
          const book = {
            ...current(),
            metadata: args.metadata as Metadata,
            dirty: true,
          };
          books.set(book.id, book);
          return book;
        }
        case "write_chapter": {
          const book = { ...current(), dirty: true };
          books.set(book.id, book);
          return book;
        }
        case "save_book": {
          if (backend.saveGate !== null) {
            const gate = backend.saveGate;
            backend.saveGate = null;
            await gate;
          }
          if (backend.saveError !== null) throw backend.saveError;
          const before = current();
          const path = (args.path as string | null) ?? before.source;
          const book = { ...before, dirty: false, source: path };
          books.set(book.id, book);
          return book;
        }
        case "add_resource_from_path": {
          const before = current();
          const name = (args.osPath as string).split("/").pop() ?? "img.png";
          const book: Book = {
            ...before,
            dirty: true,
            resources: [
              ...before.resources,
              {
                id: `img-${before.resources.length}`,
                path: `OEBPS/images/${name}`,
                media_type: "image/png",
                size: BigInt(1),
              },
            ],
          };
          books.set(book.id, book);
          return book;
        }
        case "validate":
          return [];
        case "close_book":
          books.delete(args.bookId as string);
          return null;
        case "list_recent_books":
          return [...backend.recents];
        case "add_recent_book": {
          const path = args.path as string;
          backend.recents = [
            path,
            ...backend.recents.filter((p) => p !== path),
          ].slice(0, 10);
          return [...backend.recents];
        }
        case "remove_recent_book":
          backend.recents = backend.recents.filter((p) => p !== args.path);
          return [...backend.recents];
        case "clear_recent_books":
          backend.recents = [];
          return [];
        case "take_pending_open_paths": {
          const paths = backend.pending;
          backend.pending = [];
          return paths;
        }
        case "quit_app":
        case "ack_quit_request":
        case "detach_frontend":
        case "set_menu_state":
        case "plugin:window|set_title":
        case "plugin:window|destroy":
          return null;
        default:
          throw { kind: "Io", message: `unmocked command ${cmd}` };
      }
    },
    { shouldMockEvents: true },
  );
  return backend;
}

const count = (backend: Backend, cmd: string) =>
  backend.calls.filter((c) => c.cmd === cmd).length;
const opened = (backend: Backend, path: string) =>
  backend.calls.some((c) => c.cmd === "open_book" && c.args.path === path);
const lastCall = (backend: Backend, cmd: string) =>
  [...backend.calls].reverse().find((c) => c.cmd === cmd);

// ---- UI helpers ---------------------------------------------------------

const ALPHA = "/Livros/alpha.epub";
const BETA = "/Livros/Notas/beta.epub";

const sheet = () => screen.queryByRole("alertdialog");
const findSheet = () =>
  screen.findByRole("alertdialog", { name: /Do you want to save the changes/ });
const welcome = () => screen.queryByRole("region", { name: "Welcome" });

/** Wait until the lifecycle lock is released (Open Book… re-enabled). */
const idle = () =>
  waitFor(() =>
    expect(
      (screen.getByRole("button", { name: "Open Book…" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false),
  );

/** Mount with no book, wait for the welcome panel and shell handshake. */
async function mount(backend: Backend): Promise<void> {
  render(<App />);
  await screen.findByRole("region", { name: "Welcome" });
  await waitFor(() => expect(count(backend, "take_pending_open_paths")).toBe(1));
}

async function openFromWelcome(backend: Backend, path: string): Promise<void> {
  backend.openPicks.push(path);
  fireEvent.click(screen.getByRole("button", { name: "Open Book…" }));
  await screen.findByText(titleFor(path));
  await screen.findByTitle("Chapter content");
}

type DirtyState = "clean" | "core-dirty" | "editor-only";

async function makeDirty(state: DirtyState): Promise<void> {
  if (state === "core-dirty") {
    fireEvent.click(screen.getByRole("button", { name: "Edit metadata…" }));
    fireEvent.click(screen.getByRole("button", { name: "Save metadata" }));
    await screen.findByLabelText("(unsaved changes)");
  } else if (state === "editor-only") {
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const buffer = (await screen.findByLabelText(
      "chapter buffer",
    )) as HTMLTextAreaElement;
    await waitFor(() => expect(buffer.value).not.toBe(""));
    fireEvent.change(buffer, { target: { value: "unapplied edit" } });
    // Editor-only changes show as unsaved too (SHOULD-20).
    await screen.findByLabelText("(unsaved changes)");
  }
}

async function fillNewBook(title: string): Promise<HTMLElement> {
  const dialog = await screen.findByRole("dialog", { name: "New Book" });
  fireEvent.change(within(dialog).getByLabelText("Title"), {
    target: { value: title },
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "Create book" }));
  return dialog;
}

beforeAll(() => {
  window.HTMLElement.prototype.scrollIntoView = () => undefined;
  Object.defineProperty(window, "scrollTo", {
    value: () => undefined,
    configurable: true,
  });
});

afterEach(async () => {
  cleanup();
  // Let effect cleanups unlisten while the IPC mocks still exist.
  await new Promise((resolve) => setTimeout(resolve, 0));
  clearMocks();
});

// ---- MUST-1: one guarded controller for every entry point --------------

interface Transition {
  name: string;
  /** Start the transition (pickers/forms already satisfied). */
  trigger: (backend: Backend) => Promise<void>;
  /** Did the transition happen? */
  happened: (backend: Backend) => boolean;
}

const POSITION = { x: 10, y: 10 };

/**
 * A native-menu activation right after the same action arrived by key is
 * (deliberately) treated as the menu echo of that keypress; tests space
 * them out like a real user would.
 */
const afterDedupeWindow = () =>
  act(() => new Promise((resolve) => setTimeout(resolve, DEDUPE_WINDOW_MS + 10)));

const TRANSITIONS: Transition[] = [
  {
    name: "header Open Book… button",
    trigger: async (backend) => {
      backend.openPicks.push(BETA);
      fireEvent.click(screen.getByRole("button", { name: "Open Book…" }));
    },
    happened: (backend) => opened(backend, BETA),
  },
  {
    name: "⌘O shortcut",
    trigger: async (backend) => {
      backend.openPicks.push(BETA);
      fireEvent.keyDown(window, { key: "o", metaKey: true });
    },
    happened: (backend) => opened(backend, BETA),
  },
  {
    name: "File ▸ Open Book… (native menu)",
    trigger: async (backend) => {
      backend.openPicks.push(BETA);
      await afterDedupeWindow();
      await act(() => emit("app-menu", "open-book"));
    },
    happened: (backend) => opened(backend, BETA),
  },
  {
    name: "File ▸ Open Recent / Finder (open-files)",
    trigger: async () => {
      await act(() => emit("open-files", [BETA]));
    },
    happened: (backend) => opened(backend, BETA),
  },
  {
    name: "dropping an .epub on the window",
    trigger: async () => {
      await act(() =>
        emit("tauri://drag-drop", { paths: [BETA], position: POSITION }),
      );
    },
    happened: (backend) => opened(backend, BETA),
  },
  {
    name: "New Book… (after filling the form)",
    trigger: async () => {
      fireEvent.click(screen.getByRole("button", { name: "New Book…" }));
      await fillNewBook("Fresh book");
    },
    happened: (backend) => count(backend, "create_book") > 0,
  },
  {
    name: "Close Book (⌘W)",
    trigger: async () => {
      fireEvent.keyDown(window, { key: "w", metaKey: true });
    },
    happened: (backend) => count(backend, "close_book") > 0,
  },
  {
    name: "File ▸ Close Book (native menu)",
    trigger: async () => {
      await afterDedupeWindow();
      await act(() => emit("app-menu", "close-book"));
    },
    happened: (backend) => count(backend, "close_book") > 0,
  },
  {
    name: "Quit (⌘Q / app-quit-requested)",
    trigger: async () => {
      await act(() => emit("app-quit-requested"));
    },
    happened: (backend) => count(backend, "quit_app") > 0,
  },
  {
    name: "red close button (close-requested)",
    trigger: async () => {
      await act(() => emit("tauri://close-requested", null));
    },
    happened: (backend) => count(backend, "plugin:window|destroy") > 0,
  },
];

describe.each(TRANSITIONS)("entry point: $name", (transition) => {
  it("clean: proceeds with no prompt", async () => {
    const backend = mockBackend();
    await mount(backend);
    await openFromWelcome(backend, ALPHA);

    await transition.trigger(backend);
    await waitFor(() => expect(transition.happened(backend)).toBe(true));
    expect(sheet()).toBeNull();
  });

  it.each<DirtyState>(["core-dirty", "editor-only"])(
    "%s: prompts once; Cancel changes nothing, Don’t Save proceeds",
    async (state) => {
      const backend = mockBackend();
      await mount(backend);
      await openFromWelcome(backend, ALPHA);
      await makeDirty(state);

      await transition.trigger(backend);
      const guard = await findSheet();
      expect(screen.getAllByRole("alertdialog")).toHaveLength(1);
      fireEvent.click(within(guard).getByRole("button", { name: "Cancel" }));
      await waitFor(() => expect(sheet()).toBeNull());
      await idle();
      expect(transition.happened(backend)).toBe(false);
      expect(count(backend, "save_book")).toBe(0);
      screen.getByText(titleFor(ALPHA));
      screen.getByLabelText("(unsaved changes)");
      if (state === "editor-only") {
        expect(
          (screen.getByLabelText("chapter buffer") as HTMLTextAreaElement)
            .value,
        ).toBe("unapplied edit");
      }
      // Dismiss a leftover New Book form from the cancelled attempt.
      const form = screen.queryByRole("dialog", { name: "New Book" });
      if (form !== null) {
        fireEvent.click(within(form).getByRole("button", { name: "Cancel" }));
      }

      await transition.trigger(backend);
      const again = await findSheet();
      fireEvent.click(within(again).getByRole("button", { name: "Don’t Save" }));
      await waitFor(() => expect(transition.happened(backend)).toBe(true));
      expect(count(backend, "save_book")).toBe(0);
    },
  );
});

describe("welcome-panel entry points (no book open: never prompts)", () => {
  it("opens from a recent book in the list", async () => {
    const backend = mockBackend();
    backend.recents = [BETA, ALPHA];
    await mount(backend);
    const list = await screen.findByRole("list");
    const item = within(list).getByRole("button", { name: /beta\.epub/ });
    expect(item.getAttribute("title")).toBe(BETA);
    expect(item.textContent).toContain("Notas");
    fireEvent.click(item);
    await screen.findByText(titleFor(BETA));
  });

  it("creates from New Book…", async () => {
    const backend = mockBackend();
    await mount(backend);
    fireEvent.click(screen.getByRole("button", { name: "New Book…" }));
    await fillNewBook("Fresh book");
    await screen.findByText("Fresh book");
    expect(sheet()).toBeNull();
  });
});

// ---- MUST-2: failed replacement preserves everything --------------------

describe("failed replacement", () => {
  it("Don’t Save, then a rejected open keeps book, chapter, edit mode and text", async () => {
    const backend = mockBackend();
    backend.openErrors.set(BETA, { kind: "NotAnEpub", message: "no mimetype" });
    await mount(backend);
    await openFromWelcome(backend, ALPHA);
    fireEvent.click(screen.getByRole("button", { name: "Next →" }));
    await screen.findByText("chapter 2 of 3");
    await makeDirty("editor-only");

    backend.openPicks.push(BETA);
    fireEvent.click(screen.getByRole("button", { name: "Open Book…" }));
    fireEvent.click(
      within(await findSheet()).getByRole("button", { name: "Don’t Save" }),
    );

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("“beta.epub” isn’t a valid EPUB file.");
    expect(
      (screen.getByLabelText("chapter buffer") as HTMLTextAreaElement).value,
    ).toBe("unapplied edit");
    screen.getByText(titleFor(ALPHA));
    screen.getByText("chapter 2 of 3");
    expect(count(backend, "close_book")).toBe(0);
  });

  it("a late chapter read from the replaced book is ignored", async () => {
    const backend = mockBackend();
    await mount(backend);
    await openFromWelcome(backend, ALPHA);

    const gate = deferred<void>();
    backend.chapterGate = { resourceId: "ch2", gate: gate.promise };
    fireEvent.click(screen.getByRole("button", { name: "Next →" }));
    await waitFor(() =>
      expect(
        backend.calls.some(
          (c) => c.cmd === "read_chapter" && c.args.resourceId === "ch2",
        ),
      ).toBe(true),
    );

    await act(() => emit("open-files", [BETA]));
    await screen.findByText(titleFor(BETA));
    await waitFor(() =>
      expect(
        screen.getByTitle("Chapter content").getAttribute("srcdoc"),
      ).toContain(`served-for id:${BETA}`),
    );

    await act(async () => gate.resolve());
    expect(
      screen.getByTitle("Chapter content").getAttribute("srcdoc"),
    ).toContain(`served-for id:${BETA}`);
    screen.getByText("chapter 1 of 3");
  });
});

// ---- MUST-3/4: prepare first; save failure blocks -----------------------

describe("prepare-then-guard", () => {
  it("cancelling the picker or the New form never prompts and calls nothing", async () => {
    const backend = mockBackend();
    await mount(backend);
    await openFromWelcome(backend, ALPHA);
    await makeDirty("core-dirty");

    backend.openPicks.push(null);
    fireEvent.click(screen.getByRole("button", { name: "Open Book…" }));
    await waitFor(() => expect(count(backend, "plugin:dialog|open")).toBe(2));

    fireEvent.click(screen.getByRole("button", { name: "New Book…" }));
    const form = await screen.findByRole("dialog", { name: "New Book" });
    fireEvent.keyDown(form, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    expect(sheet()).toBeNull();
    expect(count(backend, "open_book")).toBe(1);
    expect(count(backend, "create_book")).toBe(0);
    expect(count(backend, "save_book")).toBe(0);
  });
});

describe("save failure blocks the transition", () => {
  it("in-place save fails: stay on the book, offer Save As…", async () => {
    const backend = mockBackend();
    await mount(backend);
    await openFromWelcome(backend, ALPHA);
    await makeDirty("core-dirty");
    backend.saveError = { kind: "Io", message: "volume gone" };

    await act(() => emit("open-files", [BETA]));
    fireEvent.click(within(await findSheet()).getByRole("button", { name: "Save" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(
      "“alpha.epub” couldn’t be saved to its original location.",
    );
    expect(opened(backend, BETA)).toBe(false);
    screen.getByLabelText("(unsaved changes)");

    // SHOULD-21: Save As… from the banner recovers.
    backend.saveError = null;
    backend.savePicks.push("/Elsewhere/alpha.epub");
    fireEvent.click(within(alert).getByRole("button", { name: "Save As…" }));
    await waitFor(() =>
      expect(lastCall(backend, "save_book")?.args.path).toBe(
        "/Elsewhere/alpha.epub",
      ),
    );
    await waitFor(() =>
      expect(screen.queryByLabelText("(unsaved changes)")).toBeNull(),
    );
  });

  it("cancelling Save As for a never-saved book keeps it", async () => {
    const backend = mockBackend();
    await mount(backend);
    fireEvent.click(screen.getByRole("button", { name: "New Book…" }));
    await fillNewBook("Fresh book");
    await screen.findByText("Fresh book");

    backend.savePicks.push(null);
    await act(() => emit("app-quit-requested"));
    fireEvent.click(within(await findSheet()).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(count(backend, "plugin:dialog|save")).toBe(1));
    await waitFor(() => expect(sheet()).toBeNull());
    expect(count(backend, "quit_app")).toBe(0);
    screen.getByText("Fresh book");
  });

  it("Save then proceeds when it succeeds (Quit)", async () => {
    const backend = mockBackend();
    await mount(backend);
    await openFromWelcome(backend, ALPHA);
    await makeDirty("editor-only");

    await act(() => emit("app-quit-requested"));
    fireEvent.click(within(await findSheet()).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(count(backend, "quit_app")).toBe(1));
    const order = backend.calls.map((c) => c.cmd);
    expect(order.indexOf("write_chapter")).toBeLessThan(order.indexOf("save_book"));
    expect(order.indexOf("save_book")).toBeLessThan(order.indexOf("quit_app"));
  });
});

// ---- MUST-5: one operation at a time ------------------------------------

describe("one lifecycle operation at a time", () => {
  it("double-clicking Create creates once", async () => {
    const backend = mockBackend();
    await mount(backend);
    fireEvent.click(screen.getByRole("button", { name: "New Book…" }));
    const dialog = await screen.findByRole("dialog", { name: "New Book" });
    fireEvent.change(within(dialog).getByLabelText("Title"), {
      target: { value: "Once" },
    });
    const create = within(dialog).getByRole("button", { name: "Create book" });
    fireEvent.click(create);
    fireEvent.click(create);
    await screen.findByText("Once");
    expect(count(backend, "create_book")).toBe(1);
  });

  it("⌘O / ⌘N while the picker or the sheet is up open nothing else", async () => {
    const backend = mockBackend();
    await mount(backend);
    await openFromWelcome(backend, ALPHA);
    await makeDirty("core-dirty");

    const picker = deferred<string | null>();
    backend.openPicks.push(picker.promise);
    fireEvent.keyDown(window, { key: "o", metaKey: true });
    await waitFor(() => expect(count(backend, "plugin:dialog|open")).toBe(2));
    fireEvent.keyDown(window, { key: "o", metaKey: true });
    fireEvent.keyDown(window, { key: "n", metaKey: true });
    expect(count(backend, "plugin:dialog|open")).toBe(2);
    expect(screen.queryByRole("dialog", { name: "New Book" })).toBeNull();

    await act(async () => picker.resolve(BETA));
    const guard = await findSheet();
    fireEvent.keyDown(window, { key: "o", metaKey: true });
    fireEvent.keyDown(window, { key: "n", metaKey: true });
    fireEvent.keyDown(window, { key: "w", metaKey: true });
    expect(count(backend, "plugin:dialog|open")).toBe(2);
    expect(screen.queryByRole("dialog", { name: "New Book" })).toBeNull();
    expect(count(backend, "close_book")).toBe(0);
    fireEvent.click(within(guard).getByRole("button", { name: "Don’t Save" }));
    await screen.findByText(titleFor(BETA));
  });

  it("a Finder open during a modal waits until it settles", async () => {
    const backend = mockBackend();
    await mount(backend);
    fireEvent.click(screen.getByRole("button", { name: "New Book…" }));
    const form = await screen.findByRole("dialog", { name: "New Book" });

    await act(() => emit("open-files", [BETA]));
    expect(opened(backend, BETA)).toBe(false);

    fireEvent.click(within(form).getByRole("button", { name: "Cancel" }));
    await screen.findByText(titleFor(BETA));
  });

  it("shows the activity status only for slow operations", async () => {
    const backend = mockBackend();
    await mount(backend);
    await openFromWelcome(backend, ALPHA);
    expect(screen.queryByText(/^Opening/)).toBeNull();

    const gate = deferred<void>();
    backend.openGate = gate.promise;
    await act(() => emit("open-files", [BETA]));
    // Previous book stays visible meanwhile.
    screen.getByText(titleFor(ALPHA));
    await screen.findByText("Opening “beta.epub”…");
    await act(async () => gate.resolve());
    await screen.findByText(titleFor(BETA));
    expect(screen.queryByText(/^Opening/)).toBeNull();
  });
});

// ---- MUST-7/8: sheet and modal keyboard behaviour ------------------------

describe("unsaved-changes sheet (HIG)", () => {
  it("names the book, focuses Save, Return saves, Esc cancels and restores focus", async () => {
    const backend = mockBackend();
    await mount(backend);
    await openFromWelcome(backend, ALPHA);
    await makeDirty("core-dirty");

    const openButton = screen.getByRole("button", { name: "Open Book…" });
    openButton.focus();
    backend.openPicks.push(BETA);
    fireEvent.click(openButton);
    let guard = await findSheet();
    expect(guard.getAttribute("aria-label") ?? guard.textContent).toContain(
      `Do you want to save the changes made to “${titleFor(ALPHA)}”?`,
    );
    within(guard).getByText("Your changes will be lost if you don’t save them.");
    const buttons = within(guard)
      .getAllByRole("button")
      .map((b) => b.textContent);
    expect(buttons).toEqual(["Don’t Save", "Cancel", "Save"]);
    await waitFor(() => expect(document.activeElement?.textContent).toBe("Save"));

    fireEvent.keyDown(guard, { key: "Escape" });
    await waitFor(() => expect(sheet()).toBeNull());
    await idle();
    expect(document.activeElement).toBe(openButton);
    expect(opened(backend, BETA)).toBe(false);

    backend.openPicks.push(BETA);
    fireEvent.click(openButton);
    guard = await findSheet();
    fireEvent.keyDown(guard, { key: "Enter" });
    await screen.findByText(titleFor(BETA));
    expect(count(backend, "save_book")).toBe(1);
  });
});

describe("modals", () => {
  it("New Book: focus moves in, Tab is trapped, Esc cancels and restores focus", async () => {
    const backend = mockBackend();
    await mount(backend);
    const trigger = screen.getByRole("button", { name: "New Book…" });
    trigger.focus();
    fireEvent.click(trigger);
    const dialog = await screen.findByRole("dialog", { name: "New Book" });
    expect(document.activeElement).toBe(within(dialog).getByLabelText("Title"));

    const create = within(dialog).getByRole("button", { name: "Create book" });
    create.focus();
    fireEvent.keyDown(create, { key: "Tab" });
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(create);

    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(trigger);
    expect(count(backend, "create_book")).toBe(0);
  });

  it("Edit metadata: Esc cancels without updating", async () => {
    const backend = mockBackend();
    await mount(backend);
    await openFromWelcome(backend, ALPHA);
    fireEvent.click(screen.getByRole("button", { name: "Edit metadata…" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit metadata" });
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(count(backend, "update_metadata")).toBe(0);
  });

  it("creation errors stay inside the New Book dialog with input kept", async () => {
    const backend = mockBackend();
    backend.createError = { kind: "Io", message: "no memory" };
    await mount(backend);
    fireEvent.click(screen.getByRole("button", { name: "New Book…" }));
    const dialog = await fillNewBook("Kept title");
    const error = await within(dialog).findByRole("alert");
    expect(error.textContent).toContain("The book couldn’t be created.");
    expect(within(dialog).getByLabelText("Title")).toHaveProperty(
      "value",
      "Kept title",
    );
  });
});

// ---- MUST-9/10/16: Close Book, window title, identity --------------------

describe("Close Book", () => {
  it("resets to welcome, releases the session, resets the title", async () => {
    const backend = mockBackend();
    await mount(backend);
    await openFromWelcome(backend, ALPHA);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    await screen.findByLabelText("chapter buffer");

    fireEvent.keyDown(window, { key: "w", metaKey: true });
    await screen.findByRole("region", { name: "Welcome" });
    expect(lastCall(backend, "close_book")?.args.bookId).toBe(`id:${ALPHA}`);
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.queryByLabelText("chapter buffer")).toBeNull();
    await waitFor(() =>
      expect(lastCall(backend, "plugin:window|set_title")?.args.value).toBe(
        "epubzilla",
      ),
    );
    await waitFor(() =>
      expect(document.activeElement?.textContent).toBe("Open Book…"),
    );
  });

  it("does nothing with no book open", async () => {
    const backend = mockBackend();
    await mount(backend);
    fireEvent.keyDown(window, { key: "w", metaKey: true });
    await afterDedupeWindow();
    await act(() => emit("app-menu", "close-book"));
    expect(count(backend, "close_book")).toBe(0);
  });
});

describe("document identity", () => {
  it("window title and Not saved follow open, create, save as", async () => {
    const backend = mockBackend();
    // Real IPC latency: chapter reads resolve on a later task, so the new
    // book is adopted (and the sidebar mounted) before createBook returns.
    backend.chapterDelayMs = 30;
    await mount(backend);
    const title = () => lastCall(backend, "plugin:window|set_title")?.args.value;

    await openFromWelcome(backend, ALPHA);
    await waitFor(() => expect(title()).toBe("alpha"));
    expect(screen.getByText(titleFor(ALPHA)).getAttribute("title")).toBe(ALPHA);
    expect(screen.queryByText("Not saved")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "New Book…" }));
    await fillNewBook("Livro Novo — 物語");
    await screen.findByText("Livro Novo — 物語");
    await waitFor(() => expect(title()).toBe("Livro Novo — 物語"));
    screen.getByText("Not saved");
    // SHOULD-22: a new book starts on the Chapters tab.
    expect(
      screen.getByRole("tab", { name: "Chapters" }).getAttribute("aria-selected"),
    ).toBe("true");

    await idle(); // creation finishes once its first chapter is read
    backend.savePicks.push("/Livros/livro-novo.epub");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(title()).toBe("livro-novo"));
    expect(screen.queryByText("Not saved")).toBeNull();
    expect(backend.recents[0]).toBe("/Livros/livro-novo.epub");
  });

  it("native menu state follows the document", async () => {
    const backend = mockBackend();
    await mount(backend);
    const state = () => lastCall(backend, "set_menu_state")?.args.state;
    await waitFor(() =>
      expect(state()).toEqual({ hasBook: false, editable: false, busy: false }),
    );
    await openFromWelcome(backend, ALPHA);
    await waitFor(() =>
      expect(state()).toEqual({ hasBook: true, editable: true, busy: false }),
    );
    backend.fixture = "epub2";
    await act(() => emit("open-files", [BETA]));
    await screen.findByText(titleFor(BETA));
    await waitFor(() =>
      expect(state()).toEqual({ hasBook: true, editable: false, busy: false }),
    );
    screen.getByText("EPUB 2 — read-only");
    expect(
      (screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});

// ---- MUST-11/12/13: errors, welcome, recents ------------------------------

describe("errors", () => {
  it("dismisses, and clears on the next successful open", async () => {
    const backend = mockBackend();
    backend.openErrors.set(BETA, {
      kind: "MalformedPackage",
      message: "bad opf",
    });
    await mount(backend);
    await act(() => emit("open-files", [BETA]));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(
      "“beta.epub” couldn’t be opened because its package is damaged.",
    );
    within(alert).getByText("MalformedPackage: bad opf");
    fireEvent.click(within(alert).getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("alert")).toBeNull();

    await act(() => emit("open-files", [BETA]));
    await screen.findByRole("alert");
    await openFromWelcome(backend, ALPHA);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("a missing recent shows a human message and leaves the list", async () => {
    const backend = mockBackend();
    backend.recents = [BETA, ALPHA];
    backend.openErrors.set(BETA, {
      kind: "Io",
      message: `cannot open ${BETA}: No such file or directory (os error 2)`,
    });
    await mount(backend);
    fireEvent.click(await screen.findByRole("button", { name: /beta\.epub/ }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(
      "“beta.epub” couldn’t be found. It may have been moved or deleted.",
    );
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /beta\.epub/ })).toBeNull(),
    );
    expect(backend.recents).toEqual([ALPHA]);
  });

  it("explains drops and Finder batches that contain no EPUB", async () => {
    const backend = mockBackend();
    await mount(backend);
    await act(() =>
      emit("tauri://drag-drop", { paths: ["/x/a.pdf"], position: POSITION }),
    );
    expect((await screen.findByRole("alert")).textContent).toContain(
      "epubzilla opens EPUB files only.",
    );
    expect(count(backend, "open_book")).toBe(0);
  });
});

describe("welcome and recents", () => {
  it("shows actions, the drop hint, an empty recents message, and focuses Open", async () => {
    const backend = mockBackend();
    await mount(backend);
    expect(document.activeElement?.textContent).toBe("Open Book…");
    screen.getByRole("button", { name: "New Book…" });
    screen.getByText("or drop an EPUB file here");
    screen.getByText("No recent books");
  });

  it("records opens and reflects shell-side changes (Clear Menu)", async () => {
    const backend = mockBackend();
    await mount(backend);
    await openFromWelcome(backend, ALPHA);
    expect(backend.recents).toEqual([ALPHA]);

    await act(() => emit("open-files", [BETA]));
    await screen.findByText(titleFor(BETA));
    expect(backend.recents).toEqual([BETA, ALPHA]);

    fireEvent.keyDown(window, { key: "w", metaKey: true });
    await screen.findByRole("region", { name: "Welcome" });
    const list = screen.getByRole("list");
    expect(
      within(list)
        .getAllByRole("button")
        .map((b) => b.getAttribute("title")),
    ).toEqual([BETA, ALPHA]);

    await act(() => emit("recent-books-changed", []));
    await screen.findByText("No recent books");
  });

  it("opens files the OS sent before the app was ready (Finder cold start)", async () => {
    const backend = mockBackend();
    backend.pending = ["/x/readme.txt", BETA];
    render(<App />);
    await screen.findByText(titleFor(BETA));
    expect(welcome()).toBeNull();
  });

  it("reopening the open file is a no-op (no prompt, no reload)", async () => {
    const backend = mockBackend();
    await mount(backend);
    await openFromWelcome(backend, ALPHA);
    await makeDirty("core-dirty");
    await act(() => emit("open-files", [ALPHA]));
    await act(() =>
      emit("tauri://drag-drop", { paths: [ALPHA], position: POSITION }),
    );
    expect(sheet()).toBeNull();
    expect(count(backend, "open_book")).toBe(1);
  });
});

// ---- MUST-14: drop overlay -------------------------------------------------

describe("drop overlay", () => {
  const overlay = () => document.querySelector(".drop-overlay");

  it("appears for an .epub drag and hides on leave", async () => {
    const backend = mockBackend();
    await mount(backend);
    await act(() =>
      emit("tauri://drag-enter", { paths: [BETA], position: POSITION }),
    );
    expect(overlay()).not.toBeNull();
    await act(() => emit("tauri://drag-leave", null));
    expect(overlay()).toBeNull();

    await act(() =>
      emit("tauri://drag-enter", { paths: ["/x/pic.png"], position: POSITION }),
    );
    expect(overlay()).toBeNull();
  });

  it("inserts Finder image drops into the chapter being edited", async () => {
    const backend = mockBackend();
    await mount(backend);
    await openFromWelcome(backend, ALPHA);
    // Chapter 3 edits as Markdown (image references need Markdown).
    fireEvent.click(screen.getByRole("button", { name: "Next →" }));
    await screen.findByText("chapter 2 of 3");
    fireEvent.click(screen.getByRole("button", { name: "Next →" }));
    await screen.findByText("chapter 3 of 3");
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const buffer = (await screen.findByLabelText(
      "chapter buffer",
    )) as HTMLTextAreaElement;
    await waitFor(() => expect(buffer.value).not.toBe(""));
    await act(() =>
      emit("tauri://drag-drop", {
        paths: ["/x/pic.png", "/x/notes.txt", "/x/Foto Café.JPG"],
        position: POSITION,
      }),
    );
    await waitFor(() =>
      expect(buffer.value).toContain("![](../images/Foto Café.JPG)"),
    );
    expect(buffer.value).toContain("![](../images/pic.png)");
    expect(
      backend.calls
        .filter((c) => c.cmd === "add_resource_from_path")
        .map((c) => c.args.osPath),
    ).toEqual(["/x/pic.png", "/x/Foto Café.JPG"]);
    // No EPUB-only complaint, nothing opened.
    expect(screen.queryByRole("alert")).toBeNull();
    expect(count(backend, "open_book")).toBe(1);
  });

  it("ignores image drops outside the editor", async () => {
    const backend = mockBackend();
    await mount(backend);
    await openFromWelcome(backend, ALPHA);
    await act(() =>
      emit("tauri://drag-drop", { paths: ["/x/pic.png"], position: POSITION }),
    );
    expect(count(backend, "add_resource_from_path")).toBe(0);
  });
});

// ---- Exits are never dead (Quit / red close mid-operation) -----------------

describe("exit requests during a lifecycle operation", () => {
  it("acknowledges each quit request with its id", async () => {
    const backend = mockBackend();
    await mount(backend);
    await act(() => emit("app-quit-requested", 7));
    await waitFor(() => expect(count(backend, "quit_app")).toBe(1));
    expect(lastCall(backend, "ack_quit_request")?.args).toEqual({ request: 7 });
  });

  it("with nothing unsaved, Quit goes ahead while an open is pending", async () => {
    const backend = mockBackend();
    await mount(backend);
    await openFromWelcome(backend, ALPHA);
    const gate = deferred<void>();
    backend.openGate = gate.promise;
    await act(() => emit("open-files", [BETA]));
    await waitFor(() => expect(opened(backend, BETA)).toBe(true));

    await act(() => emit("app-quit-requested", 1));
    await waitFor(() => expect(count(backend, "quit_app")).toBe(1));
    expect(sheet()).toBeNull();
    await act(async () => gate.resolve());
  });

  it("with nothing unsaved, Quit goes ahead while the picker is up", async () => {
    const backend = mockBackend();
    await mount(backend);
    const picker = deferred<string | null>();
    backend.openPicks.push(picker.promise);
    fireEvent.click(screen.getByRole("button", { name: "Open Book…" }));
    await waitFor(() => expect(count(backend, "plugin:dialog|open")).toBe(1));
    await act(() => emit("app-quit-requested", 1));
    await waitFor(() => expect(count(backend, "quit_app")).toBe(1));
    await act(async () => picker.resolve(null));
  });

  it("with unsaved work, Quit waits for the operation, then runs the guard", async () => {
    const backend = mockBackend();
    await mount(backend);
    await openFromWelcome(backend, ALPHA);
    await makeDirty("core-dirty");
    const picker = deferred<string | null>();
    backend.openPicks.push(picker.promise);
    fireEvent.keyDown(window, { key: "o", metaKey: true });
    await waitFor(() => expect(count(backend, "plugin:dialog|open")).toBe(2));

    await act(() => emit("app-quit-requested", 1));
    // Remembered, not dropped — and nothing quits behind the picker.
    expect(count(backend, "ack_quit_request")).toBe(1);
    expect(count(backend, "quit_app")).toBe(0);
    expect(sheet()).toBeNull();
    // The picker is a decision on screen: the app is visibly responsive,
    // so a repeat is acknowledged (no "isn't responding") and stacks
    // nothing.
    await act(() => emit("app-quit-requested", 2));
    expect(count(backend, "ack_quit_request")).toBe(2);

    await act(async () => picker.resolve(null)); // open cancelled
    const guard = await findSheet();
    fireEvent.click(within(guard).getByRole("button", { name: "Don’t Save" }));
    await waitFor(() => expect(count(backend, "quit_app")).toBe(1));
  });

  it("a second ⌘Q while the quit sheet is up stacks nothing; Cancel stays", async () => {
    const backend = mockBackend();
    await mount(backend);
    await openFromWelcome(backend, ALPHA);
    await makeDirty("core-dirty");
    await act(() => emit("app-quit-requested", 1));
    const guard = await findSheet();
    await act(() => emit("app-quit-requested", 2));
    expect(screen.getAllByRole("alertdialog")).toHaveLength(1);
    expect(count(backend, "ack_quit_request")).toBe(2);
    fireEvent.click(within(guard).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(sheet()).toBeNull());
    await idle();
    // Not re-run from a queue after Cancel.
    expect(sheet()).toBeNull();
    expect(count(backend, "quit_app")).toBe(0);
  });

  const acks = (backend: Backend) =>
    backend.calls
      .filter((c) => c.cmd === "ack_quit_request")
      .map((c) => c.args.request);

  it("a repeat ⌘Q while an open is working stays unacknowledged until it ends", async () => {
    const backend = mockBackend();
    await mount(backend);
    await openFromWelcome(backend, ALPHA);
    await makeDirty("core-dirty");
    const gate = deferred<void>();
    backend.openGate = gate.promise;
    await act(() => emit("open-files", [BETA]));
    fireEvent.click(within(await findSheet()).getByRole("button", { name: "Don’t Save" }));
    await waitFor(() => expect(opened(backend, BETA)).toBe(true));

    await act(() => emit("app-quit-requested", 1)); // queued: taken on
    await act(() => emit("app-quit-requested", 2)); // repeat: no decision shown
    expect(acks(backend)).toEqual([1]);
    expect(count(backend, "quit_app")).toBe(0);

    // The open finishes: responsive again, and the queued quit runs (the
    // replacement is clean, so it quits without asking).
    await act(async () => gate.resolve());
    await waitFor(() => expect(count(backend, "quit_app")).toBe(1));
    expect(acks(backend)).toEqual([1, 2]);
  });

  it("a repeat ⌘Q while the exit’s Save is stalled stays unacknowledged (native fallback)", async () => {
    const backend = mockBackend();
    await mount(backend);
    await openFromWelcome(backend, ALPHA);
    await makeDirty("core-dirty");
    const gate = deferred<void>();
    backend.saveGate = gate.promise;
    await act(() => emit("app-quit-requested", 101));
    fireEvent.click(within(await findSheet()).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(count(backend, "save_book")).toBe(1));
    expect(sheet()).toBeNull();

    // Nothing on screen to answer them: the shell's 2 s timer must fire.
    await act(() => emit("app-quit-requested", 102));
    await act(() => emit("app-quit-requested", 103));
    expect(acks(backend)).toEqual([101]);
    expect(count(backend, "quit_app")).toBe(0);

    await act(async () => gate.resolve());
    await waitFor(() => expect(count(backend, "quit_app")).toBe(1));
  });

  it("a held repeat is acknowledged as soon as the exit shows its sheet again", async () => {
    const backend = mockBackend();
    await mount(backend);
    await openFromWelcome(backend, ALPHA);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const buffer = (await screen.findByLabelText(
      "chapter buffer",
    )) as HTMLTextAreaElement;
    await waitFor(() => expect(buffer.value).not.toBe(""));
    fireEvent.change(buffer, { target: { value: "first" } });
    const gate = deferred<void>();
    backend.saveGate = gate.promise;
    await act(() => emit("app-quit-requested", 1));
    fireEvent.click(within(await findSheet()).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(count(backend, "save_book")).toBe(1));
    await act(() => emit("app-quit-requested", 2));
    expect(acks(backend)).toEqual([1]);

    // A newer edit slipped in, so the guard asks again: that sheet answers.
    fireEvent.change(buffer, { target: { value: "second" } });
    await act(async () => gate.resolve());
    const again = await findSheet();
    expect(acks(backend)).toEqual([1, 2]);
    fireEvent.click(within(again).getByRole("button", { name: "Cancel" }));
    await idle();
    expect(count(backend, "quit_app")).toBe(0);
  });

  it("repeat ⌘Q behind another operation’s sheet is acknowledged (never “isn’t responding”)", async () => {
    const backend = mockBackend();
    await mount(backend);
    await openFromWelcome(backend, ALPHA);
    await makeDirty("core-dirty");
    await act(() => emit("app-menu", "close-book"));
    const closeGuard = await findSheet();

    await act(() => emit("app-quit-requested", 1)); // queued behind the sheet
    await act(() => emit("app-quit-requested", 2)); // repeat: sheet on screen
    expect(acks(backend)).toEqual([1, 2]);
    expect(screen.getAllByRole("alertdialog")).toHaveLength(1);

    // Cancelling Close Book runs the queued quit, which asks again (Save
    // is still offered on quit).
    fireEvent.click(within(closeGuard).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(closeGuard.isConnected).toBe(false));
    const quitGuard = await findSheet();
    fireEvent.click(within(quitGuard).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(count(backend, "quit_app")).toBe(1));
    expect(count(backend, "save_book")).toBe(1);
    expect(count(backend, "close_book")).toBe(0);
  });

  it("red close: clean closes mid-operation; dirty waits, then guards", async () => {
    const backend = mockBackend();
    await mount(backend);
    await openFromWelcome(backend, ALPHA);
    const gate = deferred<void>();
    backend.openGate = gate.promise;
    await act(() => emit("open-files", [BETA]));
    await waitFor(() => expect(opened(backend, BETA)).toBe(true));
    await act(() => emit("tauri://close-requested", null));
    await waitFor(() => expect(count(backend, "plugin:window|destroy")).toBe(1));
    await act(async () => gate.resolve());
    await screen.findByText(titleFor(BETA));

    await makeDirty("core-dirty");
    const picker = deferred<string | null>();
    backend.openPicks.push(picker.promise);
    fireEvent.keyDown(window, { key: "o", metaKey: true });
    await waitFor(() => expect(count(backend, "plugin:dialog|open")).toBe(1));
    await act(() => emit("tauri://close-requested", null));
    expect(count(backend, "plugin:window|destroy")).toBe(1);
    await act(async () => picker.resolve(null));
    const guard = await findSheet();
    fireEvent.click(within(guard).getByRole("button", { name: "Don’t Save" }));
    await waitFor(() => expect(count(backend, "plugin:window|destroy")).toBe(2));
  });
});

// ---- Nothing changes behind a pending decision ----------------------------

describe("edits during a pending lifecycle operation", () => {
  async function editAlpha(backend: Backend): Promise<HTMLTextAreaElement> {
    await openFromWelcome(backend, ALPHA);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const buffer = (await screen.findByLabelText(
      "chapter buffer",
    )) as HTMLTextAreaElement;
    await waitFor(() => expect(buffer.value).not.toBe(""));
    return buffer;
  }

  it("typing while open_book is pending: the editor is read-only, and a slipped-in edit re-runs the guard", async () => {
    const backend = mockBackend();
    await mount(backend);
    const buffer = await editAlpha(backend);
    expect(buffer.readOnly).toBe(false);

    const gate = deferred<void>();
    backend.openGate = gate.promise;
    await act(() => emit("open-files", [BETA])); // clean: no guard
    await waitFor(() => expect(opened(backend, BETA)).toBe(true));
    expect(buffer.readOnly).toBe(true);
    // Chapter management and navigation are inert too.
    expect(
      (screen.getByRole("button", { name: "Apply" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Done" }) as HTMLButtonElement).disabled,
    ).toBe(true);

    fireEvent.change(buffer, { target: { value: "typed while opening" } });
    await act(async () => gate.resolve());

    // The replacement was acquired, but the newer text is unsaved: ask.
    const guard = await findSheet();
    expect(count(backend, "close_book")).toBe(0);
    fireEvent.click(within(guard).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(sheet()).toBeNull());
    await idle();
    // Still on alpha with the text; the acquired beta session was released.
    screen.getByText(titleFor(ALPHA));
    expect(
      (screen.getByLabelText("chapter buffer") as HTMLTextAreaElement).value,
    ).toBe("typed while opening");
    expect(lastCall(backend, "close_book")?.args.bookId).toBe(`id:${BETA}`);
    expect(buffer.readOnly).toBe(false);
  });

  it("typing during Save-then-Quit: read-only while saving, and newer text is guarded again", async () => {
    const backend = mockBackend();
    await mount(backend);
    const buffer = await editAlpha(backend);
    fireEvent.change(buffer, { target: { value: "first" } });

    const gate = deferred<void>();
    backend.saveGate = gate.promise;
    await act(() => emit("app-quit-requested", 1));
    fireEvent.click(within(await findSheet()).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(count(backend, "save_book")).toBe(1));
    expect(buffer.readOnly).toBe(true);

    fireEvent.change(buffer, { target: { value: "second" } });
    await act(async () => gate.resolve());

    const again = await findSheet();
    expect(count(backend, "quit_app")).toBe(0);
    fireEvent.click(within(again).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(count(backend, "quit_app")).toBe(1));
    const writes = backend.calls.filter((c) => c.cmd === "write_chapter");
    expect(
      writes.map((c) => (c.args.content as { content: string }).content),
    ).toEqual(["first", "second"]);
    expect(count(backend, "save_book")).toBe(2);
  });

  /** Save metadata with update_metadata held until the returned gate opens. */
  async function pendingMetadataSave(backend: Backend): Promise<Deferred<void>> {
    const gate = deferred<void>();
    backend.metadataGate = gate.promise;
    fireEvent.click(screen.getByRole("button", { name: "Edit metadata…" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Title" }), {
      target: { value: "pending title" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save metadata" }));
    await waitFor(() => expect(count(backend, "update_metadata")).toBe(1));
    return gate;
  }

  it("Quit while a metadata save is in flight guards the book it leaves dirty", async () => {
    const backend = mockBackend();
    await mount(backend);
    await openFromWelcome(backend, ALPHA);
    const gate = await pendingMetadataSave(backend);

    await act(() => emit("app-quit-requested", 1));
    expect(count(backend, "quit_app")).toBe(0);
    // Resolved outside act(): the guard must not depend on React having
    // committed the returned (dirty) book.
    gate.resolve();
    const guard = await findSheet();
    expect(count(backend, "quit_app")).toBe(0);
    fireEvent.click(within(guard).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(count(backend, "quit_app")).toBe(1));
    expect(count(backend, "save_book")).toBe(1);
  });

  it("Close Book while a metadata save is in flight guards the book it leaves dirty", async () => {
    const backend = mockBackend();
    await mount(backend);
    await openFromWelcome(backend, ALPHA);
    const gate = await pendingMetadataSave(backend);
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    await act(() => emit("app-menu", "close-book"));
    expect(count(backend, "close_book")).toBe(0);
    gate.resolve();
    const guard = await findSheet();
    expect(count(backend, "close_book")).toBe(0);
    fireEvent.click(within(guard).getByRole("button", { name: "Cancel" }));
    await idle();
    expect(count(backend, "close_book")).toBe(0);
    screen.getByText("pending title");
  });

  it("chapter management and metadata are refused while frozen", async () => {
    const backend = mockBackend();
    await mount(backend);
    await openFromWelcome(backend, ALPHA);
    fireEvent.click(screen.getByRole("tab", { name: "Chapters" }));
    const gate = deferred<void>();
    backend.openGate = gate.promise;
    await act(() => emit("open-files", [BETA]));
    await waitFor(() => expect(opened(backend, BETA)).toBe(true));
    for (const name of ["Add chapter…", "Next →"]) {
      expect(
        (screen.getByRole("button", { name }) as HTMLButtonElement).disabled,
      ).toBe(true);
    }
    expect(
      (screen.getByRole("button", { name: "Edit metadata…" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    await act(async () => gate.resolve());
    await screen.findByText(titleFor(BETA));
  });
});

// ---- Navigation stays behind the active decision ---------------------------

describe("chapter navigation during a decision", () => {
  it("View ▸ Next Chapter and its shortcut do nothing while the sheet is up", async () => {
    const backend = mockBackend();
    await mount(backend);
    await openFromWelcome(backend, ALPHA);
    await makeDirty("editor-only");

    backend.openPicks.push(BETA);
    fireEvent.click(screen.getByRole("button", { name: "Open Book…" }));
    const guard = await findSheet();
    const state = () => lastCall(backend, "set_menu_state")?.args.state;
    await waitFor(() =>
      expect(state()).toEqual({ hasBook: true, editable: true, busy: true }),
    );

    await afterDedupeWindow();
    await act(() => emit("app-menu", "next-chapter"));
    fireEvent.keyDown(window, { key: "ArrowRight", altKey: true, metaKey: true });
    fireEvent.keyDown(window, { key: "ArrowRight" });
    fireEvent.keyDown(window, { key: "e", metaKey: true });

    expect(screen.queryByRole("dialog", { name: "Unapplied changes" })).toBeNull();
    expect(screen.getAllByRole("alertdialog")).toHaveLength(1);
    expect(guard.contains(document.activeElement)).toBe(true);
    screen.getByText("chapter 1 of 3");
    expect(
      backend.calls.filter(
        (c) => c.cmd === "read_chapter" && c.args.resourceId === "ch2",
      ),
    ).toHaveLength(0);

    fireEvent.click(within(guard).getByRole("button", { name: "Cancel" }));
    await idle();
    await waitFor(() =>
      expect(state()).toEqual({ hasBook: true, editable: true, busy: false }),
    );
  });
});
