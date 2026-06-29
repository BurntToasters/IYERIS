use std::collections::HashSet;
use std::fs;
use std::path::Path;

const MAX_COPY_DEPTH: usize = 128;

#[cfg(unix)]
fn inode_key(meta: &fs::Metadata) -> (u64, u64) {
    use std::os::unix::fs::MetadataExt;
    (meta.dev(), meta.ino())
}

pub fn copy_dir_recursive(src: &Path, dest: &Path) -> Result<(), String> {
    let mut visited = HashSet::new();
    copy_dir_recursive_inner(src, dest, &mut visited, 0)
}

/// Like [`copy_dir_recursive`] but calls `is_cancelled()` between entries.
/// Returns `Err("Operation cancelled")` as soon as the predicate is true,
/// allowing callers to interrupt a large directory copy mid-flight.
pub fn copy_dir_recursive_cancellable(
    src: &Path,
    dest: &Path,
    is_cancelled: &impl Fn() -> bool,
) -> Result<(), String> {
    let mut visited = HashSet::new();
    copy_dir_recursive_inner_cancellable(src, dest, &mut visited, 0, is_cancelled)
}

fn copy_dir_recursive_inner(
    src: &Path,
    dest: &Path,
    visited: &mut HashSet<String>,
    depth: usize,
) -> Result<(), String> {
    copy_dir_recursive_inner_cancellable(src, dest, visited, depth, &|| false)
}

