//! Generator for the frontend integration-test fixtures (M1.5).
//!
//! Builds two REAL EPUB files (an EPUB 3 with a nested nav, an image, a
//! stylesheet, an inter-chapter link, a non-linear spine item, and unicode
//! metadata; an EPUB 2 with an NCX TOC), opens them through the same
//! `epubzilla_core::Session` the Tauri commands wrap, and snapshots what the
//! commands actually return (`Book` + `ChapterContent` per spine item) as
//! JSON into `frontend/src/test/fixtures/`.
//!
//! The JSON files are committed so the frontend CI job stays node-only.
//! Regenerate after core/model changes with:
//!
//! ```sh
//! cargo test -p epubzilla-app --test gen_fixtures -- --ignored
//! ```

use std::collections::BTreeMap;
use std::io::Write;
use std::path::{Path, PathBuf};

use epubzilla_core::{ContentFormat, Session};
use zip::write::SimpleFileOptions;
use zip::CompressionMethod;

/// A tiny valid 1x1 transparent PNG. The core never decodes image bytes;
/// this only has to be a real file with a stable size.
const PNG_1X1: &[u8] = &[
    0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4,
    0x89, 0x00, 0x00, 0x00, 0x0A, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9C, 0x63, 0x00, 0x01, 0x00, 0x00,
    0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE,
    0x42, 0x60, 0x82,
];

const CONTAINER_XML: &str = r#"<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
"#;

/// Write an EPUB zip: `mimetype` stored first, everything else deflated.
fn write_epub(path: &Path, entries: &[(&str, &[u8])]) {
    let file = std::fs::File::create(path).unwrap();
    let mut zip = zip::ZipWriter::new(file);
    zip.start_file(
        "mimetype",
        SimpleFileOptions::default().compression_method(CompressionMethod::Stored),
    )
    .unwrap();
    zip.write_all(b"application/epub+zip").unwrap();
    let deflated = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    for (name, bytes) in entries {
        zip.start_file(*name, deflated).unwrap();
        zip.write_all(bytes).unwrap();
    }
    zip.finish().unwrap();
}

fn chapter_xhtml(title: &str, body: &str) -> String {
    format!(
        r#"<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head>
  <title>{title}</title>
  <link rel="stylesheet" type="text/css" href="../styles/book.css"/>
</head>
<body>
{body}
</body>
</html>
"#
    )
}

fn epub3_entries() -> Vec<(&'static str, Vec<u8>)> {
    let opf = r#"<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id" xml:lang="en">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="pub-id">urn:uuid:5a2f0c6e-8f7a-4bd2-9c3e-fixture-e3</dc:identifier>
    <dc:title>Épübzïlla — 世界の本 ✓</dc:title>
    <dc:creator>Åsa Öberg</dc:creator>
    <dc:creator>李雷</dc:creator>
    <dc:language>en</dc:language>
    <meta property="dcterms:modified">2026-01-01T00:00:00Z</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="ch1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch2" href="text/ch2.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch3" href="text/ch3.xhtml" media-type="application/xhtml+xml"/>
    <item id="notes" href="text/notes.xhtml" media-type="application/xhtml+xml"/>
    <item id="css" href="styles/book.css" media-type="text/css"/>
    <item id="pic" href="images/pic.png" media-type="image/png"/>
  </manifest>
  <spine>
    <itemref idref="ch1"/>
    <itemref idref="ch2"/>
    <itemref idref="ch3"/>
    <itemref idref="notes" linear="no"/>
  </spine>
</package>
"#;

    let nav = r#"<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>Contents</title></head>
<body>
  <nav epub:type="toc">
    <ol>
      <li><span>Part I — Beginnings</span>
        <ol>
          <li><a href="text/ch1.xhtml">Chapter 1 — Ünïcode</a></li>
          <li><a href="text/ch2.xhtml">Chapter 2</a>
            <ol>
              <li><a href="text/ch2.xhtml#sec21">Section 2.1</a></li>
            </ol>
          </li>
        </ol>
      </li>
      <li><a href="text/ch3.xhtml">Chapter 3</a></li>
      <li><a href="text/notes.xhtml">Notes</a></li>
    </ol>
  </nav>
</body>
</html>
"#;

    let ch1 = chapter_xhtml(
        "Chapter 1",
        r#"<h1>Chapter 1 — Ünïcode ✓</h1>
<p><img src="../images/pic.png" alt="fixture image"/></p>
<p>Onwards to <a href="ch2.xhtml#sec21">Section 2.1</a> or outside to
<a href="https://example.com/">example.com</a>.</p>
<script>document.title = "must be stripped";</script>"#,
    );
    let ch2 = chapter_xhtml(
        "Chapter 2",
        r#"<h1>Chapter 2</h1>
<p>Back to <a href="ch1.xhtml">Chapter 1</a>.</p>
<h2 id="sec21">Section 2.1</h2>
<p>Fragment target.</p>"#,
    );
    let ch3 = chapter_xhtml("Chapter 3", "<h1>Chapter 3</h1>\n<p>The end.</p>");
    let notes = chapter_xhtml(
        "Notes",
        "<h1>Notes</h1>\n<p>Non-linear auxiliary content.</p>",
    );
    let css = "body { color: #333333; }\nimg { border: 1px solid #999999; }\n";

    vec![
        ("META-INF/container.xml", CONTAINER_XML.into()),
        ("OEBPS/content.opf", opf.into()),
        ("OEBPS/nav.xhtml", nav.into()),
        ("OEBPS/text/ch1.xhtml", ch1.into_bytes()),
        ("OEBPS/text/ch2.xhtml", ch2.into_bytes()),
        ("OEBPS/text/ch3.xhtml", ch3.into_bytes()),
        ("OEBPS/text/notes.xhtml", notes.into_bytes()),
        ("OEBPS/styles/book.css", css.into()),
        ("OEBPS/images/pic.png", PNG_1X1.to_vec()),
    ]
}

