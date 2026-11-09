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
//! * a request that is not acknowledged within [`QUIT_ACK_TIMEOUT`] means
//!   the webview is hung, crashed or gone: the shell asks natively whether
//!   to quit anyway (a repeat ⌘Q asks at once once that time is up, not
//!   before, so a webview that is merely a moment late is never flagged);
//! * the timeout is suspended while a native sheet or modal panel (an open
//!   or save picker) is on screen, and restarts when it closes;
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
use std::time::{Duration, Instant};

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

/// How often an overdue request re-checks whether the native picker that
/// suspended its timeout has closed.
const MODAL_POLL_INTERVAL: Duration = Duration::from_millis(250);

/// Text of the native last-resort quit prompt (alert title, then body).
pub const UNRESPONSIVE_TITLE: &str = "epubzilla isn’t responding";
pub const UNRESPONSIVE_MESSAGE: &str = "Quit anyway? Unsaved changes may be lost.";

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
    /// When the timeout of `unacknowledged` started (sent, or restarted
    /// after a native picker closed).
    asked_at: Option<Instant>,
    /// A native sheet or modal panel held the timeout of `unacknowledged`
    /// when it ran out; it restarts once that closes.
    suspended: bool,
    /// The native "not responding" prompt is on screen.
    prompt_open: bool,
}

impl QuitTracker {
    fn forget_request(&mut self) {
        self.unacknowledged = None;
        self.asked_at = None;
        self.suspended = false;
    }
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
    /// ...and its timeout has run out (not suspended by a native picker).
    pub ack_overdue: bool,
    /// A native sheet or modal panel (open / save picker) is on screen.
    pub native_modal: bool,
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
    /// Prevent the exit; the pending request's timeout decides.
    Hold,
}

