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

fn copy_dir_recursive_inner(
    src: &Path,
    dest: &Path,
    visited: &mut HashSet<String>,
    depth: usize,
) -> Result<(), String> {
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
            copy_dir_recursive_inner(&entry_path, &target, visited, depth + 1)?;
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
            std::os::windows::fs::symlink_dir(&link_target, target)
                .map_err(map_win_symlink_err)?;
        } else {
            std::os::windows::fs::symlink_file(&link_target, target)
                .map_err(map_win_symlink_err)?;
        }
    }

    Ok(())
}
