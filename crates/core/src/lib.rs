//! epubzilla-core: the EPUB engine.
//!
//! UI-free by design — exercised by `epubzilla-cli` and, from M1 on, wrapped
//! by Tauri commands. Contracts live in `docs/contracts/`.

pub mod container;
pub mod error;
pub mod model;
pub mod nav;
pub mod opf;
pub mod session;
mod writer;

pub use container::OcfContainer;
pub use error::{CoreError, CoreResult, Severity, ValidationIssue};
pub use model::{
    Book, BookId, ChapterContent, ContentFormat, EpubVersion, Metadata, NavPoint, Resource,
    ResourceId, SpineItem, SpineItemId,
};
pub use session::Session;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn core_error_serializes_tagged() {
        let err = CoreError::ResourceNotFound { id: "ch01".into() };
        let json = serde_json::to_value(&err).unwrap();
        assert_eq!(json["kind"], "ResourceNotFound");
        assert_eq!(json["id"], "ch01");
    }

    #[test]
    fn book_round_trips_through_json() {
        let book = Book {
            id: "b1".into(),
            metadata: Metadata {
                title: "Test — “curly” ünïcode ✓".into(),
                authors: vec!["Author".into()],
                language: "en".into(),
                identifier: "urn:uuid:00000000-0000-0000-0000-000000000000".into(),
                modified: None,
                description: None,
                publisher: None,
                cover_resource: None,
            },
            spine: vec![SpineItem {
                id: "s1".into(),
                resource: "r1".into(),
                linear: true,
            }],
            nav: vec![NavPoint {
                label: "Chapter 1".into(),
                href: Some("OEBPS/ch01.xhtml".into()),
                children: vec![],
            }],
            resources: vec![Resource {
                id: "r1".into(),
                path: "OEBPS/ch01.xhtml".into(),
                media_type: "application/xhtml+xml".into(),
                size: 1024,
            }],
            source: None,
            epub_version: EpubVersion::V3,
            dirty: false,
        };
        let json = serde_json::to_string(&book).unwrap();
        let back: Book = serde_json::from_str(&json).unwrap();
        assert_eq!(back.metadata.title, book.metadata.title);
        assert_eq!(back.spine.len(), 1);
    }
}
