use super::*;
use std::fs;
use std::io::{Cursor, Write};
use std::sync::atomic::Ordering;
use std::time::{SystemTime, UNIX_EPOCH};

fn make_test_temp_dir(prefix: &str) -> PathBuf {
    let mut dir = std::env::temp_dir();
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    dir.push(format!(
        "iyeris-{}-{}-{}",
        prefix,
        std::process::id(),
        nonce
    ));
    fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
fn cancelled_copy_fingerprint_never_publishes_destination() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("source");
    let destination = temp.path().join("destination");
    fs::write(&source, b"original").unwrap();
    let cancelled = std::cell::Cell::new(false);
    let result = copy_entry_checked(&source, &destination, &|| cancelled.get(), &mut |staged| {
        cancelled.set(true);
        undo::record_copy_entry(&source, &destination, staged, &|| cancelled.get())
    });
    assert_eq!(result.unwrap_err(), "Operation cancelled");
    assert!(!destination.exists());
    assert_eq!(fs::read(&source).unwrap(), b"original");
    assert_eq!(fs::read_dir(temp.path()).unwrap().count(), 1);
}

#[test]
fn copy_fingerprint_window_releases_mutation_lock() {
    let mut lock = Some(mutation_lock().unwrap());
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("source");
    let destination = temp.path().join("destination");
    fs::write(&source, b"original").unwrap();
    copy_entry_checked(&source, &destination, &|| false, &mut |staged| {
        drop(lock.take());
        // FILE_OP_LOCK is not recursive. A missed drop would make this hang
        // or fail; success proves the fingerprint window is unlocked.
        drop(try_mutation_lock()?);
        let recorded = undo::record_copy_entry(&source, &destination, staged, &|| false);
        lock = Some(mutation_lock().unwrap());
        recorded
    })
    .unwrap();
    assert!(lock.is_some());
    assert_eq!(fs::read(&destination).unwrap(), b"original");
}

#[test]
fn later_copy_failure_keeps_and_reports_replaced_published_entry() {
    let temp = tempfile::tempdir().unwrap();
    let source_a = temp.path().join("source-a");
    let source_b = temp.path().join("source-b");
    let destination_a = temp.path().join("destination-a");
    let destination_b = temp.path().join("destination-b");
    fs::write(&source_a, b"first copy").unwrap();
    fs::write(&source_b, b"second copy").unwrap();

    let recorded = copy_entry_checked(&source_a, &destination_a, &|| false, &mut |staged| {
        undo::record_copy_entry(&source_a, &destination_a, staged, &|| false)
    })
    .unwrap();
    fs::write(&destination_a, b"user edit").unwrap();
    let second = copy_entry_checked(&source_b, &destination_b, &|| false, &mut |_| {
        Err::<(), _>("injected later fingerprint failure".to_string())
    });
    assert_eq!(second.unwrap_err(), "injected later fingerprint failure");

    let cleanup_errors = rollback_published_copies(&[recorded]);
    assert_eq!(fs::read(&destination_a).unwrap(), b"user edit");
    assert_eq!(fs::read(&source_a).unwrap(), b"first copy");
    assert_eq!(cleanup_errors.len(), 1);
    assert!(cleanup_errors[0].contains(&destination_a.to_string_lossy().to_string()));
}

#[test]
fn queued_mutation_wait_cancels_without_entering_the_global_lock() {
    use std::sync::atomic::AtomicBool;
    use std::sync::mpsc;
    use std::thread;
    use std::time::{Duration, Instant};

    let held = mutation_lock().unwrap();
    let token = std::sync::Arc::new(AtomicBool::new(false));
    let queued_token = std::sync::Arc::clone(&token);
    let (sender, receiver) = mpsc::channel();
    let worker = thread::spawn(move || {
        let started = Instant::now();
        let result = mutation_lock_cancellable(Some(&queued_token));
        sender.send((started.elapsed(), result.is_err())).unwrap();
    });

    thread::sleep(Duration::from_millis(30));
    token.store(true, Ordering::Relaxed);
    let (elapsed, cancelled) = receiver
        .recv_timeout(Duration::from_millis(500))
        .expect("queued operation should observe cancellation promptly");
    assert!(cancelled);
    assert!(elapsed < Duration::from_millis(500));
    assert!(
        try_mutation_lock().is_err(),
        "cancelled waiter must not acquire the lock"
    );
    drop(held);
    worker.join().unwrap();
}

