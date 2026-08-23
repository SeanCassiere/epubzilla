//! Performance budget enforcement (core-api.md, "Performance budgets").
//!
//! Generates synthetic large books, then times the core operations against
//! the contracted budgets:
//!
//! - a 500-chapter, ~50 MB (uncompressed) text-heavy book, and
//! - an image-heavy variant (250 chapters + 100 images totalling ~50 MB of
//!   incompressible image bytes).
//!
//! Ignored by default so `cargo test` stays fast; CI runs it explicitly in
//! release mode:
//!
//! ```sh
//! cargo test -p epubzilla-core --release --test perf_budgets -- --ignored --nocapture --test-threads=1
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

const IMAGE_CHAPTER_COUNT: usize = 250;
const IMAGE_COUNT: usize = 100;
/// 512 KB of incompressible bytes per image → ~50 MB of image payload.
const IMAGE_BYTES: usize = 512 * 1024;

fn budget(ms: u64) -> Duration {
    let multiplier: u64 = std::env::var("CI_MULTIPLIER")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(1);
    Duration::from_millis(ms * multiplier)
}

fn assert_budget(label: &str, elapsed: Duration, ms: u64) {
    assert!(
        elapsed <= budget(ms),
        "{label} took {elapsed:?}, budget {:?}",
        budget(ms)
    );
}

/// Deterministic pseudo-random stream (xorshift64*) so the corpus does
/// not deflate down to nothing and the timings stay realistic.
struct Rng(u64);

impl Rng {
    fn new(seed: u64) -> Self {
        Rng(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1)
    }
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }
}

fn chapter_markdown(n: usize, paragraphs: usize) -> String {
    const WORDS: [&str; 16] = [
        "lorem", "ipsum", "dolor", "amet", "grüße", "wörld", "tëxt", "über", "seiten", "kapitel",
        "façade", "naïve", "résumé", "cœur", "søster", "łódź",
    ];
    let mut rng = Rng::new(n as u64);
    let mut md = format!("# Chapter {n} — Ünïcode ✓\n\n");
    for p in 0..paragraphs {
        md.push_str(&format!("Paragraph {p} of chapter {n}:"));
        for _ in 0..24 {
            let r = rng.next();
            md.push(' ');
            md.push_str(WORDS[(r % 16) as usize]);
            md.push_str(&format!("-{:04x}", r >> 48));
        }
        md.push_str(".\n\n");
    }
    md
}

/// Incompressible pseudo-image: a PNG signature followed by random bytes.
/// Deflate cannot shrink it, so zip copy/re-encode costs stay realistic.
fn image_bytes(n: usize) -> Vec<u8> {
    let mut bytes = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
    let mut rng = Rng::new(0xC0FFEE ^ n as u64);
    while bytes.len() < IMAGE_BYTES {
        bytes.extend_from_slice(&rng.next().to_le_bytes());
    }
    bytes.truncate(IMAGE_BYTES);
    bytes
}

fn new_metadata(title: &str) -> Metadata {
    Metadata {
        title: title.into(),
        authors: vec!["Benchmark Bot".into()],
        language: "en".into(),
        identifier: String::new(),
        modified: None,
        description: None,
        publisher: None,
        cover_resource: None,
    }
}

/// Build a synthetic book with `chapters` Markdown chapters (each `paragraphs`
/// paragraphs) and `images` incompressible image resources, saved to `path`.
fn build_corpus(
    session: &mut Session,
    path: &std::path::Path,
    chapters: usize,
    paragraphs: usize,
    images: usize,
) -> usize {
    let book = session.create_book(new_metadata("Perf Corpus"));
    let mut total_bytes = 0usize;
    for n in 0..chapters {
        let updated = session
            .add_chapter(&book.id, &format!("Chapter {n}"), None)
            .unwrap();
        let resource_id = updated.spine.last().unwrap().resource.clone();
        let mut markdown = chapter_markdown(n, paragraphs);
        if images > 0 {
            // Reference an image from each chapter so the sweep keeps them.
            markdown.push_str(&format!("\n![figure](images/figure-{}.png)\n", n % images));
        }
        total_bytes += markdown.len();
        session
            .write_chapter(
                &book.id,
                &resource_id,
                ChapterContent {
                    resource: resource_id.clone(),
                    format: ContentFormat::Markdown,
                    content: markdown,
                    fallback_reason: None,
                },
            )
            .unwrap();
    }
    for n in 0..images {
        let bytes = image_bytes(n);
        total_bytes += bytes.len();
        session
            .add_resource(&book.id, &format!("figure-{n}.png"), "image/png", bytes)
            .unwrap();
    }
    session
        .save_book(&book.id, Some(path.to_string_lossy().into_owned()))
        .unwrap();
    session.close_book(&book.id).unwrap();
    total_bytes
}

