//! Reference extraction for the orphan sweep (`save_book`): which
//! zip-internal paths a content document (XHTML) or stylesheet (CSS) points
//! at. Extraction is lenient and best-effort — a parse error ends collection
//! with whatever was found so far. Matching is deliberately broad (any
//! `src`/`href`-shaped attribute on any element counts as a reference):
//! over-collection merely keeps a resource, while under-collection could
//! sweep something a reader still needs.

use std::collections::HashSet;

use quick_xml::events::{BytesStart, Event};
use quick_xml::Reader;

use crate::opf::resolve_href;

/// Zip-internal paths referenced from one XHTML document at `doc_path`.
///
/// Collected attributes: `src`, `href`, `data`, `poster`, and any
/// prefix-qualified `*:href` (SVG `xlink:href`), on every element — this
/// covers `img`, `image`, `link`, `source`, `audio`, `video`, `object`,
/// `embed`, and `a`. Over-collection is harmless: the sweep only uses these
/// to *keep* resources.
pub(crate) fn xhtml_refs(bytes: &[u8], doc_path: &str) -> HashSet<String> {
    let base_dir = parent_dir(doc_path);
    let mut out = HashSet::new();
    let mut reader = Reader::from_reader(bytes);
    reader.config_mut().check_end_names = false;
    loop {
        match reader.read_event() {
            Ok(Event::Start(e)) | Ok(Event::Empty(e)) => {
                collect_element_refs(&e, base_dir, &mut out)
            }
            Ok(Event::Eof) | Err(_) => break,
            Ok(_) => {}
        }
    }
    out
}

fn collect_element_refs(element: &BytesStart, base_dir: &str, out: &mut HashSet<String>) {
    for attr in element.attributes().with_checks(false).flatten() {
        let name = attr.key.as_ref();
        let is_ref_attr = matches!(name, "src" | "href" | "data" | "poster")
            || name.ends_with(":href")
            || name.ends_with(":src");
        if !is_ref_attr {
            continue;
        }
        if let Ok(value) = attr.normalized_value(quick_xml::XmlVersion::Implicit1_0) {
            if let Some(path) = resolve_ref(base_dir, &value) {
                out.insert(path);
            }
        }
    }
}

/// Zip-internal paths referenced from one CSS stylesheet at `css_path` via
/// `url(...)` tokens (covers `@font-face src`, backgrounds, and `@import
/// url(...)`; quoted and unquoted forms).
pub(crate) fn css_refs(css: &str, css_path: &str) -> HashSet<String> {
    let base_dir = parent_dir(css_path);
    let mut out = HashSet::new();
    let mut rest = css;
    while let Some(i) = find_url_open(rest) {
        rest = &rest[i + 4..];
        let Some(end) = rest.find(')') else { break };
        let raw = rest[..end]
            .trim()
            .trim_matches(|c| c == '"' || c == '\'')
            .trim();
        if let Some(path) = resolve_ref(base_dir, raw) {
            out.insert(path);
        }
        rest = &rest[end + 1..];
    }
    out
}

/// Byte offset of the next case-insensitive `url(` token, if any.
fn find_url_open(s: &str) -> Option<usize> {
    s.as_bytes()
        .windows(4)
        .position(|w| w.eq_ignore_ascii_case(b"url("))
}

/// Resolve one raw reference value against `base_dir` (the referencing
/// document's zip directory) into a zip-internal path. External URLs
/// (anything with a scheme, e.g. `https:`, `data:`, `mailto:`), pure
/// fragments, and empty values yield `None`.
fn resolve_ref(base_dir: &str, value: &str) -> Option<String> {
    let value = value.trim();
    let path_part = value
        .split(['#', '?'])
        .next()
        .expect("split yields at least one part");
    if path_part.is_empty() {
        return None;
    }
    // A `:` before any `/` marks a scheme (https:, data:, mailto:, …).
    let colon = path_part.find(':');
    let slash = path_part.find('/');
    if matches!((colon, slash), (Some(c), Some(s)) if c < s) || (colon.is_some() && slash.is_none())
    {
        return None;
    }
    if let Some(absolute) = path_part.strip_prefix('/') {
        return Some(resolve_href("", absolute));
    }
    Some(resolve_href(base_dir, path_part))
}

fn parent_dir(path: &str) -> &str {
    match path.rfind('/') {
        Some(i) => &path[..i],
        None => "",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn set(items: &[&str]) -> HashSet<String> {
        items.iter().map(|s| (*s).to_owned()).collect()
    }

    #[test]
    fn xhtml_refs_collects_and_resolves_media_attributes() {
        let doc = br##"<?xml version="1.0"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:xlink="http://www.w3.org/1999/xlink">
<head>
  <link rel="stylesheet" href="../styles/main.css"/>
</head>
<body>
  <p><img src="images/p%C3%AFc.png" alt="x"/></p>
  <svg xmlns="http://www.w3.org/2000/svg"><image xlink:href="images/vector.svg"/></svg>
  <video poster="images/poster.jpg"><source src="media/clip.mp4"/></video>
  <object data="media/widget.swf"></object>
  <a href="ch2.xhtml#frag">next</a>
  <a href="https://example.com/x.png">external</a>
  <a href="mailto:someone@example.com">mail</a>
  <a href="#local">fragment only</a>
  <img src="data:image/png;base64,AAAA" alt="inline"/>
</body>
</html>"##;
        let refs = xhtml_refs(doc, "OEBPS/text/ch1.xhtml");
        assert_eq!(
            refs,
            set(&[
                "OEBPS/styles/main.css",
                "OEBPS/text/images/pïc.png",
                "OEBPS/text/images/vector.svg",
                "OEBPS/text/images/poster.jpg",
                "OEBPS/text/media/clip.mp4",
                "OEBPS/text/media/widget.swf",
                "OEBPS/text/ch2.xhtml",
            ])
        );
    }

    #[test]
    fn xhtml_refs_is_best_effort_on_malformed_markup() {
        let doc = br#"<html><body><img src="a.png"/><p>unclosed"#;
        let refs = xhtml_refs(doc, "OEBPS/ch1.xhtml");
        assert_eq!(refs, set(&["OEBPS/a.png"]));
    }

    #[test]
    fn css_refs_handles_quotes_case_and_relative_paths() {
        let css = r#"
@font-face { font-family: F; src: URL("../fonts/Nïce Font.otf") format("opentype"); }
body { background: url(images/bg.png); }
.h { background-image: url( 'tile.gif' ); }
.x { content: url(data:image/png;base64,AAAA); }
@import url(more.css);
"#;
        let refs = css_refs(css, "OEBPS/styles/main.css");
        assert_eq!(
            refs,
            set(&[
                "OEBPS/fonts/Nïce Font.otf",
                "OEBPS/styles/images/bg.png",
                "OEBPS/styles/tile.gif",
                "OEBPS/styles/more.css",
            ])
        );
    }

    #[test]
    fn refs_from_root_and_dotdot_resolve() {
        let doc = br#"<html><body><img src="/images/root.png"/><img src="../images/up.png"/></body></html>"#;
        let refs = xhtml_refs(doc, "OEBPS/text/ch.xhtml");
        assert_eq!(refs, set(&["images/root.png", "OEBPS/images/up.png"]));
    }
}
