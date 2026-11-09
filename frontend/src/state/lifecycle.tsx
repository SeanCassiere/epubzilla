// Book lifecycle controller: the ONE place that opens, creates, closes,
// saves, and quits. Every entry point — welcome panel, header, File menu,
// ⌘O/⌘N/⌘W/⌘S, Open Recent (menu + welcome), dropping an .epub, Finder
// "Open With", the red close button, and ⌘Q — funnels through here, so
// they all share:
//
//  - prepare-then-guard: the picker / New form runs first; cancelling it
//    changes nothing and never asks about unsaved work;
//  - one unsaved-changes guard (book dirty OR unapplied editor buffer),
//    shown at most once per transition; Save failing or being cancelled
//    blocks the transition;
//  - one operation at a time: a lock held across picker, guard, save and
//    acquisition; background entry points are ignored (or, for Finder,
//    queued) while it is held or any modal is open;
//  - readable errors naming the file (lib/lifecycle.ts);
//  - side effects on success: recents, native window title, menu state.
//
// The reader state (state/reader.tsx) stays unguarded mechanics; this
// layer owns the decisions.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { Metadata } from "@bindings/Metadata";
import { useReader } from "./reader";
import * as api from "../lib/api";
import { pickEpubFile, pickSaveEpubPath, slugifyTitle } from "../lib/dialog";
import { needsUnsavedPrompt } from "../lib/editing";
import {
  describeCreateError,
  describeOpenError,
  describeSaveError,
  fileName,
  firstEpub,
  isEpubPath,
  isNotFound,
  rawError,
  samePath,
  windowTitleFor,
  type LifecycleNotice,
} from "../lib/lifecycle";
import { anyModalOpen, subscribeModals } from "../lib/modalStack";
import { onShortcut } from "../lib/shortcuts";
import {
  onOpenFiles,
  onQuitRequested,
  onRecentBooksChanged,
} from "../lib/shellEvents";
import { onFileDragDrop } from "../lib/dragDrop";
import {
  destroyWindow,
  interceptClose,
  onCloseRequested,
  setWindowTitle,
} from "../lib/window";

/** The unsaved-changes sheet's three answers. */
export type GuardChoice = "save" | "dont-save" | "cancel";

/**
 * Activity status threshold: like chapter loads (ReaderPane), typical
 * opens finish in a few ms, so the status only appears when an operation
 * outlasts this.
 */
export const ACTIVITY_DELAY_MS = 150;

interface NewBookDialogState {
  /** Creation failure, shown inside the dialog (input is kept). */
  error: LifecycleNotice | null;
}

export interface LifecycleState {
  /** A lifecycle operation or decision is pending (the lock is held). */
  busy: boolean;
  /** "Opening “x.epub”…" etc., only once it outlasted ACTIVITY_DELAY_MS. */
  activityLabel: string | null;
  /** Recent books (OS paths), newest first. */
  recents: string[];
  /** The current lifecycle failure, if any (error banner). */
  notice: LifecycleNotice | null;
  dismissNotice: () => void;
  /** Title of the book the unsaved sheet asks about; null when hidden. */
  guardTitle: string | null;
  resolveGuard: (choice: GuardChoice) => void;
  /** Non-null while the New Book dialog is open. */
  newBookDialog: NewBookDialogState | null;
  requestNew: () => void;
  cancelNew: () => void;
  submitNew: (metadata: Metadata) => void;
  /** Open `path`, or show the picker first when omitted. */
  requestOpen: (path?: string) => void;
  /** Drop / Finder batch: first .epub wins, non-EPUBs are explained. */
  openPaths: (paths: string[]) => void;
  requestClose: () => void;
  /** Unified save (apply buffer → path when needed → save). */
  save: (alwaysPrompt?: boolean) => Promise<boolean>;
  clearRecents: () => void;
  /** An .epub is being dragged over the window (drop overlay). */
  dropActive: boolean;
  /** Id of the book most recently made by New Book (sidebar opens on Chapters). */
  createdBookId: string | null;
}

const LifecycleContext = createContext<LifecycleState | null>(null);

