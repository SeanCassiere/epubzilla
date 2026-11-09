# Contract: Shell lifecycle commands and events

Status: **Accepted** · Changes via PR only.

Shell-level (Tauri app crate) commands and events that support the book
lifecycle: recent books, guarded Quit, OS file-open requests, and native
menu state. They do not change `epubzilla-core` state (the exit policy
only asks the session whether anything is unsaved); the core API is in
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
| `take_pending_open_paths` | — | `Vec<String>` | Called on mount, once the listeners are registered. Marks the frontend listening and returns paths the OS sent while nobody was (Finder cold start, after a reload). |
| `detach_frontend` | — | `()` | Called when the listeners go away (unmount). The shell stops emitting to it and parks Finder opens again. A page load (`PageLoadEvent::Started`, e.g. a reload) has the same effect. |
| `ack_quit_request` | `request: u64` | `()` | Sent as soon as `app-quit-requested` arrives, before any guard runs. Proves the webview is alive (see Exit policy). |
| `quit_app` | — | `()` | Called only after the unsaved-changes guard passes. Confirms and exits. |
| `set_menu_state` | `state: { hasBook, editable, busy }` | `()` | Native menu enablement (Save, Save As, Close Book, editor and navigation items). `busy` (a lifecycle operation or any modal) disables every document item, including chapter navigation and the sidebar panels. |

Every change to the recents list rebuilds File ▸ Open Recent and emits
`recent-books-changed`. The list is persisted as JSON in the app data
directory (`recent-books.json`). A missing or corrupt file starts empty.

## Events (shell → frontend)

| Event | Payload | When |
|---|---|---|
| `open-files` | `string[]` | macOS `RunEvent::Opened` (Finder double-click, Open With, drop on the Dock icon) once the frontend is ready, and File ▸ Open Recent items. The frontend opens the first `.epub`. |
| `app-quit-requested` | `u64` request id | ⌘Q or the Quit item, while a frontend is listening and has not confirmed. The exit is held (`prevent_exit`) until `quit_app`. The frontend acknowledges with `ack_quit_request(id)` immediately. |
| `recent-books-changed` | `string[]` | After any recents change. |
| `app-menu` | `string` | Other menu items, as before (ids are frontend shortcut actions, now including `close-book`). |

## Exit policy

`RunEvent::ExitRequested` (decision in `lifecycle::exit_decision`,
unit-tested):

- **Allowed** when the last window was destroyed (the red close button
  already ran the frontend guard), on the updater restart code, or after
  `quit_app` / the native prompt's Quit confirmed it.
- **No frontend listening** (never loaded, unmounted, reloading): allowed
  when the core has no unsaved changes; otherwise the native prompt below.
- **A previous quit request is still unacknowledged** (a second ⌘Q while
  the webview is hung, crashed or gone): the native prompt, at once.
- **Otherwise** it is prevented, the window is un-minimized, shown and
  focused, and `app-quit-requested` is emitted with a new id. If that id is
  not acknowledged within 2 s, the native prompt is shown.

The native prompt is a blocking `tauri-plugin-dialog` message dialog, at
most one at a time: “epubzilla isn’t responding. Quit anyway? Unsaved
changes may be lost.” **Quit** confirms and exits; **Cancel** keeps the app
running (a later ⌘Q asks again). So ⌘Q is never dead, even with a hung or
crashed webview.

The frontend never drops a quit request either: while a lifecycle
operation (picker, guard, save, open, create) is pending it quits at once
when nothing is unsaved, and otherwise runs the guard as soon as the
operation finishes. The red close button behaves the same way. A repeat ⌘Q
while such a queued quit still waits is deliberately left unacknowledged,
so an operation that never finishes ends in the native prompt rather than
a dead ⌘Q.

The predefined macOS Quit item sends `terminate:`, which bypasses this
handshake, so it is replaced by a custom item with ⌘Q.

### Not guarded: Dock ▸ Quit, logout, restart, shutdown

**Dock ▸ Quit, logging out, restarting or shutting down the Mac (and
AppleScript `quit`) are not guarded.** They all go through
`NSApplication terminate:`. tao's app delegate (0.35) implements only
`applicationWillTerminate:` and no `applicationShouldTerminate:`, so
nothing can veto or defer that termination: Tauri never sees an
`ExitRequested` it could prevent, and unsaved changes (core and editor
buffer) are lost without a prompt. Adding an AppKit delegate hook is out of
scope for now.

### On-device verification pending

None of the native behaviour above has been run on a Mac yet; it is
covered by unit tests of the Rust decision logic and frontend tests with
mocked IPC and events only. Still to verify on device: ⌘Q and the Quit
item with clean and unsaved books (including while minimized and while an
open, save or picker is pending), the 2 s fallback prompt with a hung or
crashed webview and a second ⌘Q, Finder open (cold and warm), Open
Recent, `.epub` drops on the window, Finder image drops into the editor,
native menu enablement, and that Dock ▸ Quit / logout really are
unguarded as described.
