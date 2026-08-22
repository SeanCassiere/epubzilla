//! Error taxonomy. Contractual: docs/contracts/domain-model.md.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, thiserror::Error, Serialize, Deserialize, TS)]
#[serde(tag = "kind")]
#[ts(export)]
pub enum CoreError {
    #[error("I/O error: {message}")]
    Io { message: String },
    /// Bad mimetype entry or container.xml.
    #[error("not an EPUB: {message}")]
    NotAnEpub { message: String },
    /// OPF or nav parse failure.
    #[error("malformed package: {message}")]
    MalformedPackage { message: String },
    #[error("resource not found: {id}")]
    ResourceNotFound { id: String },
    /// e.g. DRM-encrypted books.
    #[error("unsupported feature: {message}")]
    UnsupportedFeature { message: String },
    #[error("validation failed with {} issue(s)", issues.len())]
    ValidationFailed { issues: Vec<ValidationIssue> },
    /// Markdown ↔ XHTML round-trip would lose data.
    #[error("conversion would be lossy: {detail}")]
    ConversionLossy { detail: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub enum Severity {
    Error,
    Warning,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ValidationIssue {
    pub severity: Severity,
    pub location: Option<String>,
    pub message: String,
}

pub type CoreResult<T> = Result<T, CoreError>;
