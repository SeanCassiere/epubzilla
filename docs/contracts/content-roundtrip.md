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

Markdown flavor: **CommonMark + GFM tables and strikethrough**. Footnotes via
Pandoc-style `[^1]` syntax.

| Markdown | XHTML |
|---|---|
| `#`–`######` headings | `<h1>`–`<h6>` |
| Paragraphs | `<p>` |
| `*em*`, `**strong**`, `~~del~~` | `<em>`, `<strong>`, `<del>` |
| `` `code` ``, fenced blocks | `<code>`, `<pre><code class="language-…">` |
| Ordered/unordered lists (nested) | `<ol>`/`<ul>`/`<li>` |
| Blockquotes | `<blockquote>` |
| Links `[t](href)` | `<a href>` (internal hrefs are zip-relative resource paths) |
| Images `![alt](path)` | `<img src alt>` (src must be a manifest resource) |
| `---` | `<hr/>` |
| GFM tables | `<table>/<thead>/<tbody>/<tr>/<th>/<td>` |
| Footnotes `[^1]` | `<aside epub:type="footnote">` + `<a epub:type="noteref">` |
| Hard line break | `<br/>` |

Additionally tolerated on XHTML→Markdown (mapped, not authored):
`<b>`→`**`, `<i>`→`*`, `<s>/<strike>`→`~~`, `<div>` with only block children →
unwrapped, attribute-free `<section>` → unwrapped, whitespace-only elements →
dropped. (A *single top-level* `<section>` wrapper is frame, not content —
see "Document frame" below.)

## Outside the subset (source-mode triggers)

Any of the following in the body forces `format: Xhtml`:

- Inline `style` attributes, `<style>`, or `class` attributes that affect layout
  (classes are preserved if the element itself is otherwise in-subset — see below)
- `<svg>`, `<math>`, `<video>`, `<audio>`, `<iframe>`, `<script>`
- Definition lists, `<figure>/<figcaption>`, ruby text
- Nested tables, tables with `colspan`/`rowspan`
- Any element or attribute not listed in the tables above

**Class preservation:** a single `class` attribute on an in-subset block element
does not force source mode; it is carried through the round-trip via an
attribute annotation (`{.classname}` Pandoc-style) so book CSS keeps working.

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
footnotes are used, and pass the native validator (ADR-0003).

## Conformance fixtures

`core/tests/fixtures/roundtrip/` holds paired `.md`/`.xhtml` files. CI asserts
both directions for every pair. Adding a capability to the subset requires
adding fixtures in the same PR — the fixture set *is* the executable form of
this contract.
