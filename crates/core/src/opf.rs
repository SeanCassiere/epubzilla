//! Package document (OPF) parsing into the domain model.
//!
//! Handles EPUB 3 and EPUB 2 variants. Manifest hrefs are resolved to
//! normalized zip-internal paths (contract: domain-model.md conventions).
//! `Resource.size` is not knowable from the OPF alone and is filled in by
//! the container layer (M0.5); it is 0 here.

use quick_xml::events::{BytesStart, Event};
use quick_xml::Reader;

use crate::error::{CoreError, CoreResult};
use crate::model::{EpubVersion, Metadata, Resource, ResourceId, SpineItem};

/// Everything the package document declares, in model terms.
#[derive(Debug, Clone)]
pub struct PackageDoc {
    pub version: EpubVersion,
    pub metadata: Metadata,
    pub resources: Vec<Resource>,
    pub spine: Vec<SpineItem>,
    /// EPUB 3 nav document (manifest item with `properties~="nav"`).
    pub nav_resource: Option<ResourceId>,
    /// NCX (spine `toc` idref), used as EPUB 2 / fallback TOC.
    pub ncx_resource: Option<ResourceId>,
}

/// Parse the package document. `package_path` is the OPF's own zip-internal
/// path; manifest hrefs are resolved relative to its directory.
pub fn parse_opf(bytes: &[u8], package_path: &str) -> CoreResult<PackageDoc> {
    Parser::new(package_path).run(bytes)
}

#[derive(PartialEq)]
enum Section {
    None,
    Metadata,
    Manifest,
    Spine,
}

/// Which metadata element we're currently collecting text for.
enum Pending {
    None,
    Title,
    Creator,
    Language,
    Identifier { id: Option<String> },
    Description,
    Publisher,
    Modified,
}

struct Parser {
    package_dir: String,
    section: Section,
    pending: Pending,
    /// Text accumulated for the current `pending` element (entity refs are
    /// separate events, so text arrives fragmented).
    buf: String,
    version: EpubVersion,
    unique_identifier_ref: Option<String>,
    title: Option<String>,
    authors: Vec<String>,
    language: Option<String>,
    /// (id attr, value) pairs, to pick the unique-identifier one.
    identifiers: Vec<(Option<String>, String)>,
    description: Option<String>,
    publisher: Option<String>,
    modified: Option<String>,
    cover_meta_idref: Option<String>,
    cover_property_id: Option<ResourceId>,
    resources: Vec<Resource>,
    spine: Vec<SpineItem>,
    nav_resource: Option<ResourceId>,
    spine_toc_idref: Option<String>,
}

impl Parser {
    fn new(package_path: &str) -> Self {
        let package_dir = match package_path.rfind('/') {
            Some(i) => package_path[..i].to_owned(),
            None => String::new(),
        };
        Self {
            package_dir,
            section: Section::None,
            pending: Pending::None,
            buf: String::new(),
            version: EpubVersion::V3,
            unique_identifier_ref: None,
            title: None,
            authors: Vec::new(),
            language: None,
            identifiers: Vec::new(),
            description: None,
            publisher: None,
            modified: None,
            cover_meta_idref: None,
            cover_property_id: None,
            resources: Vec::new(),
            spine: Vec::new(),
            nav_resource: None,
            spine_toc_idref: None,
        }
    }

    fn run(mut self, bytes: &[u8]) -> CoreResult<PackageDoc> {
        let mut reader = Reader::from_reader(bytes);
        loop {
            match reader.read_event() {
                Ok(Event::Start(e)) => {
                    self.buf.clear();
                    self.on_start(&e, false)?;
                }
                Ok(Event::Empty(e)) => self.on_start(&e, true)?,
                Ok(Event::Text(t)) => {
                    let text = t.xml_content(quick_xml::XmlVersion::Implicit1_0);
                    self.buf.push_str(&text);
                }
                Ok(Event::GeneralRef(r)) => {
                    if let Some(ch) = resolve_entity(&r) {
                        self.buf.push(ch);
                    }
                }
                Ok(Event::End(e)) => self.on_end(e.local_name().as_ref()),
                Ok(Event::Eof) => break,
                Err(e) => {
                    return Err(malformed(format!(
                        "XML error at byte {}: {e}",
                        reader.buffer_position()
                    )))
                }
                _ => {}
            }
        }
        self.finish()
    }

