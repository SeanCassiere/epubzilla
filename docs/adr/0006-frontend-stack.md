# ADR-0006: Frontend stack — Tauri v2, React, TypeScript, Vite, pnpm

Status: Accepted · 2026-08-23

## Context

M1 introduces the desktop shell and UI (ADR-0001 chose Tauri + a web
frontend). A frontend framework, bundler, and package manager must be fixed
before scaffolding.

## Decision

- **Tauri v2** for the shell; the existing `epubzilla-core` crate is wrapped
  by a thin `crates/app` Tauri backend exposing the core-api.md commands.
- **React + TypeScript** for the frontend, in `frontend/`.
- **Vite** as the bundler and dev server; **pnpm** as the package manager.
- Frontend model types come exclusively from the generated
  `crates/core/bindings/` (ts-rs); hand-written mirrors stay forbidden.

## Rationale

- M3's editor candidates (Tiptap, Milkdown — ADR-0004) have their most
  mature bindings and ecosystem on React; picking React now avoids a
  framework migration at M3.
- Vite + pnpm match the Tauri v2 default tooling and the user's toolchain.
- Rejected: Svelte/Solid (weaker editor-component story), Next.js (SSR
  machinery useless in a webview).

## Consequences

- CI grows frontend jobs (typecheck, lint, build) and a bindings-consumption
  check.
- The Tauri command layer is the only place IPC types appear; UI components
  consume typed wrappers, never `invoke` strings directly.
