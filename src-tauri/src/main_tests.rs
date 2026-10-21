use super::*;

#[cfg(unix)]
#[test]
fn validate_path_preserves_trailing_spaces() {
    let temp = tempfile::tempdir().unwrap();
    let intended = temp.path().join("report ");
    let sibling = temp.path().join("report");
    std::fs::write(&intended, b"selected").unwrap();
    std::fs::write(&sibling, b"unselected").unwrap();
    let validated = validate_path(intended.to_str().unwrap(), "File").unwrap();
    assert_eq!(validated, intended);
    assert_eq!(std::fs::read(validated).unwrap(), b"selected");
}

#[cfg(unix)]
#[test]
fn state_directory_rejects_symlink_above_existing_parent() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let real = root.join("real");
    std::fs::create_dir_all(real.join("existing")).unwrap();
    std::os::unix::fs::symlink(&real, root.join("link")).unwrap();
    assert!(ensure_real_directory_tree(&root.join("link/existing/new"), "State").is_err());
    assert!(!real.join("existing/new").exists());
}

#[test]
fn transfer_recovery_journal_reload_and_acknowledgement_keep_referenced_data() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let journal_path = root.join("transfer-recovery").join("journal.json");
    let staging = root.join(".iyeris-copy-staging");
    let backup = root.join(".iyeris-overwrite-backup");
    let destination = root.join("destination");
    std::fs::write(&staging, b"partial copy").unwrap();
    std::fs::write(&backup, b"original destination").unwrap();

    let store = recovery::RecoveryJournal::open(&journal_path).unwrap();
    let record_id = store
        .begin_operation(
            "copy",
            Some("copy-op-1"),
            &[],
            std::slice::from_ref(&destination),
        )
        .unwrap();
    store
        .record_paths(
            &record_id,
            recovery::RecoveryPaths {
                staging: vec![staging.clone()],
                backups: vec![backup.clone()],
                retained: Vec::new(),
            },
        )
        .unwrap();
    drop(store);

    let reloaded = recovery::RecoveryJournal::open(&journal_path).unwrap();
    let unfinished = reloaded.list_unfinished().unwrap();
    assert_eq!(unfinished.len(), 1);
    assert_eq!(unfinished[0].id, record_id);
    assert_eq!(unfinished[0].kind, "copy");
    assert_eq!(
        unfinished[0].staging_paths,
        vec![staging.to_string_lossy().to_string()]
    );
    assert_eq!(
        unfinished[0].backup_paths,
        vec![backup.to_string_lossy().to_string()]
    );
    reloaded.acknowledge(&record_id).unwrap();
    assert!(reloaded.list_unfinished().unwrap().is_empty());
    assert_eq!(std::fs::read(&staging).unwrap(), b"partial copy");
    assert_eq!(std::fs::read(&backup).unwrap(), b"original destination");
}

#[test]
fn transfer_recovery_journal_rejects_oversized_state_file() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let journal_path = root.join("journal.json");
    std::fs::write(&journal_path, vec![b'x'; recovery::MAX_JOURNAL_BYTES + 1]).unwrap();
    assert!(recovery::RecoveryJournal::open(&journal_path).is_err());
}

#[test]
fn make_temp_path_includes_purpose() {
    let base = Path::new("/tmp/test.json");
    let temp = make_temp_path(base, "download");
    let name = temp
        .file_name()
        .and_then(|n| n.to_str())
        .expect("temp path should have a valid UTF-8 filename");
    assert!(name.contains("download"));
    assert!(name.ends_with(".tmp"));
}

#[test]
fn make_temp_path_unique() {
    let base = Path::new("/tmp/test.json");
    let t1 = make_temp_path(base, "test");
    let t2 = make_temp_path(base, "test");
    assert_ne!(t1, t2);
}

#[test]
fn validate_path_rejects_empty() {
    assert!(validate_path("", "Test").is_err());
    assert!(validate_path("   ", "Test").is_err());
}

#[test]
fn validate_path_rejects_relative() {
    assert!(validate_path("relative/path", "Test").is_err());
}

#[test]
fn validate_path_rejects_nul_and_oversized_input() {
    assert!(validate_path("/tmp/bad\0name", "Test").is_err());
    let oversized = format!("/tmp/{}", "x".repeat(1_048_576));
    assert!(validate_path(&oversized, "Test").is_err());
}

