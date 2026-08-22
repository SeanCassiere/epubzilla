//! The EPUB domain model. Contractual: docs/contracts/domain-model.md.
//!
//! Types are exported to TypeScript via ts-rs (`cargo test export_bindings`
//! regenerates `crates/core/bindings/`). The frontend must consume the
//! generated types, never hand-written mirrors.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Opaque session handle for an open book. Not persisted.
pub type BookId = String;
/// Unique within a book.
pub type ResourceId = String;
/// Unique within a book.
pub type SpineItemId = String;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub enum EpubVersion {
    /// Read-only support (ADR-0003).
    V2,
    V3,
}

/// A book opened in memory. A lightweight index: chapter bodies and binary
/// resources are never held here (invariant 3).
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Book {
    pub id: BookId,
    pub metadata: Metadata,
    pub spine: Vec<SpineItem>,
    pub nav: Vec<NavPoint>,
    pub resources: Vec<Resource>,
    /// OS path of the opened file; `None` for unsaved new books.
    pub source: Option<String>,
    pub epub_version: EpubVersion,
    pub dirty: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Metadata {
    pub title: String,
    pub authors: Vec<String>,
    /// BCP 47 language tag, e.g. "en".
    pub language: String,
    /// dc:identifier (URN/UUID/ISBN).
    pub identifier: String,
    /// dcterms:modified, ISO 8601 UTC.
    pub modified: Option<String>,
    pub description: Option<String>,
    pub publisher: Option<String>,
    pub cover_resource: Option<ResourceId>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct SpineItem {
    pub id: SpineItemId,
    /// Must reference an XHTML content document.
    pub resource: ResourceId,
    /// Non-linear items exist but aren't in the reading flow.
    pub linear: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct NavPoint {
    pub label: String,
    /// Resource path plus optional fragment; `None` for section headers.
    pub href: Option<String>,
    pub children: Vec<NavPoint>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Resource {
    pub id: ResourceId,
    /// Zip-internal path, normalized, relative to the archive root.
    pub path: String,
    /// e.g. "application/xhtml+xml", "image/jpeg".
    pub media_type: String,
    /// Uncompressed bytes.
    pub size: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub enum ContentFormat {
    Markdown,
    Xhtml,
}

/// Chapter content, delivered on demand (never embedded in `Book`).
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ChapterContent {
    pub resource: ResourceId,
    /// See docs/contracts/content-roundtrip.md for when each format is used.
    pub format: ContentFormat,
    pub content: String,
}
