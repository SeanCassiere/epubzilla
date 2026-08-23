//! Tauri commands wrapping `epubzilla_core::Session` (core-api.md).
//!
//! M1.2 exposed the five reader commands; M2.1 adds the lifecycle and
//! mutation commands (create/save/write/update/add/remove/reorder/validate).
//! Each `#[tauri::command]` is a thin wrapper over a plain function taking
//! the shared session, so the logic is unit-testable without a running app.
//! `CoreError` implements `Serialize` with `tag = "kind"`, so failures cross
//! IPC as the typed error JSON the frontend bindings expect — never a string.

use std::sync::Mutex;

use epubzilla_core::{
    Book, ChapterContent, ContentFormat, CoreError, CoreResult, Metadata, Session, SpineItemId,
    ValidationIssue,
};

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

pub(crate) fn create_book_impl(session: &SharedSession, metadata: Metadata) -> CoreResult<Book> {
    Ok(lock(session)?.create_book(metadata))
}

pub(crate) fn save_book_impl(
    session: &SharedSession,
    book_id: &str,
    path: Option<String>,
) -> CoreResult<Book> {
    lock(session)?.save_book(book_id, path)
}

pub(crate) fn write_chapter_impl(
    session: &SharedSession,
    book_id: &str,
    resource_id: &str,
    content: ChapterContent,
) -> CoreResult<Book> {
    lock(session)?.write_chapter(book_id, resource_id, content)
}

pub(crate) fn update_metadata_impl(
    session: &SharedSession,
    book_id: &str,
    metadata: Metadata,
) -> CoreResult<Book> {
    lock(session)?.update_metadata(book_id, metadata)
}

pub(crate) fn add_chapter_impl(
    session: &SharedSession,
    book_id: &str,
    title: &str,
    after: Option<&str>,
) -> CoreResult<Book> {
    lock(session)?.add_chapter(book_id, title, after)
}

pub(crate) fn remove_chapter_impl(
    session: &SharedSession,
    book_id: &str,
    spine_item_id: &str,
) -> CoreResult<Book> {
    lock(session)?.remove_chapter(book_id, spine_item_id)
}

pub(crate) fn reorder_spine_impl(
    session: &SharedSession,
    book_id: &str,
    order: &[SpineItemId],
) -> CoreResult<Book> {
    lock(session)?.reorder_spine(book_id, order)
}

/// Image media type for a file extension (case-insensitive). The picker
/// filter and this list must stay in sync (frontend/src/lib/dialog.ts).
fn image_media_type(extension: Option<&str>) -> Option<&'static str> {
    match extension?.to_ascii_lowercase().as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "svg" => Some("image/svg+xml"),
        "webp" => Some("image/webp"),
        _ => None,
    }
}

/// M3.3: read one image file from an OS path and store it in the book via
/// `Session::add_resource` — bytes never cross IPC. The media type is
/// inferred from the file extension.
pub(crate) fn add_resource_from_path_impl(
    session: &SharedSession,
    book_id: &str,
    os_path: &str,
) -> CoreResult<Book> {
    let path = std::path::Path::new(os_path);
    let media_type =
        image_media_type(path.extension().and_then(|e| e.to_str())).ok_or_else(|| {
            CoreError::UnsupportedFeature {
                message: format!(
                    "add_resource_from_path: {os_path:?} is not a supported image \
                 (png, jpg, jpeg, gif, svg, webp)"
                ),
            }
        })?;
    let bytes = std::fs::read(path).map_err(|e| CoreError::Io {
        message: format!("add_resource_from_path: cannot read {os_path}: {e}"),
    })?;
    let hint = path.file_name().and_then(|n| n.to_str()).unwrap_or("image");
    lock(session)?.add_resource(book_id, hint, media_type, bytes)
}

/// Canonical file extension for a supported image media type. Inverse
/// direction of `image_media_type` — pasted images (issue #54) arrive as
/// bytes plus the clipboard's media type, with no OS path to infer from.
fn image_extension(media_type: &str) -> Option<&'static str> {
    match media_type {
        "image/png" => Some("png"),
        "image/jpeg" => Some("jpg"),
        "image/gif" => Some("gif"),
        "image/svg+xml" => Some("svg"),
        "image/webp" => Some("webp"),
        _ => None,
    }
}

