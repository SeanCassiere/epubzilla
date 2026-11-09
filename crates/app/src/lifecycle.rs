//! Shell side of the book lifecycle: guarded Quit, Finder / Open With
//! file-open requests, recent-books commands, and native menu state.
//!
//! The frontend owns the unsaved-changes guard. The shell's job is to give
//! it a chance to run without ever trapping the user:
//!
//! * exits requested from the app (custom Quit item, ⌘Q) are held and sent
//!   to the frontend as a numbered quit request; the frontend acknowledges
//!   it at once (`ack_quit_request`) and confirms the real exit later via
//!   `quit_app` once its guard passed;
//! * a request that is not acknowledged within [`QUIT_ACK_TIMEOUT`], or a
//!   second ⌘Q while one is still unacknowledged, means the webview is
//!   hung, crashed or gone: the shell asks natively whether to quit anyway;
//! * whether a frontend is listening at all is tracked across its whole
//!   life (registration, React unmount, page reloads), not as a one-time
//!   flag; with no listener the shell quits directly unless the core still
//!   holds unsaved changes, in which case it asks natively first.
//!
//! Files handed to the app by the OS are delivered as one `open-files`
//! event, or parked until the frontend asks for them on mount
//! (`take_pending_open_paths`) when they arrive while nobody listens.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager, Runtime, Url};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

use crate::commands::SharedSession;
use crate::menu::{self, MenuHandles, MenuState};
use crate::recents::SharedRecents;

/// Frontend event: the user asked to quit; ack it, run the guard, then
/// `quit_app`. Payload: the request id to pass to `ack_quit_request`.
pub const QUIT_REQUESTED_EVENT: &str = "app-quit-requested";
/// Frontend event: the OS (or Open Recent) asked to open these paths.
pub const OPEN_FILES_EVENT: &str = "open-files";
/// Frontend event: the recent-books list changed (payload: the new list).
pub const RECENTS_CHANGED_EVENT: &str = "recent-books-changed";

/// How long a quit request may go unacknowledged before the shell assumes
/// the frontend is not responding and asks natively.
pub const QUIT_ACK_TIMEOUT: Duration = Duration::from_secs(2);

/// Text of the native last-resort quit prompt.
pub const UNRESPONSIVE_TITLE: &str = "epubzilla isn’t responding";
pub const UNRESPONSIVE_MESSAGE: &str =
    "epubzilla isn’t responding. Quit anyway? Unsaved changes may be lost.";

/// Process-wide lifecycle state shared between the run loop and commands.
#[derive(Debug, Default)]
pub struct LifecycleState {
    /// A frontend has registered its listeners and has not gone away since
    /// (unmount or page reload clear it). Without one, events would be
    /// lost: open paths are parked and quit requests are not sent.
    listening: AtomicBool,
    /// Set by `quit_app` (guard passed) or the native prompt's Quit: the
    /// next exit request goes through.
    quit_confirmed: AtomicBool,
    /// OS open requests that arrived while no frontend was listening.
    pending_open: Mutex<Vec<String>>,
    /// Quit-request bookkeeping (ids, acknowledgement, native prompt).
    quit: Mutex<QuitTracker>,
}

#[derive(Debug, Default)]
struct QuitTracker {
    next_id: u64,
    /// The newest quit request the frontend has not acknowledged yet.
    unacknowledged: Option<u64>,
    /// The native "not responding" prompt is on screen.
    prompt_open: bool,
}

/// What the run loop knows when an exit is requested.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct ExitInputs {
    /// `RunEvent::ExitRequested::code`.
    pub code: Option<i32>,
    /// The guard (or the native prompt) already confirmed this quit.
    pub confirmed: bool,
    /// A frontend is listening for quit requests.
    pub listening: bool,
    /// An earlier quit request is still unacknowledged.
    pub awaiting_ack: bool,
    /// The core holds unsaved changes (only consulted without a listener).
    pub unsaved_in_core: bool,
}

/// What to do with a `RunEvent::ExitRequested`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExitDecision {
    /// Let the app exit.
    Allow,
    /// Prevent the exit and ask the frontend to run its guard.
    AskFrontend,
    /// Prevent the exit and ask natively ("not responding — quit anyway?").
    AskNative,
}

