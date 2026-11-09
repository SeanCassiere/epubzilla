//! Shell side of the book lifecycle: guarded Quit, Finder / Open With
//! file-open requests, recent-books commands, and native menu state.
//!
//! The frontend owns the unsaved-changes guard. The shell's job is to give
//! it a chance to run: exits requested from the app (custom Quit item,
//! ⌘Q) are held until the frontend confirms via `quit_app`, and files
//! handed to the app by the OS are delivered as one `open-files` event, or
//! parked until the frontend asks for them on mount
//! (`take_pending_open_paths`) when they arrive before the webview is up.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager, Runtime, Url};

use crate::menu::{self, MenuHandles, MenuState};
use crate::recents::SharedRecents;

/// Frontend event: the user asked to quit; run the guard, then `quit_app`.
pub const QUIT_REQUESTED_EVENT: &str = "app-quit-requested";
/// Frontend event: the OS (or Open Recent) asked to open these paths.
pub const OPEN_FILES_EVENT: &str = "open-files";
/// Frontend event: the recent-books list changed (payload: the new list).
pub const RECENTS_CHANGED_EVENT: &str = "recent-books-changed";

/// Process-wide lifecycle flags shared between the run loop and commands.
#[derive(Debug, Default)]
pub struct LifecycleState {
    /// Set once the frontend has mounted and fetched pending paths; until
    /// then events would be lost, so paths are parked and exits allowed.
    frontend_ready: AtomicBool,
    /// Set by `quit_app` after the guard passed: the next exit request goes
    /// through.
    quit_confirmed: AtomicBool,
    /// OS open requests that arrived before the frontend was ready.
    pending_open: Mutex<Vec<String>>,
}

/// What to do with a `RunEvent::ExitRequested`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExitDecision {
    /// Let the app exit.
    Allow,
    /// Prevent the exit and ask the frontend to run its guard.
    AskFrontend,
}

/// Pure exit policy.
///
/// * `code == None`: the last window was destroyed. The red close button
///   already ran the frontend guard (onCloseRequested), so allow.
/// * the restart code (updater): allow.
/// * otherwise (Quit item / ⌘Q via `AppHandle::exit`): allow only once the
///   frontend confirmed, or when no frontend is listening (never strand the
///   user in an app that cannot quit).
pub fn exit_decision(code: Option<i32>, confirmed: bool, frontend_ready: bool) -> ExitDecision {
    match code {
        None => ExitDecision::Allow,
        Some(tauri::RESTART_EXIT_CODE) => ExitDecision::Allow,
        Some(_) if confirmed || !frontend_ready => ExitDecision::Allow,
        Some(_) => ExitDecision::AskFrontend,
    }
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
    /// Run-loop side of `RunEvent::ExitRequested`.
    pub fn on_exit_requested(&self, code: Option<i32>) -> ExitDecision {
        exit_decision(
            code,
            self.quit_confirmed.load(Ordering::SeqCst),
            self.frontend_ready.load(Ordering::SeqCst),
        )
    }

    /// Either hand `paths` back for immediate delivery (frontend ready) or
    /// park them for `take_pending_open_paths`. Returns the paths to emit.
    pub fn route_open(&self, paths: Vec<String>) -> Option<Vec<String>> {
        if paths.is_empty() {
            return None;
        }
        if self.frontend_ready.load(Ordering::SeqCst) {
            Some(paths)
        } else {
            if let Ok(mut pending) = self.pending_open.lock() {
                pending.extend(paths);
            }
            None
        }
    }

    /// Mark the frontend ready and drain anything parked before it was.
    pub fn take_pending(&self) -> Vec<String> {
        self.frontend_ready.store(true, Ordering::SeqCst);
        self.pending_open
            .lock()
            .map(|mut pending| std::mem::take(&mut *pending))
            .unwrap_or_default()
    }

    fn confirm_quit(&self) {
        self.quit_confirmed.store(true, Ordering::SeqCst);
    }
}

/// Deliver OS open requests (macOS `RunEvent::Opened`, Open Recent): emit
/// to a ready frontend and bring the window forward, or park them.
pub fn deliver_open_paths<R: Runtime>(app: &AppHandle<R>, paths: Vec<String>) {
    let state = app.state::<LifecycleState>();
    if let Some(paths) = state.route_open(paths) {
        let _ = app.emit(OPEN_FILES_EVENT, paths);
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
        }
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

/// Called once by the frontend on mount: marks it ready for live
/// `open-files` / `app-quit-requested` events and returns parked paths.
#[tauri::command]
pub fn take_pending_open_paths(state: tauri::State<'_, LifecycleState>) -> Vec<String> {
    state.take_pending()
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

    #[test]
    fn closing_the_last_window_exits() {
        assert_eq!(exit_decision(None, false, true), ExitDecision::Allow);
    }

    #[test]
    fn quit_waits_for_the_frontend_guard() {
        assert_eq!(
            exit_decision(Some(0), false, true),
            ExitDecision::AskFrontend
        );
        assert_eq!(exit_decision(Some(0), true, true), ExitDecision::Allow);
    }

    #[test]
    fn quit_is_never_blocked_without_a_frontend_or_on_restart() {
        assert_eq!(exit_decision(Some(0), false, false), ExitDecision::Allow);
        assert_eq!(
            exit_decision(Some(tauri::RESTART_EXIT_CODE), false, true),
            ExitDecision::Allow
        );
    }

    #[test]
    fn open_requests_park_until_the_frontend_is_ready() {
        let state = LifecycleState::default();
        assert_eq!(state.route_open(vec!["/a.epub".into()]), None);
        assert_eq!(state.route_open(vec![]), None);
        assert_eq!(state.take_pending(), vec!["/a.epub".to_string()]);
        // Ready now: delivered immediately, nothing parked.
        assert_eq!(
            state.route_open(vec!["/b.epub".into()]),
            Some(vec!["/b.epub".to_string()])
        );
        assert!(state.take_pending().is_empty());
    }

    #[test]
    fn quit_confirmation_flips_the_decision() {
        let state = LifecycleState::default();
        state.take_pending();
        assert_eq!(state.on_exit_requested(Some(0)), ExitDecision::AskFrontend);
        state.confirm_quit();
        assert_eq!(state.on_exit_requested(Some(0)), ExitDecision::Allow);
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
