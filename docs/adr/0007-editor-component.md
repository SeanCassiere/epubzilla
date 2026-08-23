# ADR-0007: Milkdown for WYSIWYG; CodeMirror 6 for source modes

Status: Accepted · 2026-08-23 · Settles the open question in ADR-0004

## Context

M3 needs the editor component: WYSIWYG and raw-Markdown views over one
document model (ADR-0004), against the Markdown subset contract
(`docs/contracts/content-roundtrip.md`). Candidates: Tiptap and Milkdown,
both ProseMirror-based.

## Decision

- **Milkdown** (`@milkdown/*`, with the GFM plugin) for the WYSIWYG mode.
- **CodeMirror 6** for the raw-Markdown mode and for the XHTML source mode
  that out-of-subset chapters fall back to.
- The editor buffer's interchange format is always the Markdown string (or
  XHTML string in source mode); the authoritative Markdown↔XHTML conversion
  stays in the Rust core (`write_chapter` / `read_chapter`) — the editor
  never serializes to XHTML itself.

## Rationale

- Milkdown is markdown-native: every editor state has an exact Markdown
  equivalent (remark-based model), so WYSIWYG editing cannot drift outside
  what the round-trip contract can express. Tiptap's model is rich-text-first
  with Markdown only as a lossy serialization layer — the mismatch would
  surface exactly at our contract boundary.
- GFM (tables, strikethrough) is first-party in Milkdown; both are MIT-core,
  but Tiptap's ecosystem gates parts behind paid tiers.
- Cost accepted: Milkdown needs more UI assembly than Tiptap's batteries-
  included kits; acceptable since our chrome is minimal and the raw-Markdown
  CodeMirror mode is the escape hatch for anything WYSIWYG doesn't cover
  (e.g. footnote syntax can be edited as literal `[^1]` text).

## Consequences

- Footnotes and class annotations (`{.class}`) may render as literal syntax
  in WYSIWYG rather than rich widgets in v1; they remain editable and
  round-trip via the core.
- If Milkdown proves unmaintained or blocking, the CodeMirror Markdown mode
  is the fallback editing surface while a replacement is evaluated.
