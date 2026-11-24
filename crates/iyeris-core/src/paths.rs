//! Filesystem path validation, secure temp files and app-state directory helpers.
//!
//! Ported from `src-tauri/src/main.rs`. Behavior is unchanged.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

static TEMP_FILE_COUNTER: AtomicU64 = AtomicU64::new(1);
static DEV_MODE: AtomicBool = AtomicBool::new(false);

pub fn is_dev_mode() -> bool {
    DEV_MODE.load(Ordering::Relaxed)
}

/// Sets the process-wide dev-mode flag. The host calls this once at startup.
pub fn set_dev_mode(enabled: bool) {
    DEV_MODE.store(enabled, Ordering::Relaxed);
}

pub fn make_temp_path(path: &Path, purpose: &str) -> PathBuf {
    let counter = TEMP_FILE_COUNTER.fetch_add(1, Ordering::Relaxed);
    let pid = std::process::id();
    let suffix = format!("{}.{}.{}.tmp", purpose, pid, counter);
    let extension = match path.extension().and_then(|ext| ext.to_str()) {
        Some(ext) if !ext.is_empty() => format!("{}.{}", ext, suffix),
        _ => suffix,
    };
    path.with_extension(extension)
}

/// Reserve a unique temporary sibling without following a pre-existing
/// symlink. Callers must keep the returned file handle until they are ready to
/// write; the path is only used for the final atomic rename/cleanup.
pub fn create_secure_temp_file(
    path: &Path,
    purpose: &str,
) -> Result<(PathBuf, std::fs::File), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "Temporary file has no parent directory".to_string())?;
    let parent_metadata = std::fs::symlink_metadata(parent).map_err(|error| {
        format!(
            "Failed to inspect temporary-file parent {}: {}",
            parent.display(),
            error
        )
    })?;
    if parent_metadata.file_type().is_symlink() || !parent_metadata.is_dir() {
        return Err(format!(
            "Temporary-file parent is not a real directory: {}",
            parent.display()
        ));
    }
    for _ in 0..32 {
        let candidate = make_temp_path(path, purpose);
        match std::fs::OpenOptions::new()
            .write(true)
            .read(true)
            .create_new(true)
            .open(&candidate)
        {
            Ok(file) => return Ok((candidate, file)),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(format!(
                    "Failed to create secure temporary file {}: {}",
                    candidate.display(),
                    error
                ));
            }
        }
    }
    Err("Unable to reserve a unique temporary file".to_string())
}

/// Publish a fully-written temporary file over a regular destination.
///
/// `std::fs::rename` replaces an existing file on Unix, but returns
/// `AlreadyExists` on Windows. Keep the replacement atomic on both platforms
/// so settings, indexes, thumbnails, and native integration files can be
/// refreshed repeatedly without a delete-then-write gap.
pub fn atomic_replace_file(temp: &Path, destination: &Path) -> Result<(), String> {
    if let Ok(metadata) = std::fs::symlink_metadata(destination) {
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err(format!(
                "Refusing to replace unsafe destination: {}",
                destination.display()
            ));
        }
    }

    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows::core::PCWSTR;
        use windows::Win32::Storage::FileSystem::{
            MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
        };

        let from: Vec<u16> = temp
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let to: Vec<u16> = destination
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        // SAFETY: both buffers are valid, NUL-terminated UTF-16 strings owned
        // for the duration of the call.
        unsafe {
            MoveFileExW(
                PCWSTR(from.as_ptr()),
                PCWSTR(to.as_ptr()),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
        }
        .map_err(|error| format!("Failed to publish {}: {}", destination.display(), error))
    }

    #[cfg(not(windows))]
    {
        std::fs::rename(temp, destination)
            .map_err(|error| format!("Failed to publish {}: {}", destination.display(), error))
    }
}

