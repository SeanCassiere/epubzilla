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
//  - nothing changes behind a decision: while the lock is held the reader
//    is frozen (editor read-only, mutations and chapter navigation
//    refused), edits already in flight settle — their resulting model
//    visible to the guard before React re-renders — before it looks, and
//    the document revision is re-checked after the guard and before the
//    previous book is released — newer changes re-run the guard;
//  - Quit and the red close button are never dead: with nothing unsaved
//    they go ahead even mid-operation; otherwise they wait for the
//    operation and then run the guard. Quit requests are acknowledged
//    while the app can visibly answer them (idle, or a decision — picker,
//    sheet — on screen); a repeat that arrives while an operation or an
//    exit's save is working stays unacknowledged until a decision shows,
//    so the shell's native "Quit anyway?" fallback can fire if it hangs;
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
import { isImagePath, needsUnsavedPrompt } from "../lib/editing";
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

/** What the lifecycle lock is held for (exit requests treat exits apart). */
type OperationKind = "exit" | "other";

/** An exit request waiting for the current operation to finish. */
type QueuedExit = "quit" | "close";

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

/** saveLocked's answer: success, and the revision the save persisted. */
interface SaveOutcome {
  ok: boolean;
  revision: number;
}

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
  const [queuedExit, setQueuedExitState] = useState<QueuedExit | null>(null);
  const queuedExitRef = useRef<QueuedExit | null>(null);
  const setQueuedExit = useCallback((next: QueuedExit | null) => {
    queuedExitRef.current = next;
    setQueuedExitState(next);
  }, []);
  const operationRef = useRef<OperationKind | null>(null);
  // An interactive decision (picker, unsaved sheet, save dialog) of the
  // current operation is on screen, so a repeat Quit can be answered.
  const decidingRef = useRef(false);
  // Newest quit request left unacknowledged while the operation works.
  const pendingAckRef = useRef<number | null>(null);

  const ackQuit = useCallback((request: number | null) => {
    if (request !== null) api.ackQuitRequest(request).catch(() => undefined);
  }, []);
  /** Acknowledge the held request (and, shell-side, every older one). */
  const flushPendingAck = useCallback(() => {
    const request = pendingAckRef.current;
    pendingAckRef.current = null;
    ackQuit(request);
  }, [ackQuit]);
  /** Hold `request` until the app can visibly answer it. */
  const deferAck = useCallback((request: number | null) => {
    if (request === null) return;
    pendingAckRef.current = Math.max(pendingAckRef.current ?? 0, request);
  }, []);
  /**
   * Await a user decision (picker, sheet). While it is on screen the app
   * is visibly responsive, so held quit requests are acknowledged.
   */
  const awaitDecision = useCallback(
    async <T,>(prompt: () => Promise<T>): Promise<T> => {
      decidingRef.current = true;
      flushPendingAck();
      try {
        return await prompt();
      } finally {
        decidingRef.current = false;
      }
    },
    [flushPendingAck],
  );
  const modalOpen = useSyncExternalStore(subscribeModals, anyModalOpen);

  /**
   * Run `task` holding the lifecycle lock; refuses if already held. The
   * reader is frozen for the whole operation, and mutations already in
   * flight settle before `task` looks at the document.
   */
  const exclusive = useCallback(
    async <T,>(
      task: () => Promise<T>,
      kind: OperationKind = "other",
    ): Promise<T | undefined> => {
      if (lockRef.current) return undefined;
      lockRef.current = true;
      operationRef.current = kind;
      readerRef.current.setFrozen(true);
      setBusy(true);
      try {
        await readerRef.current.settle();
        return await task();
      } finally {
        lockRef.current = false;
        operationRef.current = null;
        decidingRef.current = false;
        // Responsive again: whatever was held is answered by what follows
        // (a queued quit's guard, or nothing because the quit happened).
        flushPendingAck();
        readerRef.current.setFrozen(false);
        setBusy(false);
        setActivity(null);
      }
    },
    [flushPendingAck],
  );

  /**
   * Unsaved work right now: dirty book or unapplied editor buffer. Reads
   * the reader's synchronous snapshot, so a mutation that settled a moment
   * ago counts even before React re-rendered.
   */
  const hasUnsaved = useCallback((): boolean => {
    const { latestBook, editorBufferModified } = readerRef.current;
    const book = latestBook();
    return book !== null && needsUnsavedPrompt(book.dirty, editorBufferModified());
  }, []);

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
    async (alwaysPrompt: boolean): Promise<SaveOutcome> => {
      const failed: SaveOutcome = { ok: false, revision: 0 };
      const book = readerRef.current.latestBook();
      if (book === null || book.epub_version !== "V3") return failed;
      if (!(await readerRef.current.applyEditorBuffer())) return failed;
      // What this save persists: anything newer than this is still unsaved.
      const revision = readerRef.current.revision();
      const inPlace = !alwaysPrompt && book.source !== null;
      let path: string | undefined;
      if (!inPlace) {
        let picked: string | null;
        try {
          picked = await awaitDecision(() =>
            pickSaveEpubPath(`${slugifyTitle(book.metadata.title)}.epub`),
          );
        } catch (err) {
          setNotice({
            message: "The save dialog couldn’t be opened.",
            details: rawError(err),
          });
          return failed;
        }
        if (picked === null) return failed;
        path = picked;
      }
      setActivity("Saving…");
      const result = await readerRef.current.saveBook(path);
      if (!result.ok) {
        setNotice(describeSaveError(result.error, path ?? book.source, inPlace));
        return failed;
      }
      setNotice(null);
      if (path !== undefined) addRecent(path);
      return { ok: true, revision };
    },
    [addRecent, awaitDecision],
  );

  /**
   * The unsaved-changes guard. Resolves true when the transition may
   * proceed: nothing pending, "Don't Save", or a successful Save. If the
   * document changed after the decision was made or the save took its
   * snapshot, the guard asks again rather than lose those changes.
   * `force` asks even when the reader's state does not (yet) look dirty.
   */
  const passGuardLocked = useCallback(
    async (force = false): Promise<boolean> => {
      let ask = force;
      for (;;) {
        const { latestBook, revision } = readerRef.current;
        const book = latestBook();
        if (book === null) return true;
        if (!ask && !hasUnsaved()) return true;
        const before = revision();
        const choice = await awaitDecision(
          () =>
            new Promise<GuardChoice>((resolve) => {
              setGuard({ title: book.metadata.title, resolve });
            }),
        );
        setGuard(null);
        if (choice === "cancel") return false;
        if (choice === "dont-save") {
          if (revision() === before) return true;
        } else {
          const saved = await saveLocked(false);
          if (!saved.ok) return false;
          if (revision() === saved.revision) return true;
        }
        ask = true; // changed meanwhile: those changes are unsaved
      }
    },
    [hasUnsaved, saveLocked, awaitDecision],
  );

  /**
   * After the guard passed: options for openBook/createBook that re-check
   * the document revision once the replacement was acquired and before the
   * current book is released, re-running the guard on newer changes.
   */
  const confirmUnchangedSince = useCallback(
    (revision: number) => ({
      confirm: async () =>
        readerRef.current.revision() === revision || passGuardLocked(true),
    }),
    [passGuardLocked],
  );

  const openLocked = useCallback(
    async (path: string): Promise<void> => {
      // Reselecting the open file is not a Revert: no prompt, no reload.
      if (samePath(readerRef.current.latestBook()?.source ?? null, path)) return;
      if (!(await passGuardLocked())) return;
      const revision = readerRef.current.revision();
      setActivity(`Opening “${fileName(path)}”…`);
      const result = await readerRef.current.openBook(
        path,
        confirmUnchangedSince(revision),
      );
      if (!result.ok && result.cancelled === true) return;
      if (result.ok) {
        setNotice(null);
        addRecent(path);
      } else {
        setNotice(describeOpenError(result.error, path));
        if (isNotFound(result.error)) removeRecent(path);
      }
    },
    [passGuardLocked, confirmUnchangedSince, addRecent, removeRecent],
  );

  // ---- entry points ----------------------------------------------------

  const requestOpen = useCallback(
    (path?: string) => {
      if (lockRef.current || anyModalOpen()) return;
      void exclusive(async () => {
        let target = path ?? null;
        if (target === null) {
          try {
            target = await awaitDecision(pickEpubFile);
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
    [exclusive, openLocked, awaitDecision],
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
        const revision = readerRef.current.revision();
        setActivity("Creating book…");
        const result = await readerRef.current.createBook(
          metadata,
          confirmUnchangedSince(revision),
        );
        if (result.ok) {
          setNewBookDialog(null);
          setNotice(null);
        } else if (result.cancelled !== true) {
          setNewBookDialog({ error: describeCreateError(result.error) });
        }
      });
    },
    [exclusive, passGuardLocked, confirmUnchangedSince],
  );

  const requestClose = useCallback(() => {
    if (lockRef.current || anyModalOpen()) return;
    if (readerRef.current.latestBook() === null) return;
    void exclusive(async () => {
      if (!(await passGuardLocked())) return;
      await readerRef.current.closeBook();
      setNotice(null);
    });
  }, [exclusive, passGuardLocked]);

  const save = useCallback(
    async (alwaysPrompt = false): Promise<boolean> =>
      (await exclusive(() => saveLocked(alwaysPrompt)))?.ok ?? false,
    [exclusive, saveLocked],
  );

  /**
   * ⌘Q / Quit (`request`: the shell's request id to acknowledge; null when
   * replayed from the queue). Never dead: idle → guard, then quit;
   * mid-operation with nothing unsaved → quit now; mid-operation with
   * unsaved work → queued, run once the operation finishes.
   *
   * A repeat that the running exit or the queued quit already covers is
   * acknowledged only while a decision (picker, sheet) is on screen. While
   * the operation is working (IPC, settling, applying, saving) it is held
   * unacknowledged until a decision appears or the operation ends — so a
   * healthy app never looks hung behind its own sheet, and one stuck in a
   * save gets the shell's native "Quit anyway?" after its timeout.
   */
  const requestQuit = useCallback(
    (request: number | null = null): void => {
      const answerRepeat = () => {
        if (decidingRef.current) ackQuit(request);
        else deferAck(request);
      };
      if (lockRef.current) {
        if (operationRef.current === "exit") {
          answerRepeat();
          return;
        }
        if (!hasUnsaved()) {
          ackQuit(request);
          void api.quitApp().catch(() => undefined);
          return;
        }
        if (queuedExitRef.current === "quit") {
          answerRepeat();
          return;
        }
        ackQuit(request);
        setQueuedExit("quit");
        return;
      }
      ackQuit(request);
      void exclusive(async () => {
        if (await passGuardLocked()) await api.quitApp().catch(() => undefined);
      }, "exit");
    },
    [exclusive, hasUnsaved, passGuardLocked, setQueuedExit, ackQuit, deferAck],
  );

  /** Red close button with unsaved work: guard, then destroy the window. */
  const closeWindowGuarded = useCallback(() => {
    void exclusive(async () => {
      if (await passGuardLocked()) await destroyWindow();
    }, "exit");
  }, [exclusive, passGuardLocked]);

  // Exit requests that arrived mid-operation run as soon as it finishes
  // (before any queued Finder open: the user asked to leave).
  useEffect(() => {
    if (queuedExit === null || busy) return;
    setQueuedExit(null);
    if (queuedExit === "quit") requestQuit();
    else if (hasUnsaved()) closeWindowGuarded();
    else void destroyWindow();
  }, [queuedExit, busy, setQueuedExit, requestQuit, closeWindowGuarded, hasUnsaved]);

  useEffect(() => {
    if (queuedPath === null || queuedExit !== null || busy || modalOpen) return;
    setQueuedPath(null);
    requestOpen(queuedPath);
  }, [queuedPath, queuedExit, busy, modalOpen, requestOpen]);

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
            if (!anyModalOpen() && readerRef.current.latestBook() !== null) {
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
  const handlersRef = useRef({
    openPaths,
    requestOpen,
    requestQuit,
    closeWindowGuarded,
    hasUnsaved,
  });
  handlersRef.current = {
    openPaths,
    requestOpen,
    requestQuit,
    closeWindowGuarded,
    hasUnsaved,
  };

  // Shell events: register listeners FIRST, then fetch paths the OS sent
  // before we were listening (Finder cold start) — no gap either way.
  useEffect(() => {
    let disposed = false;
    const subscriptions = Promise.all([
      onOpenFiles((paths) => handlersRef.current.openPaths(paths)),
      onRecentBooksChanged(setRecents),
      // requestQuit acknowledges (or deliberately holds) the request: the
      // shell treats an unacknowledged one as a hung webview and asks
      // natively.
      onQuitRequested((request) => handlersRef.current.requestQuit(request)),
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
      // Nobody will answer quit requests or take Finder opens now.
      api.detachFrontend().catch(() => undefined);
      void subscriptions.then((stops) => stops.forEach((stop) => stop()));
    };
  }, []);

  // OS file drags: overlay while an .epub hovers, open on drop. Ignored
  // while a decision is pending. While editing, dropped image files go
  // into the chapter through the editor's insert-image path: the native
  // webview intercepts Finder drops, so the editor's own HTML5 drop
  // handler never sees them (no "EPUB only" complaint while editing).
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
          const reader = readerRef.current;
          if (reader.editing && !event.paths.some(isEpubPath)) {
            const images = event.paths.filter(isImagePath);
            if (images.length > 0) void reader.insertEditorImages(images);
            return;
          }
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

  // Red close button: clean → closes (even mid-operation); dirty → guard,
  // then destroy (which skips close-requested, so the guard never
  // re-triggers itself). Mid-operation with unsaved work, the close waits
  // for the operation and then runs the guard.
  useEffect(() => {
    const unlisten = onCloseRequested((event) => {
      const handlers = handlersRef.current;
      if (!interceptClose(handlers.hasUnsaved(), event)) return;
      if (!lockRef.current) {
        handlers.closeWindowGuarded();
      } else if (operationRef.current !== "exit") {
        if (queuedExitRef.current === null) setQueuedExit("close");
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
      createdBookId: reader.createdBookId,
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
      reader.createdBookId,
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