/// Pure exit policy.
///
/// * `code == None`: the last window was destroyed. The red close button
///   already ran the frontend guard (onCloseRequested), so allow.
/// * the restart code (updater), or a confirmed quit: allow.
/// * no frontend listening: allow, unless the core holds unsaved changes —
///   then ask natively rather than discard them silently.
/// * a previous request is still unacknowledged (second ⌘Q, hung or dead
///   webview): ask natively — never a dead ⌘Q.
/// * otherwise: ask the frontend.
pub fn exit_decision(inputs: ExitInputs) -> ExitDecision {
    match inputs.code {
        None => ExitDecision::Allow,
        Some(tauri::RESTART_EXIT_CODE) => ExitDecision::Allow,
        Some(_) if inputs.confirmed => ExitDecision::Allow,
        Some(_) if !inputs.listening => {
            if inputs.unsaved_in_core {
                ExitDecision::AskNative
            } else {
                ExitDecision::Allow
            }
        }
        Some(_) if inputs.awaiting_ack => ExitDecision::AskNative,
        Some(_) => ExitDecision::AskFrontend,
    }
}

/// The run loop's action for one exit request (decision plus the request
/// id to send when the frontend is asked).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExitAction {
    Allow,
    AskFrontend { request: u64 },
    AskNative,
}

/// OS file URLs (Finder open / Dock drop) to local paths; anything that is
/// not a `file://` URL is skipped. Only macOS/iOS deliver `RunEvent::Opened`;
/// the helper is compiled (and tested) everywhere.
#[cfg_attr(not(any(target_os = "macos", target_os = "ios")), allow(dead_code))]
pub fn file_urls_to_paths(urls: &[Url]) -> Vec<String> {
    urls.iter()
        .filter(|url| url.scheme() == "file")
        .filter_map(|url| url.to_file_path().ok())
        .map(|path| path.to_string_lossy().into_owned())
        .collect()
}

impl LifecycleState {
    fn tracker(&self) -> std::sync::MutexGuard<'_, QuitTracker> {
        self.quit
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Run-loop side of `RunEvent::ExitRequested`. `unsaved_in_core` is
    /// only called when no frontend listens (it locks the session).
    pub fn on_exit_requested(
        &self,
        code: Option<i32>,
        unsaved_in_core: impl FnOnce() -> bool,
    ) -> ExitAction {
        let listening = self.listening.load(Ordering::SeqCst);
        let mut tracker = self.tracker();
        let inputs = ExitInputs {
            code,
            confirmed: self.quit_confirmed.load(Ordering::SeqCst),
            listening,
            awaiting_ack: tracker.unacknowledged.is_some(),
            unsaved_in_core: !listening && unsaved_in_core(),
        };
        match exit_decision(inputs) {
            ExitDecision::Allow => ExitAction::Allow,
            ExitDecision::AskNative => ExitAction::AskNative,
            ExitDecision::AskFrontend => {
                tracker.next_id += 1;
                let request = tracker.next_id;
                tracker.unacknowledged = Some(request);
                ExitAction::AskFrontend { request }
            }
        }
    }

    /// The frontend received quit request `request` (and everything older).
    pub fn acknowledge(&self, request: u64) {
        let mut tracker = self.tracker();
        if tracker
            .unacknowledged
            .is_some_and(|pending| pending <= request)
        {
            tracker.unacknowledged = None;
        }
    }

    /// Timer side: true when `request` is still unacknowledged after the
    /// timeout, i.e. the shell should ask natively.
    pub fn ack_overdue(&self, request: u64) -> bool {
        self.tracker().unacknowledged == Some(request)
    }

    /// Claim the native prompt; false when it is already on screen.
    pub fn begin_native_prompt(&self) -> bool {
        let mut tracker = self.tracker();
        if tracker.prompt_open {
            return false;
        }
        tracker.prompt_open = true;
        true
    }

    /// The native prompt closed; `quit` is the user's answer.
    pub fn end_native_prompt(&self, quit: bool) {
        self.tracker().prompt_open = false;
        if quit {
            self.confirm_quit();
        }
    }

    /// Either hand `paths` back for immediate delivery (frontend listening)
    /// or park them for `take_pending_open_paths`. Returns the paths to emit.
    pub fn route_open(&self, paths: Vec<String>) -> Option<Vec<String>> {
        if paths.is_empty() {
            return None;
        }
        if self.listening.load(Ordering::SeqCst) {
            Some(paths)
        } else {
            if let Ok(mut pending) = self.pending_open.lock() {
                pending.extend(paths);
            }
            None
        }
    }

