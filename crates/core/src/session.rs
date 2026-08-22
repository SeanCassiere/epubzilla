//! Book model assembly and the in-memory session of open books.
//!
//! `open_book` wires the container (M0.2), OPF (M0.3), and nav (M0.4) layers
//! into the `Book` index eagerly; chapter bodies stay in the zip and are
//! decompressed on demand via `read_chapter` / `read_resource` (ADR-0002,
//! domain-model.md invariant 3).

use std::collections::HashMap;
use std::fs::File;
use std::path::Path;

use crate::container::OcfContainer;
use crate::error::{CoreError, CoreResult};
use crate::model::{Book, BookId, ChapterContent, ContentFormat, NavPoint, Resource};
use crate::{nav, opf};

const XHTML_MEDIA_TYPE: &str = "application/xhtml+xml";

/// One open book: the lightweight model plus its container, kept open for
/// lazy content reads.
struct OpenBook {
    book: Book,
    container: OcfContainer<File>,
}

/// In-memory registry of open books, keyed by `BookId` (core-api.md).
#[derive(Default)]
pub struct Session {
    books: HashMap<BookId, OpenBook>,
    next_id: u64,
}

impl Session {
    pub fn new() -> Self {
        Self::default()
    }

    /// Open an EPUB from an OS path: container → OPF → nav, sizes filled,
    /// invariants enforced. Chapter bodies are not read.
    pub fn open_book(&mut self, path: impl AsRef<Path>) -> CoreResult<Book> {
        let path = path.as_ref();
        let mut container = OcfContainer::open_path(path)?;

        let package_path = container.package_path().to_owned();
        let opf_bytes = container.read_entry(&package_path)?;
        let package = opf::parse_opf(&opf_bytes, &package_path)?;

        let mut resources = package.resources;
        fill_sizes(&mut resources, &mut container);

        let nav = parse_nav(
            &mut container,
            &resources,
            package.nav_resource.as_deref(),
            package.ncx_resource.as_deref(),
        )?;

        // Invariants (domain-model.md): spine idrefs resolve (also checked by
        // the OPF parser) and every nav href points at a manifest resource.
        for item in &package.spine {
            if !resources.iter().any(|r| r.id == item.resource) {
                return Err(CoreError::MalformedPackage {
                    message: format!("spine item {:?} has no manifest resource", item.resource),
                });
            }
        }
        nav::validate_nav_targets(&nav, &resources)?;

        self.next_id += 1;
        let id: BookId = format!("book-{}", self.next_id);
        let book = Book {
            id: id.clone(),
            metadata: package.metadata,
            spine: package.spine,
            nav,
            resources,
            source: Some(path.to_string_lossy().into_owned()),
            epub_version: package.version,
            dirty: false,
        };
        self.books.insert(
            id,
            OpenBook {
                book: book.clone(),
                container,
            },
        );
        Ok(book)
    }

    /// Current model snapshot.
    pub fn get_book(&self, book_id: &str) -> CoreResult<Book> {
        self.open(book_id).map(|ob| ob.book.clone())
    }

    /// Decompress one chapter on demand. Always returns `format: Xhtml` for
    /// now; Markdown conversion lands with M0.7/M0.8 — see #10 for wiring
    /// `prefer: Markdown` through the converter.
    pub fn read_chapter(
        &mut self,
        book_id: &str,
        resource_id: &str,
        prefer: ContentFormat,
    ) -> CoreResult<ChapterContent> {
        let _ = prefer; // Honored from M0.7/M0.8 on (#10).
        let open = self.open_mut(book_id)?;
        let resource = find_resource(&open.book, resource_id)?;
        if resource.media_type != XHTML_MEDIA_TYPE {
            return Err(CoreError::UnsupportedFeature {
                message: format!(
                    "resource {resource_id:?} is {:?}, not a chapter ({XHTML_MEDIA_TYPE})",
                    resource.media_type
                ),
            });
        }
        let path = resource.path.clone();
        let bytes = open.container.read_entry(&path)?;
        let content = String::from_utf8(bytes).map_err(|e| CoreError::MalformedPackage {
            message: format!("chapter {path} is not valid UTF-8: {e}"),
        })?;
        Ok(ChapterContent {
            resource: resource_id.to_owned(),
            format: ContentFormat::Xhtml,
            content,
        })
    }