fn copy_dir_recursive_inner_cancellable(
    src: &Path,
    dest: &Path,
    visited: &mut HashSet<String>,
    depth: usize,
    is_cancelled: &impl Fn() -> bool,
) -> Result<(), String> {
    if is_cancelled() {
        return Err("Operation cancelled".to_string());
    }
    if depth > MAX_COPY_DEPTH {
        return Err(format!(
            "Maximum directory depth ({}) exceeded at: {}",
            MAX_COPY_DEPTH,
            src.display()
        ));
    }

    let canonical = src
        .canonicalize()
        .map_err(|e| format!("Failed to resolve path {}: {}", src.display(), e))?;
    let key = canonical.to_string_lossy().to_string();
    if !visited.insert(key) {
        log::warn!("[fs_utils] Skipping directory cycle: {}", src.display());
        return Ok(());
    }

    #[cfg(unix)]
    {
        let meta = fs::symlink_metadata(src).map_err(|e| e.to_string())?;
        let ik = inode_key(&meta);
        log::debug!("[fs_utils] Visiting inode {:?} at {}", ik, src.display());
    }

    fs::create_dir_all(dest).map_err(|e| format!("Failed to create directory: {}", e))?;

    for entry_result in fs::read_dir(src).map_err(|e| e.to_string())? {
        if is_cancelled() {
            return Err("Operation cancelled".to_string());
        }
        let entry = match entry_result {
            Ok(e) => e,
            Err(err) => {
                log::warn!(
                    "[fs_utils] Skipping unreadable entry in {}: {}",
                    src.display(),
                    err
                );
                continue;
            }
        };
        let entry_path = entry.path();
        let target = dest.join(entry.file_name());
        let meta = fs::symlink_metadata(&entry_path).map_err(|e| e.to_string())?;

        if meta.file_type().is_symlink() {
            copy_symlink(&entry_path, &target)?;
        } else if meta.is_dir() {
            copy_dir_recursive_inner_cancellable(&entry_path, &target, visited, depth + 1, is_cancelled)?;
        } else {
            fs::copy(&entry_path, &target).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

fn copy_symlink(source: &Path, target: &Path) -> Result<(), String> {
    let link_target = fs::read_link(source).map_err(|e| e.to_string())?;

    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(&link_target, target)
            .map_err(|e| format!("Failed to create symlink: {}", e))?;
    }

    #[cfg(windows)]
    {
        fn map_win_symlink_err(e: std::io::Error) -> String {
            if e.raw_os_error() == Some(1314) || e.raw_os_error() == Some(5) {
                "Failed to create symlink: Administrator privileges required (or enable Developer Mode)".to_string()
            } else {
                format!("Failed to create symlink: {}", e)
            }
        }
        let is_dir_link = fs::symlink_metadata(source)
            .map(|m| m.is_dir())
            .unwrap_or(false);
        if is_dir_link {
            std::os::windows::fs::symlink_dir(&link_target, target).map_err(map_win_symlink_err)?;
        } else {
            std::os::windows::fs::symlink_file(&link_target, target)
                .map_err(map_win_symlink_err)?;
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    #[test]
    fn copies_nested_directory_tree() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("src");
        let dst = tmp.path().join("dst");
        fs::create_dir_all(src.join("sub")).unwrap();
        fs::write(src.join("a.txt"), "hello").unwrap();
        fs::write(src.join("sub/b.txt"), "world").unwrap();

        copy_dir_recursive(&src, &dst).unwrap();

        assert_eq!(fs::read_to_string(dst.join("a.txt")).unwrap(), "hello");
        assert_eq!(fs::read_to_string(dst.join("sub/b.txt")).unwrap(), "world");
    }

    #[cfg(unix)]
    #[test]
    fn copies_symlink_as_symlink_without_following() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("src");
        let dst = tmp.path().join("dst");
        fs::create_dir_all(&src).unwrap();
        fs::write(src.join("target.txt"), "data").unwrap();
        std::os::unix::fs::symlink("target.txt", src.join("link.txt")).unwrap();

        copy_dir_recursive(&src, &dst).unwrap();

        let meta = fs::symlink_metadata(dst.join("link.txt")).unwrap();
        assert!(meta.file_type().is_symlink());
    }

    // F2: copy_dir_recursive_cancellable must stop as soon as is_cancelled()
    // returns true and return Err("Operation cancelled").
    #[test]
    fn cancellable_copy_stops_immediately_when_cancelled_at_start() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("src");
        let dst = tmp.path().join("dst");
        fs::create_dir_all(&src).unwrap();
        fs::write(src.join("a.txt"), "aaa").unwrap();
        fs::write(src.join("b.txt"), "bbb").unwrap();

        // Always cancelled.
        let result = copy_dir_recursive_cancellable(&src, &dst, &|| true);

        assert!(result.is_err());
        assert_eq!(result.unwrap_err(), "Operation cancelled");
    }

    #[test]
    fn cancellable_copy_completes_when_not_cancelled() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("src");
        let dst = tmp.path().join("dst");
        fs::create_dir_all(&src).unwrap();
        fs::write(src.join("x.txt"), "hello").unwrap();

        let result = copy_dir_recursive_cancellable(&src, &dst, &|| false);

        assert!(result.is_ok());
        assert_eq!(fs::read_to_string(dst.join("x.txt")).unwrap(), "hello");
    }

    #[test]
    fn cancellable_copy_stops_mid_directory_when_cancel_fires() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("src");
        let dst = tmp.path().join("dst");
        fs::create_dir_all(&src).unwrap();
        // Create several files so the cancel flag can fire between entries.
        for i in 0..10 {
            fs::write(src.join(format!("file{}.txt", i)), format!("data{}", i)).unwrap();
        }

        // Cancel after the second file-level check (i.e., mid-directory).
        let call_count = Arc::new(AtomicUsize::new(0));
        let cc = Arc::clone(&call_count);
        let result = copy_dir_recursive_cancellable(&src, &dst, &|| {
            cc.fetch_add(1, Ordering::SeqCst) >= 2
        });

        assert!(result.is_err());
        assert_eq!(result.unwrap_err(), "Operation cancelled");
        // dst might be partially populated but not fully — the point is we stopped.
    }

    #[test]
    fn cancellable_copy_recurses_into_subdirs_and_cancels_there() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("src");
        let sub = src.join("sub");
        let dst = tmp.path().join("dst");
        fs::create_dir_all(&sub).unwrap();
        fs::write(src.join("top.txt"), "top").unwrap();
        fs::write(sub.join("deep.txt"), "deep").unwrap();

        // Cancel on entry to any call (fires before depth check, so subdirectory
        // processing is also interrupted).
        let call_count = Arc::new(AtomicUsize::new(0));
        let cc = Arc::clone(&call_count);
        let result = copy_dir_recursive_cancellable(&src, &dst, &|| {
            // Let the first entry through, cancel on the next recursive call.
            cc.fetch_add(1, Ordering::SeqCst) >= 1
        });

        assert!(result.is_err());
        assert_eq!(result.unwrap_err(), "Operation cancelled");
    }

    // The non-cancellable public wrapper must still work correctly (it delegates
    // to copy_dir_recursive_inner_cancellable with is_cancelled = || false).
    #[test]
    fn non_cancellable_wrapper_still_copies_correctly() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("src");
        let dst = tmp.path().join("dst");
        fs::create_dir_all(src.join("nested")).unwrap();
        fs::write(src.join("root.txt"), "root content").unwrap();
        fs::write(src.join("nested/leaf.txt"), "leaf content").unwrap();

        copy_dir_recursive(&src, &dst).unwrap();

        assert_eq!(fs::read_to_string(dst.join("root.txt")).unwrap(), "root content");
        assert_eq!(fs::read_to_string(dst.join("nested/leaf.txt")).unwrap(), "leaf content");
    }
}
