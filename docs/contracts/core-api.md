# Contract: Core API

Status: **Accepted** · Changes via PR only.

The command surface the Rust core exposes to the frontend (Tauri commands).
Types reference `domain-model.md`. All commands are async and return
`Result<T, CoreError>`.

The core owns an in-memory session of open books keyed by `BookId`
(edit-in-place model, ADR-0002). The frontend is stateless with respect to
book data: it holds `BookId`s and re-fetches.

## Commands

### Lifecycle

| Command | Input | Output | Notes |
|---|---|---|---|
| `open_book` | `path: String` | `Book` | Parses container/OPF/nav eagerly; chapter bodies lazy. |
| `create_book` | `metadata: Metadata` | `Book` | New in-memory EPUB 3 book with a generated title page; `source: None`. |
| `save_book` | `book_id, path: Option<String>` | `Book` | Atomic write (temp + rename). `path` required when `source` is `None` (save-as). Untouched zip entries are copied, not re-encoded. Refreshes `dcterms:modified`, clears `dirty`. Incremental orphan sweep: resources added during the session that end up unreferenced are dropped on save (manifest entry, bytes, zip entry); pre-existing resources are never dropped, even when an edit removed their last reference (conservative limitation — deciding that would require reading every unmodified document; a full sweep may later be offered as an explicit clean-up). References come from documents modified this session (`src`/`href`/`xlink:href` attributes) and transitively through added CSS resources' `url(...)` chains; the sweep reads no unmodified documents. Content documents, the nav document, the NCX, and the cover image are never swept. The sweep is silent — swept paths are observable only as the returned `Book`'s smaller `resources` list. |
| `close_book` | `book_id` | `()` | Drops session state. Unsaved changes are the frontend's problem to confirm. |

### Reading

| Command | Input | Output | Notes |
|---|---|---|---|
| `get_book` | `book_id` | `Book` | Current model snapshot. |
| `read_chapter` | `book_id, resource_id, prefer: ContentFormat` | `ChapterContent` | `prefer: Markdown` converts per `content-roundtrip.md`; returns `format: Xhtml` when conversion would be lossy. |
| `read_resource` | `book_id, resource_id` | `ResourcePayload` | For images/CSS/fonts. Returns raw bytes over IPC. Resources are additionally served over the `epub://` asset protocol as `epub://<book_id>/<zip-internal path>` with the manifest `media_type` as Content-Type (404 on unknown ids/paths). Platform webviews may surface the scheme as `http://epub.localhost/...`; the frontend builds URLs only via the `resourceUrl` helper (`convertFileSrc`-based), never by hand. |

### Editing

All editing commands set `dirty: true` and return the updated `Book` so the
frontend never computes model changes itself.

| Command | Input | Output | Notes |
|---|---|---|---|
| `write_chapter` | `book_id, resource_id, content: ChapterContent` | `Book` | Markdown input is converted to XHTML on write. |
| `update_metadata` | `book_id, metadata: Metadata` | `Book` | Regenerates title page if book uses a generated one. |
| `add_chapter` | `book_id, title: String, after: Option<SpineItemId>` | `Book` | Creates resource + spine entry + nav entry. |
| `remove_chapter` | `book_id, spine_item_id` | `Book` | Removes spine entry, nav entries, and the resource if unreferenced. |
| `reorder_spine` | `book_id, order: Vec<SpineItemId>` | `Book` | Must be a permutation of the current spine; nav order follows for top-level chapter entries. |
| `add_resource_from_path` | `book_id, os_path: String` | `Book` | M3.3: reads the file at `os_path` and stores it via `Session::add_resource` — bytes never cross IPC. Media type is inferred from the extension (`png`, `jpg`, `jpeg`, `gif`, `svg`, `webp`); anything else is `UnsupportedFeature`. |
| `add_resource_from_bytes` | `book_id, name_hint: String, media_type: String, bytes: Vec<u8>` | `Book` | Issue #54: stores in-memory image bytes (clipboard paste / drag-and-drop, no OS path) via `Session::add_resource`. `media_type` must be one of `image/png`, `image/jpeg`, `image/gif`, `image/svg+xml`, `image/webp` — anything else is `UnsupportedFeature`. `name_hint`'s extension is kept only when it agrees with `media_type`; otherwise the canonical extension is applied (empty hints become `pasted-image.<ext>`). |
| `set_cover` | `book_id, resource_id: Option<ResourceId>` | `Book` | Issue #73: sets `metadata.cover_resource`. `Some` must name an existing manifest resource with an `image/*` media type (`ResourceNotFound` / `UnsupportedFeature` otherwise); `None` clears the cover. The regenerated OPF gives the cover's manifest item the EPUB 3 `cover-image` property. Replacement cleanup: a displaced cover that was added THIS session and is referenced by nothing else is removed eagerly (manifest entry, bytes, zip entry) using the incremental sweep's bookkeeping — no unmodified document is read; pre-existing displaced covers are conservatively kept (they only lose the property), matching `save_book`'s sweep policy. |
| `set_cover_from_path` | `book_id, os_path: String` | `Book` | Issue #73: reads the image file at `os_path`, stores it via `Session::add_resource` (same media-type inference and slot rules as `add_resource_from_path`), and makes it the cover via `set_cover` — one command, bytes never cross IPC. |

`Session::add_resource(book_id, path_hint: &str, media_type: &str, bytes:
Vec<u8>) -> CoreResult<Book>` is the core-level primitive behind
`add_resource_from_path`: it stores the bytes in the session overlay under a
collision-free zip-internal path derived from `path_hint`'s file name
(`<package dir>/images/<sanitized stem>[-<n>].<ext>`, lowercased extension),
adds the manifest `Resource` with the given media type, and sets `dirty`.
EPUB 2 books reject it with `UnsupportedFeature` like every other mutation.

### Validation

| Command | Input | Output | Notes |
|---|---|---|---|
| `validate` | `book_id` | `Vec<ValidationIssue>` | Native Rust subset (ADR-0003). Full `epubcheck` runs in CI only. |

## Consistency rules

1. Spine, nav, and manifest are kept in sync **by the core**. No command can
   leave them inconsistent; there is no command to edit nav or manifest directly
   in v1.
2. `save_book` output must pass `epubcheck` with zero errors for any book
   created by `create_book` and mutated only through this API.
3. Commands are serialized per book: concurrent calls on one `book_id` are
   queued by the core, not rejected.

## Performance budgets

Measured on the reference machine (typical laptop, local SSD), release build.
Two generated fixtures (issue #76): a **text-heavy** book (500 chapters,
~50 MB Markdown) and an **image-heavy** book (250 chapters plus 100
incompressible images, ~50 MB of image bytes). Budgets apply to both:

| Operation | Budget |
|---|---|
| `open_book` — large book (either fixture) | ≤ 1000 ms |
| `read_chapter` — typical chapter (~50 KB XHTML) | ≤ 50 ms |
| `write_chapter` | ≤ 50 ms (in-memory; no disk I/O) |
| `save_book` — one chapter changed in the large book | ≤ 500 ms |
| `validate` — full native subset on the large book | ≤ 500 ms |

The `validate` budget exists because the frontend re-checks automatically
after every save (issue #82); the re-check is fire-and-forget, but it must
not occupy the per-book command queue long enough to make the next command
feel stuck. Reference-machine numbers as of the issue #76 pass sit well
inside these budgets (open ~2 ms, save ~20–75 ms, validate ~20–140 ms).

Budgets are enforced by benchmark tests in the core crate
(`crates/core/tests/perf_budgets.rs`); regressions fail CI.
