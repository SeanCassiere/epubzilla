# Contract: EPUB Domain Model

Status: **Accepted** · Changes via PR only.

The canonical data model shared between the Rust core and the TypeScript frontend.
Types are defined once in Rust and exported to TypeScript via type generation
(`ts-rs` or `specta` — see ADR-0004). The frontend never hand-writes these types.

## Conventions

- All strings are UTF-8. IDs are opaque strings, unique within a book.
- Resource paths are always zip-internal, normalized, relative to the archive root
  (e.g. `OEBPS/ch01.xhtml`), never OS paths.
- Optional fields are `Option<T>` in Rust / `T | null` in TS.

## Types

```rust
/// A book opened in memory. The handle the frontend holds.
struct Book {
    id: BookId,              // opaque session handle, not persisted
    metadata: Metadata,
    spine: Vec<SpineItem>,   // linear reading order
    nav: Vec<NavPoint>,      // table of contents (tree)
    resources: Vec<Resource>,// full manifest
    source: Option<String>,  // OS path of the opened file; None for unsaved new books
    epub_version: EpubVersion, // V2 | V3 (V2 is read-only, see ADR-0003)
    dirty: bool,
}

struct Metadata {
    title: String,
    authors: Vec<String>,
    language: String,          // BCP 47 tag, e.g. "en"
    identifier: String,        // dc:identifier (URN/UUID/ISBN)
    modified: Option<String>,  // dcterms:modified, ISO 8601 UTC
    description: Option<String>,
    publisher: Option<String>,
    cover_resource: Option<ResourceId>,
}

struct SpineItem {
    id: SpineItemId,
    resource: ResourceId,      // must reference an XHTML content document
    linear: bool,              // non-linear items exist but aren't in reading flow
}

struct NavPoint {
    label: String,
    href: Option<String>,      // resource path + optional fragment; None for section headers
    children: Vec<NavPoint>,
}

struct Resource {
    id: ResourceId,
    path: String,              // zip-internal path
    media_type: String,        // e.g. "application/xhtml+xml", "image/jpeg"
    size: u64,                 // uncompressed bytes
}

/// Chapter content, delivered on demand (never embedded in Book).
struct ChapterContent {
    resource: ResourceId,
    format: ContentFormat,     // Markdown | Xhtml (see content-roundtrip.md)
    content: String,
    // When Markdown was preferred but the chapter came back as Xhtml, the
    // out-of-subset construct that forced source mode. None otherwise.
    fallback_reason: Option<String>,
}

enum ContentFormat { Markdown, Xhtml }
```

## Invariants

1. Every `SpineItem.resource` and every `NavPoint.href` path resolves to a `Resource`.
2. `spine` order is the single source of truth for reading order; nav is presentation.
3. `Book` is a lightweight index — chapter bodies and binary resources are **never**
   held in `Book`; they are fetched via `read_chapter` / `read_resource`.
4. Mutations go through core API commands only (see `core-api.md`); the frontend
   never edits the model locally and syncs back.

## Error taxonomy

```rust
enum CoreError {
    Io { message: String },
    NotAnEpub { message: String },          // bad mimetype/container.xml
    MalformedPackage { message: String },   // OPF/nav parse failure
    ResourceNotFound { id: String },
    UnsupportedFeature { message: String }, // e.g. DRM-encrypted
    ValidationFailed { issues: Vec<ValidationIssue> },
    ConversionLossy { detail: String },     // md↔xhtml round-trip would lose data
}

struct ValidationIssue {
    severity: Severity,   // Error | Warning
    location: Option<String>,
    message: String,
}
```

All core API commands return `Result<T, CoreError>`. The frontend must handle
every variant; no command panics across the boundary.
