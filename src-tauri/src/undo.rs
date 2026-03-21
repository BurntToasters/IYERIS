use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

const MAX_UNDO_STACK_SIZE: usize = 50;
const CREATED_TIME_TOLERANCE_MS: f64 = 2000.0;

static UNDO_STACK: LazyLock<Mutex<Vec<UndoAction>>> = LazyLock::new(|| Mutex::new(Vec::new()));
static REDO_STACK: LazyLock<Mutex<Vec<UndoAction>>> = LazyLock::new(|| Mutex::new(Vec::new()));

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
            UndoAction::Rename(data) => {
                if paths_to_remove.contains(&data.old_path) || paths_to_remove.contains(&data.new_path)
                {
                    paths_to_remove.insert(data.old_path.clone());
                    paths_to_remove.insert(data.new_path.clone());
                }
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

#[allow(dead_code)]
pub fn clear_undo_redo_for_path(item_path: &str) -> Result<(), String> {
    clear_undo_stack_for_path(item_path)
}

fn get_state() -> Result<UndoRedoState, String> {
    let can_undo = !UNDO_STACK.lock().map_err(|e| e.to_string())?.is_empty();
    let can_redo = !REDO_STACK.lock().map_err(|e| e.to_string())?.is_empty();
    Ok(UndoRedoState { can_undo, can_redo })
}

fn copy_dir_recursive(source: &Path, dest: &Path) -> Result<(), String> {
    fs::create_dir_all(dest).map_err(|e| format!("Failed to create directory: {}", e))?;
    for entry in fs::read_dir(source).map_err(|e| e.to_string())?.flatten() {
        let entry_path = entry.path();
        let target = dest.join(entry.file_name());
        if entry_path.is_dir() {
            copy_dir_recursive(&entry_path, &target)?;
        } else {
            fs::copy(&entry_path, &target).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

fn is_cross_device_error(err: &std::io::Error) -> bool {
    match err.raw_os_error() {
        Some(code) => code == 18 || code == 17,
        None => false,
    }
}

fn move_path(source: &Path, dest: &Path) -> Result<(), String> {
    match fs::rename(source, dest) {
        Ok(_) => return Ok(()),
        Err(err) if !is_cross_device_error(&err) => return Err(err.to_string()),
        Err(_) => {}
    }

    let source_meta = fs::metadata(source).map_err(|e| e.to_string())?;
    if source_meta.is_dir() {
        copy_dir_recursive(source, dest)?;
        let dest_meta = fs::metadata(dest).map_err(|e| e.to_string())?;
        if !dest_meta.is_dir() {
            return Err("Cross-device copy verification failed".to_string());
        }
        fs::remove_dir_all(source).map_err(|e| e.to_string())?;
    } else {
        fs::copy(source, dest).map_err(|e| e.to_string())?;
        let source_size = fs::metadata(source).map_err(|e| e.to_string())?.len();
        let dest_size = fs::metadata(dest).map_err(|e| e.to_string())?.len();
        if source_size != dest_size {
            let _ = fs::remove_file(dest);
            return Err("Cross-device copy verification failed: size mismatch".to_string());
        }
        fs::remove_file(source).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn execute_rename_action(from_path: &str, to_path: &str, direction: &str) -> Result<(), String> {
    let from = match crate::validate_existing_path(from_path, "Item") {
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
    if to.exists() {
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

    for source in &action.source_paths {
        if !Path::new(source).exists() {
            push_undo_action(UndoAction::Move(action), false)?;
            return Err("Cannot undo: One or more files no longer exist".to_string());
        }
    }

    for target in &targets {
        if Path::new(target).exists() {
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
        let source = PathBuf::from(&action.source_paths[index]);
        let target = PathBuf::from(&targets[index]);
        if let Err(err) = move_path(&source, &target) {
            let remaining_action = if index > 0 {
                UndoAction::Move(MoveActionData {
                    source_paths: action.source_paths[index..].to_vec(),
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

    let mut new_moved_paths = Vec::new();
    for (source, target) in source_target_pairs {
        if !source.exists() {
            return Err("Cannot redo: File not found at original location".to_string());
        }
        if target.exists() {
            return Err("Cannot redo: A file already exists at the target location".to_string());
        }
        move_path(&source, &target)?;
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
    if !item_path.exists() {
        return Err(CreateUndoFailure::Drop(
            "Cannot undo: File no longer exists".to_string(),
        ));
    }

    let metadata = fs::metadata(&item_path)
        .map_err(|e| CreateUndoFailure::Keep(format!("Cannot undo: {}", e)))?;

    if let (Some(created_at), Some(current_created_at)) = (action.created_at_ms, metadata_time_ms(&metadata))
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
    let action = pop_undo_action()?.ok_or("Nothing to undo")?;

    match action {
        UndoAction::Rename(data) => {
            if let Err(err) = execute_rename_action(&data.new_path, &data.old_path, "undo") {
                push_undo_action(UndoAction::Rename(data), false)?;
                return Err(err);
            }
            push_redo_action(UndoAction::Rename(data))?;
        }
        UndoAction::Move(data) => {
            if let Err(err) = execute_move_undo(data.clone()) {
                return Err(err);
            }
            push_redo_action(UndoAction::Move(data))?;
        }
        UndoAction::Create(data) => {
            match execute_create_undo(&data) {
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
            }
        }
        UndoAction::BatchRename(data) => {
            for rename in data.renames.iter().rev() {
                if let Err(err) = move_path(
                    &PathBuf::from(&rename.new_path),
                    &PathBuf::from(&rename.old_path),
                ) {
                    push_undo_action(UndoAction::BatchRename(data), false)?;
                    return Err(err);
                }
            }
            push_redo_action(UndoAction::BatchRename(data))?;
        }
        UndoAction::Trash(data) => {
            push_undo_action(UndoAction::Trash(data), false)?;
            return Err("Undo for trash actions is not implemented".to_string());
        }
    }

    get_state()
}

#[tauri::command]
pub async fn redo_action() -> Result<UndoRedoState, String> {
    let action = pop_redo_action()?.ok_or("Nothing to redo")?;

    match action {
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
            let item_path = PathBuf::from(&data.path);
            if item_path.exists() {
                push_redo_action(UndoAction::Create(data))?;
                return Err(
                    "Cannot redo: A file or folder already exists at this location".to_string(),
                );
            }

            let create_result = if data.is_directory {
                fs::create_dir(&item_path)
            } else {
                fs::write(&item_path, "")
            };

            if let Err(err) = create_result {
                push_redo_action(UndoAction::Create(data))?;
                return Err(err.to_string());
            }

            push_undo_action(UndoAction::Create(data), false)?;
        }
        UndoAction::BatchRename(data) => {
            for rename in &data.renames {
                if let Err(err) =
                    move_path(&PathBuf::from(&rename.old_path), &PathBuf::from(&rename.new_path))
                {
                    push_redo_action(UndoAction::BatchRename(data))?;
                    return Err(err);
                }
            }
            push_undo_action(UndoAction::BatchRename(data), false)?;
        }
        UndoAction::Trash(data) => {
            push_redo_action(UndoAction::Trash(data))?;
            return Err("Redo for trash actions is not implemented".to_string());
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
        UNDO_STACK.lock().unwrap().clear();
        REDO_STACK.lock().unwrap().clear();
    }

    #[test]
    fn push_undo_action_caps_at_max_size() {
        let _guard = TEST_LOCK.lock().unwrap();
        clear_stacks();
        for i in 0..(MAX_UNDO_STACK_SIZE + 10) {
            let path = PathBuf::from(format!("C:/tmp/test-{}", i));
            push_create_action(&path, false).unwrap();
        }
        let undo_len = UNDO_STACK.lock().unwrap().len();
        let redo_len = REDO_STACK.lock().unwrap().len();
        assert_eq!(undo_len, MAX_UNDO_STACK_SIZE);
        assert_eq!(redo_len, 0);
    }

    #[test]
    fn clear_path_prunes_related_rename_chain() {
        let _guard = TEST_LOCK.lock().unwrap();
        clear_stacks();
        let a = PathBuf::from("C:/tmp/a.txt");
        let b = PathBuf::from("C:/tmp/b.txt");
        let c = PathBuf::from("C:/tmp/c.txt");
        push_rename_action(&a, &b).unwrap();
        push_rename_action(&b, &c).unwrap();
        clear_undo_stack_for_path("C:/tmp/c.txt").unwrap();
        let undo_len = UNDO_STACK.lock().unwrap().len();
        assert_eq!(undo_len, 0);
    }
}
