//! Conformance fixtures for docs/contracts/content-roundtrip.md.
//!
//! `tests/fixtures/roundtrip/` holds paired `NNN-name.md` / `NNN-name.xhtml`
//! files (both conversion directions are asserted for every pair, plus the
//! full round-trip guarantee) and `NNN-name.bad.xhtml` files that must be
//! rejected as out-of-subset. The fixture set is the executable form of the
//! contract.

use std::path::{Path, PathBuf};

use epubzilla_core::{markdown_to_xhtml, xhtml_to_markdown, CoreError};

fn fixture_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/roundtrip")
}

/// Normalize insignificant whitespace: trailing spaces, blank-line runs, and
/// leading/trailing blank lines.
fn normalize(s: &str) -> String {
    let mut lines: Vec<&str> = s.lines().map(str::trim_end).collect();
    while lines.first().is_some_and(|l| l.is_empty()) {
        lines.remove(0);
    }
    while lines.last().is_some_and(|l| l.is_empty()) {
        lines.pop();
    }
    let mut out: Vec<&str> = Vec::with_capacity(lines.len());
    for line in lines {
        if line.is_empty() && out.last().is_some_and(|l| l.is_empty()) {
            continue;
        }
        out.push(line);
    }
    out.join("\n")
}

fn read(path: &Path) -> String {
    std::fs::read_to_string(path).unwrap_or_else(|e| panic!("reading {}: {e}", path.display()))
}

#[test]
fn paired_fixtures_convert_both_ways_and_round_trip() {
    let mut md_files: Vec<PathBuf> = std::fs::read_dir(fixture_dir())
        .expect("fixture dir")
        .map(|e| e.expect("dir entry").path())
        .filter(|p| p.extension().is_some_and(|e| e == "md"))
        .collect();
    md_files.sort();
    assert!(
        md_files.len() >= 14,
        "expected at least 14 paired fixtures, found {}",
        md_files.len()
    );

    for md_path in md_files {
        let name = md_path.file_name().unwrap().to_string_lossy().into_owned();
        let xhtml_path = md_path.with_extension("xhtml");
        assert!(xhtml_path.exists(), "{name} has no paired .xhtml fixture");
        let md = read(&md_path);
        let xhtml = read(&xhtml_path);

        // Markdown → XHTML matches the pair.
        assert_eq!(
            normalize(&markdown_to_xhtml(&md)),
            normalize(&xhtml),
            "{name}: markdown_to_xhtml does not match paired .xhtml"
        );

        // XHTML → Markdown matches the pair.
        let back = xhtml_to_markdown(&xhtml)
            .unwrap_or_else(|e| panic!("{name}: xhtml_to_markdown failed: {e}"));
        assert_eq!(
            normalize(&back),
            normalize(&md),
            "{name}: xhtml_to_markdown does not match paired .md"
        );

        // Round-trip guarantee: to_markdown(to_xhtml(md)) == md.
        let round = xhtml_to_markdown(&markdown_to_xhtml(&md))
            .unwrap_or_else(|e| panic!("{name}: round-trip failed: {e}"));
        assert_eq!(
            normalize(&round),
            normalize(&md),
            "{name}: round-trip is not identity"
        );
    }
}

#[test]
fn bad_fixtures_are_rejected() {
    let mut bad_files: Vec<PathBuf> = std::fs::read_dir(fixture_dir())
        .expect("fixture dir")
        .map(|e| e.expect("dir entry").path())
        .filter(|p| {
            p.file_name()
                .is_some_and(|n| n.to_string_lossy().ends_with(".bad.xhtml"))
        })
        .collect();
    bad_files.sort();
    assert!(
        bad_files.len() >= 4,
        "expected at least 4 negative fixtures, found {}",
        bad_files.len()
    );

    for path in bad_files {
        let name = path.file_name().unwrap().to_string_lossy().into_owned();
        let xhtml = read(&path);
        match xhtml_to_markdown(&xhtml) {
            Err(CoreError::ConversionLossy { detail }) => {
                assert!(
                    !detail.is_empty(),
                    "{name}: rejection must name the offending construct"
                );
            }
            Err(other) => panic!("{name}: wrong error kind: {other}"),
            Ok(md) => panic!("{name}: must be rejected, got:\n{md}"),
        }
    }
}
