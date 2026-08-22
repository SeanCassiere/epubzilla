//! Performance budget enforcement (core-api.md, "Performance budgets").
//!
//! Generates a synthetic 500-chapter, ~50 MB (uncompressed) book, then times
//! open_book / read_chapter / write_chapter / save_book against the
//! contracted budgets. Ignored by default so `cargo test` stays fast; CI runs
//! it explicitly in release mode:
//!
//! ```sh
//! cargo test -p epubzilla-core --release --test perf_budgets -- --ignored --nocapture
//! ```
//!
//! Budgets are contracted for the reference machine (typical laptop, local
//! SSD). CI runners can be slower, so a single documented multiplier is
//! applied when `CI_MULTIPLIER` is set (e.g. `CI_MULTIPLIER=2`); the
//! contract numbers themselves are never weakened.

use std::time::{Duration, Instant};

use epubzilla_core::{ChapterContent, ContentFormat, Metadata, Session};

const CHAPTER_COUNT: usize = 500;
/// ~100 KB of Markdown per chapter → ~50 MB of content across 500 chapters.
const PARAGRAPHS_PER_CHAPTER: usize = 320;

fn budget(ms: u64) -> Duration {
    let multiplier: u64 = std::env::var("CI_MULTIPLIER")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(1);
    Duration::from_millis(ms * multiplier)
}

/// Deterministic pseudo-random word stream (xorshift64*) so the corpus does
/// not deflate down to nothing and the timings stay realistic.
fn chapter_markdown(n: usize) -> String {
    const WORDS: [&str; 16] = [
        "lorem", "ipsum", "dolor", "amet", "grüße", "wörld", "tëxt", "über", "seiten", "kapitel",
        "façade", "naïve", "résumé", "cœur", "søster", "łódź",
    ];
    let mut state = (n as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1;
    let mut next = move || {
        state ^= state >> 12;
        state ^= state << 25;
        state ^= state >> 27;
        state.wrapping_mul(0x2545_F491_4F6C_DD1D)
    };
    let mut md = format!("# Chapter {n} — Ünïcode ✓\n\n");
    for p in 0..PARAGRAPHS_PER_CHAPTER {
        md.push_str(&format!("Paragraph {p} of chapter {n}:"));
        for _ in 0..24 {
            let r = next();
            md.push(' ');
            md.push_str(WORDS[(r % 16) as usize]);
            md.push_str(&format!("-{:04x}", r >> 48));
        }
        md.push_str(".\n\n");
    }
    md
}

#[test]
#[ignore = "perf harness: run explicitly in release mode (see module docs)"]
fn budgets_hold_on_500_chapter_book() {
    let dir = std::env::temp_dir().join(format!("epubzilla-perf-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("perf-500.epub");

    // --- Build the synthetic book (not timed). ---
    let mut session = Session::new();
    let book = session.create_book(Metadata {
        title: "Perf Corpus".into(),
        authors: vec!["Benchmark Bot".into()],
        language: "en".into(),
        identifier: String::new(),
        modified: None,
        description: None,
        publisher: None,
        cover_resource: None,
    });
    let mut total_bytes = 0usize;
    for n in 0..CHAPTER_COUNT {
        let updated = session
            .add_chapter(&book.id, &format!("Chapter {n}"), None)
            .unwrap();
        let resource_id = updated.spine.last().unwrap().resource.clone();
        let markdown = chapter_markdown(n);
        total_bytes += markdown.len();
        session
            .write_chapter(
                &book.id,
                &resource_id,
                ChapterContent {
                    resource: resource_id.clone(),
                    format: ContentFormat::Markdown,
                    content: markdown,
                },
            )
            .unwrap();
    }
    session
        .save_book(&book.id, Some(path.to_string_lossy().into_owned()))
        .unwrap();
    session.close_book(&book.id).unwrap();
    drop(session);
    let file_size = std::fs::metadata(&path).unwrap().len();
    println!(
        "corpus: {CHAPTER_COUNT} chapters, ~{:.1} MB markdown, {:.1} MB epub on disk",
        total_bytes as f64 / 1e6,
        file_size as f64 / 1e6
    );

    // --- open_book: ≤ 1000 ms. ---
    let mut session = Session::new();
    let start = Instant::now();
    let book = session.open_book(&path).unwrap();
    let open_elapsed = start.elapsed();
    println!("open_book:     {open_elapsed:?} (budget 1000 ms)");
    assert_eq!(book.spine.len(), CHAPTER_COUNT + 1); // + generated title page

    // --- read_chapter: ≤ 50 ms (mid-book chapter, prefer Markdown). ---
    let mid = book.spine[CHAPTER_COUNT / 2].resource.clone();
    let start = Instant::now();
    let content = session
        .read_chapter(&book.id, &mid, ContentFormat::Markdown)
        .unwrap();
    let read_elapsed = start.elapsed();
    println!("read_chapter:  {read_elapsed:?} (budget 50 ms)");
    assert!(!content.content.is_empty());

    // --- write_chapter: ≤ 50 ms (in-memory; no disk I/O). ---
    let replacement = chapter_markdown(9999);
    let start = Instant::now();
    session
        .write_chapter(
            &book.id,
            &mid,
            ChapterContent {
                resource: mid.clone(),
                format: ContentFormat::Markdown,
                content: replacement,
            },
        )
        .unwrap();
    let write_elapsed = start.elapsed();
    println!("write_chapter: {write_elapsed:?} (budget 50 ms)");

    // --- save_book: ≤ 500 ms (one chapter changed; untouched entries are
    // raw-copied, not re-encoded). ---
    let start = Instant::now();
    session.save_book(&book.id, None).unwrap();
    let save_elapsed = start.elapsed();
    println!("save_book:     {save_elapsed:?} (budget 500 ms)");

    let _ = std::fs::remove_file(&path);

    assert!(
        open_elapsed <= budget(1000),
        "open_book took {open_elapsed:?}, budget {:?}",
        budget(1000)
    );
    assert!(
        read_elapsed <= budget(50),
        "read_chapter took {read_elapsed:?}, budget {:?}",
        budget(50)
    );
    assert!(
        write_elapsed <= budget(50),
        "write_chapter took {write_elapsed:?}, budget {:?}",
        budget(50)
    );
    assert!(
        save_elapsed <= budget(500),
        "save_book took {save_elapsed:?}, budget {:?}",
        budget(500)
    );
}
