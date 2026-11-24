//! Pure helpers for reading launch arguments and early settings.
//!
//! Ported from `src-tauri/src/main.rs`. Behavior is unchanged.

use std::io::Read;
use std::path::PathBuf;

pub fn early_settings_path() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    let base = std::env::var("APPDATA").ok().map(PathBuf::from);

    #[cfg(target_os = "macos")]
    let base = std::env::var("HOME")
        .ok()
        .map(|h| PathBuf::from(h).join("Library").join("Application Support"));

    #[cfg(target_os = "linux")]
    let base = std::env::var("XDG_DATA_HOME")
        .ok()
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var("HOME")
                .ok()
                .map(|h| PathBuf::from(h).join(".local").join("share"))
        });

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    let base: Option<PathBuf> = None;

    base.map(|b| b.join("run.rosie.iyeris").join("settings.json"))
}

pub fn read_early_setting_bool(key: &str) -> bool {
    early_settings_path()
        .and_then(|path| {
            let file = crate::file_operations::open_regular_read(&path).ok()?;
            let size = file.metadata().ok()?.len();
            const MAX_EARLY_SETTINGS_BYTES: u64 = 8 * 1024 * 1024;
            if size > MAX_EARLY_SETTINGS_BYTES {
                return None;
            }
            let mut content = String::with_capacity(size as usize);
            file.take(MAX_EARLY_SETTINGS_BYTES.saturating_add(1))
                .read_to_string(&mut content)
                .ok()?;
            (content.len() as u64 <= MAX_EARLY_SETTINGS_BYTES).then_some(content)
        })
        .and_then(|content| serde_json::from_str::<serde_json::Value>(&content).ok())
        .and_then(|json| json.get(key).and_then(|v| v.as_bool()))
        .unwrap_or(false)
}

pub fn has_minimized_launch_arg(args: &[String]) -> bool {
    args.iter().any(|a| a == "--minimized" || a == "--hidden")
}

/// M7: returns a path passed in argv to a single-instance / startup launch,
/// after additional sanity checks. Previously any absolute existing path was
/// accepted; the frontend would then navigate the user to whatever showed up.
/// We now also:
///  * reject NUL bytes and non-whitespace control characters
///  * canonicalize and require the target to exist
///
/// Arguments arrive through argv rather than a shell, so shell-looking
/// characters (and newlines, which are valid filenames) are allowed.
pub fn first_open_path_arg(args: &[String]) -> Option<String> {
    for arg in args.iter().skip(1) {
        if arg.starts_with("--") {
            continue;
        }
        if arg
            .chars()
            .any(|c| c == '\0' || (c.is_control() && !matches!(c, '\t' | '\n' | '\r')))
        {
            log::warn!("[SingleInstance] rejecting arg with control character");
            continue;
        }
        let path = std::path::Path::new(arg);
        if !path.is_absolute() {
            continue;
        }
        match path.canonicalize() {
            Ok(canonical) if canonical.exists() => {
                return Some(canonical.to_string_lossy().to_string());
            }
            _ => continue,
        }
    }
    None
}

#[cfg(test)]
#[path = "launch_tests.rs"]
mod tests;
