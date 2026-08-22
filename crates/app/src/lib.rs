//! Tauri shell for epubzilla: the reader commands over a shared
//! `epubzilla_core::Session` (core-api.md) and the `epub://` asset protocol
//! for chapter resources. Mutation commands land with M2.

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
        ])
        .register_uri_scheme_protocol("epub", |ctx, request| {
            let session = ctx.app_handle().state::<SharedSession>();
            protocol::handle_request(&session, &request.uri().to_string())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
