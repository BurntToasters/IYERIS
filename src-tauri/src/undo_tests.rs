use super::*;
use std::sync::LazyLock;
use std::sync::Mutex;

static TEST_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

fn clear_stacks() {
    UNDO_STACK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clear();
    REDO_STACK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clear();
}

#[test]
fn copy_fingerprint_obeys_cancellation_during_large_file() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("large");
    fs::File::create(&path)
        .unwrap()
        .set_len(8 * 1024 * 1024)
        .unwrap();
    let checks = AtomicUsize::new(0);
    let result = copy_fingerprint(&path, &|| checks.fetch_add(1, Ordering::SeqCst) >= 3);
    assert_eq!(result.unwrap_err(), "Operation cancelled");
    assert!(checks.load(Ordering::SeqCst) <= 5);
}

#[test]
fn copied_file_and_tree_undo_redo_as_one_action() {
    let _guard = TEST_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    clear_stacks();
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let source = root.join("source");
    fs::create_dir(&source).unwrap();
    fs::create_dir(source.join("empty")).unwrap();
    fs::write(source.join("data"), b"original bytes").unwrap();
    let source_file = root.join("file");
    fs::write(&source_file, b"file bytes").unwrap();
    let destination = root.join("copy");
    let destination_file = root.join("copy-file");
    crate::file_operations::copy_entry_exclusive(&source, &destination, &|| false).unwrap();
    crate::file_operations::copy_entry_exclusive(&source_file, &destination_file, &|| false)
        .unwrap();
    push_copy_action(&[
        (source, destination.clone()),
        (source_file, destination_file.clone()),
    ])
    .unwrap();
    fs::remove_dir_all(root.join("source")).unwrap();
    fs::write(root.join("file"), b"changed source").unwrap();
    undo_action_sync().unwrap();
    assert!(!destination.exists());
    assert!(!destination_file.exists());
    redo_action_sync().unwrap();
    assert_eq!(
        fs::read(destination.join("data")).unwrap(),
        b"original bytes"
    );
    assert!(destination.join("empty").is_dir());
    assert_eq!(fs::read(destination_file).unwrap(), b"file bytes");
    clear_stacks();
}

#[test]
fn copy_undo_preserves_edits_and_redo_preserves_new_occupant() {
    let _guard = TEST_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    clear_stacks();
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let source = root.join("source");
    let destination = root.join("copy");
    fs::write(&source, b"original").unwrap();
    crate::file_operations::copy_entry_exclusive(&source, &destination, &|| false).unwrap();
    push_copy_action(&[(source, destination.clone())]).unwrap();
    let original_times = fs::metadata(&destination).unwrap();
    fs::write(&destination, b"edited").unwrap();
    assert!(undo_action_sync().is_err());
    assert_eq!(fs::read(&destination).unwrap(), b"edited");
    fs::write(&destination, b"original").unwrap();
    let restored = fs::File::options().write(true).open(&destination).unwrap();
    restored
        .set_times(
            fs::FileTimes::new()
                .set_modified(original_times.modified().unwrap())
                .set_accessed(original_times.accessed().unwrap()),
        )
        .unwrap();
    undo_action_sync().unwrap();
    fs::write(&destination, b"new occupant").unwrap();
    assert!(redo_action_sync().is_err());
    assert_eq!(fs::read(&destination).unwrap(), b"new occupant");
    clear_stacks();
}

