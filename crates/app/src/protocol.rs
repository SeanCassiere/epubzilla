//! The `epub://` asset protocol: serves manifest resources (images, CSS,
//! fonts, …) straight from the open session so rendered chapters can load
//! them by URL (M1.3).
//!
//! Canonical URI shape: `epub://<book_id>/<zip-internal path>`. The frontend
//! never builds these by hand — `resourceUrl` in `frontend/src/lib/api.ts`
//! goes through Tauri's `convertFileSrc`, which yields the platform form:
//!
//! - macOS/Linux webviews: `epub://localhost/<percent-encoded book_id/path>`
//! - Windows/Android webviews: `http://epub.localhost/<percent-encoded …>`
//!
//! All three shapes are accepted here. Responses carry the manifest's
//! `media_type` as Content-Type; unknown books, paths outside the manifest,
//! and unreadable entries all come back as 404.

use std::borrow::Cow;

use percent_encoding::percent_decode_str;
use tauri::http;

use crate::commands::SharedSession;

const NOT_FOUND: &str = "resource not found";

/// Split a request URI into `(book_id, zip-internal path)`.
///
/// Handles both the localhost forms produced by `convertFileSrc` (book id is
/// the first path segment) and the canonical `epub://<book_id>/<path>` form
/// (book id is the authority). Percent-encoding is decoded; `None` means the
/// URI does not name a resource (→ 404).
pub(crate) fn parse_resource_uri(uri: &str) -> Option<(String, String)> {
    let rest = uri.split_once("://").map(|(_, rest)| rest)?;
    let (host, path) = rest.split_once('/').unwrap_or((rest, ""));
    let (book_id, zip_path): (Cow<'_, str>, Cow<'_, str>) =
        if host.is_empty() || host == "localhost" || host.ends_with(".localhost") {
            // convertFileSrc encodes "<book_id>/<path>" as one URI component,
            // so decode first, then split on the first slash.
            let decoded = percent_decode_str(path).decode_utf8().ok()?;
            let (book_id, zip_path) = decoded.split_once('/')?;
            (Cow::Owned(book_id.to_owned()), Cow::Owned(zip_path.into()))
        } else {
            (
                percent_decode_str(host).decode_utf8().ok()?,
                percent_decode_str(path).decode_utf8().ok()?,
            )
        };
    // Strip a query/fragment a webview may append (zip paths contain neither).
    let zip_path = zip_path
        .split(['?', '#'])
        .next()
        .unwrap_or_default()
        .to_owned();
    if book_id.is_empty() || zip_path.is_empty() {
        return None;
    }
    Some((book_id.into_owned(), zip_path))
}

