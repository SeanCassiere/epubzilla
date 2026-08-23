// Regression coverage for issue #84: the chapter-iframe click listener
// receives event targets from the IFRAME's realm, where a parent-realm
// `instanceof Element` check is always false — so link interception
// silently never ran and the sandboxed frame followed raw relative hrefs.
// jsdom is single-realm (and never loads srcdoc), so component tests
// cannot exercise the cross-realm path; instead these tests drive the
// extracted handler with FOREIGN-REALM-LIKE fakes: plain objects that are
// structurally DOM elements but deliberately fail `instanceof Element`,
// exactly like a node constructed by another window would.

import { describe, expect, it, vi } from "vitest";
import {
  eventTargetElement,
  handleChapterClick,
  type ChapterClickContext,
  type ChapterClickEvent,
} from "./chapterClick";

/**
 * A minimal element from a "different realm": structurally a DOM element
 * (nodeType 1, callable closest/getAttribute) but NOT an instance of this
 * realm's Element — the exact shape that broke the old instanceof guard.
 */
interface ForeignElement {
  nodeType: number;
  closest: (selector: string) => ForeignElement | null;
  getAttribute: (name: string) => string | null;
}

/** Foreign-realm-like anchor carrying (or not) a data-epub-link. */
function foreignAnchor(epubLink: string | null): ForeignElement {
  const anchor: ForeignElement = {
    nodeType: 1,
    closest: (selector) => {
      if (selector === "a[data-epub-link]") {
        return epubLink === null ? null : anchor;
      }
      if (selector === "a") return anchor;
      return null;
    },
    getAttribute: (name) => (name === "data-epub-link" ? epubLink : null),
  };
  return anchor;
}

/** Foreign-realm-like element that sits inside no anchor at all. */
function foreignPlainElement(): ForeignElement {
  return {
    nodeType: 1,
    closest: () => null,
    getAttribute: () => null,
  };
}

/** Click event whose target came across the realm boundary. */
function clickOn(target: unknown, clientX = 0) {
  return {
    target,
    clientX,
    preventDefault: vi.fn<() => void>(),
  } satisfies ChapterClickEvent;
}

/** Context with spies; scrolled mode and a 900px viewport by default. */
function makeContext(
  overrides: Partial<ChapterClickContext> = {},
): ChapterClickContext & {
  goToResource: ReturnType<typeof vi.fn>;
  turnPage: ReturnType<typeof vi.fn>;
} {
  return {
    mode: "scrolled",
    viewportWidth: 900,
    selectionCollapsed: true,
    goToResource: vi.fn(),
    turnPage: vi.fn(),
    ...overrides,
  } as ChapterClickContext & {
    goToResource: ReturnType<typeof vi.fn>;
    turnPage: ReturnType<typeof vi.fn>;
  };
}

describe("eventTargetElement", () => {
  it("accepts a same-realm element", () => {
    const el = document.createElement("a");
    expect(eventTargetElement(el)).toBe(el);
  });

  it("accepts a foreign-realm-like element that fails instanceof Element", () => {
    const foreign = foreignAnchor("OEBPS/ch2.xhtml");
    // The premise of issue #84: a structural element from another realm
    // is NOT an instance of this realm's Element constructor.
    expect(foreign instanceof Element).toBe(false);
    expect(eventTargetElement(foreign)).toBe(foreign as unknown as Element);
  });

  it("rejects null, primitives, and non-element nodes", () => {
    expect(eventTargetElement(null)).toBeNull();
    expect(eventTargetElement(undefined)).toBeNull();
    expect(eventTargetElement("a")).toBeNull();
    // Text node (nodeType 3) — even with a closest-like function.
    expect(
      eventTargetElement({ nodeType: 3, closest: () => null }),
    ).toBeNull();
    // Document (nodeType 9) has no closest.
    expect(eventTargetElement(document)).toBeNull();
    // Element nodeType but no closest (not structurally an element).
    expect(eventTargetElement({ nodeType: 1 })).toBeNull();
  });
});

