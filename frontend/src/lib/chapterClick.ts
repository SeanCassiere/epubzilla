// Chapter-iframe click handling (issue #84). No React, no Tauri — pure
// decision logic for one click inside the sandboxed chapter document:
// inter-chapter link navigation on annotated `data-epub-link` anchors
// (see chapter.ts).
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
  preventDefault: () => void;
}

/** Reader state and actions the click decision depends on. */
export interface ChapterClickContext {
  /** Navigate the APP to a resource path + optional fragment. */
  goToResource: (path: string, fragment: string | null) => void;
}

/**
 * Handle one click inside the chapter document: a click on/inside an
 * `a[data-epub-link]` navigates the app to the target chapter (honoring
 * `#fragment`) and calls preventDefault so the sandboxed iframe never
 * follows the raw relative href itself.
 *
 * Returns true when the click was consumed (navigation).
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
  return false;
}
