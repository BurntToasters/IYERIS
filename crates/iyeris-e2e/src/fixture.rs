//! Fixture tree with known contents, plus the directory walk used for checks
//! and for the artifact's `tree` section.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Component, Path};

use serde_json::{json, Value};
use sha2::{Digest, Sha256};

/// Files under the fixture `source` directory, relative to it. Two content
/// groups are duplicates on purpose.
pub const FILES: &[(&str, &[u8])] = &[
    ("notes.txt", b"alpha\n"),
    ("photos/2024/sunset.txt", b"sunset bytes\n"),
    ("photos/2024/copy-of-notes.txt", b"alpha\n"),
    ("docs/readme.md", b"# readme\n"),
    ("docs/duplicate-readme.md", b"# readme\n"),
    ("docs/unique.txt", b"only here\n"),
    ("unicode/caf\u{e9}-r\u{e9}sum\u{e9}.txt", b"unicode name\n"),
    ("empty.txt", b""),
];

/// Directories under `source` that exist even when they hold no file.
pub const DIRS: &[&str] = &["photos", "photos/2024", "docs", "unicode", "empty-dir"];

pub fn sha256_bytes(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

/// Writes the fixture tree under `source`, creating `source` itself.
pub fn build(source: &Path) -> Result<(), String> {
    for dir in DIRS {
        fs::create_dir_all(source.join(dir)).map_err(|e| format!("create fixture dir: {e}"))?;
    }
    for (rel, bytes) in FILES {
        fs::write(source.join(rel), bytes).map_err(|e| format!("write fixture file: {e}"))?;
    }
    Ok(())
}

/// Expected `(relative path, sha256)` pairs for fixture files whose relative
/// path passes `keep`.
pub fn expected_files(keep: impl Fn(&str) -> bool) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = FILES
        .iter()
        .filter(|(rel, _)| keep(rel))
        .map(|(rel, bytes)| (rel.to_string(), sha256_bytes(bytes)))
        .collect();
    out.sort();
    out
}

/// Expected duplicate groups as `(size, relative paths)`: every content that
/// appears at least twice in the fixture.
pub fn expected_duplicate_groups() -> Vec<(u64, Vec<String>)> {
    let mut by_content: BTreeMap<&[u8], Vec<String>> = BTreeMap::new();
    for (rel, bytes) in FILES {
        by_content.entry(bytes).or_default().push(rel.to_string());
    }
    let mut groups: Vec<(u64, Vec<String>)> = by_content
        .into_iter()
        .filter(|(bytes, paths)| !bytes.is_empty() && paths.len() > 1)
        .map(|(bytes, mut paths)| {
            paths.sort();
            (bytes.len() as u64, paths)
        })
        .collect();
    groups.sort();
    groups
}

/// One fixture path in the artifact tree.
pub struct Entry {
    pub path: String,
    pub kind: &'static str,
    pub size: Option<u64>,
    pub sha256: Option<String>,
}

impl Entry {
    pub fn to_json(&self) -> Value {
        json!({
            "path": self.path,
            "kind": self.kind,
            "size": self.size,
            "sha256": self.sha256,
        })
    }
}

/// Renders `path` as `/`-separated components relative to `base`. Returns
/// `<outside-base>` for anything not under `base`, so no absolute path leaks.
pub fn rel(base: &Path, path: &Path) -> String {
    match path.strip_prefix(base) {
        Ok(stripped) => stripped
            .components()
            .filter_map(|component| match component {
                Component::Normal(part) => Some(part.to_string_lossy().into_owned()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("/"),
        Err(_) => "<outside-base>".to_string(),
    }
}

/// Recursively lists everything under `dir`, with paths relative to `base`,
/// sorted by path. Files carry size and sha256; directories carry neither.
pub fn walk(base: &Path, dir: &Path) -> Result<Vec<Entry>, String> {
    let mut out = Vec::new();
    collect(base, dir, &mut out)?;
    out.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(out)
}

fn collect(base: &Path, dir: &Path, out: &mut Vec<Entry>) -> Result<(), String> {
    let read = fs::read_dir(dir).map_err(|e| format!("read dir {}: {e}", rel(base, dir)))?;
    for item in read {
        let item = item.map_err(|e| format!("read dir entry: {e}"))?;
        let path = item.path();
        let file_type = item
            .file_type()
            .map_err(|e| format!("stat {}: {e}", rel(base, &path)))?;
        if file_type.is_dir() {
            out.push(Entry {
                path: rel(base, &path),
                kind: "dir",
                size: None,
                sha256: None,
            });
            collect(base, &path, out)?;
        } else if file_type.is_file() {
            let bytes = fs::read(&path).map_err(|e| format!("read {}: {e}", rel(base, &path)))?;
            out.push(Entry {
                path: rel(base, &path),
                kind: "file",
                size: Some(bytes.len() as u64),
                sha256: Some(sha256_bytes(&bytes)),
            });
        } else {
            out.push(Entry {
                path: rel(base, &path),
                kind: "other",
                size: None,
                sha256: None,
            });
        }
    }
    Ok(())
}

/// `(relative path, sha256)` for the file entries of a walk.
pub fn file_pairs(entries: &[Entry]) -> Vec<(String, String)> {
    let mut pairs: Vec<(String, String)> = entries
        .iter()
        .filter(|entry| entry.kind == "file")
        .map(|entry| (entry.path.clone(), entry.sha256.clone().unwrap_or_default()))
        .collect();
    pairs.sort();
    pairs
}
