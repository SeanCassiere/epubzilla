//! OCF container reading: the EPUB zip archive, `mimetype` verification, and
//! `META-INF/container.xml` resolution to the package document.
//!
//! Spec: EPUB 3 OCF. Reading is deliberately lenient where real-world books
//! deviate (e.g. `mimetype` not stored first) as long as identity is clear;
//! writing (M0.6) is strict.

use std::fs::File;
use std::io::{Read, Seek};
use std::path::Path;

use quick_xml::events::Event;
use quick_xml::Reader;

use crate::error::{CoreError, CoreResult};

const MIMETYPE_PATH: &str = "mimetype";
const EPUB_MIMETYPE: &str = "application/epub+zip";
const CONTAINER_XML_PATH: &str = "META-INF/container.xml";
const ENCRYPTION_XML_PATH: &str = "META-INF/encryption.xml";
const PACKAGE_MEDIA_TYPE: &str = "application/oebps-package+xml";

/// An open EPUB archive, verified to be an (unencrypted) EPUB and resolved to
/// its package document.
#[derive(Debug)]
pub struct OcfContainer<R: Read + Seek> {
    archive: zip::ZipArchive<R>,
    package_path: String,
}

impl OcfContainer<File> {
    pub fn open_path(path: impl AsRef<Path>) -> CoreResult<Self> {
        let file = File::open(path.as_ref()).map_err(|e| CoreError::Io {
            message: format!("cannot open {}: {e}", path.as_ref().display()),
        })?;
        Self::new(file)
    }
}

impl<R: Read + Seek> OcfContainer<R> {
    pub fn new(reader: R) -> CoreResult<Self> {
        let mut archive = zip::ZipArchive::new(reader).map_err(|e| CoreError::NotAnEpub {
            message: format!("not a zip archive: {e}"),
        })?;

        verify_mimetype(&mut archive)?;

        if archive.index_for_name(ENCRYPTION_XML_PATH).is_some() {
            return Err(CoreError::UnsupportedFeature {
                message: "encrypted EPUBs (META-INF/encryption.xml) are not supported".into(),
            });
        }

        let container_xml = read_archive_entry(&mut archive, CONTAINER_XML_PATH).map_err(|_| {
            CoreError::NotAnEpub {
                message: format!("missing {CONTAINER_XML_PATH}"),
            }
        })?;
        let package_path = parse_container_xml(&container_xml)?;

        if archive.index_for_name(&package_path).is_none() {
            return Err(CoreError::NotAnEpub {
                message: format!("container.xml points at missing entry {package_path}"),
            });
        }

        Ok(Self {
            archive,
            package_path,
        })
    }

    /// Zip-internal path of the package document (OPF).
    pub fn package_path(&self) -> &str {
        &self.package_path
    }

    /// Uncompressed bytes of one entry. `path` is zip-internal and normalized.
    pub fn read_entry(&mut self, path: &str) -> CoreResult<Vec<u8>> {
        read_archive_entry(&mut self.archive, path)
    }

    /// All entry names in the archive.
    pub fn entry_names(&self) -> Vec<String> {
        self.archive.file_names().map(str::to_owned).collect()
    }

    /// Raw-copy (no re-encode) every entry into `writer`, byte-for-byte,
    /// compression and all — except those whose name `skip` returns true
    /// for. Backbone of incremental save (ADR-0002, M0.6).
    pub fn raw_copy_entries<W: std::io::Write + Seek>(
        &mut self,
        writer: &mut zip::ZipWriter<W>,
        skip: impl Fn(&str) -> bool,
    ) -> CoreResult<()> {
        for index in 0..self.archive.len() {
            let entry = self
                .archive
                .by_index_raw(index)
                .map_err(|e| CoreError::Io {
                    message: format!("reading zip entry #{index}: {e}"),
                })?;
            if skip(entry.name()) {
                continue;
            }
            let name = entry.name().to_owned();
            writer.raw_copy_file(entry).map_err(|e| CoreError::Io {
                message: format!("raw-copying zip entry {name}: {e}"),
            })?;
        }
        Ok(())
    }

    /// Uncompressed size of one entry.
    pub fn entry_size(&mut self, path: &str) -> CoreResult<u64> {
        let entry = self
            .archive
            .by_name(path)
            .map_err(|_| CoreError::ResourceNotFound { id: path.into() })?;
        Ok(entry.size())
    }
}

fn verify_mimetype<R: Read + Seek>(archive: &mut zip::ZipArchive<R>) -> CoreResult<()> {
    let bytes = read_archive_entry(archive, MIMETYPE_PATH).map_err(|_| CoreError::NotAnEpub {
        message: "missing mimetype entry".into(),
    })?;
    let content = String::from_utf8_lossy(&bytes);
    if content.trim_end() != EPUB_MIMETYPE {
        return Err(CoreError::NotAnEpub {
            message: format!(
                "mimetype entry is {:?}, expected {EPUB_MIMETYPE:?}",
                content.trim_end()
            ),
        });
    }
    Ok(())
}

fn read_archive_entry<R: Read + Seek>(
    archive: &mut zip::ZipArchive<R>,
    path: &str,
) -> CoreResult<Vec<u8>> {
    let mut entry = archive
        .by_name(path)
        .map_err(|_| CoreError::ResourceNotFound { id: path.into() })?;
    let mut buf = Vec::with_capacity(entry.size() as usize);
    entry.read_to_end(&mut buf).map_err(|e| CoreError::Io {
        message: format!("reading zip entry {path}: {e}"),
    })?;
    Ok(buf)
}

