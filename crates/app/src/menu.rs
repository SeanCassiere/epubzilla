//! Native application menu (issue #74): the discoverable, platform-styled
//! home of the keyboard shortcuts. Item ids double as the frontend
//! `ShortcutAction` names — activation is forwarded verbatim as one
//! `app-menu` event (lib.rs) and lib/menu.ts maps it onto the same action
//! bus the DOM keyboard shortcuts use, so both paths share one code path
//! (and a dedupe window absorbs platforms where an accelerator also
//! reaches the webview as a key event).
//!
//! Book lifecycle additions: File ▸ Open Recent (rebuilt whenever the
//! recents list changes, items carry their path in the id), File ▸ Close
//! Book (⌘W), a custom Quit item (the predefined one sends `terminate:`,
//! which exits without giving the unsaved-changes guard a chance), and
//! per-state enablement driven by the frontend via `set_menu_state`.
//!
//! On macOS a standard Window menu (Minimize, Zoom, Bring All to Front) is
//! registered as the app's windows menu, so AppKit lists the open window by
//! its title there.

use std::collections::HashMap;

use serde::Deserialize;
use tauri::menu::{Menu, MenuItem, MenuItemBuilder, PredefinedMenuItem, Submenu, SubmenuBuilder};
use tauri::{AppHandle, Runtime};

use crate::recents::recent_labels;

/// Id prefix for File ▸ Open Recent entries; the rest of the id is the path.
pub const OPEN_RECENT_PREFIX: &str = "open-recent:";
/// File ▸ Open Recent ▸ Clear Menu.
pub const CLEAR_RECENT_ID: &str = "clear-recent";
/// The custom (guarded) Quit item.
pub const QUIT_ID: &str = "quit";

/// Handles kept after building so items can be enabled/disabled and the
/// Open Recent submenu rebuilt at runtime.
pub struct MenuHandles<R: Runtime> {
    pub open_recent: Submenu<R>,
    pub items: HashMap<&'static str, MenuItem<R>>,
    /// The Window menu, registered with AppKit once the menu is installed
    /// (`register_window_menu`).
    #[cfg(target_os = "macos")]
    pub window: Submenu<R>,
}

/// Document state the frontend reports (`set_menu_state`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MenuState {
    /// A book is open (not the welcome state).
    pub has_book: bool,
    /// The open book can be modified and saved (EPUB 3).
    pub editable: bool,
    /// A lifecycle operation or modal decision is pending.
    pub busy: bool,
}

/// Which item ids are enabled for `state`. Pure, so it is unit-tested
/// without a menu; `apply_state` pushes the result to the native items.
pub fn enablement(state: MenuState) -> Vec<(&'static str, bool)> {
    let MenuState {
        has_book,
        editable,
        busy,
    } = state;
    vec![
        ("new-book", !busy),
        ("open-book", !busy),
        ("close-book", has_book && !busy),
        ("save", has_book && editable && !busy),
        ("save-as", has_book && editable && !busy),
        ("toggle-edit", has_book && editable && !busy),
        // Navigation and panel focus would act behind (or pull focus out
        // of) a pending decision, so they follow `busy` too.
        ("prev-chapter", has_book && !busy),
        ("next-chapter", has_book && !busy),
        ("sidebar-contents", has_book && !busy),
        ("sidebar-chapters", has_book && !busy),
        ("sidebar-checks", has_book && !busy),
    ]
}

/// One app menu item: id (== frontend action), label, accelerator.
fn item<R: Runtime>(
    app: &AppHandle<R>,
    items: &mut HashMap<&'static str, MenuItem<R>>,
    id: &'static str,
    label: &str,
    accelerator: &str,
) -> tauri::Result<MenuItem<R>> {
    let built = MenuItemBuilder::with_id(id, label)
        .accelerator(accelerator)
        .build(app)?;
    items.insert(id, built.clone());
    Ok(built)
}

fn quit_item<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<MenuItem<R>> {
    MenuItemBuilder::with_id(QUIT_ID, "Quit epubzilla")
        .accelerator("CmdOrCtrl+Q")
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
        .item(&quit_item(app)?)
        .build()
}