fn epub2_entries() -> Vec<(&'static str, Vec<u8>)> {
    let opf = r#"<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
    <dc:identifier id="bookid">urn:uuid:0b1d9c2a-legacy-fixture-e2</dc:identifier>
    <dc:title>Ältere Bücher: eine EPUB-2-Probe</dc:title>
    <dc:creator>Grüße Müller</dc:creator>
    <dc:language>de</dc:language>
  </metadata>
  <manifest>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/>
    <item id="c2" href="c2.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine toc="ncx">
    <itemref idref="c1"/>
    <itemref idref="c2"/>
  </spine>
</package>
"#;

    let ncx = r#"<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head><meta name="dtb:uid" content="urn:uuid:0b1d9c2a-legacy-fixture-e2"/></head>
  <docTitle><text>Ältere Bücher: eine EPUB-2-Probe</text></docTitle>
  <navMap>
    <navPoint id="n1" playOrder="1">
      <navLabel><text>Erstes Kapitel</text></navLabel>
      <content src="c1.xhtml"/>
      <navPoint id="n1a" playOrder="2">
        <navLabel><text>Abschnitt Eins</text></navLabel>
        <content src="c1.xhtml#abschnitt"/>
      </navPoint>
    </navPoint>
    <navPoint id="n2" playOrder="3">
      <navLabel><text>Zweites Kapitel</text></navLabel>
      <content src="c2.xhtml"/>
    </navPoint>
  </navMap>
</ncx>
"#;

    let c1 = r#"<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>Erstes Kapitel</title></head>
<body>
<h1>Erstes Kapitel</h1>
<p>Grüße aus einem EPUB-2-Buch.</p>
<h2 id="abschnitt">Abschnitt Eins</h2>
<p>NCX-Fragmentziel.</p>
</body>
</html>
"#;
    let c2 = r#"<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>Zweites Kapitel</title></head>
<body>
<h1>Zweites Kapitel</h1>
<p>Ende.</p>
</body>
</html>
"#;

    vec![
        ("META-INF/container.xml", CONTAINER_XML.into()),
        ("OEBPS/content.opf", opf.into()),
        ("OEBPS/toc.ncx", ncx.into()),
        ("OEBPS/c1.xhtml", c1.into()),
        ("OEBPS/c2.xhtml", c2.into()),
    ]
}

/// Open one fixture EPUB via the real Session and snapshot the command
/// results: the `Book`, a `ChapterContent` per spine resource (as the
/// reader requests it, `prefer: Xhtml`), and — M3.4 — the same chapters
/// read with `prefer: Markdown` (as the editor requests them), so the
/// frontend harness serves REAL core conversion output: in-subset chapters
/// come back as Markdown, out-of-subset ones as the Xhtml fallback.
fn snapshot(session: &mut Session, epub_path: &Path, out_path: &Path) {
    let book = session.open_book(epub_path).unwrap();
    let mut chapters = BTreeMap::new();
    let mut markdown = BTreeMap::new();
    for item in &book.spine {
        let content = session
            .read_chapter(&book.id, &item.resource, ContentFormat::Xhtml)
            .unwrap();
        chapters.insert(item.resource.clone(), content);
        let preferred = session
            .read_chapter(&book.id, &item.resource, ContentFormat::Markdown)
            .unwrap();
        markdown.insert(item.resource.clone(), preferred);
    }
    // `source` is a machine-local temp path; blank it so the committed
    // fixture is deterministic (the frontend tests never depend on it).
    let mut book_json = serde_json::to_value(&book).unwrap();
    book_json["source"] = serde_json::Value::Null;
    let json = serde_json::json!({ "book": book_json, "chapters": chapters, "markdown": markdown });
    let mut text = serde_json::to_string_pretty(&json).unwrap();
    text.push('\n');
    std::fs::write(out_path, text).unwrap();
}

/// Regenerates frontend/src/test/fixtures/{epub3,epub2}.json. Ignored so a
/// plain `cargo test` never rewrites committed files; run explicitly with
/// the command in the module doc when the core model or parser changes.
#[test]
#[ignore = "fixture regeneration — run explicitly with --ignored"]
fn regenerate_frontend_fixtures() {
    let tmp = std::env::temp_dir().join(format!("epubzilla-fixtures-{}", std::process::id()));
    std::fs::create_dir_all(&tmp).unwrap();

    let epub3 = tmp.join("fixture-epub3.epub");
    let entries3 = epub3_entries();
    let borrowed3: Vec<(&str, &[u8])> = entries3.iter().map(|(n, b)| (*n, b.as_slice())).collect();
    write_epub(&epub3, &borrowed3);

    let epub2 = tmp.join("fixture-epub2.epub");
    let entries2 = epub2_entries();
    let borrowed2: Vec<(&str, &[u8])> = entries2.iter().map(|(n, b)| (*n, b.as_slice())).collect();
    write_epub(&epub2, &borrowed2);

    let fixtures_dir =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../frontend/src/test/fixtures");
    std::fs::create_dir_all(&fixtures_dir).unwrap();

    // One session so the ids are deterministic: book-1 (EPUB 3), book-2 (EPUB 2).
    let mut session = Session::new();
    snapshot(&mut session, &epub3, &fixtures_dir.join("epub3.json"));
    snapshot(&mut session, &epub2, &fixtures_dir.join("epub2.json"));
}
