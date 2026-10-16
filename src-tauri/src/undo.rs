use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

const MAX_UNDO_STACK_SIZE: usize = 50;
const CREATED_TIME_TOLERANCE_MS: f64 = 2000.0;

static UNDO_STACK: LazyLock<Mutex<Vec<UndoAction>>> = LazyLock::new(|| Mutex::new(Vec::new()));
static REDO_STACK: LazyLock<Mutex<Vec<UndoAction>>> = LazyLock::new(|| Mutex::new(Vec::new()));

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CopyEntry {
    pub source_path: String,
    pub dest_path: String,
    pub fingerprint: String,
    #[serde(skip)]
    retained: Option<Arc<RetainedCopy>>,
}

#[derive(Debug)]
struct RetainedCopy {
    workspace: Option<tempfile::TempDir>,
    fingerprint: String,
}

impl RetainedCopy {
    fn path(&self) -> &Path {
        self.workspace
            .as_ref()
            .expect("retained workspace is available")
            .path()
    }
}

impl Drop for RetainedCopy {
    fn drop(&mut self) {
        let Some(workspace) = self.workspace.as_ref() else {
            return;
        };
        let content = workspace.path().join("content");
        let content_state = fs::symlink_metadata(&content);
        if matches!(content_state, Err(ref error) if error.kind() == std::io::ErrorKind::NotFound)
            && !std::thread::panicking()
        {
            // Redo already moved the retained item out. The now-empty private
            // workspace is safe for TempDir's normal cleanup.
            self.close_workspace();
            return;
        }
        let should_preserve = std::thread::panicking()
            || content_state.is_err()
            || verify_copy(&content, &self.fingerprint).is_err();
        if should_preserve {
            if let Some(workspace) = self.workspace.take() {
                let retained_path = workspace.keep();
                log::error!(
                    "[Undo] Retained changed or in-flight copy data at {}",
                    retained_path.display()
                );
                crate::recovery::record_unowned_retained_path(&retained_path, "copy-undo");
            }
        } else {
            self.close_workspace();
        }
    }
}

