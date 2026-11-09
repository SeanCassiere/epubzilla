//! Markdown ↔ XHTML round-trip conversion. Contractual:
//! docs/contracts/content-roundtrip.md — the conformance fixtures in
//! `tests/fixtures/roundtrip/` are the executable form of that contract.
//!
//! Scope: **body content only**. The XHTML document frame (`<html>`,
//! `<head>`, charset, CSS links) is owned by the core elsewhere and is never
//! seen by this module — both functions operate on the children of `<body>`.
//! When footnotes or alerts are present the produced fragment uses the `epub:` prefix;
//! the caller must ensure `xmlns:epub="http://www.idpf.org/2007/ops"` is
//! declared on the document element.
//!
//! - [`markdown_to_xhtml`] always succeeds (the contract's CommonMark/GFM
//!   subset, heading attributes, and footnotes). Raw HTML is escaped except
//!   standalone empty-paragraph breaks; output is XML-well-formed.
//! - [`xhtml_to_markdown`] succeeds only for the supported subset; anything
//!   else returns [`CoreError::ConversionLossy`] naming the offending
//!   construct. Conversion is never lossy.
//!
//! Class annotations: a paragraph consisting solely of `{.classname}`
//! attaches that class to the following block; headings take the Pandoc
//! trailing form (`## Title {.classname}`).

use std::collections::{HashMap, HashSet};

use pulldown_cmark::{
    Alignment, BlockQuoteKind, CodeBlockKind, Event, LinkType, Options, Parser, Tag, TagEnd,
};
use quick_xml::events::Event as XmlEvent;
use quick_xml::Reader;

use crate::error::{CoreError, CoreResult};

// ---------------------------------------------------------------------------
// Markdown → XHTML
// ---------------------------------------------------------------------------

/// Convert the contract's Markdown flavor to an
/// XML-well-formed XHTML body fragment. Always succeeds.
pub fn markdown_to_xhtml(md: &str) -> String {
    let mut options = Options::empty();
    options.insert(Options::ENABLE_TABLES);
    options.insert(Options::ENABLE_STRIKETHROUGH);
    options.insert(Options::ENABLE_FOOTNOTES);
    options.insert(Options::ENABLE_HEADING_ATTRIBUTES);
    options.insert(Options::ENABLE_GFM);
    options.insert(Options::ENABLE_TASKLISTS);
    let md: String = md.chars().filter(|c| xml_char(*c)).collect();
    let events: Vec<_> = Parser::new_ext(&md, options).collect();
    let mut w = XhtmlWriter::default();
    // Reserve derived footnote ids before assigning user-authored heading ids.
    let mut counts = HashMap::<String, usize>::new();
    for event in &events {
        match event {
            Event::FootnoteReference(name) => {
                let count = counts.entry(name.to_string()).or_default();
                *count += 1;
                w.ids.insert(reference_id(name, *count));
            }
            Event::Start(Tag::FootnoteDefinition(name)) => {
                w.ids.insert(format!("fn-{name}"));
            }
            _ => {}
        }
    }
    let mut events = events.into_iter().peekable();
    while let Some(event) = events.next() {
        if matches!(event, Event::Start(Tag::Item)) {
            // Loose items have a paragraph between the item and its marker.
            let paragraph = matches!(events.peek(), Some(Event::Start(Tag::Paragraph)));
            if paragraph {
                events.next();
            }
            if let Some(Event::TaskListMarker(done)) = events.peek() {
                let state = if *done { "done" } else { "open" };
                w.sink()
                    .push_str(&format!("<li class=\"task-item task-{state}\">"));
            } else {
                w.event(event);
            }
            if paragraph {
                w.event(Event::Start(Tag::Paragraph));
            }
        } else {
            w.event(event);
        }
    }
    w.finish()
}

#[derive(Default)]
struct XhtmlWriter {
    out: String,
    /// Buffer for the paragraph currently being written (paragraphs are
    /// buffered so `{.classname}` annotation paragraphs can be intercepted).
    para: Option<String>,
    raw_html: Option<String>,
    /// Buffer for the footnote definition currently being written.
    footnote: Option<(String, String)>,
    /// `(src, alt, title)` while inside an image (children render to plain alt text).
    image: Option<(String, String, String)>,
    /// Class waiting to be attached to the next block element.
    pending_class: Option<String>,
    /// Completed footnote definitions, in source order.
    defs: Vec<(String, String)>,
    /// Footnote names in order of first reference (defines numbering).
    ref_order: Vec<String>,
    in_table_head: bool,
    alignments: Vec<Alignment>,
    column: usize,
    ids: HashSet<String>,
    ref_counts: HashMap<String, usize>,
    emitted_reference_ids: HashSet<String>,
    backlinks: HashMap<String, Vec<String>>,
}

impl XhtmlWriter {
    fn sink(&mut self) -> &mut String {
        if let Some(p) = self.para.as_mut() {
            return p;
        }
        if let Some((_, f)) = self.footnote.as_mut() {
            return f;
        }
        &mut self.out
    }

    /// Write a completed block string (used for paragraphs, which buffer).
    fn write_block(&mut self, s: &str) {
        let target = match self.footnote.as_mut() {
            Some((_, f)) => f,
            None => &mut self.out,
        };
        target.push_str(s);
    }

    fn class_attr(&mut self) -> String {
        match self.pending_class.take() {
            Some(c) => format!(" class=\"{}\"", esc_attr(&c)),
            None => String::new(),
        }
    }

    fn event(&mut self, event: Event<'_>) {
        // Inside an image, children only contribute to the alt text.
        if let Some((_, alt, _)) = self.image.as_mut() {
            match event {
                Event::Text(t) | Event::Code(t) => alt.push_str(&t),
                Event::SoftBreak | Event::HardBreak => alt.push(' '),
                Event::End(TagEnd::Image) => {
                    let (src, alt, title) = self.image.take().expect("image state");
                    let tag = format!(
                        "<img src=\"{}\" alt=\"{}\"{}/>",
                        esc_attr(&src),
                        esc_attr(&alt),
                        title_attr(&title)
                    );
                    self.sink().push_str(&tag);
                }
                _ => {}
            }
            return;
        }
        match event {
            Event::Start(tag) => self.start(tag),
            Event::End(tag) => self.end(tag),
            Event::Text(t) => {
                let escaped = esc_text(&t);
                self.sink().push_str(&escaped);
            }
            Event::Code(t) => {
                let code = format!("<code>{}</code>", esc_text(&t));
                self.sink().push_str(&code);
            }
            // Raw HTML is escaped as text: output must stay XML-well-formed.
            Event::Html(t) => {
                if let Some(html) = &mut self.raw_html {
                    html.push_str(&t);
                } else {
                    self.sink().push_str(&esc_text(&t));
                }
            }
            Event::InlineHtml(t) => {
                self.sink().push_str(&esc_text(&t));
            }
            Event::SoftBreak => self.sink().push('\n'),
            Event::HardBreak => self.sink().push_str("<br/>\n"),
            Event::Rule => {
                let cls = self.class_attr();
                let tag = format!("<hr{cls}/>\n");
                self.write_block(&tag);
            }
            Event::FootnoteReference(name) => {
                let n = match self.ref_order.iter().position(|r| r == name.as_ref()) {
                    Some(i) => i + 1,
                    None => {
                        self.ref_order.push(name.to_string());
                        self.ref_order.len()
                    }
                };
                let count = self.ref_counts.entry(name.to_string()).or_default();
                *count += 1;
                let reference = reference_id(&name, *count);
                // A label like "note-2" can collide with the second reference
                // to "note". Keep the first id, and never link a backlink to
                // an anchor owned by a different occurrence.
                let id = if self.emitted_reference_ids.insert(reference.clone()) {
                    self.backlinks
                        .entry(name.to_string())
                        .or_default()
                        .push(reference.clone());
                    format!(" id=\"{}\"", esc_attr(&reference))
                } else {
                    String::new()
                };
                let anchor = format!(
                    "<a epub:type=\"noteref\" role=\"doc-noteref\"{id} href=\"#fn-{}\"><sup>{n}</sup></a>",
                    esc_attr(&name)
                );
                self.sink().push_str(&anchor);
            }
            Event::TaskListMarker(done) => {
                let (label, symbol) = if done {
                    ("Completed", "☑")
                } else {
                    ("Not completed", "☐")
                };
                self.sink().push_str(&format!("<span class=\"task-marker\" role=\"img\" aria-label=\"{label}\">{symbol}</span> "));
            }
            Event::InlineMath(_) | Event::DisplayMath(_) => {}
        }
    }

