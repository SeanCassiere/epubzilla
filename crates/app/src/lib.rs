//! Tauri shell for epubzilla. Commands wrapping `epubzilla_core::Session`
//! land with M1.2 (#26); this is the bare application scaffold.

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