#[test]
fn cross_volume_staging_cancellation_restores_source() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("source");
    let destination = temp.path().join("destination");
    fs::create_dir(&source).unwrap();
    fs::write(source.join("file"), b"contents").unwrap();
    let result = copy_then_remove_source(&source, &destination, false, true, &|| true);
    assert_eq!(result.unwrap_err(), "Operation cancelled");
    assert_eq!(fs::read(source.join("file")).unwrap(), b"contents");
    assert!(!destination.exists());
    assert_eq!(fs::read_dir(temp.path()).unwrap().count(), 1);
}

#[cfg(unix)]
#[test]
fn cross_volume_cleanup_failure_keeps_complete_destination() {
    use std::os::unix::fs::PermissionsExt;
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("source");
    let destination = temp.path().join("destination");
    fs::create_dir_all(source.join("locked")).unwrap();
    fs::write(source.join("locked/file"), b"irreplaceable").unwrap();
    fs::set_permissions(source.join("locked"), fs::Permissions::from_mode(0o555)).unwrap();
    let result = copy_then_remove_source(&source, &destination, false, true, &|| false);
    assert_eq!(
        fs::read(destination.join("locked/file")).unwrap(),
        b"irreplaceable"
    );
    // Privileged test runners can delete through read-only permission bits.
    if let Err(error) = result {
        assert!(error.contains("Complete copy retained"));
    }
    for entry in fs::read_dir(temp.path()).unwrap() {
        let locked = entry.unwrap().path().join("locked");
        if locked.exists() {
            fs::set_permissions(locked, fs::Permissions::from_mode(0o755)).unwrap();
        }
    }
}

#[test]
fn failed_overwrite_restore_preserves_backup_and_reports_location() {
    let temp = tempfile::tempdir().unwrap();
    let destination = temp.path().join("destination");
    let backup = temp.path().join("backup");
    fs::write(&destination, b"new occupant").unwrap();
    fs::write(&backup, b"original data").unwrap();
    let backups = HashMap::from([(
        "item".to_string(),
        OverwriteBackup {
            dest_path: destination.clone(),
            backup_path: backup.clone(),
            fingerprint: undo::path_fingerprint(&backup, &|| false).unwrap(),
        },
    )]);
    let errors = restore_overwrite_backups(&backups);
    assert_eq!(errors.len(), 1);
    assert!(errors[0].contains(backup.to_str().unwrap()));
    assert_eq!(fs::read(destination).unwrap(), b"new occupant");
    assert_eq!(fs::read(backup).unwrap(), b"original data");
}

#[test]
fn failed_copy_publication_preserves_occupied_destination() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("source");
    let destination = temp.path().join("destination");
    fs::write(&source, b"source").unwrap();
    fs::write(&destination, b"new occupant").unwrap();
    assert!(copy_entry_exclusive(&source, &destination, &|| false).is_err());
    assert_eq!(fs::read(destination).unwrap(), b"new occupant");
    assert_eq!(fs::read_dir(temp.path()).unwrap().count(), 2);
}

#[test]
fn conflict_resolution_payload_is_bounded() {
    let mut resolutions = HashMap::new();
    resolutions.insert("name.txt".to_string(), "overwrite".to_string());
    assert!(validate_conflict_resolutions(Some(&resolutions)).is_ok());

    let mut oversized = HashMap::new();
    oversized.insert(
        "x".repeat(MAX_MUTATION_PATH_BYTES + 1),
        "rename".to_string(),
    );
    assert!(validate_conflict_resolutions(Some(&oversized)).is_err());
}

