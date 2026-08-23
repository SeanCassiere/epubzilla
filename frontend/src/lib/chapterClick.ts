// Chapter-iframe click handling (issue #84). No React, no Tauri — pure
// decision logic for one click inside the sandboxed chapter document:
// inter-chapter link navigation first (annotated `data-epub-link` anchors,
// see chapter.ts), then the paginated click page-turn zones (issue #75).
//
// Realm caveat, and the reason this module exists: the click listener runs
// in the parent window but receives nodes from the IFRAME's realm, where
// `node instanceof Element` against the parent's `Element` constructor is
// always false. That guard silently disabled link interception for every
// book (issue #84) — and jsdom is single-realm, so component tests could
// never catch it. Everything here is therefore realm-agnostic (duck-typed
// on nodeType/closest, never instanceof) and unit-tested with
// foreign-realm-like fakes that fail `instanceof Element` on purpose.

import { splitHref } from "./toc";
import type { ReadingMode } from "./readingMode";

/** `Node.ELEMENT_NODE` without depending on any realm's `Node` global. */
const ELEMENT_NODE = 1;

/**
 * Realm-agnostic `event.target` -> `Element` guard: accepts any object
 * that structurally is a DOM element (element nodeType plus a callable
 * `closest`), regardless of which window/realm constructed it. Never use
 * `instanceof Element` on event targets from the chapter iframe — that is
 * exactly the cross-realm bug this replaces (issue #84).
 */
export function eventTargetElement(target: unknown): Element | null {
  if (typeof target !== "object" || target === null) return null;
  const node = target as { nodeType?: unknown; closest?: unknown };
  if (node.nodeType !== ELEMENT_NODE) return null;
  if (typeof node.closest !== "function") return null;
  return target as Element;
}

/** The parts of a click event the handler needs (realm-free). */
export interface ChapterClickEvent {
  /** Raw `event.target` — typed unknown because it crosses realms. */
  target: unknown;
  clientX: number;
  preventDefault: () => void;
}

/** Reader state and actions the click decision depends on. */
export interface ChapterClickContext {
  mode: ReadingMode;
  /** Iframe viewport width in CSS px; <= 0 disables the click zones. */
  viewportWidth: number;
  /** False while the user has an active text selection in the chapter. */
  selectionCollapsed: boolean;
  /** Navigate the APP to a resource path + optional fragment. */
  goToResource: (path: string, fragment: string | null) => void;
  turnPage: (delta: 1 | -1) => void;
}

/**
 * Handle one click inside the chapter document.
 *
 * Priority order (links always beat page turns):
 * 1. A click on/inside an `a[data-epub-link]` navigates the app to the
 *    target chapter (honoring `#fragment`) and calls preventDefault so
 *    the sandboxed iframe never follows the raw relative href itself.
 * 2. Otherwise, in paginated mode, clicks in the outer thirds of the
 *    viewport turn the page — unless the click is inside ANY anchor
 *    (stripped external links stay inert, they don't turn pages) or a
 *    text selection is active. The middle third stays inert.
 *
 * Returns true when the click was consumed (navigation or page turn).
 */
export function handleChapterClick(
  event: ChapterClickEvent,
  ctx: ChapterClickContext,
): boolean {
  const target = eventTargetElement(event.target);
  if (target === null) return false;
  const anchor = target.closest("a[data-epub-link]");
  const link = anchor?.getAttribute("data-epub-link");
  if (link !== null && link !== undefined) {
    // Navigate the app, never the iframe.
    event.preventDefault();
    const { path, fragment } = splitHref(link);
    ctx.goToResource(path, fragment);
    return true;
  }
  // Paginated click page-turn (issue #75): outer thirds of the viewport
  // turn the page; the middle third stays inert so text selection and
  // in-page links behave normally.
  if (ctx.mode !== "paginated") return false;
  if (target.closest("a") !== null) return false;
  if (!ctx.selectionCollapsed) return false;
  if (ctx.viewportWidth <= 0) return false;
  if (event.clientX >= (ctx.viewportWidth * 2) / 3) {
    ctx.turnPage(1);
    return true;
  }
  if (event.clientX <= ctx.viewportWidth / 3) {
    ctx.turnPage(-1);
    return true;
  }
  return false;
}