    /// The frontend registered its listeners: mark it listening and drain
    /// anything parked while nobody was.
    pub fn take_pending(&self) -> Vec<String> {
        self.listening.store(true, Ordering::SeqCst);
        self.pending_open
            .lock()
            .map(|mut pending| std::mem::take(&mut *pending))
            .unwrap_or_default()
    }

    /// The frontend went away (React unmount, page reload or navigation):
    /// stop sending it events, and forget requests it will never answer.
    pub fn detach_frontend(&self) {
        self.listening.store(false, Ordering::SeqCst);
        self.tracker().unacknowledged = None;
    }

    fn confirm_quit(&self) {
        self.quit_confirmed.store(true, Ordering::SeqCst);
    }
}

/// Bring the main window forward (un-minimize, show, focus) so whatever
/// the frontend shows next — the unsaved sheet, an opened book — is seen.
fn reveal_main_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Run-loop handler for `RunEvent::ExitRequested`; calls `prevent_exit`
/// unless the exit may go ahead.
pub fn handle_exit_request<R: Runtime>(
    app: &AppHandle<R>,
    code: Option<i32>,
    prevent_exit: impl FnOnce(),
) {
    let state = app.state::<LifecycleState>();
    let action = state.on_exit_requested(code, || {
        // try_lock: never block the main thread behind a long command; a
        // busy session is treated as possibly unsaved (ask, don't lose).
        app.state::<SharedSession>()
            .try_lock()
            .map(|session| session.has_unsaved_changes())
            .unwrap_or(true)
    });
    match action {
        ExitAction::Allow => {}
        ExitAction::AskNative => {
            prevent_exit();
            prompt_quit_anyway(app);
        }
        ExitAction::AskFrontend { request } => {
            prevent_exit();
            // A minimized or hidden window would show the unsaved sheet
            // where nobody can see it, making Quit look broken.
            reveal_main_window(app);
            let _ = app.emit(QUIT_REQUESTED_EVENT, request);
            let app = app.clone();
            std::thread::spawn(move || {
                std::thread::sleep(QUIT_ACK_TIMEOUT);
                if app.state::<LifecycleState>().ack_overdue(request) {
                    prompt_quit_anyway(&app);
                }
            });
        }
    }
}

/// Native last resort when the webview cannot answer: Quit / Cancel. Runs
/// the (blocking) dialog on its own thread so the run loop stays free; at
/// most one prompt is on screen at a time.
fn prompt_quit_anyway<R: Runtime>(app: &AppHandle<R>) {
    if !app.state::<LifecycleState>().begin_native_prompt() {
        return;
    }
    reveal_main_window(app);
    let app = app.clone();
    std::thread::spawn(move || {
        let quit = app
            .dialog()
            .message(UNRESPONSIVE_MESSAGE)
            .title(UNRESPONSIVE_TITLE)
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::OkCancelCustom(
                "Quit".into(),
                "Cancel".into(),
            ))
            .blocking_show();
        app.state::<LifecycleState>().end_native_prompt(quit);
        if quit {
            app.exit(0);
        }
    });
}

/// Deliver OS open requests (macOS `RunEvent::Opened`, Open Recent): emit
/// to a ready frontend and bring the window forward, or park them.
pub fn deliver_open_paths<R: Runtime>(app: &AppHandle<R>, paths: Vec<String>) {
    let state = app.state::<LifecycleState>();
    if let Some(paths) = state.route_open(paths) {
        let _ = app.emit(OPEN_FILES_EVENT, paths);
        reveal_main_window(app);
    }
}

/// Rebuild File ▸ Open Recent and notify the frontend after a change.
pub fn publish_recents<R: Runtime>(app: &AppHandle<R>, entries: &[String]) {
    if let Some(handles) = app.try_state::<MenuHandles<R>>() {
        let _ = menu::fill_open_recent(app, &handles.open_recent, entries);
    }
    let _ = app.emit(RECENTS_CHANGED_EVENT, entries.to_vec());
}

fn recents_snapshot(recents: &SharedRecents) -> Vec<String> {
    recents
        .lock()
        .map(|r| r.entries().to_vec())
        .unwrap_or_default()
}

