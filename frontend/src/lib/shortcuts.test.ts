import { describe, expect, it } from "vitest";
import {
  DEDUPE_WINDOW_MS,
  dispatchShortcut,
  handleShortcutKeydown,
  matchShortcut,
  menuActionFor,
  onShortcut,
  shouldDispatch,
  type DispatchRecord,
  type KeyCombo,
  type ShortcutAction,
} from "./shortcuts";

function combo(overrides: Partial<KeyCombo> & { key: string }): KeyCombo {
  return {
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...overrides,
  };
}

describe("matchShortcut", () => {
  it("matches the primary-modifier table with Cmd (macOS)", () => {
    const meta = (key: string, extra: Partial<KeyCombo> = {}) =>
      matchShortcut(combo({ key, metaKey: true, ...extra }));
    expect(meta("n")).toBe("new-book");
    expect(meta("o")).toBe("open-book");
    expect(meta("s")).toBe("save");
    expect(meta("e")).toBe("toggle-edit");
    expect(meta("1")).toBe("sidebar-contents");
    expect(meta("2")).toBe("sidebar-chapters");
    expect(meta("3")).toBe("sidebar-checks");
    expect(meta("S", { shiftKey: true })).toBe("save-as");
    expect(meta("L", { shiftKey: true })).toBe("toggle-layout");
    expect(meta("T", { shiftKey: true })).toBe("cycle-theme");
    expect(meta("ArrowLeft", { altKey: true })).toBe("prev-chapter");
    expect(meta("ArrowRight", { altKey: true })).toBe("next-chapter");
  });

  it("accepts Ctrl as the primary modifier (Windows/Linux)", () => {
    expect(matchShortcut(combo({ key: "s", ctrlKey: true }))).toBe("save");
    expect(
      matchShortcut(combo({ key: "ArrowRight", ctrlKey: true, altKey: true })),
    ).toBe("next-chapter");
  });

  it("requires the primary modifier — plain typing keys never match", () => {
    for (const key of ["s", "e", "o", "n", "1", "ArrowLeft", " "]) {
      expect(matchShortcut(combo({ key }))).toBeNull();
    }
    // Shift alone is still typing (capital letters).
    expect(matchShortcut(combo({ key: "S", shiftKey: true }))).toBeNull();
  });

  it("leaves the reader-local keys (PR #83) alone", () => {
    // Plain arrows, paging keys, and Space belong to the reader/page-turn
    // layer; the app table must not claim them in any plain/shift form.
    for (const key of ["ArrowLeft", "ArrowRight", "PageUp", "PageDown", " "]) {
      expect(matchShortcut(combo({ key }))).toBeNull();
      expect(matchShortcut(combo({ key, shiftKey: true }))).toBeNull();
    }
  });

  it("does not misfire on near-miss chords", () => {
    // Alt combines only with the arrow chords.
    expect(
      matchShortcut(combo({ key: "s", metaKey: true, altKey: true })),
    ).toBeNull();
    expect(
      matchShortcut(
        combo({ key: "ArrowLeft", metaKey: true, altKey: true, shiftKey: true }),
      ),
    ).toBeNull();
    // Mod+Arrow without Alt is the caret/line shortcut — not ours.
    expect(matchShortcut(combo({ key: "ArrowLeft", metaKey: true }))).toBeNull();
    // Unknown letters.
    expect(matchShortcut(combo({ key: "q", metaKey: true }))).toBeNull();
    expect(
      matchShortcut(combo({ key: "q", metaKey: true, shiftKey: true })),
    ).toBeNull();
  });
});

describe("menuActionFor", () => {
  it("maps every menu id straight onto its action", () => {
    const ids: ShortcutAction[] = [
      "new-book",
      "open-book",
      "save",
      "save-as",
      "toggle-edit",
      "prev-chapter",
      "next-chapter",
      "toggle-layout",
      "cycle-theme",
      "sidebar-contents",
      "sidebar-chapters",
      "sidebar-checks",
    ];
    for (const id of ids) expect(menuActionFor(id)).toBe(id);
  });

  it("rejects unknown ids (predefined menu items, future ids)", () => {
    expect(menuActionFor("copy")).toBeNull();
    expect(menuActionFor("")).toBeNull();
    expect(menuActionFor("quit")).toBeNull();
  });
});

describe("shouldDispatch (menu/DOM double-delivery dedupe)", () => {
  it("suppresses the cross-source echo inside the window, allows it after", () => {
    const last = new Map<ShortcutAction, DispatchRecord>();
    expect(shouldDispatch("save", "key", 1000, last)).toBe(true);
    // Menu echo of the same physical press: suppressed.
    expect(
      shouldDispatch("save", "menu", 1000 + DEDUPE_WINDOW_MS - 1, last),
    ).toBe(false);
    expect(shouldDispatch("save", "menu", 1000 + DEDUPE_WINDOW_MS, last)).toBe(
      true,
    );
  });

  it("never suppresses same-source repeats (fast double-taps, key repeat)", () => {
    const last = new Map<ShortcutAction, DispatchRecord>();
    expect(shouldDispatch("toggle-edit", "key", 1000, last)).toBe(true);
    expect(shouldDispatch("toggle-edit", "key", 1001, last)).toBe(true);
    expect(shouldDispatch("toggle-edit", "menu", 2000, last)).toBe(true);
    expect(shouldDispatch("toggle-edit", "menu", 2001, last)).toBe(true);
  });

  it("never suppresses a different action", () => {
    const last = new Map<ShortcutAction, DispatchRecord>();
    expect(shouldDispatch("save", "key", 1000, last)).toBe(true);
    expect(shouldDispatch("save-as", "menu", 1001, last)).toBe(true);
    expect(shouldDispatch("toggle-edit", "menu", 1002, last)).toBe(true);
  });
});

describe("dispatch/onShortcut bus", () => {
  it("delivers dispatched actions to subscribers until unsubscribed", () => {
    const seen: ShortcutAction[] = [];
    const off = onShortcut((action) => seen.push(action));
    dispatchShortcut("sidebar-contents");
    expect(seen).toEqual(["sidebar-contents"]);
    off();
    dispatchShortcut("sidebar-chapters");
    expect(seen).toEqual(["sidebar-contents"]);
  });

  it("dedupes an immediate cross-source duplicate (one physical press)", () => {
    const seen: ShortcutAction[] = [];
    const off = onShortcut((action) => seen.push(action));
    dispatchShortcut("cycle-theme", "key");
    dispatchShortcut("cycle-theme", "menu"); // echo of the same press
    off();
    expect(seen).toEqual(["cycle-theme"]);
  });
});

describe("handleShortcutKeydown", () => {
  it("prevents default and dispatches on a match", () => {
    const seen: ShortcutAction[] = [];
    const off = onShortcut((action) => seen.push(action));
    const event = new KeyboardEvent("keydown", {
      key: "o",
      metaKey: true,
      cancelable: true,
    });
    handleShortcutKeydown(event);
    off();
    expect(event.defaultPrevented).toBe(true);
    expect(seen).toEqual(["open-book"]);
  });

  it("ignores non-shortcut keys entirely", () => {
    const seen: ShortcutAction[] = [];
    const off = onShortcut((action) => seen.push(action));
    const event = new KeyboardEvent("keydown", {
      key: "ArrowRight",
      cancelable: true,
    });
    handleShortcutKeydown(event);
    off();
    expect(event.defaultPrevented).toBe(false);
    expect(seen).toEqual([]);
  });
});
