// Reader session state: the open Book and the current spine position.
//
// Deliberately small — M1.4 adds TOC navigation on top of `goTo`, M2 adds
// editing state. The Book itself always comes from the core (api.ts); this
// context never derives model data.

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { Book } from "@bindings/Book";
import type { ChapterContent } from "@bindings/ChapterContent";
import type { Metadata } from "@bindings/Metadata";
import type { ValidationIssue } from "@bindings/ValidationIssue";
import * as api from "../lib/api";
import { rawError } from "../lib/lifecycle";
import { anyModalOpen } from "../lib/modalStack";

export type ReaderStatus = "idle" | "opening" | "loading-chapter" | "ready";

/**
 * Outcome of a lifecycle command (open/create/save). Failures are returned
 * rather than stored in `error` so the lifecycle controller can phrase
 * them with the file name (lib/lifecycle.ts describe*Error).
 */
export type CommandResult =
  | { ok: true; book: Book }
  | { ok: false; error: unknown; cancelled?: boolean };

/**
 * Options for openBook / createBook. `confirm` runs after the replacement
 * was acquired but BEFORE anything about the current book changes (or its
 * session is released): resolve false to back out — the acquired book is
 * released and the result is `{ ok: false, cancelled: true }`.
 */
export interface AdoptOptions {
  confirm?: () => Promise<boolean>;
}