    fn start(&mut self, tag: Tag<'_>) {
        match tag {
            Tag::Paragraph => self.para = Some(String::new()),
            Tag::HtmlBlock => self.raw_html = Some(String::new()),
            Tag::Heading {
                level, id, classes, ..
            } => {
                let cls = if classes.is_empty() {
                    self.class_attr()
                } else {
                    self.pending_class = None;
                    format!(" class=\"{}\"", esc_attr(&classes.join(" ")))
                };
                let id = id
                    .filter(|id| self.ids.insert(id.to_string()))
                    .map(|id| format!(" id=\"{}\"", esc_attr(&id)))
                    .unwrap_or_default();
                let open = format!("<h{}{id}{cls}>", level as usize);
                self.sink().push_str(&open);
            }
            Tag::BlockQuote(Some(kind)) => {
                let (name, epub_type, role, title) = alert_signature(kind);
                self.pending_class = None;
                self.sink().push_str(&format!(
                    "<aside class=\"alert alert-{name}\" epub:type=\"{epub_type}\" role=\"{role}\">\n<p class=\"alert-title\">{title}</p>\n"
                ));
            }
            Tag::BlockQuote(None) => {
                let cls = self.class_attr();
                let open = format!("<blockquote{cls}>\n");
                self.sink().push_str(&open);
            }
            Tag::CodeBlock(kind) => {
                let lang = match &kind {
                    CodeBlockKind::Fenced(info) => {
                        info.split_whitespace().next().unwrap_or("").to_string()
                    }
                    CodeBlockKind::Indented => String::new(),
                };
                let cls = self.class_attr();
                let code_cls = if lang.is_empty() {
                    String::new()
                } else {
                    format!(" class=\"language-{}\"", esc_attr(&lang))
                };
                let open = format!("<pre{cls}><code{code_cls}>");
                self.sink().push_str(&open);
            }
            Tag::List(start) => {
                let cls = self.class_attr();
                let open = match start {
                    Some(1) => format!("<ol{cls}>\n"),
                    Some(n) => format!("<ol{cls} start=\"{n}\">\n"),
                    None => format!("<ul{cls}>\n"),
                };
                self.sink().push_str(&open);
            }
            Tag::Item => self.sink().push_str("<li>"),
            Tag::FootnoteDefinition(name) => {
                self.footnote = Some((name.to_string(), String::new()));
            }
            Tag::Table(alignments) => {
                self.alignments = alignments;
                let cls = self.class_attr();
                let open = format!("<table{cls}>\n");
                self.sink().push_str(&open);
            }
            Tag::TableHead => {
                self.in_table_head = true;
                self.column = 0;
                self.sink().push_str("<thead>\n<tr>\n");
            }
            Tag::TableRow => {
                self.column = 0;
                self.sink().push_str("<tr>\n");
            }
            Tag::TableCell => {
                let (cell, scope) = if self.in_table_head {
                    ("th", " scope=\"col\"")
                } else {
                    ("td", "")
                };
                let alignment = match self.alignments.get(self.column) {
                    Some(Alignment::Left) => "left",
                    Some(Alignment::Center) => "center",
                    Some(Alignment::Right) => "right",
                    _ => "",
                };
                let style = if alignment.is_empty() {
                    String::new()
                } else {
                    format!(" style=\"text-align: {alignment}\"")
                };
                self.column += 1;
                self.sink().push_str(&format!("<{cell}{scope}{style}>"));
            }
            Tag::Emphasis => self.sink().push_str("<em>"),
            Tag::Strong => self.sink().push_str("<strong>"),
            Tag::Strikethrough => self.sink().push_str("<del>"),
            Tag::Link {
                dest_url,
                title,
                link_type,
                ..
            } => {
                let dest_url = if link_type == LinkType::Email {
                    format!("mailto:{dest_url}")
                } else {
                    dest_url.to_string()
                };
                let open = format!("<a href=\"{}\"{}>", esc_attr(&dest_url), title_attr(&title));
                self.sink().push_str(&open);
            }
            Tag::Image {
                dest_url, title, ..
            } => {
                self.image = Some((dest_url.to_string(), String::new(), title.to_string()));
            }
            _ => {}
        }
    }

    fn end(&mut self, tag: TagEnd) {
        match tag {
            TagEnd::HtmlBlock => {
                let html = self.raw_html.take().unwrap_or_default();
                if matches!(html.trim(), "<br>" | "<br/>" | "<br />") {
                    let cls = self.class_attr();
                    self.write_block(&format!("<p{cls}><br/></p>\n"));
                } else {
                    self.sink().push_str(&esc_text(&html));
                }
            }
            TagEnd::Paragraph => {
                let buf = self.para.take().unwrap_or_default();
                if let Some(class) = parse_annotation(buf.trim()) {
                    self.pending_class = Some(class);
                } else {
                    let cls = self.class_attr();
                    let block = format!("<p{cls}>{buf}</p>\n");
                    self.write_block(&block);
                }
            }
            TagEnd::Heading(level) => {
                let close = format!("</h{}>\n", level as usize);
                self.sink().push_str(&close);
            }
            TagEnd::BlockQuote(None) => self.sink().push_str("</blockquote>\n"),
            TagEnd::BlockQuote(Some(_)) => self.sink().push_str("</aside>\n"),
            TagEnd::CodeBlock => self.sink().push_str("</code></pre>\n"),
            TagEnd::List(ordered) => {
                let close = if ordered { "</ol>\n" } else { "</ul>\n" };
                self.sink().push_str(close);
            }
            TagEnd::Item => self.sink().push_str("</li>\n"),
            TagEnd::FootnoteDefinition => {
                if let Some(def) = self.footnote.take() {
                    self.defs.push(def);
                }
            }
            TagEnd::Table => self.sink().push_str("</tbody>\n</table>\n"),
            TagEnd::TableHead => {
                self.in_table_head = false;
                self.sink().push_str("</tr>\n</thead>\n<tbody>\n");
            }
            TagEnd::TableRow => self.sink().push_str("</tr>\n"),
            TagEnd::TableCell => {
                let close = if self.in_table_head {
                    "</th>\n"
                } else {
                    "</td>\n"
                };
                self.sink().push_str(close);
            }
            TagEnd::Emphasis => self.sink().push_str("</em>"),
            TagEnd::Strong => self.sink().push_str("</strong>"),
            TagEnd::Strikethrough => self.sink().push_str("</del>"),
            TagEnd::Link => self.sink().push_str("</a>"),
            _ => {}
        }
    }

    fn finish(mut self) -> String {
        if let Some(class) = self.pending_class.take() {
            // Trailing annotation with no block to attach to: keep literally.
            self.out
                .push_str(&format!("<p>{{.{}}}</p>\n", esc_text(&class)));
        }
        // Emit footnote bodies at the end, in order of first reference,
        // followed by any defined-but-unreferenced notes.
        let mut ordered: Vec<(String, String)> = Vec::new();
        for name in &self.ref_order {
            if let Some(i) = self.defs.iter().position(|(n, _)| n == name) {
                ordered.push(self.defs.remove(i));
            }
        }
        ordered.append(&mut self.defs);
        for (name, body) in ordered {
            let backlinks = self
                .backlinks
                .get(&name)
                .into_iter()
                .flatten()
                .map(|id| format!("<a role=\"doc-backlink\" href=\"#{}\">↩</a>", esc_attr(id)))
                .collect::<Vec<_>>()
                .join(" ");
            let backlinks = if backlinks.is_empty() {
                String::new()
            } else {
                format!("<p>{backlinks}</p>\n")
            };
            self.out.push_str(&format!(
                "<aside epub:type=\"footnote\" role=\"doc-footnote\" id=\"fn-{}\">\n{body}{backlinks}</aside>\n",
                esc_attr(&name)
            ));
        }
        self.out
    }
}

fn reference_id(name: &str, count: usize) -> String {
    if count == 1 {
        format!("fnref-{name}")
    } else {
        format!("fnref-{name}-{count}")
    }
}

fn title_attr(title: &str) -> String {
    if title.is_empty() {
        String::new()
    } else {
        format!(" title=\"{}\"", esc_attr(title))
    }
}

fn xml_char(c: char) -> bool {
    matches!(c, '\t' | '\n' | '\r' | '\u{20}'..='\u{d7ff}' | '\u{e000}'..='\u{fffd}' | '\u{10000}'..='\u{10ffff}')
}

fn alert_signature(
    kind: BlockQuoteKind,
) -> (&'static str, &'static str, &'static str, &'static str) {
    match kind {
        BlockQuoteKind::Note => ("note", "notice", "note", "Note"),
        BlockQuoteKind::Tip => ("tip", "tip", "doc-tip", "Tip"),
        BlockQuoteKind::Important => ("important", "notice", "note", "Important"),
        BlockQuoteKind::Warning => ("warning", "notice", "doc-notice", "Warning"),
        BlockQuoteKind::Caution => ("caution", "notice", "doc-notice", "Caution"),
    }
}

