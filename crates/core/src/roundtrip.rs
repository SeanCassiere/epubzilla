//! Markdown ↔ XHTML round-trip conversion. Contractual:
//! docs/contracts/content-roundtrip.md — the conformance fixtures in
//! `tests/fixtures/roundtrip/` are the executable form of that contract.
//!
//! Scope: **body content only**. The XHTML document frame (`<html>`,
//! `<head>`, charset, CSS links) is owned by the core elsewhere and is never
//! seen by this module — both functions operate on the children of `<body>`.
//! When footnotes are present the produced fragment uses the `epub:` prefix;
//! the caller must ensure `xmlns:epub="http://www.idpf.org/2007/ops"` is
//! declared on the document element.
//!
//! - [`markdown_to_xhtml`] always succeeds (CommonMark + GFM tables and
//!   strikethrough + footnotes; raw HTML in the Markdown is escaped as text
//!   so the output is always XML-well-formed).
//! - [`xhtml_to_markdown`] succeeds only for the supported subset; anything
//!   else returns [`CoreError::ConversionLossy`] naming the offending
//!   construct. Conversion is never lossy.
//!
//! Class annotations: a paragraph consisting solely of `{.classname}`
//! attaches that class to the following block; headings take the Pandoc
//! trailing form (`## Title {.classname}`).

use pulldown_cmark::{CodeBlockKind, Event, Options, Parser, Tag, TagEnd};
use quick_xml::events::Event as XmlEvent;
use quick_xml::Reader;

use crate::error::{CoreError, CoreResult};

// ---------------------------------------------------------------------------
// Markdown → XHTML
// ---------------------------------------------------------------------------

/// Convert Markdown (CommonMark + GFM tables/strikethrough + footnotes) to an
/// XML-well-formed XHTML body fragment. Always succeeds.
pub fn markdown_to_xhtml(md: &str) -> String {
    let mut options = Options::empty();
    options.insert(Options::ENABLE_TABLES);
    options.insert(Options::ENABLE_STRIKETHROUGH);
    options.insert(Options::ENABLE_FOOTNOTES);
    options.insert(Options::ENABLE_HEADING_ATTRIBUTES);
    let parser = Parser::new_ext(md, options);

    let mut w = XhtmlWriter::default();
    for event in parser {
        w.event(event);
    }
    w.finish()
}