impl RetainedCopy {
    fn close_workspace(&mut self) {
        let Some(workspace) = self.workspace.take() else {
            return;
        };
        let root = workspace.path().to_path_buf();
        match workspace.close() {
            Ok(()) => crate::recovery::finish_records_referencing(
                &[root.clone(), root.join("content")],
                None,
            ),
            Err(error) => {
                log::error!(
                    "[Undo] Retained copy cleanup failed at {}; preserving recovery record: {}",
                    root.display(),
                    error
                );
                crate::recovery::record_unowned_retained_path(&root, "copy-undo");
            }
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CopyActionData {
    pub entries: Vec<CopyEntry>,
    #[serde(default)]
    pub overwrite_backups: Vec<OverwriteBackupEntry>,
    #[serde(default)]
    pub recovery_record_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OverwriteBackupEntry {
    pub original_path: String,
    pub backup_path: String,
    pub fingerprint: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateActionData {
    pub path: String,
    pub is_directory: bool,
    #[serde(default)]
    pub created_at_ms: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameActionData {
    pub old_path: String,
    pub new_path: String,
    pub old_name: String,
    pub new_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MoveActionData {
    pub source_paths: Vec<String>,
    #[serde(default)]
    pub original_paths: Option<Vec<String>>,
    #[serde(default)]
    pub original_parent: Option<String>,
    pub dest_path: String,
    #[serde(default)]
    pub item_fingerprints: Option<Vec<String>>,
    #[serde(default)]
    pub overwrite_backups: Vec<OverwriteBackupEntry>,
    #[serde(default)]
    pub recovery_record_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashActionData {
    pub path: String,
    #[serde(default)]
    pub original_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchRenameEntry {
    pub old_path: String,
    pub new_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchRenameActionData {
    pub renames: Vec<BatchRenameEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", content = "data")]
pub enum UndoAction {
    #[serde(rename = "copy")]
    Copy(CopyActionData),
    #[serde(rename = "create")]
    Create(CreateActionData),
    #[serde(rename = "rename")]
    Rename(RenameActionData),
    #[serde(rename = "move")]
    Move(MoveActionData),
    #[serde(rename = "trash")]
    Trash(TrashActionData),
    #[serde(rename = "batch-rename")]
    BatchRename(BatchRenameActionData),
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UndoRedoState {
    pub can_undo: bool,
    pub can_redo: bool,
}

fn current_time_ms() -> Option<f64> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|d| d.as_secs_f64() * 1000.0)
}

pub(crate) fn discard_history_on_exit() {
    // Active operations hold their own action/Arc; clearing idle stacks cannot
    // delete a copy in use. A crash leaves private recovery workspaces intact.
    if let Ok(mut undo) = UNDO_STACK.try_lock() {
        let discarded = std::mem::take(&mut *undo);
        drop(undo);
        for action in discarded {
            discard_action_safely(action);
        }
    }
    if let Ok(mut redo) = REDO_STACK.try_lock() {
        let discarded = std::mem::take(&mut *redo);
        drop(redo);
        for action in discarded {
            discard_action_safely(action);
        }
    }
}

fn cap_stack(stack: &mut Vec<UndoAction>) {
    if stack.len() > MAX_UNDO_STACK_SIZE {
        let overflow = stack.len() - MAX_UNDO_STACK_SIZE;
        let discarded = stack.drain(0..overflow).collect::<Vec<_>>();
        for action in discarded {
            discard_action_safely(action);
        }
    }
}

fn cleanup_owned_backup(backup: &OverwriteBackupEntry, recovery_record_id: Option<&str>) {
    let retained = PathBuf::from(&backup.backup_path);
    match fs::symlink_metadata(&retained) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            crate::recovery::finish_records_referencing(&[retained], None);
            return;
        }
        Err(error) => {
            log::error!(
                "[Undo] Cannot inspect retained overwrite original {}; preserving it: {}",
                retained.display(),
                error
            );
            crate::recovery::record_error(recovery_record_id, &error.to_string());
            crate::recovery::record_unowned_retained_path(&retained, "overwrite-backup");
            return;
        }
        Ok(_) => {}
    }
    if let Err(error) = verify_copy(&retained, &backup.fingerprint) {
        log::error!(
            "[Undo] Retained overwrite original changed at {}; preserving it: {}",
            retained.display(),
            error
        );
        crate::recovery::record_error(recovery_record_id, &error);
        crate::recovery::record_unowned_retained_path(&retained, "overwrite-backup");
        return;
    }
    let quarantine = match crate::file_operations::reserve_staging_rename_with_recovery(
        &retained,
        recovery_record_id,
    ) {
        Ok(path) => path,
        Err(error) => {
            log::error!(
                "[Undo] Cannot quarantine retained overwrite original {}; preserving it: {}",
                retained.display(),
                error
            );
            crate::recovery::record_error(recovery_record_id, &error);
            crate::recovery::record_unowned_retained_path(&retained, "overwrite-backup");
            return;
        }
    };
    if let Err(error) = verify_copy(&quarantine, &backup.fingerprint) {
        let recovery = if path_entry_exists(&retained) {
            Err(format!(
                "original path is occupied; retained at {}",
                quarantine.display()
            ))
        } else {
            crate::file_operations::rename_exclusive(&quarantine, &retained)
                .map_err(|restore| format!("restore failed: {}; retained at {}", restore, quarantine.display()))
        };
        let recovery = match recovery {
            Ok(()) => format!("restored at {}", retained.display()),
            Err(message) => message,
        };
        log::error!(
            "[Undo] Retained overwrite original changed during cleanup at {}; preserving it: {}; {}",
            retained.display(),
            error,
            recovery
        );
        crate::recovery::record_error(recovery_record_id, &error);
        crate::recovery::record_unowned_retained_path(&quarantine, "overwrite-backup");
        return;
    }
    if let Err(error) = crate::recovery::record_paths(
        recovery_record_id,
        crate::recovery::RecoveryPaths {
            staging: vec![quarantine.clone()],
            ..crate::recovery::RecoveryPaths::default()
        },
    ) {
        log::error!(
            "[Undo] Cannot journal overwrite cleanup at {}: {}",
            quarantine.display(),
            error
        );
        crate::recovery::record_error(recovery_record_id, &error);
        return;
    }
    if let Err(error) = crate::file_operations::remove_existing_path(&quarantine) {
        log::error!(
            "[Undo] Retained overwrite cleanup failed at {}; preserving recovery data: {}",
            quarantine.display(),
            error
        );
        crate::recovery::record_error(recovery_record_id, &error);
        crate::recovery::record_unowned_retained_path(&quarantine, "overwrite-backup");
    } else {
        crate::recovery::finish_records_referencing(&[retained, quarantine], None);
    }
}

fn discard_action_safely(action: UndoAction) {
    match action {
        UndoAction::Copy(data) => {
            let recovery_record_id = data.recovery_record_id.as_deref();
            for backup in &data.overwrite_backups {
                cleanup_owned_backup(backup, recovery_record_id);
            }
            let retained_paths = data
                .entries
                .iter()
                .filter_map(|entry| entry.retained.as_ref())
                .flat_map(|retained| {
                    let root = retained.path().to_path_buf();
                    [root.clone(), root.join("content")]
                })
                .collect::<Vec<_>>();
            drop(data.entries);
            crate::recovery::finish_records_referencing(&retained_paths, None);
        }
        UndoAction::Move(data) => {
            let recovery_record_id = data.recovery_record_id.as_deref();
            for backup in &data.overwrite_backups {
                cleanup_owned_backup(backup, recovery_record_id);
            }
        }
        _ => {}
    }
}

fn push_undo_action(action: UndoAction, clear_redo: bool) -> Result<(), String> {
    {
        let mut undo = UNDO_STACK.lock().map_err(|e| e.to_string())?;
        undo.push(action);
        cap_stack(&mut undo);
    }
    if clear_redo {
        let discarded = {
            let mut redo = REDO_STACK.lock().map_err(|e| e.to_string())?;
            std::mem::take(&mut *redo)
        };
        for old_action in discarded {
            discard_action_safely(old_action);
        }
    }
    Ok(())
}

fn push_redo_action(action: UndoAction) -> Result<(), String> {
    let mut redo = REDO_STACK.lock().map_err(|e| e.to_string())?;
    redo.push(action);
    cap_stack(&mut redo);
    Ok(())
}

fn pop_undo_action() -> Result<Option<UndoAction>, String> {
    let mut undo = UNDO_STACK.lock().map_err(|e| e.to_string())?;
    Ok(undo.pop())
}

fn pop_redo_action() -> Result<Option<UndoAction>, String> {
    let mut redo = REDO_STACK.lock().map_err(|e| e.to_string())?;
    Ok(redo.pop())
}

fn to_file_name(path: &str) -> String {
    Path::new(path)
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_default()
}

/// Hash the tree without following links. Metadata and entry names distinguish
/// an edited copy from the recorded result, including changes inside folders.
fn metadata_identity(metadata: &fs::Metadata) -> Vec<u8> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let mut identity = metadata.dev().to_le_bytes().to_vec();
        identity.extend_from_slice(&metadata.ino().to_le_bytes());
        identity
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        // MetadataExt's file-index helpers are still unstable on stable Rust.
        // Creation time plus the content and modified-time hash distinguishes
        // replacements without relying on those unstable APIs.
        metadata.creation_time().to_le_bytes().to_vec()
    }
    #[cfg(not(any(unix, windows)))]
    {
        let created = metadata
            .created()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .unwrap_or_default();
        let mut identity = created.as_secs().to_le_bytes().to_vec();
        identity.extend_from_slice(&created.subsec_nanos().to_le_bytes());
        identity
    }
}

fn metadata_modified(metadata: &fs::Metadata) -> (u64, u32) {
    let modified = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .unwrap_or_default();
    (modified.as_secs(), modified.subsec_nanos())
}

fn same_entry_identity(left: &fs::Metadata, right: &fs::Metadata) -> bool {
    metadata_identity(left) == metadata_identity(right)
}

pub(crate) fn path_identity(path: &Path) -> Result<String, String> {
    let metadata = fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    Ok(blake3::hash(&metadata_identity(&metadata)).to_hex().to_string())
}

pub(crate) fn copy_fingerprint(path: &Path, cancelled: &impl Fn() -> bool) -> Result<String, String> {
    fingerprint_tree(path, cancelled, true)
}

pub(crate) fn content_fingerprint(
    path: &Path,
    cancelled: &impl Fn() -> bool,
) -> Result<String, String> {
    fingerprint_tree(path, cancelled, false)
}

fn fingerprint_tree(
    path: &Path,
    cancelled: &impl Fn() -> bool,
    include_identity: bool,
) -> Result<String, String> {
    fn visit(
        path: &Path,
        hash: &mut blake3::Hasher,
        depth: usize,
        cancelled: &impl Fn() -> bool,
        include_identity: bool,
    ) -> Result<(), String> {
        if cancelled() {
            return Err("Operation cancelled".to_string());
        }
        use std::io::Read;
        if depth > 256 {
            return Err("Copy tree exceeds undo depth limit".to_string());
        }
        let metadata = fs::symlink_metadata(path).map_err(|error| error.to_string())?;
        let identity = metadata_identity(&metadata);
        if include_identity {
            hash.update(&(identity.len() as u64).to_le_bytes());
            hash.update(&identity);
        }
        let modified = metadata_modified(&metadata);
        hash.update(&modified.0.to_le_bytes());
        hash.update(&modified.1.to_le_bytes());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            hash.update(&metadata.permissions().mode().to_le_bytes());
        }
        #[cfg(not(unix))]
        hash.update(&[u8::from(metadata.permissions().readonly())]);
        if metadata.file_type().is_symlink() {
            hash.update(b"link");
            let target = fs::read_link(path).map_err(|error| error.to_string())?;
            hash.update(target.as_os_str().as_encoded_bytes());
            let after = fs::symlink_metadata(path).map_err(|error| error.to_string())?;
            if !same_entry_identity(&metadata, &after) || metadata_modified(&after) != modified {
                return Err("Copy changed while recording undo".to_string());
            }
        } else if metadata.is_dir() {
            hash.update(b"directory");
            let mut entries = fs::read_dir(path)
                .map_err(|error| error.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|error| error.to_string())?;
            entries.sort_by_key(|entry| entry.file_name());
            hash.update(&(entries.len() as u64).to_le_bytes());
            for entry in entries {
                let name = entry.file_name();
                let bytes = name.as_encoded_bytes();
                hash.update(&(bytes.len() as u64).to_le_bytes());
                hash.update(bytes);
                visit(&entry.path(), hash, depth + 1, cancelled, include_identity)?;
            }
            let after = fs::symlink_metadata(path).map_err(|error| error.to_string())?;
            if !same_entry_identity(&metadata, &after) || metadata_modified(&after) != modified {
                return Err("Copy changed while recording undo".to_string());
            }
        } else {
            hash.update(b"file");
            hash.update(&metadata.len().to_le_bytes());
            let mut file = crate::file_operations::open_regular_read(path)?;
            let mut buffer = vec![0; 1024 * 1024];
            let mut remaining = metadata.len();
            loop {
                if cancelled() {
                    return Err("Operation cancelled".to_string());
                }
                let limit = (buffer.len() as u64).min(remaining.saturating_add(1)) as usize;
                let count = file
                    .read(&mut buffer[..limit])
                    .map_err(|error| error.to_string())?;
                if count as u64 > remaining {
                    return Err("Copy changed while recording undo".to_string());
                }
                remaining -= count as u64;
                if count == 0 {
                    break;
                }
                hash.update(&buffer[..count]);
            }
            let after = file.metadata().map_err(|error| error.to_string())?;
            if remaining != 0
                || after.len() != metadata.len()
                || metadata_modified(&after) != modified
                || !same_entry_identity(&metadata, &after)
            {
                return Err("Copy changed while recording undo".to_string());
            }
            let path_after = fs::symlink_metadata(path).map_err(|error| error.to_string())?;
            if !same_entry_identity(&metadata, &path_after)
                || metadata_modified(&path_after) != modified
            {
                return Err("Copy changed while recording undo".to_string());
            }
        }
        Ok(())
    }
    let mut hash = blake3::Hasher::new();
    visit(path, &mut hash, 0, cancelled, include_identity)?;
    Ok(hash.finalize().to_hex().to_string())
}

fn verify_moved_item(path: &Path, expected: &str) -> Result<(), String> {
    if content_fingerprint(path, &|| false)? != expected {
        return Err(format!(
            "Cannot undo/redo move: item changed at {}",
            path.display()
        ));
    }
    Ok(())
}

pub(crate) fn record_copy_entry(
    source: &Path,
    destination: &Path,
    staged: &Path,
    cancelled: &impl Fn() -> bool,
) -> Result<CopyEntry, String> {
    Ok(CopyEntry {
        source_path: source.to_string_lossy().to_string(),
        dest_path: destination.to_string_lossy().to_string(),
        fingerprint: copy_fingerprint(staged, cancelled)?,
        retained: None,
    })
}

pub(crate) fn push_recorded_copy_action(entries: Vec<CopyEntry>) -> Result<(), String> {
    push_recorded_copy_action_with_backups(entries, Vec::new())
}

pub(crate) fn push_recorded_copy_action_with_backups(
    entries: Vec<CopyEntry>,
    overwrite_backups: Vec<OverwriteBackupEntry>,
) -> Result<(), String> {
    push_recorded_copy_action_with_recovery(entries, overwrite_backups, None)
}

pub(crate) fn push_recorded_copy_action_with_recovery(
    entries: Vec<CopyEntry>,
    overwrite_backups: Vec<OverwriteBackupEntry>,
    recovery_record_id: Option<String>,
) -> Result<(), String> {
    push_undo_action(
        UndoAction::Copy(CopyActionData {
            entries,
            overwrite_backups,
            recovery_record_id,
        }),
        true,
    )
}

#[cfg(test)]
pub fn push_copy_action(paths: &[(PathBuf, PathBuf)]) -> Result<(), String> {
    push_recorded_copy_action(
        paths
            .iter()
            .map(|(source, destination)| {
                record_copy_entry(source, destination, destination, &|| false)
            })
            .collect::<Result<Vec<_>, _>>()?,
    )
}

pub(crate) fn verify_copy(path: &Path, expected: &str) -> Result<(), String> {
    if copy_fingerprint(path, &|| false)? != expected {
        return Err(format!(
            "Cannot undo/redo copy: item changed at {}",
            path.display()
        ));
    }
    Ok(())
}

fn execute_copy_undo(data: &mut CopyActionData) -> Result<(), String> {
    let mut paths = Vec::new();
    let mut backup_paths = Vec::new();
    let mut backups_by_destination = HashMap::new();
    for backup in &data.overwrite_backups {
        let original = canonical_entry_path(Path::new(&backup.original_path), "Overwrite destination")?;
        let retained = canonical_entry_path(Path::new(&backup.backup_path), "Overwrite backup")?;
        if backups_by_destination
            .insert(original.clone(), (retained.clone(), backup.fingerprint.clone()))
            .is_some()
        {
            return Err(format!("Duplicate overwrite backup for {}", original.display()));
        }
    }
    let mut new_workspaces = (0..data.entries.len())
        .map(|_| None)
        .collect::<Vec<Option<tempfile::TempDir>>>();
    let mut copy_indices = Vec::new();
    let mut all_workspaces = data
        .entries
        .iter()
        .map(|entry| entry.retained.clone())
        .collect::<Vec<_>>();
    let mut seen_backups = HashSet::new();
    for (index, entry) in data.entries.iter().enumerate() {
        let destination = canonical_entry_path(Path::new(&entry.dest_path), "Copy")?;
        let retained = entry
            .retained
            .as_ref()
            .map(|workspace| workspace.path().join("content"));
        let destination_exists = path_present(&destination, "Copy destination")?;
        let retained_exists = retained
            .as_ref()
            .map(|path| path_present(path, "Retained copy"))
            .transpose()?
            .unwrap_or(false);
        let destination_is_copy = destination_exists
            && verify_copy(&destination, &entry.fingerprint).is_ok();
        if destination_exists && !destination_is_copy {
            if let Some((_, backup_fingerprint)) = backups_by_destination.get(&destination) {
                verify_copy(&destination, backup_fingerprint)?;
            } else {
                return Err(format!("Cannot undo copy: item changed at {}", destination.display()));
            }
        }
        if retained_exists {
            verify_copy(retained.as_ref().expect("retained path exists"), &entry.fingerprint)?;
        }
        if destination_is_copy && retained_exists {
            return Err(format!(
                "Cannot undo copy: matching entries exist at both {} and {}",
                destination.display(),
                retained.as_ref().expect("retained path exists").display()
            ));
        }
        if destination_is_copy {
            let workspace = tempfile::Builder::new()
                .prefix(".iyeris-undo-")
                .tempdir_in(
                    destination
                        .parent()
                        .ok_or("Copy destination has no parent")?,
                )
                .map_err(|error| error.to_string())?;
            let retained_path = workspace.path().join("content");
            paths.push((destination.clone(), retained_path));
            copy_indices.push(index);
            new_workspaces[index] = Some(workspace);
        } else if !retained_exists {
            return Err(format!("Cannot undo copy: item is missing at {}", destination.display()));
        }
        if backups_by_destination.contains_key(&destination) {
            seen_backups.insert(destination.clone());
        }
        if let Some((backup, fingerprint)) = backups_by_destination.get(&destination) {
            let backup_exists = path_present(backup, "Overwrite backup")?;
            if backup_exists {
                verify_copy(backup, fingerprint)?;
            } else if !destination_exists || verify_copy(&destination, fingerprint).is_err() {
                return Err(format!(
                    "Cannot undo copy: overwrite original is missing from {} and {}",
                    backup.display(),
                    destination.display()
                ));
            }
            if backup_exists {
                backup_paths.push((backup.clone(), destination.clone()));
            }
        }
    }
    if seen_backups.len() != backups_by_destination.len() {
        return Err("Overwrite backup does not belong to a copied destination".to_string());
    }

    crate::recovery::record_paths(
        data.recovery_record_id.as_deref(),
        crate::recovery::RecoveryPaths {
            retained: paths.iter().map(|(_, retained)| retained.clone()).collect(),
            ..crate::recovery::RecoveryPaths::default()
        },
    )?;
    let result = crate::file_operations::rename_batch_transaction_with_recovery(
        &paths,
        data.recovery_record_id.as_deref(),
    )
    .and_then(|()| {
        for (entry, workspace) in data.entries.iter().zip(&all_workspaces) {
            if let Some(workspace) = workspace {
                verify_copy(&workspace.path().join("content"), &entry.fingerprint)?;
            }
        }
        for (index, (_, retained)) in copy_indices.iter().zip(&paths) {
            verify_copy(retained, &data.entries[*index].fingerprint)?;
        }
        if !backup_paths.is_empty() {
            crate::file_operations::rename_batch_transaction_with_recovery(
                &backup_paths,
                data.recovery_record_id.as_deref(),
            )?;
        }
        Ok(())
    });
    if let Err(error) = result {
        let recovery_paths = paths
            .iter()
            .filter(|(_, retained)| path_entry_exists(retained))
            .map(|(destination, retained)| (retained.clone(), destination.clone()))
            .collect::<Vec<_>>();
        let recovery = crate::file_operations::rename_batch_transaction_with_recovery(
            &recovery_paths,
            data.recovery_record_id.as_deref(),
        );
        let mut recovery_errors = Vec::new();
        if let Err(recovery_error) = recovery {
            recovery_errors.push(format!("copy rollback failed: {}", recovery_error));
        }
        for (index, workspace) in new_workspaces.into_iter().enumerate() {
            let Some(workspace) = workspace else { continue };
            let content = workspace.path().join("content");
            if path_entry_exists(&content) {
                all_workspaces[index] = Some(Arc::new(RetainedCopy {
                    workspace: Some(workspace),
                    fingerprint: data.entries[index].fingerprint.clone(),
                }));
            }
        }
        for (entry, workspace) in data.entries.iter_mut().zip(all_workspaces) {
            entry.retained = workspace;
        }
        for (backup_path, destination) in &backup_paths {
            if path_entry_exists(backup_path) {
                recovery_errors.push(format!(
                    "overwrite original retained at {} (destination {})",
                    backup_path.display(),
                    destination.display()
                ));
            }
        }
        let mut message = error;
        for recovery_error in recovery_errors {
            message.push_str("; ");
            message.push_str(&recovery_error);
        }
        return Err(message);
    }
    for (index, workspace) in new_workspaces.into_iter().enumerate() {
        if let Some(workspace) = workspace {
            all_workspaces[index] = Some(Arc::new(RetainedCopy {
                workspace: Some(workspace),
                fingerprint: data.entries[index].fingerprint.clone(),
            }));
        }
    }
    for (entry, workspace) in data.entries.iter_mut().zip(all_workspaces) {
        entry.retained = workspace;
    }
    Ok(())
}

fn execute_copy_redo(data: &mut CopyActionData) -> Result<(), String> {
    let mut paths = Vec::new();
    let mut backup_paths = Vec::new();
    let backups_by_destination: HashMap<PathBuf, &OverwriteBackupEntry> = data
        .overwrite_backups
        .iter()
        .map(|backup| {
            Ok::<_, String>((
                canonical_entry_path(Path::new(&backup.original_path), "Overwrite destination")?,
                backup,
            ))
        })
        .collect::<Result<_, _>>()?;
    for entry in &data.entries {
        let retained = entry
            .retained
            .as_ref()
            .ok_or("Copy redo data is unavailable")?
            .path()
            .join("content");
        verify_copy(&retained, &entry.fingerprint)?;
        let destination = canonical_entry_path(Path::new(&entry.dest_path), "Copy")?;
        if let Some(backup) = backups_by_destination.get(&destination) {
            let original = canonical_entry_path(Path::new(&backup.original_path), "Overwrite destination")?;
            let backup_path = canonical_entry_path(Path::new(&backup.backup_path), "Overwrite backup")?;
            verify_copy(&original, &backup.fingerprint)?;
            if path_entry_exists(&backup_path) {
                return Err(format!(
                    "Cannot redo copy: retained backup path is occupied at {}",
                    backup_path.display()
                ));
            }
            backup_paths.push((original, backup_path));
        } else if path_entry_exists(&destination) {
            return Err(format!("Cannot redo copy: destination occupied at {}", destination.display()));
        }
        paths.push((retained, destination));
    }
    if !backup_paths.is_empty() {
        crate::file_operations::rename_batch_transaction_with_recovery(
            &backup_paths,
            data.recovery_record_id.as_deref(),
        )?;
    }
    if let Err(error) = crate::file_operations::rename_batch_transaction_with_recovery(
        &paths,
        data.recovery_record_id.as_deref(),
    ) {
        let restore = backup_paths
            .iter()
            .map(|(original, backup)| (backup.clone(), original.clone()))
            .collect::<Vec<_>>();
        return match crate::file_operations::rename_batch_transaction_with_recovery(
            &restore,
            data.recovery_record_id.as_deref(),
        ) {
            Ok(()) => Err(error),
            Err(recovery) => Err(format!(
                "{}; overwrite backup recovery failed: {}; backups remain at {}",
                error,
                recovery,
                backup_paths
                    .iter()
                    .map(|(_, path)| path.display().to_string())
                    .collect::<Vec<_>>()
                    .join(", ")
            )),
        };
    }
    for entry in &mut data.entries {
        entry.retained = None;
    }
    Ok(())
}

pub fn push_create_action(path: &Path, is_directory: bool) -> Result<(), String> {
    push_undo_action(
        UndoAction::Create(CreateActionData {
            path: path.to_string_lossy().to_string(),
            is_directory,
            created_at_ms: current_time_ms(),
        }),
        true,
    )
}

pub fn push_rename_action(old_path: &Path, new_path: &Path) -> Result<(), String> {
    let old_path = old_path.to_string_lossy().to_string();
    let new_path = new_path.to_string_lossy().to_string();
    push_undo_action(
        UndoAction::Rename(RenameActionData {
            old_name: to_file_name(&old_path),
            new_name: to_file_name(&new_path),
            old_path,
            new_path,
        }),
        true,
    )
}

pub fn push_move_action(
    source_paths: Vec<String>,
    original_paths: Vec<String>,
    dest_path: String,
) -> Result<(), String> {
    push_move_action_with_backups(
        source_paths,
        original_paths,
        dest_path,
        Vec::new(),
        None,
    )
}

pub(crate) fn push_move_action_with_backups(
    source_paths: Vec<String>,
    original_paths: Vec<String>,
    dest_path: String,
    overwrite_backups: Vec<OverwriteBackupEntry>,
    item_fingerprints: Option<Vec<String>>,
) -> Result<(), String> {
    push_move_action_with_recovery(
        source_paths,
        original_paths,
        dest_path,
        overwrite_backups,
        item_fingerprints,
        None,
    )
}

pub(crate) fn push_move_action_with_recovery(
    source_paths: Vec<String>,
    original_paths: Vec<String>,
    dest_path: String,
    overwrite_backups: Vec<OverwriteBackupEntry>,
    item_fingerprints: Option<Vec<String>>,
    recovery_record_id: Option<String>,
) -> Result<(), String> {
    if source_paths.is_empty() {
        return Ok(());
    }
    let original_parent = original_paths.first().and_then(|path| {
        Path::new(path)
            .parent()
            .map(|parent| parent.to_string_lossy().to_string())
    });
    push_undo_action(
        UndoAction::Move(MoveActionData {
            source_paths,
            original_paths: if original_paths.is_empty() {
                None
            } else {
                Some(original_paths)
            },
            original_parent,
            dest_path,
            item_fingerprints,
            overwrite_backups,
            recovery_record_id,
        }),
        true,
    )
}

pub fn push_batch_rename_action(renames: Vec<(String, String)>) -> Result<(), String> {
    if renames.is_empty() {
        return Ok(());
    }
    let renames = renames
        .into_iter()
        .map(|(old_path, new_path)| BatchRenameEntry { old_path, new_path })
        .collect();
    push_undo_action(
        UndoAction::BatchRename(BatchRenameActionData { renames }),
        true,
    )
}

fn action_contains_path(action: &UndoAction, paths: &HashSet<String>) -> bool {
    match action {
        UndoAction::Copy(data) => {
            data.entries
                .iter()
                .any(|entry| paths.contains(&entry.dest_path))
                || data.overwrite_backups.iter().any(|backup| {
                    paths.contains(&backup.original_path) || paths.contains(&backup.backup_path)
                })
        }
        UndoAction::Rename(data) => {
            paths.contains(&data.old_path) || paths.contains(&data.new_path)
        }
        UndoAction::Create(data) => paths.contains(&data.path),
        UndoAction::Move(data) => {
            data.source_paths.iter().any(|path| paths.contains(path))
                || data
                    .original_paths
                    .as_ref()
                    .map(|items| items.iter().any(|path| paths.contains(path)))
                    .unwrap_or(false)
                || data.overwrite_backups.iter().any(|backup| {
                    paths.contains(&backup.original_path) || paths.contains(&backup.backup_path)
                })
        }
        UndoAction::BatchRename(data) => data
            .renames
            .iter()
            .any(|item| paths.contains(&item.old_path) || paths.contains(&item.new_path)),
        UndoAction::Trash(data) => {
            paths.contains(&data.path)
                || data
                    .original_path
                    .as_ref()
                    .map(|path| paths.contains(path))
                    .unwrap_or(false)
        }
    }
}

fn expand_related_paths(stack: &[UndoAction], paths_to_remove: &mut HashSet<String>) {
    for action in stack.iter().rev() {
        match action {
            UndoAction::Rename(data)
                if paths_to_remove.contains(&data.old_path)
                    || paths_to_remove.contains(&data.new_path) =>
            {
                paths_to_remove.insert(data.old_path.clone());
                paths_to_remove.insert(data.new_path.clone());
            }
            UndoAction::BatchRename(data) => {
                for rename in &data.renames {
                    if paths_to_remove.contains(&rename.old_path)
                        || paths_to_remove.contains(&rename.new_path)
                    {
                        paths_to_remove.insert(rename.old_path.clone());
                        paths_to_remove.insert(rename.new_path.clone());
                    }
                }
            }
            _ => {}
        }
    }
}

pub fn clear_undo_stack_for_path(item_path: &str) -> Result<(), String> {
    let mut discarded = Vec::new();
    {
        let mut undo = UNDO_STACK.lock().map_err(|e| e.to_string())?;
        let mut redo = REDO_STACK.lock().map_err(|e| e.to_string())?;

        let mut paths_to_remove = HashSet::new();
        paths_to_remove.insert(item_path.to_string());

        expand_related_paths(&undo, &mut paths_to_remove);
        expand_related_paths(&redo, &mut paths_to_remove);

        let old_undo = std::mem::take(&mut *undo);
        for action in old_undo {
            if action_contains_path(&action, &paths_to_remove) {
                discarded.push(action);
            } else {
                undo.push(action);
            }
        }
        let old_redo = std::mem::take(&mut *redo);
        for action in old_redo {
            if action_contains_path(&action, &paths_to_remove) {
                discarded.push(action);
            } else {
                redo.push(action);
            }
        }
    }
    for action in discarded {
        discard_action_safely(action);
    }

    Ok(())
}

pub fn clear_undo_redo_for_path(item_path: &str) -> Result<(), String> {
    clear_undo_stack_for_path(item_path)
}

fn get_state() -> Result<UndoRedoState, String> {
    let undo = UNDO_STACK.lock().map_err(|e| e.to_string())?;
    let redo = REDO_STACK.lock().map_err(|e| e.to_string())?;
    Ok(UndoRedoState {
        can_undo: !undo.is_empty(),
        can_redo: !redo.is_empty(),
    })
}

fn path_entry_exists(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok()
}

/// Resolve an entry through a stable, canonical parent before undo/redo
/// renames or moves. The entry itself may be a symlink (rename must preserve
/// that link), so only the parent is canonicalized. This does not pin a
/// directory handle against concurrent replacement by another process.
fn canonical_entry_path(path: &Path, label: &str) -> Result<PathBuf, String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("Cannot determine {} parent directory", label))?;
    let name = path
        .file_name()
        .ok_or_else(|| format!("Cannot determine {} name", label))?;
    let parent_meta = fs::symlink_metadata(parent)
        .map_err(|error| format!("Cannot inspect {} parent directory: {}", label, error))?;
    if parent_meta.file_type().is_symlink() || !parent_meta.is_dir() {
        return Err(format!(
            "{} parent directory is not a real directory",
            label
        ));
    }
    let canonical_parent = parent
        .canonicalize()
        .map_err(|error| format!("Cannot resolve {} parent directory: {}", label, error))?;
    Ok(canonical_parent.join(name))
}

fn canonical_batch_rename_paths(
    data: &BatchRenameActionData,
) -> Result<Vec<(PathBuf, PathBuf)>, String> {
    data.renames
        .iter()
        .map(|rename| {
            Ok((
                canonical_entry_path(Path::new(&rename.old_path), "Batch rename source")?,
                canonical_entry_path(Path::new(&rename.new_path), "Batch rename target")?,
            ))
        })
        .collect()
}

fn move_path(source: &Path, dest: &Path) -> Result<(), String> {
    crate::file_operations::move_path_with_fallback(source, dest)
}

fn execute_rename_action(from_path: &str, to_path: &str, direction: &str) -> Result<(), String> {
    let from_raw = match crate::validate_existing_path(from_path, "Item") {
        Ok(path) => path,
        Err(_) => {
            return Err(format!(
                "Cannot {}: File no longer exists (may have been moved or deleted)",
                direction
            ))
        }
    };
    let to = crate::validate_path(to_path, "Target")
        .map_err(|_| format!("Cannot {}: Invalid target path", direction))?;
    let from = canonical_entry_path(&from_raw, "Item")?;
    let to = canonical_entry_path(&to, "Target")?;
    if !path_entry_exists(&from) {
        return Err(format!(
            "Cannot {}: File no longer exists (may have been moved or deleted)",
            direction
        ));
    }
    if path_entry_exists(&to) {
        return Err(format!(
            "Cannot {}: A file already exists at the {} location",
            direction,
            if direction == "undo" {
                "original"
            } else {
                "target"
            }
        ));
    }
    move_path(&from, &to)
}

fn move_undo_targets(action: &MoveActionData) -> Option<Vec<String>> {
    if let Some(original_paths) = &action.original_paths {
        if original_paths.len() == action.source_paths.len() {
            return Some(original_paths.clone());
        }
    }
    let parent = action.original_parent.as_ref()?;
    Some(
        action
            .source_paths
            .iter()
            .map(|source| {
                Path::new(parent)
                    .join(to_file_name(source))
                    .to_string_lossy()
                    .to_string()
            })
            .collect(),
    )
}

fn verify_optional_fingerprint(path: &Path, expected: Option<&str>) -> Result<(), String> {
    if let Some(expected) = expected {
        verify_copy(path, expected)
    } else {
        Ok(())
    }
}

fn path_present(path: &Path, label: &str) -> Result<bool, String> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(format!("Cannot inspect {} {}: {}", label, path.display(), error)),
    }
}

fn overwrite_backup_map(
    backups: &[OverwriteBackupEntry],
) -> Result<HashMap<PathBuf, (PathBuf, String)>, String> {
    let mut result = HashMap::new();
    for backup in backups {
        let original = canonical_entry_path(Path::new(&backup.original_path), "Overwrite destination")?;
        let retained = canonical_entry_path(Path::new(&backup.backup_path), "Overwrite backup")?;
        if result
            .insert(original.clone(), (retained, backup.fingerprint.clone()))
            .is_some()
        {
            return Err(format!("Duplicate overwrite backup for {}", original.display()));
        }
    }
    Ok(result)
}

fn finish_move_overwrite_failure(action: MoveActionData, error: String) -> Result<(), String> {
    crate::recovery::record_error(action.recovery_record_id.as_deref(), &error);
    push_undo_action(UndoAction::Move(action), false)?;
    Err(error)
}

fn execute_move_overwrite_undo_with(
    action: MoveActionData,
    move_item: &mut impl FnMut(&Path, &Path) -> Result<(), String>,
) -> Result<(), String> {
    let targets = match move_undo_targets(&action) {
        Some(paths) => paths,
        None => {
            return finish_move_overwrite_failure(
                action,
                "Cannot undo: Original parent path not available".to_string(),
            )
        }
    };
    let current = match action
        .source_paths
        .iter()
        .map(|path| canonical_entry_path(Path::new(path), "Moved item"))
        .collect::<Result<Vec<_>, _>>()
    {
        Ok(paths) => paths,
        Err(error) => return finish_move_overwrite_failure(action, error),
    };
    let targets = match targets
        .iter()
        .map(|path| canonical_entry_path(Path::new(path), "Original item"))
        .collect::<Result<Vec<_>, _>>()
    {
        Ok(paths) => paths,
        Err(error) => return finish_move_overwrite_failure(action, error),
    };
    let fingerprints = match action.item_fingerprints.as_ref() {
        Some(fingerprints) if fingerprints.len() == current.len() => fingerprints,
        _ => {
            return finish_move_overwrite_failure(
                action,
                "Cannot undo overwritten move: destination fingerprints are unavailable".to_string(),
            )
        }
    };
    let backup_map = match overwrite_backup_map(&action.overwrite_backups) {
        Ok(backups) => backups,
        Err(error) => return finish_move_overwrite_failure(action, error),
    };

    let mut move_current: Vec<(PathBuf, PathBuf)> = Vec::new();
    for index in 0..current.len() {
        let current_exists = match path_present(&current[index], "Moved item") {
            Ok(exists) => exists,
            Err(error) => return finish_move_overwrite_failure(action, error),
        };
        let target_exists = match path_present(&targets[index], "Original item") {
            Ok(exists) => exists,
            Err(error) => return finish_move_overwrite_failure(action, error),
        };
        if current_exists {
            if let Err(error) = verify_moved_item(&current[index], &fingerprints[index]) {
                return finish_move_overwrite_failure(action, error);
            }
        }
        if target_exists {
            if let Err(error) = verify_moved_item(&targets[index], &fingerprints[index]) {
                return finish_move_overwrite_failure(
                    action,
                    format!("Original path occupied by another item: {}; {}", targets[index].display(), error),
                );
            }
        }
        match (current_exists, target_exists) {
            (true, false) => move_current.push((current[index].clone(), targets[index].clone())),
            (false, true) => {}
            (true, true) => {
                return finish_move_overwrite_failure(
                    action,
                    format!("Cannot undo move: item exists at both {} and {}", current[index].display(), targets[index].display()),
                )
            }
            (false, false) => {
                return finish_move_overwrite_failure(
                    action,
                    format!("Cannot undo move: item is missing from {} and {}", current[index].display(), targets[index].display()),
                )
            }
        }
        if let Some((backup_path, backup_fingerprint)) = backup_map.get(&current[index]) {
            let backup_staged = match path_present(backup_path, "Overwrite backup") {
                Ok(exists) => exists,
                Err(error) => return finish_move_overwrite_failure(action, error),
            };
            let backup_restored = match path_present(&current[index], "Overwrite destination") {
                Ok(exists) => exists
                    && verify_copy(&current[index], backup_fingerprint).is_ok(),
                Err(error) => return finish_move_overwrite_failure(action, error),
            };
            if backup_staged {
                if let Err(error) = verify_copy(backup_path, backup_fingerprint) {
                    return finish_move_overwrite_failure(action, error);
                }
            }
            if !backup_staged && !backup_restored {
                return finish_move_overwrite_failure(
                    action,
                    format!("Cannot undo move: overwrite original is missing from {} and {}", backup_path.display(), current[index].display()),
                );
            }
            if backup_staged && current_exists {
                // The destination is occupied by the new move, as expected.
            } else if backup_staged && !current_exists {
                // Restore below after the moved item is at its original source.
            }
        } else if backup_map.keys().any(|path| path == &current[index]) {
            unreachable!("backup lookup returned none for a matching key");
        }
    }
    for backup_path in backup_map.keys() {
        if !current.contains(backup_path) {
            return finish_move_overwrite_failure(
                action,
                format!("Overwrite backup does not belong to a moved destination: {}", backup_path.display()),
            );
        }
    }

    let mut moved_indices: Vec<usize> = Vec::new();
    let mut restored_backups = Vec::new();
    for (index, (source, target)) in move_current.iter().enumerate() {
        if let Err(error) = move_item(source, target) {
            let mut recovery_errors = Vec::new();
            for (backup_path, (destination, fingerprint)) in backup_map.iter() {
                if path_entry_exists(destination)
                    && verify_copy(destination, fingerprint).is_ok()
                    && !path_entry_exists(backup_path)
                {
                    if let Err(recovery) = move_item(destination, backup_path) {
                        recovery_errors.push(format!(
                            "backup rollback {} -> {} failed: {}; original remains at {}",
                            destination.display(),
                            backup_path.display(),
                            recovery,
                            destination.display()
                        ));
                    }
                }
            }
            for completed in moved_indices.into_iter().rev() {
                let (from, to) = &move_current[completed];
                if let Err(recovery) = move_item(to, from) {
                    recovery_errors.push(format!(
                        "move rollback {} -> {} failed: {}; item remains at {}",
                        to.display(),
                        from.display(),
                        recovery,
                        to.display()
                    ));
                }
            }
            let mut message = format!("Partial overwrite undo failed: {}", error);
            for recovery in recovery_errors {
                message.push_str("; ");
                message.push_str(&recovery);
            }
            return finish_move_overwrite_failure(action, message);
        }
        moved_indices.push(index);
    }

    for (backup_path, (destination, fingerprint)) in &backup_map {
        if !path_entry_exists(backup_path) {
            continue;
        }
        if path_entry_exists(destination) {
            if verify_copy(destination, fingerprint).is_ok() {
                continue;
            }
            return finish_move_overwrite_failure(
                action,
                format!("Cannot restore overwrite original; destination occupied at {}", destination.display()),
            );
        }
        if let Err(error) = move_item(backup_path, destination) {
            let mut recovery_errors = Vec::new();
            for restored in restored_backups.iter().rev() {
                if let Some((backup_path, (destination, _))) = backup_map.iter().find(|(_, (destination, _))| *destination == *restored) {
                    if let Err(recovery) = move_item(destination, backup_path) {
                        recovery_errors.push(format!(
                            "backup rollback {} -> {} failed: {}; item remains at {}",
                            destination.display(),
                            backup_path.display(),
                            recovery,
                            destination.display()
                        ));
                    }
                }
            }
            for (from, to) in move_current.iter().rev() {
                if path_entry_exists(to) && !path_entry_exists(from) {
                    if let Err(recovery) = move_item(to, from) {
                        recovery_errors.push(format!(
                            "move rollback {} -> {} failed: {}; item remains at {}",
                            to.display(),
                            from.display(),
                            recovery,
                            to.display()
                        ));
                    }
                }
            }
            let mut message = format!("Overwrite restore failed: {}; original retained at {}", error, backup_path.display());
            for recovery in recovery_errors {
                message.push_str("; ");
                message.push_str(&recovery);
            }
            return finish_move_overwrite_failure(action, message);
        }
        restored_backups.push(destination.clone());
    }
    Ok(())
}

fn execute_move_overwrite_redo_with(
    action: &MoveActionData,
    move_item: &mut impl FnMut(&Path, &Path) -> Result<(), String>,
) -> Result<Vec<String>, String> {
    let redo_result = (|| -> Result<(), String> {
        let targets = move_undo_targets(action)
            .ok_or("Cannot redo: Original parent path not available")?;
        let sources = targets
            .iter()
            .map(|path| canonical_entry_path(Path::new(path), "Original item"))
            .collect::<Result<Vec<_>, _>>()?;
        let destinations = action
            .source_paths
            .iter()
            .map(|path| canonical_entry_path(Path::new(path), "Move destination"))
            .collect::<Result<Vec<_>, _>>()?;
        let fingerprints = action
            .item_fingerprints
            .as_ref()
            .filter(|fingerprints| fingerprints.len() == sources.len())
            .ok_or("Cannot redo overwritten move: destination fingerprints are unavailable")?;
        let backup_map = overwrite_backup_map(&action.overwrite_backups)?;
        let mut moves = Vec::new();
        for index in 0..sources.len() {
            let source_exists = path_present(&sources[index], "Original item")?;
            let destination_exists = path_present(&destinations[index], "Move destination")?;
            if source_exists {
                verify_moved_item(&sources[index], &fingerprints[index])?;
                if destination_exists {
                    if let Some((_, backup_fingerprint)) = backup_map.get(&destinations[index]) {
                        if verify_copy(&destinations[index], backup_fingerprint).is_err() {
                            return Err(format!("Cannot redo move: destination occupied at {}", destinations[index].display()));
                        }
                    } else {
                        return Err(format!("Cannot redo move: destination occupied at {}", destinations[index].display()));
                    }
                }
                moves.push((sources[index].clone(), destinations[index].clone()));
            } else if destination_exists {
                verify_moved_item(&destinations[index], &fingerprints[index])?;
            } else {
                return Err(format!("Cannot redo move: item missing from {} and {}", sources[index].display(), destinations[index].display()));
            }
        }
        let mut staged_backups = Vec::new();
        for (destination, (backup_path, fingerprint)) in &backup_map {
            let dest_matches = path_present(destination, "Overwrite destination")?
                && verify_copy(destination, fingerprint).is_ok();
            let backup_matches = path_present(backup_path, "Overwrite backup")?
                && verify_copy(backup_path, fingerprint).is_ok();
            if dest_matches && !backup_matches {
                if path_present(backup_path, "Overwrite backup")? {
                    return Err(format!("Cannot redo move: backup path occupied at {}", backup_path.display()));
                }
                staged_backups.push((destination.clone(), backup_path.clone()));
            } else if !backup_matches {
                return Err(format!("Cannot redo move: overwrite original missing from {} and {}", destination.display(), backup_path.display()));
            }
        }

        let mut completed_backups = Vec::new();
        let mut completed_moves: Vec<(PathBuf, PathBuf)> = Vec::new();
        for (destination, backup_path) in &staged_backups {
            if let Err(error) = move_item(destination, backup_path) {
                return Err(format!("Failed to retain overwrite original: {}; item remains at {}", error, destination.display()));
            }
            completed_backups.push((destination.clone(), backup_path.clone()));
        }
        for (source, destination) in &moves {
            if let Err(error) = move_item(source, destination) {
                let mut recovery_errors = Vec::new();
                for (from, to) in completed_moves.iter().rev() {
                    if let Err(recovery) = move_item(to, from) {
                        recovery_errors.push(format!("move rollback {} -> {} failed: {}; item remains at {}", to.display(), from.display(), recovery, to.display()));
                    }
                }
                for (original, backup) in completed_backups.iter().rev() {
                    if let Err(recovery) = move_item(backup, original) {
                        recovery_errors.push(format!("backup rollback {} -> {} failed: {}; original remains at {}", backup.display(), original.display(), recovery, backup.display()));
                    }
                }
                let mut message = format!("Partial overwrite redo failed: {}", error);
                for recovery in recovery_errors {
                    message.push_str("; ");
                    message.push_str(&recovery);
                }
                return Err(message);
            }
            completed_moves.push((source.clone(), destination.clone()));
        }
        Ok(())
    })();

    if let Err(error) = redo_result {
        push_redo_action(UndoAction::Move(action.clone()))?;
        return Err(error);
    }
    Ok(action.source_paths.clone())
}

fn move_action_subset(
    action: &MoveActionData,
    indices: &[usize],
    source_paths_override: Option<&[PathBuf]>,
) -> MoveActionData {
    let aligned_original_paths = action
        .original_paths
        .as_ref()
        .filter(|paths| paths.len() == action.source_paths.len());
    MoveActionData {
        source_paths: indices
            .iter()
            .map(|index| {
                source_paths_override
                    .and_then(|paths| paths.get(*index))
                    .map(|path| path.to_string_lossy().into_owned())
                    .or_else(|| action.source_paths.get(*index).cloned())
                    .unwrap_or_else(|| {
                        aligned_original_paths
                            .and_then(|paths| paths.get(*index))
                            .map(|path| {
                                Path::new(&action.dest_path)
                                    .join(to_file_name(path))
                                    .to_string_lossy()
                                    .into_owned()
                            })
                            .unwrap_or_default()
                    })
            })
            .collect(),
        original_paths: aligned_original_paths
            .map(|paths| indices.iter().map(|index| paths[*index].clone()).collect()),
        original_parent: action.original_parent.clone(),
        dest_path: action.dest_path.clone(),
        item_fingerprints: action.item_fingerprints.as_ref().and_then(|fingerprints| {
            (fingerprints.len() == action.source_paths.len())
                .then(|| indices.iter().map(|index| fingerprints[*index].clone()).collect())
        }),
        overwrite_backups: action
            .overwrite_backups
            .iter()
            .filter(|backup| {
                indices.iter().any(|index| {
                    action.source_paths.get(*index).is_some_and(|source| source == &backup.original_path)
                })
            })
            .cloned()
            .collect(),
        recovery_record_id: action.recovery_record_id.clone(),
    }
}

fn describe_recovery_location(source: &Path, target: &Path) -> String {
    match (path_entry_exists(source), path_entry_exists(target)) {
        (true, false) => format!("item remains at {}", source.display()),
        (false, true) => format!("item remains at {}", target.display()),
        (true, true) => format!(
            "entries remain at both {} and {}; inspect them before retrying",
            source.display(),
            target.display()
        ),
        (false, false) => format!(
            "could not confirm the item state at {} or {}; inspect both paths and any recovery path in the move error",
            source.display(),
            target.display()
        ),
    }
}

fn execute_move_undo(action: MoveActionData) -> Result<(), String> {
    let recovery_record_id = action.recovery_record_id.clone();
    execute_move_undo_with(action, &mut |source, target| {
        crate::file_operations::move_path_with_fallback_cancellable_and_recovery(
            source,
            target,
            &|| false,
            recovery_record_id.as_deref(),
        )
    })
}

fn execute_move_undo_with(
    action: MoveActionData,
    move_item: &mut impl FnMut(&Path, &Path) -> Result<(), String>,
) -> Result<(), String> {
    if !action.overwrite_backups.is_empty() {
        return execute_move_overwrite_undo_with(action, move_item);
    }
    let targets = match move_undo_targets(&action) {
        Some(paths) => paths,
        None => {
            push_undo_action(UndoAction::Move(action), false)?;
            return Err("Cannot undo: Original parent path not available".to_string());
        }
    };

    let sources: Vec<PathBuf> = match action
        .source_paths
        .iter()
        .map(|source| canonical_entry_path(Path::new(source), "Moved item"))
        .collect::<Result<_, _>>()
    {
        Ok(paths) => paths,
        Err(error) => {
            push_undo_action(UndoAction::Move(action), false)?;
            return Err(error);
        }
    };
    let targets: Vec<PathBuf> = match targets
        .iter()
        .map(|target| canonical_entry_path(Path::new(target), "Original item"))
        .collect::<Result<_, _>>()
    {
        Ok(paths) => paths,
        Err(error) => {
            push_undo_action(UndoAction::Move(action), false)?;
            return Err(error);
        }
    };

    for source in &sources {
        if !path_entry_exists(source) {
            push_undo_action(UndoAction::Move(action), false)?;
            return Err("Cannot undo: One or more files no longer exist".to_string());
        }
    }
    if let Some(fingerprints) = action.item_fingerprints.as_ref() {
        if fingerprints.len() != sources.len() {
            push_undo_action(UndoAction::Move(action), false)?;
            return Err("Cannot undo: Move fingerprints do not match the recorded items".to_string());
        }
        for (source, fingerprint) in sources.iter().zip(fingerprints) {
            if let Err(error) = verify_moved_item(source, fingerprint) {
                push_undo_action(UndoAction::Move(action), false)?;
                return Err(error);
            }
        }
    }

    for target in &targets {
        if path_entry_exists(target) {
            push_undo_action(UndoAction::Move(action), false)?;
            return Err("Cannot undo: A file already exists at the original location".to_string());
        }
    }

    for index in 0..action.source_paths.len() {
        let source = sources[index].clone();
        let target = targets[index].clone();
        if let Err(err) = move_item(&source, &target) {
            let mut rollback_succeeded = vec![false; index];
            let mut rollback_errors = Vec::new();
            for i in (0..index).rev() {
                match move_item(&targets[i], &sources[i]) {
                    Ok(()) => rollback_succeeded[i] = true,
                    Err(rollback_error) => rollback_errors.push(format!(
                        "rollback {} -> {} failed: {}; {}",
                        targets[i].display(),
                        sources[i].display(),
                        rollback_error,
                        describe_recovery_location(&targets[i], &sources[i])
                    )),
                }
            }

            let mut undo_indices = Vec::new();
            let mut redo_indices = Vec::new();
            let mut state_errors = Vec::new();
            for item_index in 0..action.source_paths.len() {
                let source_exists = path_entry_exists(&sources[item_index]);
                let target_exists = path_entry_exists(&targets[item_index]);
                if item_index < index && !rollback_succeeded[item_index] {
                    if target_exists {
                        redo_indices.push(item_index);
                    } else if source_exists {
                        undo_indices.push(item_index);
                    } else {
                        undo_indices.push(item_index);
                        state_errors.push(describe_recovery_location(
                            &sources[item_index],
                            &targets[item_index],
                        ));
                    }
                } else if source_exists {
                    undo_indices.push(item_index);
                    if target_exists {
                        state_errors.push(format!(
                            "{} also has an entry at {}; undo will wait until that occupant is moved",
                            action.source_paths[item_index],
                            targets[item_index].display()
                        ));
                    }
                } else if target_exists
                    && item_index == index
                    && err.starts_with("Source cleanup incomplete:")
                {
                    // Some move implementations can report a cleanup failure after
                    // the destination entry has already been created.
                    redo_indices.push(item_index);
                } else if target_exists && item_index == index {
                    undo_indices.push(item_index);
                    state_errors.push(describe_recovery_location(
                        &sources[item_index],
                        &targets[item_index],
                    ));
                } else {
                    // Keep unconfirmed entries retryable; filesystem metadata
                    // errors do not prove that either path is absent.
                    undo_indices.push(item_index);
                    state_errors.push(describe_recovery_location(
                        &sources[item_index],
                        &targets[item_index],
                    ));
                }
            }

            if !undo_indices.is_empty() {
                push_undo_action(
                    UndoAction::Move(move_action_subset(&action, &undo_indices, None)),
                    false,
                )?;
            }
            if !redo_indices.is_empty() {
                push_redo_action(UndoAction::Move(move_action_subset(
                    &action,
                    &redo_indices,
                    None,
                )))?;
            }

            let mut message = format!("Partial undo failed: {}", err);
            for detail in rollback_errors.iter().chain(state_errors.iter()) {
                message.push_str("; ");
                message.push_str(detail);
            }
            return Err(message);
        }
    }

    Ok(())
}

fn execute_move_redo(action: &MoveActionData) -> Result<Vec<String>, String> {
    let recovery_record_id = action.recovery_record_id.clone();
    execute_move_redo_with(action, &mut |source, target| {
        crate::file_operations::move_path_with_fallback_cancellable_and_recovery(
            source,
            target,
            &|| false,
            recovery_record_id.as_deref(),
        )
    })
}

fn execute_move_redo_with(
    action: &MoveActionData,
    move_item: &mut impl FnMut(&Path, &Path) -> Result<(), String>,
) -> Result<Vec<String>, String> {
    if !action.overwrite_backups.is_empty() {
        return execute_move_overwrite_redo_with(action, move_item);
    }
    let mut source_target_pairs: Vec<(PathBuf, PathBuf)> = Vec::new();

    if let Some(original_paths) = &action.original_paths {
        if original_paths.len() == action.source_paths.len() {
            source_target_pairs.extend(
                original_paths
                    .iter()
                    .zip(&action.source_paths)
                    .map(|(source, destination)| (PathBuf::from(source), PathBuf::from(destination))),
            );
        } else if let Some(original_parent) = &action.original_parent {
            source_target_pairs.extend(action.source_paths.iter().map(|destination| {
                let source = Path::new(original_parent).join(to_file_name(destination));
                (source, PathBuf::from(destination))
            }));
        } else {
            push_redo_action(UndoAction::Move(action.clone()))?;
            return Err("Cannot redo: Original parent path not available".to_string());
        }
    } else if let Some(original_parent) = &action.original_parent {
        source_target_pairs.extend(action.source_paths.iter().map(|source| {
            let file_name = to_file_name(source);
            (Path::new(original_parent).join(&file_name), PathBuf::from(source))
        }));
    } else {
        push_redo_action(UndoAction::Move(action.clone()))?;
        return Err("Cannot redo: Original parent path not available".to_string());
    }

    let canonical_pairs = source_target_pairs
        .into_iter()
        .map(|(source, target)| {
            Ok::<_, String>((
                canonical_entry_path(&source, "Original item")?,
                canonical_entry_path(&target, "Redo target")?,
            ))
        })
        .collect::<Result<Vec<(PathBuf, PathBuf)>, String>>();
    let source_target_pairs = match canonical_pairs {
        Ok(pairs) => pairs,
        Err(error) => {
            push_redo_action(UndoAction::Move(action.clone()))?;
            return Err(error);
        }
    };

    // Pre-check all sources and targets before any moves to avoid partial state
    for (index, (source, target)) in source_target_pairs.iter().enumerate() {
        if !path_entry_exists(source) {
            push_redo_action(UndoAction::Move(action.clone()))?;
            return Err("Cannot redo: File not found at original location".to_string());
        }
        if let Some(fingerprint) = action
            .item_fingerprints
            .as_ref()
            .and_then(|fingerprints| fingerprints.get(index))
        {
            if let Err(error) = verify_moved_item(source, fingerprint) {
                push_redo_action(UndoAction::Move(action.clone()))?;
                return Err(error);
            }
        }
        if path_entry_exists(target) {
            push_redo_action(UndoAction::Move(action.clone()))?;
            return Err("Cannot redo: A file already exists at the target location".to_string());
        }
    }

    let mut new_moved_paths = Vec::new();
    for (index, (source, target)) in source_target_pairs.iter().enumerate() {
        if let Err(err) = move_item(source, target) {
            let mut rollback_succeeded = vec![false; index];
            let mut rollback_errors = Vec::new();
            for j in (0..index).rev() {
                let (source, target) = &source_target_pairs[j];
                match move_item(target, source) {
                    Ok(()) => rollback_succeeded[j] = true,
                    Err(rollback_error) => rollback_errors.push(format!(
                        "rollback {} -> {} failed: {}; {}",
                        target.display(),
                        source.display(),
                        rollback_error,
                        describe_recovery_location(target, source)
                    )),
                }
            }

            let mut redo_indices = Vec::new();
            let mut undo_indices = Vec::new();
            let mut state_errors = Vec::new();
            for item_index in 0..source_target_pairs.len() {
                let (source, target) = &source_target_pairs[item_index];
                let source_exists = path_entry_exists(source);
                let target_exists = path_entry_exists(target);
                if item_index < index && !rollback_succeeded[item_index] {
                    if target_exists {
                        undo_indices.push(item_index);
                    } else if source_exists {
                        redo_indices.push(item_index);
                    } else {
                        redo_indices.push(item_index);
                        state_errors.push(describe_recovery_location(source, target));
                    }
                } else if source_exists {
                    redo_indices.push(item_index);
                    if target_exists {
                        state_errors.push(format!(
                            "{} also has an entry at {}; redo will wait until that occupant is moved",
                            source.display(),
                            target.display()
                        ));
                    }
                } else if target_exists
                    && item_index == index
                    && err.starts_with("Source cleanup incomplete:")
                {
                    undo_indices.push(item_index);
                } else if target_exists && item_index == index {
                    redo_indices.push(item_index);
                    state_errors.push(describe_recovery_location(source, target));
                } else {
                    // Keep unconfirmed entries retryable; filesystem metadata
                    // errors do not prove that either path is absent.
                    redo_indices.push(item_index);
                    state_errors.push(describe_recovery_location(source, target));
                }
            }

            if !redo_indices.is_empty() {
                push_redo_action(UndoAction::Move(move_action_subset(
                    action,
                    &redo_indices,
                    None,
                )))?;
            }
            if !undo_indices.is_empty() {
                let target_paths = source_target_pairs
                    .iter()
                    .map(|(_, target)| target.clone())
                    .collect::<Vec<_>>();
                push_undo_action(
                    UndoAction::Move(move_action_subset(
                        action,
                        &undo_indices,
                        Some(&target_paths),
                    )),
                    false,
                )?;
            }

            let mut message = format!("Partial redo failed: {}", err);
            for detail in rollback_errors.iter().chain(state_errors.iter()) {
                message.push_str("; ");
                message.push_str(detail);
            }
            return Err(message);
        }
        new_moved_paths.push(target.to_string_lossy().to_string());
    }

    Ok(new_moved_paths)
}

enum CreateUndoFailure {
    Keep(String),
    Drop(String),
}

fn metadata_time_ms(metadata: &fs::Metadata) -> Option<f64> {
    metadata
        .created()
        .ok()
        .or_else(|| metadata.modified().ok())
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs_f64() * 1000.0)
}

