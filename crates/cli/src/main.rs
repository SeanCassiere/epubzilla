//! CLI harness for the epubzilla core engine.
//!
//! Exercises the `Session` API from core-api.md end to end: inspect a book's
//! model, extract chapter content, create a book from Markdown files, and run
//! the native validation subset. Errors print to stderr with a nonzero exit.

use std::process::ExitCode;

use clap::{Parser, Subcommand};
use epubzilla_core::{
    Book, ChapterContent, ContentFormat, CoreError, EpubVersion, Metadata, NavPoint, Session,
    Severity,
};

#[derive(Parser)]
#[command(
    name = "epubzilla-cli",
    version,
    about = "EPUB inspection and authoring harness"
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Print metadata, spine, and table of contents for an EPUB file
    Inspect { path: String },
    /// Extract a chapter's content (Markdown when in-subset, XHTML otherwise)
    Extract {
        path: String,
        /// Spine index (0-based), resource id, or resource path
        chapter: String,
    },
    /// Create an EPUB from metadata and Markdown chapter files
    Create {
        #[arg(long)]
        title: String,
        /// May be given multiple times
        #[arg(long = "author")]
        authors: Vec<String>,
        /// BCP 47 language tag (default: en)
        #[arg(long)]
        language: Option<String>,
        /// Target path (default: slugified title + .epub)
        #[arg(long)]
        output: Option<String>,
        /// Markdown chapter file; may be given multiple times
        #[arg(long = "chapter")]
        chapters: Vec<String>,
    },
    /// Run the native validation subset against an EPUB file
    Validate { path: String },
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    let result = match cli.command {
        Command::Inspect { path } => inspect(&path),
        Command::Extract { path, chapter } => extract(&path, &chapter),
        Command::Create {
            title,
            authors,
            language,
            output,
            chapters,
        } => create(title, authors, language, output, &chapters),
        Command::Validate { path } => return validate(&path),
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(err) => {
            eprintln!("error: {err}");
            ExitCode::FAILURE
        }
    }
}

fn inspect(path: &str) -> Result<(), CoreError> {
    let mut session = Session::new();
    let book = session.open_book(path)?;

    let m = &book.metadata;
    println!("Title:      {}", m.title);
    println!(
        "Authors:    {}",
        if m.authors.is_empty() {
            "(none)".to_owned()
        } else {
            m.authors.join(", ")
        }
    );
    println!("Language:   {}", m.language);
    println!("Identifier: {}", m.identifier);
    if let Some(modified) = &m.modified {
        println!("Modified:   {modified}");
    }
    println!(
        "Version:    EPUB {}",
        match book.epub_version {
            EpubVersion::V2 => "2",
            EpubVersion::V3 => "3",
        }
    );

    println!("\nSpine ({} items):", book.spine.len());
    for (i, item) in book.spine.iter().enumerate() {
        let path = book
            .resources
            .iter()
            .find(|r| r.id == item.resource)
            .map_or("(missing resource)", |r| r.path.as_str());
        let linear = if item.linear { "" } else { " [non-linear]" };
        println!("  {i:>3}. {path}{linear}");
    }

    println!("\nTable of contents:");
    if book.nav.is_empty() {
        println!("  (empty)");
    } else {
        print_nav(&book.nav, 1);
    }
    Ok(())
}

fn print_nav(points: &[NavPoint], depth: usize) {
    for point in points {
        let indent = "  ".repeat(depth);
        match &point.href {
            Some(href) => println!("{indent}{} -> {href}", point.label),
            None => println!("{indent}{}", point.label),
        }
        print_nav(&point.children, depth + 1);
    }
}

fn extract(path: &str, chapter: &str) -> Result<(), CoreError> {
    let mut session = Session::new();
    let book = session.open_book(path)?;
    let resource_id = resolve_chapter(&book, chapter)?;
    let content = session.read_chapter(&book.id, &resource_id, ContentFormat::Markdown)?;
    match content.format {
        ContentFormat::Markdown => eprintln!("format: markdown"),
        ContentFormat::Xhtml => eprintln!("format: xhtml (content is outside the Markdown subset)"),
    }
    print!("{}", content.content);
    Ok(())
}