/// (Re)fill File ▸ Open Recent: one item per path (id carries the path),
/// a separator, then Clear Menu (disabled when there is nothing to clear).
pub fn fill_open_recent<R: Runtime>(
    app: &AppHandle<R>,
    submenu: &Submenu<R>,
    paths: &[String],
) -> tauri::Result<()> {
    for existing in submenu.items()? {
        submenu.remove(&existing)?;
    }
    if paths.is_empty() {
        let none = MenuItemBuilder::with_id("open-recent-none", "No Recent Books")
            .enabled(false)
            .build(app)?;
        submenu.append(&none)?;
    }
    for (path, label) in paths.iter().zip(recent_labels(paths)) {
        let entry =
            MenuItemBuilder::with_id(format!("{OPEN_RECENT_PREFIX}{path}"), label).build(app)?;
        submenu.append(&entry)?;
    }
    submenu.append(&PredefinedMenuItem::separator(app)?)?;
    let clear = MenuItemBuilder::with_id(CLEAR_RECENT_ID, "Clear Menu")
        .enabled(!paths.is_empty())
        .build(app)?;
    submenu.append(&clear)?;
    Ok(())
}

fn file_submenu<R: Runtime>(
    app: &AppHandle<R>,
    items: &mut HashMap<&'static str, MenuItem<R>>,
    recents: &[String],
) -> tauri::Result<(Submenu<R>, Submenu<R>)> {
    let open_recent = SubmenuBuilder::new(app, "Open Recent").build()?;
    fill_open_recent(app, &open_recent, recents)?;
    let builder = SubmenuBuilder::new(app, "File")
        .item(&item(app, items, "new-book", "New Book…", "CmdOrCtrl+N")?)
        .item(&item(app, items, "open-book", "Open Book…", "CmdOrCtrl+O")?)
        .item(&open_recent)
        .separator()
        .item(&item(
            app,
            items,
            "close-book",
            "Close Book",
            "CmdOrCtrl+W",
        )?)
        .item(&item(app, items, "save", "Save", "CmdOrCtrl+S")?)
        .item(&item(
            app,
            items,
            "save-as",
            "Save As…",
            "CmdOrCtrl+Shift+S",
        )?);
    // Quit lives in the app submenu on macOS, at the bottom of File elsewhere.
    #[cfg(not(target_os = "macos"))]
    let builder = builder.separator().item(&quit_item(app)?);
    Ok((builder.build()?, open_recent))
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

fn view_submenu<R: Runtime>(
    app: &AppHandle<R>,
    items: &mut HashMap<&'static str, MenuItem<R>>,
) -> tauri::Result<Submenu<R>> {
    SubmenuBuilder::new(app, "View")
        .item(&item(
            app,
            items,
            "toggle-edit",
            "Toggle Editor",
            "CmdOrCtrl+E",
        )?)
        .separator()
        .item(&item(
            app,
            items,
            "prev-chapter",
            "Previous Chapter",
            "CmdOrCtrl+Alt+Left",
        )?)
        .item(&item(
            app,
            items,
            "next-chapter",
            "Next Chapter",
            "CmdOrCtrl+Alt+Right",
        )?)
        .separator()
        .item(&item(
            app,
            items,
            "cycle-theme",
            "Cycle Reading Theme",
            "CmdOrCtrl+Shift+T",
        )?)
        .separator()
        .item(&item(
            app,
            items,
            "sidebar-contents",
            "Show Contents",
            "CmdOrCtrl+1",
        )?)
        .item(&item(
            app,
            items,
            "sidebar-chapters",
            "Show Chapters",
            "CmdOrCtrl+2",
        )?)
        .item(&item(
            app,
            items,
            "sidebar-checks",
            "Show Checks",
            "CmdOrCtrl+3",
        )?)
        .build()
}

/// Standard macOS Window menu from predefined items (Minimize ⌘M, Zoom,
/// Bring All to Front). AppKit appends the window list once it is the app's
/// windows menu.
#[cfg(target_os = "macos")]
fn window_submenu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Submenu<R>> {
    SubmenuBuilder::new(app, "Window")
        .minimize()
        .maximize()
        .separator()
        .bring_all_to_front()
        .build()
}

/// Make the Window menu AppKit's windows menu (`NSApp.windowsMenu`), which
/// lists the open windows by title. Call after the menu was installed as
/// the app menu; no-op elsewhere.
pub fn register_window_menu<R: Runtime>(handles: &MenuHandles<R>) -> tauri::Result<()> {
    #[cfg(target_os = "macos")]
    handles.window.set_as_windows_menu_for_nsapp()?;
    #[cfg(not(target_os = "macos"))]
    let _ = handles;
    Ok(())
}

/// Build the full application menu, plus the handles needed to update it.
pub fn build<R: Runtime>(
    app: &AppHandle<R>,
    recents: &[String],
) -> tauri::Result<(Menu<R>, MenuHandles<R>)> {
    let mut items = HashMap::new();
    let menu = Menu::new(app)?;
    #[cfg(target_os = "macos")]
    menu.append(&app_submenu(app)?)?;
    let (file, open_recent) = file_submenu(app, &mut items, recents)?;
    menu.append(&file)?;
    menu.append(&edit_submenu(app)?)?;
    menu.append(&view_submenu(app, &mut items)?)?;
    #[cfg(target_os = "macos")]
    let window = window_submenu(app)?;
    #[cfg(target_os = "macos")]
    menu.append(&window)?;
    let handles = MenuHandles {
        open_recent,
        items,
        #[cfg(target_os = "macos")]
        window,
    };
    // Launch state: welcome, nothing open.
    apply_state(&handles, MenuState::default())?;
    Ok((menu, handles))
}

/// Push `state`'s enablement to the native items.
pub fn apply_state<R: Runtime>(handles: &MenuHandles<R>, state: MenuState) -> tauri::Result<()> {
    for (id, enabled) in enablement(state) {
        if let Some(item) = handles.items.get(id) {
            item.set_enabled(enabled)?;
        }
    }
    handles.open_recent.set_enabled(!state.busy)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn enabled(state: MenuState, id: &str) -> bool {
        enablement(state)
            .into_iter()
            .find(|(i, _)| *i == id)
            .map(|(_, e)| e)
            .unwrap_or_else(|| panic!("no item {id}"))
    }

    #[test]
    fn welcome_state_disables_book_items() {
        let welcome = MenuState::default();
        assert!(enabled(welcome, "new-book"));
        assert!(enabled(welcome, "open-book"));
        for id in [
            "close-book",
            "save",
            "save-as",
            "toggle-edit",
            "next-chapter",
        ] {
            assert!(!enabled(welcome, id), "{id} should be disabled");
        }
    }

    #[test]
    fn epub2_is_read_only() {
        let epub2 = MenuState {
            has_book: true,
            editable: false,
            busy: false,
        };
        assert!(enabled(epub2, "close-book"));
        assert!(enabled(epub2, "next-chapter"));
        assert!(!enabled(epub2, "save"));
        assert!(!enabled(epub2, "save-as"));
        assert!(!enabled(epub2, "toggle-edit"));
    }

    #[test]
    fn busy_blocks_lifecycle_and_navigation_items() {
        let busy = MenuState {
            has_book: true,
            editable: true,
            busy: true,
        };
        for id in [
            "new-book",
            "open-book",
            "close-book",
            "save",
            "save-as",
            "toggle-edit",
            "prev-chapter",
            "next-chapter",
            "sidebar-contents",
            "sidebar-chapters",
            "sidebar-checks",
        ] {
            assert!(!enabled(busy, id), "{id} should be disabled while busy");
        }
    }

    #[test]
    fn menu_state_deserializes_from_camel_case() {
        let state: MenuState =
            serde_json::from_str(r#"{"hasBook":true,"editable":true,"busy":false}"#).unwrap();
        assert_eq!(
            state,
            MenuState {
                has_book: true,
                editable: true,
                busy: false
            }
        );
    }
}
