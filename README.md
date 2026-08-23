# epubzilla

A fast desktop application for previewing, creating, and editing EPUB files.
Tauri (Rust core) + React.

**[Download the latest release](https://github.com/SeanCassiere/epubzilla/releases)**
— currently built for macOS (Apple Silicon); Windows and Linux builds are
temporarily paused. Builds are unsigned for now, so downloaded copies are
quarantined and macOS reports the app as "damaged". Clear the flag once
after installing:

```sh
xattr -cr /Applications/epubzilla.app
```

## Features

- **Read**: open EPUB 2/3 books with faithful rendering (the book's own CSS
  and images, sandboxed), TOC navigation, and spine paging with keyboard
  shortcuts.
- **Create**: new EPUB 3 books with metadata, a generated title page, and
  chapter management (add, remove, reorder).
- **Edit**: chapters as Markdown — WYSIWYG (Milkdown) or raw (CodeMirror) —
  with XHTML source mode for content outside the Markdown subset (never
  lossy), image insertion, and unsaved-changes guards.
- **Fast and safe**: atomic incremental saves that pass epubcheck; a
  500-chapter book opens in ~5 ms. Performance budgets are contractual and
  enforced in CI.

Underneath, the UI-free Rust core (`crates/core`) implements the contracts in
`docs/contracts/`. A CLI harness (`crates/cli`) exercises the whole surface:

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

The release workflow (`.github/workflows/release.yml`) builds installers with
[tauri-action](https://github.com/tauri-apps/tauri-action) — currently macOS
(Apple Silicon dmg/app) only; Windows (msi/nsis) and Linux (AppImage/deb/rpm)
targets are temporarily disabled in the workflow's matrix (a comment there
shows how to re-enable them; CI still tests on Linux). Artifacts upload to a
**draft** GitHub Release with notes generated from merged PRs since the
previous tag. Review and publish the draft manually.

Two ways to cut a release:

1. **GitHub Actions (recommended)**: run the **Cut release** workflow
   (Actions → Cut release → Run workflow) and enter the version `X.Y.Z`. It
   bumps the version files, commits, tags `vX.Y.Z`, and starts the release
   build.
2. **Locally**:

   ```sh
   pnpm bump 0.3.0          # rewrites version in package.json, frontend/package.json,
                            # Cargo.toml [workspace.package], crates/app/tauri.conf.json
   cargo check --workspace  # refresh Cargo.lock
   git add -A && git commit -m "v0.3.0"
   git tag -a v0.3.0 -m "v0.3.0"
   git push && git push --tags
   ```

Builds are currently unsigned: macOS quarantines downloaded copies and
reports the app as "damaged" — clear it with
`xattr -cr /Applications/epubzilla.app` (see the note at the top of this
README). Signing/notarization is tracked in issue #65.

## License

MIT — see [LICENSE](LICENSE).