interface ReaderState {
  book: Book | null;
  /** Index into `book.spine`; -1 when nothing is open. */
  spineIndex: number;
  chapter: ChapterContent | null;
  status: ReaderStatus;
  /**
   * Element id inside the current chapter to scroll to (from a TOC entry
   * or inter-chapter link with `#fragment`); null means "top of chapter".
   */
  fragment: string | null;
  /** CoreError from the last failed command (render via describeError). */
  error: unknown;
  /** Dismiss `error` (the error banner's Dismiss button). */
  clearError: () => void;
  /**
   * open_book, then adopt. The current book — model, chapter, edit mode,
   * editor buffer — stays untouched until the replacement was acquired, so
   * a failed open loses nothing. Not guarded: callers go through the
   * lifecycle controller (state/lifecycle.tsx).
   */
  openBook: (path: string, options?: AdoptOptions) => Promise<CommandResult>;
  /**
   * create_book: the new Book slots in exactly like an opened one (title
   * page renders, nav shows). Same preservation rules as openBook.
   */
  createBook: (
    metadata: Metadata,
    options?: AdoptOptions,
  ) => Promise<CommandResult>;
  /**
   * Id of the open book when it was made by createBook (set in the same
   * render that adopts it, so the sidebar mounts on Chapters); else null.
   */
  createdBookId: string | null;
  /**
   * Lifecycle freeze (state/lifecycle.tsx): while a lifecycle operation is
   * pending, user-facing mutations and navigation are refused and the
   * editor is read-only, so nothing changes behind the guard's decision.
   * writeChapter stays available — the controller's save applies the
   * editor buffer through it.
   */
  frozen: boolean;
  setFrozen: (frozen: boolean) => void;
  /**
   * Resolves once every mutation already in flight has settled AND its
   * resulting Book is visible through `latestBook` (React may not have
   * committed it to `book` yet).
   */
  settle: () => Promise<void>;
  /**
   * The authoritative open Book right now, synchronously: updated the
   * moment a command returns a new model, before React re-renders. The
   * lifecycle guard reads this, never the last rendered `book`, so a
   * mutation that just completed is never mistaken for a clean book.
   */
  latestBook: () => Book | null;
  /**
   * Monotonic document revision: changes whenever a mutation starts or the
   * editor buffer changes. The controller compares it across a guard
   * decision / save to catch edits that slipped in meanwhile.
   */
  revision: () => number;
  /**
   * Insert image files (OS paths) into the chapter being edited, via the
   * same add-resource-and-reference path as the toolbar's Insert image…
   * (Finder drops, which the native webview intercepts). No-op when the
   * editor can't take them.
   */
  insertEditorImages: (paths: string[]) => Promise<void>;
  /**
   * Close Book: release the core session and reset every per-book piece
   * of state (back to the welcome state). Not guarded — see openBook.
   */
  closeBook: () => Promise<void>;
  /**
   * update_metadata on the open book; the returned Book replaces state
   * (position and current chapter are kept — only the model changed).
   */
  updateMetadata: (metadata: Metadata) => Promise<boolean>;
  /**
   * add_chapter after the CURRENT spine item (or at the end when nothing
   * is current); adopts the returned Book and navigates to the new chapter.
   */
  addChapter: (title: string) => Promise<boolean>;
  /**
   * remove_chapter; adopts the returned Book. If the removed chapter was
   * current, navigates to the nearest linear neighbor.
   */
  removeChapter: (spineItemId: string) => Promise<boolean>;
  /**
   * reorder_spine with the full permutation where the item swapped one
   * slot in `direction`; adopts the returned Book, current chapter kept.
   */
  moveSpineItem: (spineItemId: string, direction: 1 | -1) => Promise<boolean>;
  /**
   * save_book on the open book (M2.4). `path` is required when the book
   * has no `source` (save-as); omit it to save in place. Adopts the
   * returned Book (dirty cleared, source set) — position and current
   * chapter are kept, only the model changed.
   */
  saveBook: (path?: string) => Promise<CommandResult>;
  goTo: (spineIndex: number) => Promise<void>;
  /** Navigate by zip-internal resource path (TOC entries, chapter links). */
  goToResource: (path: string, fragment: string | null) => Promise<void>;
  nextChapter: () => Promise<void>;
  previousChapter: () => Promise<void>;
  /** Edit mode (M3.1): the reader surface is replaced by the editor pane. */
  editing: boolean;
  startEditing: () => void;
  /** Leave edit mode and re-read the current chapter (writes may have landed). */
  stopEditing: () => Promise<void>;
  /** write_chapter on the open book; adopts the returned Book (dirty set). */
  writeChapter: (content: ChapterContent) => Promise<boolean>;
  /**
   * Navigation guard (M3.1): the editor registers an async veto consulted
   * before any chapter-leaving navigation (goTo/goToResource/next/prev and
   * leaving edit mode via requestStopEditing). Resolve false to cancel. One
   * guard at a time; pass null to unregister. Open/new/window-close go
   * through the lifecycle controller's unsaved-changes guard instead (M3.3), which
   * consults the editor buffer via the handle below — never both.
   */
  setNavGuard: (guard: (() => Promise<boolean>) | null) => void;
  /** Leave edit mode via the navigation guard (Cmd/Ctrl+E, Done button). */
  requestStopEditing: () => Promise<void>;
  /**
   * Editor buffer handle (M3.3): the editor registers its live buffer so the
   * unified save flow and dirty guard can see and apply unapplied changes.
   * Pass null to unregister.
   */
  setEditorBuffer: (handle: EditorBufferHandle | null) => void;
  /** Whether a registered editor buffer has unapplied changes right now. */
  editorBufferModified: () => boolean;
  /**
   * Reactive mirror of editorBufferModified for display (unsaved
   * indicator): the editor reports flips via notifyEditorModified, never
   * its text.
   */
  editorDirty: boolean;
  notifyEditorModified: (modified: boolean) => void;
  /**
   * Apply the registered editor buffer if it has unapplied changes.
   * Resolves true when there was nothing to apply or the apply succeeded.
   */
  applyEditorBuffer: () => Promise<boolean>;
  /**
   * add_resource_from_path on the open book (M3.3, image insertion);
   * adopts and returns the updated Book (null on failure).
   */
  addResource: (osPath: string) => Promise<Book | null>;
  /**
   * add_resource_from_bytes on the open book (issue #54, clipboard paste /
   * drop); adopts and returns the updated Book (null on failure).
   */
  addResourceBytes: (
    nameHint: string,
    mediaType: string,
    bytes: Uint8Array,
  ) => Promise<Book | null>;
  /**
   * set_cover on the open book (issue #73): make an existing image resource
   * the cover, or clear it with null; adopts the returned Book.
   */
  setCover: (resourceId: string | null) => Promise<boolean>;
  /**
   * set_cover_from_path on the open book (issue #73): add an image file and
   * make it the cover in one command; adopts the returned Book.
   */
  setCoverFromFile: (osPath: string) => Promise<boolean>;
  /**
   * Findings from the last `validate` run (issue #72, ADR-0003 native
   * subset). Null means "not run against the current model": results are
   * cleared whenever the model changes (edits, metadata, new book) so the
   * panel never shows stale findings, and refreshed automatically after a
   * successful save.
   */
  validation: ValidationIssue[] | null;
  /** Whether a `validate` command is currently in flight. */
  validating: boolean;
  /** Run `validate` on the open book and store the findings. */
  runValidation: () => Promise<void>;
}