/// Ensure a directory exists without traversing a symlinked component. The
/// standard `create_dir_all` follows symlinks in existing parents, which is
/// unsafe for app-owned state paths that may be redirected by another local
/// process. Create missing components one at a time and lstat each result.
#[cfg_attr(target_os = "windows", allow(dead_code))]
pub fn ensure_real_directory_tree(path: &Path, label: &str) -> Result<(), String> {
    let mut missing = Vec::new();
    let mut cursor = path;
    let existing = loop {
        match std::fs::symlink_metadata(cursor) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() || !metadata.is_dir() {
                    return Err(format!(
                        "{} is not a real directory: {}",
                        label,
                        cursor.display()
                    ));
                }
                break cursor;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let name = cursor
                    .file_name()
                    .ok_or_else(|| format!("Cannot determine {} parent directory", label))?;
                missing.push(name.to_os_string());
                cursor = cursor
                    .parent()
                    .ok_or_else(|| format!("Cannot determine {} parent directory", label))?;
            }
            Err(error) => {
                return Err(format!("Cannot inspect {}: {}", label, error));
            }
        }
    };

    ensure_no_symlink_components(existing, label)?;
    let mut current = existing.to_path_buf();
    for component in missing.iter().rev() {
        current.push(component);
        match std::fs::symlink_metadata(&current) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() || !metadata.is_dir() {
                    return Err(format!(
                        "{} is not a real directory: {}",
                        label,
                        current.display()
                    ));
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                std::fs::create_dir(&current).map_err(|create_error| {
                    format!(
                        "Failed to create {} {}: {}",
                        label,
                        current.display(),
                        create_error
                    )
                })?;
                let metadata = std::fs::symlink_metadata(&current).map_err(|e| e.to_string())?;
                if metadata.file_type().is_symlink() || !metadata.is_dir() {
                    return Err(format!(
                        "{} changed into an unsafe path: {}",
                        label,
                        current.display()
                    ));
                }
            }
            Err(error) => {
                return Err(format!("Cannot inspect {}: {}", label, error));
            }
        }
    }
    Ok(())
}

/// Reject a path that traverses any symbolic-link component. This is used for
/// app-owned state paths where accepting a directory symlink could redirect a
/// write outside the location the application selected. Callers pass an
/// existing path (normally a parent directory), so every ancestor can be
/// inspected with lstat semantics.
pub fn ensure_no_symlink_components(path: &Path, label: &str) -> Result<(), String> {
    if path
        .components()
        .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return Err(format!("{} path contains a parent traversal", label));
    }

    let mut current = path;
    loop {
        let metadata = std::fs::symlink_metadata(current).map_err(|error| {
            format!(
                "Cannot inspect {} path {}: {}",
                label,
                current.display(),
                error
            )
        })?;
        #[cfg(target_os = "macos")]
        let system_alias = matches!(current.to_str(), Some("/var" | "/tmp" | "/etc"))
            && std::fs::read_link(current).ok().is_some_and(|target| {
                target == Path::new("private").join(current.file_name().unwrap_or_default())
                    || target == Path::new("/private").join(current.file_name().unwrap_or_default())
            });
        #[cfg(not(target_os = "macos"))]
        let system_alias = false;
        if metadata.file_type().is_symlink() && !system_alias {
            return Err(format!(
                "{} path traverses a symbolic link: {}",
                label,
                current.display()
            ));
        }
        if current.parent().is_none() || current.parent() == Some(current) {
            break;
        }
        current = current.parent().expect("parent checked above");
    }
    Ok(())
}

/// Create an application-state directory tree and return its canonical path.
///
/// Unlike user-selected paths, app-state roots may legitimately be redirected
/// by the OS (for example a home directory backed by a symlink, or a Windows
/// junction for AppData). Those trusted ancestor links must be allowed, but the
/// final state directory itself must be a real directory: accepting a
/// symlink/reparse point there would let another local process redirect
/// settings, index, or thumbnail writes after startup.
pub fn ensure_app_state_directory(path: &Path, label: &str) -> Result<PathBuf, String> {
    std::fs::create_dir_all(path)
        .map_err(|error| format!("Failed to create {} {}: {}", label, path.display(), error))?;
    let metadata = std::fs::symlink_metadata(path)
        .map_err(|error| format!("Cannot inspect {} {}: {}", label, path.display(), error))?;
    if metadata.file_type().is_symlink()
        || metadata_is_reparse_point(&metadata)
        || !metadata.is_dir()
    {
        return Err(format!(
            "{} is not a real directory: {}",
            label,
            path.display()
        ));
    }
    path.canonicalize()
        .map_err(|error| format!("Cannot resolve {} {}: {}", label, path.display(), error))
}

