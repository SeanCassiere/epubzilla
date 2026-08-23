//! Navigation parsing: EPUB 3 `nav.xhtml` (epub:type="toc") with fallback to
//! the EPUB 2 NCX (`toc.ncx`). Both produce the `NavPoint` tree from the
//! domain model, with hrefs resolved to zip-internal resource paths
//! (fragment preserved).

use quick_xml::events::{BytesStart, Event};
use quick_xml::Reader;

use crate::error::{CoreError, CoreResult};
use crate::model::{NavPoint, Resource};
use crate::opf::resolve_href;

/// Parse the toc `<nav>` of an EPUB 3 navigation document.
/// `nav_path` is the nav document's own zip-internal path.
pub fn parse_nav_xhtml(bytes: &[u8], nav_path: &str) -> CoreResult<Vec<NavPoint>> {
    let base_dir = parent_dir(nav_path);
    let mut reader = Reader::from_reader(bytes);
    reader.config_mut().check_end_names = false;

    // Tree assembly: `lists` is a stack of <ol> levels, `open` the chain of
    // unclosed <li> items. A closing </ol> becomes the children of the
    // innermost open <li>, or the final result at the top level.
    let mut in_toc = false;
    let mut nav_depth = 0u32;
    let mut lists: Vec<Vec<NavPoint>> = Vec::new();
    let mut open: Vec<NavPoint> = Vec::new();
    let mut collecting_label = false;
    let mut result: Option<Vec<NavPoint>> = None;

    loop {
        match reader.read_event() {
            Ok(Event::Start(e)) => match e.local_name().as_ref() {
                "nav" => {
                    nav_depth += 1;
                    if !in_toc && result.is_none() && is_toc_nav(&e) {
                        in_toc = true;
                    }
                }
                "ol" if in_toc => lists.push(Vec::new()),
                "li" if in_toc => open.push(NavPoint {
                    label: String::new(),
                    href: None,
                    children: Vec::new(),
                }),
                "a" if in_toc && !open.is_empty() => {
                    if let Some(href) = attr(&e, "href") {
                        if let Some(item) = open.last_mut() {
                            item.href = Some(resolve_href_with_fragment(&base_dir, &href));
                        }
                    }
                    collecting_label = true;
                }
                "span" if in_toc && !open.is_empty() => collecting_label = true,
                _ => {}
            },
            Ok(Event::Text(t)) if collecting_label => {
                if let Some(item) = open.last_mut() {
                    item.label
                        .push_str(&t.xml_content(quick_xml::XmlVersion::Implicit1_0));
                }
            }
            Ok(Event::GeneralRef(r)) if collecting_label => {
                if let (Some(item), Some(ch)) = (open.last_mut(), resolve_entity(&r)) {
                    item.label.push(ch);
                }
            }
            Ok(Event::End(e)) => match e.local_name().as_ref() {
                "nav" => {
                    nav_depth = nav_depth.saturating_sub(1);
                    in_toc = false;
                }
                "ol" if in_toc => {
                    let done = lists.pop().unwrap_or_default();
                    match open.last_mut() {
                        Some(item) => item.children = done,
                        None => result = Some(done),
                    }
                    if result.is_some() {
                        in_toc = false;
                    }
                }
                "li" if in_toc => {
                    if let Some(mut item) = open.pop() {
                        item.label = item.label.trim().to_owned();
                        if let Some(list) = lists.last_mut() {
                            list.push(item);
                        }
                    }
                }
                "a" | "span" => collecting_label = false,
                _ => {}
            },
            Ok(Event::Eof) => break,
            Err(e) => {
                return Err(CoreError::MalformedPackage {
                    message: format!(
                        "nav document XML error at byte {}: {e}",
                        reader.buffer_position()
                    ),
                })
            }
            _ => {}
        }
    }
    let _ = nav_depth;
    result.ok_or_else(|| CoreError::MalformedPackage {
        message: "navigation document has no toc <nav> with an <ol>".into(),
    })
}