#[test]
fn percent_decode_lossy_decodes_hex_sequences() {
    assert_eq!(percent_decode_lossy("Alpha%20Beta"), "Alpha Beta");
    assert_eq!(percent_decode_lossy("%2fpath%2Ffile"), "/path/file");
}

#[test]
fn preferred_drop_effect_distinguishes_explorer_cut_and_copy() {
    assert_eq!(
        clipboard_operation_from_preferred_drop_effect(Some(1)),
        Some("copy")
    );
    assert_eq!(
        clipboard_operation_from_preferred_drop_effect(Some(2)),
        Some("cut")
    );
}

#[test]
fn preferred_drop_effect_ignores_unknown_or_missing_values() {
    assert_eq!(clipboard_operation_from_preferred_drop_effect(None), None);
    assert_eq!(
        clipboard_operation_from_preferred_drop_effect(Some(0)),
        None
    );
    assert_eq!(
        clipboard_operation_from_preferred_drop_effect(Some(4)),
        None
    );
}

#[test]
fn clipboard_paths_are_bounded_before_state_storage() {
    let first = "a".repeat(MAX_MUTATION_PATH_BYTES);
    let bounded = bound_clipboard_paths(vec![first, "second".to_string()]);
    assert_eq!(bounded.len(), 1);
    assert_eq!(bounded[0].len(), MAX_MUTATION_PATH_BYTES);

    let many = (0..=MAX_MUTATION_ITEMS)
        .map(|index| format!("/tmp/item-{index}"))
        .collect::<Vec<_>>();
    assert_eq!(bound_clipboard_paths(many).len(), MAX_MUTATION_ITEMS);
}

#[test]
fn preview_read_guard_rejects_sensitive_paths() {
    assert!(ensure_safe_preview_read_path(Path::new("/home/me/.ssh/id_rsa")).is_err());
    assert!(ensure_safe_preview_read_path(Path::new("/home/me/.aws/config")).is_err());
    assert!(ensure_safe_preview_read_path(Path::new("/home/me/cert.pem")).is_err());
}

#[test]
fn preview_read_guard_allows_normal_paths() {
    assert!(ensure_safe_preview_read_path(Path::new("/home/me/Documents/readme.txt")).is_ok());
    assert!(ensure_safe_preview_read_path(Path::new("/tmp/photo.png")).is_ok());
}

#[cfg(unix)]
#[test]
fn preview_read_guard_checks_symlink_targets() {
    use std::os::unix::fs::symlink;

    let dir = make_test_temp_dir("preview-symlink");
    let secret_dir = dir.join(".ssh");
    fs::create_dir_all(&secret_dir).unwrap();
    let secret = secret_dir.join("id_ed25519");
    fs::write(&secret, "secret").unwrap();
    let link = dir.join("preview.txt");
    symlink(&secret, &link).unwrap();

    assert!(ensure_safe_preview_read_path(&link).is_err());
    let _ = fs::remove_dir_all(&dir);
}

#[cfg(target_os = "windows")]
#[test]
fn decode_file_uri_path_supports_windows_drive_and_unc() {
    assert_eq!(
        decode_file_uri_path("file:///C:/Program%20Files/IYERIS/test.txt"),
        Some("C:\\Program Files\\IYERIS\\test.txt".to_string())
    );
    assert_eq!(
        decode_file_uri_path("file://localhost/C:/Windows"),
        Some("C:\\Windows".to_string())
    );
    assert_eq!(
        decode_file_uri_path("file://server/share/folder%20a"),
        Some("\\\\server\\share\\folder a".to_string())
    );
}

#[cfg(not(target_os = "windows"))]
#[test]
fn decode_file_uri_path_supports_unix_and_network_forms() {
    assert_eq!(
        decode_file_uri_path("file:///home/user/My%20File.txt"),
        Some("/home/user/My File.txt".to_string())
    );
    assert_eq!(
        decode_file_uri_path("file://localhost/tmp/example"),
        Some("/tmp/example".to_string())
    );
    assert_eq!(
        decode_file_uri_path("file://server/share/folder"),
        Some("//server/share/folder".to_string())
    );
}

