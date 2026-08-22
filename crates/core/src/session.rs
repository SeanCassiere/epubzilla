//! Book model assembly and the in-memory session of open books.
//!
//! `open_book` wires the container (M0.2), OPF (M0.3), and nav (M0.4) layers
//! into the `Book` index eagerly; chapter bodies stay in the zip and are
//! decompressed on demand via `read_chapter` / `read_resource` (ADR-0002,
//! domain-model.md invariant 3).

use std::collections::HashMap;
use std::fs::File;
use std::io::Write;
use std::path::{Path, PathBuf};

use zip::write::SimpleFileOptions;
use zip::CompressionMethod;

use crate::container::OcfContainer;
use crate::error::{CoreError, CoreResult};
use crate::model::{
    Book, BookId, ChapterContent, ContentFormat, EpubVersion, Metadata, NavPoint, Resource,
    ResourceId, SpineItem,
};
use crate::{nav, opf, writer};

const XHTML_MEDIA_TYPE: &str = "application/xhtml+xml";
const MIMETYPE_PATH: &str = "mimetype";
const EPUB_MIMETYPE: &str = "application/epub+zip";
const CONTAINER_XML_PATH: &str = "META-INF/container.xml";
const DEFAULT_PACKAGE_PATH: &str = "OEBPS/content.opf";

/// One open book: the lightweight model, its backing container (if it has
/// one), and an in-memory overlay of zip entries. The overlay takes
/// precedence over the container on reads; books from `create_book` live
/// entirely in the overlay (`container: None`).
struct OpenBook {
    book: Book,
    container: Option<OcfContainer<File>>,
    /// Zip-internal path → bytes; overrides the container.
    overlay: HashMap<String, Vec<u8>>,
    /// Zip-internal path of the package document (OPF).
    package_path: String,
    /// Manifest item carrying `properties="nav"`, if any.
    nav_resource: Option<ResourceId>,
    /// NCX manifest item (spine `toc` idref), if any.
    ncx_resource: Option<ResourceId>,
}

