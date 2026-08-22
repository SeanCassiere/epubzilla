# ADR-0004: Markdown-first authoring with WYSIWYG, XHTML source-mode fallback

Status: Accepted · 2026-08-23

## Context

EPUB chapters are XHTML. Authors want either WYSIWYG or Markdown; imported
books contain arbitrary XHTML that may not map to Markdown.

## Decision

- Markdown (CommonMark + GFM tables/strikethrough + footnotes) is the
  authoring format; conversion rules are contractual — see
  `docs/contracts/content-roundtrip.md`.
- The editor is a ProseMirror-based component (Milkdown or Tiptap — final pick
  is an M3 spike) offering WYSIWYG and raw-Markdown views over one document
  model; CodeMirror provides XHTML source mode.
- Chapters outside the round-trip subset open in source mode. Conversion is
  never lossy.

## Consequences

- The supported subset must be explicit and fixture-tested (it is — see the
  round-trip contract's conformance fixtures).
- Type/shape of editor documents never crosses the IPC boundary; only
  `ChapterContent` does.
