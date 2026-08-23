//! Tauri shell for epubzilla: the core-api.md command surface over a shared
//! `epubzilla_core::Session` and the `epub://` asset protocol for chapter
//! resources.

mod commands;
mod protocol;

use std::sync::Mutex;

use commands::SharedSession;
use epubzilla_core::Session;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
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
            commands::validate,
        ])
        .register_uri_scheme_protocol("epub", |ctx, request| {
            let session = ctx.app_handle().state::<SharedSession>();
            protocol::handle_request(&session, &request.uri().to_string())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