describe("handleChapterClick — inter-chapter links (issue #84)", () => {
  it("navigates the app for a foreign-realm link click and blocks the iframe", () => {
    const ctx = makeContext();
    const event = clickOn(foreignAnchor("OEBPS/text/ch003.xhtml#chapter-1"));
    expect(handleChapterClick(event, ctx)).toBe(true);
    // preventDefault is what keeps the sandboxed iframe from following
    // the raw relative href itself (the blank-reader symptom).
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(ctx.goToResource).toHaveBeenCalledWith(
      "OEBPS/text/ch003.xhtml",
      "chapter-1",
    );
  });

  it("passes a null fragment for links without one", () => {
    const ctx = makeContext();
    const event = clickOn(foreignAnchor("OEBPS/text/ch003.xhtml"));
    handleChapterClick(event, ctx);
    expect(ctx.goToResource).toHaveBeenCalledWith(
      "OEBPS/text/ch003.xhtml",
      null,
    );
  });

  it("also works for same-realm targets nested inside the anchor", () => {
    // jsdom same-realm path: <a data-epub-link><em>click me</em></a>.
    const doc = document.implementation.createHTMLDocument("");
    const a = doc.createElement("a");
    a.setAttribute("data-epub-link", "OEBPS/notes.xhtml#n3");
    const em = doc.createElement("em");
    a.appendChild(em);
    doc.body.appendChild(a);
    const ctx = makeContext();
    const event = clickOn(em);
    expect(handleChapterClick(event, ctx)).toBe(true);
    expect(ctx.goToResource).toHaveBeenCalledWith("OEBPS/notes.xhtml", "n3");
  });

  it("a link click never turns the page, even in a paginated click zone", () => {
    const ctx = makeContext({ mode: "paginated", viewportWidth: 900 });
    // clientX 850 sits in the right-hand page-turn third.
    const event = clickOn(foreignAnchor("OEBPS/ch2.xhtml"), 850);
    expect(handleChapterClick(event, ctx)).toBe(true);
    expect(ctx.goToResource).toHaveBeenCalledTimes(1);
    expect(ctx.turnPage).not.toHaveBeenCalled();
  });

  it("ignores anchors without data-epub-link (stripped external links)", () => {
    const ctx = makeContext();
    const event = clickOn(foreignAnchor(null));
    expect(handleChapterClick(event, ctx)).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(ctx.goToResource).not.toHaveBeenCalled();
  });
});

describe("handleChapterClick — paginated click zones (issue #75)", () => {
  it("turns forward in the right third and backward in the left third", () => {
    const ctx = makeContext({ mode: "paginated", viewportWidth: 900 });
    expect(handleChapterClick(clickOn(foreignPlainElement(), 850), ctx)).toBe(
      true,
    );
    expect(ctx.turnPage).toHaveBeenLastCalledWith(1);
    expect(handleChapterClick(clickOn(foreignPlainElement(), 50), ctx)).toBe(
      true,
    );
    expect(ctx.turnPage).toHaveBeenLastCalledWith(-1);
  });

  it("leaves the middle third inert", () => {
    const ctx = makeContext({ mode: "paginated", viewportWidth: 900 });
    expect(handleChapterClick(clickOn(foreignPlainElement(), 450), ctx)).toBe(
      false,
    );
    expect(ctx.turnPage).not.toHaveBeenCalled();
  });

  it("does not turn pages on clicks inside plain anchors", () => {
    const ctx = makeContext({ mode: "paginated", viewportWidth: 900 });
    expect(handleChapterClick(clickOn(foreignAnchor(null), 850), ctx)).toBe(
      false,
    );
    expect(ctx.turnPage).not.toHaveBeenCalled();
  });

  it("does not turn pages while a text selection is active", () => {
    const ctx = makeContext({
      mode: "paginated",
      viewportWidth: 900,
      selectionCollapsed: false,
    });
    expect(handleChapterClick(clickOn(foreignPlainElement(), 850), ctx)).toBe(
      false,
    );
    expect(ctx.turnPage).not.toHaveBeenCalled();
  });

  it("does nothing with a zero-width viewport or in scrolled mode", () => {
    const zero = makeContext({ mode: "paginated", viewportWidth: 0 });
    expect(handleChapterClick(clickOn(foreignPlainElement(), 850), zero)).toBe(
      false,
    );
    expect(zero.turnPage).not.toHaveBeenCalled();
    const scrolled = makeContext({ mode: "scrolled" });
    expect(
      handleChapterClick(clickOn(foreignPlainElement(), 850), scrolled),
    ).toBe(false);
    expect(scrolled.turnPage).not.toHaveBeenCalled();
  });
});