    fn on_start(&mut self, e: &BytesStart, self_closing: bool) -> CoreResult<()> {
        let name = e.local_name();
        match name.as_ref() {
            "package" => {
                if let Some(v) = attr(e, "version") {
                    self.version = if v.starts_with('2') {
                        EpubVersion::V2
                    } else {
                        EpubVersion::V3
                    };
                }
                self.unique_identifier_ref = attr(e, "unique-identifier");
            }
            "metadata" => self.section = Section::Metadata,
            "manifest" => self.section = Section::Manifest,
            "spine" => {
                self.section = Section::Spine;
                self.spine_toc_idref = attr(e, "toc");
            }
            "item" if self.section == Section::Manifest => self.on_manifest_item(e)?,
            "itemref" if self.section == Section::Spine => {
                let idref = attr(e, "idref")
                    .ok_or_else(|| malformed("spine <itemref> without idref".into()))?;
                let linear = attr(e, "linear").as_deref() != Some("no");
                self.spine.push(SpineItem {
                    id: format!("spine-{}", self.spine.len()),
                    resource: idref,
                    linear,
                });
            }
            "meta" if self.section == Section::Metadata => {
                // EPUB 2 cover convention: <meta name="cover" content="item-id"/>
                if attr(e, "name").as_deref() == Some("cover") {
                    self.cover_meta_idref = attr(e, "content");
                }
                if !self_closing && attr(e, "property").as_deref() == Some("dcterms:modified") {
                    self.pending = Pending::Modified;
                }
            }
            _ if self.section == Section::Metadata && !self_closing => {
                self.pending = match name.as_ref() {
                    "title" => Pending::Title,
                    "creator" => Pending::Creator,
                    "language" => Pending::Language,
                    "identifier" => Pending::Identifier { id: attr(e, "id") },
                    "description" => Pending::Description,
                    "publisher" => Pending::Publisher,
                    _ => Pending::None,
                };
            }
            _ => {}
        }
        Ok(())
    }

    fn on_manifest_item(&mut self, e: &BytesStart) -> CoreResult<()> {
        let id = attr(e, "id").ok_or_else(|| malformed("manifest <item> without id".into()))?;
        let href =
            attr(e, "href").ok_or_else(|| malformed("manifest <item> without href".into()))?;
        let media_type = attr(e, "media-type").unwrap_or_default();
        let properties = attr(e, "properties").unwrap_or_default();
        for p in properties.split_whitespace() {
            match p {
                "nav" => self.nav_resource = Some(id.clone()),
                "cover-image" => self.cover_property_id = Some(id.clone()),
                _ => {}
            }
        }
        self.resources.push(Resource {
            id,
            path: resolve_href(&self.package_dir, &href),
            media_type,
            size: 0,
        });
        Ok(())
    }

    fn on_end(&mut self, name: &str) {
        let text = self.buf.trim().to_owned();
        self.buf.clear();
        if !text.is_empty() {
            match std::mem::replace(&mut self.pending, Pending::None) {
                Pending::Title => {
                    self.title.get_or_insert(text);
                }
                Pending::Creator => self.authors.push(text),
                Pending::Language => {
                    self.language.get_or_insert(text);
                }
                Pending::Identifier { id } => self.identifiers.push((id, text)),
                Pending::Description => {
                    self.description.get_or_insert(text);
                }
                Pending::Publisher => {
                    self.publisher.get_or_insert(text);
                }
                Pending::Modified => {
                    self.modified.get_or_insert(text);
                }
                Pending::None => {}
            }
        } else {
            self.pending = Pending::None;
        }
        if matches!(name, "metadata" | "manifest" | "spine") {
            self.section = Section::None;
        }
    }