/** Live view of the editor's chapter buffer (see setEditorBuffer). */
export interface EditorBufferHandle {
  /** Whether the buffer differs from its applied baseline. */
  modified: () => boolean;
  /** write_chapter the buffer; resolves true on success. */
  apply: () => Promise<boolean>;
  /** Counts buffer changes (see ReaderState.revision). */
  revision: () => number;
  /** Insert images from OS paths at the cursor (see insertEditorImages). */
  insertImages: (paths: string[]) => Promise<void>;
}

const ReaderContext = createContext<ReaderState | null>(null);

/** First linear spine index at or beyond `from` in direction `step`; -1 if none. */
export function findLinear(book: Book, from: number, step: 1 | -1): number {
  for (let i = from; i >= 0 && i < book.spine.length; i += step) {
    if (book.spine[i].linear) return i;
  }
  return -1;
}

export function ReaderProvider({ children }: { children: ReactNode }) {
  const [book, setBookState] = useState<Book | null>(null);
  // Synchronous mirror of `book` (see ReaderState.latestBook): every model
  // the core hands back lands here first, then in React state.
  const bookRef = useRef<Book | null>(null);
  const setBook = useCallback((next: Book | null) => {
    bookRef.current = next;
    setBookState(next);
  }, []);
  const latestBook = useCallback(() => bookRef.current, []);
  const [spineIndex, setSpineIndex] = useState(-1);
  const [chapter, setChapter] = useState<ChapterContent | null>(null);
  const [fragment, setFragment] = useState<string | null>(null);
  const [status, setStatus] = useState<ReaderStatus>("idle");
  const [error, setError] = useState<unknown>(null);
  const [editing, setEditing] = useState(false);
  const [validation, setValidation] = useState<ValidationIssue[] | null>(null);
  const [validating, setValidating] = useState(false);
  const [editorDirty, setEditorDirty] = useState(false);
  const [createdBookId, setCreatedBookId] = useState<string | null>(null);

  // Lifecycle freeze (see ReaderState.frozen). The ref answers synchronously
  // for handlers that run before the next render.
  const frozenRef = useRef(false);
  const [frozen, setFrozenState] = useState(false);
  const setFrozen = useCallback((next: boolean) => {
    frozenRef.current = next;
    setFrozenState(next);
  }, []);
  /** Chapter navigation is refused while frozen or behind any modal. */
  const navBlocked = () => frozenRef.current || anyModalOpen();

  // Mutations in flight and the document revision (see settle / revision).
  const inFlightRef = useRef(new Set<Promise<unknown>>());
  const mutationRevisionRef = useRef(0);
  const track = useCallback(<T,>(work: Promise<T>): Promise<T> => {
    mutationRevisionRef.current += 1;
    const set = inFlightRef.current;
    set.add(work);
    const done = () => {
      set.delete(work);
    };
    work.then(done, done);
    return work;
  }, []);
  const settle = useCallback(async () => {
    const set = inFlightRef.current;
    while (set.size > 0) await Promise.allSettled([...set]);
  }, []);

  // Session generation: bumped whenever the open book is replaced or
  // closed. Async chapter reads and validation runs capture it and drop
  // their result if it changed meanwhile, so a late answer about the
  // previous book can never land on the new one.
  const generationRef = useRef(0);

  const clearError = useCallback(() => setError(null), []);
  const notifyEditorModified = useCallback((modified: boolean) => {
    setEditorDirty(modified);
  }, []);

  // Editor veto for chapter-leaving navigation (see setNavGuard docs).
  const navGuardRef = useRef<(() => Promise<boolean>) | null>(null);
  const setNavGuard = useCallback(
    (guard: (() => Promise<boolean>) | null) => {
      navGuardRef.current = guard;
    },
    [],
  );
  const passGuard = useCallback(async (): Promise<boolean> => {
    const guard = navGuardRef.current;
    return guard === null ? true : guard();
  }, []);

  // Editor buffer handle (M3.3): consulted by the lifecycle controller's save
  // flow and unsaved-changes guard; see setEditorBuffer docs.
  const editorBufferRef = useRef<EditorBufferHandle | null>(null);
  const setEditorBuffer = useCallback(
    (handle: EditorBufferHandle | null) => {
      editorBufferRef.current = handle;
    },
    [],
  );
  const editorBufferModified = useCallback(
    (): boolean => editorBufferRef.current?.modified() ?? false,
    [],
  );
  const applyEditorBuffer = useCallback(async (): Promise<boolean> => {
    const handle = editorBufferRef.current;
    if (handle === null || !handle.modified()) return true;
    return handle.apply();
  }, []);
  const revision = useCallback(
    (): number =>
      mutationRevisionRef.current + (editorBufferRef.current?.revision() ?? 0),
    [],
  );
  const insertEditorImages = useCallback(async (paths: string[]) => {
    const handle = editorBufferRef.current;
    if (handle === null || frozenRef.current) return;
    await handle.insertImages(paths);
  }, []);

  const loadChapter = useCallback(
    async (target: Book, index: number, targetFragment: string | null = null) => {
      const item = target.spine[index];
      if (item === undefined) return;
      const generation = generationRef.current;
      setStatus("loading-chapter");
      setError(null);
      try {
        const content = await api.readChapter(
          target.id,
          item.resource,
          "Xhtml",
        );
        if (generation !== generationRef.current) return;
        setChapter(content);
        setSpineIndex(index);
        setFragment(targetFragment);
        setStatus("ready");
      } catch (err) {
        if (generation !== generationRef.current) return;
        setError(err);
        setStatus("ready");
      }
    },
    [],
  );

  /**
   * Run `validate` for `bookId` and store the findings (issue #72). A
   * command rejection lands in `error` (rendered by the header) and clears
   * any previous findings.
   */
  const refreshValidation = useCallback(async (bookId: string) => {
    const generation = generationRef.current;
    setValidating(true);
    try {
      const issues = await api.validateBook(bookId);
      if (generation === generationRef.current) setValidation(issues);
    } catch (err) {
      if (generation === generationRef.current) {
        setError(err);
        setValidation(null);
      }
    } finally {
      if (generation === generationRef.current) setValidating(false);
    }
  }, []);

  const runValidation = useCallback(async () => {
    if (book === null) return;
    await refreshValidation(book.id);
  }, [book, refreshValidation]);

  /**
   * Make `next` the open book (from open_book OR create_book — both return
   * a full Book that slots in identically) and load its first linear
   * chapter.
   *
   * Nothing about the current book changes until `acquire` succeeds: edit
   * mode, the editor (and its unapplied buffer), chapter and position all
   * stay as they were, so a rejected open can be retried with no loss.
   * Only after adoption is the previous core session released.
   */
  const adoptBook = useCallback(
    async (
      acquire: () => Promise<Book>,
      created: boolean,
      options: AdoptOptions = {},
    ): Promise<CommandResult> => {
      const previous = book;
      setStatus("opening");
      let next: Book;
      try {
        next = await acquire();
      } catch (err) {
        setStatus(previous === null ? "idle" : "ready");
        return { ok: false, error: err };
      }
      if (options.confirm !== undefined && !(await options.confirm())) {
        // Backed out after acquisition: the current book was never touched.
        api.closeBook(next.id).catch(() => undefined);
        setStatus(previous === null ? "idle" : "ready");
        return { ok: false, error: null, cancelled: true };
      }
      generationRef.current += 1;
      setCreatedBookId(created ? next.id : null);
      setEditing(false);
      setEditorDirty(false);
      setError(null);
      setBook(next);
      setChapter(null);
      setFragment(null);
      setSpineIndex(-1);
      setValidation(null);
      setValidating(false);
      if (previous !== null && previous.id !== next.id) {
        // Best-effort session cleanup; ignore failures.
        api.closeBook(previous.id).catch(() => undefined);
      }
      const first = findLinear(next, 0, 1);
      if (first === -1) {
        setStatus("ready");
      } else {
        await loadChapter(next, first);
      }
      return { ok: true, book: next };
    },
    [book, loadChapter, setBook],
  );

  const openBook = useCallback(
    (path: string, options?: AdoptOptions) =>
      adoptBook(() => api.openBook(path), false, options),
    [adoptBook],
  );

  const createBook = useCallback(
    (metadata: Metadata, options?: AdoptOptions) =>
      adoptBook(() => api.createBook(metadata), true, options),
    [adoptBook],
  );

  const closeBook = useCallback(async () => {
    const previous = book;
    generationRef.current += 1;
    setEditing(false);
    setEditorDirty(false);
    setBook(null);
    setChapter(null);
    setFragment(null);
    setSpineIndex(-1);
    setValidation(null);
    setValidating(false);
    setError(null);
    setStatus("idle");
    if (previous !== null) {
      await api.closeBook(previous.id).catch(() => undefined);
    }
  }, [book, setBook]);

  const updateMetadata = useCallback(
    async (metadata: Metadata): Promise<boolean> => {
      if (book === null || frozenRef.current) return false;
      setError(null);
      try {
        // Same book, same spine position — only the model (and dirty flag,
        // displayed from M2.4) changed. Adopted inside the tracked work, so
        // settle() returns only once the guard can see the new model.
        await track(api.updateMetadata(book.id, metadata).then(setBook));
        setValidation(null);
        return true;
      } catch (err) {
        setError(err);
        return false;
      }
    },
    [book, track, setBook],
  );

  /**
   * Shared spine-mutation path (M2.3): run an editing command, adopt the
   * returned Book as the truth (no optimistic updates), and keep the
   * current chapter when it survived — only its index may have shifted,
   * the loaded content is unchanged. Returns the updated Book, or null
   * on failure (the CoreError is stored for the header to render).
   */
  const applyEdit = useCallback(
    async (mutate: () => Promise<Book>): Promise<Book | null> => {
      if (book === null) return null;
      const currentId = book.spine[spineIndex]?.id ?? null;
      setError(null);
      try {
        // Adopted inside the tracked work (see updateMetadata).
        const updated = await track(
          mutate().then((next) => {
            setBook(next);
            return next;
          }),
        );
        setValidation(null);
        if (currentId !== null) {
          const kept = updated.spine.findIndex((s) => s.id === currentId);
          if (kept !== -1) setSpineIndex(kept);
        }
        return updated;
      } catch (err) {
        setError(err);
        return null;
      }
    },
    [book, spineIndex, track, setBook],
  );

  const addChapter = useCallback(
    async (title: string): Promise<boolean> => {
      if (book === null || frozenRef.current) return false;
      const after = book.spine[spineIndex]?.id;
      const known = new Set(book.spine.map((s) => s.id));
      const updated = await applyEdit(() =>
        api.addChapter(book.id, title, after),
      );
      if (updated === null) return false;
      // The one spine id we didn't know before is the new chapter.
      const created = updated.spine.findIndex((s) => !known.has(s.id));
      if (created !== -1) await loadChapter(updated, created);
      return true;
    },
    [book, spineIndex, applyEdit, loadChapter],
  );

  const removeChapter = useCallback(
    async (spineItemId: string): Promise<boolean> => {
      if (book === null || frozenRef.current) return false;
      const removedIndex = book.spine.findIndex((s) => s.id === spineItemId);
      if (removedIndex === -1) return false;
      const wasCurrent = removedIndex === spineIndex;
      const updated = await applyEdit(() =>
        api.removeChapter(book.id, spineItemId),
      );
      if (updated === null) return false;
      if (wasCurrent) {
        // Sensible neighbor: the first linear chapter at or after the
        // removed slot, else the nearest linear one before it.
        const at = Math.min(removedIndex, updated.spine.length - 1);
        const forward = at < 0 ? -1 : findLinear(updated, at, 1);
        const fallback =
          forward !== -1 ? forward : at < 0 ? -1 : findLinear(updated, at, -1);
        if (fallback === -1) {
          setChapter(null);
          setSpineIndex(-1);
        } else {
          await loadChapter(updated, fallback);
        }
      }
      return true;
    },
    [book, spineIndex, applyEdit, loadChapter],
  );

  const moveSpineItem = useCallback(
    async (spineItemId: string, direction: 1 | -1): Promise<boolean> => {
      if (book === null || frozenRef.current) return false;
      const from = book.spine.findIndex((s) => s.id === spineItemId);
      if (from === -1) return false;
      const to = from + direction;
      if (to < 0 || to >= book.spine.length) return false;
      // Full permutation with the two neighbors swapped — the core owns
      // the ordering rules; the UI only describes the desired order.
      const order = book.spine.map((s) => s.id);
      [order[from], order[to]] = [order[to], order[from]];
      const updated = await applyEdit(() =>
        api.reorderSpine(book.id, order),
      );
      return updated !== null;
    },
    [book, applyEdit],
  );

  const saveBook = useCallback(
    async (path?: string): Promise<CommandResult> => {
      if (book === null) return { ok: false, error: new Error("No book is open.") };
      setError(null);
      try {
        const saved = await api.saveBook(book.id, path);
        // Same book, same spine position — only `dirty`, `source`, and
        // `dcterms:modified` changed.
        setBook(saved);
        // Issue #72: re-check automatically after every save so the panel
        // reflects what was just written. Fire-and-forget: findings (or a
        // rejection, via `error`) land when they land — save stays snappy.
        void refreshValidation(saved.id);
        return { ok: true, book: saved };
      } catch (err) {
        return { ok: false, error: err };
      }
    },
    [book, refreshValidation, setBook],
  );

  const goTo = useCallback(
    async (index: number) => {
      if (book === null || index < 0 || index >= book.spine.length) return;
      if (navBlocked()) return;
      if (index !== spineIndex && !(await passGuard())) return;
      await loadChapter(book, index);
    },
    [book, spineIndex, loadChapter, passGuard],
  );

  const goToResource = useCallback(
    async (path: string, targetFragment: string | null) => {
      if (book === null || navBlocked()) return;
      const resource = book.resources.find((r) => r.path === path);
      if (resource === undefined) return;
      const index = book.spine.findIndex((s) => s.resource === resource.id);
      if (index === -1) return;
      if (index === spineIndex && chapter !== null) {
        // Same chapter: only the scroll target changes, no reload.
        setFragment(targetFragment);
        return;
      }
      if (!(await passGuard())) return;
      await loadChapter(book, index, targetFragment);
    },
    [book, spineIndex, chapter, loadChapter, passGuard],
  );

  const nextChapter = useCallback(async () => {
    if (book === null || navBlocked()) return;
    const next = findLinear(book, spineIndex + 1, 1);
    if (next !== -1 && (await passGuard())) await loadChapter(book, next);
  }, [book, spineIndex, loadChapter, passGuard]);

  const previousChapter = useCallback(async () => {
    if (book === null || navBlocked()) return;
    const prev = findLinear(book, spineIndex - 1, -1);
    if (prev !== -1 && (await passGuard())) await loadChapter(book, prev);
  }, [book, spineIndex, loadChapter, passGuard]);

  const startEditing = useCallback(() => {
    if (navBlocked()) return;
    if (book !== null && book.epub_version === "V3" && spineIndex >= 0) {
      setEditing(true);
    }
  }, [book, spineIndex]);

  const stopEditing = useCallback(async () => {
    if (frozenRef.current) return;
    setEditing(false);
    // Re-read the current chapter: applied writes changed its content.
    if (book !== null && spineIndex >= 0) await loadChapter(book, spineIndex);
  }, [book, spineIndex, loadChapter]);

  const requestStopEditing = useCallback(async () => {
    if (navBlocked()) return;
    if (!(await passGuard())) return;
    await stopEditing();
  }, [passGuard, stopEditing]);

  const addResource = useCallback(
    async (osPath: string): Promise<Book | null> => {
      if (book === null || frozenRef.current) return null;
      return applyEdit(() => api.addResourceFromPath(book.id, osPath));
    },
    [book, applyEdit],
  );

  const addResourceBytes = useCallback(
    async (
      nameHint: string,
      mediaType: string,
      bytes: Uint8Array,
    ): Promise<Book | null> => {
      if (book === null || frozenRef.current) return null;
      return applyEdit(() =>
        api.addResourceFromBytes(book.id, nameHint, mediaType, bytes),
      );
    },
    [book, applyEdit],
  );

  const setCover = useCallback(
    async (resourceId: string | null): Promise<boolean> => {
      if (book === null || frozenRef.current) return false;
      const updated = await applyEdit(() => api.setCover(book.id, resourceId));
      return updated !== null;
    },
    [book, applyEdit],
  );

  const setCoverFromFile = useCallback(
    async (osPath: string): Promise<boolean> => {
      if (book === null || frozenRef.current) return false;
      const updated = await applyEdit(() =>
        api.setCoverFromPath(book.id, osPath),
      );
      return updated !== null;
    },
    [book, applyEdit],
  );

  const writeChapter = useCallback(
    async (content: ChapterContent): Promise<boolean> => {
      if (book === null) return false;
      const updated = await applyEdit(() =>
        api.writeChapter(book.id, content.resource, content),
      );
      return updated !== null;
    },
    [book, applyEdit],
  );

  const value = useMemo<ReaderState>(
    () => ({
      book,
      spineIndex,
      chapter,
      fragment,
      status,
      error,
      clearError,
      openBook,
      createBook,
      createdBookId,
      frozen,
      setFrozen,
      settle,
      latestBook,
      revision,
      insertEditorImages,
      closeBook,
      updateMetadata,
      addChapter,
      removeChapter,
      moveSpineItem,
      saveBook,
      goTo,
      goToResource,
      nextChapter,
      previousChapter,
      editing,
      startEditing,
      stopEditing,
      writeChapter,
      setNavGuard,
      requestStopEditing,
      setEditorBuffer,
      editorBufferModified,
      editorDirty,
      notifyEditorModified,
      applyEditorBuffer,
      addResource,
      addResourceBytes,
      setCover,
      setCoverFromFile,
      validation,
      validating,
      runValidation,
    }),
    [
      book,
      spineIndex,
      chapter,
      fragment,
      status,
      error,
      clearError,
      openBook,
      createBook,
      createdBookId,
      frozen,
      setFrozen,
      settle,
      latestBook,
      revision,
      insertEditorImages,
      closeBook,
      updateMetadata,
      addChapter,
      removeChapter,
      moveSpineItem,
      saveBook,
      goTo,
      goToResource,
      nextChapter,
      previousChapter,
      editing,
      startEditing,
      stopEditing,
      writeChapter,
      setNavGuard,
      requestStopEditing,
      setEditorBuffer,
      editorBufferModified,
      editorDirty,
      notifyEditorModified,
      applyEditorBuffer,
      addResource,
      addResourceBytes,
      setCover,
      setCoverFromFile,
      validation,
      validating,
      runValidation,
    ],
  );

  return (
    <ReaderContext.Provider value={value}>{children}</ReaderContext.Provider>
  );
}

export function useReader(): ReaderState {
  const ctx = useContext(ReaderContext);
  if (ctx === null) {
    throw new Error("useReader must be used within a ReaderProvider");
  }
  return ctx;
}

/** Raw `Kind: message` form of a command rejection (CoreError or unknown). */
export function describeError(error: unknown): string {
  return rawError(error);
}
