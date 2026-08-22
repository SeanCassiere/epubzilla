# ADR-0003: Native validation subset in-app; epubcheck in CI

Status: Accepted · 2026-08-23

## Context

`epubcheck` is the authoritative EPUB validator but requires a JVM, which we
do not want to ship inside a desktop app.

## Decision

- The core implements a native Rust validation subset (`validate` command):
  container structure, manifest/spine/nav consistency, XML well-formedness,
  required metadata, resource reference resolution.
- Real `epubcheck` runs in CI against generated fixtures and golden books;
  "epubcheck-clean output" is a release gate, not a runtime feature.
- EPUB 3 is the write target. EPUB 2 books can be opened read-only
  (metadata/TOC via OPF + NCX); saving upgrades is out of scope for v1.

## Consequences

- In-app validation can miss what epubcheck would catch; CI coverage of the
  writer paths is the backstop.
- No JVM dependency for users.