#[test]
fn plan_file_operations_rejects_copy_overwrite_onto_self() {
    let dir = make_test_temp_dir("copy-self");
    let file_path = dir.join("sample.txt");
    fs::write(&file_path, "abc").unwrap();

    let planned = plan_file_operations(
        &[file_path.to_string_lossy().to_string()],
        &dir,
        "overwrite",
        "copy",
        &HashMap::new(),
    );

    let _ = fs::remove_dir_all(&dir);
    assert!(planned.is_err());
    assert!(planned
        .err()
        .unwrap()
        .to_ascii_lowercase()
        .contains("onto itself"));
}

#[test]
fn plan_file_operations_rejects_move_overwrite_onto_self() {
    let dir = make_test_temp_dir("move-self");
    let file_path = dir.join("sample.txt");
    fs::write(&file_path, "abc").unwrap();

    let planned = plan_file_operations(
        &[file_path.to_string_lossy().to_string()],
        &dir,
        "overwrite",
        "move",
        &HashMap::new(),
    );

    let _ = fs::remove_dir_all(&dir);
    assert!(planned.is_err());
    assert!(planned
        .err()
        .unwrap()
        .to_ascii_lowercase()
        .contains("onto itself"));
}

#[test]
fn read_file_chunks_stops_when_cancelled_mid_stream() {
    let dir = make_test_temp_dir("checksum-cancel");
    let file_path = dir.join("sample.bin");
    let mut file = fs::File::create(&file_path).unwrap();
    file.write_all(&vec![b'x'; 32 * 1024]).unwrap();
    drop(file);

    let mut file = fs::File::open(&file_path).unwrap();
    let mut saw_chunks = 0usize;
    let mut should_continue_calls = 0usize;
    let result = read_file_chunks(
        &mut file,
        32 * 1024,
        |_| {
            saw_chunks += 1;
        },
        || {
            should_continue_calls += 1;
            Ok(should_continue_calls < 3)
        },
        |_| {},
    );

    let _ = fs::remove_dir_all(&dir);
    assert!(result.is_err());
    assert_eq!(result.unwrap_err(), "Checksum cancelled");
    assert!(saw_chunks > 0);
    assert!(saw_chunks < 4);
}

struct CancelAfterFirstRead {
    inner: Cursor<Vec<u8>>,
    token: CancellationToken,
    cancelled: bool,
}

impl Read for CancelAfterFirstRead {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let read = self.inner.read(buf)?;
        if read > 0 && !self.cancelled {
            self.cancelled = true;
            self.token.store(true, Ordering::Relaxed);
        }
        Ok(read)
    }
}

#[test]
fn full_blake3_stops_when_cancelled_during_hashing() {
    let token = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let mut reader = CancelAfterFirstRead {
        inner: Cursor::new(vec![b'x'; 32 * 1024]),
        token: token.clone(),
        cancelled: false,
    };

    let result = full_blake3_reader(&mut reader, Some(&token));

    assert_eq!(result.unwrap_err(), "Duplicate scan cancelled");
    assert!(reader.inner.position() < 32 * 1024);
}

#[cfg(unix)]
#[test]
fn get_item_properties_treats_symlinked_directory_as_directory() {
    use std::os::unix::fs::symlink;

    let dir = make_test_temp_dir("symlink-dir-props");
    let target_dir = dir.join("target");
    let link_dir = dir.join("target-link");
    fs::create_dir(&target_dir).unwrap();
    symlink(&target_dir, &link_dir).unwrap();

    let runtime = tokio::runtime::Runtime::new().unwrap();
    let props = runtime
        .block_on(get_item_properties(link_dir.to_string_lossy().to_string()))
        .unwrap();

    let _ = fs::remove_dir_all(&dir);
    assert!(props.is_symlink);
    assert!(props.is_directory);
}

