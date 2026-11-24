//! Step records and the JSON artifact written to `target/e2e/core-artifact.json`.
//!
//! The artifact must be byte-identical across runs on one OS, so nothing
//! absolute, timed or random is stored: paths are relative to the fixture
//! root, errors have the root replaced, and events keep only their name and
//! stable fields.

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use crate::fixture::Entry;

pub const SCHEMA_VERSION: u64 = 1;

/// Outcome of one harness step.
pub struct Step {
    pub name: &'static str,
    pub ok: bool,
    pub observed: Value,
}

impl Step {
    /// Builds a step from a check result. A failure is recorded with its
    /// message, redacted so it contains no absolute path.
    pub fn new(name: &'static str, result: Result<Value, String>, root: &Path) -> Self {
        match result {
            Ok(observed) => Step {
                name,
                ok: true,
                observed,
            },
            Err(message) => Step {
                name,
                ok: false,
                observed: json!({ "error": redact(&message, root) }),
            },
        }
    }
}

/// Replaces the fixture root in free-form text with `<root>`.
pub fn redact(text: &str, root: &Path) -> String {
    text.replace(&root.to_string_lossy().into_owned(), "<root>")
}

/// Keeps event names and the stable fields of each payload, sorted and
/// de-duplicated. `operationId` and percentages are dropped: they come from
/// generated ids and from timing.
pub fn normalize_events(events: Vec<(String, Value)>) -> Value {
    let mut lines: Vec<String> = events
        .iter()
        .map(|(name, payload)| {
            let fields = match name.as_str() {
                "file-operation-progress" => json!({
                    "event": name,
                    "operation": payload["operation"],
                    "current": payload["current"],
                    "total": payload["total"],
                    "name": payload["name"],
                }),
                "checksum-progress" => json!({
                    "event": name,
                    "algorithm": payload["algorithm"],
                }),
                _ => json!({ "event": name }),
            };
            fields.to_string()
        })
        .collect();
    lines.sort();
    lines.dedup();
    Value::Array(lines.iter().map(|line| json!(line)).collect())
}

/// Writes the artifact, creating its directory. Output is pretty JSON with a
/// trailing newline.
pub fn write(path: &Path, steps: &[Step], tree: &[Entry]) -> Result<(), String> {
    let document = json!({
        "schema": SCHEMA_VERSION,
        "os": std::env::consts::OS,
        "steps": steps
            .iter()
            .map(|step| json!({ "name": step.name, "ok": step.ok, "observed": step.observed }))
            .collect::<Vec<Value>>(),
        "tree": tree.iter().map(Entry::to_json).collect::<Vec<Value>>(),
    });
    let mut text = serde_json::to_string_pretty(&document).map_err(|e| e.to_string())?;
    text.push('\n');
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("create {}: {e}", parent.display()))?;
    }
    fs::write(path, text).map_err(|e| format!("write {}: {e}", path.display()))
}

/// `<workspace root>/target/e2e/core-artifact.json`, two levels above this crate.
pub fn artifact_path() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("target")
        .join("e2e")
        .join("core-artifact.json")
}
