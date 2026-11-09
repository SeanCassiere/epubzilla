# Contract: Shell lifecycle commands and events

Status: **Accepted** · Changes via PR only.

Shell-level (Tauri app crate) commands and events that support the book
lifecycle: recent books, guarded Quit, OS file-open requests, and native
menu state. They do not touch `epubzilla-core`; the core API is in
`core-api.md`. Implementation: `crates/app/src/lifecycle.rs`,
`crates/app/src/recents.rs`, `crates/app/src/menu.rs`. Frontend wrappers:
`frontend/src/lib/api.ts` (commands) and `frontend/src/lib/shellEvents.ts`
(events). The frontend's single entry point for all of them is the
lifecycle controller, `frontend/src/state/lifecycle.tsx`.

## Commands

| Command | Input | Output | Notes |
|---|---|---|---|
| `list_recent_books` | — | `Vec<String>` | OS paths, newest first, at most 10. |
| `add_recent_book` | `path: String` | `Vec<String>` | After a successful open, first Save, or Save As. Deduplicated, moved to the front. |
| `remove_recent_book` | `path: String` | `Vec<String>` | For example when the file is gone. Never touches the file. |
| `clear_recent_books` | — | `Vec<String>` | Same as File ▸ Open Recent ▸ Clear Menu. |
| `take_pending_open_paths` | — | `Vec<String>` | Called once on mount. Marks the frontend ready and returns paths the OS sent before then (Finder cold start). |
| `quit_app` | — | `()` | Called only after the unsaved-changes guard passes. Confirms and exits. |
| `set_menu_state` | `state: { hasBook, editable, busy }` | `()` | Native menu enablement (Save, Save As, Close Book, editor and navigation items). |

Every change to the recents list rebuilds File ▸ Open Recent and emits
`recent-books-changed`. The list is persisted as JSON in the app data
directory (`recent-books.json`). A missing or corrupt file starts empty.

## Events (shell → frontend)

| Event | Payload | When |
|---|---|---|
| `open-files` | `string[]` | macOS `RunEvent::Opened` (Finder double-click, Open With, drop on the Dock icon) once the frontend is ready, and File ▸ Open Recent items. The frontend opens the first `.epub`. |
| `app-quit-requested` | — | ⌘Q or the Quit item, while the frontend is ready and has not confirmed. The exit is held (`prevent_exit`) until `quit_app`. |
| `recent-books-changed` | `string[]` | After any recents change. |
| `app-menu` | `string` | Other menu items, as before (ids are frontend shortcut actions, now including `close-book`). |

## Exit policy

`RunEvent::ExitRequested` is allowed when the last window was destroyed
(the red close button already ran the frontend guard), on the updater
restart code, after `quit_app`, or when no frontend has registered yet.
Otherwise it is prevented and `app-quit-requested` is emitted. The
predefined macOS Quit item sends `terminate:`, which bypasses this
handshake, so it is replaced by a custom item with ⌘Q.