    fn finish(self) -> CoreResult<PackageDoc> {
        if self.resources.is_empty() {
            return Err(malformed("package has no manifest items".into()));
        }
        if self.spine.is_empty() {
            return Err(malformed("package has an empty spine".into()));
        }

        // Spine idrefs and the NCX toc idref must resolve to manifest items.
        let mut spine = Vec::with_capacity(self.spine.len());
        for item in self.spine {
            if !self.resources.iter().any(|r| r.id == item.resource) {
                return Err(malformed(format!(
                    "spine idref {:?} has no manifest item",
                    item.resource
                )));
            }
            spine.push(item);
        }
        let ncx_resource = self
            .spine_toc_idref
            .filter(|id| self.resources.iter().any(|r| &r.id == id));

        // dc:identifier: prefer the one the package's unique-identifier points at.
        let identifier = self
            .unique_identifier_ref
            .as_ref()
            .and_then(|uid| {
                self.identifiers
                    .iter()
                    .find(|(id, _)| id.as_ref() == Some(uid))
            })
            .or_else(|| self.identifiers.first())
            .map(|(_, value)| value.clone())
            .unwrap_or_default();

        // Cover: EPUB 3 cover-image property wins over the EPUB 2 meta.
        let cover_resource = self.cover_property_id.or_else(|| {
            self.cover_meta_idref
                .filter(|id| self.resources.iter().any(|r| &r.id == id))
        });

        Ok(PackageDoc {
            version: self.version,
            metadata: Metadata {
                title: self.title.unwrap_or_default(),
                authors: self.authors,
                language: self.language.unwrap_or_default(),
                identifier,
                modified: self.modified,
                description: self.description,
                publisher: self.publisher,
                cover_resource,
            },
            resources: self.resources,
            spine,
            nav_resource: self.nav_resource,
            ncx_resource,
        })
    }
}

/// Resolve a character reference or one of the five predefined XML entities.
fn resolve_entity(r: &quick_xml::events::BytesRef) -> Option<char> {
    if let Ok(Some(ch)) = r.resolve_char_ref() {
        return Some(ch);
    }
    match r.xml_content(quick_xml::XmlVersion::Implicit1_0).as_ref() {
        "amp" => Some('&'),
        "lt" => Some('<'),
        "gt" => Some('>'),
        "quot" => Some('"'),
        "apos" => Some('\''),
        _ => None,
    }
}

fn attr(e: &BytesStart, name: &str) -> Option<String> {
    e.attributes().flatten().find_map(|a| {
        (a.key.local_name().as_ref() == name).then(|| {
            a.normalized_value(quick_xml::XmlVersion::Implicit1_0)
                .unwrap_or_default()
                .into_owned()
        })
    })
}

fn malformed(message: String) -> CoreError {
    CoreError::MalformedPackage { message }
}

/// Resolve a manifest href against the package directory into a normalized
/// zip-internal path: percent-decoding, `.`/`..` segments collapsed.
pub(crate) fn resolve_href(base_dir: &str, href: &str) -> String {
    let decoded = percent_decode(href);
    let mut segments: Vec<&str> = if base_dir.is_empty() {
        Vec::new()
    } else {
        base_dir.split('/').collect()
    };
    for seg in decoded.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                segments.pop();
            }
            s => segments.push(s),
        }
    }
    segments.join("/")
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(byte) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(byte);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    const EPUB3_OPF: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="pub-id">urn:uuid:1234</dc:identifier>
    <dc:identifier>isbn:999</dc:identifier>
    <dc:title>Ünïcode “Title” ✓</dc:title>
    <dc:creator>First Author</dc:creator>
    <dc:creator>Second Author</dc:creator>
    <dc:language>en</dc:language>
    <dc:publisher>Test House</dc:publisher>
    <meta property="dcterms:modified">2026-01-01T00:00:00Z</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="ch1" href="text/ch%201.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch2" href="./text/ch2.xhtml" media-type="application/xhtml+xml"/>
    <item id="cover-img" href="../images/cover.jpg" media-type="image/jpeg" properties="cover-image"/>
  </manifest>
  <spine>
    <itemref idref="ch1"/>
    <itemref idref="ch2" linear="no"/>
  </spine>
</package>"#;

    const EPUB2_OPF: &str = r#"<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
    <dc:title>Old Book</dc:title>
    <dc:creator opf:role="aut">Legacy Author</dc:creator>
    <dc:language>de</dc:language>
    <dc:identifier id="bookid">isbn:12345</dc:identifier>
    <meta name="cover" content="cover-img"/>
  </metadata>
  <manifest>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="ch1" href="ch1.html" media-type="application/xhtml+xml"/>
    <item id="cover-img" href="cover.jpg" media-type="image/jpeg"/>
  </manifest>
  <spine toc="ncx">
    <itemref idref="ch1"/>
  </spine>
