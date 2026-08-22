//! Tauri commands wrapping `epubzilla_core::Session` (core-api.md).
//!
//! M1.2 exposes the five reader commands only; mutations land with M2.
//! Each `#[tauri::command]` is a thin wrapper over a plain function taking
//! the shared session, so the logic is unit-testable without a running app.
//! `CoreError` implements `Serialize` with `tag = "kind"`, so failures cross
//! IPC as the typed error JSON the frontend bindings expect — never a string.

use std::sync::Mutex;

use epubzilla_core::{Book, ChapterContent, ContentFormat, CoreError, CoreResult, Session};

/// The shared session managed by Tauri (`app.manage(...)`), one per app.
pub type SharedSession = Mutex<Session>;

/// Lock the session, mapping a poisoned lock to a `CoreError` so the
/// frontend still receives typed error JSON if a command panicked.
fn lock(session: &SharedSession) -> CoreResult<std::sync::MutexGuard<'_, Session>> {
    session.lock().map_err(|_| CoreError::Io {
        message: "session lock poisoned by a previous panic".into(),
    })
}

pub(crate) fn open_book_impl(session: &SharedSession, path: &str) -> CoreResult<Book> {
    lock(session)?.open_book(path)
}

pub(crate) fn get_book_impl(session: &SharedSession, book_id: &str) -> CoreResult<Book> {
    lock(session)?.get_book(book_id)
}

pub(crate) fn read_chapter_impl(
    session: &SharedSession,
    book_id: &str,
    resource_id: &str,
    prefer: ContentFormat,
) -> CoreResult<ChapterContent> {
    lock(session)?.read_chapter(book_id, resource_id, prefer)
}

pub(crate) fn read_resource_impl(
    session: &SharedSession,
    book_id: &str,
    resource_id: &str,
) -> CoreResult<Vec<u8>> {
    lock(session)?.read_resource(book_id, resource_id)
}

pub(crate) fn close_book_impl(session: &SharedSession, book_id: &str) -> CoreResult<()> {
    lock(session)?.close_book(book_id)
}

#[tauri::command]
pub async fn open_book(session: tauri::State<'_, SharedSession>, path: String) -> CoreResult<Book> {
    open_book_impl(&session, &path)
}

#[tauri::command]
pub async fn get_book(
    session: tauri::State<'_, SharedSession>,
    book_id: String,
) -> CoreResult<Book> {
    get_book_impl(&session, &book_id)
}

#[tauri::command]
pub async fn read_chapter(
    session: tauri::State<'_, SharedSession>,
    book_id: String,
    resource_id: String,
    prefer: ContentFormat,
) -> CoreResult<ChapterContent> {
    read_chapter_impl(&session, &book_id, &resource_id, prefer)
}

#[tauri::command]
pub async fn read_resource(
    session: tauri::State<'_, SharedSession>,
    book_id: String,
    resource_id: String,
) -> Result<tauri::ipc::Response, CoreError> {
    // `ipc::Response` sends the bytes raw (ArrayBuffer on the JS side)
    // instead of a JSON number array.
    read_resource_impl(&session, &book_id, &resource_id).map(tauri::ipc::Response::new)
}

#[tauri::command]
pub async fn close_book(
    session: tauri::State<'_, SharedSession>,
    book_id: String,
) -> CoreResult<()> {
    close_book_impl(&session, &book_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use epubzilla_core::Metadata;

    /// A real temp .epub built through the core's own writer: create_book
    /// gives a title page + nav, save_book serializes the zip.
    fn temp_epub(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("epubzilla-app-tests-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(name);
        let mut session = Session::new();
        let book = session.create_book(Metadata {
            title: "Cömmand “Läyer” ✓".into(),
            authors: vec!["Tëst Author".into()],
            language: "en".into(),
            identifier: String::new(),
            modified: None,
            description: None,
            publisher: None,
            cover_resource: None,
        });
        session
            .save_book(&book.id, Some(path.to_string_lossy().into_owned()))
            .unwrap();
        path
    }

    #[test]
    fn open_get_read_close_round_trip() {
        let path = temp_epub("commands.epub");
        let session: SharedSession = Mutex::new(Session::new());

        let book = open_book_impl(&session, path.to_str().unwrap()).unwrap();
        assert_eq!(book.metadata.title, "Cömmand “Läyer” ✓");
        assert_eq!(book.spine.len(), 1);

        let again = get_book_impl(&session, &book.id).unwrap();
        assert_eq!(again.id, book.id);
        assert_eq!(again.metadata.title, book.metadata.title);

        let chapter =
            read_chapter_impl(&session, &book.id, "titlepage", ContentFormat::Xhtml).unwrap();
        assert_eq!(chapter.format, ContentFormat::Xhtml);
        assert!(chapter.content.contains("Cömmand “Läyer” ✓"));

        let bytes = read_resource_impl(&session, &book.id, "nav").unwrap();
        assert!(!bytes.is_empty());
        assert!(String::from_utf8(bytes).unwrap().contains("<nav"));

        close_book_impl(&session, &book.id).unwrap();
        let err = get_book_impl(&session, &book.id).unwrap_err();
        assert!(matches!(err, CoreError::ResourceNotFound { .. }));
    }

    #[test]
    fn open_book_missing_file_is_io_error() {
        let session: SharedSession = Mutex::new(Session::new());
        let err = open_book_impl(&session, "/no/such/file.epub").unwrap_err();
        assert!(matches!(err, CoreError::Io { .. }));
    }

    #[test]
    fn unknown_ids_are_not_found() {
        let path = temp_epub("unknown.epub");
        let session: SharedSession = Mutex::new(Session::new());
        let book = open_book_impl(&session, path.to_str().unwrap()).unwrap();

        assert!(matches!(
            get_book_impl(&session, "book-999").unwrap_err(),
            CoreError::ResourceNotFound { id } if id == "book-999"
        ));
        assert!(matches!(
            read_chapter_impl(&session, &book.id, "nope", ContentFormat::Xhtml).unwrap_err(),
            CoreError::ResourceNotFound { id } if id == "nope"
        ));
        assert!(matches!(
            read_resource_impl(&session, &book.id, "nope").unwrap_err(),
            CoreError::ResourceNotFound { .. }
        ));
        assert!(matches!(
            close_book_impl(&session, "book-999").unwrap_err(),
            CoreError::ResourceNotFound { .. }
        ));
    }

    /// The IPC error contract: command failures serialize as the serde form
    /// of `CoreError` — an object with a `kind` tag — not a string.
    #[test]
    fn command_errors_serialize_with_kind_tag() {
        let session: SharedSession = Mutex::new(Session::new());
        let err = get_book_impl(&session, "book-999").unwrap_err();
        let json = serde_json::to_value(&err).unwrap();
        assert_eq!(json["kind"], "ResourceNotFound");
        assert_eq!(json["id"], "book-999");

        let err = open_book_impl(&session, "/no/such/file.epub").unwrap_err();
        let json = serde_json::to_value(&err).unwrap();
        assert_eq!(json["kind"], "Io");
        assert!(json["message"].is_string());
    }
}
