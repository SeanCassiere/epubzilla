# epubzilla

An application for previewing, creating, and editing EPUB files — fast.

## Goals

- **Preview**: open and read EPUB files with fast rendering.
- **Create**: scaffold new EPUBs with title pages, metadata, and chapters.
- **Edit**: modify chapter content via a WYSIWYG or Markdown-based editor.
- **Performance**: reading, editing, and creation should feel instant, leveraging a performant core language and/or existing libraries.

## Status

**v0.2.0 released** — grab installers for macOS, Windows, and Linux from
[Releases](https://github.com/SeanCassiere/epubzilla/releases) (unsigned for
now: on macOS, right-click → Open the first time).

The desktop app covers the full loop: open and read EPUB 2/3 books (TOC
navigation, faithful rendering), create new EPUB 3 books (metadata, title
page, chapter management), and edit chapters as Markdown — WYSIWYG (Milkdown)
or raw (CodeMirror) — with XHTML source mode for content outside the Markdown
subset, image insertion, and atomic incremental saves that pass epubcheck.

Underneath, the UI-free Rust core (`crates/core`) implements the contracts in
`docs/contracts/`, with epubcheck-clean output and performance budgets
enforced in CI (a 500-chapter book opens in ~5ms). A CLI harness
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

Milestones M0–M3 (core, previewer, creator, editor) are complete; polish and
platform-native refinements are tracked on the
[M4 milestone](https://github.com/SeanCassiere/epubzilla/milestone/5).

## Development

Prerequisites: Rust (stable), Node 22+, pnpm.

```sh
pnpm install          # JS deps (frontend workspace)
pnpm dev              # Tauri dev shell with Vite HMR
pnpm typecheck        # frontend typecheck
cargo test --workspace
```

Layout: `crates/core` (engine), `crates/cli` (harness), `crates/app` (Tauri
shell), `frontend/` (React UI). Frontend model types come exclusively from the
generated `crates/core/bindings/` (`@bindings/*` alias) — regenerate with
`cargo test -p epubzilla-core export_bindings`. Architecture decisions live in
`docs/adr/`, interface contracts in `docs/contracts/`.

### Releases

Tag pushes matching `v*` trigger the release workflow
(`.github/workflows/release.yml`), which builds installers with
[tauri-action](https://github.com/tauri-apps/tauri-action) for macOS
(Apple Silicon dmg/app), Linux (AppImage/deb), and Windows (msi/nsis), and
uploads them to a **draft** GitHub Release with notes generated from merged
PRs since the previous tag. Review and publish the draft manually.

To cut a release:

```sh
pnpm bump 0.2.0          # rewrites version in package.json, frontend/package.json,
                         # Cargo.toml [workspace.package], crates/app/tauri.conf.json
cargo check --workspace  # refresh Cargo.lock
git add -A && git commit -m "v0.2.0"
git tag v0.2.0
git push && git push --tags
```

Builds are currently unsigned: on macOS, right-click the app and choose
"Open" the first time to bypass Gatekeeper; on Windows, SmartScreen may warn
("More info" > "Run anyway"). Signing/notarization is a follow-up once
identities exist.

## License

MIT — see [LICENSE](LICENSE).
