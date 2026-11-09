//! Recent books (File ▸ Open Recent and the welcome panel's list).
//!
//! The Rust shell owns the list because the native Open Recent submenu has
//! to exist before (and independently of) the webview. It is one small JSON
//! array of OS paths under the app data directory: newest first,
//! deduplicated, at most [`MAX_RECENTS`] entries. The frontend reads and
//! updates it through the `*_recent_book(s)` commands; every change rebuilds
//! the submenu and emits `recent-books-changed` so both views agree.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// How many books Open Recent remembers (matches Pages / Preview).
pub const MAX_RECENTS: usize = 10;

/// File name of the persisted list inside the app data directory.
pub const RECENTS_FILE: &str = "recent-books.json";

/// The managed recents store.
pub type SharedRecents = Mutex<RecentBooks>;

/// Move `path` to the front of `list`, removing any older copy, and keep at
/// most [`MAX_RECENTS`] entries. Blank paths are ignored.
pub fn push_recent(list: &mut Vec<String>, path: &str) {
    if path.trim().is_empty() {
        return;
    }
    list.retain(|p| p != path);
    list.insert(0, path.to_owned());
    list.truncate(MAX_RECENTS);
}

/// Parse a persisted list, tolerating a missing, corrupt, or oversized file
/// (history is a convenience: a bad file must never stop the app starting).
pub fn parse_recents(json: &str) -> Vec<String> {
    let parsed: Vec<String> = serde_json::from_str(json).unwrap_or_default();
    let mut list = Vec::new();
    // Re-run the normal insertion rules from oldest to newest so duplicates
    // and blanks from a hand-edited file are cleaned up.
    for path in parsed.iter().rev() {
        push_recent(&mut list, path);
    }
    list
}

/// Recent-book history, optionally backed by a JSON file.
#[derive(Debug, Default)]
pub struct RecentBooks {
    file: Option<PathBuf>,
    entries: Vec<String>,
}

impl RecentBooks {
    /// An unpersisted store (tests, or when the data dir is unavailable).
    pub fn in_memory() -> Self {
        Self::default()
    }

    /// Load from `file`; a missing or unreadable file starts empty.
    pub fn load(file: PathBuf) -> Self {
        let entries = std::fs::read_to_string(&file)
            .map(|json| parse_recents(&json))
            .unwrap_or_default();
        Self {
            file: Some(file),
            entries,
        }
    }

    /// Newest first.
    pub fn entries(&self) -> &[String] {
        &self.entries
    }

    /// Record a successful open / first save / save as.
    pub fn add(&mut self, path: &str) {
        push_recent(&mut self.entries, path);
        self.persist();
    }

    /// Drop one entry (e.g. the file has gone missing). Returns whether it
    /// was present.
    pub fn remove(&mut self, path: &str) -> bool {
        let before = self.entries.len();
        self.entries.retain(|p| p != path);
        let removed = self.entries.len() != before;
        if removed {
            self.persist();
        }
        removed
    }

    /// File ▸ Open Recent ▸ Clear Menu. Never touches the books themselves.
    pub fn clear(&mut self) {
        self.entries.clear();
        self.persist();
    }

    /// Best-effort write via a temp file + rename so a crash never leaves a
    /// half-written list behind. Failures are ignored: the in-memory list
    /// still serves this session.
    fn persist(&self) {
        let Some(file) = &self.file else { return };
        let Ok(json) = serde_json::to_string_pretty(&self.entries) else {
            return;
        };
        if let Some(dir) = file.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let tmp = file.with_extension("json.tmp");
        if std::fs::write(&tmp, json).is_ok() {
            let _ = std::fs::rename(&tmp, file);
        }
    }
}

/// Last path component, accepting both separators (paths come from the OS).
pub fn file_name(path: &str) -> &str {
    path.rsplit(['/', '\\']).next().unwrap_or(path)
}

/// Menu labels for the recent entries: the file name, plus the parent
/// folder when two entries share a file name (like macOS does).
pub fn recent_labels(paths: &[String]) -> Vec<String> {
    paths
        .iter()
        .map(|path| {
            let name = file_name(path);
            let duplicate = paths
                .iter()
                .filter(|other| file_name(other) == name)
                .count()
                > 1;
            if duplicate {
                let parent = Path::new(path)
                    .parent()
                    .map(|p| file_name(&p.to_string_lossy()).to_owned())
                    .unwrap_or_default();
                if parent.is_empty() {
                    name.to_owned()
                } else {
                    format!("{name} — {parent}")
                }
            } else {
                name.to_owned()
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn paths(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| (*s).to_owned()).collect()
    }

    #[test]
    fn push_moves_to_front_dedupes_and_caps() {
        let mut list = Vec::new();
        push_recent(&mut list, "/a.epub");
        push_recent(&mut list, "/b.epub");
        push_recent(&mut list, "/a.epub");
        assert_eq!(list, paths(&["/a.epub", "/b.epub"]));

        for i in 0..20 {
            push_recent(&mut list, &format!("/n{i}.epub"));
        }
        assert_eq!(list.len(), MAX_RECENTS);
        assert_eq!(list[0], "/n19.epub");

        push_recent(&mut list, "  ");
        assert_eq!(list[0], "/n19.epub");
    }

    #[test]
    fn parse_tolerates_garbage_and_cleans_duplicates() {
        assert!(parse_recents("not json").is_empty());
        assert!(parse_recents("{\"a\":1}").is_empty());
        assert_eq!(
            parse_recents(r#"["/a.epub", "/b.epub", "/a.epub", ""]"#),
            paths(&["/a.epub", "/b.epub"])
        );
    }

    #[test]
    fn persists_across_loads_and_keeps_unicode() {
        let dir = std::env::temp_dir().join(format!("epubzilla-recents-{}", std::process::id()));
        let file = dir.join(RECENTS_FILE);
        let _ = std::fs::remove_file(&file);

        let mut store = RecentBooks::load(file.clone());
        assert!(store.entries().is_empty());
        store.add("/books/Épübzïlla 世界.epub");
        store.add("/books/other.epub");
        assert!(store.remove("/books/other.epub"));
        assert!(!store.remove("/books/missing.epub"));

        let reloaded = RecentBooks::load(file.clone());
        assert_eq!(reloaded.entries(), &paths(&["/books/Épübzïlla 世界.epub"]));

        let mut cleared = reloaded;
        cleared.clear();
        assert!(RecentBooks::load(file.clone()).entries().is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn labels_disambiguate_duplicate_file_names() {
        let list = paths(&["/a/x/book.epub", "/b/y/book.epub", "/c/solo.epub"]);
        assert_eq!(
            recent_labels(&list),
            vec!["book.epub — x", "book.epub — y", "solo.epub"]
        );
        assert_eq!(file_name("C:\\books\\w.epub"), "w.epub");
    }
}
