// Tests for the transfer recovery journal. Moved from src-tauri/src/main_tests.rs.

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

    let store = crate::recovery::RecoveryJournal::open(&journal_path).unwrap();
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
            crate::recovery::RecoveryPaths {
                staging: vec![staging.clone()],
                backups: vec![backup.clone()],
                retained: Vec::new(),
            },
        )
        .unwrap();
    drop(store);

    let reloaded = crate::recovery::RecoveryJournal::open(&journal_path).unwrap();
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
    std::fs::write(
        &journal_path,
        vec![b'x'; crate::recovery::MAX_JOURNAL_BYTES + 1],
    )
    .unwrap();
    assert!(crate::recovery::RecoveryJournal::open(&journal_path).is_err());
}
