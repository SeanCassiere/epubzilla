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
| `app-quit-requested` | `u64` request id | ⌘Q or the Quit item, while a frontend is listening and has not confirmed. The exit is held (`prevent_exit`) until `quit_app`. The frontend acknowledges with `ack_quit_request(id)` while it can visibly answer (see below). |
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
- **A previous quit request is still unacknowledged** (a repeat ⌘Q): the
  native prompt at once if that request's 2 s timeout already ran out (the
  webview is hung, crashed or gone); otherwise the exit is held and the
  timeout decides. A quick double ⌘Q therefore never flags a healthy
  webview that is a moment late to answer.
- **Otherwise** it is prevented, the window is un-minimized, shown and
  focused, and `app-quit-requested` is emitted with a new id. If that id is
  not acknowledged within 2 s, the native prompt is shown.

**Native pickers suspend the timeout.** On macOS the open and save panels
are sheets on the main window, and the webview may not get to deliver its
acknowledgement while one is up. When the timeout runs out with a sheet or
an app-modal window on screen (checked on the main thread through AppKit),
it is suspended; a repeat ⌘Q is held meanwhile, and a fresh 2 s timeout
starts when the panel closes. A healthy app with a picker up never gets the
prompt.

The native prompt is a `tauri-plugin-dialog` message dialog, at most one at
a time, titled “epubzilla isn’t responding” with “Quit anyway? Unsaved
changes may be lost.” It is shown with the plugin's non-blocking API as a
sheet on the main window, which is brought forward and focused first; the
run loop never waits for it. (Without a parent window the plugin falls back
to a system `CFUserNotification` alert, which on device never came to the
front.) **Quit** confirms and exits; **Cancel** keeps the app running and
forgets the unanswered request, so a later ⌘Q goes to the frontend's guard
again with a fresh 2 s timeout. So ⌘Q is never dead, even with a hung or
crashed webview.

The frontend never drops a quit request either: while a lifecycle
operation (picker, guard, save, open, create) is pending it quits at once
when nothing is unsaved, and otherwise runs the guard as soon as the
operation finishes. The red close button behaves the same way.

Acknowledgement follows what is on screen. A request that starts a quit or
queues one is acknowledged at once. A repeat that the running exit or the
queued quit already covers is acknowledged only while an interactive
decision is on screen (the unsaved sheet, the open or save picker), so a
healthy app with a sheet up never gets the native prompt. While the
operation is working instead — an open or create in flight, or an exit
settling edits, applying the editor buffer or saving — the repeat is held
unacknowledged until a decision appears or the operation ends. An
operation that never finishes therefore ends in the native prompt after
2 s rather than a dead ⌘Q.

The predefined macOS Quit item sends `terminate:`, which bypasses this
handshake, so it is replaced by a custom item with ⌘Q.

WKWebView offers ⌘-key equivalents to the page before the menu, and only
hands them back once its web content process answers, so with a hung web
content process ⌘Q would never reach the Quit item. On macOS an AppKit
local key-down monitor therefore sends ⌘Q straight to the same guarded
path as the Quit item, before any window sees it.

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