/// Pure exit policy.
///
/// * `code == None`: the last window was destroyed. The red close button
///   already ran the frontend guard (onCloseRequested), so allow.
/// * the restart code (updater), or a confirmed quit: allow.
/// * no frontend listening: allow, unless the core holds unsaved changes —
///   then ask natively rather than discard them silently.
/// * a previous request is still unacknowledged (repeat ⌘Q): ask natively
///   once its timeout ran out and no native picker is on screen (hung or
///   dead webview — never a dead ⌘Q); before that, hold: the request is
///   young or a picker is up, and the timeout still decides.
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
        Some(_) if inputs.awaiting_ack => {
            if inputs.ack_overdue && !inputs.native_modal {
                ExitDecision::AskNative
            } else {
                ExitDecision::Hold
            }
        }
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
    Hold,
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

    /// Run-loop side of `RunEvent::ExitRequested` at time `now`.
    /// `unsaved_in_core` is only called when no frontend listens (it locks
    /// the session), `native_modal` only for a repeat while a request is
    /// unacknowledged.
    pub fn on_exit_requested(
        &self,
        code: Option<i32>,
        now: Instant,
        unsaved_in_core: impl FnOnce() -> bool,
        native_modal: impl FnOnce() -> bool,
    ) -> ExitAction {
        let listening = self.listening.load(Ordering::SeqCst);
        let mut tracker = self.tracker();
        let awaiting_ack = tracker.unacknowledged.is_some();
        let ack_overdue = awaiting_ack
            && !tracker.suspended
            && tracker
                .asked_at
                .is_some_and(|asked| now.saturating_duration_since(asked) >= QUIT_ACK_TIMEOUT);
        let inputs = ExitInputs {
            code,
            confirmed: self.quit_confirmed.load(Ordering::SeqCst),
            listening,
            awaiting_ack,
            ack_overdue,
            native_modal: ack_overdue && native_modal(),
            unsaved_in_core: !listening && unsaved_in_core(),
        };
        match exit_decision(inputs) {
            ExitDecision::Allow => ExitAction::Allow,
            ExitDecision::AskNative => ExitAction::AskNative,
            ExitDecision::Hold => ExitAction::Hold,
            ExitDecision::AskFrontend => {
                tracker.next_id += 1;
                let request = tracker.next_id;
                tracker.unacknowledged = Some(request);
                tracker.asked_at = Some(now);
                tracker.suspended = false;
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
            tracker.forget_request();
        }
    }

    /// Timer side: true when `request` is still unacknowledged after the
    /// timeout, i.e. the shell should ask natively.
    pub fn ack_overdue(&self, request: u64) -> bool {
        self.tracker().unacknowledged == Some(request)
    }

    /// Timer side: a native picker is on screen while `request` is
    /// overdue. The webview may not get to answer until it closes, so a
    /// repeat ⌘Q holds instead of asking natively.
    pub fn suspend_ack_timeout(&self, request: u64) {
        let mut tracker = self.tracker();
        if tracker.unacknowledged == Some(request) {
            tracker.suspended = true;
        }
    }

    /// Timer side: the picker closed; `request` gets a fresh timeout from
    /// `now`.
    pub fn restart_ack_timeout(&self, request: u64, now: Instant) {
        let mut tracker = self.tracker();
        if tracker.unacknowledged == Some(request) {
            tracker.suspended = false;
            tracker.asked_at = Some(now);
        }
    }

    /// Claim the native prompt; false when it is already on screen.
    #[cfg(test)]
    pub fn begin_native_prompt(&self) -> bool {
        self.begin_native_prompt_for(None)
    }

    /// Claim the native prompt for an overdue `request`. Revalidated under
    /// the same lock that claims the prompt: the timer checks the request
    /// before asking AppKit about pickers (a main-thread round trip), and an
    /// acknowledgement landing in between must not still put "isn't
    /// responding" in front of a working app.
    pub fn begin_native_prompt_for(&self, request: Option<u64>) -> bool {
        let mut tracker = self.tracker();
        if tracker.prompt_open {
            return false;
        }
        if request.is_some_and(|request| tracker.unacknowledged != Some(request)) {
            return false;
        }
        tracker.prompt_open = true;
        true
    }

    /// The native prompt closed; `quit` is the user's answer. On Cancel the
    /// outstanding request is forgotten: the frontend may never answer it,
    /// and leaving it set would send every later ⌘Q straight to the native
    /// prompt, skipping the frontend's Save / Don't Save guard for good.
    /// The next ⌘Q asks the frontend again, with a fresh timeout.
    pub fn end_native_prompt(&self, quit: bool) {
        let mut tracker = self.tracker();
        tracker.prompt_open = false;
        if quit {
            drop(tracker);
            self.confirm_quit();
        } else {
            tracker.forget_request();
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
        self.tracker().forget_request();
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
    let action = state.on_exit_requested(
        code,
        Instant::now(),
        || {
            // try_lock: never block the main thread behind a long command; a
            // busy session is treated as possibly unsaved (ask, don't lose).
            app.state::<SharedSession>()
                .try_lock()
                .map(|session| session.has_unsaved_changes())
                .unwrap_or(true)
        },
        || native_modal_open(app),
    );
    match action {
        ExitAction::Allow => {}
        ExitAction::AskNative => {
            prevent_exit();
            prompt_quit_anyway(app, None);
        }
        ExitAction::Hold => {
            prevent_exit();
            reveal_main_window(app);
        }
        ExitAction::AskFrontend { request } => {
            prevent_exit();
            // A minimized or hidden window would show the unsaved sheet
            // where nobody can see it, making Quit look broken.
            reveal_main_window(app);
            let _ = app.emit(QUIT_REQUESTED_EVENT, request);
            let app = app.clone();
            std::thread::spawn(move || watch_quit_ack(&app, request));
        }
    }
}

/// Timer thread of quit request `request`: ask natively once it has gone
/// unacknowledged for [`QUIT_ACK_TIMEOUT`] — except while a native picker
/// is on screen. Then the timeout is suspended until the picker closes and
/// starts over, so a healthy app never gets the prompt behind its picker.
fn watch_quit_ack<R: Runtime>(app: &AppHandle<R>, request: u64) {
    let state = app.state::<LifecycleState>();
    loop {
        std::thread::sleep(QUIT_ACK_TIMEOUT);
        if !state.ack_overdue(request) {
            return;
        }
        if !native_modal_open(app) {
            prompt_quit_anyway(app, Some(request));
            return;
        }
        state.suspend_ack_timeout(request);
        while native_modal_open(app) {
            if !state.ack_overdue(request) {
                return;
            }
            std::thread::sleep(MODAL_POLL_INTERVAL);
        }
        state.restart_ack_timeout(request, Instant::now());
    }
}

/// A native sheet (the dialog plugin's open / save panels are sheets on the
/// main window) or an app-modal window is on screen. AppKit state, so it is
/// read on the main thread; from another thread a main thread that does not
/// answer within a second counts as busy with such a panel (nothing else
/// could be shown then anyway).
#[cfg(target_os = "macos")]
fn native_modal_open<R: Runtime>(app: &AppHandle<R>) -> bool {
    use objc2::MainThreadMarker;
    use objc2_app_kit::NSApplication;

    fn on_screen(mtm: MainThreadMarker) -> bool {
        let ns_app = NSApplication::sharedApplication(mtm);
        ns_app.modalWindow().is_some()
            || ns_app
                .windows()
                .iter()
                .any(|window| window.attachedSheet().is_some())
    }

    if let Some(mtm) = MainThreadMarker::new() {
        return on_screen(mtm);
    }
    let (tx, rx) = std::sync::mpsc::channel();
    let posted = app.run_on_main_thread(move || {
        if let Some(mtm) = MainThreadMarker::new() {
            let _ = tx.send(on_screen(mtm));
        }
    });
    posted.is_ok() && rx.recv_timeout(Duration::from_secs(1)).unwrap_or(true)
}

/// Elsewhere the dialog plugin's pickers are not sheets; never suspend.
#[cfg(not(target_os = "macos"))]
fn native_modal_open<R: Runtime>(_app: &AppHandle<R>) -> bool {
    false
}

/// Native last resort when the webview cannot answer: Quit / Cancel. At
/// most one prompt is on screen at a time. From the timer, `request` is the
/// overdue request; the prompt is skipped if it was answered meanwhile.
///
/// It is an `NSAlert` sheet on the main window, brought forward and
/// focused first, shown through the dialog plugin's non-blocking API, so
/// the run loop never waits on it. Without a parent window, rfd falls back
/// to `CFUserNotificationDisplayAlert`, a system alert owned by another
/// process that can end up behind other windows or never show at all.
fn prompt_quit_anyway<R: Runtime>(app: &AppHandle<R>, request: Option<u64>) {
    if !app
        .state::<LifecycleState>()
        .begin_native_prompt_for(request)
    {
        return;
    }
    reveal_main_window(app);
    let mut prompt = app
        .dialog()
        .message(UNRESPONSIVE_MESSAGE)
        .title(UNRESPONSIVE_TITLE)
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Quit".into(),
            "Cancel".into(),
        ));
    if let Some(window) = app.get_webview_window("main") {
        prompt = prompt.parent(&window);
    }
    let app = app.clone();
    prompt.show(move |quit| {
        app.state::<LifecycleState>().end_native_prompt(quit);
        if quit {
            app.exit(0);
        }
    });
}

