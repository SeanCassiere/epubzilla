//! Generates real EPUBs into `target/epubcheck-fixtures/` for CI's epubcheck
//! job (ADR-0003: full epubcheck runs in CI only). Run via
//! `cargo test -p epubzilla-core --test epubcheck_fixtures`.

use std::io::Write;
use std::path::PathBuf;

use epubzilla_core::{Metadata, Session};
use zip::write::SimpleFileOptions;

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

    // Both must reopen cleanly; epubcheck does the deep validation in CI.
    session.open_book(&created).unwrap();
    session.open_book(&resaved).unwrap();
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