fn execute_create_undo(action: &CreateActionData) -> Result<(), CreateUndoFailure> {
    let item_path = PathBuf::from(&action.path);

    // Pin the parent directory before inspecting/removing the entry. This
    // avoids following a parent symlink swapped in after the undo action was
    // recorded, and lets us reject a replaced final symlink explicitly.
    let file_name = item_path
        .file_name()
        .ok_or_else(|| CreateUndoFailure::Keep("Cannot undo: Invalid created path".to_string()))?;
    let parent = item_path
        .parent()
        .ok_or_else(|| CreateUndoFailure::Keep("Cannot undo: Invalid created path".to_string()))?;
    let parent_meta = fs::symlink_metadata(parent).map_err(|e| {
        CreateUndoFailure::Keep(format!("Cannot undo: parent directory unavailable: {}", e))
    })?;
    if parent_meta.file_type().is_symlink() || !parent_meta.is_dir() {
        return Err(CreateUndoFailure::Keep(
            "Cannot undo: parent directory is not a real directory".to_string(),
        ));
    }
    let canonical_parent = fs::canonicalize(parent).map_err(|e| {
        CreateUndoFailure::Keep(format!("Cannot undo: parent directory unavailable: {}", e))
    })?;
    let item_path = canonical_parent.join(file_name);

    let metadata = match fs::symlink_metadata(&item_path) {
        Ok(m) => m,
        Err(_) => {
            return Err(CreateUndoFailure::Drop(
                "Cannot undo: File no longer exists".to_string(),
            ));
        }
    };

    if metadata.file_type().is_symlink() {
        return Err(CreateUndoFailure::Keep(
            "Cannot undo: File has been replaced since creation".to_string(),
        ));
    }

    if let (Some(created_at), Some(current_created_at)) =
        (action.created_at_ms, metadata_time_ms(&metadata))
    {
        if (current_created_at - created_at).abs() > CREATED_TIME_TOLERANCE_MS {
            return Err(CreateUndoFailure::Keep(
                "Cannot undo: File has been replaced since creation".to_string(),
            ));
        }
    }

    if metadata.is_dir() {
        let mut entries = fs::read_dir(&item_path)
            .map_err(|e| CreateUndoFailure::Keep(format!("Cannot undo: {}", e)))?;
        if entries.next().is_some() {
            return Err(CreateUndoFailure::Keep(
                "Cannot undo: Folder is not empty. Remove its contents first.".to_string(),
            ));
        }
        fs::remove_dir(&item_path)
            .map_err(|e| CreateUndoFailure::Keep(format!("Cannot undo: {}", e)))?;
    } else {
        if !action.is_directory && metadata.len() > 0 {
            return Err(CreateUndoFailure::Keep(
                "Cannot undo: File has been modified since creation".to_string(),
            ));
        }
        fs::remove_file(&item_path)
            .map_err(|e| CreateUndoFailure::Keep(format!("Cannot undo: {}", e)))?;
    }

    Ok(())
}