/// Issue #54: store image bytes (clipboard paste / drag-and-drop in the
/// editor) in the book via `Session::add_resource`. The stored path derives
/// from `name_hint`, but clipboard names are unreliable ("image.png",
/// sometimes empty), so the hint's extension is kept only when it agrees
/// with `media_type`; otherwise the canonical extension for the media type
/// is applied. Non-image media types are `UnsupportedFeature`.
pub(crate) fn add_resource_from_bytes_impl(
    session: &SharedSession,
    book_id: &str,
    name_hint: &str,
    media_type: &str,
    bytes: Vec<u8>,
) -> CoreResult<Book> {
    let extension = image_extension(media_type).ok_or_else(|| CoreError::UnsupportedFeature {
        message: format!(
            "add_resource_from_bytes: {media_type:?} is not a supported image \
             media type (image/png, image/jpeg, image/gif, image/svg+xml, image/webp)"
        ),
    })?;
    let hint_path = std::path::Path::new(name_hint);
    let hinted = image_media_type(hint_path.extension().and_then(|e| e.to_str()));
    let hint = if hinted == Some(media_type) {
        name_hint.to_owned()
    } else {
        let stem = hint_path
            .file_stem()
            .and_then(|s| s.to_str())
            .filter(|s| !s.is_empty())
            .unwrap_or("pasted-image");
        format!("{stem}.{extension}")
    };
    lock(session)?.add_resource(book_id, &hint, media_type, bytes)
}