/// Apply `change` to the store, then rebuild the menu and notify.
pub fn change_recents<R: Runtime>(
    app: &AppHandle<R>,
    change: impl FnOnce(&mut crate::recents::RecentBooks),
) -> Vec<String> {
    let recents = app.state::<SharedRecents>();
    let entries = match recents.lock() {
        Ok(mut store) => {
            change(&mut store);
            store.entries().to_vec()
        }
        Err(_) => Vec::new(),
    };
    publish_recents(app, &entries);
    entries
}

#[tauri::command]
pub fn list_recent_books(recents: tauri::State<'_, SharedRecents>) -> Vec<String> {
    recents_snapshot(&recents)
}

#[tauri::command]
pub fn add_recent_book<R: Runtime>(app: AppHandle<R>, path: String) -> Vec<String> {
    change_recents(&app, |store| store.add(&path))
}

#[tauri::command]
pub fn remove_recent_book<R: Runtime>(app: AppHandle<R>, path: String) -> Vec<String> {
    change_recents(&app, |store| {
        store.remove(&path);
    })
}

#[tauri::command]
pub fn clear_recent_books<R: Runtime>(app: AppHandle<R>) -> Vec<String> {
    change_recents(&app, |store| store.clear())
}

/// Called by the frontend once its listeners are registered (on mount):
/// marks it listening for live `open-files` / `app-quit-requested` events
/// and returns parked paths.
#[tauri::command]
pub fn take_pending_open_paths(state: tauri::State<'_, LifecycleState>) -> Vec<String> {
    state.take_pending()
}

/// Called by the frontend when its listeners go away (unmount).
#[tauri::command]
pub fn detach_frontend(state: tauri::State<'_, LifecycleState>) {
    state.detach_frontend();
}

/// The frontend received quit request `request`; it answers later with
/// `quit_app` (guard passed) or not at all (the user cancelled).
#[tauri::command]
pub fn ack_quit_request(state: tauri::State<'_, LifecycleState>, request: u64) {
    state.acknowledge(request);
}

/// The frontend's guard passed (or nothing was unsaved): really quit.
#[tauri::command]
pub fn quit_app<R: Runtime>(app: AppHandle<R>, state: tauri::State<'_, LifecycleState>) {
    state.confirm_quit();
    app.exit(0);
}

