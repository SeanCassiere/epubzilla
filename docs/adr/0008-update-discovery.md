# ADR-0008: Update discovery and manual installation handoff

**Status:** Accepted

## Context

epubzilla needs to tell an installed user when a newer stable release exists.
The application is currently distributed through public GitHub Releases. A
later phase may install updates automatically, but replacing a running desktop
application is a separate safety boundary and must not be implied by discovery.

## Decision

- Use Tauri v2's first-party updater for version discovery and its signed
  `latest.json` format. Pin matching Rust and JavaScript plugin versions.
- Use the published GitHub Release endpoint as the static, anonymous source:
  `https://github.com/SeanCassiere/epubzilla/releases/latest/download/latest.json`.
  Drafts and prereleases are therefore not offered by the production endpoint.
- Embed the updater Minisign public key in the application. The corresponding
  encrypted private key is held outside the repository and supplied to release
  CI only through GitHub Actions secrets.
- In phase one, retain only the available version, close the returned updater
  resource, and hand the user to the public latest-release page. Download and
  installation are explicitly manual. No process exit/relaunch permission is
  present.
- Defer download, automatic installation, dirty-state guards, and relaunch to
  a later decision and implementation (#90).

## Consequences

Release builds must produce signed updater artifacts and a single inspected
manifest even though the app does not yet consume the artifact. This establishes
the trust chain needed by a later automatic-updater phase. Loss of the signing
key cannot be repaired for already-installed copies without a manual reinstall;
rotation therefore requires a transitional release signed by the old key.

No new Contract is needed: neither the Rust core/domain interface nor a
repository-owned manifest schema changes.

The frontend launch check is non-blocking and failure-silent. Diagnostics go to
the developer console. Only update discovery and the exact release-page URL are
granted through Tauri capabilities, so this phase cannot download, install,
quit, or relaunch the application.