/// `{.classname}` → `Some("classname")`.
fn parse_annotation(s: &str) -> Option<String> {
    let inner = s.strip_prefix("{.")?.strip_suffix('}')?;
    let mut chars = inner.chars();
    let first = chars.next()?;
    if !first.is_ascii_alphabetic() {
        return None;
    }
    if !chars.all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return None;
    }
    Some(inner.to_string())
}

fn esc_text(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            _ if xml_char(ch) => out.push(ch),
            _ => {}
        }
    }
    out
}

fn esc_attr(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            _ if xml_char(ch) => out.push(ch),
            _ => {}
        }
    }
    out
}

// ---------------------------------------------------------------------------
// XHTML → Markdown
// ---------------------------------------------------------------------------

/// Convert an XHTML body fragment back to Markdown. Returns
/// [`CoreError::ConversionLossy`] naming the offending construct if the
/// content uses anything outside the supported subset — never converts
/// lossily.
pub fn xhtml_to_markdown(xhtml_body: &str) -> CoreResult<String> {
    let nodes = parse_tree(xhtml_body)?;
    let mut ctx = validate_generated_content(&nodes)?;
    let mut blocks = nodes_to_blocks(&nodes, &mut ctx)?;
    blocks.append(&mut ctx.footnotes);
    let mut md = blocks.join("\n\n");
    if !md.is_empty() {
        md.push('\n');
    }
    Ok(md)
}

fn lossy(detail: impl Into<String>) -> CoreError {
    CoreError::ConversionLossy {
        detail: detail.into(),
    }
}

// --- lightweight DOM ---

#[derive(Clone)]
enum Node {
    Elem(Elem),
    Text(String),
}

#[derive(Clone)]
struct Elem {
    name: String,
    attrs: Vec<(String, String)>,
    children: Vec<Node>,
}

fn parse_tree(xhtml: &str) -> CoreResult<Vec<Node>> {
    let mut reader = Reader::from_reader(xhtml.as_bytes());
    let mut root: Vec<Node> = Vec::new();
    let mut stack: Vec<Elem> = Vec::new();

    fn push(root: &mut Vec<Node>, stack: &mut [Elem], node: Node) {
        match stack.last_mut() {
            Some(parent) => parent.children.push(node),
            None => root.push(node),
        }
    }

    loop {
        match reader.read_event() {
            Ok(XmlEvent::Start(e)) => stack.push(elem_from_start(&e)?),
            Ok(XmlEvent::Empty(e)) => {
                let el = elem_from_start(&e)?;
                push(&mut root, &mut stack, Node::Elem(el));
            }
            Ok(XmlEvent::End(_)) => match stack.pop() {
                Some(el) => push(&mut root, &mut stack, Node::Elem(el)),
                None => return Err(lossy("unbalanced closing tag in body")),
            },
            Ok(XmlEvent::Text(t)) => {
                let text = t
                    .xml_content(quick_xml::XmlVersion::Implicit1_0)
                    .into_owned();
                push(&mut root, &mut stack, Node::Text(text));
            }
            Ok(XmlEvent::CData(t)) => {
                let text = t.as_ref().to_owned();
                push(&mut root, &mut stack, Node::Text(text));
            }
            Ok(XmlEvent::GeneralRef(r)) => {
                let content = r.xml_content(quick_xml::XmlVersion::Implicit1_0);
                let ch = resolve_entity(&r)
                    .ok_or_else(|| lossy(format!("unresolvable entity reference &{content};")))?;
                push(&mut root, &mut stack, Node::Text(ch.to_string()));
            }
            Ok(XmlEvent::Comment(_)) => return Err(lossy("XML comment in body")),
            Ok(XmlEvent::PI(_)) => return Err(lossy("processing instruction in body")),
            Ok(XmlEvent::DocType(_)) => return Err(lossy("DOCTYPE declaration in body")),
            Ok(XmlEvent::Decl(_)) => {}
            Ok(XmlEvent::Eof) => break,
            Err(e) => {
                return Err(lossy(format!(
                    "body is not well-formed XML at byte {}: {e}",
                    reader.buffer_position()
                )))
            }
        }
    }
    if !stack.is_empty() {
        return Err(lossy("unclosed element in body"));
    }
    Ok(root)
}

