// Typed loaders for the committed fixture snapshots (M1.5).
//
// The JSON files are REAL command output: fixture EPUBs are built and opened
// through `epubzilla_core::Session` by the generator test in
// crates/app/tests/gen_fixtures.rs, which serializes the same `Book` and
// `ChapterContent` values the Tauri commands return over IPC. Regenerate
// after core/model changes with:
//
//   cargo test -p epubzilla-app --test gen_fixtures -- --ignored
//
// The one wire-format difference from the bindings: `Resource.size` is
// `bigint` in TypeScript but a plain number in JSON, so loading converts it.
// Everything else must deserialize into the @bindings types as-is — any
// drift breaks compilation here.

import type { Book } from "@bindings/Book";
import type { ChapterContent } from "@bindings/ChapterContent";
import type { Resource } from "@bindings/Resource";
import epub3Raw from "./fixtures/epub3.json";
import epub2Raw from "./fixtures/epub2.json";

/** What the frontend receives for one open fixture book. */
export interface Fixture {
  book: Book;
  /** `read_chapter(prefer: Xhtml)` result per spine resource id. */
  chapters: Record<string, ChapterContent>;
  /**
   * `read_chapter(prefer: Markdown)` result per spine resource id (M3.4):
   * REAL core conversion output — in-subset chapters have
   * `format: "Markdown"`, out-of-subset ones fall back to `format: "Xhtml"`.
   */
  markdown: Record<string, ChapterContent>;
}

/** JSON wire form: identical to the bindings except `size` is a number. */
type RawResource = Omit<Resource, "size"> & { size: number };
type RawBook = Omit<Book, "resources"> & { resources: RawResource[] };
interface RawFixture {
  book: RawBook;
  chapters: Record<string, ChapterContent>;
  markdown: Record<string, ChapterContent>;
}

function decode(raw: RawFixture): Fixture {
  return {
    book: {
      ...raw.book,
      resources: raw.book.resources.map((r) => ({ ...r, size: BigInt(r.size) })),
    },
    chapters: raw.chapters,
    markdown: raw.markdown,
  };
}

/** EPUB 3: nested nav, image, stylesheet, non-linear item, unicode metadata. */
export function epub3Fixture(): Fixture {
  return decode(epub3Raw as RawFixture);
}

/** EPUB 2: NCX-derived nav tree, two linear chapters. */
export function epub2Fixture(): Fixture {
  return decode(epub2Raw as RawFixture);
}
