# epubzilla

An application for previewing, creating, and editing EPUB files — fast.

## Goals

- **Preview**: open and read EPUB files with fast rendering.
- **Create**: scaffold new EPUBs with title pages, metadata, and chapters.
- **Edit**: modify chapter content via a WYSIWYG or Markdown-based editor.
- **Performance**: reading, editing, and creation should feel instant, leveraging a performant core language and/or existing libraries.

## Status

**M0 (core engine) complete.** The UI-free Rust core (`crates/core`) opens,
models, edits, and writes EPUBs per the contracts in `docs/contracts/`, with
epubcheck-clean output and performance budgets enforced in CI. A CLI harness
(`crates/cli`) exercises the whole surface:

```sh
# Metadata, spine, and table of contents
epubzilla-cli inspect book.epub

# Chapter content — Markdown when in-subset, XHTML otherwise.
# <chapter> is a spine index (0-based), resource id, or resource path.
epubzilla-cli extract book.epub 3

# New EPUB 3 from metadata + Markdown chapter files
epubzilla-cli create --title "My Book" --author "Jane Doe" \
  --chapter intro.md --chapter one.md --output my-book.epub

# Native validation subset; exit 1 on any error-severity issue
epubzilla-cli validate my-book.epub
```

Next up: M1 — Tauri shell wiring the core to a UI. See the
[project issues](https://github.com/seancassiere/epubzilla/issues) for the
milestone breakdown.

## License

MIT — see [LICENSE](LICENSE).