    /// Raw bytes of any manifest resource (images, CSS, fonts, …).
    pub fn read_resource(&mut self, book_id: &str, resource_id: &str) -> CoreResult<Vec<u8>> {
        let open = self.open_mut(book_id)?;
        let path = find_resource(&open.book, resource_id)?.path.clone();
        open.container.read_entry(&path)
    }

    /// Drop session state for one book.
    pub fn close_book(&mut self, book_id: &str) -> CoreResult<()> {
        self.books
            .remove(book_id)
            .map(|_| ())
            .ok_or_else(|| CoreError::ResourceNotFound {
                id: book_id.to_owned(),
            })
    }

    fn open(&self, book_id: &str) -> CoreResult<&OpenBook> {
        self.books
            .get(book_id)
            .ok_or_else(|| CoreError::ResourceNotFound {
                id: book_id.to_owned(),
            })
    }

    fn open_mut(&mut self, book_id: &str) -> CoreResult<&mut OpenBook> {
        self.books
            .get_mut(book_id)
            .ok_or_else(|| CoreError::ResourceNotFound {
                id: book_id.to_owned(),
            })
    }
}

fn find_resource<'b>(book: &'b Book, resource_id: &str) -> CoreResult<&'b Resource> {
    book.resources
        .iter()
        .find(|r| r.id == resource_id)
        .ok_or_else(|| CoreError::ResourceNotFound {
            id: resource_id.to_owned(),
        })
}

/// Fill `Resource.size` from the zip. Manifest items whose entry is missing
/// from the archive keep size 0 (lenient on read; validation flags them).
fn fill_sizes(resources: &mut [Resource], container: &mut OcfContainer<File>) {
    for resource in resources {
        if let Ok(size) = container.entry_size(&resource.path) {
            resource.size = size;
        }
    }
}