#[tauri::command]
pub async fn undo_action() -> Result<UndoRedoState, String> {
    tokio::task::spawn_blocking(undo_action_sync)
        .await
        .map_err(|e| e.to_string())?
}

fn undo_action_sync() -> Result<UndoRedoState, String> {
    // Keep the undo stack and filesystem mutations in one ordering domain;
    // ordinary IPC mutations acquire this lock before pushing actions.
    let _mutation_lock = crate::file_operations::mutation_lock()?;
    let action = pop_undo_action()?.ok_or("Nothing to undo")?;

    match action {
        UndoAction::Copy(mut data) => {
            if let Err(error) = execute_copy_undo(&mut data) {
                push_undo_action(UndoAction::Copy(data), false)?;
                return Err(error);
            }
            push_redo_action(UndoAction::Copy(data))?;
        }
        UndoAction::Rename(data) => {
            if let Err(err) = execute_rename_action(&data.new_path, &data.old_path, "undo") {
                push_undo_action(UndoAction::Rename(data), false)?;
                return Err(err);
            }
            push_redo_action(UndoAction::Rename(data))?;
        }
        UndoAction::Move(data) => {
            execute_move_undo(data.clone())?;
            push_redo_action(UndoAction::Move(data))?;
        }
        UndoAction::Create(data) => match execute_create_undo(&data) {
            Ok(_) => {
                push_redo_action(UndoAction::Create(data))?;
            }
            Err(CreateUndoFailure::Keep(err)) => {
                push_undo_action(UndoAction::Create(data), false)?;
                return Err(err);
            }
            Err(CreateUndoFailure::Drop(err)) => {
                return Err(err);
            }
        },
        UndoAction::BatchRename(data) => {
            let paths = match canonical_batch_rename_paths(&data) {
                Ok(paths) => paths,
                Err(error) => {
                    push_undo_action(UndoAction::BatchRename(data), false)?;
                    return Err(error);
                }
            };
            let reversed = paths
                .into_iter()
                .map(|(old, new)| (new, old))
                .collect::<Vec<_>>();
            if let Err(error) = crate::file_operations::rename_batch_transaction(&reversed) {
                push_undo_action(UndoAction::BatchRename(data), false)?;
                return Err(error);
            }
            push_redo_action(UndoAction::BatchRename(data))?;
        }
        UndoAction::Trash(_) => {
            return Err(
                "Cannot undo: Items sent to trash must be restored from the system trash"
                    .to_string(),
            );
        }
    }

    get_state()
}

