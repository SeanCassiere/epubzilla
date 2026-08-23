//! Native application menu (issue #74): the discoverable, platform-styled
//! home of the keyboard shortcuts. Item ids double as the frontend
//! `ShortcutAction` names — activation is forwarded verbatim as one
//! `app-menu` event (lib.rs) and lib/menu.ts maps it onto the same action
//! bus the DOM keydown shortcuts use, so both paths share one code path
//! (and a dedupe window absorbs platforms where an accelerator also
//! reaches the webview as a key event).

use tauri::menu::{Menu, MenuItemBuilder, Submenu, SubmenuBuilder};
use tauri::{AppHandle, Runtime};

/// One app menu item: id (== frontend action), label, accelerator.
fn item<R: Runtime>(
    app: &AppHandle<R>,
    id: &str,
    label: &str,
    accelerator: &str,
) -> tauri::Result<tauri::menu::MenuItem<R>> {
    MenuItemBuilder::with_id(id, label)
        .accelerator(accelerator)
        .build(app)
}

/// The macOS application submenu (About/Hide/Quit). Other platforms put
/// Quit at the bottom of File instead.
#[cfg(target_os = "macos")]
fn app_submenu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Submenu<R>> {
    SubmenuBuilder::new(app, "epubzilla")
        .about(None)
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()
}

fn file_submenu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Submenu<R>> {
    let builder = SubmenuBuilder::new(app, "File")
        .item(&item(app, "new-book", "New Book…", "CmdOrCtrl+N")?)
        .item(&item(app, "open-book", "Open Book…", "CmdOrCtrl+O")?)
        .separator()
        .item(&item(app, "save", "Save", "CmdOrCtrl+S")?)
        .item(&item(app, "save-as", "Save As…", "CmdOrCtrl+Shift+S")?);
    // Quit lives in the app submenu on macOS, at the bottom of File elsewhere.
    #[cfg(not(target_os = "macos"))]
    let builder = builder.separator().quit();
    builder.build()
}

/// Standard Edit menu: predefined items so the webview's clipboard and
/// undo shortcuts (Cmd+C/V/X/Z/A) work natively, especially on macOS
/// where they only route through the menu.
fn edit_submenu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Submenu<R>> {
    SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()
}

fn view_submenu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Submenu<R>> {
    SubmenuBuilder::new(app, "View")
        .item(&item(app, "toggle-edit", "Toggle Editor", "CmdOrCtrl+E")?)
        .separator()
        .item(&item(
            app,
            "prev-chapter",
            "Previous Chapter",
            "CmdOrCtrl+Alt+Left",
        )?)
        .item(&item(
            app,
            "next-chapter",
            "Next Chapter",
            "CmdOrCtrl+Alt+Right",
        )?)
        .separator()
        .item(&item(
            app,
            "toggle-layout",
            "Toggle Reading Layout",
            "CmdOrCtrl+Shift+L",
        )?)
        .item(&item(
            app,
            "cycle-theme",
            "Cycle Reading Theme",
            "CmdOrCtrl+Shift+T",
        )?)
        .separator()
        .item(&item(
            app,
            "sidebar-contents",
            "Show Contents",
            "CmdOrCtrl+1",
        )?)
        .item(&item(
            app,
            "sidebar-chapters",
            "Show Chapters",
            "CmdOrCtrl+2",
        )?)
        .item(&item(app, "sidebar-checks", "Show Checks", "CmdOrCtrl+3")?)
        .build()
}

/// Build the full application menu.
pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let menu = Menu::new(app)?;
    #[cfg(target_os = "macos")]
    menu.append(&app_submenu(app)?)?;
    menu.append(&file_submenu(app)?)?;
    menu.append(&edit_submenu(app)?)?;
    menu.append(&view_submenu(app)?)?;
    Ok(menu)
}
