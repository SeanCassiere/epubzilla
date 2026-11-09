# Contract: Markdown ↔ XHTML Round-Trip

Status: **Accepted** · Changes via PR only.

Chapters are stored in the EPUB as XHTML. The editor authors in Markdown
(WYSIWYG or source — ADR-0004). This contract defines exactly which content
round-trips, and what happens when it doesn't.

## The rule

- **Markdown → XHTML** (on write) is always possible and always used.
- **XHTML → Markdown** (on read) is attempted only if the chapter body uses
  nothing outside the *supported subset* below. Otherwise `read_chapter`
  returns `format: Xhtml` and the editor opens in source mode. Never convert
  lossily.
- Round-trip guarantee: for any chapter within the subset,
  `to_markdown(to_xhtml(md))` is semantically identical (same rendered DOM),
  though not necessarily byte-identical.

## Supported subset

Markdown flavor: **CommonMark + GFM tables (including alignment),
strikethrough, task lists, footnotes, GitHub alerts, and bracketed autolinks**.
Headings support Pandoc attributes `{#id .class}`; other supported blocks
use the existing `{.class}` annotation paragraph.

| Markdown | XHTML |
|---|---|
| `#`–`######` headings, optional `{#id .class}` | `<h1>`–`<h6>`, optional `id` and single `class` |
| Paragraphs | `<p>` |
| `*em*`, `**strong**`, `~~del~~` | `<em>`, `<strong>`, `<del>` |
| `` `code` ``, fenced blocks | `<code>`, `<pre><code class="language-…">` |
| Ordered/unordered lists (nested) | `<ol>`/`<ul>`/`<li>` |
| Blockquotes | `<blockquote>` |
| Links `[t](href "title")` | `<a href title>` (title optional; hrefs remain chapter-relative and verbatim) |
| Autolinks `<https://…>`, `<a@b.c>` | `<a href>` (email destinations use `mailto:`) |
| Images `![alt](path "title")` | `<img src alt title/>` (title optional; src must be a manifest resource) |
| `---` | `<hr/>` |
| GFM tables, with `:---` / `:---:` / `---:` | `<table>/<thead>/<tbody>/<tr>/<th>/<td>`; `scope="col"` on headers and `style="text-align: left\|center\|right"` on aligned cells |
| Footnotes `[^1]` (including multiple paragraphs/lists) | `<aside epub:type="footnote" role="doc-footnote" id="fn-label">` + numbered `<a epub:type="noteref" role="doc-noteref" id="fnref-label" href="#fn-label"><sup>1</sup></a>` |
| GitHub alerts `> [!NOTE]` (also TIP, IMPORTANT, WARNING, CAUTION) | Exact generated `<aside class="alert alert-kind" epub:type="…" role="…">`, derived title paragraph, supported body blocks |
| Task items `- [x]` / `- [ ]` | `<li class="task-item task-done\|task-open">` and a static `<span class="task-marker" role="img" aria-label="Completed\|Not completed">☑\|☐</span>`; no form controls |
| Standalone `<br>`, `<br/>`, or `<br />` block | `<p><br/></p>` (read back as `<br />`) |
| Hard line break | `<br/>` |

Additionally tolerated on XHTML→Markdown (mapped, not authored):
`<b>`→`**`, `<i>`→`*`, `<s>/<strike>`→`~~`, `<div>` with only block children →
unwrapped, attribute-free `<section>` → unwrapped, whitespace-only elements →
dropped. (A *single top-level* `<section>` wrapper is frame, not content —
see "Document frame" below.)

## Outside the subset (source-mode triggers)

Any of the following in the body forces `format: Xhtml`:

- Inline `style` attributes except the table-cell carve-out below, `<style>`,
  or unsupported `class` attributes (single supported block classes are
  preserved — see below)
- `<svg>`, `<math>`, `<video>`, `<audio>`, `<iframe>`, `<script>`
- Definition lists, `<figure>/<figcaption>`, ruby text
- Nested tables, tables with `colspan`/`rowspan`
- Any element or attribute not listed in the tables above

**Class preservation:** a single `class` attribute on an in-subset block element
does not force source mode; it is carried through the round-trip via an
attribute annotation (`{.classname}` Pandoc-style) so book CSS keeps working.

**Heading IDs:** plain headings remain id-less. The writer keeps the first
occurrence of a duplicate heading ID and omits it on later headings. Generated
footnote IDs are reserved, so headings cannot shadow them. Duplicate IDs or
IDs that cannot be expressed as a Markdown attribute token force source mode
on read.