#[tauri::command]
pub async fn redo_action() -> Result<UndoRedoState, String> {
    tokio::task::spawn_blocking(redo_action_sync)
        .await
        .map_err(|e| e.to_string())?
}

fn redo_action_sync() -> Result<UndoRedoState, String> {
    let _mutation_lock = crate::file_operations::mutation_lock()?;
    let action = pop_redo_action()?.ok_or("Nothing to redo")?;

    match action {
        UndoAction::Copy(mut data) => {
            if let Err(error) = execute_copy_redo(&mut data) {
                push_redo_action(UndoAction::Copy(data))?;
                return Err(error);
            }
            push_undo_action(UndoAction::Copy(data), false)?;
        }
        UndoAction::Rename(data) => {
            if let Err(err) = execute_rename_action(&data.old_path, &data.new_path, "redo") {
                push_redo_action(UndoAction::Rename(data))?;
                return Err(err);
            }
            push_undo_action(UndoAction::Rename(data), false)?;
        }
        UndoAction::Move(data) => match execute_move_redo(&data) {
            Ok(new_moved_paths) => {
                push_undo_action(
                    UndoAction::Move(MoveActionData {
                        source_paths: new_moved_paths,
                        original_paths: data.original_paths.clone(),
                        original_parent: data.original_parent.clone(),
                        dest_path: data.dest_path.clone(),
                        item_fingerprints: data.item_fingerprints.clone(),
                        overwrite_backups: data.overwrite_backups.clone(),
                        recovery_record_id: data.recovery_record_id.clone(),
                    }),
                    false,
                )?;
            }
            Err(err) => {
                return Err(err);
            }
        },
        UndoAction::Create(data) => {
            let item_path = match canonical_entry_path(&PathBuf::from(&data.path), "Target") {
                Ok(path) => path,
                Err(error) => {
                    push_redo_action(UndoAction::Create(data))?;
                    return Err(error);
                }
            };
            if path_entry_exists(&item_path) {
                push_redo_action(UndoAction::Create(data))?;
                return Err(
                    "Cannot redo: A file or folder already exists at this location".to_string(),
                );
            }

            let create_result = if data.is_directory {
                fs::create_dir(&item_path)
            } else {
                // `create_new` makes the existence check and creation one
                // filesystem operation. A plain write could follow a
                // symlink swapped in between those two steps.
                fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(&item_path)
                    .map(|_| ())
            };

            if let Err(err) = create_result {
                push_redo_action(UndoAction::Create(data))?;
                return Err(err.to_string());
            }

            push_undo_action(UndoAction::Create(data), false)?;
        }
        UndoAction::BatchRename(data) => {
            let paths = match canonical_batch_rename_paths(&data) {
                Ok(paths) => paths,
                Err(error) => {
                    push_redo_action(UndoAction::BatchRename(data))?;
                    return Err(error);
                }
            };
            if let Err(error) = crate::file_operations::rename_batch_transaction(&paths) {
                push_redo_action(UndoAction::BatchRename(data))?;
                return Err(error);
            }
            push_undo_action(UndoAction::BatchRename(data), false)?;
        }
        UndoAction::Trash(_) => {
            return Err(
                "Cannot redo: Items sent to trash must be restored from the system trash"
                    .to_string(),
            );
        }
    }

    get_state()
}

