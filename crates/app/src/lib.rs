//! Tauri shell for epubzilla: the core-api.md command surface over a shared
//! `epubzilla_core::Session` and the `epub://` asset protocol for chapter
//! resources.

mod commands;
mod menu;
mod protocol;

use std::sync::Mutex;

use commands::SharedSession;
use epubzilla_core::Session;
use tauri::{Emitter, Manager};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        // Native menu with accelerators (issue #74). Activations forward
        // the item id to the webview; lib/menu.ts routes them onto the
        // same action bus as the DOM keyboard shortcuts.
        .setup(|app| {
            let menu = menu::build(app.handle())?;
            app.set_menu(menu)?;
            Ok(())
        })
        .on_menu_event(|app, event| {
            let _ = app.emit("app-menu", event.id().0.clone());
        })
        .manage(Mutex::new(Session::new()) as SharedSession)
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
        ])
        .register_uri_scheme_protocol("epub", |ctx, request| {
            let session = ctx.app_handle().state::<SharedSession>();
            protocol::handle_request(&session, &request.uri().to_string())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
