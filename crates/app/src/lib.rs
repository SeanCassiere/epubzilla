//! Tauri shell for epubzilla: the core-api.md command surface over a shared
//! `epubzilla_core::Session` and the `epub://` asset protocol for chapter
//! resources.

mod commands;
mod lifecycle;
mod menu;
mod protocol;
mod recents;

use std::sync::Mutex;

use commands::SharedSession;
use epubzilla_core::Session;
use lifecycle::LifecycleState;
use recents::{RecentBooks, SharedRecents, RECENTS_FILE};
use tauri::webview::PageLoadEvent;
use tauri::{Emitter, Manager};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        // Native menu with accelerators (issue #74). Activations forward
        // the item id to the webview; lib/menu.ts routes them onto the
        // same action bus as the DOM keyboard shortcuts. Open Recent needs
        // the persisted list, so the recents store is loaded first.
        .setup(|app| {
            let recents = match app.path().app_data_dir() {
                Ok(dir) => RecentBooks::load(dir.join(RECENTS_FILE)),
                Err(_) => RecentBooks::in_memory(),
            };
            let (menu, handles) = menu::build(app.handle(), recents.entries())?;
            app.set_menu(menu)?;
            app.manage(handles);
            app.manage(Mutex::new(recents) as SharedRecents);
            Ok(())
        })
        .on_menu_event(|app, event| {
            let id = event.id().0.as_str();
            if let Some(path) = id.strip_prefix(menu::OPEN_RECENT_PREFIX) {
                // Same route as Finder opens: the frontend's guarded
                // lifecycle controller decides what happens.
                lifecycle::deliver_open_paths(app, vec![path.to_owned()]);
            } else if id == menu::CLEAR_RECENT_ID {
                lifecycle::change_recents(app, |store| store.clear());
            } else if id == menu::QUIT_ID {
                // Goes through RunEvent::ExitRequested below, which holds
                // the exit until the frontend's unsaved-changes guard runs.
                app.exit(0);
            } else {
                let _ = app.emit("app-menu", id.to_owned());
            }
        })
        // Frontend liveness: a (re)loading page has no listeners until it
        // registers again via take_pending_open_paths.
        .on_page_load(|webview, payload| {
            if payload.event() == PageLoadEvent::Started {
                webview.state::<LifecycleState>().detach_frontend();
            }
        })
        .manage(Mutex::new(Session::new()) as SharedSession)
        .manage(LifecycleState::default())
        .invoke_handler(tauri::generate_handler![
            commands::open_book,
            commands::get_book,
            commands::read_chapter,
            commands::read_resource,
            commands::close_book,
            commands::create_book,
            commands::save_book,
            commands::write_chapter,
            commands::update_metadata,
            commands::add_chapter,
            commands::remove_chapter,
            commands::reorder_spine,
            commands::add_resource_from_path,
            commands::add_resource_from_bytes,
            commands::set_cover,
            commands::set_cover_from_path,
            commands::validate,
            lifecycle::list_recent_books,
            lifecycle::add_recent_book,
            lifecycle::remove_recent_book,
            lifecycle::clear_recent_books,
            lifecycle::take_pending_open_paths,
            lifecycle::detach_frontend,
            lifecycle::ack_quit_request,
            lifecycle::quit_app,
            lifecycle::set_menu_state,
        ])
        .register_uri_scheme_protocol("epub", |ctx, request| {
            let session = ctx.app_handle().state::<SharedSession>();
            protocol::handle_request(&session, &request.uri().to_string())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app, event| match event {
        tauri::RunEvent::ExitRequested { code, api, .. } => {
            lifecycle::handle_exit_request(app, code, || api.prevent_exit());
        }
        // Finder double-click / Open With / drop on the Dock icon (macOS).
        #[cfg(any(target_os = "macos", target_os = "ios"))]
        tauri::RunEvent::Opened { urls } => {
            lifecycle::deliver_open_paths(app, lifecycle::file_urls_to_paths(&urls));
        }
        _ => {}
    });
}
