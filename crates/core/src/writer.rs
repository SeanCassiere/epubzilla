//! EPUB 3 serialization: OPF, container.xml, and generated documents
//! (title page, nav) for books created in memory.
//!
//! Writing is strict where reading is lenient (ADR-0003): output must pass
//! epubcheck with zero errors (core-api.md consistency rule 2). The zip
//! assembly itself (mimetype first + stored, atomic temp + rename, raw entry
//! copy) lives in `session::save_book`; this module only produces bytes.

use std::time::{SystemTime, UNIX_EPOCH};

use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;

use crate::model::{Book, Metadata, NavPoint, Resource};
use crate::nav::{AuxNav, AuxNavEntry, AuxTarget};

/// Current time as ISO 8601 UTC with second precision, e.g.
/// `2026-08-23T12:34:56Z` — the exact shape `dcterms:modified` requires.
pub(crate) fn now_iso8601() -> String {
    let now = OffsetDateTime::now_utc();
    now.replace_nanosecond(0)
        .unwrap_or(now)
        .format(&Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_owned())
}

/// A fresh `urn:uuid:` identifier for books created without one. Random
/// enough for document identity (time + pid + counter entropy), shaped like
/// a v4 UUID. The counter keeps same-instant calls distinct.
pub(crate) fn generate_identifier() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let a = (nanos as u64) ^ COUNTER.fetch_add(1, Ordering::Relaxed).rotate_left(48);
    let b = ((nanos >> 64) as u64)
        .wrapping_mul(0x9e37_79b9_7f4a_7c15)
        .wrapping_add((std::process::id() as u64).rotate_left(32))
        .wrapping_add(a.rotate_left(17));
    format!(
        "urn:uuid:{:08x}-{:04x}-4{:03x}-{:04x}-{:012x}",
        (a >> 32) as u32,
        (a >> 16) as u16,
        (a & 0xfff) as u16,
        0x8000 | ((b >> 48) as u16 & 0x3fff),
        b & 0xffff_ffff_ffff
    )
}

/// Escape text/attribute content for XML output.
pub(crate) fn escape_xml(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            c => out.push(c),
        }
    }
    out
}

/// `META-INF/container.xml` pointing at the package document.
pub(crate) fn write_container_xml(package_path: &str) -> String {
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="{}" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
"#,
        escape_xml(package_path)
    )
}

/// The EPUB 3 package document, regenerated from the model.
/// `modified` is the refreshed `dcterms:modified` timestamp.
pub(crate) fn write_opf(
    book: &Book,
    nav_resource: Option<&str>,
    ncx_resource: Option<&str>,
    package_path: &str,
    modified: &str,
) -> String {
    let package_dir = parent_dir(package_path);
    let meta = &book.metadata;

    let mut out = String::with_capacity(1024);
    out.push_str(r#"<?xml version="1.0" encoding="UTF-8"?>"#);
    out.push('\n');
    out.push_str(
        r#"<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id">"#,
    );
    out.push('\n');

    out.push_str(r#"  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">"#);
    out.push('\n');
    out.push_str(&format!(
        "    <dc:identifier id=\"pub-id\">{}</dc:identifier>\n",
        escape_xml(&meta.identifier)
    ));
    out.push_str(&format!(
        "    <dc:title>{}</dc:title>\n",
        escape_xml(&meta.title)
    ));
    out.push_str(&format!(
        "    <dc:language>{}</dc:language>\n",
        escape_xml(&meta.language)
    ));
    for author in &meta.authors {
        out.push_str(&format!(
            "    <dc:creator>{}</dc:creator>\n",
            escape_xml(author)
        ));
    }
    if let Some(description) = &meta.description {
        out.push_str(&format!(
            "    <dc:description>{}</dc:description>\n",
            escape_xml(description)
        ));
    }
    if let Some(publisher) = &meta.publisher {
        out.push_str(&format!(
            "    <dc:publisher>{}</dc:publisher>\n",
            escape_xml(publisher)
        ));
    }
    out.push_str(&format!(
        "    <meta property=\"dcterms:modified\">{}</meta>\n",
        escape_xml(modified)
    ));
    out.push_str("  </metadata>\n");

    out.push_str("  <manifest>\n");
    for resource in &book.resources {
        let mut properties = Vec::new();
        if nav_resource == Some(resource.id.as_str()) {
            properties.push("nav");
        }
        if meta.cover_resource.as_deref() == Some(resource.id.as_str())
            && resource.media_type.starts_with("image/")
        {
            properties.push("cover-image");
        }
        let props = if properties.is_empty() {
            String::new()
        } else {
            format!(" properties=\"{}\"", properties.join(" "))
        };
        out.push_str(&format!(
            "    <item id=\"{}\" href=\"{}\" media-type=\"{}\"{}/>\n",
            escape_xml(&resource.id),
            escape_xml(&relative_href(&package_dir, &resource.path)),
            escape_xml(&resource.media_type),
            props
        ));
    }
    out.push_str("  </manifest>\n");

    match ncx_resource {
        Some(ncx) => out.push_str(&format!("  <spine toc=\"{}\">\n", escape_xml(ncx))),
        None => out.push_str("  <spine>\n"),
    }
    for item in &book.spine {
        let linear = if item.linear { "" } else { " linear=\"no\"" };
        out.push_str(&format!(
            "    <itemref idref=\"{}\"{}/>\n",
            escape_xml(&item.resource),
            linear
        ));
    }
    out.push_str("  </spine>\n</package>\n");
    out
}

/// Generated title page for `create_book`: title plus authors, clean markup.
pub(crate) fn write_title_page_xhtml(metadata: &Metadata) -> String {
    let mut authors = String::new();
    for author in &metadata.authors {
        authors.push_str(&format!(
            "    <p class=\"author\">{}</p>\n",
            escape_xml(author)
        ));
    }
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="{lang}" lang="{lang}">
<head>
  <title>{title}</title>
</head>
<body>
  <section class="titlepage">
    <h1>{title}</h1>
{authors}  </section>
</body>
</html>
"#,
        lang = escape_xml(&metadata.language),
        title = escape_xml(&metadata.title),
    )
}

/// Generated EPUB 3 chapter document: the minimal valid frame (`<head>` with
/// the chapter title) around an XHTML body fragment. The `epub:` namespace is
/// declared when the body uses it (footnotes).
pub(crate) fn write_chapter_xhtml(title: &str, language: &str, body: &str) -> String {
    let epub_ns = if body.contains("epub:") {
        r#" xmlns:epub="http://www.idpf.org/2007/ops""#
    } else {
        ""
    };
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml"{epub_ns} xml:lang="{lang}" lang="{lang}">
<head>
  <title>{title}</title>
</head>
<body>
{body}</body>
</html>
"#,
        lang = escape_xml(language),
        title = escape_xml(title),
    )
}

