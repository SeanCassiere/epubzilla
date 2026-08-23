//! Generates real EPUBs into `target/epubcheck-fixtures/` for CI's epubcheck
//! job (ADR-0003: full epubcheck runs in CI only). Run via
//! `cargo test -p epubzilla-core --test epubcheck_fixtures`.

use std::io::Write;
use std::path::PathBuf;

use epubzilla_core::{ChapterContent, ContentFormat, Metadata, Session, SpineItemId};
use zip::write::SimpleFileOptions;

/// A tiny valid 1x1 transparent PNG (same bytes as the M1.5 fixtures).
const PNG_1X1: &[u8] = &[
    0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4,
    0x89, 0x00, 0x00, 0x00, 0x0A, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9C, 0x63, 0x00, 0x01, 0x00, 0x00,
    0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE,
    0x42, 0x60, 0x82,
];

fn fixtures_dir() -> PathBuf {
    // crates/core → workspace root → target/epubcheck-fixtures
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../target/epubcheck-fixtures");
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
fn generate_epubcheck_fixtures() {
    let dir = fixtures_dir();
    let mut session = Session::new();

    // Fixture 1: a book born from create_book, unicode metadata throughout.
    let book = session.create_book(Metadata {
        title: "Ünïcode “Fixture” — こんにちは ✓".into(),
        authors: vec!["Ærin Author".into(), "Zoë Writer".into()],
        language: "en".into(),
        identifier: String::new(), // generated urn:uuid
        modified: None,
        description: Some("A generated fixture with ünïcode metadata.".into()),
        publisher: Some("Epubzilla Tëst House".into()),
        cover_resource: None,
    });
    let created = dir.join("created-unicode.epub");
    session
        .save_book(&book.id, Some(created.to_string_lossy().into_owned()))
        .unwrap();

    // Fixture 2: an existing multi-chapter EPUB 3 resaved incrementally
    // (raw-copied chapters + regenerated OPF).
    let source = build_source_epub(&dir);
    let book = session.open_book(&source).unwrap();
    let resaved = dir.join("resaved-incremental.epub");
    session
        .save_book(&book.id, Some(resaved.to_string_lossy().into_owned()))
        .unwrap();
    std::fs::remove_file(&source).unwrap();

    // Fixture 3: the full mutation lifecycle (M0.8) — create, add chapters,
    // write Markdown, reorder, remove — so CI's epubcheck validates output
    // produced by every mutation command (core-api.md consistency rule 2).
    let book = session.create_book(Metadata {
        title: "Mütation Lifecycle ✓".into(),
        authors: vec!["Mütation Tester".into()],
        language: "en".into(),
        identifier: String::new(),
        modified: None,
        description: None,
        publisher: None,
        cover_resource: None,
    });
    let book_id = book.id.clone();
    let mut resources = Vec::new();
    for title in ["Chäpter One", "Chapter Twö ✓", "Chapter Three"] {
        let book = session.add_chapter(&book_id, title, None).unwrap();
        resources.push(book.spine.last().unwrap().resource.clone());
    }
    // M3.3: an added image, referenced from the first chapter's Markdown, so
    // epubcheck validates add_resource output and the in-book reference.
    let book = session
        .add_resource(&book_id, "pixel.png", "image/png", PNG_1X1.to_vec())
        .unwrap();
    let image_path = book
        .resources
        .iter()
        .find(|r| r.media_type == "image/png")
        .map(|r| r.path.clone())
        .unwrap();
    assert_eq!(image_path, "OEBPS/images/pixel.png");
    for (n, resource) in resources.iter().enumerate() {
        let image = if n == 0 {
            "\n![A pixel](images/pixel.png)\n"
        } else {
            ""
        };
        let md = format!(
            "# Chapter {n}\n\nBödy with *émphasis*, `code`, and a list ✓:\n\n- one\n- two\n{image}",
        );
        session
            .write_chapter(
                &book_id,
                resource,
                ChapterContent {
                    resource: resource.clone(),
                    format: ContentFormat::Markdown,
                    content: md,
                    fallback_reason: None,
                },
            )
            .unwrap();
    }
    let book = session.get_book(&book_id).unwrap();
    let order: Vec<SpineItemId> = vec![
        book.spine[0].id.clone(),
        book.spine[3].id.clone(),
        book.spine[1].id.clone(),
        book.spine[2].id.clone(),
    ];
    session.reorder_spine(&book_id, &order).unwrap();
    let book = session.get_book(&book_id).unwrap();
    let last = book.spine.last().unwrap().id.clone();
    session.remove_chapter(&book_id, &last).unwrap();
    assert!(session.validate(&book_id).unwrap().is_empty());
    let mutated = dir.join("mutation-lifecycle.epub");
    session
        .save_book(&book_id, Some(mutated.to_string_lossy().into_owned()))
        .unwrap();

    // Fixture 4 (M3.4): the UI edit path. Open an existing book, read a
    // chapter as the editor does (`prefer: Markdown`), edit the markdown,
    // write_chapter, save, then REOPEN the saved file and prove
    // read_chapter(Markdown) returns the edited markdown — a semantic
    // round-trip through the real XHTML serialization. The saved book is
    // left in the fixtures dir so CI's epubcheck validates it too.
    let source = build_source_epub(&dir);
    let book = session.open_book(&source).unwrap();
    let read = session
        .read_chapter(&book.id, "ch1", ContentFormat::Markdown)
        .unwrap();
    assert_eq!(
        read.format,
        ContentFormat::Markdown,
        "fixture ch1 must be inside the round-trip subset"
    );
    let edited = format!(
        "{}\n\nÉdited through the UI command path ✓ — *emphasis* survives.\n",
        read.content.trim_end()
    );
    session
        .write_chapter(
            &book.id,
            "ch1",
            ChapterContent {
                resource: "ch1".into(),
                format: ContentFormat::Markdown,
                content: edited.clone(),
                fallback_reason: None,
            },
        )
        .unwrap();
    let edited_path = dir.join("edited-roundtrip.epub");
    session
        .save_book(&book.id, Some(edited_path.to_string_lossy().into_owned()))
        .unwrap();
    std::fs::remove_file(&source).unwrap();
    let reopened = session.open_book(&edited_path).unwrap();
    let round = session
        .read_chapter(&reopened.id, "ch1", ContentFormat::Markdown)
        .unwrap();
    assert_eq!(round.format, ContentFormat::Markdown);
    assert_eq!(round.content.trim_end(), edited.trim_end());
    // Untouched chapter is byte-preserved semantics: still round-trips.
    let untouched = session
        .read_chapter(&reopened.id, "ch2", ContentFormat::Markdown)
        .unwrap();
    assert_eq!(untouched.format, ContentFormat::Markdown);

    // All must reopen cleanly; epubcheck does the deep validation in CI.
    session.open_book(&created).unwrap();
    session.open_book(&resaved).unwrap();
    let reopened = session.open_book(&mutated).unwrap();
    assert!(session.validate(&reopened.id).unwrap().is_empty());
}

/// Hand-build a valid multi-chapter EPUB 3 to exercise the incremental path.
fn build_source_epub(dir: &std::path::Path) -> PathBuf {
    const CONTAINER_XML: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
"#;
    const OPF: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="pub-id">urn:uuid:5a11ad0e-1111-4e6e-8e6e-000000000001</dc:identifier>
    <dc:title>Incremental Sœurce ✓</dc:title>
    <dc:creator>Chapter Smith</dc:creator>
    <dc:language>en</dc:language>
    <meta property="dcterms:modified">2026-01-01T00:00:00Z</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch2" href="ch2.xhtml" media-type="application/xhtml+xml"/>
    <item id="style" href="style.css" media-type="text/css"/>
  </manifest>
  <spine>
    <itemref idref="ch1"/>
    <itemref idref="ch2"/>
  </spine>
</package>
"#;
    const NAV: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="en" lang="en">
<head><title>Contents</title></head>
<body>
  <nav epub:type="toc">
    <h1>Contents</h1>
    <ol>
      <li><a href="ch1.xhtml">Chäpter One</a></li>
      <li><a href="ch2.xhtml">Chapter Two</a></li>
    </ol>
  </nav>
</body>
</html>
"#;
    const CH1: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="en" lang="en">
<head><title>Chäpter One</title><link rel="stylesheet" type="text/css" href="style.css"/></head>
<body><h1>Chäpter One</h1><p>Hëllo — first chapter, with ünïcode ✓.</p></body>
</html>
"#;
    const CH2: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="en" lang="en">
<head><title>Chapter Two</title></head>
<body><h1>Chapter Two</h1><p>Second chapter body.</p></body>
</html>
"#;
    const CSS: &str = "body { font-family: serif; }\n";

    let path = dir.join("source-tmp.epub");
    let file = std::fs::File::create(&path).unwrap();
    let mut writer = zip::ZipWriter::new(file);
    let entries: &[(&str, &str)] = &[
        ("mimetype", "application/epub+zip"),
        ("META-INF/container.xml", CONTAINER_XML),
        ("OEBPS/content.opf", OPF),
        ("OEBPS/nav.xhtml", NAV),
        ("OEBPS/ch1.xhtml", CH1),
        ("OEBPS/ch2.xhtml", CH2),
        ("OEBPS/style.css", CSS),
    ];
    for (name, content) in entries {
        let options = if *name == "mimetype" {
            SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored)
        } else {
            SimpleFileOptions::default()
        };
        writer.start_file(*name, options).unwrap();
        writer.write_all(content.as_bytes()).unwrap();
    }
    writer.finish().unwrap();
    path
}
