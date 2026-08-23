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
import * as api from "../lib/api";

export type ReaderStatus = "idle" | "opening" | "loading-chapter" | "ready";

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
  openBook: (path: string) => Promise<void>;
  /**
   * create_book: the new Book slots in exactly like an opened one (title
   * page renders, nav shows). Resolves true on success so callers (the
   * new-book dialog) know whether to close.
   */
  createBook: (metadata: Metadata) => Promise<boolean>;
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
  saveBook: (path?: string) => Promise<boolean>;
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
   * opening or creating another book). Resolve false to cancel. One guard
   * at a time; pass null to unregister.
   */
  setNavGuard: (guard: (() => Promise<boolean>) | null) => void;
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
  const [book, setBook] = useState<Book | null>(null);
  const [spineIndex, setSpineIndex] = useState(-1);
  const [chapter, setChapter] = useState<ChapterContent | null>(null);
  const [fragment, setFragment] = useState<string | null>(null);
  const [status, setStatus] = useState<ReaderStatus>("idle");
  const [error, setError] = useState<unknown>(null);
  const [editing, setEditing] = useState(false);

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

  const loadChapter = useCallback(
    async (target: Book, index: number, targetFragment: string | null = null) => {
      const item = target.spine[index];
      if (item === undefined) return;
      setStatus("loading-chapter");
      setError(null);
      try {
        const content = await api.readChapter(
          target.id,
          item.resource,
          "Xhtml",
        );
        setChapter(content);
        setSpineIndex(index);
        setFragment(targetFragment);
        setStatus("ready");
      } catch (err) {
        setError(err);
        setStatus("ready");
      }
    },
    [],
  );

  /**
   * Make `next` the open book (from open_book OR create_book — both return
   * a full Book that slots in identically) and load its first linear
   * chapter. Resolves true on success.
   */
  const adoptBook = useCallback(
    async (acquire: () => Promise<Book>): Promise<boolean> => {
      if (!(await passGuard())) return false;
      setEditing(false);
      setStatus("opening");
      setError(null);
      try {
        const previous = book;
        const next = await acquire();
        setBook(next);
        setChapter(null);
        if (previous !== null && previous.id !== next.id) {
          // Best-effort session cleanup; ignore failures.
          api.closeBook(previous.id).catch(() => undefined);
        }
        const first = findLinear(next, 0, 1);
        if (first === -1) {
          setSpineIndex(-1);
          setStatus("ready");
        } else {
          await loadChapter(next, first);
        }
        return true;
      } catch (err) {
        setError(err);
        setStatus(book === null ? "idle" : "ready");
        return false;
      }
    },
    [book, loadChapter, passGuard],
  );

  const openBook = useCallback(
    async (path: string) => {
      await adoptBook(() => api.openBook(path));
    },
    [adoptBook],
  );

  const createBook = useCallback(
    (metadata: Metadata) => adoptBook(() => api.createBook(metadata)),
    [adoptBook],
  );

  const updateMetadata = useCallback(
    async (metadata: Metadata): Promise<boolean> => {
      if (book === null) return false;
      setError(null);
      try {
        const updated = await api.updateMetadata(book.id, metadata);
        // Same book, same spine position — only the model (and dirty flag,
        // displayed from M2.4) changed.
        setBook(updated);
        return true;
      } catch (err) {
        setError(err);
        return false;
      }
    },
    [book],
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
        const updated = await mutate();
        setBook(updated);
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
    [book, spineIndex],
  );

  const addChapter = useCallback(
    async (title: string): Promise<boolean> => {
      if (book === null) return false;
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
      if (book === null) return false;
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
      if (book === null) return false;
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
    async (path?: string): Promise<boolean> => {
      if (book === null) return false;
      setError(null);
      try {
        const saved = await api.saveBook(book.id, path);
        // Same book, same spine position — only `dirty`, `source`, and
        // `dcterms:modified` changed.
        setBook(saved);
        return true;
      } catch (err) {
        setError(err);
        return false;
      }
    },
    [book],
  );

  const goTo = useCallback(
    async (index: number) => {
      if (book === null || index < 0 || index >= book.spine.length) return;
      if (index !== spineIndex && !(await passGuard())) return;
      await loadChapter(book, index);
    },
    [book, spineIndex, loadChapter, passGuard],
  );

  const goToResource = useCallback(
    async (path: string, targetFragment: string | null) => {
      if (book === null) return;
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
    if (book === null) return;
    const next = findLinear(book, spineIndex + 1, 1);
    if (next !== -1 && (await passGuard())) await loadChapter(book, next);
  }, [book, spineIndex, loadChapter, passGuard]);

  const previousChapter = useCallback(async () => {
    if (book === null) return;
    const prev = findLinear(book, spineIndex - 1, -1);
    if (prev !== -1 && (await passGuard())) await loadChapter(book, prev);
  }, [book, spineIndex, loadChapter, passGuard]);

  const startEditing = useCallback(() => {
    if (book !== null && book.epub_version === "V3" && spineIndex >= 0) {
      setEditing(true);
    }
  }, [book, spineIndex]);

  const stopEditing = useCallback(async () => {
    setEditing(false);
    // Re-read the current chapter: applied writes changed its content.
    if (book !== null && spineIndex >= 0) await loadChapter(book, spineIndex);
  }, [book, spineIndex, loadChapter]);

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
      openBook,
      createBook,
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
    }),
    [
      book,
      spineIndex,
      chapter,
      fragment,
      status,
      error,
      openBook,
      createBook,
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

/** Human-readable form of a command rejection (CoreError or unknown). */
export function describeError(error: unknown): string {
  if (api.isCoreError(error)) {
    switch (error.kind) {
      case "ResourceNotFound":
        return `${error.kind}: ${error.id}`;
      case "ValidationFailed":
        return `${error.kind}: ${error.issues.length} issue(s)`;
      case "ConversionLossy":
        return `${error.kind}: ${error.detail}`;
      default:
        return `${error.kind}: ${error.message}`;
    }
  }
  return error instanceof Error ? error.message : String(error);
}