#[cfg(target_os = "windows")]
fn metadata_is_reparse_point(metadata: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(target_os = "windows"))]
fn metadata_is_reparse_point(_metadata: &std::fs::Metadata) -> bool {
    false
}

pub fn validate_path(raw: &str, label: &str) -> Result<PathBuf, String> {
    if raw.trim().is_empty() {
        return Err(format!("{} path is required", label));
    }
    // IPC callers can otherwise force every path-taking command to copy and
    // log arbitrarily large strings before the OS rejects them. Keep a
    // generous cross-platform bound (well above native path limits) and
    // reject embedded NULs before constructing a PathBuf.
    const MAX_PATH_BYTES: usize = 1024 * 1024;
    if raw.len() > MAX_PATH_BYTES {
        return Err(format!(
            "{} path exceeds the {} byte limit",
            label, MAX_PATH_BYTES
        ));
    }
    if raw.contains('\0') {
        return Err(format!("{} path contains a NUL character", label));
    }
    let path = PathBuf::from(raw);
    if !path.is_absolute() {
        return Err(format!("{} path must be absolute: {}", label, raw));
    }
    Ok(path)
}

pub fn validate_existing_path(raw: &str, label: &str) -> Result<PathBuf, String> {
    let path = validate_path(raw, label)?;
    match std::fs::symlink_metadata(&path) {
        Ok(_) => Ok(path),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Err(format!("{} path does not exist: {}", label, path.display()))
        }
        Err(error) => Err(format!(
            "Failed to access {} path {}: {}",
            label,
            path.display(),
            error
        )),
    }
}

pub fn ensure_not_root_path(path: &Path, action: &str) -> Result<(), String> {
    let canonical = match path.canonicalize() {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            // Copy/move destinations may not exist yet. Resolve the nearest
            // existing parent without falling back to the raw path; reject
            // symlink ancestors so a later privileged/mutating call cannot be
            // redirected through a swapped parent.
            let mut missing = Vec::new();
            let mut cursor = path;
            let existing = loop {
                match std::fs::symlink_metadata(cursor) {
                    Ok(metadata) => {
                        if metadata.file_type().is_symlink() || !metadata.is_dir() {
                            return Err(format!(
                                "Cannot safely resolve path before attempting to {}",
                                action
                            ));
                        }
                        break cursor;
                    }
                    Err(next_error) if next_error.kind() == std::io::ErrorKind::NotFound => {
                        let name = cursor.file_name().ok_or_else(|| {
                            format!("Cannot safely resolve path before attempting to {}", action)
                        })?;
                        missing.push(name.to_os_string());
                        cursor = cursor.parent().ok_or_else(|| {
                            format!("Cannot safely resolve path before attempting to {}", action)
                        })?;
                    }
                    Err(next_error) => {
                        return Err(format!(
                            "Cannot safely resolve path before attempting to {}: {}",
                            action, next_error
                        ));
                    }
                }
            };
            let mut resolved = existing.canonicalize().map_err(|resolve_error| {
                format!(
                    "Cannot safely resolve path before attempting to {}: {}",
                    action, resolve_error
                )
            })?;
            for component in missing.iter().rev() {
                resolved.push(component);
            }
            resolved
        }
        Err(error) => {
            return Err(format!(
                "Cannot safely resolve path before attempting to {}: {}",
                action, error
            ));
        }
    };
    if canonical.parent().is_none() {
        return Err(format!("Cannot {} a root directory", action));
    }
    Ok(())
}

#[cfg(test)]
#[path = "paths_tests.rs"]
mod tests;
