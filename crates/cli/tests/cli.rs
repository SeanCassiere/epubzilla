//! End-to-end CLI tests: create → validate → inspect → extract, driving the
//! built binary the way a user would. Unicode metadata throughout.

use assert_cmd::Command;
use predicates::prelude::*;

fn cli() -> Command {
    Command::cargo_bin("epubzilla-cli").unwrap()
}

fn temp_dir(name: &str) -> std::path::PathBuf {
    let dir =
        std::env::temp_dir().join(format!("epubzilla-cli-tests-{}-{name}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

const CH1_MD: &str =
    "# Chäpter Øne ✓\n\nHello **world** — with `code` and *emphasis*.\n\n- one\n- two\n";
const CH2_MD: &str = "Plain body with no heading, so the title falls back to the file stem.\n";

/// Create a book with Unicode metadata + two Markdown chapters, then run the
/// whole command surface against the saved file.
#[test]
fn create_validate_inspect_extract_roundtrip() {
    let dir = temp_dir("roundtrip");
    let ch1 = dir.join("first.md");
    let ch2 = dir.join("zweites-kapitel.md");
    std::fs::write(&ch1, CH1_MD).unwrap();
    std::fs::write(&ch2, CH2_MD).unwrap();
    let output = dir.join("book.epub");

    // create → prints the saved path.
    cli()
        .args([
            "create",
            "--title",
            "Grüße “Wörld” ✓",
            "--author",
            "Ærin Author",
            "--author",
            "Zoë Writer",
            "--language",
            "de",
            "--output",
            output.to_str().unwrap(),
            "--chapter",
            ch1.to_str().unwrap(),
            "--chapter",
            ch2.to_str().unwrap(),
        ])
        .assert()
        .success()
        .stdout(predicate::str::contains("book.epub"));
    assert!(output.exists());

    // validate → no Error-severity issues, exit 0.
    cli()
        .args(["validate", output.to_str().unwrap()])
        .assert()
        .success()
        .stdout(predicate::str::contains("OK: no issues found"));

    // inspect → metadata, spine, and TOC.
    cli()
        .args(["inspect", output.to_str().unwrap()])
        .assert()
        .success()
        .stdout(
            predicate::str::contains("Grüße “Wörld” ✓")
                .and(predicate::str::contains("Ærin Author, Zoë Writer"))
                .and(predicate::str::contains("Language:   de"))
                .and(predicate::str::contains("EPUB 3"))
                .and(predicate::str::contains("Spine (3 items)"))
                .and(predicate::str::contains("titlepage.xhtml"))
                .and(predicate::str::contains("chapter-1.xhtml"))
                .and(predicate::str::contains("Chäpter Øne ✓"))
                // No-heading chapter takes its title from the file stem.
                .and(predicate::str::contains("zweites-kapitel")),
        );

    // extract by spine index → the Markdown round-trips.
    cli()
        .args(["extract", output.to_str().unwrap(), "1"])
        .assert()
        .success()
        .stderr(predicate::str::contains("format: markdown"))
        .stdout(
            predicate::str::contains("# Chäpter Øne ✓")
                .and(predicate::str::contains(
                    "Hello **world** — with `code` and *emphasis*.",
                ))
                .and(predicate::str::contains("- one")),
        );

    // extract by resource id and by resource path give the same content.
    let by_id = cli()
        .args(["extract", output.to_str().unwrap(), "chapter-1"])
        .assert()
        .success();
    let by_path = cli()
        .args(["extract", output.to_str().unwrap(), "OEBPS/chapter-1.xhtml"])
        .assert()
        .success();
    assert_eq!(by_id.get_output().stdout, by_path.get_output().stdout);
}

#[test]
fn extract_unknown_chapter_fails() {
    let dir = temp_dir("unknown");
    // Default output path: slugified title + .epub, in the working directory.
    let output = dir.join("tiny-tëst-book.epub");
    cli()
        .current_dir(&dir)
        .args(["create", "--title", "Tiny Tëst — Book!"])
        .assert()
        .success()
        .stdout(predicate::str::contains("tiny-tëst-book.epub"));
    assert!(output.exists());

    cli()
        .args(["extract", output.to_str().unwrap(), "no-such-chapter"])
        .assert()
        .failure()
        .stderr(predicate::str::contains("resource not found"));

    // Out-of-range spine index is a clear error too.
    cli()
        .args(["extract", output.to_str().unwrap(), "99"])
        .assert()
        .failure()
        .stderr(predicate::str::contains("spine index 99"));
}

#[test]
fn commands_fail_cleanly_on_missing_file() {
    for command in ["inspect", "validate"] {
        cli()
            .args([command, "/no/such/file.epub"])
            .assert()
            .failure()
            .stderr(predicate::str::contains("error:"));
    }
}