fn elem_from_start(e: &quick_xml::events::BytesStart) -> CoreResult<Elem> {
    let name = e.name().as_ref().to_owned();
    let mut attrs = Vec::new();
    for attr in e.attributes() {
        let attr = attr.map_err(|err| lossy(format!("malformed attribute on <{name}>: {err}")))?;
        let key = attr.key.as_ref().to_owned();
        let value = attr
            .normalized_value(quick_xml::XmlVersion::Implicit1_0)
            .unwrap_or_default()
            .into_owned();
        attrs.push((key, value));
    }
    Ok(Elem {
        name,
        attrs,
        children: Vec::new(),
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

impl Elem {
    fn attr(&self, name: &str) -> Option<&str> {
        self.attrs
            .iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.as_str())
    }

    /// Reject any attribute not in `allowed` (xmlns declarations tolerated).
    fn check_attrs(&self, allowed: &[&str]) -> CoreResult<()> {
        for (k, v) in &self.attrs {
            if k == "xmlns" || k.starts_with("xmlns:") {
                continue;
            }
            if !allowed.contains(&k.as_str()) {
                return Err(lossy(format!("attribute {k}=\"{v}\" on <{}>", self.name)));
            }
        }
        Ok(())
    }

    /// A single class token, if present. Multiple classes are out of subset.
    fn single_class(&self) -> CoreResult<Option<String>> {
        match self.attr("class") {
            None => Ok(None),
            Some(c) => {
                let c = c.trim();
                if c.is_empty() {
                    return Ok(None);
                }
                if c.split_whitespace().count() > 1 {
                    return Err(lossy(format!(
                        "multiple classes \"{c}\" on <{}>",
                        self.name
                    )));
                }
                if parse_annotation(&format!("{{.{c}}}")).is_none() {
                    return Err(lossy(format!(
                        "class {c:?} cannot be represented by a block annotation"
                    )));
                }
                Ok(Some(c.to_string()))
            }
        }
    }
}

// --- markdown emission ---

#[derive(Default)]
struct MdCtx {
    /// Footnote definition blocks, appended at the end of the document.
    footnotes: Vec<String>,
    references: HashMap<String, usize>,
}

const BLOCK_ELEMS: &[&str] = &[
    "p",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "ul",
    "ol",
    "blockquote",
    "pre",
    "hr",
    "table",
    "div",
    "section",
    "aside",
];

const INLINE_ELEMS: &[&str] = &[
    "em", "strong", "del", "code", "a", "img", "br", "b", "i", "s", "strike",
];

/// Convert a run of block-level nodes into Markdown block strings.
fn nodes_to_blocks(nodes: &[Node], ctx: &mut MdCtx) -> CoreResult<Vec<String>> {
    let mut blocks = Vec::new();
    for node in nodes {
        match node {
            Node::Text(t) => {
                if !t.trim().is_empty() {
                    return Err(lossy(format!(
                        "text {:?} outside any block element",
                        t.trim()
                    )));
                }
            }
            Node::Elem(el) => blocks.append(&mut elem_to_blocks(el, ctx)?),
        }
    }
    Ok(blocks)
}

/// One block element → zero or more Markdown blocks (a class annotation adds
/// a `{.classname}` block before its element; footnote asides emit nothing
/// in place).
fn elem_to_blocks(el: &Elem, ctx: &mut MdCtx) -> CoreResult<Vec<String>> {
    let annotated = |class: Option<String>, block: String| -> Vec<String> {
        match class {
            Some(c) => vec![format!("{{.{c}}}"), block],
            None => vec![block],
        }
    };
    match el.name.as_str() {
        "p" => {
            el.check_attrs(&["class"])?;
            let class = el.single_class()?;
            if let [Node::Elem(br)] = significant_nodes(&el.children).as_slice() {
                if br.name == "br" {
                    br.check_attrs(&[])?;
                    require_empty(br)?;
                    return Ok(annotated(class, "<br />".to_string()));
                }
            }
            let text = inline_to_md(&el.children, false)?;
            if text.trim().is_empty() {
                return Ok(Vec::new()); // whitespace-only element: dropped
            }
            Ok(annotated(class, finish_paragraph(&text)))
        }
        "h1" | "h2" | "h3" | "h4" | "h5" | "h6" => {
            el.check_attrs(&["class", "id"])?;
            let class = el.single_class()?;
            let level = el.name[1..].parse::<usize>().unwrap_or(1);
            let text = inline_to_md(&el.children, false)?;
            // With no authored attributes to follow it, a literal trailing
            // {...} would be consumed as heading metadata on the next write.
            if el.attr("id").is_none()
                && class.is_none()
                && text.trim_end().ends_with('}')
                && text.contains('{')
            {
                return Err(lossy(
                    "literal trailing heading attributes cannot be preserved",
                ));
            }
            let mut line = format!("{} {}", "#".repeat(level), text.trim());
            let mut attrs = Vec::new();
            if let Some(id) = el.attr("id") {
                if !attribute_token(id) {
                    return Err(lossy("heading id cannot be represented in Markdown"));
                }
                attrs.push(format!("#{id}"));
            }
            if let Some(c) = class {
                attrs.push(format!(".{c}"));
            }
            if !attrs.is_empty() {
                line.push_str(&format!(" {{{}}}", attrs.join(" ")));
            }
            Ok(vec![line])
        }
        "blockquote" => {
            el.check_attrs(&["class"])?;
            let class = el.single_class()?;
            let inner = nodes_to_blocks(&el.children, ctx)?.join("\n\n");
            let quoted: Vec<String> = inner
                .lines()
                .map(|l| {
                    if l.is_empty() {
                        ">".to_string()
                    } else {
                        format!("> {l}")
                    }
                })
                .collect();
            Ok(annotated(class, quoted.join("\n")))
        }
        "ul" => {
            el.check_attrs(&["class"])?;
            let class = el.single_class()?;
            Ok(annotated(class, list_to_md(el, None, ctx)?))
        }
        "ol" => {
            el.check_attrs(&["class", "start"])?;
            let class = el.single_class()?;
            let start = match el.attr("start") {
                Some(s) => s
                    .trim()
                    .parse::<u64>()
                    .map_err(|_| lossy(format!("non-numeric start=\"{s}\" on <ol>")))?,
                None => 1,
            };
            Ok(annotated(class, list_to_md(el, Some(start), ctx)?))
        }
        "pre" => {
            el.check_attrs(&["class"])?;
            let class = el.single_class()?;
            Ok(annotated(class, pre_to_md(el)?))
        }
        "hr" => {
            el.check_attrs(&["class"])?;
            let class = el.single_class()?;
            require_empty(el)?;
            Ok(annotated(class, "---".to_string()))
        }
        "table" => {
            el.check_attrs(&["class"])?;
            let class = el.single_class()?;
            Ok(annotated(class, table_to_md(el)?))
        }
        "aside" => {
            if el.attr("class").is_some() {
                return alert_to_md(el, ctx);
            }
            let epub_type = el.attr("epub:type").unwrap_or_default();
            if epub_type != "footnote" {
                return Err(lossy(format!(
                    "<aside epub:type=\"{epub_type}\"> (only footnote asides are supported)"
                )));
            }
            el.check_attrs(&["epub:type", "id", "role"])?;
            check_role(el, "doc-footnote")?;
            let id = el
                .attr("id")
                .ok_or_else(|| lossy("footnote <aside> without an id"))?;
            let name = id
                .strip_prefix("fn-")
                .filter(|name| footnote_label(name))
                .ok_or_else(|| lossy("footnote id is outside the generated fn- scheme"))?;
            let children = footnote_body(el, name, ctx)?;
            let blocks = nodes_to_blocks(&children, ctx)?;
            let mut def = format!("[^{name}]:");
            for (i, block) in blocks.iter().enumerate() {
                if i == 0 {
                    def.push(' ');
                    def.push_str(&indent_continuation(block, 4));
                } else {
                    def.push_str("\n\n");
                    def.push_str(&indent_all(block, 4));
                }
            }
            ctx.footnotes.push(def);
            Ok(Vec::new())
        }
        "div" | "section" => {
            // Tolerated: unwrapped. Attributes would be lost, so any
            // attribute (other than xmlns) is out of subset.
            el.check_attrs(&[])?;
            for child in &el.children {
                if let Node::Elem(c) = child {
                    if !BLOCK_ELEMS.contains(&c.name.as_str()) {
                        return Err(lossy(format!(
                            "<{}> wrapping inline content (<{}>)",
                            el.name, c.name
                        )));
                    }
                } else if let Node::Text(t) = child {
                    if !t.trim().is_empty() {
                        return Err(lossy(format!(
                            "<{}> containing bare text {:?}",
                            el.name,
                            t.trim()
                        )));
                    }
                }
            }
            nodes_to_blocks(&el.children, ctx)
        }
        other => Err(lossy(format!("unsupported element <{other}>"))),
    }
}

fn significant_nodes(nodes: &[Node]) -> Vec<&Node> {
    nodes
        .iter()
        .filter(|node| !matches!(node, Node::Text(t) if t.trim().is_empty()))
        .collect()
}

fn plain_text(nodes: &[Node]) -> Option<String> {
    nodes
        .iter()
        .map(|node| match node {
            Node::Text(text) => Some(text.as_str()),
            Node::Elem(_) => None,
        })
        .collect::<Option<Vec<_>>>()
        .map(|parts| parts.concat())
}

fn attribute_token(token: &str) -> bool {
    !token.is_empty()
        && token
            .chars()
            .all(|c| !c.is_whitespace() && !matches!(c, '{' | '}' | '\\'))
}

fn footnote_label(label: &str) -> bool {
    attribute_token(label) && !label.contains(['[', ']'])
}

fn check_role(el: &Elem, expected: &str) -> CoreResult<()> {
    if el.attr("role").is_some_and(|role| role != expected) {
        return Err(lossy(format!("unexpected role on <{}>", el.name)));
    }
    Ok(())
}

fn noteref_label(el: &Elem) -> CoreResult<&str> {
    el.attr("href")
        .and_then(|href| href.strip_prefix("#fn-"))
        .filter(|name| footnote_label(name))
        .ok_or_else(|| lossy("noteref href is outside the generated #fn- scheme"))
}

/// Validate the entire reference graph before discarding any derived ids/text.
fn validate_generated_content(nodes: &[Node]) -> CoreResult<MdCtx> {
    fn visit(
        nodes: &[Node],
        ids: &mut HashSet<String>,
        notes: &mut HashSet<String>,
        order: &mut Vec<String>,
        ctx: &mut MdCtx,
    ) -> CoreResult<()> {
        for node in nodes {
            let Node::Elem(el) = node else { continue };
            if let Some(id) = el.attr("id") {
                if !ids.insert(id.to_string()) {
                    return Err(lossy(format!("duplicate id {id:?}")));
                }
            }
            if el.name == "aside" && el.attr("epub:type") == Some("footnote") {
                if let Some(name) = el.attr("id").and_then(|id| id.strip_prefix("fn-")) {
                    // CommonMark footnote labels are case insensitive.
                    if notes
                        .iter()
                        .any(|known| known.to_lowercase() == name.to_lowercase())
                    {
                        return Err(lossy("duplicate footnote label"));
                    }
                    notes.insert(name.to_string());
                }
            }
            if el.name == "a" && el.attr("epub:type") == Some("noteref") {
                let name = noteref_label(el)?;
                if !order.iter().any(|n| n == name) {
                    order.push(name.to_string());
                }
                let number = order.iter().position(|n| n == name).unwrap() + 1;
                let count = ctx.references.entry(name.to_string()).or_default();
                *count += 1;
                if el
                    .attr("id")
                    .is_some_and(|id| id != reference_id(name, *count))
                {
                    return Err(lossy("noteref id does not match its label and occurrence"));
                }
                let children = match el.children.as_slice() {
                    [Node::Elem(sup)] if sup.name == "sup" => {
                        sup.check_attrs(&[])?;
                        &sup.children
                    }
                    children => children,
                };
                if plain_text(children).as_deref() != Some(number.to_string().as_str()) {
                    return Err(lossy(
                        "custom noteref text (expected derived footnote number)",
                    ));
                }
            }
            visit(&el.children, ids, notes, order, ctx)?;
        }
        Ok(())
    }
    let mut ctx = MdCtx::default();
    let mut notes = HashSet::new();
    visit(
        nodes,
        &mut HashSet::new(),
        &mut notes,
        &mut Vec::new(),
        &mut ctx,
    )?;
    if ctx.references.keys().any(|name| !notes.contains(name)) {
        return Err(lossy("noteref without a matching footnote definition"));
    }
    let mut reference_ids = HashSet::new();
    for (name, count) in &ctx.references {
        for occurrence in 1..=*count {
            if !reference_ids.insert(reference_id(name, occurrence)) {
                return Err(lossy("footnote labels produce colliding reference ids"));
            }
        }
    }
    Ok(ctx)
}

fn footnote_body(el: &Elem, name: &str, ctx: &MdCtx) -> CoreResult<Vec<Node>> {
    let mut children = el.children.clone();
    while matches!(children.last(), Some(Node::Text(t)) if t.trim().is_empty()) {
        children.pop();
    }
    if let Some(Node::Elem(p)) = children.last() {
        let links = significant_nodes(&p.children);
        if p.name == "p"
            && links
                .iter()
                .any(|n| matches!(n, Node::Elem(a) if a.attr("role") == Some("doc-backlink")))
        {
            p.check_attrs(&[])?;
            let count = ctx.references.get(name).copied().unwrap_or(0);
            if links.len() != count || count == 0 {
                return Err(lossy("incomplete footnote backlinks"));
            }
            for (index, node) in links.iter().enumerate() {
                let Node::Elem(a) = node else {
                    return Err(lossy("custom backlink text"));
                };
                a.check_attrs(&["role", "href"])?;
                if a.name != "a"
                    || a.attr("role") != Some("doc-backlink")
                    || a.attr("href")
                        != Some(format!("#{}", reference_id(name, index + 1)).as_str())
                    || plain_text(&a.children).as_deref() != Some("↩")
                {
                    return Err(lossy("custom footnote backlink"));
                }
            }
            children.pop();
        }
    }
    Ok(children)
}

fn alert_to_md(el: &Elem, ctx: &mut MdCtx) -> CoreResult<Vec<String>> {
    el.check_attrs(&["class", "epub:type", "role"])?;
    for kind in [
        BlockQuoteKind::Note,
        BlockQuoteKind::Tip,
        BlockQuoteKind::Important,
        BlockQuoteKind::Warning,
        BlockQuoteKind::Caution,
    ] {
        let (name, epub_type, role, title) = alert_signature(kind);
        if el.attr("class") != Some(format!("alert alert-{name}").as_str()) {
            continue;
        }
        if el.attr("epub:type") != Some(epub_type) || el.attr("role") != Some(role) {
            return Err(lossy("alert signature does not match its kind"));
        }
        let mut children = el.children.as_slice();
        while matches!(children.first(), Some(Node::Text(t)) if t.trim().is_empty()) {
            children = &children[1..];
        }
        if let Some(Node::Elem(p)) = children.first() {
            if p.name == "p" && p.attr("class") == Some("alert-title") {
                p.check_attrs(&["class"])?;
                if plain_text(&p.children).as_deref() != Some(title) {
                    return Err(lossy("custom alert title"));
                }
                children = &children[1..];
            }
        }
        let body = nodes_to_blocks(children, ctx)?.join("\n\n");
        let mut lines = vec![format!("> [!{}]", name.to_uppercase())];
        lines.extend(body.lines().map(|line| {
            if line.is_empty() {
                ">".to_string()
            } else {
                format!("> {line}")
            }
        }));
        return Ok(vec![lines.join("\n")]);
    }
    Err(lossy("unknown aside signature"))
}

fn task_body(li: &Elem) -> CoreResult<(Elem, &'static str)> {
    li.check_attrs(&["class"])?;
    let done = match li.attr("class") {
        None => return Ok((li.clone(), "")),
        Some("task-item task-done") => true,
        Some("task-item task-open") => false,
        _ => return Err(lossy("unknown task item signature")),
    };
    let mut li = li.clone();
    let mut children = &mut li.children;
    if matches!(children.first(), Some(Node::Elem(p)) if p.name == "p") {
        let Node::Elem(p) = &mut children[0] else {
            unreachable!()
        };
        children = &mut p.children;
    }
    let Some(Node::Elem(span)) = children.first() else {
        return Err(lossy("task item without marker"));
    };
    span.check_attrs(&["class", "role", "aria-label"])?;
    let (label, symbol, marker) = if done {
        ("Completed", "☑", "[x] ")
    } else {
        ("Not completed", "☐", "[ ] ")
    };
    if span.name != "span"
        || span.attr("class") != Some("task-marker")
        || span.attr("role") != Some("img")
        || span.attr("aria-label") != Some(label)
        || plain_text(&span.children).as_deref() != Some(symbol)
    {
        return Err(lossy("custom task marker"));
    }
    children.remove(0);
    // The writer inserts one separating space; ordinary inline whitespace is normalized.
    if let Some(Node::Text(text)) = children.first_mut() {
        *text = text.trim_start().to_string();
    }
    Ok((li, marker))
}

fn cell_alignment(el: &Elem) -> CoreResult<Alignment> {
    el.check_attrs(if el.name == "th" {
        &["style", "align", "scope"]
    } else {
        &["style", "align"]
    })?;
    if el.attr("scope").is_some_and(|scope| scope != "col") {
        return Err(lossy("unsupported table header scope"));
    }
    let parse = |value: &str| match value.trim() {
        "left" => Ok(Alignment::Left),
        "center" => Ok(Alignment::Center),
        "right" => Ok(Alignment::Right),
        _ => Err(lossy("unsupported table alignment")),
    };
    let style = el
        .attr("style")
        .map(|style| {
            let style = style
                .trim()
                .strip_suffix(';')
                .unwrap_or(style.trim())
                .trim();
            let (property, value) = style
                .split_once(':')
                .ok_or_else(|| lossy("unsupported table style"))?;
            if property.trim() != "text-align" {
                return Err(lossy("unsupported table style"));
            }
            parse(value)
        })
        .transpose()?;
    let legacy = el.attr("align").map(parse).transpose()?;
    if style.is_some() && legacy.is_some() && style != legacy {
        return Err(lossy("conflicting table alignment attributes"));
    }
    Ok(style.or(legacy).unwrap_or(Alignment::None))
}

/// Protect entity-looking literals without needlessly changing ordinary query separators.
fn escape_entities(text: &str) -> String {
    let mut out = String::new();
    for (index, c) in text.char_indices() {
        if c == '&' {
            let tail = &text[index + 1..];
            let entity = tail.split_once(';').is_some_and(|(name, _)| {
                !name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '#')
            });
            if entity {
                out.push_str("&amp;");
                continue;
            }
        }
        out.push(c);
    }
    out
}

fn markdown_title(el: &Elem) -> CoreResult<String> {
    match el.attr("title") {
        None => Ok(String::new()),
        Some("") => Err(lossy("empty title attribute cannot be preserved")),
        Some(title) => Ok(format!(
            " \"{}\"",
            escape_entities(title)
                .replace('\\', "\\\\")
                .replace('"', "&quot;")
        )),
    }
}

fn require_empty(el: &Elem) -> CoreResult<()> {
    let empty = el.children.iter().all(|c| match c {
        Node::Text(t) => t.trim().is_empty(),
        Node::Elem(_) => false,
    });
    if empty {
        Ok(())
    } else {
        Err(lossy(format!("<{}> with child content", el.name)))
    }
}

fn pre_to_md(el: &Elem) -> CoreResult<String> {
    let mut code: Option<&Elem> = None;
    for child in &el.children {
        match child {
            Node::Text(t) if t.trim().is_empty() => {}
            Node::Text(t) => {
                return Err(lossy(format!(
                    "<pre> with bare text {:?} (expected a single <code> child)",
                    t.trim()
                )))
            }
            Node::Elem(c) if c.name == "code" && code.is_none() => code = Some(c),
            Node::Elem(c) => return Err(lossy(format!("<{}> inside <pre>", c.name))),
        }
    }
    let code = code.ok_or_else(|| lossy("<pre> without a <code> child"))?;
    code.check_attrs(&["class"])?;
    let lang = match code.attr("class") {
        None => String::new(),
        Some(c) => c
            .trim()
            .strip_prefix("language-")
            .ok_or_else(|| lossy(format!("class \"{c}\" on <code> (expected language-…)")))?
            .to_string(),
    };
    let mut content = String::new();
    for child in &code.children {
        match child {
            Node::Text(t) => content.push_str(t),
            Node::Elem(c) => return Err(lossy(format!("<{}> inside a code block", c.name))),
        }
    }
    if !content.is_empty() && !content.ends_with('\n') {
        content.push('\n');
    }
    // Fence must be longer than any backtick run in the content.
    let mut fence_len = 3;
    for run in content.split(|c| c != '`') {
        fence_len = fence_len.max(run.len() + 1);
    }
    let fence = "`".repeat(fence_len.max(3));
    Ok(format!("{fence}{lang}\n{content}{fence}"))
}

fn list_to_md(el: &Elem, start: Option<u64>, ctx: &mut MdCtx) -> CoreResult<String> {
    // Collect <li> children; anything else (bar whitespace) is out of subset.
    let mut items: Vec<&Elem> = Vec::new();
    for child in &el.children {
        match child {
            Node::Text(t) if t.trim().is_empty() => {}
            Node::Text(t) => {
                return Err(lossy(format!(
                    "bare text {:?} inside <{}>",
                    t.trim(),
                    el.name
                )))
            }
            Node::Elem(c) if c.name == "li" => items.push(c),
            Node::Elem(c) => return Err(lossy(format!("<{}> inside <{}>", c.name, el.name))),
        }
    }
    // Loose list: any item wraps its text in <p>.
    let loose = items.iter().any(|li| {
        li.children
            .iter()
            .any(|c| matches!(c, Node::Elem(e) if e.name == "p"))
    });
    let mut lines: Vec<String> = Vec::new();
    for (i, li) in items.iter().enumerate() {
        let (li, task) = task_body(li)?;
        let marker = match start {
            Some(s) => format!("{}. ", s + i as u64),
            None => "- ".to_string(),
        };
        let blocks = li_to_blocks(&li, ctx)?;
        let joiner = if loose { "\n\n" } else { "\n" };
        let body = format!("{task}{}", blocks.join(joiner));
        let indented = indent_continuation(&body, marker.len());
        lines.push(format!("{marker}{indented}"));
        if loose && i + 1 < items.len() {
            lines.push(String::new());
        }
    }
    Ok(lines.join("\n"))
}

/// A list item may mix leading inline content with nested blocks
/// (e.g. `<li>text<ul>…</ul></li>`); group consecutive inline nodes into
/// implicit paragraphs.
fn li_to_blocks(li: &Elem, ctx: &mut MdCtx) -> CoreResult<Vec<String>> {
    let mut blocks: Vec<String> = Vec::new();
    let mut inline_run: Vec<&Node> = Vec::new();
    let flush = |run: &mut Vec<&Node>, blocks: &mut Vec<String>| -> CoreResult<()> {
        if run.is_empty() {
            return Ok(());
        }
        let owned: Vec<&Node> = std::mem::take(run);
        let text = inline_refs_to_md(&owned, false)?;
        if !text.trim().is_empty() {
            blocks.push(finish_paragraph(&text));
        }
        Ok(())
    };
    for child in &li.children {
        let is_inline = match child {
            Node::Text(_) => true,
            Node::Elem(e) => INLINE_ELEMS.contains(&e.name.as_str()),
        };
        if is_inline {
            inline_run.push(child);
        } else {
            flush(&mut inline_run, &mut blocks)?;
            match child {
                Node::Elem(e) => blocks.append(&mut elem_to_blocks(e, ctx)?),
                Node::Text(_) => unreachable!("text is inline"),
            }
        }
    }
    flush(&mut inline_run, &mut blocks)?;
    if blocks.is_empty() {
        blocks.push(String::new());
    }
    Ok(blocks)
}

fn table_to_md(el: &Elem) -> CoreResult<String> {
    let mut header: Option<Vec<(String, Alignment)>> = None;
    let mut rows: Vec<Vec<(String, Alignment)>> = Vec::new();
    for child in &el.children {
        match child {
            Node::Text(t) if t.trim().is_empty() => {}
            Node::Text(t) => return Err(lossy(format!("bare text {:?} inside <table>", t.trim()))),
            Node::Elem(sec) if sec.name == "thead" => {
                sec.check_attrs(&[])?;
                if header.is_some() {
                    return Err(lossy("multiple <thead> in <table>"));
                }
                let trs = table_rows(sec, "th")?;
                match trs.len() {
                    1 => header = Some(trs.into_iter().next().unwrap()),
                    n => return Err(lossy(format!("<thead> with {n} rows (expected exactly 1)"))),
                }
            }
            Node::Elem(sec) if sec.name == "tbody" => {
                sec.check_attrs(&[])?;
                rows.append(&mut table_rows(sec, "td")?);
            }
            Node::Elem(sec) => return Err(lossy(format!("<{}> inside <table>", sec.name))),
        }
    }
    let header = header.ok_or_else(|| lossy("<table> without a <thead> header row"))?;
    let mut out = String::new();
    let cell_text = |row: &[(String, Alignment)]| {
        row.iter()
            .map(|(text, _)| text.as_str())
            .collect::<Vec<_>>()
            .join(" | ")
    };
    out.push_str(&format!("| {} |", cell_text(&header)));
    out.push('\n');
    if header.is_empty() {
        return Err(lossy("table has no columns"));
    }
    let separators = header
        .iter()
        .map(|(_, alignment)| match alignment {
            Alignment::None => " --- ",
            Alignment::Left => " :--- ",
            Alignment::Center => " :---: ",
            Alignment::Right => " ---: ",
        })
        .collect::<Vec<_>>()
        .join("|");
    out.push_str(&format!("|{separators}|"));
    for row in rows {
        if row.len() != header.len() || row.iter().zip(&header).any(|(cell, head)| cell.1 != head.1)
        {
            return Err(lossy(
                "table body alignment or column count disagrees with header",
            ));
        }
        out.push('\n');
        out.push_str(&format!("| {} |", cell_text(&row)));
    }
    Ok(out)
}

/// Rows of a `<thead>`/`<tbody>`, with cells of `cell_name`.
fn table_rows(section: &Elem, cell_name: &str) -> CoreResult<Vec<Vec<(String, Alignment)>>> {
    let mut rows = Vec::new();
    for child in &section.children {
        match child {
            Node::Text(t) if t.trim().is_empty() => {}
            Node::Text(t) => {
                return Err(lossy(format!(
                    "bare text {:?} inside <{}>",
                    t.trim(),
                    section.name
                )))
            }
            Node::Elem(tr) if tr.name == "tr" => {
                tr.check_attrs(&[])?;
                let mut cells = Vec::new();
                for cell in &tr.children {
                    match cell {
                        Node::Text(t) if t.trim().is_empty() => {}
                        Node::Text(t) => {
                            return Err(lossy(format!("bare text {:?} inside <tr>", t.trim())))
                        }
                        Node::Elem(c) if c.name == cell_name => {
                            if c.attr("colspan").is_some() || c.attr("rowspan").is_some() {
                                return Err(lossy(format!("colspan/rowspan on <{}>", c.name)));
                            }
                            let alignment = cell_alignment(c)?;
                            let text = inline_to_md(&c.children, true)?;
                            cells.push((text.trim().to_string(), alignment));
                        }
                        Node::Elem(c) => {
                            return Err(lossy(format!(
                                "<{}> inside <tr> (expected <{cell_name}>)",
                                c.name
                            )))
                        }
                    }
                }
                rows.push(cells);
            }
            Node::Elem(c) => return Err(lossy(format!("<{}> inside <{}>", c.name, section.name))),
        }
    }
    Ok(rows)
}

// --- inline emission ---

fn inline_to_md(nodes: &[Node], in_table: bool) -> CoreResult<String> {
    let refs: Vec<&Node> = nodes.iter().collect();
    inline_refs_to_md(&refs, in_table)
}

fn inline_refs_to_md(nodes: &[&Node], in_table: bool) -> CoreResult<String> {
    let mut out = String::new();
    for node in nodes {
        match node {
            Node::Text(t) => out.push_str(&escape_md(&collapse_ws(t), in_table)),
            Node::Elem(el) => out.push_str(&inline_elem_to_md(el, in_table)?),
        }
    }
    Ok(out)
}

fn inline_elem_to_md(el: &Elem, in_table: bool) -> CoreResult<String> {
    let wrap = |el: &Elem, delim: &str| -> CoreResult<String> {
        el.check_attrs(&[])?;
        let inner = inline_to_md(&el.children, in_table)?;
        let inner = inner.trim();
        if inner.is_empty() {
            return Ok(String::new()); // whitespace-only element: dropped
        }
        Ok(format!("{delim}{inner}{delim}"))
    };
    match el.name.as_str() {
        "em" | "i" => wrap(el, "*"),
        "strong" | "b" => wrap(el, "**"),
        "del" | "s" | "strike" => wrap(el, "~~"),
        "code" => {
            el.check_attrs(&[])?;
            let mut content = String::new();
            for child in &el.children {
                match child {
                    Node::Text(t) => content.push_str(t),
                    Node::Elem(c) => {
                        return Err(lossy(format!("<{}> inside inline <code>", c.name)))
                    }
                }
            }
            let content = collapse_ws(&content);
            if content.trim().is_empty() {
                return Ok(String::new());
            }
            Ok(code_span(&content))
        }
        "a" => {
            let epub_type = el.attr("epub:type").unwrap_or_default();
            if epub_type == "noteref" {
                el.check_attrs(&["epub:type", "href", "id", "role"])?;
                check_role(el, "doc-noteref")?;
                let name = noteref_label(el)?;
                return Ok(format!("[^{name}]"));
            }
            if !epub_type.is_empty() {
                return Err(lossy(format!("epub:type=\"{epub_type}\" on <a>")));
            }
            el.check_attrs(&["href", "title"])?;
            let href = el
                .attr("href")
                .ok_or_else(|| lossy("<a> without an href"))?;
            let inner = inline_to_md(&el.children, in_table)?;
            let plain = plain_text(&el.children);
            if el.attr("title").is_none() {
                if let Some(plain) = plain {
                    let candidate = if href == plain {
                        Some(href)
                    } else {
                        href.strip_prefix("mailto:")
                            .filter(|address| *address == plain)
                    };
                    if let Some(candidate) = candidate {
                        let md = format!("<{candidate}>");
                        // Ask CommonMark whether this really is an autolink.
                        if let Some(Event::Start(Tag::Link {
                            dest_url,
                            link_type,
                            ..
                        })) = Parser::new(&md).nth(1)
                        {
                            let destination = if link_type == LinkType::Email {
                                format!("mailto:{dest_url}")
                            } else {
                                dest_url.to_string()
                            };
                            if destination == href {
                                return Ok(md);
                            }
                        }
                    }
                }
            }
            Ok(format!(
                "[{}]({}{})",
                inner.trim(),
                link_dest(href),
                markdown_title(el)?
            ))
        }
        "img" => {
            el.check_attrs(&["src", "alt", "title"])?;
            let src = el.attr("src").ok_or_else(|| lossy("<img> without a src"))?;
            let alt = el.attr("alt").unwrap_or_default();
            require_empty(el)?;
            Ok(format!(
                "![{}]({}{})",
                escape_md(alt, in_table),
                link_dest(src),
                markdown_title(el)?
            ))
        }
        "br" => {
            el.check_attrs(&[])?;
            require_empty(el)?;
            if in_table {
                return Err(lossy("<br/> inside a table cell (no Markdown equivalent)"));
            }
            Ok("\\\n".to_string())
        }
        other if BLOCK_ELEMS.contains(&other) => {
            Err(lossy(format!("block element <{other}> in inline context")))
        }
        other => Err(lossy(format!("unsupported element <{other}>"))),
    }
}

/// Backtick-delimited code span, lengthening the delimiter past any backtick
/// run in the content.
fn code_span(content: &str) -> String {
    let mut delim_len = 1;
    for run in content.split(|c: char| c != '`') {
        delim_len = delim_len.max(run.len() + 1);
    }
    let delim = "`".repeat(delim_len);
    if content.starts_with('`') || content.ends_with('`') {
        format!("{delim} {content} {delim}")
    } else {
        format!("{delim}{content}{delim}")
    }
}

/// Link destination, angle-bracketed when it contains characters that would
/// break the inline form.
fn link_dest(url: &str) -> String {
    let url = escape_entities(url)
        .replace('\\', "\\\\")
        .replace('<', "&lt;")
        .replace('>', "&gt;");
    if url
        .chars()
        .any(|c| c.is_whitespace() || c == '(' || c == ')')
    {
        format!("<{url}>")
    } else {
        url.to_string()
    }
}

// --- text helpers ---

/// Collapse runs of whitespace to single spaces (inline context).
fn collapse_ws(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut last_ws = false;
    for ch in s.chars() {
        if ch.is_whitespace() {
            if !last_ws {
                out.push(' ');
            }
            last_ws = true;
        } else {
            out.push(ch);
            last_ws = false;
        }
    }
    out
}

/// Escape Markdown-significant characters in plain text.
fn escape_md(s: &str, in_table: bool) -> String {
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        match ch {
            '\\' | '`' | '*' | '_' | '[' | ']' | '<' | '~' | '&' => {
                out.push('\\');
                out.push(ch);
            }
            '|' if in_table => {
                out.push('\\');
                out.push('|');
            }
            _ => out.push(ch),
        }
    }
    out
}