/// Common measurement pass: open, read a mid chapter, rewrite it, save,
/// validate. Returns the elapsed times in that order.
struct Timings {
    open: Duration,
    read: Duration,
    write: Duration,
    save: Duration,
    validate: Duration,
    spine_len: usize,
}

fn measure(path: &std::path::Path) -> Timings {
    let mut session = Session::new();

    let start = Instant::now();
    let book = session.open_book(path.to_str().unwrap()).unwrap();
    let open = start.elapsed();

    let mid = book.spine[book.spine.len() / 2].resource.clone();
    let start = Instant::now();
    let content = session
        .read_chapter(&book.id, &mid, ContentFormat::Markdown)
        .unwrap();
    let read = start.elapsed();
    assert!(!content.content.is_empty());

    let replacement = chapter_markdown(9999, PARAGRAPHS_PER_CHAPTER);
    let start = Instant::now();
    session
        .write_chapter(
            &book.id,
            &mid,
            ChapterContent {
                resource: mid.clone(),
                format: ContentFormat::Markdown,
                content: replacement,
                fallback_reason: None,
            },
        )
        .unwrap();
    let write = start.elapsed();

    let start = Instant::now();
    session.save_book(&book.id, None).unwrap();
    let save = start.elapsed();

    // Post-save automatic re-check (issue #82) must not blow the save
    // interaction budget: validate reads and parses every XHTML document.
    let start = Instant::now();
    let issues = session.validate(&book.id).unwrap();
    let validate = start.elapsed();
    assert!(
        issues.is_empty(),
        "synthetic corpus should validate clean: {issues:?}"
    );

    Timings {
        open,
        read,
        write,
        save,
        validate,
        spine_len: book.spine.len(),
    }
}

#[test]
#[ignore = "perf harness: run explicitly in release mode (see module docs)"]
fn budgets_hold_on_500_chapter_book() {
    let dir = std::env::temp_dir().join(format!("epubzilla-perf-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("perf-500.epub");

    let mut session = Session::new();
    let total_bytes = build_corpus(
        &mut session,
        &path,
        CHAPTER_COUNT,
        PARAGRAPHS_PER_CHAPTER,
        0,
    );
    drop(session);
    let file_size = std::fs::metadata(&path).unwrap().len();
    println!(
        "corpus: {CHAPTER_COUNT} chapters, ~{:.1} MB markdown, {:.1} MB epub on disk",
        total_bytes as f64 / 1e6,
        file_size as f64 / 1e6
    );

    let t = measure(&path);
    assert_eq!(t.spine_len, CHAPTER_COUNT + 1); // + generated title page
    println!("open_book:     {:?} (budget {:?})", t.open, budget(1000));
    println!("read_chapter:  {:?} (budget {:?})", t.read, budget(50));
    println!("write_chapter: {:?} (budget {:?})", t.write, budget(50));
    println!("save_book:     {:?} (budget {:?})", t.save, budget(500));
    println!("validate:      {:?} (budget {:?})", t.validate, budget(500));

    let _ = std::fs::remove_file(&path);

    assert_budget("open_book", t.open, 1000);
    assert_budget("read_chapter", t.read, 50);
    assert_budget("write_chapter", t.write, 50);
    assert_budget("save_book", t.save, 500);
    assert_budget("validate", t.validate, 500);
}

#[test]
#[ignore = "perf harness: run explicitly in release mode (see module docs)"]
fn budgets_hold_on_image_heavy_book() {
    let dir = std::env::temp_dir().join(format!("epubzilla-perf-img-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("perf-images.epub");

    let mut session = Session::new();
    let total_bytes = build_corpus(
        &mut session,
        &path,
        IMAGE_CHAPTER_COUNT,
        PARAGRAPHS_PER_CHAPTER / 4,
        IMAGE_COUNT,
    );
    drop(session);
    let file_size = std::fs::metadata(&path).unwrap().len();
    println!(
        "corpus: {IMAGE_CHAPTER_COUNT} chapters + {IMAGE_COUNT} images, ~{:.1} MB content, {:.1} MB epub on disk",
        total_bytes as f64 / 1e6,
        file_size as f64 / 1e6
    );

    let t = measure(&path);
    assert_eq!(t.spine_len, IMAGE_CHAPTER_COUNT + 1); // + generated title page
    println!("open_book:     {:?} (budget {:?})", t.open, budget(1000));
    println!("read_chapter:  {:?} (budget {:?})", t.read, budget(50));
    println!("write_chapter: {:?} (budget {:?})", t.write, budget(50));
    println!("save_book:     {:?} (budget {:?})", t.save, budget(500));
    println!("validate:      {:?} (budget {:?})", t.validate, budget(500));

    let _ = std::fs::remove_file(&path);

    assert_budget("open_book", t.open, 1000);
    assert_budget("read_chapter", t.read, 50);
    assert_budget("write_chapter", t.write, 50);
    assert_budget("save_book", t.save, 500);
    assert_budget("validate", t.validate, 500);
}