/// Request → response logic behind `register_uri_scheme_protocol`, factored
/// out so it is testable without a running app.
pub(crate) fn handle_request(session: &SharedSession, uri: &str) -> http::Response<Vec<u8>> {
    let Some((book_id, zip_path)) = parse_resource_uri(uri) else {
        return error_response(http::StatusCode::NOT_FOUND);
    };
    let Ok(mut session) = session.lock() else {
        return error_response(http::StatusCode::INTERNAL_SERVER_ERROR);
    };
    // The protocol addresses by zip-internal path; the session by manifest
    // id. Resolve path → (id, media_type) through the book snapshot.
    let Ok(book) = session.get_book(&book_id) else {
        return error_response(http::StatusCode::NOT_FOUND);
    };
    let Some(resource) = book.resources.iter().find(|r| r.path == zip_path) else {
        return error_response(http::StatusCode::NOT_FOUND);
    };
    match session.read_resource(&book_id, &resource.id) {
        Ok(bytes) => http::Response::builder()
            .status(http::StatusCode::OK)
            .header(http::header::CONTENT_TYPE, resource.media_type.as_str())
            // Fonts (and fetch) need CORS from the app origin.
            .header(http::header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
            .body(bytes)
            .expect("static response parts are valid"),
        Err(_) => error_response(http::StatusCode::NOT_FOUND),
    }
}

fn error_response(status: http::StatusCode) -> http::Response<Vec<u8>> {
    http::Response::builder()
        .status(status)
        .header(http::header::CONTENT_TYPE, "text/plain")
        .header(http::header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .body(NOT_FOUND.as_bytes().to_vec())
        .expect("static response parts are valid")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::open_book_impl;
    use epubzilla_core::{Metadata, Session};
    use std::sync::Mutex;

    #[test]
    fn parses_canonical_shape() {
        assert_eq!(
            parse_resource_uri("epub://book-1/OEBPS/images/cover.png"),
            Some(("book-1".into(), "OEBPS/images/cover.png".into()))
        );
    }

    #[test]
    fn parses_convert_file_src_shapes() {
        // macOS/Linux: epub://localhost/<encodeURIComponent("book-1/…")>
        assert_eq!(
            parse_resource_uri("epub://localhost/book-1%2FOEBPS%2Fimages%2Fcover.png"),
            Some(("book-1".into(), "OEBPS/images/cover.png".into()))
        );
        // Windows/Android: http://epub.localhost/<encoded>
        assert_eq!(
            parse_resource_uri("http://epub.localhost/book-1%2FOEBPS%2Fstyle.css"),
            Some(("book-1".into(), "OEBPS/style.css".into()))
        );
        // Some webviews decode the slashes before the handler sees the URI.
        assert_eq!(
            parse_resource_uri("http://epub.localhost/book-1/OEBPS/style.css"),
            Some(("book-1".into(), "OEBPS/style.css".into()))
        );
    }

    #[test]
    fn decodes_percent_encoding_and_strips_query() {
        assert_eq!(
            parse_resource_uri("epub://book-1/OEBPS/f%C3%B6nts/M%20N.woff2?v=1#frag"),
            Some(("book-1".into(), "OEBPS/fönts/M N.woff2".into()))
        );
    }

    #[test]
    fn rejects_uris_without_a_resource() {
        assert_eq!(parse_resource_uri("epub://book-1"), None);
        assert_eq!(parse_resource_uri("epub://book-1/"), None);
        assert_eq!(parse_resource_uri("epub://localhost/onlyonesegment"), None);
        assert_eq!(parse_resource_uri("not-a-uri"), None);
    }

    fn open_temp_book(session: &SharedSession, name: &str) -> epubzilla_core::Book {
        let dir = std::env::temp_dir().join(format!("epubzilla-app-tests-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(name);
        let mut builder = Session::new();
        let book = builder.create_book(Metadata {
            title: "Prötocol ✓".into(),
            authors: vec!["Author".into()],
            language: "en".into(),
            identifier: String::new(),
            modified: None,
            description: None,
            publisher: None,
            cover_resource: None,
        });
        builder
            .save_book(&book.id, Some(path.to_string_lossy().into_owned()))
            .unwrap();
        open_book_impl(session, path.to_str().unwrap()).unwrap()
    }

    #[test]
    fn serves_resource_bytes_with_manifest_content_type() {
        let session: SharedSession = Mutex::new(Session::new());
        let book = open_temp_book(&session, "protocol-serves.epub");

        let uri = format!("epub://{}/OEBPS/titlepage.xhtml", book.id);
        let response = handle_request(&session, &uri);
        assert_eq!(response.status(), http::StatusCode::OK);
        assert_eq!(
            response.headers()[http::header::CONTENT_TYPE],
            "application/xhtml+xml"
        );
        assert!(String::from_utf8(response.body().clone())
            .unwrap()
            .contains("Prötocol ✓"));

        // The convertFileSrc shape resolves to the same bytes.
        let encoded = format!("epub://localhost/{}%2FOEBPS%2Ftitlepage.xhtml", book.id);
        let same = handle_request(&session, &encoded);
        assert_eq!(same.status(), http::StatusCode::OK);
        assert_eq!(same.body(), response.body());
    }

    #[test]
    fn unknown_book_path_or_shape_is_404() {
        let session: SharedSession = Mutex::new(Session::new());
        let book = open_temp_book(&session, "protocol-404.epub");

        for uri in [
            "epub://book-999/OEBPS/titlepage.xhtml".to_owned(),
            format!("epub://{}/OEBPS/missing.png", book.id),
            format!("epub://{}", book.id),
        ] {
            let response = handle_request(&session, &uri);
            assert_eq!(response.status(), http::StatusCode::NOT_FOUND, "{uri}");
        }
    }
}