/// Trim a paragraph and defuse line-leading characters that would re-parse
/// as block syntax (`#`, `>`, list markers, thematic breaks, setext lines).
fn finish_paragraph(text: &str) -> String {
    let lines: Vec<String> = text
        .trim()
        .lines()
        .map(|l| fix_line_start(l.trim_start()))
        .collect();
    lines.join("\n")
}

fn fix_line_start(line: &str) -> String {
    let Some(first) = line.chars().next() else {
        return line.to_string();
    };
    match first {
        '#' | '>' | '-' | '+' | '=' => format!("\\{line}"),
        c if c.is_ascii_digit() => {
            let digits: String = line.chars().take_while(|c| c.is_ascii_digit()).collect();
            let rest = &line[digits.len()..];
            if rest.starts_with('.') || rest.starts_with(')') {
                format!("{digits}\\{rest}")
            } else {
                line.to_string()
            }
        }
        _ => line.to_string(),
    }
}

/// Indent every line but the first by `n` spaces (list-item continuation).
fn indent_continuation(text: &str, n: usize) -> String {
    let pad = " ".repeat(n);
    let mut out = String::new();
    for (i, line) in text.lines().enumerate() {
        if i > 0 {
            out.push('\n');
            if !line.is_empty() {
                out.push_str(&pad);
            }
        }
        out.push_str(line);
    }
    out
}