impl OpenBook {
    /// Uncompressed bytes of one entry: overlay first, then the container.
    fn read_entry(&mut self, path: &str) -> CoreResult<Vec<u8>> {
        if let Some(bytes) = self.overlay.get(path) {
            return Ok(bytes.clone());
        }
        match &mut self.container {
            Some(container) => container.read_entry(path),
            None => Err(CoreError::ResourceNotFound { id: path.into() }),
        }
    }
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
                container: Some(container),
                overlay: HashMap::new(),
                package_path,
                nav_resource: package.nav_resource,
                ncx_resource: package.ncx_resource,
            },
        );
        Ok(book)
    }

    /// Create a new in-memory EPUB 3 book with no backing file: a generated
    /// title page, a nav document listing it, and a consistent spine
    /// (core-api.md). Everything lives in the overlay until `save_book`.
    pub fn create_book(&mut self, metadata: Metadata) -> Book {
        let mut metadata = metadata;
        if metadata.identifier.is_empty() {
            metadata.identifier = writer::generate_identifier();
        }
        if metadata.language.is_empty() {
            metadata.language = "en".to_owned();
        }

        let title_page_path = "OEBPS/titlepage.xhtml".to_owned();
        let nav_path = "OEBPS/nav.xhtml".to_owned();
        let title_page = writer::write_title_page_xhtml(&metadata);
        let nav_label = if metadata.title.is_empty() {
            "Title Page".to_owned()
        } else {
            metadata.title.clone()
        };
        let nav_doc = writer::write_nav_xhtml(
            &metadata,
            &[("titlepage.xhtml".to_owned(), nav_label.clone())],
        );

        let mut overlay = HashMap::new();
        overlay.insert(
            CONTAINER_XML_PATH.to_owned(),
            writer::write_container_xml(DEFAULT_PACKAGE_PATH).into_bytes(),
        );
        overlay.insert(title_page_path.clone(), title_page.into_bytes());
        overlay.insert(nav_path.clone(), nav_doc.into_bytes());

        let resources = vec![
            Resource {
                id: "titlepage".to_owned(),
                path: title_page_path.clone(),
                media_type: XHTML_MEDIA_TYPE.to_owned(),
                size: overlay[&title_page_path].len() as u64,
            },
            Resource {
                id: "nav".to_owned(),
                path: nav_path.clone(),
                media_type: XHTML_MEDIA_TYPE.to_owned(),
                size: overlay[&nav_path].len() as u64,
            },
        ];

        self.next_id += 1;
        let id: BookId = format!("book-{}", self.next_id);
        let book = Book {
            id: id.clone(),
            metadata,
            spine: vec![SpineItem {
                id: "spine-0".to_owned(),
                resource: "titlepage".to_owned(),
                linear: true,
            }],
            nav: vec![NavPoint {
                label: nav_label,
                href: Some(title_page_path),
                children: Vec::new(),
            }],
            resources,
            source: None,
            epub_version: EpubVersion::V3,
            dirty: true,
        };
        self.books.insert(
            id,
            OpenBook {
                book: book.clone(),
                container: None,
                overlay,
                package_path: DEFAULT_PACKAGE_PATH.to_owned(),
                nav_resource: Some("nav".to_owned()),
                ncx_resource: None,
            },
        );
        book
    }

    /// Atomic incremental save (ADR-0002): serialize to a temp file next to
    /// the target, then rename over it. `mimetype` is written first and
    /// stored; the OPF is regenerated from the model with a refreshed
    /// `dcterms:modified`; overlay entries are written from memory; every
    /// other entry is raw-copied from the source container without
    /// re-encoding. `path` is required when the book has no source (save-as).
    pub fn save_book(&mut self, book_id: &str, path: Option<String>) -> CoreResult<Book> {
        let open = self.open_mut(book_id)?;
        let target: PathBuf = match path.or_else(|| open.book.source.clone()) {
            Some(p) => PathBuf::from(p),
            None => {
                return Err(CoreError::Io {
                    message: "save_book: book has no source file; a path is required (save-as)"
                        .into(),
                })
            }
        };

        let modified = writer::now_iso8601();
        let opf_bytes = writer::write_opf(
            &open.book,
            open.nav_resource.as_deref(),
            open.ncx_resource.as_deref(),
            &open.package_path,
            &modified,
        )
        .into_bytes();

        let dir = match target.parent() {
            Some(d) if !d.as_os_str().is_empty() => d.to_path_buf(),
            _ => PathBuf::from("."),
        };
        let file_name =
            target
                .file_name()
                .and_then(|n| n.to_str())
                .ok_or_else(|| CoreError::Io {
                    message: format!("save_book: invalid target path {}", target.display()),
                })?;
        let temp_path = dir.join(format!(".{file_name}.tmp-{}", std::process::id()));

        let result = write_epub_zip(open, &temp_path, &opf_bytes);
        if let Err(err) = result {
            let _ = std::fs::remove_file(&temp_path);
            return Err(err);
        }
        if let Err(e) = std::fs::rename(&temp_path, &target) {
            let _ = std::fs::remove_file(&temp_path);
            return Err(CoreError::Io {
                message: format!("cannot move saved file into {}: {e}", target.display()),
            });
        }

        open.book.source = Some(target.to_string_lossy().into_owned());
        open.book.dirty = false;
        open.book.metadata.modified = Some(modified);
        // Re-point the container at the saved file so later saves stay
        // incremental (and save-as leaves the old file alone).
        open.container = Some(OcfContainer::open_path(&target)?);
        Ok(open.book.clone())
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
        let bytes = open.read_entry(&path)?;
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
        open.read_entry(&path)
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

/// Assemble the EPUB zip at `temp_path`: stored mimetype first, regenerated
/// OPF, overlay entries from memory, everything else raw-copied.
fn write_epub_zip(open: &mut OpenBook, temp_path: &Path, opf_bytes: &[u8]) -> CoreResult<()> {
    let io_err = |what: &str, e: &dyn std::fmt::Display| CoreError::Io {
        message: format!("save_book: {what}: {e}"),
    };

    let file = File::create(temp_path).map_err(|e| CoreError::Io {
        message: format!("cannot create temp file {}: {e}", temp_path.display()),
    })?;
    let mut zip = zip::ZipWriter::new(file);
    let deflated = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);

    // OCF 4.2: mimetype first, uncompressed.
    zip.start_file(
        MIMETYPE_PATH,
        SimpleFileOptions::default().compression_method(CompressionMethod::Stored),
    )
    .map_err(|e| io_err("writing mimetype", &e))?;
    zip.write_all(EPUB_MIMETYPE.as_bytes())
        .map_err(|e| io_err("writing mimetype", &e))?;

    zip.start_file(open.package_path.as_str(), deflated)
        .map_err(|e| io_err("writing package document", &e))?;
    zip.write_all(opf_bytes)
        .map_err(|e| io_err("writing package document", &e))?;

    let mut overlay_paths: Vec<&String> = open
        .overlay
        .keys()
        .filter(|p| p.as_str() != MIMETYPE_PATH && **p != open.package_path)
        .collect();
    overlay_paths.sort();
    for path in overlay_paths {
        zip.start_file(path.as_str(), deflated)
            .map_err(|e| io_err(&format!("writing {path}"), &e))?;
        zip.write_all(&open.overlay[path])
            .map_err(|e| io_err(&format!("writing {path}"), &e))?;
    }

    if let Some(container) = &mut open.container {
        let overlay = &open.overlay;
        let package_path = open.package_path.as_str();
        container.raw_copy_entries(&mut zip, |name| {
            name == MIMETYPE_PATH || name == package_path || overlay.contains_key(name)
        })?;
    }

    zip.finish().map_err(|e| io_err("finalizing archive", &e))?;
    Ok(())
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

    fn sample_metadata() -> Metadata {
        Metadata {
            title: "Nëw “Bøok” ✓".into(),
            authors: vec!["Ærin Author".into(), "Zoë Writer".into()],
            language: "en".into(),
            identifier: String::new(),
            modified: None,
            description: Some("A tëst description".into()),
            publisher: None,
            cover_resource: None,
        }
    }

    fn temp_path(name: &str) -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("epubzilla-session-tests-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join(name)
    }

    #[test]
    fn create_book_has_consistent_model() {
        let mut session = Session::new();
        let book = session.create_book(sample_metadata());

        assert_eq!(book.source, None);
        assert!(book.dirty);
        assert_eq!(book.epub_version, crate::EpubVersion::V3);
        assert!(book.metadata.identifier.starts_with("urn:uuid:"));

        // Spine → title page, nav lists it, all consistent.
        assert_eq!(book.spine.len(), 1);
        assert_eq!(book.spine[0].resource, "titlepage");
        let titlepage = book.resources.iter().find(|r| r.id == "titlepage").unwrap();
        assert_eq!(titlepage.media_type, XHTML_MEDIA_TYPE);
        assert!(titlepage.size > 0);
        assert!(book.resources.iter().any(|r| r.id == "nav"));
        assert_eq!(book.nav.len(), 1);
        assert_eq!(book.nav[0].href.as_deref(), Some(titlepage.path.as_str()));
        assert_eq!(book.nav[0].label, "Nëw “Bøok” ✓");

        // In-memory chapters are readable through the overlay.
        let mut session2 = session;
        let chapter = session2
            .read_chapter(&book.id, "titlepage", ContentFormat::Xhtml)
            .unwrap();
        assert!(chapter.content.contains("Nëw “Bøok” ✓"));
        assert!(chapter.content.contains("Ærin Author"));
        assert!(chapter.content.contains("Zoë Writer"));
        let nav_doc = String::from_utf8(session2.read_resource(&book.id, "nav").unwrap()).unwrap();
        assert!(nav_doc.contains(r#"epub:type="toc""#));
        assert!(nav_doc.contains(r#"href="titlepage.xhtml""#));
    }

    #[test]
    fn save_as_writes_valid_zip_with_stored_mimetype_first() {
        let mut session = Session::new();
        let book = session.create_book(sample_metadata());
        let path = temp_path("created.epub");
        let saved = session
            .save_book(&book.id, Some(path.to_string_lossy().into_owned()))
            .unwrap();

        assert_eq!(saved.source.as_deref(), Some(path.to_str().unwrap()));
        assert!(!saved.dirty);
        let modified = saved.metadata.modified.as_deref().unwrap();
        assert!(modified.ends_with('Z') && modified.len() == 20);

        // First entry: "mimetype", stored, exact content.
        let file = std::fs::File::open(&path).unwrap();
        let mut archive = zip::ZipArchive::new(file).unwrap();
        {
            let mut first = archive.by_index(0).unwrap();
            assert_eq!(first.name(), "mimetype");
            assert_eq!(first.compression(), zip::CompressionMethod::Stored);
            let mut content = String::new();
            std::io::Read::read_to_string(&mut first, &mut content).unwrap();
            assert_eq!(content, "application/epub+zip");
        }
        // No temp file left behind.
        let leftovers: Vec<_> = std::fs::read_dir(path.parent().unwrap())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().contains(".tmp-"))
            .collect();
        assert!(leftovers.is_empty());
    }

    #[test]
    fn saved_created_book_reopens_cleanly() {
        let mut session = Session::new();
        let created = session.create_book(sample_metadata());
        let path = temp_path("roundtrip.epub");
        let saved = session
            .save_book(&created.id, Some(path.to_string_lossy().into_owned()))
            .unwrap();

        let reopened = session.open_book(&path).unwrap();
        assert_eq!(reopened.metadata.title, created.metadata.title);
        assert_eq!(reopened.metadata.authors, created.metadata.authors);
        assert_eq!(reopened.metadata.language, "en");
        assert_eq!(reopened.metadata.identifier, saved.metadata.identifier);
        assert_eq!(reopened.metadata.modified, saved.metadata.modified);
        assert_eq!(reopened.epub_version, crate::EpubVersion::V3);
        assert_eq!(reopened.spine.len(), 1);
        assert_eq!(reopened.spine[0].resource, "titlepage");
        assert_eq!(reopened.nav.len(), 1);
        assert_eq!(reopened.nav[0].label, created.nav[0].label);
        assert_eq!(reopened.nav[0].href, created.nav[0].href);
        assert_eq!(reopened.resources.len(), created.resources.len());

        let chapter = session
            .read_chapter(&reopened.id, "titlepage", ContentFormat::Xhtml)
            .unwrap();
        assert!(chapter.content.contains("Nëw “Bøok” ✓"));
    }

    #[test]
    fn incremental_save_raw_copies_untouched_entries() {
        let source = write_epub("incremental-src.epub", &epub3_entries());
        let mut session = Session::new();
        let book = session.open_book(&source).unwrap();
        let target = temp_path("incremental-dst.epub");
        session
            .save_book(&book.id, Some(target.to_string_lossy().into_owned()))
            .unwrap();

        // Untouched entries are byte-for-byte identical at the raw
        // (compressed) level: same method, CRC, and stream bytes.
        let raw = |path: &std::path::Path, name: &str| {
            let mut archive = zip::ZipArchive::new(std::fs::File::open(path).unwrap()).unwrap();
            let index = archive.index_for_name(name).unwrap();
            let mut entry = archive.by_index_raw(index).unwrap();
            let mut bytes = Vec::new();
            std::io::Read::read_to_end(&mut entry, &mut bytes).unwrap();
            (entry.compression(), entry.crc32(), bytes)
        };
        for name in [
            "OEBPS/ch1.xhtml",
            "OEBPS/ch2.xhtml",
            "OEBPS/nav.xhtml",
            "OEBPS/style.css",
            "META-INF/container.xml",
        ] {
            assert_eq!(raw(&source, name), raw(&target, name), "entry {name}");
        }

        // The saved book reopens with the same model.
        let reopened = session.open_book(&target).unwrap();
        assert_eq!(reopened.metadata.title, book.metadata.title);
        assert_eq!(reopened.spine.len(), book.spine.len());
        assert_eq!(reopened.nav.len(), book.nav.len());
        // dcterms:modified was refreshed in the regenerated OPF.
        assert!(reopened.metadata.modified.is_some());
    }

    #[test]
    fn save_without_source_and_without_path_is_an_error() {
        let mut session = Session::new();
        let book = session.create_book(sample_metadata());
        let err = session.save_book(&book.id, None).unwrap_err();
        assert!(matches!(err, CoreError::Io { message } if message.contains("path is required")));
        // Book state untouched by the failed save.
        let book = session.get_book(&book.id).unwrap();
        assert!(book.dirty);
        assert_eq!(book.source, None);
    }

    #[test]
    fn failed_save_leaves_no_partial_file() {
        let mut session = Session::new();
        let book = session.create_book(sample_metadata());
        let missing_dir = temp_path("no-such-dir");
        let target = missing_dir.join("out.epub");
        let err = session
            .save_book(&book.id, Some(target.to_string_lossy().into_owned()))
            .unwrap_err();
        assert!(matches!(err, CoreError::Io { .. }));
        assert!(!target.exists());
        assert!(!missing_dir.exists());
        // Still unsaved and dirty.
        let book = session.get_book(&book.id).unwrap();
        assert!(book.dirty);
        assert_eq!(book.source, None);
    }

    #[test]
    fn save_without_path_reuses_source() {
        let source = write_epub("resave-src.epub", &epub3_entries());
        // Copy so we don't clobber the shared fixture used by other tests.
        let target = temp_path("resave-copy.epub");
        std::fs::copy(&source, &target).unwrap();
        let mut session = Session::new();
        let book = session.open_book(&target).unwrap();
        let saved = session.save_book(&book.id, None).unwrap();
        assert_eq!(saved.source.as_deref(), Some(target.to_str().unwrap()));
        assert!(!saved.dirty);
        // Target still opens cleanly after in-place save.
        session.open_book(&target).unwrap();
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
