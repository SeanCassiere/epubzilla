# ADR-0002: Edit-in-place with in-memory working copy and atomic save

Status: Accepted · 2026-08-23

## Context

Two storage models were considered: editing the EPUB file directly, or an
unpacked project directory that exports to EPUB.

## Decision

Edit-in-place: `open_book` builds an in-memory working copy (index eager,
content lazy); `save_book` writes atomically (temp file + rename) and copies
untouched zip entries without re-encoding.

## Rationale

- Simpler UX: the file the user opens is the file they save. No import/export
  mental model, no orphaned project directories.
- Atomic save means a crash never corrupts the source file.
- Incremental entry copying meets the save-time budget without a project dir.
- Rejected: project directory — friendlier to git and partial saves, but v1's
  target user is an author, not a repo. Can be added later as an export mode.

## Consequences

- Unsaved state lives in core memory; the frontend must confirm before
  `close_book` when `dirty`.
- Very large books are bounded by lazy content loading, not by unpacking.