/// Native menu enablement follows the document state.
#[tauri::command]
pub fn set_menu_state<R: Runtime>(app: AppHandle<R>, state: MenuState) {
    if let Some(handles) = app.try_state::<MenuHandles<R>>() {
        let _ = menu::apply_state(&handles, state);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn inputs(code: Option<i32>) -> ExitInputs {
        ExitInputs {
            code,
            listening: true,
            ..ExitInputs::default()
        }
    }

    #[test]
    fn closing_the_last_window_exits() {
        assert_eq!(exit_decision(inputs(None)), ExitDecision::Allow);
    }

    #[test]
    fn quit_waits_for_the_frontend_guard() {
        assert_eq!(exit_decision(inputs(Some(0))), ExitDecision::AskFrontend);
        let confirmed = ExitInputs {
            confirmed: true,
            ..inputs(Some(0))
        };
        assert_eq!(exit_decision(confirmed), ExitDecision::Allow);
    }

    #[test]
    fn restart_is_never_held() {
        let restart = ExitInputs {
            awaiting_ack: true,
            ..inputs(Some(tauri::RESTART_EXIT_CODE))
        };
        assert_eq!(exit_decision(restart), ExitDecision::Allow);
    }

    #[test]
    fn without_a_listener_quit_only_asks_when_the_core_has_unsaved_changes() {
        let gone = ExitInputs {
            listening: false,
            ..inputs(Some(0))
        };
        assert_eq!(exit_decision(gone), ExitDecision::Allow);
        let gone_dirty = ExitInputs {
            unsaved_in_core: true,
            ..gone
        };
        assert_eq!(exit_decision(gone_dirty), ExitDecision::AskNative);
    }

    #[test]
    fn an_unacknowledged_request_escalates_to_the_native_prompt() {
        let pending = ExitInputs {
            awaiting_ack: true,
            ..inputs(Some(0))
        };
        assert_eq!(exit_decision(pending), ExitDecision::AskNative);
    }

    #[test]
    fn second_quit_before_the_ack_asks_natively() {
        let state = LifecycleState::default();
        state.take_pending();
        let first = state.on_exit_requested(Some(0), || false);
        assert_eq!(first, ExitAction::AskFrontend { request: 1 });
        // Hung webview: no ack, user presses ⌘Q again.
        assert_eq!(
            state.on_exit_requested(Some(0), || false),
            ExitAction::AskNative
        );
        assert!(state.ack_overdue(1));
    }

    #[test]
    fn acknowledged_requests_do_not_time_out() {
        let state = LifecycleState::default();
        state.take_pending();
        let ExitAction::AskFrontend { request } = state.on_exit_requested(Some(0), || false) else {
            panic!("expected a frontend request");
        };
        state.acknowledge(request);
        assert!(!state.ack_overdue(request));
        // Guard sheet still up, ⌘Q again: the (alive) frontend is asked again.
        assert_eq!(
            state.on_exit_requested(Some(0), || false),
            ExitAction::AskFrontend { request: 2 }
        );
        // A stale ack for the older request does not clear the newer one.
        state.acknowledge(1);
        assert!(state.ack_overdue(2));
        state.acknowledge(2);
        assert!(!state.ack_overdue(2));
    }

    #[test]
    fn a_detached_frontend_is_not_asked() {
        let state = LifecycleState::default();
        state.take_pending();
        assert!(matches!(
            state.on_exit_requested(Some(0), || false),
            ExitAction::AskFrontend { .. }
        ));
        // Page reload / unmount: the outstanding request is void.
        state.detach_frontend();
        assert!(!state.ack_overdue(1));
        assert_eq!(
            state.on_exit_requested(Some(0), || false),
            ExitAction::Allow
        );
        assert_eq!(
            state.on_exit_requested(Some(0), || true),
            ExitAction::AskNative
        );
        // Listening again after remount.
        state.take_pending();
        assert!(matches!(
            state.on_exit_requested(Some(0), || true),
            ExitAction::AskFrontend { .. }
        ));
    }

    #[test]
    fn the_session_is_only_consulted_without_a_listener() {
        let state = LifecycleState::default();
        state.take_pending();
        let action = state.on_exit_requested(Some(0), || panic!("session must not be locked"));
        assert!(matches!(action, ExitAction::AskFrontend { .. }));
    }

    #[test]
    fn only_one_native_prompt_at_a_time_and_quit_confirms() {
        let state = LifecycleState::default();
        state.take_pending();
        assert!(state.begin_native_prompt());
        assert!(!state.begin_native_prompt());
        state.end_native_prompt(false);
        assert!(matches!(
            state.on_exit_requested(Some(0), || false),
            ExitAction::AskFrontend { .. }
        ));
        assert!(state.begin_native_prompt());
        state.end_native_prompt(true);
        assert_eq!(
            state.on_exit_requested(Some(0), || false),
            ExitAction::Allow
        );
    }

    #[test]
    fn open_requests_park_until_the_frontend_listens() {
        let state = LifecycleState::default();
        assert_eq!(state.route_open(vec!["/a.epub".into()]), None);
        assert_eq!(state.route_open(vec![]), None);
        assert_eq!(state.take_pending(), vec!["/a.epub".to_string()]);
        // Listening now: delivered immediately, nothing parked.
        assert_eq!(
            state.route_open(vec!["/b.epub".into()]),
            Some(vec!["/b.epub".to_string()])
        );
        assert!(state.take_pending().is_empty());
        // Gone again (reload): park until it re-registers.
        state.detach_frontend();
        assert_eq!(state.route_open(vec!["/c.epub".into()]), None);
        assert_eq!(state.take_pending(), vec!["/c.epub".to_string()]);
    }

    #[test]
    fn quit_confirmation_flips_the_decision() {
        let state = LifecycleState::default();
        state.take_pending();
        assert!(matches!(
            state.on_exit_requested(Some(0), || false),
            ExitAction::AskFrontend { .. }
        ));
        state.confirm_quit();
        assert_eq!(
            state.on_exit_requested(Some(0), || false),
            ExitAction::Allow
        );
    }

    #[test]
    fn file_urls_become_paths() {
        let urls = vec![
            Url::parse("file:///Users/me/Books/Caf%C3%A9%20%E4%B8%96%E7%95%8C.epub").unwrap(),
            Url::parse("https://example.com/x.epub").unwrap(),
        ];
        let paths = file_urls_to_paths(&urls);
        assert_eq!(paths.len(), 1);
        assert!(paths[0].ends_with("Café 世界.epub"), "{paths:?}");
    }
}