/// Extract the first `<rootfile>` full-path with the OPF media type.
fn parse_container_xml(bytes: &[u8]) -> CoreResult<String> {
    let mut reader = Reader::from_reader(bytes);
    reader.config_mut().trim_text(true);

    let mut fallback: Option<String> = None;
    loop {
        match reader.read_event() {
            Ok(Event::Empty(e)) | Ok(Event::Start(e)) if e.local_name().as_ref() == "rootfile" => {
                let mut full_path = None;
                let mut media_type = None;
                for attr in e.attributes().flatten() {
                    let value = attr
                        .normalized_value(quick_xml::XmlVersion::Implicit1_0)
                        .unwrap_or_default()
                        .into_owned();
                    match attr.key.local_name().as_ref() {
                        "full-path" => full_path = Some(value),
                        "media-type" => media_type = Some(value),
                        _ => {}
                    }
                }
                if let Some(path) = full_path {
                    if media_type.as_deref() == Some(PACKAGE_MEDIA_TYPE) {
                        return Ok(path);
                    }
                    fallback.get_or_insert(path);
                }
            }
            Ok(Event::Eof) => break,
            Err(e) => {
                return Err(CoreError::NotAnEpub {
                    message: format!("malformed container.xml: {e}"),
                })
            }
            _ => {}
        }
    }
    fallback.ok_or_else(|| CoreError::NotAnEpub {
        message: "container.xml has no usable <rootfile>".into(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Cursor, Write};
    use zip::write::SimpleFileOptions;

    const CONTAINER_XML: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>"#;

    fn build_zip(entries: &[(&str, &str)]) -> Cursor<Vec<u8>> {
        let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
        for (name, content) in entries {
            let options = if *name == MIMETYPE_PATH {
                SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored)
            } else {
                SimpleFileOptions::default()
            };
            writer.start_file(*name, options).unwrap();
            writer.write_all(content.as_bytes()).unwrap();
        }
        let mut cursor = writer.finish().unwrap();
        cursor.set_position(0);
        cursor
    }

    fn valid_entries() -> Vec<(&'static str, &'static str)> {
        vec![
            (MIMETYPE_PATH, EPUB_MIMETYPE),
            (CONTAINER_XML_PATH, CONTAINER_XML),
            ("OEBPS/content.opf", "<package/>"),
        ]
    }

    #[test]
    fn opens_valid_container() {
        let mut container = OcfContainer::new(build_zip(&valid_entries())).unwrap();
        assert_eq!(container.package_path(), "OEBPS/content.opf");
        assert_eq!(
            container.read_entry("OEBPS/content.opf").unwrap(),
            b"<package/>"
        );
        assert_eq!(container.entry_size("OEBPS/content.opf").unwrap(), 10);
        assert_eq!(container.entry_names().len(), 3);
    }

    #[test]
    fn tolerates_mimetype_trailing_newline() {
        let mut entries = valid_entries();
        entries[0] = (MIMETYPE_PATH, "application/epub+zip\n");
        assert!(OcfContainer::new(build_zip(&entries)).is_ok());
    }

    #[test]
    fn rejects_non_zip() {
        let err = OcfContainer::new(Cursor::new(b"not a zip".to_vec())).unwrap_err();
        assert!(matches!(err, CoreError::NotAnEpub { .. }));
    }

    #[test]
    fn rejects_missing_mimetype() {
        let entries = valid_entries()[1..].to_vec();
        let err = OcfContainer::new(build_zip(&entries)).unwrap_err();
        assert!(matches!(err, CoreError::NotAnEpub { message } if message.contains("mimetype")));
    }

    #[test]
    fn rejects_wrong_mimetype() {
        let mut entries = valid_entries();
        entries[0] = (MIMETYPE_PATH, "application/zip");
        let err = OcfContainer::new(build_zip(&entries)).unwrap_err();
        assert!(matches!(err, CoreError::NotAnEpub { .. }));
    }

    #[test]
    fn rejects_missing_container_xml() {
        let entries = vec![valid_entries()[0], valid_entries()[2]];
        let err = OcfContainer::new(build_zip(&entries)).unwrap_err();
        assert!(
            matches!(err, CoreError::NotAnEpub { message } if message.contains("container.xml"))
        );
    }

    #[test]
    fn rejects_container_without_rootfile() {
        let mut entries = valid_entries();
        entries[1] = (CONTAINER_XML_PATH, "<container><rootfiles/></container>");
        let err = OcfContainer::new(build_zip(&entries)).unwrap_err();
        assert!(matches!(err, CoreError::NotAnEpub { .. }));
    }

    #[test]
    fn rejects_dangling_package_path() {
        let entries = vec![valid_entries()[0], valid_entries()[1]];
        let err = OcfContainer::new(build_zip(&entries)).unwrap_err();
        assert!(matches!(err, CoreError::NotAnEpub { message } if message.contains("content.opf")));
    }

    #[test]
    fn rejects_encrypted() {
        let mut entries = valid_entries();
        entries.push((ENCRYPTION_XML_PATH, "<encryption/>"));
        let err = OcfContainer::new(build_zip(&entries)).unwrap_err();
        assert!(matches!(err, CoreError::UnsupportedFeature { .. }));
    }

    #[test]
    fn falls_back_to_rootfile_without_media_type() {
        let mut entries = valid_entries();
        entries[1] = (
            CONTAINER_XML_PATH,
            r#"<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>"#,
        );
        let container = OcfContainer::new(build_zip(&entries)).unwrap();
        assert_eq!(container.package_path(), "OEBPS/content.opf");
    }

    #[test]
    fn missing_entry_is_resource_not_found() {
        let mut container = OcfContainer::new(build_zip(&valid_entries())).unwrap();
        let err = container.read_entry("nope.xhtml").unwrap_err();
        assert!(matches!(err, CoreError::ResourceNotFound { .. }));
    }
}
