# ADR-0001: Tauri desktop app with a Rust core

Status: Accepted · 2026-08-23

## Context

The app must open, edit, and save large EPUBs (hundreds of chapters, embedded
media) near-instantly, and must render XHTML chapter content faithfully.

## Decision

Build a Tauri desktop application: a Rust core crate for all EPUB I/O and model
logic, and a TypeScript web-view frontend for UI, preview, and editing.

## Rationale

- Browsers render XHTML+CSS natively — the previewer is essentially free and
  faithful in a web view.
- Rust gives the file-I/O and parsing performance headroom for the budgets in
  `docs/contracts/core-api.md`, and mature crates exist (`zip`, `quick-xml`).
- The best editor components (ProseMirror family, CodeMirror) are web-native.
- Rejected: pure web app (epub.js) — read-focused, and fast writes on big
  archives need native file access; Electron — heavier runtime, no Rust
  boundary by default. A later web build stays possible since the frontend is
  web tech.

## Consequences

- A typed IPC boundary must be maintained; types are generated from Rust
  (see contracts) to prevent drift.
- Core logic stays UI-free so it can be exercised by a CLI harness and tests.