#[derive(Default)]
struct XhtmlWriter {
    out: String,
    /// Buffer for the paragraph currently being written (paragraphs are
    /// buffered so `{.classname}` annotation paragraphs can be intercepted).
    para: Option<String>,
    /// Buffer for the footnote definition currently being written.
    footnote: Option<(String, String)>,
    /// `(src, alt)` while inside an image (children render to plain alt text).
    image: Option<(String, String)>,
    /// Class waiting to be attached to the next block element.
    pending_class: Option<String>,
    /// Completed footnote definitions, in source order.
    defs: Vec<(String, String)>,
    /// Footnote names in order of first reference (defines numbering).
    ref_order: Vec<String>,
    in_table_head: bool,
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
        if let Some((_, alt)) = self.image.as_mut() {
            match event {
                Event::Text(t) | Event::Code(t) => alt.push_str(&t),
                Event::SoftBreak | Event::HardBreak => alt.push(' '),
                Event::End(TagEnd::Image) => {
                    let (src, alt) = self.image.take().expect("image state");
                    let tag = format!(
                        "<img src=\"{}\" alt=\"{}\"/>",
                        esc_attr(&src),
                        esc_attr(&alt)
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
            Event::Html(t) | Event::InlineHtml(t) => {
                let escaped = esc_text(&t);
                self.sink().push_str(&escaped);
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
                let anchor = format!(
                    "<a epub:type=\"noteref\" href=\"#fn-{}\">{n}</a>",
                    esc_attr(&name)
                );
                self.sink().push_str(&anchor);
            }
            Event::TaskListMarker(_) | Event::InlineMath(_) | Event::DisplayMath(_) => {}
        }
    }

    fn start(&mut self, tag: Tag<'_>) {
        match tag {
            Tag::Paragraph => self.para = Some(String::new()),
            Tag::Heading { level, classes, .. } => {
                let cls = if classes.is_empty() {
                    self.class_attr()
                } else {
                    self.pending_class = None;
                    format!(" class=\"{}\"", esc_attr(&classes.join(" ")))
                };
                let open = format!("<h{}{cls}>", level as usize);
                self.sink().push_str(&open);
            }
            Tag::BlockQuote(_) => {
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
            Tag::Table(_) => {
                let cls = self.class_attr();
                let open = format!("<table{cls}>\n");
                self.sink().push_str(&open);
            }
            Tag::TableHead => {
                self.in_table_head = true;
                self.sink().push_str("<thead>\n<tr>\n");
            }
            Tag::TableRow => self.sink().push_str("<tr>\n"),
            Tag::TableCell => {
                let cell = if self.in_table_head { "<th>" } else { "<td>" };
                self.sink().push_str(cell);
            }
            Tag::Emphasis => self.sink().push_str("<em>"),
            Tag::Strong => self.sink().push_str("<strong>"),
            Tag::Strikethrough => self.sink().push_str("<del>"),
            Tag::Link { dest_url, .. } => {
                let open = format!("<a href=\"{}\">", esc_attr(&dest_url));
                self.sink().push_str(&open);
            }
            Tag::Image { dest_url, .. } => {
                self.image = Some((dest_url.to_string(), String::new()));
            }
            _ => {}
        }
    }

    fn end(&mut self, tag: TagEnd) {
        match tag {
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
            TagEnd::BlockQuote(_) => self.sink().push_str("</blockquote>\n"),
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
            self.out.push_str(&format!(
                "<aside epub:type=\"footnote\" id=\"fn-{}\">\n{body}</aside>\n",
                esc_attr(&name)
            ));
        }
        self.out
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
            _ => out.push(ch),
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
            _ => out.push(ch),
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
    let mut ctx = MdCtx::default();
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

enum Node {
    Elem(Elem),
    Text(String),
}

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
            let text = inline_to_md(&el.children, false)?;
            if text.trim().is_empty() {
                return Ok(Vec::new()); // whitespace-only element: dropped
            }
            Ok(annotated(class, finish_paragraph(&text)))
        }
        "h1" | "h2" | "h3" | "h4" | "h5" | "h6" => {
            el.check_attrs(&["class"])?;
            let class = el.single_class()?;
            let level = el.name[1..].parse::<usize>().unwrap_or(1);
            let text = inline_to_md(&el.children, false)?;
            let mut line = format!("{} {}", "#".repeat(level), text.trim());
            if let Some(c) = class {
                line.push_str(&format!(" {{.{c}}}"));
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
            let epub_type = el.attr("epub:type").unwrap_or_default();
            if !epub_type.split_whitespace().any(|t| t == "footnote") {
                return Err(lossy(format!(
                    "<aside epub:type=\"{epub_type}\"> (only footnote asides are supported)"
                )));
            }
            el.check_attrs(&["epub:type", "id"])?;
            let id = el
                .attr("id")
                .ok_or_else(|| lossy("footnote <aside> without an id"))?;
            let name = id.strip_prefix("fn-").unwrap_or(id);
            let blocks = nodes_to_blocks(&el.children, ctx)?;
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
        li.check_attrs(&[])?;
        let marker = match start {
            Some(s) => format!("{}. ", s + i as u64),
            None => "- ".to_string(),
        };
        let blocks = li_to_blocks(li, ctx)?;
        let joiner = if loose { "\n\n" } else { "\n" };
        let body = blocks.join(joiner);
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
    let mut header: Option<Vec<String>> = None;
    let mut rows: Vec<Vec<String>> = Vec::new();
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
    out.push_str(&format!("| {} |", header.join(" | ")));
    out.push('\n');
    out.push_str(&format!("|{}|", vec![" --- "; header.len()].join("|")));
    for row in rows {
        out.push('\n');
        out.push_str(&format!("| {} |", row.join(" | ")));
    }
    Ok(out)
}

/// Rows of a `<thead>`/`<tbody>`, with cells of `cell_name`.
fn table_rows(section: &Elem, cell_name: &str) -> CoreResult<Vec<Vec<String>>> {
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
                            c.check_attrs(&[])?;
                            let text = inline_to_md(&c.children, true)?;
                            cells.push(text.trim().to_string());
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
            if epub_type.split_whitespace().any(|t| t == "noteref") {
                el.check_attrs(&["epub:type", "href", "id"])?;
                let href = el
                    .attr("href")
                    .ok_or_else(|| lossy("noteref <a> without an href"))?;
                let target = href.strip_prefix('#').ok_or_else(|| {
                    lossy(format!(
                        "noteref href \"{href}\" is not a fragment reference"
                    ))
                })?;
                let name = target.strip_prefix("fn-").unwrap_or(target);
                return Ok(format!("[^{name}]"));
            }
            if !epub_type.is_empty() {
                return Err(lossy(format!("epub:type=\"{epub_type}\" on <a>")));
            }
            el.check_attrs(&["href"])?;
            let href = el
                .attr("href")
                .ok_or_else(|| lossy("<a> without an href"))?;
            let inner = inline_to_md(&el.children, in_table)?;
            Ok(format!("[{}]({})", inner.trim(), link_dest(href)))
        }
        "img" => {
            el.check_attrs(&["src", "alt"])?;
            let src = el.attr("src").ok_or_else(|| lossy("<img> without a src"))?;
            let alt = el.attr("alt").unwrap_or_default();
            require_empty(el)?;
            Ok(format!(
                "![{}]({})",
                escape_md(alt, in_table),
                link_dest(src)
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
    fn noteref_without_fn_prefix_uses_raw_id() {
        assert_eq!(
            to_md("<p>x<a epub:type=\"noteref\" href=\"#other\">1</a></p>"),
            "x[^other]\n"
        );
    }

    #[test]
    fn footnote_aside_without_id_is_rejected() {
        assert!(detail("<aside epub:type=\"footnote\"><p>x</p></aside>").contains("without an id"));
    }
}