</package>"#;

    #[test]
    fn parses_epub3() {
        let doc = parse_opf(EPUB3_OPF.as_bytes(), "OEBPS/content.opf").unwrap();
        assert_eq!(doc.version, EpubVersion::V3);
        assert_eq!(doc.metadata.title, "Ünïcode “Title” ✓");
        assert_eq!(doc.metadata.authors, vec!["First Author", "Second Author"]);
        assert_eq!(doc.metadata.language, "en");
        assert_eq!(doc.metadata.identifier, "urn:uuid:1234");
        assert_eq!(
            doc.metadata.modified.as_deref(),
            Some("2026-01-01T00:00:00Z")
        );
        assert_eq!(doc.metadata.publisher.as_deref(), Some("Test House"));
        assert_eq!(doc.metadata.cover_resource.as_deref(), Some("cover-img"));
        assert_eq!(doc.nav_resource.as_deref(), Some("nav"));
        assert_eq!(doc.ncx_resource, None);
        assert_eq!(doc.spine.len(), 2);
        assert!(doc.spine[0].linear);
        assert!(!doc.spine[1].linear);
    }

    #[test]
    fn resolves_hrefs() {
        let doc = parse_opf(EPUB3_OPF.as_bytes(), "OEBPS/content.opf").unwrap();
        let path_of = |id: &str| {
            doc.resources
                .iter()
                .find(|r| r.id == id)
                .unwrap()
                .path
                .clone()
        };
        assert_eq!(path_of("nav"), "OEBPS/nav.xhtml");
        assert_eq!(path_of("ch1"), "OEBPS/text/ch 1.xhtml");
        assert_eq!(path_of("ch2"), "OEBPS/text/ch2.xhtml");
        assert_eq!(path_of("cover-img"), "images/cover.jpg");
    }

    #[test]
    fn parses_epub2() {
        let doc = parse_opf(EPUB2_OPF.as_bytes(), "content.opf").unwrap();
        assert_eq!(doc.version, EpubVersion::V2);
        assert_eq!(doc.metadata.title, "Old Book");
        assert_eq!(doc.metadata.identifier, "isbn:12345");
        assert_eq!(doc.metadata.cover_resource.as_deref(), Some("cover-img"));
        assert_eq!(doc.nav_resource, None);
        assert_eq!(doc.ncx_resource.as_deref(), Some("ncx"));
        assert_eq!(doc.resources[1].path, "ch1.html");
    }

    #[test]
    fn rejects_malformed_xml() {
        let err = parse_opf(b"<package><metadata>", "content.opf").unwrap_err();
        assert!(matches!(err, CoreError::MalformedPackage { .. }));
    }

    #[test]
    fn rejects_empty_spine() {
        let opf = r#"<package version="3.0"><manifest><item id="a" href="a.xhtml" media-type="application/xhtml+xml"/></manifest><spine/></package>"#;
        let err = parse_opf(opf.as_bytes(), "content.opf").unwrap_err();
        assert!(
            matches!(err, CoreError::MalformedPackage { message } if message.contains("spine"))
        );
    }

    #[test]
    fn rejects_dangling_spine_idref() {
        let opf = r#"<package version="3.0"><manifest><item id="a" href="a.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="nope"/></spine></package>"#;
        let err = parse_opf(opf.as_bytes(), "content.opf").unwrap_err();
        assert!(matches!(err, CoreError::MalformedPackage { message } if message.contains("nope")));
    }

    #[test]
    fn missing_optional_metadata_defaults() {
        let opf = r#"<package version="3.0"><metadata/><manifest><item id="a" href="a.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="a"/></spine></package>"#;
        let doc = parse_opf(opf.as_bytes(), "content.opf").unwrap();
        assert_eq!(doc.metadata.title, "");
        assert!(doc.metadata.authors.is_empty());
        assert_eq!(doc.metadata.modified, None);
        assert_eq!(doc.metadata.cover_resource, None);
    }

    #[test]
    fn entity_escapes_are_decoded() {
        let opf = r#"<package version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Tom &amp; Jerry</dc:title></metadata><manifest><item id="a" href="a.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="a"/></spine></package>"#;
        let doc = parse_opf(opf.as_bytes(), "content.opf").unwrap();
        assert_eq!(doc.metadata.title, "Tom & Jerry");
    }
}