#[tauri::command]
pub fn get_undo_redo_state() -> Result<UndoRedoState, String> {
    get_state()
}

#[cfg(test)]
mod tests {
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
        fs::write(&destination, b"edited").unwrap();
        assert!(undo_action_sync().is_err());
        assert_eq!(fs::read(&destination).unwrap(), b"edited");
        fs::write(&destination, b"original").unwrap();
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
            fingerprint: copy_fingerprint(&backup_path, &|| false).unwrap(),
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
        assert!(!backup_path.exists(), "discarding history releases its owned backup");
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
            fingerprint: copy_fingerprint(&backup_path, &|| false).unwrap(),
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
        assert_eq!(UNDO_STACK.lock().unwrap_or_else(|p| p.into_inner()).len(), 1);
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
            fingerprint: copy_fingerprint(&backup_path, &|| false).unwrap(),
        };
        let moved_fingerprint = content_fingerprint(&destination, &|| false).unwrap();
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
        let copy: UndoAction = serde_json::from_str(
            r#"{"type":"copy","data":{"entries":[]}}"#,
        )
        .unwrap();
        let moved: UndoAction = serde_json::from_str(
            r#"{"type":"move","data":{"sourcePaths":[],"destPath":"/tmp"}}"#,
        )
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

        let result =
            execute_move_undo_with(action, &mut |source, target| move_path(source, target));

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
}