fn cleanup_dir(dir: &Path) {
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn rename_item_refuses_to_replace_an_existing_file() {
    let dir = make_test_temp_dir("rename-no-replace-file");
    let source = dir.join("source.txt");
    let dest = dir.join("dest.txt");
    fs::write(&source, "source-bytes").unwrap();
    fs::write(&dest, "keep-me").unwrap();

    let error = rename_item_inner(source.to_string_lossy().to_string(), "dest.txt".to_string())
        .unwrap_err();

    assert!(
        error.contains("already exists"),
        "unexpected error: {error}"
    );
    assert_eq!(fs::read_to_string(&source).unwrap(), "source-bytes");
    assert_eq!(fs::read_to_string(&dest).unwrap(), "keep-me");
    cleanup_dir(&dir);
}

#[test]
fn rename_item_refuses_to_replace_an_existing_directory() {
    let dir = make_test_temp_dir("rename-no-replace-dir");
    let source = dir.join("source-dir");
    let dest = dir.join("dest-dir");
    fs::create_dir(&source).unwrap();
    fs::create_dir(&dest).unwrap();
    fs::write(dest.join("inside.txt"), "keep-me").unwrap();

    let error = rename_item_inner(source.to_string_lossy().to_string(), "dest-dir".to_string())
        .unwrap_err();

    assert!(
        error.contains("already exists"),
        "unexpected error: {error}"
    );
    assert!(source.is_dir());
    assert_eq!(
        fs::read_to_string(dest.join("inside.txt")).unwrap(),
        "keep-me"
    );
    cleanup_dir(&dir);
}

#[test]
fn rename_item_allows_case_only_rename() {
    let dir = make_test_temp_dir("rename-case-only");
    let source = dir.join("RenameMe.txt");
    fs::write(&source, "payload").unwrap();

    let renamed = rename_item_inner(
        source.to_string_lossy().to_string(),
        "renameme.txt".to_string(),
    )
    .unwrap();

    let renamed_path = PathBuf::from(&renamed);
    assert!(path_entry_exists(&renamed_path));
    assert_eq!(fs::read_to_string(&renamed_path).unwrap(), "payload");
    cleanup_dir(&dir);
}

#[cfg(unix)]
#[test]
fn rename_item_renames_a_symlink_without_following_or_replacing() {
    use std::os::unix::fs::symlink;

    let dir = make_test_temp_dir("rename-symlink");
    let target = dir.join("target.txt");
    let link = dir.join("link");
    let occupied = dir.join("occupied.txt");
    fs::write(&target, "target-bytes").unwrap();
    fs::write(&occupied, "leave-me").unwrap();
    symlink(&target, &link).unwrap();

    let renamed = rename_item_inner(
        link.to_string_lossy().to_string(),
        "link-renamed".to_string(),
    )
    .unwrap();
    let renamed_path = PathBuf::from(&renamed);
    let meta = fs::symlink_metadata(&renamed_path).unwrap();
    assert!(meta.file_type().is_symlink());
    assert_eq!(fs::read_to_string(&target).unwrap(), "target-bytes");

    let error = rename_item_inner(
        renamed_path.to_string_lossy().to_string(),
        "occupied.txt".to_string(),
    )
    .unwrap_err();
    assert!(
        error.contains("already exists"),
        "unexpected error: {error}"
    );
    assert_eq!(fs::read_to_string(&occupied).unwrap(), "leave-me");
    cleanup_dir(&dir);
}

#[test]
fn batch_rename_rejects_duplicate_targets_without_clobbering() {
    let dir = make_test_temp_dir("batch-rename-dup-target");
    let a = dir.join("a.txt");
    let b = dir.join("b.txt");
    fs::write(&a, "aaa").unwrap();
    fs::write(&b, "bbb").unwrap();

    let results = batch_rename_inner(vec![
        serde_json::json!({ "oldPath": a.to_string_lossy(), "newName": "shared.txt" }),
        serde_json::json!({ "oldPath": b.to_string_lossy(), "newName": "shared.txt" }),
    ])
    .unwrap();

    assert!(results.iter().all(|row| row["success"] == false));
    assert!(results.iter().all(|row| row["error"]
        .as_str()
        .unwrap_or("")
        .contains("Duplicate target")));
    assert_eq!(fs::read_to_string(&a).unwrap(), "aaa");
    assert_eq!(fs::read_to_string(&b).unwrap(), "bbb");
    cleanup_dir(&dir);
}

#[test]
fn batch_rename_does_not_overwrite_a_preexisting_hidden_staging_name() {
    let dir = make_test_temp_dir("batch-rename-staging");
    let a = dir.join("a.txt");
    let b = dir.join("b.txt");
    fs::write(&a, "aaa").unwrap();
    fs::write(&b, "bbb").unwrap();
    let planted = dir.join(".iyeris-rename-tmp-b.txt");
    fs::write(&planted, "do-not-clobber").unwrap();

    let results = batch_rename_inner(vec![
        serde_json::json!({ "oldPath": a.to_string_lossy(), "newName": "b.txt" }),
        serde_json::json!({ "oldPath": b.to_string_lossy(), "newName": "a.txt" }),
    ])
    .unwrap();

    assert!(results.iter().all(|row| row["success"] == true));
    assert_eq!(fs::read_to_string(&planted).unwrap(), "do-not-clobber");
    assert_eq!(fs::read_to_string(dir.join("b.txt")).unwrap(), "aaa");
    assert_eq!(fs::read_to_string(dir.join("a.txt")).unwrap(), "bbb");
    cleanup_dir(&dir);
}

#[test]
fn duplicate_scan_ids_are_window_scoped() {
    assert_eq!(duplicate_scan_operation_id("main"), "main::duplicate-scan");
    assert_ne!(
        duplicate_scan_operation_id("main"),
        duplicate_scan_operation_id("secondary")
    );
}

#[test]
fn hidden_detection_covers_dotfiles_without_metadata() {
    assert!(is_hidden_entry(".secret", Path::new("/home/u/.secret")));
    assert!(!is_hidden_entry(
        "visible.txt",
        Path::new("/home/u/visible.txt")
    ));
}

#[cfg(target_os = "windows")]
#[test]
fn duplicate_walk_filter_skips_windows_hidden_attribute_entries() {
    let temp = tempfile::tempdir().unwrap();
    let visible = temp.path().join("visible.txt");
    let flagged = temp.path().join("flagged.txt");
    fs::write(&visible, "visible").unwrap();
    fs::write(&flagged, "flagged").unwrap();
    assert!(!is_hidden_entry("flagged.txt", &flagged));

    crate::native_windows::update_file_attributes(&flagged, None, Some(true), None).unwrap();
    assert!(is_hidden_entry("flagged.txt", &flagged));

    let visited: Vec<PathBuf> = walkdir::WalkDir::new(temp.path())
        .into_iter()
        .filter_entry(|entry| allow_duplicate_walk_entry(entry, false))
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path().to_path_buf())
        .collect();

    assert!(visited.iter().any(|path| path == temp.path()));
    assert!(visited.iter().any(|path| path.ends_with("visible.txt")));
    assert!(!visited.iter().any(|path| path.ends_with("flagged.txt")));

    let with_hidden: Vec<PathBuf> = walkdir::WalkDir::new(temp.path())
        .into_iter()
        .filter_entry(|entry| allow_duplicate_walk_entry(entry, true))
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path().to_path_buf())
        .collect();
    assert!(with_hidden.iter().any(|path| path.ends_with("flagged.txt")));
}

#[test]
fn duplicate_walk_filter_skips_dotfiles_but_keeps_root() {
    let temp = tempfile::tempdir().unwrap();
    fs::write(temp.path().join("visible.txt"), "visible").unwrap();
    fs::write(temp.path().join(".secret.txt"), "secret").unwrap();

    let visited: Vec<PathBuf> = walkdir::WalkDir::new(temp.path())
        .into_iter()
        .filter_entry(|entry| allow_duplicate_walk_entry(entry, false))
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path().to_path_buf())
        .collect();

    assert!(visited.iter().any(|path| path == temp.path()));
    assert!(visited.iter().any(|path| path.ends_with("visible.txt")));
    assert!(!visited.iter().any(|path| path.ends_with(".secret.txt")));
}
