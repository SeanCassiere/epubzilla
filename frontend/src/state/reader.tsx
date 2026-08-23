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
  goTo: (spineIndex: number) => Promise<void>;
  /** Navigate by zip-internal resource path (TOC entries, chapter links). */
  goToResource: (path: string, fragment: string | null) => Promise<void>;
  nextChapter: () => Promise<void>;
  previousChapter: () => Promise<void>;
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
    [book, loadChapter],
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

  const goTo = useCallback(
    async (index: number) => {
      if (book === null || index < 0 || index >= book.spine.length) return;
      await loadChapter(book, index);
    },
    [book, loadChapter],
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
      await loadChapter(book, index, targetFragment);
    },
    [book, spineIndex, chapter, loadChapter],
  );

  const nextChapter = useCallback(async () => {
    if (book === null) return;
    const next = findLinear(book, spineIndex + 1, 1);
    if (next !== -1) await loadChapter(book, next);
  }, [book, spineIndex, loadChapter]);

  const previousChapter = useCallback(async () => {
    if (book === null) return;
    const prev = findLinear(book, spineIndex - 1, -1);
    if (prev !== -1) await loadChapter(book, prev);
  }, [book, spineIndex, loadChapter]);

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
      goTo,
      goToResource,
      nextChapter,
      previousChapter,
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
      goTo,
      goToResource,
      nextChapter,
      previousChapter,
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