#[test]
fn has_minimized_launch_arg_detects_supported_flags() {
    let args = vec!["app".to_string(), "--minimized".to_string()];
    assert!(has_minimized_launch_arg(&args));

    let args = vec!["app".to_string(), "--hidden".to_string()];
    assert!(has_minimized_launch_arg(&args));

    let args = vec!["app".to_string(), "--dev".to_string()];
    assert!(!has_minimized_launch_arg(&args));
}

#[cfg(unix)]
#[test]
fn first_open_path_arg_accepts_shell_looking_filenames() {
    let temp = tempfile::tempdir().expect("tempdir");
    let suspicious = temp.path().join("bad $`;|&<>\nname.txt");
    std::fs::write(&suspicious, "valid").expect("write temp file");
    let args = vec!["app".to_string(), suspicious.to_string_lossy().to_string()];
    assert_eq!(
        first_open_path_arg(&args),
        Some(
            suspicious
                .canonicalize()
                .expect("canonical path")
                .to_string_lossy()
                .to_string()
        )
    );
}

#[cfg(windows)]
#[test]
fn first_open_path_arg_accepts_shell_looking_filenames() {
    let temp = tempfile::tempdir().expect("tempdir");
    let suspicious = temp.path().join("bad $`;&name.txt");
    std::fs::write(&suspicious, "valid").expect("write temp file");
    let args = vec!["app".to_string(), suspicious.to_string_lossy().to_string()];
    assert_eq!(
        first_open_path_arg(&args),
        Some(
            suspicious
                .canonicalize()
                .expect("canonical path")
                .to_string_lossy()
                .to_string()
        )
    );
}

#[test]
fn first_open_path_arg_rejects_control_characters() {
    let temp = tempfile::tempdir().expect("tempdir");
    let control = temp.path().join("bad\u{1}name.txt");
    let args = vec!["app".to_string(), control.to_string_lossy().to_string()];
    assert!(first_open_path_arg(&args).is_none());
}

#[test]
fn app_state_directory_creates_nested_tree_and_canonicalizes() {
    let temp = tempfile::tempdir().expect("tempdir");
    let path = temp.path().join("state").join("nested");
    let resolved = ensure_app_state_directory(&path, "Test state").expect("create state dir");
    assert!(path.is_dir());
    assert_eq!(resolved, path.canonicalize().expect("canonical path"));
}

#[cfg(unix)]
#[test]
fn app_state_directory_allows_symlinked_ancestor() {
    use std::os::unix::fs::symlink;
    let temp = tempfile::tempdir().expect("tempdir");
    let real = temp.path().join("real");
    std::fs::create_dir_all(&real).expect("create real dir");
    let link = temp.path().join("link");
    symlink(&real, &link).expect("create ancestor symlink");

    let resolved = ensure_app_state_directory(&link.join("state"), "Test state")
        .expect("trusted ancestor symlink should be allowed");
    assert!(resolved.starts_with(real.canonicalize().expect("canonical real dir")));
    assert!(resolved.ends_with("state"));
}

#[cfg(unix)]
#[test]
fn app_state_directory_rejects_symlinked_final_component() {
    use std::os::unix::fs::symlink;
    let temp = tempfile::tempdir().expect("tempdir");
    let real = temp.path().join("real");
    std::fs::create_dir_all(&real).expect("create real dir");
    let link = temp.path().join("link");
    symlink(&real, &link).expect("create symlink");

    assert!(ensure_app_state_directory(&link, "Test state").is_err());
}

#[test]
fn app_state_directory_rejects_non_directory() {
    let temp = tempfile::tempdir().expect("tempdir");
    let file = temp.path().join("state");
    std::fs::write(&file, "not a directory").expect("write temp file");

    assert!(ensure_app_state_directory(&file, "Test state").is_err());
}

#[test]
fn first_open_path_arg_accepts_existing_absolute_path() {
    let temp = tempfile::tempdir().expect("tempdir");
    let file_path = temp.path().join("ok.txt");
    std::fs::write(&file_path, "ok").expect("write temp file");
    let args = vec!["app".to_string(), file_path.to_string_lossy().to_string()];
    assert_eq!(
        first_open_path_arg(&args),
        Some(
            file_path
                .canonicalize()
                .expect("canonical path")
                .to_string_lossy()
                .to_string()
        )
    );
}