/// Parse an EPUB 2 NCX document's `<navMap>`.
/// `ncx_path` is the NCX's own zip-internal path.
pub fn parse_ncx(bytes: &[u8], ncx_path: &str) -> CoreResult<Vec<NavPoint>> {
    let base_dir = parent_dir(ncx_path);
    let mut reader = Reader::from_reader(bytes);
    reader.config_mut().check_end_names = false;

    let mut in_nav_map = false;
    let mut open: Vec<NavPoint> = Vec::new();
    let mut root: Vec<NavPoint> = Vec::new();
    let mut collecting_label = false;
    let mut saw_nav_map = false;

    loop {
        match reader.read_event() {
            Ok(Event::Start(e)) => match e.local_name().as_ref() {
                "navMap" => {
                    in_nav_map = true;
                    saw_nav_map = true;
                }
                "navPoint" if in_nav_map => open.push(NavPoint {
                    label: String::new(),
                    href: None,
                    children: Vec::new(),
                }),
                "text" if in_nav_map && !open.is_empty() => collecting_label = true,
                _ => {}
            },
            Ok(Event::Empty(e)) if in_nav_map && e.local_name().as_ref() == "content" => {
                if let (Some(item), Some(src)) = (open.last_mut(), attr(&e, "src")) {
                    item.href = Some(resolve_href_with_fragment(&base_dir, &src));
                }
            }
            Ok(Event::Text(t)) if collecting_label => {
                if let Some(item) = open.last_mut() {
                    item.label
                        .push_str(&t.xml_content(quick_xml::XmlVersion::Implicit1_0));
                }
            }
            Ok(Event::GeneralRef(r)) if collecting_label => {
                if let (Some(item), Some(ch)) = (open.last_mut(), resolve_entity(&r)) {
                    item.label.push(ch);
                }
            }
            Ok(Event::End(e)) => match e.local_name().as_ref() {
                "navMap" => in_nav_map = false,
                "navPoint" if in_nav_map => {
                    if let Some(mut item) = open.pop() {
                        item.label = item.label.trim().to_owned();
                        match open.last_mut() {
                            Some(parent) => parent.children.push(item),
                            None => root.push(item),
                        }
                    }
                }
                "text" => collecting_label = false,
                _ => {}
            },
            Ok(Event::Eof) => break,
            Err(e) => {
                return Err(CoreError::MalformedPackage {
                    message: format!("NCX XML error at byte {}: {e}", reader.buffer_position()),
                })
            }
            _ => {}
        }
    }
    if !saw_nav_map {
        return Err(CoreError::MalformedPackage {
            message: "NCX has no <navMap>".into(),
        });
    }
    Ok(root)
}

/// A non-toc `<nav>` (landmarks, page-list, lot, loi, …) from the source
/// navigation document, carried through nav rebuilds so structural mutations
/// never silently strip author-provided navigation (#71).
#[derive(Debug, Clone)]
pub struct AuxNav {
    /// The nav's `epub:type` value, verbatim (e.g. "landmarks", "page-list").
    pub epub_type: String,
    /// Heading text (first `h1`–`h6` inside the nav), if any.
    pub heading: Option<String>,
    pub entries: Vec<AuxNavEntry>,
}

/// One `<li>` of a preserved nav.
#[derive(Debug, Clone)]
pub struct AuxNavEntry {
    pub label: String,
    /// `epub:type` on the entry's anchor (landmarks entries carry one).
    pub entry_type: Option<String>,
    pub target: Option<AuxTarget>,
    pub children: Vec<AuxNavEntry>,
}

/// Where a preserved nav entry points.
#[derive(Debug, Clone)]
pub enum AuxTarget {
    /// A manifest resource, tracked by id so the emitted href follows the
    /// resource if its path changes, plus an optional fragment.
    Resource {
        id: String,
        fragment: Option<String>,
    },
    /// A verbatim href: an external URL, or a reference that does not
    /// resolve to any manifest resource. Emitted unchanged.
    Href(String),
}

