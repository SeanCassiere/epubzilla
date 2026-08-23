// Pure TOC tree helpers (M1.4). No React, no Tauri — unit-testable logic
// for locating the current chapter in the nav tree and deciding which
// nodes are expanded. `NavPoint.href` is a zip-internal resource path plus
// optional `#fragment`; `null` marks a section header (domain-model.md).

import type { NavPoint } from "@bindings/NavPoint";

/** A nav href split into its resource path and optional fragment id. */
export interface HrefTarget {
  path: string;
  fragment: string | null;
}

/** Splits `"OEBPS/ch1.xhtml#sec2"` into path + fragment (null if absent). */
export function splitHref(href: string): HrefTarget {
  const hash = href.indexOf("#");
  if (hash === -1) return { path: href, fragment: null };
  return { path: href.slice(0, hash), fragment: href.slice(hash + 1) || null };
}

/** Position of a node in the nav tree as child indices from the root. */
export type TocPath = ReadonlyArray<number>;

/** Stable string key for a tree position, e.g. `[0,2,1]` -> `"0.2.1"`. */
export function pathKey(path: TocPath): string {
  return path.join(".");
}

/**
 * DFS (document order) for the FIRST nav entry whose href resource path —
 * fragment ignored — equals `resourcePath`. Multiple entries may point at
 * one chapter; document order makes "first" deterministic. Returns the
 * tree path of the match, or null.
 */
export function findCurrentTocPath(
  nav: ReadonlyArray<NavPoint>,
  resourcePath: string,
): number[] | null {
  for (let i = 0; i < nav.length; i += 1) {
    const point = nav[i];
    if (point.href !== null && splitHref(point.href).path === resourcePath) {
      return [i];
    }
    const inChildren = findCurrentTocPath(point.children, resourcePath);
    if (inChildren !== null) return [i, ...inChildren];
  }
  return null;
}

/** Keys of the PROPER ancestors of a tree path (excludes the node itself). */
export function ancestorKeys(path: TocPath): string[] {
  const keys: string[] = [];
  for (let len = 1; len < path.length; len += 1) {
    keys.push(pathKey(path.slice(0, len)));
  }
  return keys;
}

/**
 * Effective expansion of one node: an explicit user toggle always wins;
 * otherwise depth-0 nodes are expanded and everything deeper is collapsed
 * unless it is an ancestor of the current chapter (auto-expansion). The
 * collapsed-by-default deep tree keeps a 500-chapter TOC cheap: children
 * of collapsed nodes are never mounted.
 */
export function isNodeExpanded(
  key: string,
  depth: number,
  manual: ReadonlyMap<string, boolean>,
  autoExpanded: ReadonlySet<string>,
): boolean {
  const toggled = manual.get(key);
  if (toggled !== undefined) return toggled;
  return depth === 0 || autoExpanded.has(key);
}

/** Total nav entries (all depths) — used to size the tree for a11y. */
export function countNavPoints(nav: ReadonlyArray<NavPoint>): number {
  let total = 0;
  for (const point of nav) {
    total += 1 + countNavPoints(point.children);
  }
  return total;
}

/**
 * Intent of one key press inside the TOC tree (issue #74). Standard
 * tree-view keyboard model: Up/Down walk visible entries, Home/End jump
 * to the edges, Right expands (or moves on), Left collapses (or climbs
 * to the parent). Enter/Space activate natively (the rows are buttons).
 */
export type TocKeyIntent =
  | "next"
  | "previous"
  | "first"
  | "last"
  | "expand-or-next"
  | "collapse-or-parent";

/** Map a KeyboardEvent.key to its tree intent (null = not a tree key). */
export function tocKeyIntent(key: string): TocKeyIntent | null {
  switch (key) {
    case "ArrowDown":
      return "next";
    case "ArrowUp":
      return "previous";
    case "Home":
      return "first";
    case "End":
      return "last";
    case "ArrowRight":
      return "expand-or-next";
    case "ArrowLeft":
      return "collapse-or-parent";
    default:
      return null;
  }
}

/** Parent of a tree-path key: `"0.2.1"` -> `"0.2"`; roots have none. */
export function parentKey(key: string): string | null {
  const dot = key.lastIndexOf(".");
  return dot === -1 ? null : key.slice(0, dot);
}

/**
 * Keyboard guard for ArrowLeft/ArrowRight chapter shortcuts: ignore the
 * keys while focus sits in a text-entry control so caret movement wins.
 */
export function shouldHandleNavKey(
  tagName: string | null,
  isContentEditable: boolean,
): boolean {
  if (isContentEditable) return false;
  if (tagName === null) return true;
  const tag = tagName.toUpperCase();
  return tag !== "INPUT" && tag !== "TEXTAREA" && tag !== "SELECT";
}
