//! Typed error for the framework-free core.
//!
//! # Failure modes
//!
//! - `CoreError::Io`: an operating-system I/O call failed while touching `path`
//!   (or no path when `path` is `None`). The original `std::io::Error` is kept
//!   as `source`. Produced by `From<std::io::Error>`, which always sets `path`
//!   to `None`; callers that know the path attach it themselves.
//! - `CoreError::InvalidPath(String)`: caller-supplied path or name was
//!   rejected before any filesystem work (empty, relative, contains NUL,
//!   oversized, or otherwise unsafe).
//! - `CoreError::Cancelled`: the operation observed its cancellation token and
//!   stopped. Not a bug; the caller asked for it.
//! - `CoreError::NotFound(PathBuf)`: the target path does not exist. Callers
//!   construct this explicitly; I/O errors arrive as `Io`.
//! - `CoreError::PermissionDenied(PathBuf)`: the OS refused access to the path.
//!   Callers construct this explicitly; I/O errors arrive as `Io`.
//! - `CoreError::Message(String)`: a free-form failure carried over from ported
//!   code that still returns `Result<_, String>`. Also produced by `From<String>`.
//! - Formatting (`Display`) cannot fail. `From<CoreError> for String` cannot
//!   fail; it uses `Display`.

use std::fmt;
use std::path::PathBuf;

/// Error type shared by core seams and new core code.
///
/// Ported modules still return `Result<_, String>`; they are converted with
/// `From<CoreError> for String` at the boundary until they are migrated.
#[derive(Debug)]
pub enum CoreError {
    /// An I/O call failed. `path` is the path involved, if known.
    Io {
        path: Option<PathBuf>,
        source: std::io::Error,
    },
    /// A caller-supplied path or name was rejected.
    InvalidPath(String),
    /// The operation was cancelled before it completed.
    Cancelled,
    /// The path does not exist.
    NotFound(PathBuf),
    /// The OS denied access to the path.
    PermissionDenied(PathBuf),
    /// A free-form error message.
    Message(String),
}

impl fmt::Display for CoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            CoreError::Io {
                path: Some(path),
                source,
            } => write!(f, "{}: {}", path.display(), source),
            CoreError::Io { path: None, source } => write!(f, "{}", source),
            CoreError::InvalidPath(message) => write!(f, "{}", message),
            CoreError::Cancelled => write!(f, "Operation cancelled"),
            CoreError::NotFound(path) => write!(f, "Not found: {}", path.display()),
            CoreError::PermissionDenied(path) => {
                write!(f, "Permission denied: {}", path.display())
            }
            CoreError::Message(message) => write!(f, "{}", message),
        }
    }
}

impl std::error::Error for CoreError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            CoreError::Io { source, .. } => Some(source),
            _ => None,
        }
    }
}

impl From<std::io::Error> for CoreError {
    fn from(source: std::io::Error) -> Self {
        CoreError::Io { path: None, source }
    }
}

impl From<String> for CoreError {
    fn from(message: String) -> Self {
        CoreError::Message(message)
    }
}

impl From<CoreError> for String {
    fn from(error: CoreError) -> Self {
        error.to_string()
    }
}