**Table alignment:** the only supported inline style is a single
`text-align: left`, `center`, or `right` declaration on `th`/`td`, allowing
surrounding whitespace and one trailing semicolon. Legacy `align` attributes
are accepted on read; the writer always uses `style`. Headers may have
`scope="col"`. Every body cell must agree with its header, including absence
of alignment; conflicting attributes, other declarations, irregular rows,
and other scopes force source mode.

**Derived content:** only deterministically regenerated content may be omitted
on read. Alert signatures must match this table exactly; an optional leading
`<p class="alert-title">` must contain precisely the default title:

| Kind / class | `epub:type` | `role` | Default title |
|---|---|---|---|
| NOTE / `alert alert-note` | `notice` | `note` | Note |
| TIP / `alert alert-tip` | `tip` | `doc-tip` | Tip |
| IMPORTANT / `alert alert-important` | `notice` | `note` | Important |
| WARNING / `alert alert-warning` | `notice` | `doc-notice` | Warning |
| CAUTION / `alert alert-caution` | `notice` | `doc-notice` | Caution |

Custom titles, other asides, and altered task marker signatures force source
mode. Escaped or unknown alert markers remain plain blockquote text. Loose
task items place the marker at the start of their first paragraph.

Footnote reference IDs are `fnref-label`, `fnref-label-2`, etc.; their
numbers follow first-reference order. Note IDs are `fn-label`. Legacy
references without `role`, `id`, or `sup` remain readable when their target
and number match the generated scheme. Custom IDs, unmatched targets,
non-derived reference text, or conflicting roles force source mode. Each note
ends with a paragraph of `<a role="doc-backlink" href="#fnref-…">↩</a>`
links, one per reference; only this exact generated backlink group may be
omitted on read. If labels such as `note` and `note-2` collide with
occurrence suffixes, the writer keeps the first reference ID and omits the
colliding ID and its backlink. Such ambiguous graphs force source mode.

**Known divergences:** bare URLs remain literal in the core; remark-gfm may
autolink them in the rich editor. Use bracketed autolinks for portable behavior.
Read-side punctuation escaping remains conservative (including literal
ampersands, underscores, and less-than signs) to retain existing fixture
compatibility. All raw HTML is escaped except the standalone empty-paragraph
convention above. Titles are preserved, but an explicitly empty XHTML title
attribute forces source mode because the Markdown parser cannot distinguish
it from an absent title.

## Document frame

The XHTML `<head>` (title, CSS links, charset) is **not** part of editable
content. The core owns it: it is preserved verbatim on round-trip, and the
editor sees/edits only the `<body>` children.

Attributes on `<body>` itself (e.g. pandoc's `epub:type="bodymatter"`) are
part of the frame and are preserved verbatim.

**Single `<section>` wrapper:** when the `<body>` content consists of exactly
one top-level `<section>` element (plus optional surrounding whitespace), that
`<section>` — *regardless of its attributes*, e.g. pandoc's
`<section id="…" class="level1">` — is treated as part of the document frame:
its open/close tags are preserved verbatim like `<head>`, and only its
children are round-tripped. Reads convert the wrapper's children to Markdown;
writes splice the regenerated XHTML back inside the same wrapper. Nested
sections, or multiple sibling sections, are **content** and keep the rules
above (attribute-free → unwrapped; any attribute → out of subset).

## Generated XHTML requirements

Serialized chapters must be valid EPUB 3 XHTML content documents:
`application/xhtml+xml`, XML well-formed, `epub:` namespace declared when
footnotes or alerts are used, and pass the native validator (ADR-0003).
XML-illegal control characters are removed before parsing Markdown. Native
validation reports a warning for a relative anchor target whose path does not
resolve to a manifest item; query strings and fragments are excluded from
that lookup. External and root-relative URLs are outside that check.

## Conformance fixtures

`core/tests/fixtures/roundtrip/` holds paired `.md`/`.xhtml` files. CI asserts
both directions for every pair. Adding a capability to the subset requires
adding fixtures in the same PR — the fixture set *is* the executable form of
this contract.

The duplicate-heading-ID write policy has a separate input/output pair in
`roundtrip/write/` because discarding duplicate IDs intentionally changes the
authored Markdown. Session-level fixtures write a book containing every new
construct, validate it natively, save/reopen it, and export
`target/epubcheck-fixtures/conversion-standard.epub` for CI's epubcheck job.