pub(crate) fn validate_impl(
    session: &SharedSession,
    book_id: &str,
) -> CoreResult<Vec<ValidationIssue>> {
    lock(session)?.validate(book_id)
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

#[tauri::command]
pub async fn create_book(
    session: tauri::State<'_, SharedSession>,
    metadata: Metadata,
) -> CoreResult<Book> {
    create_book_impl(&session, metadata)
}

#[tauri::command]
pub async fn save_book(
    session: tauri::State<'_, SharedSession>,
    book_id: String,
    path: Option<String>,
) -> CoreResult<Book> {
    save_book_impl(&session, &book_id, path)
}

#[tauri::command]
pub async fn write_chapter(
    session: tauri::State<'_, SharedSession>,
    book_id: String,
    resource_id: String,
    content: ChapterContent,
) -> CoreResult<Book> {
    write_chapter_impl(&session, &book_id, &resource_id, content)
}

#[tauri::command]
pub async fn update_metadata(
    session: tauri::State<'_, SharedSession>,
    book_id: String,
    metadata: Metadata,
) -> CoreResult<Book> {
    update_metadata_impl(&session, &book_id, metadata)
}

#[tauri::command]
pub async fn add_chapter(
    session: tauri::State<'_, SharedSession>,
    book_id: String,
    title: String,
    after: Option<String>,
) -> CoreResult<Book> {
    add_chapter_impl(&session, &book_id, &title, after.as_deref())
}

#[tauri::command]
pub async fn remove_chapter(
    session: tauri::State<'_, SharedSession>,
    book_id: String,
    spine_item_id: String,
) -> CoreResult<Book> {
    remove_chapter_impl(&session, &book_id, &spine_item_id)
}

#[tauri::command]
pub async fn reorder_spine(
    session: tauri::State<'_, SharedSession>,
    book_id: String,
    order: Vec<SpineItemId>,
) -> CoreResult<Book> {
    reorder_spine_impl(&session, &book_id, &order)
}

#[tauri::command]
pub async fn add_resource_from_path(
    session: tauri::State<'_, SharedSession>,
    book_id: String,
    os_path: String,
) -> CoreResult<Book> {
    add_resource_from_path_impl(&session, &book_id, &os_path)
}

#[tauri::command]
pub async fn add_resource_from_bytes(
    session: tauri::State<'_, SharedSession>,
    book_id: String,
    name_hint: String,
    media_type: String,
    bytes: Vec<u8>,
) -> CoreResult<Book> {
    add_resource_from_bytes_impl(&session, &book_id, &name_hint, &media_type, bytes)
}

#[tauri::command]
pub async fn validate(
    session: tauri::State<'_, SharedSession>,
    book_id: String,
) -> CoreResult<Vec<ValidationIssue>> {
    validate_impl(&session, &book_id)
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

    fn metadata(title: &str) -> Metadata {
        Metadata {
            title: title.into(),
            authors: vec!["Mütation Author".into()],
            language: "en".into(),
            identifier: String::new(),
            modified: None,
            description: None,
            publisher: None,
            cover_resource: None,
        }
    }

    #[test]
    fn create_mutate_save_lifecycle() {
        let dir = std::env::temp_dir().join(format!("epubzilla-app-m2-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("lifecycle.epub");
        let session: SharedSession = Mutex::new(Session::new());

        let book = create_book_impl(&session, metadata("M2 Lïfecycle ✓")).unwrap();
        assert!(book.dirty);
        assert!(book.source.is_none());

        // save with no path and no source is the contracted save-as error
        assert!(matches!(
            save_book_impl(&session, &book.id, None).unwrap_err(),
            CoreError::Io { .. }
        ));

        let book = add_chapter_impl(&session, &book.id, "One", None).unwrap();
        let book = add_chapter_impl(&session, &book.id, "Two", None).unwrap();
        assert_eq!(book.spine.len(), 3); // titlepage + 2

        let chapter_resource = book.spine[1].resource.clone();
        let book = write_chapter_impl(
            &session,
            &book.id,
            &chapter_resource,
            ChapterContent {
                resource: chapter_resource.clone(),
                format: ContentFormat::Markdown,
                content: "# One\n\nHello **markdown**.".into(),
                fallback_reason: None,
            },
        )
        .unwrap();

        let order: Vec<String> = book.spine.iter().rev().map(|s| s.id.clone()).collect();
        let book = reorder_spine_impl(&session, &book.id, &order).unwrap();
        assert_eq!(book.spine[0].resource, book.spine.first().unwrap().resource);

        // UI flow: metadata form carries the existing identifier through
        // (clearing it would fail validation — identifier is required).
        let renamed = Metadata {
            identifier: book.metadata.identifier.clone(),
            ..metadata("Renämed ✓")
        };
        let book = update_metadata_impl(&session, &book.id, renamed).unwrap();
        assert_eq!(book.metadata.title, "Renämed ✓");

        let spine_item = book.spine.last().unwrap().id.clone();
        let book = remove_chapter_impl(&session, &book.id, &spine_item).unwrap();
        assert_eq!(book.spine.len(), 2);

        let issues = validate_impl(&session, &book.id).unwrap();
        assert!(issues.is_empty(), "unexpected issues: {issues:?}");

        let saved = save_book_impl(
            &session,
            &book.id,
            Some(path.to_string_lossy().into_owned()),
        )
        .unwrap();
        assert!(!saved.dirty);
        assert_eq!(saved.source.as_deref(), Some(path.to_str().unwrap()));

        // the saved file reopens cleanly with the mutations applied
        let reopened = open_book_impl(&session, path.to_str().unwrap()).unwrap();
        assert_eq!(reopened.metadata.title, "Renämed ✓");
        assert_eq!(reopened.spine.len(), 2);
    }

    #[test]
    fn reorder_rejects_non_permutation() {
        let session: SharedSession = Mutex::new(Session::new());
        let book = create_book_impl(&session, metadata("Perm")).unwrap();
        let err = reorder_spine_impl(&session, &book.id, &["bogus".to_string()]).unwrap_err();
        assert!(matches!(err, CoreError::MalformedPackage { .. }));
    }

    #[test]
    fn add_resource_from_path_reads_and_stores_the_image() {
        let dir = std::env::temp_dir().join(format!("epubzilla-app-m3-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let img = dir.join("Cövèr Art.PNG");
        let bytes: Vec<u8> = vec![0x89, 0x50, 0x4E, 0x47, 1, 2, 3, 4];
        std::fs::write(&img, &bytes).unwrap();

        let session: SharedSession = Mutex::new(Session::new());
        let book = create_book_impl(&session, metadata("Ïmage Bòok ✓")).unwrap();
        let book = add_resource_from_path_impl(&session, &book.id, img.to_str().unwrap()).unwrap();

        assert!(book.dirty);
        let added = book
            .resources
            .iter()
            .find(|r| r.path == "OEBPS/images/Cövèr-Art.png")
            .unwrap();
        assert_eq!(added.media_type, "image/png");
        assert_eq!(added.size, bytes.len() as u64);
        assert_eq!(
            read_resource_impl(&session, &book.id, &added.id).unwrap(),
            bytes
        );
    }

    #[test]
    fn add_resource_from_path_rejects_unsupported_and_missing_files() {
        let session: SharedSession = Mutex::new(Session::new());
        let book = create_book_impl(&session, metadata("Ïmage Errs")).unwrap();

        let err = add_resource_from_path_impl(&session, &book.id, "/pics/movie.mp4").unwrap_err();
        assert!(matches!(err, CoreError::UnsupportedFeature { .. }));
        let err = add_resource_from_path_impl(&session, &book.id, "/pics/none").unwrap_err();
        assert!(matches!(err, CoreError::UnsupportedFeature { .. }));
        let err = add_resource_from_path_impl(&session, &book.id, "/no/such/file.png").unwrap_err();
        assert!(matches!(err, CoreError::Io { .. }));
    }

    #[test]
    fn add_resource_from_bytes_stores_the_image() {
        let session: SharedSession = Mutex::new(Session::new());
        let book = create_book_impl(&session, metadata("Pästed Bòok ✓")).unwrap();
        let bytes: Vec<u8> = vec![0x89, 0x50, 0x4E, 0x47, 9, 8, 7];
        let book = add_resource_from_bytes_impl(
            &session,
            &book.id,
            "Pästed Ïmage.PNG",
            "image/png",
            bytes.clone(),
        )
        .unwrap();

        assert!(book.dirty);
        let added = book
            .resources
            .iter()
            .find(|r| r.path == "OEBPS/images/Pästed-Ïmage.png")
            .unwrap();
        assert_eq!(added.media_type, "image/png");
        assert_eq!(added.size, bytes.len() as u64);
        assert_eq!(
            read_resource_impl(&session, &book.id, &added.id).unwrap(),
            bytes
        );
    }

    #[test]
    fn add_resource_from_bytes_normalizes_unreliable_clipboard_names() {
        let session: SharedSession = Mutex::new(Session::new());
        let book = create_book_impl(&session, metadata("Clïpboard Names")).unwrap();

        // No extension: the media type's canonical extension is applied.
        let book =
            add_resource_from_bytes_impl(&session, &book.id, "clipboard", "image/jpeg", vec![1])
                .unwrap();
        assert!(book
            .resources
            .iter()
            .any(|r| r.path.ends_with("/clipboard.jpg")));

        // Wrong extension for the media type: replaced, not trusted.
        let book =
            add_resource_from_bytes_impl(&session, &book.id, "shot.png", "image/webp", vec![2])
                .unwrap();
        assert!(book
            .resources
            .iter()
            .any(|r| r.path.ends_with("/shot.webp")));

        // Matching extension is kept (jpeg spelling included).
        let book =
            add_resource_from_bytes_impl(&session, &book.id, "photo.jpeg", "image/jpeg", vec![3])
                .unwrap();
        assert!(book
            .resources
            .iter()
            .any(|r| r.path.ends_with("/photo.jpeg")));

        // Empty name still lands somewhere sensible.
        let book =
            add_resource_from_bytes_impl(&session, &book.id, "", "image/png", vec![4]).unwrap();
        assert!(book
            .resources
            .iter()
            .any(|r| r.path.ends_with("/pasted-image.png")));
    }

    #[test]
    fn add_resource_from_bytes_rejects_non_image_media_types() {
        let session: SharedSession = Mutex::new(Session::new());
        let book = create_book_impl(&session, metadata("Bäd Paste")).unwrap();
        for media_type in ["video/mp4", "image/tiff", "text/html", ""] {
            let err = add_resource_from_bytes_impl(&session, &book.id, "x", media_type, vec![1])
                .unwrap_err();
            assert!(
                matches!(err, CoreError::UnsupportedFeature { .. }),
                "{media_type} should be rejected"
            );
        }
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
