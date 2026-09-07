use serde::{Deserialize, Serialize};
use std::collections::HashSet;
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
    retained: Option<Arc<tempfile::TempDir>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CopyActionData {
    pub entries: Vec<CopyEntry>,
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
        undo.clear();
    }
    if let Ok(mut redo) = REDO_STACK.try_lock() {
        redo.clear();
    }
}

fn cap_stack(stack: &mut Vec<UndoAction>) {
    if stack.len() > MAX_UNDO_STACK_SIZE {
        let overflow = stack.len() - MAX_UNDO_STACK_SIZE;
        stack.drain(0..overflow);
    }
}

fn push_undo_action(action: UndoAction, clear_redo: bool) -> Result<(), String> {
    {
        let mut undo = UNDO_STACK.lock().map_err(|e| e.to_string())?;
        undo.push(action);
        cap_stack(&mut undo);
    }
    if clear_redo {
        let mut redo = REDO_STACK.lock().map_err(|e| e.to_string())?;
        redo.clear();
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
fn copy_fingerprint(path: &Path, cancelled: &impl Fn() -> bool) -> Result<String, String> {
    fn visit(
        path: &Path,
        hash: &mut blake3::Hasher,
        depth: usize,
        cancelled: &impl Fn() -> bool,
    ) -> Result<(), String> {
        if cancelled() {
            return Err("Operation cancelled".to_string());
        }
        use std::io::Read;
        if depth > 256 {
            return Err("Copy tree exceeds undo depth limit".to_string());
        }
        let metadata = fs::symlink_metadata(path).map_err(|error| error.to_string())?;
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
                visit(&entry.path(), hash, depth + 1, cancelled)?;
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
                || after.modified().ok() != metadata.modified().ok()
            {
                return Err("Copy changed while recording undo".to_string());
            }
        }
        Ok(())
    }
    let mut hash = blake3::Hasher::new();
    visit(path, &mut hash, 0, cancelled)?;
    Ok(hash.finalize().to_hex().to_string())
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
    push_undo_action(UndoAction::Copy(CopyActionData { entries }), true)
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

fn verify_copy(path: &Path, expected: &str) -> Result<(), String> {
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
    let mut workspaces = Vec::new();
    for entry in &data.entries {
        let destination = canonical_entry_path(Path::new(&entry.dest_path), "Copy")?;
        verify_copy(&destination, &entry.fingerprint)?;
        let workspace = tempfile::Builder::new()
            .prefix(".iyeris-undo-")
            .tempdir_in(
                destination
                    .parent()
                    .ok_or("Copy destination has no parent")?,
            )
            .map_err(|error| error.to_string())?;
        paths.push((destination, workspace.path().join("content")));
        workspaces.push(workspace);
    }
    let result = crate::file_operations::rename_batch_transaction(&paths).and_then(|()| {
        for (entry, (_, retained)) in data.entries.iter().zip(&paths) {
            verify_copy(retained, &entry.fingerprint)?;
        }
        Ok(())
    });
    if let Err(error) = result {
        let recovery_paths = paths
            .iter()
            .filter(|(_, retained)| path_entry_exists(retained))
            .map(|(destination, retained)| (retained.clone(), destination.clone()))
            .collect::<Vec<_>>();
        let recovery = crate::file_operations::rename_batch_transaction(&recovery_paths);
        // A failed recovery must never let TempDir delete the only surviving copy.
        let retained = workspaces
            .into_iter()
            .filter_map(|workspace| {
                if workspace.path().join("content").symlink_metadata().is_ok() {
                    Some(workspace.keep().display().to_string())
                } else {
                    None
                }
            })
            .collect::<Vec<_>>();
        return Err(format!(
            "{}; recovery: {:?}; retained copies: {}",
            error,
            recovery.err(),
            retained.join(", ")
        ));
    }
    for (entry, workspace) in data.entries.iter_mut().zip(workspaces) {
        entry.retained = Some(Arc::new(workspace));
    }
    Ok(())
}

fn execute_copy_redo(data: &mut CopyActionData) -> Result<(), String> {
    let mut paths = Vec::new();
    for entry in &data.entries {
        let retained = entry
            .retained
            .as_ref()
            .ok_or("Copy redo data is unavailable")?
            .path()
            .join("content");
        verify_copy(&retained, &entry.fingerprint)?;
        let destination = canonical_entry_path(Path::new(&entry.dest_path), "Copy")?;
        if path_entry_exists(&destination) {
            return Err(format!(
                "Cannot redo copy: destination occupied at {}",
                destination.display()
            ));
        }
        paths.push((retained, destination));
    }
    crate::file_operations::rename_batch_transaction(&paths)?;
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
        UndoAction::Copy(data) => data
            .entries
            .iter()
            .any(|entry| paths.contains(&entry.dest_path)),
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
    let mut undo = UNDO_STACK.lock().map_err(|e| e.to_string())?;
    let mut redo = REDO_STACK.lock().map_err(|e| e.to_string())?;

    let mut paths_to_remove = HashSet::new();
    paths_to_remove.insert(item_path.to_string());

    expand_related_paths(&undo, &mut paths_to_remove);
    expand_related_paths(&redo, &mut paths_to_remove);

    undo.retain(|action| !action_contains_path(action, &paths_to_remove));
    redo.retain(|action| !action_contains_path(action, &paths_to_remove));

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

fn execute_move_undo(action: MoveActionData) -> Result<(), String> {
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

    for target in &targets {
        if path_entry_exists(target) {
            push_undo_action(UndoAction::Move(action), false)?;
            return Err("Cannot undo: A file already exists at the original location".to_string());
        }
    }

    let aligned_original_paths = action
        .original_paths
        .as_ref()
        .filter(|paths| paths.len() == action.source_paths.len())
        .cloned();

    for index in 0..action.source_paths.len() {
        let source = sources[index].clone();
        let target = targets[index].clone();
        if let Err(err) = move_path(&source, &target) {
            // Rollback items already successfully moved (0..index)
            for i in (0..index).rev() {
                let _ = move_path(&targets[i], &sources[i]);
            }
            let remaining_action = if index > 0 {
                UndoAction::Move(MoveActionData {
                    source_paths: sources[index..]
                        .iter()
                        .map(|path| path.to_string_lossy().to_string())
                        .collect(),
                    original_paths: aligned_original_paths
                        .as_ref()
                        .map(|paths| paths[index..].to_vec()),
                    original_parent: action.original_parent.clone(),
                    dest_path: action.dest_path.clone(),
                })
            } else {
                UndoAction::Move(action)
            };
            push_undo_action(remaining_action, false)?;
            return Err(format!("Partial undo failed: {}", err));
        }
    }

    Ok(())
}

fn execute_move_redo(action: &MoveActionData) -> Result<Vec<String>, String> {
    let mut source_target_pairs: Vec<(PathBuf, PathBuf)> = Vec::new();

    if let Some(original_paths) = &action.original_paths {
        if !original_paths.is_empty() {
            source_target_pairs.extend(original_paths.iter().map(|source| {
                (
                    PathBuf::from(source),
                    Path::new(&action.dest_path).join(to_file_name(source)),
                )
            }));
        } else if let Some(original_parent) = &action.original_parent {
            source_target_pairs.extend(action.source_paths.iter().map(|source| {
                let file_name = to_file_name(source);
                (
                    Path::new(original_parent).join(&file_name),
                    Path::new(&action.dest_path).join(file_name),
                )
            }));
        } else {
            return Err("Cannot redo: Original parent path not available".to_string());
        }
    } else if let Some(original_parent) = &action.original_parent {
        source_target_pairs.extend(action.source_paths.iter().map(|source| {
            let file_name = to_file_name(source);
            (
                Path::new(original_parent).join(&file_name),
                Path::new(&action.dest_path).join(file_name),
            )
        }));
    } else {
        return Err("Cannot redo: Original parent path not available".to_string());
    }

    source_target_pairs = source_target_pairs
        .into_iter()
        .map(|(source, target)| {
            Ok::<_, String>((
                canonical_entry_path(&source, "Original item")?,
                canonical_entry_path(&target, "Redo target")?,
            ))
        })
        .collect::<Result<_, _>>()?;

    // Pre-check all sources and targets before any moves to avoid partial state
    for (source, target) in &source_target_pairs {
        if !path_entry_exists(source) {
            return Err("Cannot redo: File not found at original location".to_string());
        }
        if path_entry_exists(target) {
            return Err("Cannot redo: A file already exists at the target location".to_string());
        }
    }

    let mut new_moved_paths = Vec::new();
    for (index, (source, target)) in source_target_pairs.iter().enumerate() {
        if let Err(err) = move_path(source, target) {
            // Rollback items already successfully moved (0..index)
            for j in (0..index).rev() {
                let _ = move_path(&source_target_pairs[j].1, &source_target_pairs[j].0);
            }
            return Err(format!("Partial redo failed: {}", err));
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
                    }),
                    false,
                )?;
            }
            Err(err) => {
                push_redo_action(UndoAction::Move(data))?;
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