/// Prefer the EPUB 3 nav document, fall back to the NCX, else empty.
fn parse_nav(
    container: &mut OcfContainer<File>,
    resources: &[Resource],
    nav_resource: Option<&str>,
    ncx_resource: Option<&str>,
) -> CoreResult<Vec<NavPoint>> {
    let path_of = |id: &str| {
        resources
            .iter()
            .find(|r| r.id == id)
            .map(|r| r.path.clone())
    };
    if let Some(path) = nav_resource.and_then(path_of) {
        let bytes = container.read_entry(&path)?;
        return nav::parse_nav_xhtml(&bytes, &path);
    }
    if let Some(path) = ncx_resource.and_then(path_of) {
        let bytes = container.read_entry(&path)?;
        return nav::parse_ncx(&bytes, &path);
    }
    Ok(Vec::new())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use zip::write::SimpleFileOptions;

    const CONTAINER_XML: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>"#;

    const EPUB3_OPF: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="pub-id">urn:uuid:1234</dc:identifier>
    <dc:title>Ünïcode “Book” ✓</dc:title>
    <dc:creator>Author One</dc:creator>
    <dc:language>en</dc:language>
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
</package>"#;

    const NAV_XHTML: &str = r#"<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<body><nav epub:type="toc"><ol>
  <li><a href="ch1.xhtml">Chapter 1</a></li>
  <li><a href="ch2.xhtml">Chapter 2</a></li>
</ol></nav></body></html>"#;

    const CH1: &str = r#"<html xmlns="http://www.w3.org/1999/xhtml"><body><p>Hëllo — chapter one ✓</p></body></html>"#;
    const CH2: &str =
        r#"<html xmlns="http://www.w3.org/1999/xhtml"><body><p>Chapter two</p></body></html>"#;
    const CSS: &str = "body { color: black; }";

    const EPUB2_OPF: &str = r#"<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>Old Book</dc:title>
    <dc:language>de</dc:language>
    <dc:identifier id="bookid">isbn:12345</dc:identifier>
  </metadata>
  <manifest>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine toc="ncx">
    <itemref idref="ch1"/>
  </spine>
</package>"#;

    const NCX: &str = r#"<?xml version="1.0"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <navMap>
    <navPoint id="n1" playOrder="1">
      <navLabel><text>Kapitel 1</text></navLabel>
      <content src="ch1.xhtml"/>
    </navPoint>
  </navMap>
</ncx>"#;

    /// Write a real .epub (zip) file into a per-test temp dir.
    fn write_epub(name: &str, entries: &[(&str, &str)]) -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("epubzilla-session-tests-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(name);
        let file = std::fs::File::create(&path).unwrap();
        let mut writer = zip::ZipWriter::new(file);
        for (entry, content) in entries {
            let options = if *entry == "mimetype" {
                SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored)
            } else {
                SimpleFileOptions::default()
            };
            writer.start_file(*entry, options).unwrap();
            writer.write_all(content.as_bytes()).unwrap();
        }
        writer.finish().unwrap();
        path
    }

    fn epub3_entries() -> Vec<(&'static str, &'static str)> {
        vec![
            ("mimetype", "application/epub+zip"),
            ("META-INF/container.xml", CONTAINER_XML),
            ("OEBPS/content.opf", EPUB3_OPF),
            ("OEBPS/nav.xhtml", NAV_XHTML),
            ("OEBPS/ch1.xhtml", CH1),
            ("OEBPS/ch2.xhtml", CH2),
            ("OEBPS/style.css", CSS),
        ]
    }

    #[test]
    fn opens_epub3_end_to_end() {
        let path = write_epub("epub3.epub", &epub3_entries());
        let mut session = Session::new();
        let book = session.open_book(&path).unwrap();

        assert_eq!(book.metadata.title, "Ünïcode “Book” ✓");
        assert_eq!(book.metadata.authors, vec!["Author One"]);
        assert_eq!(book.epub_version, crate::EpubVersion::V3);
        assert_eq!(book.source.as_deref(), Some(path.to_str().unwrap()));
        assert!(!book.dirty);

        assert_eq!(book.spine.len(), 2);
        assert_eq!(book.spine[0].resource, "ch1");

        assert_eq!(book.nav.len(), 2);
        assert_eq!(book.nav[0].label, "Chapter 1");
        assert_eq!(book.nav[0].href.as_deref(), Some("OEBPS/ch1.xhtml"));

        // Sizes are filled from the archive.
        let ch1 = book.resources.iter().find(|r| r.id == "ch1").unwrap();
        assert_eq!(ch1.size, CH1.len() as u64);
        assert!(book.resources.iter().all(|r| r.size > 0));

        // get_book returns the same snapshot.
        let again = session.get_book(&book.id).unwrap();
        assert_eq!(again.metadata.title, book.metadata.title);
    }

    #[test]
    fn opens_epub2_with_ncx_fallback() {
        let entries = vec![
            ("mimetype", "application/epub+zip"),
            ("META-INF/container.xml", CONTAINER_XML),
            ("OEBPS/content.opf", EPUB2_OPF),
            ("OEBPS/toc.ncx", NCX),
            ("OEBPS/ch1.xhtml", CH1),
        ];
        let path = write_epub("epub2.epub", &entries);
        let mut session = Session::new();
        let book = session.open_book(&path).unwrap();

        assert_eq!(book.epub_version, crate::EpubVersion::V2);
        assert_eq!(book.metadata.title, "Old Book");
        assert_eq!(book.nav.len(), 1);
        assert_eq!(book.nav[0].label, "Kapitel 1");
        assert_eq!(book.nav[0].href.as_deref(), Some("OEBPS/ch1.xhtml"));
    }

    #[test]
    fn reads_chapter_lazily() {
        let path = write_epub("lazy.epub", &epub3_entries());
        let mut session = Session::new();
        let book = session.open_book(&path).unwrap();

        let chapter = session
            .read_chapter(&book.id, "ch1", ContentFormat::Xhtml)
            .unwrap();
        assert_eq!(chapter.resource, "ch1");
        assert_eq!(chapter.format, ContentFormat::Xhtml);
        assert_eq!(chapter.content, CH1);

        // prefer: Markdown still returns Xhtml until M0.7/M0.8 (#10).
        let chapter = session
            .read_chapter(&book.id, "ch2", ContentFormat::Markdown)
            .unwrap();
        assert_eq!(chapter.format, ContentFormat::Xhtml);
        assert_eq!(chapter.content, CH2);
    }

    #[test]
    fn read_chapter_rejects_non_xhtml() {
        let path = write_epub("nonxhtml.epub", &epub3_entries());
        let mut session = Session::new();
        let book = session.open_book(&path).unwrap();
        let err = session
            .read_chapter(&book.id, "style", ContentFormat::Xhtml)
            .unwrap_err();
        assert!(matches!(err, CoreError::UnsupportedFeature { .. }));
    }

    #[test]
    fn reads_any_resource() {
        let path = write_epub("resource.epub", &epub3_entries());
        let mut session = Session::new();
        let book = session.open_book(&path).unwrap();
        let bytes = session.read_resource(&book.id, "style").unwrap();
        assert_eq!(bytes, CSS.as_bytes());
    }

    #[test]
    fn unknown_ids_are_not_found() {
        let path = write_epub("unknown.epub", &epub3_entries());
        let mut session = Session::new();
        let book = session.open_book(&path).unwrap();

        let err = session.get_book("book-999").unwrap_err();
        assert!(matches!(err, CoreError::ResourceNotFound { id } if id == "book-999"));

        let err = session
            .read_chapter(&book.id, "nope", ContentFormat::Xhtml)
            .unwrap_err();
        assert!(matches!(err, CoreError::ResourceNotFound { id } if id == "nope"));

        let err = session.read_resource("book-999", "ch1").unwrap_err();
        assert!(matches!(err, CoreError::ResourceNotFound { .. }));
    }

    #[test]
    fn close_book_drops_state() {
        let path = write_epub("close.epub", &epub3_entries());
        let mut session = Session::new();
        let book = session.open_book(&path).unwrap();

        session.close_book(&book.id).unwrap();
        assert!(matches!(
            session.get_book(&book.id),
            Err(CoreError::ResourceNotFound { .. })
        ));
        assert!(matches!(
            session.close_book(&book.id),
            Err(CoreError::ResourceNotFound { .. })
        ));
    }

    #[test]
    fn book_ids_are_unique() {
        let path = write_epub("ids.epub", &epub3_entries());
        let mut session = Session::new();
        let a = session.open_book(&path).unwrap();
        let b = session.open_book(&path).unwrap();
        assert_ne!(a.id, b.id);
    }

    #[test]
    fn dangling_nav_target_is_malformed() {
        let opf = EPUB3_OPF.replace(
            r#"<item id="ch2" href="ch2.xhtml" media-type="application/xhtml+xml"/>"#,
            r#"<item id="ch2" href="ch2.xhtml" media-type="application/xhtml+xml"/><item id="junk" href="junk.xhtml" media-type="application/xhtml+xml"/>"#,
        );
        let nav = NAV_XHTML.replace("ch2.xhtml", "gone.xhtml");
        let entries = vec![
            ("mimetype", "application/epub+zip"),
            ("META-INF/container.xml", CONTAINER_XML),
            ("OEBPS/content.opf", opf.as_str()),
            ("OEBPS/nav.xhtml", nav.as_str()),
            ("OEBPS/ch1.xhtml", CH1),
            ("OEBPS/ch2.xhtml", CH2),
            ("OEBPS/style.css", CSS),
        ];
        let path = write_epub("badnav.epub", &entries);
        let err = Session::new().open_book(&path).unwrap_err();
        assert!(matches!(err, CoreError::MalformedPackage { .. }));
    }

    #[test]
    fn spine_referencing_missing_manifest_item_is_malformed() {
        let opf = EPUB3_OPF.replace(r#"<itemref idref="ch2"/>"#, r#"<itemref idref="ghost"/>"#);
        let entries = vec![
            ("mimetype", "application/epub+zip"),
            ("META-INF/container.xml", CONTAINER_XML),
            ("OEBPS/content.opf", opf.as_str()),
            ("OEBPS/nav.xhtml", NAV_XHTML),
            ("OEBPS/ch1.xhtml", CH1),
            ("OEBPS/ch2.xhtml", CH2),
            ("OEBPS/style.css", CSS),
        ];
        let path = write_epub("badspine.epub", &entries);
        let err = Session::new().open_book(&path).unwrap_err();
        assert!(
            matches!(err, CoreError::MalformedPackage { message } if message.contains("ghost"))
        );
    }

    #[test]
    fn no_nav_and_no_ncx_gives_empty_nav() {
        let opf = r#"<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Bare</dc:title></metadata>
  <manifest><item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/></manifest>
  <spine><itemref idref="ch1"/></spine>
</package>"#;
        let entries = vec![
            ("mimetype", "application/epub+zip"),
            ("META-INF/container.xml", CONTAINER_XML),
            ("OEBPS/content.opf", opf),
            ("OEBPS/ch1.xhtml", CH1),
        ];
        let path = write_epub("nonav.epub", &entries);
        let book = Session::new().open_book(&path).unwrap();
        assert!(book.nav.is_empty());
    }
}