/// The EPUB 3 nav document, regenerated from the model's `NavPoint` tree.
/// Hrefs in `nav` are zip-internal paths (plus optional fragment) and are
/// rewritten relative to `nav_path`, the nav document's own zip path.
///
/// `aux` are the source document's preserved non-toc navs (landmarks,
/// page-list, …), re-emitted after the toc with hrefs recomputed from the
/// current manifest (`resources`): entries bound to a resource id follow the
/// resource's current path, entries whose resource no longer exists are
/// dropped, and a nav whose entries all dropped is omitted (an empty `<ol>`
/// would fail epubcheck).
pub(crate) fn write_nav_xhtml(
    metadata: &Metadata,
    nav: &[NavPoint],
    aux: &[AuxNav],
    resources: &[Resource],
    nav_path: &str,
) -> String {
    let nav_dir = parent_dir(nav_path);
    let mut items = String::new();
    write_nav_list(&mut items, nav, &nav_dir, 4);
    let mut aux_navs = String::new();
    for preserved in aux {
        write_aux_nav(&mut aux_navs, preserved, resources, &nav_dir);
    }
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="{lang}" lang="{lang}">
<head>
  <title>{title}</title>
</head>
<body>
  <nav epub:type="toc">
    <h1>Contents</h1>
    <ol>
{items}    </ol>
  </nav>
{aux_navs}</body>
</html>
"#,
        lang = escape_xml(&metadata.language),
        title = escape_xml(&metadata.title),
    )
}

/// Render one preserved non-toc nav, or nothing when every entry dropped.
fn write_aux_nav(out: &mut String, nav: &AuxNav, resources: &[Resource], nav_dir: &str) {
    // Landmarks entries must be links carrying an epub:type (EPUB 3 spec /
    // epubcheck); entries that lost their target or type are dropped.
    let landmarks = nav.epub_type.split_whitespace().any(|v| v == "landmarks");
    let mut items = String::new();
    write_aux_list(&mut items, &nav.entries, landmarks, resources, nav_dir, 4);
    if items.is_empty() {
        return;
    }
    out.push_str(&format!(
        "  <nav epub:type=\"{}\">\n",
        escape_xml(&nav.epub_type)
    ));
    if let Some(heading) = &nav.heading {
        out.push_str(&format!("    <h2>{}</h2>\n", escape_xml(heading)));
    }
    out.push_str("    <ol>\n");
    out.push_str(&items);
    out.push_str("    </ol>\n  </nav>\n");
}