#[test]
fn copy_overwrite_undo_redo_restores_each_side_and_owned_backup_is_discarded_safely() {
    let _guard = TEST_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    clear_stacks();
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let source = root.join("source");
    let destination = root.join("destination");
    let backup_path = root.join(".iyeris-owned-backup");
    fs::write(&source, b"replacement").unwrap();
    fs::write(&destination, b"original").unwrap();
    fs::rename(&destination, &backup_path).unwrap();
    crate::file_operations::copy_entry_exclusive(&source, &destination, &|| false).unwrap();
    let copy = record_copy_entry(&source, &destination, &destination, &|| false).unwrap();
    let backup = OverwriteBackupEntry {
        original_path: destination.to_string_lossy().into_owned(),
        backup_path: backup_path.to_string_lossy().into_owned(),
        fingerprint: path_fingerprint(&backup_path, &|| false).unwrap(),
    };
    push_undo_action(
        UndoAction::Copy(CopyActionData {
            entries: vec![copy],
            overwrite_backups: vec![backup],
            recovery_record_id: None,
        }),
        true,
    )
    .unwrap();

    undo_action_sync().unwrap();
    assert_eq!(fs::read(&destination).unwrap(), b"original");
    assert!(!backup_path.exists());
    assert!(source.exists());
    redo_action_sync().unwrap();
    assert_eq!(fs::read(&destination).unwrap(), b"replacement");
    assert_eq!(fs::read(&backup_path).unwrap(), b"original");

    clear_undo_stack_for_path(destination.to_str().unwrap()).unwrap();
    assert!(
        !backup_path.exists(),
        "discarding history releases its owned backup"
    );
    clear_stacks();
}

#[test]
fn copy_overwrite_refuses_edited_destination_and_keeps_backup_and_retry_history() {
    let _guard = TEST_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    clear_stacks();
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let source = root.join("source");
    let destination = root.join("destination");
    let backup_path = root.join(".iyeris-owned-backup");
    fs::write(&source, b"replacement").unwrap();
    fs::write(&destination, b"original").unwrap();
    fs::rename(&destination, &backup_path).unwrap();
    crate::file_operations::copy_entry_exclusive(&source, &destination, &|| false).unwrap();
    let copy = record_copy_entry(&source, &destination, &destination, &|| false).unwrap();
    let backup = OverwriteBackupEntry {
        original_path: destination.to_string_lossy().into_owned(),
        backup_path: backup_path.to_string_lossy().into_owned(),
        fingerprint: path_fingerprint(&backup_path, &|| false).unwrap(),
    };
    push_undo_action(
        UndoAction::Copy(CopyActionData {
            entries: vec![copy],
            overwrite_backups: vec![backup],
            recovery_record_id: None,
        }),
        true,
    )
    .unwrap();
    fs::write(&destination, b"user replacement").unwrap();

    assert!(undo_action_sync().is_err());
    assert_eq!(fs::read(&destination).unwrap(), b"user replacement");
    assert_eq!(fs::read(&backup_path).unwrap(), b"original");
    assert_eq!(
        UNDO_STACK.lock().unwrap_or_else(|p| p.into_inner()).len(),
        1
    );
    clear_stacks();
}

#[test]
fn move_overwrite_undo_redo_round_trip_preserves_source_and_prior_destination() {
    let _guard = TEST_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    clear_stacks();
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let source_dir = root.join("source-dir");
    let destination_dir = root.join("destination-dir");
    fs::create_dir(&source_dir).unwrap();
    fs::create_dir(&destination_dir).unwrap();
    let source = source_dir.join("item");
    let destination = destination_dir.join("item");
    let backup_path = destination_dir.join(".iyeris-owned-backup");
    fs::write(&source, b"replacement").unwrap();
    fs::write(&destination, b"original").unwrap();
    fs::rename(&destination, &backup_path).unwrap();
    fs::rename(&source, &destination).unwrap();
    let backup = OverwriteBackupEntry {
        original_path: destination.to_string_lossy().into_owned(),
        backup_path: backup_path.to_string_lossy().into_owned(),
        fingerprint: path_fingerprint(&backup_path, &|| false).unwrap(),
    };
    let moved_fingerprint = path_fingerprint(&destination, &|| false).unwrap();
    let recorded_meta = fs::metadata(&destination).unwrap();
    push_undo_action(
        UndoAction::Move(MoveActionData {
            source_paths: vec![destination.to_string_lossy().into_owned()],
            original_paths: Some(vec![source.to_string_lossy().into_owned()]),
            original_parent: Some(source_dir.to_string_lossy().into_owned()),
            dest_path: destination_dir.to_string_lossy().into_owned(),
            item_fingerprints: Some(vec![moved_fingerprint]),
            overwrite_backups: vec![backup],
            recovery_record_id: None,
        }),
        true,
    )
    .unwrap();

    undo_action_sync().unwrap();
    let restored_meta = fs::metadata(&source).unwrap();
    eprintln!(
        "DIAG recorded: created={:?} modified={:?} len={} | restored: created={:?} modified={:?} len={}",
        recorded_meta.created(),
        recorded_meta.modified(),
        recorded_meta.len(),
        restored_meta.created(),
        restored_meta.modified(),
        restored_meta.len()
    );
    assert_eq!(fs::read(&source).unwrap(), b"replacement");
    assert_eq!(fs::read(&destination).unwrap(), b"original");
    assert!(!backup_path.exists());
    redo_action_sync().unwrap();
    assert!(!source.exists());
    assert_eq!(fs::read(&destination).unwrap(), b"replacement");
    assert_eq!(fs::read(&backup_path).unwrap(), b"original");
    clear_stacks();
}

