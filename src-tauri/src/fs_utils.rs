use std::collections::HashSet;
use std::fs;
#[cfg(not(windows))]
use std::io::{Read, Write};
use std::path::Path;

const MAX_COPY_DEPTH: usize = 128;
#[cfg(not(windows))]
const COPY_BUFFER_BYTES: usize = 1024 * 1024;

#[cfg(unix)]
fn inode_key(meta: &fs::Metadata) -> (u64, u64) {
    use std::os::unix::fs::MetadataExt;
    (meta.dev(), meta.ino())
}

#[cfg(test)]
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

#[cfg(test)]
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

    let source_meta = fs::symlink_metadata(src).map_err(|e| e.to_string())?;
    if source_meta.file_type().is_symlink() || !source_meta.is_dir() {
        return Err(format!(
            "Refusing to recursively copy a non-directory source: {}",
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
        let ik = inode_key(&source_meta);
        log::debug!("[fs_utils] Visiting inode {:?} at {}", ik, src.display());
    }

    let created_destination = match fs::symlink_metadata(dest) {
        Ok(meta) if meta.file_type().is_symlink() || !meta.is_dir() => {
            return Err(format!(
                "Refusing to copy through unsafe destination: {}",
                dest.display()
            ));
        }
        Ok(_) => false,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let builder = fs::DirBuilder::new();
            #[cfg(unix)]
            let mut builder = builder;
            #[cfg(unix)]
            {
                use std::os::unix::fs::DirBuilderExt;
                builder.mode(0o700);
            }
            builder
                .create(dest)
                .map_err(|e| format!("Failed to create directory: {}", e))?;
            true
        }
        Err(error) => return Err(format!("Failed to inspect destination: {}", error)),
    };

    for entry_result in fs::read_dir(src).map_err(|e| e.to_string())? {
        if is_cancelled() {
            return Err("Operation cancelled".to_string());
        }
        let entry =
            entry_result.map_err(|error| format!("Cannot read {}: {}", src.display(), error))?;
        let entry_path = entry.path();
        let target = dest.join(entry.file_name());
        let meta = fs::symlink_metadata(&entry_path).map_err(|e| e.to_string())?;

        if meta.file_type().is_symlink() {
            copy_symlink(&entry_path, &target)?;
        } else if meta.is_dir() {
            copy_dir_recursive_inner_cancellable(
                &entry_path,
                &target,
                visited,
                depth + 1,
                is_cancelled,
            )?;
        } else {
            copy_file_cancellable(&entry_path, &target, is_cancelled)?;
        }
    }
    if created_destination {
        crate::copy_metadata::preserve_directory(src, dest, is_cancelled)?;
    }
    Ok(())
}

