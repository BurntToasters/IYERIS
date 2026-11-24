//! Host seams: where core code asks the embedding app for directories and
//! where it sends events to the UI.
//!
//! # Failure modes
//!
//! `PathProvider::app_data_dir` and `PathProvider::app_cache_dir`:
//! - `StdPathProvider` returns `CoreError::Message` when `directories::BaseDirs`
//!   cannot resolve a home directory (for example HOME is unset and no passwd
//!   entry exists). Nothing else fails: the provider only computes paths and
//!   never creates, reads or checks them, so a returned path may not exist yet.
//! - `FixedPathProvider` never fails; it returns the paths it was built with.
//! - Paths are returned as `PathBuf` and may contain non-UTF-8 bytes on Unix.
//!   Callers that need `&str` must handle that themselves.
//!
//! `EventSink::emit`:
//! - Delivery is best effort and returns nothing. A host sink may drop the
//!   event (for example when its window is closed); the caller is not told.
//! - `NullSink` drops every event by design.
//! - `RecordingSink` stores every event in memory until `take` is called, so
//!   a long-running caller that never drains it grows memory without bound.
//! - `RecordingSink` never panics on a poisoned lock. If another thread
//!   panicked while holding it, the stored events are still returned.
//! - The payload is already a `serde_json::Value`, so serialization cannot fail
//!   here. Callers that start from a struct convert it with
//!   `serde_json::to_value` before calling `emit`, and handle that error there.

use std::path::PathBuf;
use std::sync::Mutex;

use crate::error::CoreError;

/// Bundle identifier used under the platform data and cache directories.
/// Matches the identifier IYERIS 3 used through Tauri 2.
pub const APP_IDENTIFIER: &str = "run.rosie.iyeris";

/// Supplies the application data and cache directories.
pub trait PathProvider: Send + Sync {
    /// Directory for persistent application state.
    fn app_data_dir(&self) -> Result<PathBuf, CoreError>;
    /// Directory for disposable cache files.
    fn app_cache_dir(&self) -> Result<PathBuf, CoreError>;
}

/// Platform-default provider. Returns the same paths IYERIS 3 got from Tauri 2:
/// `BaseDirs::data_dir()` and `BaseDirs::cache_dir()`, each joined with
/// [`APP_IDENTIFIER`].
#[derive(Debug, Default, Clone, Copy)]
pub struct StdPathProvider;

fn base_dirs() -> Result<directories::BaseDirs, CoreError> {
    directories::BaseDirs::new()
        .ok_or_else(|| CoreError::Message("Could not determine the home directory".to_string()))
}

impl PathProvider for StdPathProvider {
    fn app_data_dir(&self) -> Result<PathBuf, CoreError> {
        Ok(base_dirs()?.data_dir().join(APP_IDENTIFIER))
    }

    fn app_cache_dir(&self) -> Result<PathBuf, CoreError> {
        Ok(base_dirs()?.cache_dir().join(APP_IDENTIFIER))
    }
}

/// Provider with fixed paths, for tests and the E2E harness.
#[derive(Debug, Clone)]
pub struct FixedPathProvider {
    pub data: PathBuf,
    pub cache: PathBuf,
}

impl PathProvider for FixedPathProvider {
    fn app_data_dir(&self) -> Result<PathBuf, CoreError> {
        Ok(self.data.clone())
    }

    fn app_cache_dir(&self) -> Result<PathBuf, CoreError> {
        Ok(self.cache.clone())
    }
}

/// Receives events that core code wants the UI to see.
pub trait EventSink: Send + Sync {
    /// Deliver one event. Best effort; never fails from the caller's view.
    fn emit(&self, event: &str, payload: serde_json::Value);
}

/// Sink that drops every event.
#[derive(Debug, Default, Clone, Copy)]
pub struct NullSink;

impl EventSink for NullSink {
    fn emit(&self, _event: &str, _payload: serde_json::Value) {}
}

/// Sink that records events in order so a caller can inspect them.
#[derive(Debug, Default)]
pub struct RecordingSink {
    events: Mutex<Vec<(String, serde_json::Value)>>,
}

impl RecordingSink {
    pub fn new() -> Self {
        Self::default()
    }

    /// Removes and returns every event recorded so far, oldest first.
    pub fn take(&self) -> Vec<(String, serde_json::Value)> {
        let mut guard = self
            .events
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        std::mem::take(&mut *guard)
    }
}

impl EventSink for RecordingSink {
    fn emit(&self, event: &str, payload: serde_json::Value) {
        let mut guard = self
            .events
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        guard.push((event.to_string(), payload));
    }
}