#[test]
fn legacy_copy_and_move_actions_without_overwrite_backups_still_deserialize() {
    let copy: UndoAction =
        serde_json::from_str(r#"{"type":"copy","data":{"entries":[]}}"#).unwrap();
    let moved: UndoAction =
        serde_json::from_str(r#"{"type":"move","data":{"sourcePaths":[],"destPath":"/tmp"}}"#)
            .unwrap();
    assert!(matches!(copy, UndoAction::Copy(_)));
    assert!(matches!(moved, UndoAction::Move(_)));
}

fn move_fixture(
    count: usize,
) -> (
    tempfile::TempDir,
    MoveActionData,
    Vec<PathBuf>,
    Vec<PathBuf>,
) {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let original_dir = root.join("original");
    let destination_dir = root.join("destination");
    fs::create_dir(&original_dir).unwrap();
    fs::create_dir(&destination_dir).unwrap();

    let mut original_paths = Vec::new();
    let mut destination_paths = Vec::new();
    for index in 0..count {
        let name = format!("item-{index}");
        let original = original_dir.join(&name);
        let destination = destination_dir.join(&name);
        fs::write(&destination, format!("contents-{index}")).unwrap();
        original_paths.push(original);
        destination_paths.push(destination);
    }

    let action = MoveActionData {
        source_paths: destination_paths
            .iter()
            .map(|path| path.to_string_lossy().into_owned())
            .collect(),
        original_paths: Some(
            original_paths
                .iter()
                .map(|path| path.to_string_lossy().into_owned())
                .collect(),
        ),
        original_parent: Some(original_dir.to_string_lossy().into_owned()),
        dest_path: destination_dir.to_string_lossy().into_owned(),
        item_fingerprints: None,
        overwrite_backups: Vec::new(),
        recovery_record_id: None,
    };
    (temp, action, original_paths, destination_paths)
}

fn move_action_paths(action: &UndoAction) -> Vec<String> {
    match action {
        UndoAction::Move(data) => data
            .original_paths
            .clone()
            .unwrap_or_else(|| data.source_paths.clone()),
        _ => panic!("expected move action"),
    }
}

#[test]
fn move_undo_later_failure_with_successful_rollback_keeps_all_history() {
    let _guard = TEST_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    clear_stacks();
    let (_temp, action, original_paths, destination_paths) = move_fixture(3);
    let mut move_count = 0;

    let result = execute_move_undo_with(action, &mut |source, target| {
        move_count += 1;
        if move_count == 2 {
            return Err("injected second move failure".to_string());
        }
        move_path(source, target)
    });

    assert!(result.is_err());
    let undo = UNDO_STACK.lock().unwrap_or_else(|p| p.into_inner());
    assert_eq!(undo.len(), 1);
    assert_eq!(move_action_paths(&undo[0]).len(), 3);
    assert!(REDO_STACK
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .is_empty());
    assert!(destination_paths.iter().all(|path| path.exists()));
    assert!(original_paths.iter().all(|path| !path.exists()));
    drop(undo);
    clear_stacks();
}

#[test]
fn move_undo_failed_rollback_keeps_each_actionable_side_and_reports_recovery_path() {
    let _guard = TEST_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    clear_stacks();
    let (_temp, action, original_paths, destination_paths) = move_fixture(3);
    let mut move_count = 0;

    let result = execute_move_undo_with(action, &mut |source, target| {
        move_count += 1;
        if move_count == 2 {
            return Err("injected second move failure".to_string());
        }
        if move_count == 3 {
            return Err("injected rollback failure".to_string());
        }
        move_path(source, target)
    });

    let error = result.unwrap_err();
    assert!(error.contains(&original_paths[0].to_string_lossy().to_string()));
    let undo = UNDO_STACK.lock().unwrap_or_else(|p| p.into_inner());
    assert_eq!(undo.len(), 1);
    assert_eq!(
        move_action_paths(&undo[0]),
        vec![
            original_paths[1].to_string_lossy().into_owned(),
            original_paths[2].to_string_lossy().into_owned(),
        ]
    );
    let redo = REDO_STACK.lock().unwrap_or_else(|p| p.into_inner());
    assert_eq!(redo.len(), 1);
    assert_eq!(
        move_action_paths(&redo[0]),
        vec![original_paths[0].to_string_lossy().into_owned()]
    );
    assert!(original_paths[0].exists());
    assert!(destination_paths[0..1].iter().all(|path| !path.exists()));
    assert!(destination_paths[1..].iter().all(|path| path.exists()));
    drop(redo);
    drop(undo);
    clear_stacks();
}

#[test]
fn move_undo_never_overwrites_an_occupied_original_destination() {
    let _guard = TEST_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    clear_stacks();
    let (_temp, action, original_paths, destination_paths) = move_fixture(2);
    fs::write(&original_paths[0], b"unrelated occupant").unwrap();

    let result = execute_move_undo_with(action, &mut |source, target| move_path(source, target));

    assert!(result.is_err());
    assert_eq!(fs::read(&original_paths[0]).unwrap(), b"unrelated occupant");
    assert!(destination_paths.iter().all(|path| path.exists()));
    let undo = UNDO_STACK.lock().unwrap_or_else(|p| p.into_inner());
    assert_eq!(undo.len(), 1);
    assert_eq!(move_action_paths(&undo[0]).len(), 2);
    drop(undo);
    clear_stacks();
}

#[test]
fn move_redo_failed_rollback_keeps_each_actionable_side_and_reports_recovery_path() {
    let _guard = TEST_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    clear_stacks();
    let (_temp, action, original_paths, destination_paths) = move_fixture(3);
    for (destination, original) in destination_paths.iter().zip(&original_paths) {
        fs::rename(destination, original).unwrap();
    }
    let mut move_count = 0;

    let result = execute_move_redo_with(&action, &mut |source, target| {
        move_count += 1;
        if move_count == 2 {
            return Err("injected second move failure".to_string());
        }
        if move_count == 3 {
            return Err("injected rollback failure".to_string());
        }
        move_path(source, target)
    });

    let error = result.unwrap_err();
    assert!(error.contains(&destination_paths[0].to_string_lossy().to_string()));
    let undo = UNDO_STACK.lock().unwrap_or_else(|p| p.into_inner());
    assert_eq!(undo.len(), 1);
    assert_eq!(
        move_action_paths(&undo[0]),
        vec![original_paths[0].to_string_lossy().into_owned()]
    );
    let redo = REDO_STACK.lock().unwrap_or_else(|p| p.into_inner());
    assert_eq!(redo.len(), 1);
    assert_eq!(
        move_action_paths(&redo[0]),
        vec![
            original_paths[1].to_string_lossy().into_owned(),
            original_paths[2].to_string_lossy().into_owned(),
        ]
    );
    assert!(destination_paths[0].exists());
    assert!(original_paths[0..1].iter().all(|path| !path.exists()));
    assert!(original_paths[1..].iter().all(|path| path.exists()));
    drop(redo);
    drop(undo);
    clear_stacks();
}

#[test]
fn move_undo_redo_round_trip_keeps_paths_and_contents() {
    let _guard = TEST_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    clear_stacks();
    let (_temp, action, original_paths, destination_paths) = move_fixture(2);
    push_undo_action(UndoAction::Move(action), true).unwrap();

    undo_action_sync().unwrap();
    assert!(original_paths.iter().all(|path| path.exists()));
    assert!(destination_paths.iter().all(|path| !path.exists()));
    redo_action_sync().unwrap();
    assert!(destination_paths.iter().all(|path| path.exists()));
    assert!(original_paths.iter().all(|path| !path.exists()));
    assert_eq!(fs::read(&destination_paths[0]).unwrap(), b"contents-0");
    assert_eq!(fs::read(&destination_paths[1]).unwrap(), b"contents-1");
    clear_stacks();
}

#[test]
fn rename_cycle_round_trips_without_replacing_content() {
    let _guard = TEST_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    clear_stacks();
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let a = root.join("a");
    let b = root.join("b");
    let c = root.join("c");
    fs::write(&a, b"A").unwrap();
    fs::write(&b, b"B").unwrap();
    fs::write(&c, b"C").unwrap();
    let paths = vec![
        (a.clone(), b.clone()),
        (b.clone(), c.clone()),
        (c.clone(), a.clone()),
    ];
    crate::file_operations::rename_batch_transaction(&paths).unwrap();
    push_batch_rename_action(
        paths
            .iter()
            .map(|(old, new)| {
                (
                    old.to_string_lossy().into_owned(),
                    new.to_string_lossy().into_owned(),
                )
            })
            .collect(),
    )
    .unwrap();
    undo_action_sync().unwrap();
    assert_eq!(fs::read(&a).unwrap(), b"A");
    assert_eq!(fs::read(&b).unwrap(), b"B");
    assert_eq!(fs::read(&c).unwrap(), b"C");
    redo_action_sync().unwrap();
    assert_eq!(fs::read(&a).unwrap(), b"C");
    assert_eq!(fs::read(&b).unwrap(), b"A");
    assert_eq!(fs::read(&c).unwrap(), b"B");
    clear_stacks();
}

#[test]
fn push_undo_action_caps_at_max_size() {
    let _guard = TEST_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    clear_stacks();
    for i in 0..(MAX_UNDO_STACK_SIZE + 10) {
        let path = PathBuf::from(format!("C:/tmp/test-{}", i));
        push_create_action(&path, false).unwrap();
    }
    let undo_len = UNDO_STACK.lock().unwrap_or_else(|p| p.into_inner()).len();
    let redo_len = REDO_STACK.lock().unwrap_or_else(|p| p.into_inner()).len();
    assert_eq!(undo_len, MAX_UNDO_STACK_SIZE);
    assert_eq!(redo_len, 0);
}

#[test]
fn clear_path_prunes_related_rename_chain() {
    let _guard = TEST_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    clear_stacks();
    let a = PathBuf::from("C:/tmp/a.txt");
    let b = PathBuf::from("C:/tmp/b.txt");
    let c = PathBuf::from("C:/tmp/c.txt");
    push_rename_action(&a, &b).unwrap();
    push_rename_action(&b, &c).unwrap();
    clear_undo_stack_for_path("C:/tmp/c.txt").unwrap();
    let undo_len = UNDO_STACK.lock().unwrap_or_else(|p| p.into_inner()).len();
    assert_eq!(undo_len, 0);
}
