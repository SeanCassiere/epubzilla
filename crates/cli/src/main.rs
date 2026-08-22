//! CLI harness for the epubzilla core engine.
//!
//! Commands are stubs until their core capabilities land (M0.2–M0.9);
//! each prints a clear "not implemented" pointing at its tracking issue.

use clap::{Parser, Subcommand};

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
    Extract { path: String, chapter: String },
    /// Create an EPUB from metadata and Markdown chapter files
    Create,
    /// Run the native validation subset against an EPUB file
    Validate { path: String },
}

fn main() {
    let cli = Cli::parse();
    let (name, issue) = match cli.command {
        Command::Inspect { .. } => ("inspect", "M0.5 (#7)"),
        Command::Extract { .. } => ("extract", "M0.5 (#7)"),
        Command::Create => ("create", "M0.6 (#8)"),
        Command::Validate { .. } => ("validate", "M0.8 (#10)"),
    };
    eprintln!("`{name}` is not implemented yet — lands with {issue}.");
    std::process::exit(2);
}