/// Indent every line by `n` spaces.
fn indent_all(text: &str, n: usize) -> String {
    let pad = " ".repeat(n);
    text.lines()
        .map(|l| {
            if l.is_empty() {
                String::new()
            } else {
                format!("{pad}{l}")
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn to_md(xhtml: &str) -> String {
        xhtml_to_markdown(xhtml).unwrap()
    }

    fn detail(xhtml: &str) -> String {
        match xhtml_to_markdown(xhtml).unwrap_err() {
            CoreError::ConversionLossy { detail } => detail,
            other => panic!("wrong error kind: {other}"),
        }
    }

    // --- tolerated mappings (XHTML → Markdown only) ---

    #[test]
    fn maps_b_i_s_strike_to_md() {
        assert_eq!(
            to_md("<p><b>bold</b> <i>italic</i> <s>gone</s> <strike>also</strike></p>"),
            "**bold** *italic* ~~gone~~ ~~also~~\n"
        );
    }

    #[test]
    fn unwraps_div_with_block_children() {
        assert_eq!(
            to_md("<div>\n<p>one</p>\n<p>two</p>\n</div>"),
            "one\n\ntwo\n"
        );
    }

    #[test]
    fn unwraps_section() {
        assert_eq!(to_md("<section><h1>T</h1><p>x</p></section>"), "# T\n\nx\n");
    }

    #[test]
    fn div_with_inline_content_is_rejected() {
        assert!(detail("<div>bare text</div>").contains("<div>"));
        assert!(detail("<div><em>x</em></div>").contains("<em>"));
    }

    #[test]
    fn drops_whitespace_only_elements() {
        assert_eq!(to_md("<p>   </p><p>kept <em> </em>here</p>"), "kept here\n");
    }

    // --- subset violations name the offending construct ---

    #[test]
    fn rejects_inline_style() {
        assert!(detail("<p style=\"x\">y</p>").contains("style"));
    }

    #[test]
    fn rejects_unknown_elements() {
        assert!(detail("<video src=\"a.mp4\"/>").contains("<video>"));
        assert!(detail("<p><span>x</span></p>").contains("<span>"));
    }

    #[test]
    fn rejects_nested_tables() {
        let xhtml = "<table><thead><tr><th>h</th></tr></thead>\
                     <tbody><tr><td><table></table></td></tr></tbody></table>";
        assert!(detail(xhtml).contains("<table>"));
    }

    #[test]
    fn rejects_rowspan() {
        let xhtml = "<table><thead><tr><th rowspan=\"2\">h</th></tr></thead></table>";
        assert!(detail(xhtml).contains("rowspan"));
    }

    #[test]
    fn rejects_multiple_classes() {
        assert!(detail("<p class=\"a b\">x</p>").contains("multiple classes"));
    }

    #[test]
    fn rejects_malformed_xml() {
        assert!(xhtml_to_markdown("<p>unclosed").is_err());
        assert!(xhtml_to_markdown("<p><em>x</p></em>").is_err());
    }

    // --- class annotations ---

    #[test]
    fn class_round_trips_on_paragraph_and_heading() {
        let md = "{.notice}\n\nText.\n\n## Head {.fancy}\n";
        let xhtml = markdown_to_xhtml(md);
        assert!(xhtml.contains("<p class=\"notice\">Text.</p>"));
        assert!(xhtml.contains("<h2 class=\"fancy\">Head</h2>"));
        assert_eq!(to_md(&xhtml), md);
    }

    #[test]
    fn class_on_blockquote_round_trips() {
        let xhtml = "<blockquote class=\"aside\"><p>q</p></blockquote>";
        let md = to_md(xhtml);
        assert_eq!(md, "{.aside}\n\n> q\n");
        assert!(markdown_to_xhtml(&md).contains("<blockquote class=\"aside\">"));
    }

    // --- generated XHTML requirements ---

    #[test]
    fn escapes_raw_html_in_markdown() {
        let xhtml = markdown_to_xhtml("keep <script>alert(1)</script> safe\n");
        assert!(!xhtml.contains("<script>"));
        assert!(xhtml.contains("&lt;script&gt;"));
    }

    #[test]
    fn self_closes_void_elements() {
        let xhtml = markdown_to_xhtml("a\\\nb\n\n---\n\n![x](i.png)\n");
        assert!(xhtml.contains("<br/>"));
        assert!(xhtml.contains("<hr/>"));
        assert!(xhtml.contains("<img src=\"i.png\" alt=\"x\"/>"));
    }

    #[test]
    fn ordered_list_start_round_trips() {
        let md = "3. three\n4. four\n";
        let xhtml = markdown_to_xhtml(md);
        assert!(xhtml.contains("<ol start=\"3\">"));
        assert_eq!(to_md(&xhtml), md);
    }

    #[test]
    fn loose_lists_round_trip() {
        let md = "- one\n\n- two\n";
        let xhtml = markdown_to_xhtml(md);
        assert!(xhtml.contains("<li><p>one</p>"));
        assert_eq!(to_md(&xhtml), md);
    }

    #[test]
    fn resolves_entities_and_utf8() {
        assert_eq!(
            to_md("<p>caf&#xE9; &amp; ünïcode ✓</p>"),
            "café \\& ünïcode ✓\n"
        );
    }

    #[test]
    fn noteref_outside_generated_scheme_is_rejected() {
        assert!(
            detail("<p>x<a epub:type=\"noteref\" href=\"#other\">1</a></p>").contains("scheme")
        );
    }

    #[test]
    fn footnote_aside_without_id_is_rejected() {
        assert!(detail("<aside epub:type=\"footnote\"><p>x</p></aside>").contains("without an id"));
    }
    #[test]
    fn empty_paragraph_variants_and_raw_html_boundary() {
        for br in ["<br>", "<br/>", "<br />"] {
            assert_eq!(markdown_to_xhtml(br), "<p><br/></p>\n");
        }
        for md in [
            "before <br /> after",
            "<br class=\"custom\"/>",
            "<br />\ntext",
            "`<br />`",
        ] {
            assert!(!markdown_to_xhtml(md).contains("<p><br/></p>"), "{md}");
        }
        let md = "> <br />\n";
        assert_eq!(to_md(&markdown_to_xhtml(md)), md);
    }

    #[test]
    fn unknown_and_escaped_alert_markers_remain_plain() {
        for md in ["> [!UNKNOWN]\n> Body.", "> \\[!NOTE]\n> Body."] {
            let xhtml = markdown_to_xhtml(md);
            assert!(xhtml.contains("<blockquote>"));
            assert!(!xhtml.contains("<aside"));
            let canonical = to_md(&xhtml);
            assert!(!markdown_to_xhtml(&canonical).contains("<aside"));
            assert_eq!(to_md(&markdown_to_xhtml(&canonical)), canonical);
        }
        let md = "> [!NOTE]\n> Outer.\n>\n> > [!TIP]\n> > Inner.\n";
        assert_eq!(to_md(&markdown_to_xhtml(md)), md);
    }

    #[test]
    fn legacy_footnotes_and_optional_alert_title_are_supported() {
        let old = "<p>Ref<a epub:type=\"noteref\" href=\"#fn-a\">1</a></p><aside epub:type=\"footnote\" id=\"fn-a\"><p>Note.</p></aside>";
        assert_eq!(to_md(old), "Ref[^a]\n\n[^a]: Note.\n");
        let alert = "<aside class=\"alert alert-note\" epub:type=\"notice\" role=\"note\"><p>Body.</p></aside>";
        assert_eq!(to_md(alert), "> [!NOTE]\n> Body.\n");
    }

    #[test]
    fn derived_content_must_match_exactly() {
        let valid = markdown_to_xhtml("Ref[^a] and again[^a].\n\n[^a]: Note.\n");
        for invalid in [
            valid.replace("fnref-a-2", "fnref-a-3"),
            valid.replace("<sup>1</sup>", "<sup class=\"custom\">1</sup>"),
            valid.replace("doc-noteref", "button"),
            valid.replace("doc-footnote", "note"),
            valid.replace("href=\"#fnref-a\"", "href=\"#other\""),
        ] {
            assert!(xhtml_to_markdown(&invalid).is_err(), "{invalid}");
        }
        for invalid in [
            "<aside class=\"alert alert-note\" epub:type=\"notice\" role=\"doc-tip\"><p>Body.</p></aside>",
            "<ul><li class=\"task-item task-open\"><span class=\"task-marker\" role=\"img\" aria-label=\"Completed\">☐</span> Task</li></ul>",
            "<ul><li><span class=\"task-marker\" role=\"img\" aria-label=\"Completed\">☑</span> Task</li></ul>",
        ] {
            assert!(xhtml_to_markdown(invalid).is_err(), "{invalid}");
        }
    }

    #[test]
    fn table_alignment_aliases_and_styles_are_narrow() {
        let table = "<table><thead><tr><th scope=\"col\" style=\" text-align : left ; \">H</th></tr></thead><tbody><tr><td align=\"left\">B</td></tr></tbody></table>";
        assert_eq!(to_md(table), "| H |\n| :--- |\n| B |\n");
        for invalid in [
            table.replace("scope=\"col\"", "scope=\"row\""),
            table.replace("text-align : left ;", "text-align: left; text-align: left;"),
            table.replace(
                "align=\"left\"",
                "align=\"left\" style=\"text-align: right\"",
            ),
            table.replace("align=\"left\"", ""),
        ] {
            assert!(xhtml_to_markdown(&invalid).is_err(), "{invalid}");
        }
    }

    #[test]
    fn titles_and_urls_preserve_entities_quotes_and_percent_encoding() {
        let xhtml = "<p><a href=\"../a%20b.xhtml?q=1&amp;x=&amp;copy;#here\" title=\"A &quot;quote&quot; &amp;copy;\">Link</a> <img src=\"a(b).png\" alt=\"A [cover]\" title=\"Cover &quot;title&quot;\"/></p>\n";
        assert_eq!(markdown_to_xhtml(&to_md(xhtml)), xhtml);
        let titled =
            "<p><a href=\"https://example.com\" title=\"Title\">https://example.com</a></p>";
        assert!(to_md(titled).starts_with("[https://example.com]("));
        let md = "<https://example.com/?a=1&b=2>\n";
        assert_eq!(to_md(&markdown_to_xhtml(md)), md);
    }

    #[test]
    fn xml_illegal_characters_are_removed_in_all_contexts() {
        let md = "# A\u{1} {#he\u{2}ad}\n\nTe\u{b}xt [li\u{c}nk](a\u{e}.xhtml \"ti\u{ffff}tle\")\n\n`co\u{1f}de`\n";
        let xhtml = markdown_to_xhtml(md);
        assert!(xhtml.chars().all(xml_char));
        assert!(xhtml.contains("id=\"head\""));
        assert!(xhtml.contains("href=\"a.xhtml\" title=\"title\""));
        assert!(xhtml.contains("<code>code</code>"));
        assert!(parse_tree(&xhtml).is_ok());
    }

    #[test]
    fn duplicate_heading_ids_keep_first_and_do_not_shadow_footnotes() {
        let md = include_str!("../tests/fixtures/roundtrip/write/016-heading-id-duplicate.md");
        let expected =
            include_str!("../tests/fixtures/roundtrip/write/016-heading-id-duplicate.xhtml");
        assert_eq!(markdown_to_xhtml(md), expected);
        assert_eq!(markdown_to_xhtml(&to_md(expected)), expected);
        let xhtml =
            markdown_to_xhtml("# Ref {#fnref-a}\n\n# Note {#fn-a}\n\nRef[^a].\n\n[^a]: Note.\n");
        assert!(xhtml.starts_with("<h1>Ref</h1>\n<h1>Note</h1>"));
        assert!(xhtml_to_markdown(&xhtml).is_ok());
    }
    #[test]
    fn email_shaped_relative_link_is_not_promoted_to_mailto() {
        let xhtml = "<p><a href=\"a@example.com\">a@example.com</a></p>\n";
        assert_eq!(markdown_to_xhtml(&to_md(xhtml)), xhtml);
    }

    #[test]
    fn colliding_footnote_reference_ids_keep_first_and_force_source_mode() {
        let xhtml = markdown_to_xhtml(
            "A[^note] B[^note] C[^note-2].\n\n[^note]: First.\n\n[^note-2]: Second.\n",
        );
        assert_eq!(xhtml.matches("id=\"fnref-note-2\"").count(), 1);
        assert!(xhtml_to_markdown(&xhtml).is_err());
    }

    #[test]
    fn heading_attributes_and_noteref_labels_must_survive_regeneration() {
        for id in ["a.b", "a#b", "a&b", "a:b", "a-b", "a_b", "é"] {
            let xhtml = format!("<h2 id=\"{}\">Title</h2>\n", esc_attr(id));
            assert_eq!(markdown_to_xhtml(&to_md(&xhtml)), xhtml);
        }
        let mismatched = "<p>Ref<a epub:type=\"noteref\" href=\"#fn-a\">1</a></p><aside epub:type=\"footnote\" id=\"fn-A\"><p>Note.</p></aside>";
        assert!(xhtml_to_markdown(mismatched).is_err());
    }
}