/// Route ⌘Q to the guarded Quit before the webview sees it (macOS).
///
/// WKWebView offers ⌘-key equivalents to the page first and only hands
/// them back to the menu once the web content process answers. With a hung
/// or stopped web content process, ⌘Q would never reach the Quit item, and
/// so never reach the native fallback either. An AppKit local event monitor
/// runs before any window sees the key, so ⌘Q always takes the same path
/// as the Quit item: `app.exit(0)` → `RunEvent::ExitRequested`.
#[cfg(target_os = "macos")]
pub fn install_quit_key_monitor<R: Runtime>(app: &AppHandle<R>) {
    use std::ptr::{self, NonNull};

    use block2::RcBlock;
    use objc2_app_kit::{NSEvent, NSEventMask, NSEventModifierFlags};

    let app = app.clone();
    let handler = RcBlock::new(move |event: NonNull<NSEvent>| -> *mut NSEvent {
        // SAFETY: AppKit passes a valid event for the handler's duration.
        let key = unsafe { event.as_ref() };
        let modifiers = key.modifierFlags()
            & (NSEventModifierFlags::Command
                | NSEventModifierFlags::Shift
                | NSEventModifierFlags::Option
                | NSEventModifierFlags::Control);
        // The Q key by position (kVK_ANSI_Q) as well as by character, so
        // non-Latin layouts are covered too.
        const KEY_Q: u16 = 12;
        let is_quit = modifiers == NSEventModifierFlags::Command
            && (key.keyCode() == KEY_Q
                || key
                    .charactersIgnoringModifiers()
                    .is_some_and(|chars| chars.to_string().eq_ignore_ascii_case("q")));
        if is_quit {
            // Holding ⌘Q auto-repeats; one quit request per press.
            if !key.isARepeat() {
                app.exit(0);
            }
            ptr::null_mut()
        } else {
            event.as_ptr()
        }
    });
    // SAFETY: the handler returns the event it was given or null.
    let monitor = unsafe {
        NSEvent::addLocalMonitorForEventsMatchingMask_handler(NSEventMask::KeyDown, &handler)
    };
    // The monitor lives as long as the app.
    std::mem::forget(monitor);
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

    /// ⌘Q at `at`, no native picker on screen.
    fn quit(state: &LifecycleState, at: Instant, unsaved: bool) -> ExitAction {
        state.on_exit_requested(Some(0), at, || unsaved, || false)
    }

    /// `at` plus the ack timeout: the pending request is overdue.
    fn later(at: Instant) -> Instant {
        at + QUIT_ACK_TIMEOUT
    }

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
    fn an_overdue_request_escalates_to_the_native_prompt() {
        let pending = ExitInputs {
            awaiting_ack: true,
            ..inputs(Some(0))
        };
        // Still within its timeout: the timer decides, not the repeat.
        assert_eq!(exit_decision(pending), ExitDecision::Hold);
        let overdue = ExitInputs {
            ack_overdue: true,
            ..pending
        };
        assert_eq!(exit_decision(overdue), ExitDecision::AskNative);
        // A native picker is up: the webview may not answer until it closes.
        let behind_picker = ExitInputs {
            native_modal: true,
            ..overdue
        };
        assert_eq!(exit_decision(behind_picker), ExitDecision::Hold);
    }

    #[test]
    fn a_quick_repeat_waits_for_the_timeout_then_asks_natively() {
        let state = LifecycleState::default();
        let t0 = Instant::now();
        state.take_pending();
        assert_eq!(
            quit(&state, t0, false),
            ExitAction::AskFrontend { request: 1 }
        );
        // ⌘Q again before the webview had its 2 s: held, no prompt.
        assert_eq!(quit(&state, t0, false), ExitAction::Hold);
        // Hung webview: still no ack once the timeout ran out.
        assert_eq!(quit(&state, later(t0), false), ExitAction::AskNative);
        assert!(state.ack_overdue(1));
    }

    #[test]
    fn a_native_picker_suspends_the_ack_timeout() {
        let state = LifecycleState::default();
        let t0 = Instant::now();
        state.take_pending();
        assert_eq!(
            quit(&state, t0, false),
            ExitAction::AskFrontend { request: 1 }
        );
        // Overdue, but a picker is on screen: a repeat holds.
        assert_eq!(
            state.on_exit_requested(Some(0), later(t0), || false, || true),
            ExitAction::Hold
        );
        // The timer saw the picker and suspended the timeout: still held,
        // even once AppKit no longer reports it (the timer restarts it).
        state.suspend_ack_timeout(1);
        assert_eq!(quit(&state, later(later(t0)), false), ExitAction::Hold);
        // Picker closed at t1: a fresh timeout from there.
        let t1 = later(later(t0));
        state.restart_ack_timeout(1, t1);
        assert_eq!(quit(&state, t1, false), ExitAction::Hold);
        assert_eq!(quit(&state, later(t1), false), ExitAction::AskNative);
        // The (now responsive) webview answers: nothing is pending.
        state.acknowledge(1);
        assert!(!state.ack_overdue(1));
        assert_eq!(
            quit(&state, later(t1), false),
            ExitAction::AskFrontend { request: 2 }
        );
    }

    #[test]
    fn suspending_or_restarting_a_stale_request_changes_nothing() {
        let state = LifecycleState::default();
        let t0 = Instant::now();
        state.take_pending();
        assert_eq!(
            quit(&state, t0, false),
            ExitAction::AskFrontend { request: 1 }
        );
        state.acknowledge(1);
        assert_eq!(
            quit(&state, t0, false),
            ExitAction::AskFrontend { request: 2 }
        );
        state.suspend_ack_timeout(1);
        state.restart_ack_timeout(1, later(t0));
        assert_eq!(quit(&state, later(t0), false), ExitAction::AskNative);
    }

    #[test]
    fn acknowledged_requests_do_not_time_out() {
        let state = LifecycleState::default();
        let t0 = Instant::now();
        state.take_pending();
        let ExitAction::AskFrontend { request } = quit(&state, t0, false) else {
            panic!("expected a frontend request");
        };
        state.acknowledge(request);
        assert!(!state.ack_overdue(request));
        // Guard sheet still up, ⌘Q again: the (alive) frontend is asked again.
        assert_eq!(
            quit(&state, t0, false),
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
        let t0 = Instant::now();
        state.take_pending();
        assert!(matches!(
            quit(&state, t0, false),
            ExitAction::AskFrontend { .. }
        ));
        // Page reload / unmount: the outstanding request is void.
        state.detach_frontend();
        assert!(!state.ack_overdue(1));
        assert_eq!(quit(&state, t0, false), ExitAction::Allow);
        assert_eq!(quit(&state, t0, true), ExitAction::AskNative);
        // Listening again after remount.
        state.take_pending();
        assert!(matches!(
            quit(&state, t0, true),
            ExitAction::AskFrontend { .. }
        ));
    }

    #[test]
    fn the_session_is_only_consulted_without_a_listener() {
        let state = LifecycleState::default();
        state.take_pending();
        let action = state.on_exit_requested(
            Some(0),
            Instant::now(),
            || panic!("session must not be locked"),
            || panic!("no repeat: AppKit must not be queried"),
        );
        assert!(matches!(action, ExitAction::AskFrontend { .. }));
    }

    #[test]
    fn only_one_native_prompt_at_a_time_and_quit_confirms() {
        let state = LifecycleState::default();
        let t0 = Instant::now();
        state.take_pending();
        assert!(state.begin_native_prompt());
        assert!(!state.begin_native_prompt());
        state.end_native_prompt(false);
        assert!(matches!(
            quit(&state, t0, false),
            ExitAction::AskFrontend { .. }
        ));
        assert!(state.begin_native_prompt());
        state.end_native_prompt(true);
        assert_eq!(quit(&state, t0, false), ExitAction::Allow);
    }

    #[test]
    fn an_acknowledged_request_cannot_claim_the_native_prompt() {
        let state = LifecycleState::default();
        state.take_pending();
        let start = Instant::now();
        let ExitAction::AskFrontend { request } = quit(&state, start, true) else {
            panic!("expected the frontend to be asked");
        };
        // The ack lands while the timer is asking AppKit about pickers.
        state.acknowledge(request);
        assert!(!state.begin_native_prompt_for(Some(request)));
        // Still free for a genuine prompt afterwards.
        assert!(state.begin_native_prompt());
    }

    #[test]
    fn cancelling_the_native_prompt_asks_the_frontend_again() {
        let state = LifecycleState::default();
        let t0 = Instant::now();
        state.take_pending();
        // A quit the frontend never acknowledges (queued behind a stuck
        // operation), then a repeat ⌘Q after the timeout: the native prompt.
        assert_eq!(
            quit(&state, t0, false),
            ExitAction::AskFrontend { request: 1 }
        );
        assert_eq!(quit(&state, later(t0), false), ExitAction::AskNative);
        assert!(state.begin_native_prompt());
        state.end_native_prompt(false);
        // Cancel: the stale request no longer counts, so the next ⌘Q goes to
        // the frontend's guard with its own timeout instead of straight to
        // the native prompt.
        assert!(!state.ack_overdue(1));
        assert_eq!(
            quit(&state, t0, false),
            ExitAction::AskFrontend { request: 2 }
        );
        assert!(state.ack_overdue(2));
        // A late ack of the forgotten request changes nothing about the new one.
        state.acknowledge(1);
        assert!(state.ack_overdue(2));
        // …and still escalates if that one goes unanswered too.
        assert_eq!(quit(&state, later(t0), false), ExitAction::AskNative);
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
        let t0 = Instant::now();
        state.take_pending();
        assert!(matches!(
            quit(&state, t0, false),
            ExitAction::AskFrontend { .. }
        ));
        state.confirm_quit();
        assert_eq!(quit(&state, t0, false), ExitAction::Allow);
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