/// `<chapter>` accepts a spine index (0-based), a resource id, or a
/// resource path.
fn resolve_chapter(book: &Book, chapter: &str) -> Result<String, CoreError> {
    if let Ok(index) = chapter.parse::<usize>() {
        return match book.spine.get(index) {
            Some(item) => Ok(item.resource.clone()),
            None => Err(CoreError::ResourceNotFound {
                id: format!("spine index {index} (spine has {} items)", book.spine.len()),
            }),
        };
    }
    if let Some(r) = book
        .resources
        .iter()
        .find(|r| r.id == chapter || r.path == chapter)
    {
        return Ok(r.id.clone());
    }
    Err(CoreError::ResourceNotFound {
        id: chapter.to_owned(),
    })
}

fn create(
    title: String,
    authors: Vec<String>,
    language: Option<String>,
    output: Option<String>,
    chapters: &[String],
) -> Result<(), CoreError> {
    let mut session = Session::new();
    let book = session.create_book(Metadata {
        title: title.clone(),
        authors,
        language: language.unwrap_or_default(),
        identifier: String::new(),
        modified: None,
        description: None,
        publisher: None,
        cover_resource: None,
    });

    for file in chapters {
        let markdown = std::fs::read_to_string(file).map_err(|e| CoreError::Io {
            message: format!("cannot read chapter file {file}: {e}"),
        })?;
        let chapter_title = chapter_title(&markdown, file);
        let updated = session.add_chapter(&book.id, &chapter_title, None)?;
        let resource_id = updated
            .spine
            .last()
            .map(|item| item.resource.clone())
            .expect("add_chapter appended a spine item");
        session.write_chapter(
            &book.id,
            &resource_id,
            ChapterContent {
                resource: resource_id.clone(),
                format: ContentFormat::Markdown,
                content: markdown,
            },
        )?;
    }

    let target = output.unwrap_or_else(|| format!("{}.epub", slugify(&title)));
    session.save_book(&book.id, Some(target.clone()))?;
    println!("{target}");
    Ok(())
}

/// Chapter title: the first `#` heading in the Markdown, else the file stem.
fn chapter_title(markdown: &str, file: &str) -> String {
    for line in markdown.lines() {
        let trimmed = line.trim_start();
        if let Some(rest) = trimmed.strip_prefix('#') {
            let text = rest.trim_start_matches('#').trim();
            if !text.is_empty() {
                return text.to_owned();
            }
        }
    }
    std::path::Path::new(file)
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "Chapter".to_owned())
}

/// ASCII-safe slug of a title for default output filenames. UTF-8 safe:
/// operates on chars, lowercasing alphanumerics and collapsing everything
/// else into single hyphens.
fn slugify(title: &str) -> String {
    let mut slug = String::new();
    for c in title.chars() {
        if c.is_alphanumeric() {
            for lc in c.to_lowercase() {
                slug.push(lc);
            }
        } else if !slug.ends_with('-') && !slug.is_empty() {
            slug.push('-');
        }
    }
    let slug = slug.trim_end_matches('-');
    if slug.is_empty() {
        "book".to_owned()
    } else {
        slug.to_owned()
    }
}

fn validate(path: &str) -> ExitCode {
    let mut session = Session::new();
    let issues = match session
        .open_book(path)
        .and_then(|book| session.validate(&book.id))
    {
        Ok(issues) => issues,
        Err(err) => {
            eprintln!("error: {err}");
            return ExitCode::FAILURE;
        }
    };

    if issues.is_empty() {
        println!("OK: no issues found");
        return ExitCode::SUCCESS;
    }
    let mut errors = 0usize;
    for issue in &issues {
        let severity = match issue.severity {
            Severity::Error => {
                errors += 1;
                "error"
            }
            Severity::Warning => "warning",
        };
        match &issue.location {
            Some(location) => println!("{severity}: {location}: {}", issue.message),
            None => println!("{severity}: {}", issue.message),
        }
    }
    println!(
        "{} issue(s): {errors} error(s), {} warning(s)",
        issues.len(),
        issues.len() - errors
    );
    if errors > 0 {
        ExitCode::FAILURE
    } else {
        ExitCode::SUCCESS
    }
}