/// Copy one regular file in bounded chunks so cancellation remains responsive
/// even for multi-gigabyte files. Destination is create-new to avoid following
/// a symlink planted after the operation was planned.
#[cfg(not(windows))]
pub fn copy_file_cancellable(
    src: &Path,
    dest: &Path,
    is_cancelled: &impl Fn() -> bool,
) -> Result<(), String> {
    if is_cancelled() {
        return Err("Operation cancelled".to_string());
    }
    let mut input = crate::file_operations::open_regular_read(src)
        .map_err(|e| format!("Failed to open source: {}", e))?;
    let metadata = input.metadata().map_err(|e| e.to_string())?;
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut output = options
        .open(dest)
        .map_err(|e| format!("Failed to create destination: {}", e))?;
    let mut buffer = vec![0u8; COPY_BUFFER_BYTES];
    let result = (|| -> Result<(), String> {
        let mut remaining = metadata.len();
        loop {
            if is_cancelled() {
                return Err("Operation cancelled".to_string());
            }
            let limit = (remaining.saturating_add(1)).min(buffer.len() as u64) as usize;
            let read = input
                .read(&mut buffer[..limit])
                .map_err(|e| format!("Failed to read source: {}", e))?;
            if read as u64 > remaining || (read == 0 && remaining != 0) {
                return Err("Source changed while copying".to_string());
            }
            remaining -= read as u64;
            if read == 0 {
                break;
            }
            output
                .write_all(&buffer[..read])
                .map_err(|e| format!("Failed to write destination: {}", e))?;
        }
        let after = input.metadata().map_err(|error| error.to_string())?;
        if after.len() != metadata.len() || after.modified().ok() != metadata.modified().ok() {
            return Err("Source changed while copying".to_string());
        }
        crate::copy_metadata::preserve(&input, &output, is_cancelled)?;
        output
            .sync_all()
            .map_err(|e| format!("Failed to flush destination: {}", e))?;
        Ok(())
    })();
    drop(output);
    if result.is_err() {
        let _ = fs::remove_file(dest);
    }
    result
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
#[cfg(windows)]
pub fn copy_file_cancellable(
    source: &Path,
    destination: &Path,
    cancelled: &impl Fn() -> bool,
) -> Result<(), String> {
    use std::{ffi::c_void, os::windows::io::AsRawHandle};
    use windows::{
        core::HSTRING,
        Win32::{
            Foundation::HANDLE,
            Storage::FileSystem::{
                CopyFileExW, GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
                LPPROGRESS_ROUTINE_CALLBACK_REASON,
            },
        },
    };
    if cancelled() {
        return Err("Operation cancelled".to_string());
    }
    let input = crate::file_operations::open_regular_read(source)?;
    let mut expected = BY_HANDLE_FILE_INFORMATION::default();
    unsafe { GetFileInformationByHandle(HANDLE(input.as_raw_handle()), &mut expected) }
        .map_err(|error| error.to_string())?;
    struct Context<'a, F> {
        cancelled: &'a F,
        expected: BY_HANDLE_FILE_INFORMATION,
        changed: bool,
    }
    unsafe extern "system" fn progress<F: Fn() -> bool>(
        _: i64,
        _: i64,
        _: i64,
        _: i64,
        _: u32,
        _: LPPROGRESS_ROUTINE_CALLBACK_REASON,
        source: HANDLE,
        _: HANDLE,
        data: *const c_void,
    ) -> u32 {
        let context = &mut *data.cast_mut().cast::<Context<'_, F>>();
        let mut actual = BY_HANDLE_FILE_INFORMATION::default();
        if GetFileInformationByHandle(source, &mut actual).is_err()
            || actual.dwVolumeSerialNumber != context.expected.dwVolumeSerialNumber
            || actual.nFileIndexHigh != context.expected.nFileIndexHigh
            || actual.nFileIndexLow != context.expected.nFileIndexLow
        {
            context.changed = true;
            return 1; // PROGRESS_CANCEL deletes partial output.
        }
        u32::from(
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(context.cancelled))
                .unwrap_or(true),
        )
    }
    fn run<F: Fn() -> bool>(
        source: &Path,
        destination: &Path,
        context: &mut Context<'_, F>,
    ) -> windows::core::Result<()> {
        unsafe {
            CopyFileExW(
                &HSTRING::from(source.as_os_str()),
                &HSTRING::from(destination.as_os_str()),
                Some(progress::<F>),
                Some(std::ptr::from_mut(context).cast()),
                None,
                0x1 | 0x800, // COPY_FILE_FAIL_IF_EXISTS | COPY_FILE_COPY_SYMLINK
            )
        }
    }
    let mut context = Context {
        cancelled,
        expected,
        changed: false,
    };
    let result = run(source, destination, &mut context);
    if context.changed {
        return Err("Source changed while copying".to_string());
    }
    if cancelled() {
        return Err("Operation cancelled".to_string());
    }
    result.map_err(|error| format!("Cannot copy file and native streams: {error}"))?;
    if let Err(error) = crate::copy_metadata::preserve_windows_acl(source, destination) {
        let _ = fs::remove_file(destination);
        return Err(error);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    #[cfg(unix)]
    #[test]
    fn copy_preserves_private_and_executable_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let temp = tempfile::tempdir().unwrap();
        for mode in [0o600, 0o700] {
            let source = temp.path().join(format!("source-{mode}"));
            let destination = temp.path().join(format!("destination-{mode}"));
            fs::write(&source, b"private").unwrap();
            fs::set_permissions(&source, fs::Permissions::from_mode(mode)).unwrap();
            copy_file_cancellable(&source, &destination, &|| false).unwrap();
            assert_eq!(
                fs::metadata(destination).unwrap().permissions().mode() & 0o777,
                mode
            );
        }
    }

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
        let result =
            copy_dir_recursive_cancellable(&src, &dst, &|| cc.fetch_add(1, Ordering::SeqCst) >= 2);

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

        assert_eq!(
            fs::read_to_string(dst.join("root.txt")).unwrap(),
            "root content"
        );
        assert_eq!(
            fs::read_to_string(dst.join("nested/leaf.txt")).unwrap(),
            "leaf content"
        );
    }
}