/// Render one `<ol>` level of a preserved nav. Entries whose resource was
/// removed are dropped (with their children); landmarks entries additionally
/// require a target and an `epub:type`.
fn write_aux_list(
    out: &mut String,
    entries: &[AuxNavEntry],
    landmarks: bool,
    resources: &[Resource],
    nav_dir: &str,
    indent: usize,
) {
    let pad = " ".repeat(indent + 2);
    for entry in entries {
        let href = match &entry.target {
            Some(AuxTarget::Resource { id, fragment }) => {
                let Some(resource) = resources.iter().find(|r| r.id == *id) else {
                    continue; // target removed: drop the entry
                };
                let mut target = relative_href(nav_dir, &resource.path);
                if let Some(fragment) = fragment {
                    target.push('#');
                    target.push_str(fragment);
                }
                Some(target)
            }
            Some(AuxTarget::Href(href)) => Some(href.clone()),
            None => None,
        };
        if landmarks && (href.is_none() || entry.entry_type.is_none()) {
            continue;
        }
        let label = escape_xml(&entry.label);
        let entry_type = entry
            .entry_type
            .as_ref()
            .map(|t| format!(" epub:type=\"{}\"", escape_xml(t)))
            .unwrap_or_default();
        let anchor = match href {
            Some(href) => format!("<a{entry_type} href=\"{}\">{label}</a>", escape_xml(&href)),
            None => format!("<span>{label}</span>"),
        };
        let mut children = String::new();
        write_aux_list(
            &mut children,
            &entry.children,
            landmarks,
            resources,
            nav_dir,
            indent + 4,
        );
        if children.is_empty() {
            out.push_str(&format!("{pad}<li>{anchor}</li>\n"));
        } else {
            out.push_str(&format!(
                "{pad}<li>{anchor}\n{pad}  <ol>\n{children}{pad}  </ol>\n{pad}</li>\n"
            ));
        }
    }
}

/// Render one `<ol>` level of the nav tree (list items only, no `<ol>` tags
/// at the top level — the caller's template provides those).
fn write_nav_list(out: &mut String, points: &[NavPoint], nav_dir: &str, indent: usize) {
    let pad = " ".repeat(indent + 2);
    for point in points {
        let label = escape_xml(&point.label);
        let anchor = match &point.href {
            Some(href) => {
                let (path, fragment) = match href.split_once('#') {
                    Some((path, fragment)) => (path, Some(fragment)),
                    None => (href.as_str(), None),
                };
                let mut target = relative_href(nav_dir, path);
                if let Some(fragment) = fragment {
                    target.push('#');
                    target.push_str(fragment);
                }
                format!("<a href=\"{}\">{label}</a>", escape_xml(&target))
            }
            None => format!("<span>{label}</span>"),
        };
        if point.children.is_empty() {
            out.push_str(&format!("{pad}<li>{anchor}</li>\n"));
        } else {
            out.push_str(&format!("{pad}<li>{anchor}\n{pad}  <ol>\n"));
            write_nav_list(out, &point.children, nav_dir, indent + 4);
            out.push_str(&format!("{pad}  </ol>\n{pad}</li>\n"));
        }
    }
}

fn parent_dir(path: &str) -> String {
    match path.rfind('/') {
        Some(i) => path[..i].to_owned(),
        None => String::new(),
    }
}

/// Manifest href for `path` relative to the package directory, with segments
/// percent-encoded so the href is a valid URI.
fn relative_href(package_dir: &str, path: &str) -> String {
    let base: Vec<&str> = if package_dir.is_empty() {
        Vec::new()
    } else {
        package_dir.split('/').collect()
    };
    let target: Vec<&str> = path.split('/').collect();
    let mut common = 0;
    while common < base.len() && common + 1 < target.len() && base[common] == target[common] {
        common += 1;
    }
    let mut segments: Vec<String> = vec!["..".to_owned(); base.len() - common];
    segments.extend(target[common..].iter().map(|s| encode_segment(s)));
    segments.join("/")
}

