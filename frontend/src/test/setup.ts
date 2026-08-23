// Shared vitest setup (vitest.config.ts `setupFiles`).
//
// jsdom does not implement window.matchMedia; the reader uses it to track
// the system color scheme for the dark reading theme (issue #78). This
// stub answers "(prefers-color-scheme: dark)" from a mutable flag —
// light by default, flipped per-test via setSystemDark — and dispatches
// change events to registered listeners like the real MediaQueryList.

import { afterEach } from "vitest";

type SchemeListener = (event: MediaQueryListEvent) => void;

const DARK_QUERY = "(prefers-color-scheme: dark)";

let systemDark = false;
const darkListeners = new Set<SchemeListener>();

/** Flip the stubbed system scheme and notify live media-query listeners. */
export function setSystemDark(dark: boolean): void {
  if (systemDark === dark) return;
  systemDark = dark;
  const event = { matches: dark, media: DARK_QUERY } as MediaQueryListEvent;
  for (const listener of darkListeners) listener(event);
}

function makeMediaQueryList(query: string): MediaQueryList {
  const isDarkQuery = query === DARK_QUERY;
  return {
    get matches() {
      return isDarkQuery && systemDark;
    },
    media: query,
    onchange: null,
    addEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => {
      if (isDarkQuery && typeof listener === "function") {
        darkListeners.add(listener as SchemeListener);
      }
    },
    removeEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => {
      if (typeof listener === "function") {
        darkListeners.delete(listener as SchemeListener);
      }
    },
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  } as MediaQueryList;
}

// In-memory localStorage: vitest's jsdom global population does not expose
// jsdom's own localStorage, and the reader persists the reading-theme
// preference there (issue #78). Minimal Storage-shaped stub.
const store = new Map<string, string>();
const localStorageStub: Storage = {
  get length() {
    return store.size;
  },
  clear: () => store.clear(),
  getItem: (key: string) => store.get(key) ?? null,
  key: (index: number) => Array.from(store.keys())[index] ?? null,
  removeItem: (key: string) => void store.delete(key),
  setItem: (key: string, value: string) => void store.set(key, String(value)),
};
Object.defineProperty(window, "localStorage", {
  writable: true,
  configurable: true,
  value: localStorageStub,
});

// Isolate tests: back to the light scheme, drop stale listeners, and
// clear persisted UI preferences (e.g. the reading-theme localStorage key).
afterEach(() => {
  systemDark = false;
  darkListeners.clear();
  window.localStorage.clear();
});

Object.defineProperty(window, "matchMedia", {
  writable: true,
  configurable: true,
  value: (query: string) => makeMediaQueryList(query),
});