/// Parse every preservable non-toc `<nav>` of an EPUB 3 navigation document
/// (landmarks, page-list, and any other nav carrying an `epub:type` that is
/// not `toc`). `nav_path` is the nav document's own zip-internal path;
/// `resources` is the manifest, used to bind internal hrefs to resource ids.
pub fn parse_aux_navs(
    bytes: &[u8],
    nav_path: &str,
    resources: &[Resource],
) -> CoreResult<Vec<AuxNav>> {
    let base_dir = parent_dir(nav_path);
    let mut reader = Reader::from_reader(bytes);
    reader.config_mut().check_end_names = false;

    let mut result: Vec<AuxNav> = Vec::new();
    // In-progress preserved nav, plus its <ol>/<li> assembly stacks
    // (mirrors the toc parser's tree assembly).
    let mut current: Option<AuxNav> = None;
    let mut skipping_nav = false;
    let mut lists: Vec<Vec<AuxNavEntry>> = Vec::new();
    let mut open: Vec<AuxNavEntry> = Vec::new();
    let mut collecting_label = false;
    let mut collecting_heading = false;

    loop {
        match reader.read_event() {
            Ok(Event::Start(e)) => match e.local_name().as_ref() {
                "nav" => match preserved_nav_type(&e) {
                    Some(epub_type) if current.is_none() && !skipping_nav => {
                        current = Some(AuxNav {
                            epub_type,
                            heading: None,
                            entries: Vec::new(),
                        });
                        lists.clear();
                        open.clear();
                    }
                    _ => skipping_nav = true,
                },
                "h1" | "h2" | "h3" | "h4" | "h5" | "h6"
                    if current.is_some() && !skipping_nav && lists.is_empty() =>
                {
                    if let Some(nav) = current.as_mut() {
                        if nav.heading.is_none() {
                            nav.heading = Some(String::new());
                            collecting_heading = true;
                        }
                    }
                }
                "ol" if current.is_some() && !skipping_nav => lists.push(Vec::new()),
                "li" if current.is_some() && !skipping_nav && !lists.is_empty() => {
                    open.push(AuxNavEntry {
                        label: String::new(),
                        entry_type: None,
                        target: None,
                        children: Vec::new(),
                    })
                }
                "a" if current.is_some() && !skipping_nav && !open.is_empty() => {
                    if let Some(item) = open.last_mut() {
                        if let Some(href) = attr(&e, "href") {
                            item.target = Some(classify_target(&base_dir, &href, resources));
                        }
                        item.entry_type = epub_type_attr(&e);
                    }
                    collecting_label = true;
                }
                "span" if current.is_some() && !skipping_nav && !open.is_empty() => {
                    collecting_label = true
                }
                _ => {}
            },
            Ok(Event::Text(t)) if collecting_label => {
                if let Some(item) = open.last_mut() {
                    item.label
                        .push_str(&t.xml_content(quick_xml::XmlVersion::Implicit1_0));
                }
            }
            Ok(Event::Text(t)) if collecting_heading => {
                if let Some(h) = current.as_mut().and_then(|n| n.heading.as_mut()) {
                    h.push_str(&t.xml_content(quick_xml::XmlVersion::Implicit1_0));
                }
            }
            Ok(Event::GeneralRef(r)) if collecting_label => {
                if let (Some(item), Some(ch)) = (open.last_mut(), resolve_entity(&r)) {
                    item.label.push(ch);
                }
            }
            Ok(Event::GeneralRef(r)) if collecting_heading => {
                if let (Some(h), Some(ch)) = (
                    current.as_mut().and_then(|n| n.heading.as_mut()),
                    resolve_entity(&r),
                ) {
                    h.push(ch);
                }
            }
            Ok(Event::End(e)) => match e.local_name().as_ref() {
                "nav" => {
                    if skipping_nav {
                        skipping_nav = false;
                    } else if let Some(mut nav) = current.take() {
                        if let Some(h) = nav.heading.as_mut() {
                            *h = h.trim().to_owned();
                            if h.is_empty() {
                                nav.heading = None;
                            }
                        }
                        if !nav.entries.is_empty() {
                            result.push(nav);
                        }
                        lists.clear();
                        open.clear();
                    }
                }
                "h1" | "h2" | "h3" | "h4" | "h5" | "h6" => collecting_heading = false,
                "ol" if current.is_some() && !skipping_nav => {
                    let done = lists.pop().unwrap_or_default();
                    match open.last_mut() {
                        Some(item) => item.children = done,
                        None => {
                            if let Some(nav) = current.as_mut() {
                                if nav.entries.is_empty() {
                                    nav.entries = done;
                                }
                            }
                        }
                    }
                }
                "li" if current.is_some() && !skipping_nav => {
                    if let Some(mut item) = open.pop() {
                        item.label = item.label.trim().to_owned();
                        if let Some(list) = lists.last_mut() {
                            list.push(item);
                        }
                    }
                }
                "a" | "span" => collecting_label = false,
                _ => {}
            },
            Ok(Event::Eof) => break,
            Err(e) => {
                return Err(CoreError::MalformedPackage {
                    message: format!(
                        "nav document XML error at byte {}: {e}",
                        reader.buffer_position()
                    ),
                })
            }
            _ => {}
        }
    }
    Ok(result)
}