export function LifecycleProvider({ children }: { children: ReactNode }) {
  const reader = useReader();
  const readerRef = useRef(reader);
  readerRef.current = reader;

  const lockRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [activity, setActivity] = useState<string | null>(null);
  const [showActivity, setShowActivity] = useState(false);
  const [notice, setNotice] = useState<LifecycleNotice | null>(null);
  const [guard, setGuard] = useState<{
    title: string;
    resolve: (choice: GuardChoice) => void;
  } | null>(null);
  const [newBookDialog, setNewBookDialog] =
    useState<NewBookDialogState | null>(null);
  const [recents, setRecents] = useState<string[]>([]);
  const [dropActive, setDropActive] = useState(false);
  const [queuedPath, setQueuedPath] = useState<string | null>(null);
  const [createdBookId, setCreatedBookId] = useState<string | null>(null);
  const modalOpen = useSyncExternalStore(subscribeModals, anyModalOpen);

  /** Run `task` holding the lifecycle lock; refuses if already held. */
  const exclusive = useCallback(
    async <T,>(task: () => Promise<T>): Promise<T | undefined> => {
      if (lockRef.current) return undefined;
      lockRef.current = true;
      setBusy(true);
      try {
        return await task();
      } finally {
        lockRef.current = false;
        setBusy(false);
        setActivity(null);
      }
    },
    [],
  );

  // ---- recents ---------------------------------------------------------

  const addRecent = useCallback((path: string) => {
    api.addRecentBook(path).then(setRecents, () => undefined);
  }, []);
  const removeRecent = useCallback((path: string) => {
    api.removeRecentBook(path).then(setRecents, () => undefined);
  }, []);
  const clearRecents = useCallback(() => {
    api.clearRecentBooks().then(setRecents, () => undefined);
  }, []);

  // ---- building blocks (call only while holding the lock) -------------

  /**
   * Unified save (M2.4 + M3.3): apply an unapplied editor buffer FIRST,
   * then save — in place when the book has a source, via the save dialog
   * when it doesn't or `alwaysPrompt` is set. True only when everything
   * was persisted; any failure or cancel leaves all changes in place.
   */
  const saveLocked = useCallback(
    async (alwaysPrompt: boolean): Promise<boolean> => {
      const book = readerRef.current.book;
      if (book === null || book.epub_version !== "V3") return false;
      if (!(await readerRef.current.applyEditorBuffer())) return false;
      const inPlace = !alwaysPrompt && book.source !== null;
      let path: string | undefined;
      if (!inPlace) {
        let picked: string | null;
        try {
          picked = await pickSaveEpubPath(
            `${slugifyTitle(book.metadata.title)}.epub`,
          );
        } catch (err) {
          setNotice({
            message: "The save dialog couldn’t be opened.",
            details: rawError(err),
          });
          return false;
        }
        if (picked === null) return false;
        path = picked;
      }
      setActivity("Saving…");
      const result = await readerRef.current.saveBook(path);
      if (!result.ok) {
        setNotice(describeSaveError(result.error, path ?? book.source, inPlace));
        return false;
      }
      setNotice(null);
      if (path !== undefined) addRecent(path);
      return true;
    },
    [addRecent],
  );

  /**
   * The unsaved-changes guard. Resolves true when the transition may
   * proceed: nothing pending, "Don't Save", or a successful Save.
   */
  const passGuardLocked = useCallback(async (): Promise<boolean> => {
    const { book, editorBufferModified } = readerRef.current;
    if (book === null) return true;
    if (!needsUnsavedPrompt(book.dirty, editorBufferModified())) return true;
    const choice = await new Promise<GuardChoice>((resolve) => {
      setGuard({ title: book.metadata.title, resolve });
    });
    setGuard(null);
    if (choice === "cancel") return false;
    if (choice === "dont-save") return true;
    return saveLocked(false);
  }, [saveLocked]);

  const openLocked = useCallback(
    async (path: string): Promise<void> => {
      // Reselecting the open file is not a Revert: no prompt, no reload.
      if (samePath(readerRef.current.book?.source ?? null, path)) return;
      if (!(await passGuardLocked())) return;
      setActivity(`Opening “${fileName(path)}”…`);
      const result = await readerRef.current.openBook(path);
      if (result.ok) {
        setNotice(null);
        addRecent(path);
      } else {
        setNotice(describeOpenError(result.error, path));
        if (isNotFound(result.error)) removeRecent(path);
      }
    },
    [passGuardLocked, addRecent, removeRecent],
  );

  // ---- entry points ----------------------------------------------------

  const requestOpen = useCallback(
    (path?: string) => {
      if (lockRef.current || anyModalOpen()) return;
      void exclusive(async () => {
        let target = path ?? null;
        if (target === null) {
          try {
            target = await pickEpubFile();
          } catch (err) {
            setNotice({
              message: "The open dialog couldn’t be shown.",
              details: rawError(err),
            });
            return;
          }
          if (target === null) return; // cancelled: nothing happens
        }
        await openLocked(target);
      });
    },
    [exclusive, openLocked],
  );

  const openPaths = useCallback(
    (paths: string[]) => {
      const pick = firstEpub(paths);
      if (pick === null) return;
      if ("error" in pick) {
        setNotice({ message: pick.error, details: null });
        return;
      }
      if (lockRef.current || anyModalOpen()) {
        // A decision is on screen: never replace it invisibly — run this
        // request once it settles.
        setQueuedPath(pick.path);
        return;
      }
      requestOpen(pick.path);
    },
    [requestOpen],
  );

  useEffect(() => {
    if (queuedPath === null || busy || modalOpen) return;
    setQueuedPath(null);
    requestOpen(queuedPath);
  }, [queuedPath, busy, modalOpen, requestOpen]);

  const requestNew = useCallback(() => {
    if (lockRef.current || anyModalOpen()) return;
    setNewBookDialog({ error: null });
  }, []);

  const cancelNew = useCallback(() => {
    if (lockRef.current) return;
    setNewBookDialog(null);
  }, []);

  const submitNew = useCallback(
    (metadata: Metadata) => {
      void exclusive(async () => {
        // Guard Cancel returns to the form with its input intact.
        if (!(await passGuardLocked())) return;
        setActivity("Creating book…");
        const result = await readerRef.current.createBook(metadata);
        if (result.ok) {
          setCreatedBookId(result.book.id);
          setNewBookDialog(null);
          setNotice(null);
        } else {
          setNewBookDialog({ error: describeCreateError(result.error) });
        }
      });
    },
    [exclusive, passGuardLocked],
  );

  const requestClose = useCallback(() => {
    if (lockRef.current || anyModalOpen()) return;
    if (readerRef.current.book === null) return;
    void exclusive(async () => {
      if (!(await passGuardLocked())) return;
      await readerRef.current.closeBook();
      setNotice(null);
    });
  }, [exclusive, passGuardLocked]);

  const save = useCallback(
    async (alwaysPrompt = false): Promise<boolean> =>
      (await exclusive(() => saveLocked(alwaysPrompt))) ?? false,
    [exclusive, saveLocked],
  );

  const resolveGuard = useCallback(
    (choice: GuardChoice) => guard?.resolve(choice),
    [guard],
  );

  const dismissNotice = useCallback(() => {
    setNotice(null);
    readerRef.current.clearError();
  }, []);

  // ---- wiring: shortcuts, native menu, shell events, drops, close -----

  useEffect(
    () =>
      onShortcut((action) => {
        switch (action) {
          case "open-book":
            requestOpen();
            break;
          case "new-book":
            requestNew();
            break;
          case "close-book":
            requestClose();
            break;
          case "save":
            if (!anyModalOpen()) void save(false);
            break;
          case "save-as":
            if (!anyModalOpen() && readerRef.current.book !== null) {
              void save(true);
            }
            break;
          default:
            break;
        }
      }),
    [requestOpen, requestNew, requestClose, save],
  );

  // Latest handlers for the long-lived native listeners below.
  const handlersRef = useRef({ openPaths, requestOpen, exclusive, passGuardLocked });
  handlersRef.current = { openPaths, requestOpen, exclusive, passGuardLocked };

  // Shell events: register listeners FIRST, then fetch paths the OS sent
  // before we were listening (Finder cold start) — no gap either way.
  useEffect(() => {
    let disposed = false;
    const subscriptions = Promise.all([
      onOpenFiles((paths) => handlersRef.current.openPaths(paths)),
      onRecentBooksChanged(setRecents),
      onQuitRequested(() => {
        const { exclusive: run, passGuardLocked: passGuard } =
          handlersRef.current;
        void run(async () => {
          if (await passGuard()) await api.quitApp().catch(() => undefined);
        });
      }),
    ]);
    void subscriptions.then(() => {
      if (disposed) return;
      api.listRecentBooks().then(
        (list) => !disposed && setRecents(list),
        () => undefined,
      );
      api.takePendingOpenPaths().then(
        (paths) => !disposed && handlersRef.current.openPaths(paths),
        () => undefined,
      );
    });
    return () => {
      disposed = true;
      void subscriptions.then((stops) => stops.forEach((stop) => stop()));
    };
  }, []);

  // OS file drags: overlay while an .epub hovers, open on drop. Ignored
  // while a decision is pending. Image drops in the editor are left to the
  // editor (no "EPUB only" complaint while editing).
  useEffect(() => {
    const accepting = () => !lockRef.current && !anyModalOpen();
    const unlisten = onFileDragDrop((event) => {
      switch (event.type) {
        case "enter":
          setDropActive(accepting() && event.paths.some(isEpubPath));
          break;
        case "leave":
          setDropActive(false);
          break;
        case "drop": {
          setDropActive(false);
          if (!accepting()) return;
          const pick = firstEpub(event.paths);
          if (pick === null) return;
          if ("error" in pick) {
            if (!readerRef.current.editing) {
              setNotice({ message: pick.error, details: null });
            }
            return;
          }
          handlersRef.current.requestOpen(pick.path);
          break;
        }
        default:
          break;
      }
    });
    return () => {
      void unlisten.then((stop) => stop());
    };
  }, []);

  // Red close button: clean → closes; dirty → guard, then destroy (which
  // skips close-requested, so the guard never re-triggers itself).
  useEffect(() => {
    const unlisten = onCloseRequested((event) => {
      if (lockRef.current) {
        event.preventDefault();
        return;
      }
      const { book, editorBufferModified } = readerRef.current;
      const pending =
        book !== null && needsUnsavedPrompt(book.dirty, editorBufferModified());
      if (interceptClose(pending, event)) {
        const { exclusive: run, passGuardLocked: passGuard } =
          handlersRef.current;
        void run(async () => {
          if (await passGuard()) await destroyWindow();
        });
      }
    });
    return () => {
      void unlisten.then((stop) => stop());
    };
  }, []);

  // Native window title follows the document identity.
  const book = reader.book;
  const title = windowTitleFor(book);
  useEffect(() => {
    void setWindowTitle(title);
  }, [title]);

  // Native menu enablement follows the document state.
  const hasBook = book !== null;
  const editable = book !== null && book.epub_version === "V3";
  const menuBusy = busy || modalOpen;
  useEffect(() => {
    api.setMenuState({ hasBook, editable, busy: menuBusy }).catch(() => undefined);
  }, [hasBook, editable, menuBusy]);

  // Delayed activity status.
  useEffect(() => {
    if (activity === null) {
      setShowActivity(false);
      return;
    }
    const timer = window.setTimeout(() => setShowActivity(true), ACTIVITY_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [activity]);

  const value = useMemo<LifecycleState>(
    () => ({
      busy,
      activityLabel: showActivity ? activity : null,
      recents,
      notice,
      dismissNotice,
      guardTitle: guard?.title ?? null,
      resolveGuard,
      newBookDialog,
      requestNew,
      cancelNew,
      submitNew,
      requestOpen,
      openPaths,
      requestClose,
      save,
      clearRecents,
      dropActive,
      createdBookId,
    }),
    [
      busy,
      showActivity,
      activity,
      recents,
      notice,
      dismissNotice,
      guard,
      resolveGuard,
      newBookDialog,
      requestNew,
      cancelNew,
      submitNew,
      requestOpen,
      openPaths,
      requestClose,
      save,
      clearRecents,
      dropActive,
      createdBookId,
    ],
  );

  return (
    <LifecycleContext.Provider value={value}>{children}</LifecycleContext.Provider>
  );
}

export function useLifecycle(): LifecycleState {
  const ctx = useContext(LifecycleContext);
  if (ctx === null) {
    throw new Error("useLifecycle must be used within a LifecycleProvider");
  }
  return ctx;
}