/// Percent-encode one path segment (RFC 3986 unreserved + pchar subset kept).
fn encode_segment(segment: &str) -> String {
    let mut out = String::with_capacity(segment.len());
    for byte in segment.bytes() {
        match byte {
            b'A'..=b'Z'
            | b'a'..=b'z'
            | b'0'..=b'9'
            | b'-'
            | b'.'
            | b'_'
            | b'~'
            | b'!'
            | b'$'
            | b'&'
            | b'\''
            | b'('
            | b')'
            | b'*'
            | b'+'
            | b','
            | b';'
            | b'='
            | b':'
            | b'@' => out.push(byte as char),
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{EpubVersion, Resource, SpineItem};

    fn sample_metadata() -> Metadata {
        Metadata {
            title: "Tom & “Jérry” ✓".into(),
            authors: vec!["Áuthor <One>".into()],
            language: "en".into(),
            identifier: "urn:uuid:1234".into(),
            modified: None,
            description: None,
            publisher: None,
            cover_resource: None,
        }
    }

    #[test]
    fn timestamp_is_iso8601_utc() {
        let ts = now_iso8601();
        assert_eq!(ts.len(), 20, "unexpected shape: {ts}");
        assert!(ts.ends_with('Z'));
        assert_eq!(ts.as_bytes()[10], b'T');
    }

    #[test]
    fn identifiers_are_urn_uuid_shaped_and_distinct() {
        let a = generate_identifier();
        let b = generate_identifier();
        assert!(a.starts_with("urn:uuid:"));
        assert_eq!(a.len(), "urn:uuid:".len() + 36);
        assert_ne!(a, b);
    }

    #[test]
    fn escapes_markup_in_generated_documents() {
        let page = write_title_page_xhtml(&sample_metadata());
        assert!(page.contains("Tom &amp; “Jérry” ✓"));
        assert!(page.contains("Áuthor &lt;One&gt;"));
        assert!(!page.contains("<One>"));
    }

    #[test]
    fn opf_hrefs_are_relative_and_encoded() {
        let book = Book {
            id: "b1".into(),
            metadata: sample_metadata(),
            spine: vec![SpineItem {
                id: "spine-0".into(),
                resource: "ch1".into(),
                linear: true,
            }],
            nav: vec![],
            resources: vec![
                Resource {
                    id: "ch1".into(),
                    path: "OEBPS/text/ch 1.xhtml".into(),
                    media_type: "application/xhtml+xml".into(),
                    size: 10,
                },
                Resource {
                    id: "cover-img".into(),
                    path: "images/cover.jpg".into(),
                    media_type: "image/jpeg".into(),
                    size: 10,
                },
            ],
            source: None,
            epub_version: EpubVersion::V3,
            dirty: true,
        };
        let opf = write_opf(
            &book,
            None,
            None,
            "OEBPS/content.opf",
            "2026-08-23T00:00:00Z",
        );
        assert!(opf.contains(r#"href="text/ch%201.xhtml""#));
        assert!(opf.contains(r#"href="../images/cover.jpg""#));
        assert!(opf.contains(r#"<meta property="dcterms:modified">2026-08-23T00:00:00Z</meta>"#));
        assert!(opf.contains(r#"version="3.0""#));
    }

    #[test]
    fn opf_marks_nav_and_cover_properties() {
        let mut metadata = sample_metadata();
        metadata.cover_resource = Some("cover-img".into());
        let book = Book {
            id: "b1".into(),
            metadata,
            spine: vec![SpineItem {
                id: "spine-0".into(),
                resource: "nav".into(),
                linear: true,
            }],
            nav: vec![],
            resources: vec![
                Resource {
                    id: "nav".into(),
                    path: "OEBPS/nav.xhtml".into(),
                    media_type: "application/xhtml+xml".into(),
                    size: 10,
                },
                Resource {
                    id: "cover-img".into(),
                    path: "OEBPS/cover.jpg".into(),
                    media_type: "image/jpeg".into(),
                    size: 10,
                },
            ],
            source: None,
            epub_version: EpubVersion::V3,
            dirty: true,
        };
        let opf = write_opf(
            &book,
            Some("nav"),
            None,
            "OEBPS/content.opf",
            "2026-08-23T00:00:00Z",
        );
        assert!(opf.contains(
            r#"id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav""#
        ));
        assert!(opf.contains(r#"properties="cover-image""#));
    }

    fn xhtml_resource(id: &str, path: &str) -> Resource {
        Resource {
            id: id.into(),
            path: path.into(),
            media_type: "application/xhtml+xml".into(),
            size: 0,
        }
    }

    fn entry(label: &str, entry_type: Option<&str>, target: Option<AuxTarget>) -> AuxNavEntry {
        AuxNavEntry {
            label: label.into(),
            entry_type: entry_type.map(str::to_owned),
            target,
            children: Vec::new(),
        }
    }

    fn resource_target(id: &str, fragment: Option<&str>) -> Option<AuxTarget> {
        Some(AuxTarget::Resource {
            id: id.into(),
            fragment: fragment.map(str::to_owned),
        })
    }

    #[test]
    fn nav_preserves_landmarks_and_page_list() {
        let resources = vec![
            xhtml_resource("ch1", "OEBPS/text/ch1.xhtml"),
            xhtml_resource("ch2", "OEBPS/text/ch2.xhtml"),
        ];
        let aux = vec![
            AuxNav {
                epub_type: "landmarks".into(),
                heading: Some("Guide".into()),
                entries: vec![
                    entry("Start", Some("bodymatter"), resource_target("ch1", None)),
                    entry(
                        "External",
                        Some("other"),
                        Some(AuxTarget::Href("https://example.com/?a=1".into())),
                    ),
                ],
            },
            AuxNav {
                epub_type: "page-list".into(),
                heading: None,
                entries: vec![
                    entry("1", None, resource_target("ch1", Some("p1"))),
                    entry("2", None, resource_target("ch2", Some("p2"))),
                ],
            },
        ];
        let doc = write_nav_xhtml(&sample_metadata(), &[], &aux, &resources, "OEBPS/nav.xhtml");
        assert!(doc.contains(r#"<nav epub:type="landmarks">"#));
        assert!(doc.contains("<h2>Guide</h2>"));
        assert!(doc.contains(r#"<a epub:type="bodymatter" href="text/ch1.xhtml">Start</a>"#));
        assert!(doc.contains(r#"href="https://example.com/?a=1""#));
        assert!(doc.contains(r#"<nav epub:type="page-list">"#));
        assert!(doc.contains(r#"<a href="text/ch1.xhtml#p1">1</a>"#));
        assert!(doc.contains(r#"<a href="text/ch2.xhtml#p2">2</a>"#));
    }

    #[test]
    fn aux_hrefs_follow_a_moved_resource() {
        let aux = vec![AuxNav {
            epub_type: "page-list".into(),
            heading: None,
            entries: vec![entry("1", None, resource_target("ch1", Some("p1")))],
        }];
        let before = write_nav_xhtml(
            &sample_metadata(),
            &[],
            &aux,
            &[xhtml_resource("ch1", "OEBPS/ch1.xhtml")],
            "OEBPS/nav.xhtml",
        );
        assert!(before.contains(r#"<a href="ch1.xhtml#p1">1</a>"#));
        // Same entry after the resource moved: href rewritten to follow it.
        let after = write_nav_xhtml(
            &sample_metadata(),
            &[],
            &aux,
            &[xhtml_resource("ch1", "OEBPS/text/renamed.xhtml")],
            "OEBPS/nav.xhtml",
        );
        assert!(after.contains(r#"<a href="text/renamed.xhtml#p1">1</a>"#));
        assert!(!after.contains(r#""ch1.xhtml#p1""#));
    }

    #[test]
    fn aux_entries_with_removed_targets_are_dropped() {
        let resources = vec![xhtml_resource("ch1", "OEBPS/ch1.xhtml")];
        let aux = vec![
            AuxNav {
                epub_type: "page-list".into(),
                heading: None,
                entries: vec![
                    entry("1", None, resource_target("ch1", Some("p1"))),
                    entry("2", None, resource_target("ch2-gone", Some("p2"))),
                ],
            },
            AuxNav {
                epub_type: "landmarks".into(),
                heading: None,
                entries: vec![entry(
                    "Start",
                    Some("bodymatter"),
                    resource_target("ch2-gone", None),
                )],
            },
        ];
        let doc = write_nav_xhtml(&sample_metadata(), &[], &aux, &resources, "OEBPS/nav.xhtml");
        assert!(doc.contains(r#"<a href="ch1.xhtml#p1">1</a>"#));
        assert!(!doc.contains(">2</a>"));
        // The landmarks nav lost its only entry: omitted entirely, so no
        // empty <ol> reaches epubcheck.
        assert!(!doc.contains(r#"epub:type="landmarks""#));
    }

    #[test]
    fn landmarks_entries_without_type_or_href_are_dropped() {
        let resources = vec![xhtml_resource("ch1", "OEBPS/ch1.xhtml")];
        let aux = vec![AuxNav {
            epub_type: "landmarks".into(),
            heading: None,
            entries: vec![
                entry("No type", None, resource_target("ch1", None)),
                entry("No target", Some("bodymatter"), None),
                entry("Kept", Some("bodymatter"), resource_target("ch1", None)),
            ],
        }];
        let doc = write_nav_xhtml(&sample_metadata(), &[], &aux, &resources, "OEBPS/nav.xhtml");
        assert!(!doc.contains("No type"));
        assert!(!doc.contains("No target"));
        assert!(doc.contains(r#"<a epub:type="bodymatter" href="ch1.xhtml">Kept</a>"#));
    }
}