/// `epub:type` of a `<nav>` when it should be preserved through rebuilds:
/// present and not containing `toc` (the toc nav is regenerated, not
/// preserved). `None` otherwise.
fn preserved_nav_type(e: &BytesStart) -> Option<String> {
    let t = epub_type_attr(e)?;
    if t.split_whitespace().any(|v| v == "toc") {
        return None;
    }
    Some(t)
}

/// The `epub:type` attribute of an element, if any.
fn epub_type_attr(e: &BytesStart) -> Option<String> {
    e.attributes().flatten().find_map(|a| {
        (a.key.as_ref() == "epub:type"
            || (a.key.local_name().as_ref() == "type" && a.key.as_ref().contains(':')))
        .then(|| {
            a.normalized_value(quick_xml::XmlVersion::Implicit1_0)
                .unwrap_or_default()
                .into_owned()
        })
    })
}

/// Bind one href to its manifest resource (by resolved path) or keep it
/// verbatim (external URL or unresolvable reference).
fn classify_target(base_dir: &str, href: &str, resources: &[Resource]) -> AuxTarget {
    if has_scheme(href) {
        return AuxTarget::Href(href.to_owned());
    }
    let (path, fragment) = match href.split_once('#') {
        Some((p, f)) => (p, Some(f.to_owned())),
        None => (href, None),
    };
    let resolved = resolve_href(base_dir, path);
    match resources.iter().find(|r| r.path == resolved) {
        Some(r) => AuxTarget::Resource {
            id: r.id.clone(),
            fragment,
        },
        None => AuxTarget::Href(href.to_owned()),
    }
}

/// True when `href` carries a URI scheme (`https:`, `mailto:`, …): a `:`
/// appears before any `/`, `?`, or `#`.
fn has_scheme(href: &str) -> bool {
    href.split(['/', '?', '#'])
        .next()
        .unwrap_or_default()
        .contains(':')
}

/// Check every nav href (fragment stripped) resolves to a manifest resource.
pub fn validate_nav_targets(nav: &[NavPoint], resources: &[Resource]) -> CoreResult<()> {
    for point in nav {
        if let Some(href) = &point.href {
            let path = href.split('#').next().unwrap_or_default();
            if !resources.iter().any(|r| r.path == path) {
                return Err(CoreError::MalformedPackage {
                    message: format!(
                        "nav entry {:?} points at {path:?}, not in the manifest",
                        point.label
                    ),
                });
            }
        }
        validate_nav_targets(&point.children, resources)?;
    }
    Ok(())
}

fn is_toc_nav(e: &BytesStart) -> bool {
    // epub:type="toc" (possibly space-separated) or ARIA role="doc-toc".
    let epub_type = e.attributes().flatten().find_map(|a| {
        (a.key.as_ref() == "epub:type" || a.key.local_name().as_ref() == "type").then(|| {
            a.normalized_value(quick_xml::XmlVersion::Implicit1_0)
                .unwrap_or_default()
                .into_owned()
        })
    });
    if let Some(t) = epub_type {
        return t.split_whitespace().any(|v| v == "toc");
    }
    attr(e, "role").is_some_and(|r| r.split_whitespace().any(|v| v == "doc-toc"))
}

fn resolve_href_with_fragment(base_dir: &str, href: &str) -> String {
    match href.split_once('#') {
        Some((path, frag)) => format!("{}#{frag}", resolve_href(base_dir, path)),
        None => resolve_href(base_dir, href),
    }
}

fn parent_dir(path: &str) -> String {
    match path.rfind('/') {
        Some(i) => path[..i].to_owned(),
        None => String::new(),
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

#[cfg(test)]
mod tests {
    use super::*;

    const NAV_XHTML: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>Nav</title></head>
<body>
  <nav epub:type="landmarks"><ol><li><a href="cover.xhtml">Cover</a></li></ol></nav>
  <nav epub:type="toc" id="toc">
    <h1>Contents</h1>
    <ol>
      <li><a href="text/ch1.xhtml">Chapter 1 &amp; Start</a>
        <ol>
          <li><a href="text/ch1.xhtml#sec1">Section 1.1</a></li>
        </ol>
      </li>
      <li><span>Part Two</span>
        <ol>
          <li><a href="text/ch2.xhtml">Chapter 2</a></li>
        </ol>
      </li>
    </ol>
  </nav>
</body>
</html>"#;

    const NCX: &str = r#"<?xml version="1.0"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <navMap>
    <navPoint id="n1" playOrder="1">
      <navLabel><text>Kapitel 1 &amp; los</text></navLabel>
      <content src="ch1.html"/>
      <navPoint id="n1a" playOrder="2">
        <navLabel><text>Abschnitt</text></navLabel>
        <content src="ch1.html#a"/>
      </navPoint>
    </navPoint>
    <navPoint id="n2" playOrder="3">
      <navLabel><text>Kapitel 2</text></navLabel>
      <content src="ch2.html"/>
    </navPoint>
  </navMap>
</ncx>"#;

    #[test]
    fn parses_nav_xhtml_tree() {
        let nav = parse_nav_xhtml(NAV_XHTML.as_bytes(), "OEBPS/nav.xhtml").unwrap();
        assert_eq!(nav.len(), 2);
        assert_eq!(nav[0].label, "Chapter 1 & Start");
        assert_eq!(nav[0].href.as_deref(), Some("OEBPS/text/ch1.xhtml"));
        assert_eq!(nav[0].children.len(), 1);
        assert_eq!(
            nav[0].children[0].href.as_deref(),
            Some("OEBPS/text/ch1.xhtml#sec1")
        );
        assert_eq!(nav[1].label, "Part Two");
        assert_eq!(nav[1].href, None);
        assert_eq!(nav[1].children[0].label, "Chapter 2");
    }

    #[test]
    fn skips_non_toc_navs() {
        let nav = parse_nav_xhtml(NAV_XHTML.as_bytes(), "OEBPS/nav.xhtml").unwrap();
        assert!(nav.iter().all(|p| p.label != "Cover"));
    }

    #[test]
    fn nav_without_toc_is_malformed() {
        let html = r#"<html><body><nav epub:type="landmarks"><ol><li><a href="a.xhtml">A</a></li></ol></nav></body></html>"#;
        let err = parse_nav_xhtml(html.as_bytes(), "nav.xhtml").unwrap_err();
        assert!(matches!(err, CoreError::MalformedPackage { .. }));
    }

    #[test]
    fn accepts_doc_toc_role() {
        let html = r#"<html><body><nav role="doc-toc"><ol><li><a href="a.xhtml">A</a></li></ol></nav></body></html>"#;
        let nav = parse_nav_xhtml(html.as_bytes(), "nav.xhtml").unwrap();
        assert_eq!(nav[0].label, "A");
        assert_eq!(nav[0].href.as_deref(), Some("a.xhtml"));
    }

    #[test]
    fn parses_ncx_tree() {
        let nav = parse_ncx(NCX.as_bytes(), "OEBPS/toc.ncx").unwrap();
        assert_eq!(nav.len(), 2);
        assert_eq!(nav[0].label, "Kapitel 1 & los");
        assert_eq!(nav[0].href.as_deref(), Some("OEBPS/ch1.html"));
        assert_eq!(nav[0].children.len(), 1);
        assert_eq!(nav[0].children[0].href.as_deref(), Some("OEBPS/ch1.html#a"));
        assert_eq!(nav[1].label, "Kapitel 2");
    }

    #[test]
    fn ncx_without_navmap_is_malformed() {
        let err = parse_ncx(b"<ncx></ncx>", "toc.ncx").unwrap_err();
        assert!(
            matches!(err, CoreError::MalformedPackage { message } if message.contains("navMap"))
        );
    }

    const NAV_WITH_AUX: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<body>
  <nav epub:type="toc"><ol><li><a href="text/ch1.xhtml">Chapter 1</a></li></ol></nav>
  <nav epub:type="landmarks">
    <h2>Guide &amp; Landmarks</h2>
    <ol>
      <li><a epub:type="bodymatter" href="text/ch1.xhtml">Start</a></li>
      <li><a epub:type="toc" href="nav.xhtml">Contents</a></li>
      <li><a epub:type="other" href="https://example.com/x">External</a></li>
    </ol>
  </nav>
  <nav epub:type="page-list" hidden="">
    <ol>
      <li><a href="text/ch1.xhtml#p1">1</a></li>
      <li><a href="text/ch2.xhtml#p2">2</a></li>
      <li><a href="missing.xhtml#p3">3</a></li>
    </ol>
  </nav>
</body>
</html>"#;

    fn aux_resources() -> Vec<Resource> {
        [
            "OEBPS/text/ch1.xhtml",
            "OEBPS/text/ch2.xhtml",
            "OEBPS/nav.xhtml",
        ]
        .into_iter()
        .map(|path| Resource {
            id: path.rsplit('/').next().unwrap().replace(".xhtml", ""),
            path: path.into(),
            media_type: "application/xhtml+xml".into(),
            size: 0,
        })
        .collect()
    }

    #[test]
    fn parses_aux_navs_skipping_toc() {
        let aux =
            parse_aux_navs(NAV_WITH_AUX.as_bytes(), "OEBPS/nav.xhtml", &aux_resources()).unwrap();
        assert_eq!(aux.len(), 2);

        let landmarks = &aux[0];
        assert_eq!(landmarks.epub_type, "landmarks");
        assert_eq!(landmarks.heading.as_deref(), Some("Guide & Landmarks"));
        assert_eq!(landmarks.entries.len(), 3);
        assert_eq!(landmarks.entries[0].label, "Start");
        assert_eq!(
            landmarks.entries[0].entry_type.as_deref(),
            Some("bodymatter")
        );
        assert!(matches!(
            &landmarks.entries[0].target,
            Some(AuxTarget::Resource { id, fragment: None }) if id == "ch1"
        ));
        assert!(matches!(
            &landmarks.entries[1].target,
            Some(AuxTarget::Resource { id, .. }) if id == "nav"
        ));
        assert!(matches!(
            &landmarks.entries[2].target,
            Some(AuxTarget::Href(h)) if h == "https://example.com/x"
        ));

        let page_list = &aux[1];
        assert_eq!(page_list.epub_type, "page-list");
        assert_eq!(page_list.heading, None);
        assert_eq!(page_list.entries.len(), 3);
        assert!(matches!(
            &page_list.entries[0].target,
            Some(AuxTarget::Resource { id, fragment: Some(f) }) if id == "ch1" && f == "p1"
        ));
        // Unresolvable internal href stays verbatim.
        assert!(matches!(
            &page_list.entries[2].target,
            Some(AuxTarget::Href(h)) if h == "missing.xhtml#p3"
        ));
    }

    #[test]
    fn aux_navs_absent_when_only_toc() {
        let aux =
            parse_aux_navs(NAV_XHTML.as_bytes(), "OEBPS/nav.xhtml", &aux_resources()).unwrap();
        // NAV_XHTML's landmarks nav has one entry pointing at cover.xhtml,
        // which is not in the manifest: kept verbatim, nav preserved.
        assert_eq!(aux.len(), 1);
        assert_eq!(aux[0].epub_type, "landmarks");
        // A toc-only document yields nothing.
        let toc_only = r#"<html><body><nav epub:type="toc"><ol><li><a href="a.xhtml">A</a></li></ol></nav></body></html>"#;
        let aux = parse_aux_navs(toc_only.as_bytes(), "nav.xhtml", &[]).unwrap();
        assert!(aux.is_empty());
    }

    #[test]
    fn validates_targets_against_manifest() {
        let nav = parse_ncx(NCX.as_bytes(), "OEBPS/toc.ncx").unwrap();
        let make = |path: &str| Resource {
            id: path.into(),
            path: path.into(),
            media_type: "application/xhtml+xml".into(),
            size: 0,
        };
        let ok = vec![make("OEBPS/ch1.html"), make("OEBPS/ch2.html")];
        assert!(validate_nav_targets(&nav, &ok).is_ok());
        let missing = vec![make("OEBPS/ch1.html")];
        let err = validate_nav_targets(&nav, &missing).unwrap_err();
        assert!(
            matches!(err, CoreError::MalformedPackage { message } if message.contains("ch2.html"))
        );
    }
}
