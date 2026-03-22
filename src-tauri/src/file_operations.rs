use crate::undo;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::Emitter;

static ACTIVE_CHECKSUMS: std::sync::LazyLock<Mutex<HashSet<String>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashSet::new()));

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemProperties {
    pub name: String,
    pub path: String,
    pub size: u64,
    pub is_directory: bool,
    pub is_symlink: bool,
    pub symlink_target: Option<String>,
    pub is_shortcut: Option<bool>,
    pub shortcut_target: Option<String>,
    pub is_hidden: bool,
    pub readonly: bool,
    pub owner: Option<String>,
    pub group: Option<String>,
    pub is_hidden_attr: Option<bool>,
    pub is_system_attr: Option<bool>,
    pub mac_tags: Option<Vec<String>>,
    pub created: f64,
    pub modified: f64,
    pub accessed: f64,
    pub extension: String,
    #[cfg(unix)]
    pub permissions: u32,
    #[cfg(not(unix))]
    pub permissions: u32,
}

enum OpenTarget {
    FilePath(PathBuf),
    External(String),
}

pub(crate) fn validate_child_name(raw_name: &str, label: &str) -> Result<String, String> {
    let name = raw_name.trim();
    if name.is_empty() {
        return Err(format!("{} is required", label));
    }
    if name == "." || name == ".." {
        return Err(format!("{} cannot be '.' or '..'", label));
    }
    if name.contains('/') || name.contains('\\') || name.contains('\0') {
        return Err(format!(
            "{} cannot contain path separators or null bytes",
            label
        ));
    }

    #[cfg(target_os = "windows")]
    {
        let invalid_chars = ['<', '>', ':', '"', '|', '?', '*'];
        if name.chars().any(|ch| invalid_chars.contains(&ch)) {
            return Err(format!("{} contains invalid Windows characters", label));
        }
        if name.ends_with('.') {
            return Err(format!("{} cannot end with a period on Windows", label));
        }
        let base_upper = name
            .split('.')
            .next()
            .unwrap_or_default()
            .to_ascii_uppercase();
        let reserved = [
            "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7",
            "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8",
            "LPT9",
        ];
        if reserved.contains(&base_upper.as_str()) {
            return Err(format!("{} uses a reserved Windows filename", label));
        }
    }

    Ok(name.to_string())
}

fn parse_file_uri_path(raw_value: &str) -> Result<PathBuf, String> {
    let normalized =
        decode_file_uri_path(raw_value).ok_or_else(|| "Invalid file URI".to_string())?;
    crate::validate_existing_path(&normalized, "File URI")
}

fn parse_open_target(file_path: &str) -> Result<OpenTarget, String> {
    let value = file_path.trim();
    if value.is_empty() {
        return Err("File path is required".to_string());
    }

    let value_lower = value.to_ascii_lowercase();
    if value_lower.starts_with("http://")
        || value_lower.starts_with("https://")
        || value_lower.starts_with("mailto:")
    {
        return Ok(OpenTarget::External(value.to_string()));
    }
    if value_lower.starts_with("file://") {
        return Ok(OpenTarget::FilePath(parse_file_uri_path(value)?));
    }
    if value.contains("://") {
        return Err("Unsupported URL scheme".to_string());
    }

    #[cfg(target_os = "windows")]
    {
        let mut chars = value.chars();
        if let (Some(first), Some(':')) = (chars.next(), chars.next()) {
            if first.is_ascii_alphabetic() {
                let path = crate::validate_existing_path(value, "File")?;
                return Ok(OpenTarget::FilePath(path));
            }
        }
    }

    Ok(OpenTarget::FilePath(crate::validate_existing_path(
        value, "File",
    )?))
}

#[tauri::command]
pub async fn open_file(file_path: String) -> Result<(), String> {
    log::debug!("[FileOps] open_file: {}", file_path);
    match parse_open_target(&file_path)? {
        OpenTarget::FilePath(path) => {
            open::that(&path).map_err(|e| format!("Failed to open file: {}", e))
        }
        OpenTarget::External(url) => {
            open::that(url).map_err(|e| format!("Failed to open URL: {}", e))
        }
    }
}

#[tauri::command]
pub async fn create_folder(parent_path: String, folder_name: String) -> Result<String, String> {
    log::debug!("[FileOps] create_folder: {}/{}", parent_path, folder_name);
    let parent = crate::validate_existing_path(&parent_path, "Parent")?;
    let folder_name = validate_child_name(&folder_name, "Folder name")?;
    let new_path = parent.join(&folder_name);
    fs::create_dir(&new_path).map_err(|e| format!("Failed to create folder: {}", e))?;
    undo::push_create_action(&new_path, true)?;
    Ok(new_path.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn create_file(parent_path: String, file_name: String) -> Result<String, String> {
    log::debug!("[FileOps] create_file: {}/{}", parent_path, file_name);
    let parent = crate::validate_existing_path(&parent_path, "Parent")?;
    let file_name = validate_child_name(&file_name, "File name")?;
    let new_path = parent.join(&file_name);
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&new_path)
        .map_err(|e| format!("Failed to create file: {}", e))?;
    undo::push_create_action(&new_path, false)?;
    Ok(new_path.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn delete_item(item_path: String) -> Result<(), String> {
    log::debug!("[FileOps] delete_item: {}", item_path);
    let path = crate::validate_existing_path(&item_path, "Item")?;
    if path.parent().is_none() {
        return Err("Cannot delete a root directory".to_string());
    }
    let result = if path.is_dir() {
        fs::remove_dir_all(&path).map_err(|e| format!("Failed to delete directory: {}", e))
    } else {
        fs::remove_file(&path).map_err(|e| format!("Failed to delete file: {}", e))
    };
    if result.is_ok() {
        undo::clear_undo_redo_for_path(&path.to_string_lossy())?;
    }
    result
}

#[tauri::command]
pub async fn trash_item(item_path: String) -> Result<(), String> {
    log::debug!("[FileOps] trash_item: {}", item_path);
    let path = crate::validate_existing_path(&item_path, "Item")?;
    if path.parent().is_none() {
        return Err("Cannot trash a root directory".to_string());
    }
    let result = trash::delete(&path).map_err(|e| format!("Failed to trash item: {}", e));
    if result.is_ok() {
        undo::clear_undo_redo_for_path(&path.to_string_lossy())?;
    }
    result
}

#[tauri::command]
pub async fn open_trash() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        open::that(std::path::Path::new(&format!(
            "{}/.Trash",
            std::env::var("HOME").unwrap_or_default()
        )))
        .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "windows")]
    {
        open::that("shell:RecycleBinFolder").map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "linux")]
    {
        let trash_path = format!(
            "{}/.local/share/Trash",
            std::env::var("HOME").unwrap_or_default()
        );
        open::that(&trash_path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn rename_item(old_path: String, new_name: String) -> Result<String, String> {
    log::debug!("[FileOps] rename_item: {} -> {}", old_path, new_name);
    let path = crate::validate_existing_path(&old_path, "Item")?;
    let new_name = validate_child_name(&new_name, "New name")?;
    let new_path = path
        .parent()
        .ok_or("Cannot determine parent directory")?
        .join(&new_name);
    if path_entry_exists(&new_path) {
        return Err("A file or folder with that name already exists".to_string());
    }
    fs::rename(&path, &new_path).map_err(|e| {
        if e.kind() == std::io::ErrorKind::AlreadyExists {
            "A file or folder with that name already exists".to_string()
        } else {
            format!("Failed to rename: {}", e)
        }
    })?;
    undo::push_rename_action(&path, &new_path)?;
    Ok(new_path.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn copy_items(
    source_paths: Vec<String>,
    dest_path: String,
    conflict_behavior: Option<String>,
    conflict_resolutions: Option<HashMap<String, String>>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    log::debug!("[FileOps] copy_items: {} items -> {}", source_paths.len(), dest_path);
    let dest = crate::validate_existing_path(&dest_path, "Destination")?;
    let behavior = conflict_behavior.unwrap_or_else(|| "ask".to_string());
    let resolutions = conflict_resolutions.unwrap_or_default();
    let planned = plan_file_operations(&source_paths, &dest, &behavior, "copy", &resolutions)?;
    let total = planned.len();
    let mut copied_paths: Vec<PathBuf> = Vec::new();
    let mut backups: HashMap<String, OverwriteBackup> = HashMap::new();

    let operation = (|| -> Result<(), String> {
        for (index, item) in planned.iter().enumerate() {
            ensure_overwrite_backup(&mut backups, item)?;

            let source_meta = fs::symlink_metadata(&item.source_path).map_err(|e| e.to_string())?;
            if source_meta.file_type().is_symlink() {
                copy_symlink_path(&item.source_path, &item.dest_path)?;
            } else if source_meta.is_dir() {
                copy_dir_recursive(&item.source_path, &item.dest_path)?;
            } else {
                fs::copy(&item.source_path, &item.dest_path).map_err(|e| {
                    format!("Failed to copy {}: {}", item.item_name, e)
                })?;
            }
            copied_paths.push(item.dest_path.clone());

            if total > 1 {
                let _ = app.emit(
                    "file-operation-progress",
                    serde_json::json!({
                        "operation": "copy",
                        "current": index + 1,
                        "total": total,
                        "name": item.item_name,
                    }),
                );
            }
        }
        Ok(())
    })();

    if let Err(error) = operation {
        remove_paths_reversed(&copied_paths);
        restore_overwrite_backups(&backups, false);
        cleanup_backups(&backups);
        return Err(error);
    }

    cleanup_backups(&backups);

    for item in &planned {
        let _ = undo::push_create_action(&item.dest_path, item.is_directory);
    }

    Ok(())
}

fn copy_dir_recursive(src: &Path, dest: &Path) -> Result<(), String> {
    fs::create_dir_all(dest).map_err(|e| format!("Failed to create directory: {}", e))?;
    for entry_result in fs::read_dir(src).map_err(|e| e.to_string())? {
        let entry = entry_result.map_err(|e| e.to_string())?;
        let entry_path = entry.path();
        let target = dest.join(entry.file_name());
        let meta = fs::symlink_metadata(&entry_path).map_err(|e| e.to_string())?;
        if meta.file_type().is_symlink() {
            #[cfg(unix)]
            {
                let link_target = fs::read_link(&entry_path).map_err(|e| e.to_string())?;
                std::os::unix::fs::symlink(&link_target, &target)
                    .map_err(|e| format!("Failed to create symlink: {}", e))?;
            }
            #[cfg(windows)]
            {
                let link_target = fs::read_link(&entry_path).map_err(|e| e.to_string())?;
                let is_dir_link = fs::symlink_metadata(&entry_path)
                    .map(|linked_meta| linked_meta.is_dir())
                    .unwrap_or(false);
                if is_dir_link {
                    std::os::windows::fs::symlink_dir(&link_target, &target)
                        .map_err(|e| format!("Failed to create symlink: {}", e))?;
                } else {
                    std::os::windows::fs::symlink_file(&link_target, &target)
                        .map_err(|e| format!("Failed to create symlink: {}", e))?;
                }
            }
        } else if meta.is_dir() {
            copy_dir_recursive(&entry_path, &target)?;
        } else {
            fs::copy(&entry_path, &target).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

fn copy_symlink_path(source: &Path, target: &Path) -> Result<(), String> {
    let link_target = fs::read_link(source).map_err(|e| e.to_string())?;

    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(&link_target, target)
            .map_err(|e| format!("Failed to create symlink: {}", e))
    }

    #[cfg(windows)]
    {
        let source_meta = fs::symlink_metadata(source).map_err(|e| e.to_string())?;
        let is_dir_link = source_meta.is_dir() || fs::metadata(source)
            .map(|m| m.is_dir())
            .unwrap_or(false);
        if is_dir_link {
            std::os::windows::fs::symlink_dir(&link_target, target)
                .map_err(|e| format!("Failed to create symlink: {}", e))
        } else {
            std::os::windows::fs::symlink_file(&link_target, target)
                .map_err(|e| format!("Failed to create symlink: {}", e))
        }
    }
}

fn remove_symlink_path(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        fs::remove_file(path).map_err(|e| format!("Failed to remove symlink: {}", e))
    }

    #[cfg(windows)]
    {
        let is_dir_link = fs::metadata(path)
            .map(|linked_meta| linked_meta.is_dir())
            .unwrap_or(false);
        if is_dir_link {
            fs::remove_dir(path)
                .or_else(|_| fs::remove_file(path))
                .map_err(|e| format!("Failed to remove symlink: {}", e))
        } else {
            fs::remove_file(path)
                .or_else(|_| fs::remove_dir(path))
                .map_err(|e| format!("Failed to remove symlink: {}", e))
        }
    }
}

#[tauri::command]
pub async fn move_items(
    source_paths: Vec<String>,
    dest_path: String,
    conflict_behavior: Option<String>,
    conflict_resolutions: Option<HashMap<String, String>>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    log::debug!("[FileOps] move_items: {} items -> {}", source_paths.len(), dest_path);
    let dest = crate::validate_existing_path(&dest_path, "Destination")?;
    let behavior = conflict_behavior.unwrap_or_else(|| "ask".to_string());
    let resolutions = conflict_resolutions.unwrap_or_default();
    let planned = plan_file_operations(&source_paths, &dest, &behavior, "move", &resolutions)?;
    let total = planned.len();
    let mut moved_paths: Vec<String> = Vec::new();
    let mut original_paths: Vec<String> = Vec::new();
    let mut completed_moves: Vec<CompletedMove> = Vec::new();
    let mut backups: HashMap<String, OverwriteBackup> = HashMap::new();

    let operation = (|| -> Result<(), String> {
        for (index, item) in planned.iter().enumerate() {
            ensure_overwrite_backup(&mut backups, item)?;
            move_path_with_fallback(&item.source_path, &item.dest_path)?;

            moved_paths.push(item.dest_path.to_string_lossy().to_string());
            original_paths.push(item.source_path.to_string_lossy().to_string());
            completed_moves.push(CompletedMove {
                source_path: item.source_path.clone(),
                dest_path: item.dest_path.clone(),
            });

            if total > 1 {
                let _ = app.emit(
                    "file-operation-progress",
                    serde_json::json!({
                        "operation": "move",
                        "current": index + 1,
                        "total": total,
                        "name": item.item_name,
                    }),
                );
            }
        }
        Ok(())
    })();

    if let Err(error) = operation {
        rollback_moves(&completed_moves);
        restore_overwrite_backups(&backups, true);
        cleanup_backups(&backups);
        return Err(error);
    }

    cleanup_backups(&backups);
    undo::push_move_action(moved_paths, original_paths, dest_path)?;
    Ok(())
}

fn remove_existing_path(path: &Path) -> Result<(), String> {
    let meta = match fs::symlink_metadata(path) {
        Ok(meta) => meta,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.to_string()),
    };
    if meta.file_type().is_symlink() {
        return remove_symlink_path(path);
    }
    if meta.is_dir() {
        fs::remove_dir_all(path).map_err(|e| format!("Failed to remove existing directory: {}", e))
    } else {
        fs::remove_file(path).map_err(|e| format!("Failed to remove existing file: {}", e))
    }
}

fn normalize_case_key(path: &Path) -> String {
    #[cfg(target_os = "windows")]
    {
        path.to_string_lossy().to_ascii_lowercase()
    }

    #[cfg(not(target_os = "windows"))]
    {
        path.to_string_lossy().to_string()
    }
}

fn path_entry_exists(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok()
}

fn create_renamed_target(dest: &Path, original_name: &str, reserved: &HashSet<String>) -> PathBuf {
    let (base, ext) = split_filename(original_name);
    for i in 2..10_000 {
        let candidate = match &ext {
            Some(ext) => format!("{} ({}).{}", base, i, ext),
            None => format!("{} ({})", base, i),
        };
        let target = dest.join(candidate);
        let key = normalize_case_key(&target);
        if !path_entry_exists(&target) && !reserved.contains(&key) {
            return target;
        }
    }
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    dest.join(format!("{} ({})", original_name, timestamp))
}

fn split_filename(name: &str) -> (String, Option<String>) {
    if let Some(dot_index) = name.rfind('.') {
        if dot_index > 0 && dot_index < name.len() - 1 {
            return (
                name[..dot_index].to_string(),
                Some(name[dot_index + 1..].to_string()),
            );
        }
    }
    (name.to_string(), None)
}

fn resolve_conflict_target(
    dest: &Path,
    original_name: &str,
    behavior: &str,
) -> Result<Option<(PathBuf, bool)>, String> {
    let target = dest.join(original_name);
    if !path_entry_exists(&target) {
        return Ok(Some((target, false)));
    }

    match behavior.to_ascii_lowercase().as_str() {
        "skip" => Ok(None),
        "overwrite" => Ok(Some((target, true))),
        "rename" | "ask" => Ok(Some((target, false))),
        _ => Ok(Some((target, false))),
    }
}

#[derive(Clone)]
struct PlannedFileOperation {
    source_path: PathBuf,
    dest_path: PathBuf,
    item_name: String,
    is_directory: bool,
    overwrite: bool,
}

#[derive(Clone)]
struct CompletedMove {
    source_path: PathBuf,
    dest_path: PathBuf,
}

#[derive(Clone)]
struct OverwriteBackup {
    dest_path: PathBuf,
    backup_path: PathBuf,
}

fn plan_file_operations(
    source_paths: &[String],
    dest: &Path,
    behavior: &str,
    operation: &str,
    conflict_resolutions: &HashMap<String, String>,
) -> Result<Vec<PlannedFileOperation>, String> {
    if source_paths.is_empty() {
        return Err("No source items provided".to_string());
    }

    let mut planned: Vec<PlannedFileOperation> = Vec::new();
    let mut reserved: HashSet<String> = HashSet::new();
    let dest_real = fs::canonicalize(dest).unwrap_or_else(|_| dest.to_path_buf());
    let behavior_normalized = behavior.to_ascii_lowercase();

    for source in source_paths {
        let src = crate::validate_existing_path(source, "Source")?;
        let metadata = fs::symlink_metadata(&src).map_err(|e| e.to_string())?;
        let item_name = src
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .ok_or("Invalid source path")?;

        let base_target = dest.join(&item_name);
        let base_key = normalize_case_key(&base_target);
        if reserved.contains(&base_key) {
            return Err(format!("Multiple items share the same name: \"{}\"", item_name));
        }

        if metadata.is_dir() {
            if let Ok(source_real) = fs::canonicalize(&src) {
                if dest_real == source_real || dest_real.starts_with(&source_real) {
                    return Err(format!(
                        "Cannot {} \"{}\" into itself or a subfolder",
                        operation, item_name
                    ));
                }
            }
        }

        let resolved = match resolve_conflict_target(dest, &item_name, behavior)? {
            None => continue,
            Some((target, overwrite)) => {
                if overwrite {
                    (target, overwrite)
                } else if path_entry_exists(&target) {
                    if behavior_normalized == "ask" {
                        match conflict_resolutions
                            .get(&item_name)
                            .map(|value| value.to_ascii_lowercase())
                            .as_deref()
                        {
                            Some("overwrite") => (target, true),
                            Some("rename") => (create_renamed_target(dest, &item_name, &reserved), false),
                            Some("skip") => continue,
                            Some("cancel") => return Err("Operation cancelled".to_string()),
                            Some(_) => {
                                return Err(format!(
                                    "Unsupported conflict resolution for \"{}\"",
                                    item_name
                                ))
                            }
                            None => return Err(format!("CONFLICT:{}", item_name)),
                        }
                    } else {
                        (create_renamed_target(dest, &item_name, &reserved), false)
                    }
                } else {
                    (target, false)
                }
            }
        };

        let source_key = normalize_case_key(&src);
        let destination_key = normalize_case_key(&resolved.0);
        if source_key == destination_key {
            return Err(format!("Cannot {} \"{}\" onto itself", operation, item_name));
        }
        if reserved.contains(&destination_key) {
            return Err(format!(
                "Multiple items resolve to the same destination: \"{}\"",
                resolved
                    .0
                    .file_name()
                    .map(|name| name.to_string_lossy().to_string())
                    .unwrap_or_default()
            ));
        }
        reserved.insert(destination_key);

        planned.push(PlannedFileOperation {
            source_path: src,
            dest_path: resolved.0,
            item_name,
            is_directory: metadata.is_dir(),
            overwrite: resolved.1,
        });
    }

    Ok(planned)
}

fn is_cross_device_error(err: &std::io::Error) -> bool {
    matches!(err.raw_os_error(), Some(17) | Some(18))
}

fn move_path_with_fallback(source: &Path, target: &Path) -> Result<(), String> {
    let source_meta = fs::symlink_metadata(source).map_err(|e| e.to_string())?;
    let is_symlink = source_meta.file_type().is_symlink();
    let is_directory = source_meta.is_dir();

    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create directory: {}", e))?;
    }
    match fs::rename(source, target) {
        Ok(_) => return Ok(()),
        Err(error) if !is_cross_device_error(&error) => {
            return Err(format!(
                "Failed to move {} to {}: {}",
                source.display(),
                target.display(),
                error
            ));
        }
        Err(_) => {}
    }

    if is_symlink {
        copy_symlink_path(source, target)?;
        if let Err(e) = remove_symlink_path(source) {
            let _ = remove_existing_path(target);
            return Err(format!("Failed to remove source symlink after cross-device move: {}", e));
        }
    } else if is_directory {
        copy_dir_recursive(source, target)?;
        if let Err(e) = fs::remove_dir_all(source) {
            let _ = fs::remove_dir_all(target);
            return Err(format!("Failed to remove source after cross-device move: {}", e));
        }
    } else {
        fs::copy(source, target).map_err(|e| e.to_string())?;
        if let Err(e) = fs::remove_file(source) {
            let _ = fs::remove_file(target);
            return Err(format!("Failed to remove source after cross-device move: {}", e));
        }
    }
    Ok(())
}

fn create_backup_path(dest_path: &Path) -> Result<PathBuf, String> {
    let parent = dest_path
        .parent()
        .ok_or("Cannot determine parent directory for backup path")?;
    let base = dest_path
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .ok_or("Cannot determine destination name for backup path")?;

    for attempt in 0..10 {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        let candidate = parent.join(format!(
            ".{}.iyeris-backup-{}-{}-{}",
            base,
            std::process::id(),
            timestamp,
            attempt
        ));
        if !path_entry_exists(&candidate) {
            return Ok(candidate);
        }
    }
    Err("Unable to create backup path".to_string())
}

fn ensure_overwrite_backup(
    backups: &mut HashMap<String, OverwriteBackup>,
    operation: &PlannedFileOperation,
) -> Result<(), String> {
    if !operation.overwrite {
        return Ok(());
    }

    let key = normalize_case_key(&operation.dest_path);
    if backups.contains_key(&key) || !path_entry_exists(&operation.dest_path) {
        return Ok(());
    }

    let backup_path = create_backup_path(&operation.dest_path)?;
    move_path_with_fallback(&operation.dest_path, &backup_path)?;
    backups.insert(
        key,
        OverwriteBackup {
            dest_path: operation.dest_path.clone(),
            backup_path,
        },
    );
    Ok(())
}

fn restore_overwrite_backups(
    backups: &HashMap<String, OverwriteBackup>,
    skip_if_destination_exists: bool,
) {
    for backup in backups.values() {
        if !path_entry_exists(&backup.backup_path) {
            continue;
        }
        if skip_if_destination_exists && path_entry_exists(&backup.dest_path) {
            continue;
        }
        if path_entry_exists(&backup.dest_path) {
            let _ = remove_existing_path(&backup.dest_path);
        }
        let _ = move_path_with_fallback(&backup.backup_path, &backup.dest_path);
    }
}

fn cleanup_backups(backups: &HashMap<String, OverwriteBackup>) {
    for backup in backups.values() {
        if path_entry_exists(&backup.backup_path) {
            let _ = remove_existing_path(&backup.backup_path);
        }
    }
}

fn remove_paths_reversed(paths: &[PathBuf]) {
    for path in paths.iter().rev() {
        let _ = remove_existing_path(path);
    }
}

fn rollback_moves(completed: &[CompletedMove]) {
    for item in completed.iter().rev() {
        let _ = move_path_with_fallback(&item.dest_path, &item.source_path);
    }
}

#[tauri::command]
pub async fn get_item_properties(item_path: String) -> Result<ItemProperties, String> {
    log::debug!("[FileOps] get_item_properties: {}", item_path);
    let path = crate::validate_existing_path(&item_path, "Item")?;
    let meta = fs::symlink_metadata(&path).map_err(|e| e.to_string())?;

    let to_ms = |t: std::io::Result<std::time::SystemTime>| {
        t.ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs_f64() * 1000.0)
            .unwrap_or(0.0)
    };

    #[cfg(unix)]
    let permissions = {
        use std::os::unix::fs::PermissionsExt;
        meta.permissions().mode()
    };
    #[cfg(not(unix))]
    let permissions = 0u32;

    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    let is_symlink = meta.file_type().is_symlink();
    let symlink_target = if is_symlink {
        fs::read_link(&path)
            .ok()
            .map(|target| target.to_string_lossy().to_string())
    } else {
        None
    };

    #[cfg(unix)]
    let (owner, group) = {
        use std::os::unix::fs::MetadataExt;
        (Some(meta.uid().to_string()), Some(meta.gid().to_string()))
    };
    #[cfg(not(unix))]
    let (owner, group): (Option<String>, Option<String>) = (None, None);

    #[cfg(target_os = "windows")]
    let (is_shortcut, shortcut_target) = {
        let shortcut = path
            .extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| ext.eq_ignore_ascii_case("lnk"))
            .unwrap_or(false);
        let target = if shortcut {
            let escaped = path.to_string_lossy().replace('\'', "''");
            let script = format!(
                "$s=(New-Object -ComObject WScript.Shell).CreateShortcut('{}'); if($s.TargetPath) {{ Write-Output $s.TargetPath }}",
                escaped
            );
            {
                let mut cmd = Command::new("powershell");
                cmd.args(["-NoProfile", "-Command", &script]);
                #[cfg(target_os = "windows")]
                {
                    use std::os::windows::process::CommandExt;
                    cmd.creation_flags(0x08000000);
                }
                cmd.output()
                    .ok()
                    .and_then(|o| {
                        if o.status.success() {
                            let t = String::from_utf8_lossy(&o.stdout).trim().to_string();
                            if t.is_empty() { None } else { Some(t) }
                        } else {
                            None
                        }
                    })
            }
        } else {
            None
        };
        (Some(shortcut), target)
    };
    #[cfg(not(target_os = "windows"))]
    let (is_shortcut, shortcut_target): (Option<bool>, Option<String>) = (None, None);

    #[cfg(target_os = "windows")]
    let (is_hidden_attr, is_system_attr) = {
        use std::os::windows::fs::MetadataExt;
        let attrs = meta.file_attributes();
        (Some(attrs & 0x2 != 0), Some(attrs & 0x4 != 0))
    };
    #[cfg(not(target_os = "windows"))]
    let (is_hidden_attr, is_system_attr): (Option<bool>, Option<bool>) = (None, None);

    Ok(ItemProperties {
        name: name.clone(),
        path: path.to_string_lossy().to_string(),
        size: meta.len(),
        is_directory: meta.is_dir(),
        is_symlink,
        symlink_target,
        is_shortcut,
        shortcut_target,
        is_hidden: name.starts_with('.'),
        readonly: meta.permissions().readonly(),
        owner,
        group,
        is_hidden_attr,
        is_system_attr,
        mac_tags: None,
        created: to_ms(meta.created()),
        modified: to_ms(meta.modified()),
        accessed: to_ms(meta.accessed()),
        extension: path
            .extension()
            .map(|e| e.to_string_lossy().to_string())
            .unwrap_or_default(),
        permissions,
    })
}

#[tauri::command]
pub async fn set_permissions(item_path: String, mode: u32) -> Result<(), String> {
    let path = crate::validate_existing_path(&item_path, "Item")?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let perms = fs::Permissions::from_mode(mode);
        fs::set_permissions(&path, perms).map_err(|e| e.to_string())?;
    }

    #[cfg(not(unix))]
    {
        let meta = fs::metadata(&path).map_err(|e| e.to_string())?;
        let mut perms = meta.permissions();
        perms.set_readonly(mode & 0o200 == 0);
        fs::set_permissions(&path, perms).map_err(|e| e.to_string())?;
    }

    Ok(())
}

#[tauri::command]
pub async fn set_attributes(item_path: String, attrs: serde_json::Value) -> Result<(), String> {
    let path = crate::validate_existing_path(&item_path, "Item")?;
    let read_only = attrs
        .get("readOnly")
        .and_then(|value| value.as_bool());
    let hidden = attrs.get("hidden").and_then(|value| value.as_bool());

    if let Some(is_read_only) = read_only {
        let mut perms = fs::metadata(&path)
            .map_err(|e| format!("Failed to read metadata: {}", e))?
            .permissions();
        perms.set_readonly(is_read_only);
        fs::set_permissions(&path, perms)
            .map_err(|e| format!("Failed to update readonly attribute: {}", e))?;
    }

    #[cfg(target_os = "windows")]
    if let Some(is_hidden) = hidden {
        let hidden_flag = if is_hidden { "+h" } else { "-h" };
        let path_str = path.to_string_lossy().to_string();
        let output = {
            let mut cmd = Command::new("attrib");
            cmd.args([hidden_flag, &path_str]);
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000);
            cmd.output()
        }
            .map_err(|e| format!("Failed to update hidden attribute: {}", e))?;
        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
        }
    }

    #[cfg(not(target_os = "windows"))]
    if hidden.is_some() {
        return Err("Hidden attribute updates are only supported on Windows.".to_string());
    }

    Ok(())
}

#[tauri::command]
pub async fn read_file_content(
    file_path: String,
    max_size: Option<u64>,
) -> Result<String, String> {
    let path = crate::validate_existing_path(&file_path, "File")?;
    let limit = max_size.unwrap_or(10 * 1024 * 1024);

    tokio::task::spawn_blocking(move || {
        let meta = fs::metadata(&path).map_err(|e| e.to_string())?;
        if meta.len() > limit {
            return Err(format!(
                "File too large: {} bytes (limit: {} bytes)",
                meta.len(),
                limit
            ));
        }
        let mut file = fs::File::open(&path).map_err(|e| e.to_string())?;
        let mut content = String::new();
        file.read_to_string(&mut content)
            .map_err(|e| format!("Failed to read file as text: {}", e))?;
        Ok(content)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn get_file_data_url(
    file_path: String,
    max_size: Option<u64>,
) -> Result<String, String> {
    let path = crate::validate_existing_path(&file_path, "File")?;
    let limit = max_size.unwrap_or(50 * 1024 * 1024);

    tokio::task::spawn_blocking(move || {
        let meta = fs::metadata(&path).map_err(|e| e.to_string())?;
        if meta.len() > limit {
            return Err("File too large for data URL".into());
        }
        let data = fs::read(&path).map_err(|e| e.to_string())?;
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_lowercase();
        let mime = match ext.as_str() {
            "png" => "image/png",
            "jpg" | "jpeg" => "image/jpeg",
            "gif" => "image/gif",
            "svg" => "image/svg+xml",
            "webp" => "image/webp",
            "bmp" => "image/bmp",
            "ico" => "image/x-icon",
            "pdf" => "application/pdf",
            _ => "application/octet-stream",
        };
        use std::io::Write;
        let mut buf = Vec::new();
        write!(buf, "data:{};base64,", mime).map_err(|e| e.to_string())?;
        let encoded = base64_encode(&data);
        buf.extend_from_slice(encoded.as_bytes());
        String::from_utf8(buf).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

fn base64_encode(data: &[u8]) -> String {
    const CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut result = String::with_capacity((data.len() + 2) / 3 * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = if chunk.len() > 1 { chunk[1] as u32 } else { 0 };
        let b2 = if chunk.len() > 2 { chunk[2] as u32 } else { 0 };
        let n = (b0 << 16) | (b1 << 8) | b2;
        result.push(CHARS[(n >> 18 & 63) as usize] as char);
        result.push(CHARS[(n >> 12 & 63) as usize] as char);
        if chunk.len() > 1 {
            result.push(CHARS[(n >> 6 & 63) as usize] as char);
        } else {
            result.push('=');
        }
        if chunk.len() > 2 {
            result.push(CHARS[(n & 63) as usize] as char);
        } else {
            result.push('=');
        }
    }
    result
}

#[tauri::command]
pub async fn batch_rename(
    items: Vec<serde_json::Value>,
) -> Result<Vec<serde_json::Value>, String> {
    struct RenameOp {
        old_path_str: String,
        old_path: PathBuf,
        new_path: PathBuf,
    }

    let mut results = Vec::new();
    let mut completed_renames: Vec<(String, String)> = Vec::new();

    // Phase 0: validate all items upfront and build the full plan
    let mut plan: Vec<Result<RenameOp, (String, String)>> = Vec::new();
    let mut old_path_set: HashSet<PathBuf> = HashSet::new();

    for item in &items {
        let old_path_str = match item["oldPath"].as_str() {
            Some(s) => s.to_string(),
            None => {
                plan.push(Err(("".to_string(), "Missing oldPath".to_string())));
                continue;
            }
        };
        let new_name_raw = match item["newName"].as_str() {
            Some(s) => s,
            None => {
                plan.push(Err((old_path_str, "Missing newName".to_string())));
                continue;
            }
        };
        let new_name = match validate_child_name(new_name_raw, "New name") {
            Ok(n) => n,
            Err(e) => {
                plan.push(Err((old_path_str, e)));
                continue;
            }
        };
        let old_path = match crate::validate_existing_path(&old_path_str, "Item") {
            Ok(p) => p,
            Err(e) => {
                plan.push(Err((old_path_str, e)));
                continue;
            }
        };
        let new_path = match old_path.parent() {
            Some(parent) => parent.join(&new_name),
            None => {
                plan.push(Err((old_path_str, "Cannot determine parent".to_string())));
                continue;
            }
        };
        old_path_set.insert(old_path.clone());
        plan.push(Ok(RenameOp { old_path_str, old_path, new_path }));
    }

    // Phase 1: pre-move any source files whose destination is also a source being renamed
    // (prevents swap/chain renames from clobbering file content)
    let mut temp_map: HashMap<PathBuf, PathBuf> = HashMap::new();
    for op in plan.iter().filter_map(|r| r.as_ref().ok()) {
        if op.new_path != op.old_path
            && path_entry_exists(&op.new_path)
            && old_path_set.contains(&op.new_path)
            && !temp_map.contains_key(&op.new_path)
        {
            let temp_path = op.new_path.with_file_name(format!(
                ".iyeris-rename-tmp-{}",
                op.new_path.file_name().unwrap_or_default().to_string_lossy()
            ));
            if let Err(e) = fs::rename(&op.new_path, &temp_path) {
                // Roll back any temp renames already completed
                for (orig, temp) in &temp_map {
                    let _ = fs::rename(temp, orig);
                }
                return Err(format!("Batch rename staging failed: {}", e));
            }
            temp_map.insert(op.new_path.clone(), temp_path);
        }
    }

    // Phase 2: execute all renames (validation errors are passed through as-is)
    for plan_entry in &plan {
        match plan_entry {
            Err((old_path_str, error)) => {
                results.push(serde_json::json!({
                    "oldPath": old_path_str,
                    "success": false,
                    "error": error,
                }));
            }
            Ok(op) => {
                // True conflict: destination exists and is not being renamed away
                if op.new_path != op.old_path
                    && path_entry_exists(&op.new_path)
                    && !old_path_set.contains(&op.new_path)
                {
                    results.push(serde_json::json!({
                        "oldPath": op.old_path_str,
                        "success": false,
                        "error": format!("Destination already exists: {}", op.new_path.display()),
                    }));
                    continue;
                }
                // Use the temp path if this source was pre-moved during phase 1
                let actual_src = temp_map
                    .get(&op.old_path)
                    .cloned()
                    .unwrap_or_else(|| op.old_path.clone());
                match fs::rename(&actual_src, &op.new_path) {
                    Ok(_) => {
                        let new_path_string = op.new_path.to_string_lossy().to_string();
                        completed_renames.push((op.old_path_str.clone(), new_path_string.clone()));
                        results.push(serde_json::json!({
                            "oldPath": op.old_path_str,
                            "newPath": new_path_string,
                            "success": true,
                        }));
                    }
                    Err(e) => results.push(serde_json::json!({
                        "oldPath": op.old_path_str,
                        "success": false,
                        "error": e.to_string(),
                    })),
                }
            }
        }
    }

    // Phase 3: restore any staged temp files whose Phase 2 rename was skipped or failed
    // and whose original slot is now free (not occupied by a successful rename from this batch).
    for (original_path, temp_path) in &temp_map {
        if path_entry_exists(temp_path) && !path_entry_exists(original_path) {
            if let Err(e) = fs::rename(temp_path, original_path) {
                log::warn!(
                    "[FileOps] batch_rename: failed to restore staged temp {:?} to {:?}: {}",
                    temp_path, original_path, e
                );
            }
        }
    }

    undo::push_batch_rename_action(completed_renames).unwrap_or_else(|e| {
        log::warn!("[FileOps] Failed to push batch rename undo action: {}", e);
    });
    Ok(results)
}

#[tauri::command]
pub async fn create_symlink(target_path: String, link_path: String) -> Result<(), String> {
    let target = crate::validate_existing_path(&target_path, "Target")?;
    let link = crate::validate_path(&link_path, "Link")?;

    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(&target, &link)
            .map_err(|e| format!("Failed to create symlink: {}", e))
    }

    #[cfg(target_os = "windows")]
    {
        if target.is_dir() {
            std::os::windows::fs::symlink_dir(&target, &link)
                .map_err(|e| format!("Failed to create symlink: {}", e))
        } else {
            std::os::windows::fs::symlink_file(&target, &link)
                .map_err(|e| format!("Failed to create symlink: {}", e))
        }
    }
}

#[tauri::command]
pub async fn resolve_shortcut(shortcut_path: String) -> Result<String, String> {
    let path = crate::validate_existing_path(&shortcut_path, "Shortcut")?;

    #[cfg(target_os = "windows")]
    {
        let escaped_path = path.to_string_lossy().replace('\'', "''");
        let script = format!(
            "$s=(New-Object -ComObject WScript.Shell).CreateShortcut('{}'); if($s.TargetPath) {{ Write-Output $s.TargetPath }}",
            escaped_path
        );
        let output = {
            let mut cmd = Command::new("powershell");
            cmd.args(["-NoProfile", "-Command", &script]);
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000);
            cmd.output()
        }
        .map_err(|e| format!("Failed to resolve shortcut: {}", e))?;

        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
        }

        let target = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if target.is_empty() {
            return Err("Shortcut target path is empty.".to_string());
        }
        return Ok(target);
    }

    #[cfg(not(target_os = "windows"))]
    {
        let resolved =
            fs::read_link(&path).map_err(|e| format!("Failed to resolve shortcut: {}", e))?;
        Ok(resolved.to_string_lossy().to_string())
    }
}

#[tauri::command]
pub fn set_clipboard(
    state: tauri::State<'_, crate::AppState>,
    app: tauri::AppHandle,
    clipboard_data: Option<serde_json::Value>,
) -> Result<(), String> {
    log::debug!("[Clipboard] set_clipboard: {:?}", clipboard_data);
    let mut cb = state.clipboard.lock().map_err(|e| e.to_string())?;
    if let Some(data) = clipboard_data {
        cb.operation = data["operation"].as_str().map(String::from);
        cb.paths = data["paths"]
            .as_array()
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default();
    } else {
        cb.operation = None;
        cb.paths.clear();
    }

    let payload = if let Some(operation) = cb.operation.clone() {
        serde_json::json!({
            "operation": operation,
            "paths": cb.paths.clone(),
        })
    } else {
        serde_json::Value::Null
    };
    drop(cb);
    let _ = app.emit("clipboard-changed", payload);
    Ok(())
}

#[tauri::command]
pub fn get_clipboard(
    state: tauri::State<'_, crate::AppState>,
) -> Result<serde_json::Value, String> {
    let cb = state.clipboard.lock().map_err(|e| e.to_string())?;
    if let Some(ref op) = cb.operation {
        Ok(serde_json::json!({
            "operation": op,
            "paths": cb.paths,
        }))
    } else {
        Ok(serde_json::Value::Null)
    }
}

fn percent_decode_lossy(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut decoded: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut index = 0usize;

    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            let hi = bytes[index + 1] as char;
            let lo = bytes[index + 2] as char;
            if let (Some(hi), Some(lo)) = (hi.to_digit(16), lo.to_digit(16)) {
                decoded.push(((hi << 4) | lo) as u8);
                index += 3;
                continue;
            }
        }
        decoded.push(bytes[index]);
        index += 1;
    }

    String::from_utf8_lossy(&decoded).to_string()
}

fn decode_file_uri_path(raw: &str) -> Option<String> {
    let value = raw.trim();
    if !value.to_ascii_lowercase().starts_with("file://") {
        return None;
    }
    let without_scheme = &value[7..];
    let (authority_raw, path_raw) = if let Some(index) = without_scheme.find('/') {
        (&without_scheme[..index], &without_scheme[index..])
    } else {
        (without_scheme, "")
    };
    let authority = percent_decode_lossy(authority_raw);
    let path_part = percent_decode_lossy(path_raw);

    #[cfg(target_os = "windows")]
    {
        let is_drive_authority = authority.len() == 2
            && authority.as_bytes()[1] == b':'
            && authority
                .as_bytes()
                .first()
                .map(|ch| (*ch as char).is_ascii_alphabetic())
                .unwrap_or(false);

        if is_drive_authority {
            let joined = format!("{}{}", authority, path_part);
            return Some(joined.replace('/', "\\"));
        }

        if !authority.is_empty() && !authority.eq_ignore_ascii_case("localhost") {
            let mut unc_path = format!("\\\\{}", authority);
            if !path_part.is_empty() {
                unc_path.push_str(&path_part.replace('/', "\\"));
            }
            return Some(unc_path);
        }

        let mut local_path = path_part;
        if local_path.starts_with('/')
            && local_path.len() >= 3
            && local_path.as_bytes()[2] == b':'
        {
            local_path = local_path[1..].to_string();
        } else if local_path.is_empty() && !authority.is_empty() {
            local_path = authority;
        }

        Some(local_path.replace('/', "\\"))
    }

    #[cfg(not(target_os = "windows"))]
    {
        if !authority.is_empty() && !authority.eq_ignore_ascii_case("localhost") {
            return Some(format!("//{}{}", authority, path_part));
        }

        if path_part.starts_with('/') {
            return Some(path_part);
        }

        if authority.is_empty() {
            return Some(format!("/{}", path_part));
        }

        Some(authority)
    }
}

fn is_absolute_path_like(value: &str) -> bool {
    if value.is_empty() {
        return false;
    }

    #[cfg(target_os = "windows")]
    {
        let mut chars = value.chars();
        if let (Some(first), Some(':')) = (chars.next(), chars.next()) {
            if first.is_ascii_alphabetic() {
                return true;
            }
        }
        value.starts_with("\\\\")
    }

    #[cfg(not(target_os = "windows"))]
    {
        value.starts_with('/')
    }
}

fn parse_clipboard_paths(text: &str) -> Vec<String> {
    let mut seen: HashSet<String> = HashSet::new();
    let mut paths: Vec<String> = Vec::new();

    for line in text.lines().map(|line| line.trim()).filter(|line| !line.is_empty()) {
        let candidate = if let Some(path) = decode_file_uri_path(line) {
            Some(path)
        } else if is_absolute_path_like(line) {
            Some(line.to_string())
        } else {
            None
        };

        if let Some(path) = candidate {
            let key = normalize_case_key(Path::new(&path));
            if seen.insert(key) {
                paths.push(path);
            }
        }
    }

    paths
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn make_test_temp_dir(prefix: &str) -> PathBuf {
        let mut dir = std::env::temp_dir();
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        dir.push(format!("iyeris-{}-{}-{}", prefix, std::process::id(), nonce));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn percent_decode_lossy_decodes_hex_sequences() {
        assert_eq!(percent_decode_lossy("Alpha%20Beta"), "Alpha Beta");
        assert_eq!(percent_decode_lossy("%2fpath%2Ffile"), "/path/file");
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
        assert!(
            planned
                .err()
                .unwrap()
                .to_ascii_lowercase()
                .contains("onto itself")
        );
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
        assert!(
            planned
                .err()
                .unwrap()
                .to_ascii_lowercase()
                .contains("onto itself")
        );
    }
}

#[cfg(not(target_os = "windows"))]
fn run_command_capture(command: &str, args: &[&str]) -> Option<String> {
    let mut cmd = Command::new(command);
    cmd.args(args);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    let output = cmd.output().ok()?;
    if !output.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&output.stdout).to_string())
}

#[cfg(target_os = "windows")]
fn get_windows_system_clipboard_files() -> Vec<String> {
    use windows::Win32::System::DataExchange::*;
    use windows::Win32::System::Ole::CF_HDROP;
    use windows::Win32::UI::Shell::DragQueryFileW;

    unsafe {
        if OpenClipboard(None).is_err() {
            return Vec::new();
        }

        let result = (|| {
            let handle = GetClipboardData(CF_HDROP.0 as u32);
            let handle = match handle {
                Ok(h) => h,
                Err(_) => return Vec::new(),
            };

            let hdrop = windows::Win32::UI::Shell::HDROP(handle.0);
            let count = DragQueryFileW(hdrop, 0xFFFFFFFF, None);
            if count == 0 {
                return Vec::new();
            }

            let mut paths = Vec::with_capacity(count as usize);
            for i in 0..count {
                let len = DragQueryFileW(hdrop, i, None);
                if len == 0 {
                    continue;
                }
                let mut buf = vec![0u16; (len + 1) as usize];
                DragQueryFileW(hdrop, i, Some(&mut buf));
                let path = String::from_utf16_lossy(&buf[..len as usize]);
                paths.push(path);
            }
            paths
        })();

        let _ = CloseClipboard();
        result
    }
}

#[cfg(target_os = "windows")]
fn get_windows_system_clipboard_text_paths() -> Vec<String> {
    use windows::Win32::Foundation::HGLOBAL;
    use windows::Win32::System::DataExchange::*;
    use windows::Win32::System::Memory::*;
    use windows::Win32::System::Ole::CF_UNICODETEXT;

    unsafe {
        if OpenClipboard(None).is_err() {
            return Vec::new();
        }

        let result = (|| {
            let handle = GetClipboardData(CF_UNICODETEXT.0 as u32);
            let handle = match handle {
                Ok(h) => h,
                Err(_) => return Vec::new(),
            };

            let ptr = GlobalLock(std::mem::transmute::<_, HGLOBAL>(handle.0));
            if ptr.is_null() {
                return Vec::new();
            }

            let wide = ptr as *const u16;
            let mut len = 0usize;
            while *wide.add(len) != 0 {
                len += 1;
            }
            let slice = std::slice::from_raw_parts(wide, len);
            let text = String::from_utf16_lossy(slice);
            let _ = GlobalUnlock(std::mem::transmute::<_, HGLOBAL>(handle.0));
            parse_clipboard_paths(&text)
        })();

        let _ = CloseClipboard();
        result
    }
}

#[cfg(target_os = "windows")]
fn write_windows_system_clipboard_text(text: &str) -> Result<(), String> {
    use windows::Win32::System::DataExchange::*;
    use windows::Win32::System::Memory::*;
    use windows::Win32::System::Ole::CF_UNICODETEXT;

    let wide: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
    let byte_len = wide.len() * 2;

    unsafe {
        OpenClipboard(None).map_err(|e| format!("Failed to open clipboard: {}", e))?;

        let cleanup_and_err = |msg: String| -> Result<(), String> {
            let _ = CloseClipboard();
            Err(msg)
        };

        if EmptyClipboard().is_err() {
            return cleanup_and_err("Failed to empty clipboard".into());
        }

        let hmem = GlobalAlloc(GMEM_MOVEABLE, byte_len);
        let hmem = match hmem {
            Ok(h) => h,
            Err(e) => return cleanup_and_err(format!("Failed to allocate memory: {}", e)),
        };

        let ptr = GlobalLock(hmem);
        if ptr.is_null() {
            // GlobalFree unavailable in windows 0.58 — memory lost on this rare error path
            return cleanup_and_err("Failed to lock memory".into());
        }

        std::ptr::copy_nonoverlapping(wide.as_ptr() as *const u8, ptr as *mut u8, byte_len);
        let _ = GlobalUnlock(hmem);

        let handle = windows::Win32::Foundation::HANDLE(hmem.0);
        if SetClipboardData(CF_UNICODETEXT.0 as u32, handle).is_err() {
            // On failure caller should free hmem but GlobalFree unavailable in windows 0.58
            return cleanup_and_err("Failed to set clipboard data".into());
        }

        let _ = CloseClipboard();
        Ok(())
    }
}

fn get_system_clipboard_files_internal() -> Vec<String> {
    #[cfg(target_os = "windows")]
    {
        let files = get_windows_system_clipboard_files();
        if !files.is_empty() {
            return files;
        }
        return get_windows_system_clipboard_text_paths();
    }

    #[cfg(target_os = "macos")]
    {
        return run_command_capture("pbpaste", &[])
            .map(|output| parse_clipboard_paths(&output))
            .unwrap_or_default();
    }

    #[cfg(target_os = "linux")]
    {
        let text = run_command_capture("wl-paste", &["-n", "-t", "text/uri-list"])
            .or_else(|| run_command_capture("xclip", &["-selection", "clipboard", "-o"]))
            .or_else(|| run_command_capture("xsel", &["--clipboard", "--output"]))
            .unwrap_or_default();
        return parse_clipboard_paths(&text);
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        Vec::new()
    }
}

fn clipboard_paths_match(paths_a: &[String], paths_b: &[String]) -> bool {
    if paths_a.len() != paths_b.len() {
        return false;
    }

    let set_a: HashSet<String> = paths_a
        .iter()
        .map(|path| normalize_case_key(Path::new(path)))
        .collect();
    let set_b: HashSet<String> = paths_b
        .iter()
        .map(|path| normalize_case_key(Path::new(path)))
        .collect();
    set_a == set_b
}

#[tauri::command]
pub fn get_system_clipboard_data(
    state: tauri::State<'_, crate::AppState>,
) -> Result<serde_json::Value, String> {
    log::debug!("[Clipboard] get_system_clipboard_data");
    let system_paths = get_system_clipboard_files_internal();
    if !system_paths.is_empty() {
        let cb = state.clipboard.lock().map_err(|e| e.to_string())?;
        let operation = if cb.operation.as_deref() == Some("cut")
            && clipboard_paths_match(&cb.paths, &system_paths)
        {
            "cut"
        } else {
            "copy"
        };
        return Ok(serde_json::json!({
            "operation": operation,
            "paths": system_paths,
        }));
    }

    get_clipboard(state)
}

#[tauri::command]
pub fn get_system_clipboard_files(
    state: tauri::State<'_, crate::AppState>,
) -> Result<Vec<String>, String> {
    log::debug!("[Clipboard] get_system_clipboard_files");
    let system_paths = get_system_clipboard_files_internal();
    if !system_paths.is_empty() {
        return Ok(system_paths);
    }
    let cb = state.clipboard.lock().map_err(|e| e.to_string())?;
    Ok(cb.paths.clone())
}

#[tauri::command]
pub fn write_to_system_clipboard(text: String) -> Result<(), String> {
    log::debug!("[Clipboard] write_to_system_clipboard ({} chars)", text.len());
    #[cfg(target_os = "windows")]
    {
        return write_windows_system_clipboard_text(&text);
    }

    #[cfg(target_os = "macos")]
    {
        let mut cmd = Command::new("pbcopy");
        cmd.stdin(std::process::Stdio::piped());
        let mut child = cmd.spawn().map_err(|e| e.to_string())?;
        if let Some(mut stdin) = child.stdin.take() {
            use std::io::Write;
            stdin.write_all(text.as_bytes()).map_err(|e| e.to_string())?;
        }
        child.wait().map_err(|e| e.to_string())?;
        return Ok(());
    }

    #[cfg(target_os = "linux")]
    {
        let try_copy = |cmd_name: &str, args: &[&str]| -> Result<(), String> {
            let mut cmd = Command::new(cmd_name);
            cmd.args(args).stdin(std::process::Stdio::piped());
            let mut child = cmd.spawn().map_err(|e| e.to_string())?;
            if let Some(mut stdin) = child.stdin.take() {
                use std::io::Write;
                stdin.write_all(text.as_bytes()).map_err(|e| e.to_string())?;
            }
            child.wait().map_err(|e| e.to_string())?;
            Ok(())
        };

        if try_copy("wl-copy", &[]).is_ok() {
            return Ok(());
        }
        if try_copy("xclip", &["-selection", "clipboard"]).is_ok() {
            return Ok(());
        }
        if try_copy("xsel", &["--clipboard", "--input"]).is_ok() {
            return Ok(());
        }
        return Err("No clipboard tool found".into());
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        let _ = text;
        Err("Clipboard not supported on this platform".into())
    }
}

#[tauri::command]
pub fn set_drag_data(
    state: tauri::State<'_, crate::AppState>,
    paths: Vec<String>,
) -> Result<(), String> {
    let mut drag = state.drag.lock().map_err(|e| e.to_string())?;
    drag.paths = paths;
    Ok(())
}

#[tauri::command]
pub fn get_drag_data(
    state: tauri::State<'_, crate::AppState>,
) -> Result<Vec<String>, String> {
    let drag = state.drag.lock().map_err(|e| e.to_string())?;
    Ok(drag.paths.clone())
}

#[tauri::command]
pub fn clear_drag_data(
    state: tauri::State<'_, crate::AppState>,
) -> Result<(), String> {
    let mut drag = state.drag.lock().map_err(|e| e.to_string())?;
    drag.paths.clear();
    Ok(())
}

#[tauri::command]
pub async fn calculate_checksum(
    file_path: String,
    operation_id: String,
    algorithms: Vec<String>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let path = crate::validate_existing_path(&file_path, "File")?;

    {
        let mut active = ACTIVE_CHECKSUMS.lock().map_err(|e| e.to_string())?;
        active.insert(operation_id.clone());
    }

    let op_id = operation_id.clone();
    let result = tokio::task::spawn_blocking(move || {
        use sha2::{Sha256, Sha512, Digest};
        use md5::Md5;

        let file_size = fs::metadata(&path).map_err(|e| e.to_string())?.len();
        let mut file = fs::File::open(&path).map_err(|e| e.to_string())?;
        let mut results = serde_json::Map::new();

        for algo in &algorithms {
            {
                let active = ACTIVE_CHECKSUMS.lock().map_err(|e| e.to_string())?;
                if !active.contains(&op_id) {
                    return Err("Checksum cancelled".to_string());
                }
            }

            let hash = match algo.to_lowercase().as_str() {
                "sha256" => {
                    let mut hasher = Sha256::new();
                    let mut buf = [0u8; 8192];
                    let mut read_total = 0u64;
                    use std::io::Seek;
                    file.seek(std::io::SeekFrom::Start(0)).map_err(|e| e.to_string())?;
                    loop {
                        let n = file.read(&mut buf).map_err(|e| e.to_string())?;
                        if n == 0 { break; }
                        hasher.update(&buf[..n]);
                        read_total += n as u64;
                        if read_total % (1024 * 1024) == 0 {
                            let percent = if file_size > 0 { (read_total as f64 / file_size as f64) * 100.0 } else { 100.0 };
                            let _ = app.emit("checksum-progress", serde_json::json!({
                                "operationId": op_id, "percent": percent, "algorithm": algo
                            }));
                        }
                    }
                    hex::encode(hasher.finalize())
                },
                "sha512" => {
                    let mut hasher = Sha512::new();
                    let mut buf = [0u8; 8192];
                    use std::io::Seek;
                    file.seek(std::io::SeekFrom::Start(0)).map_err(|e| e.to_string())?;
                    loop {
                        let n = file.read(&mut buf).map_err(|e| e.to_string())?;
                        if n == 0 { break; }
                        hasher.update(&buf[..n]);
                    }
                    hex::encode(hasher.finalize())
                },
                "md5" => {
                    let mut hasher = Md5::new();
                    let mut buf = [0u8; 8192];
                    use std::io::Seek;
                    file.seek(std::io::SeekFrom::Start(0)).map_err(|e| e.to_string())?;
                    loop {
                        let n = file.read(&mut buf).map_err(|e| e.to_string())?;
                        if n == 0 { break; }
                        hasher.update(&buf[..n]);
                    }
                    hex::encode(hasher.finalize())
                },
                "crc32" => {
                    let mut hasher = crc32fast::Hasher::new();
                    let mut buf = [0u8; 8192];
                    use std::io::Seek;
                    file.seek(std::io::SeekFrom::Start(0)).map_err(|e| e.to_string())?;
                    loop {
                        let n = file.read(&mut buf).map_err(|e| e.to_string())?;
                        if n == 0 { break; }
                        hasher.update(&buf[..n]);
                    }
                    format!("{:08x}", hasher.finalize())
                },
                _ => return Err(format!("Unknown algorithm: {}", algo)),
            };
            results.insert(algo.clone(), serde_json::Value::String(hash));
        }

        Ok(serde_json::Value::Object(results))
    })
    .await;

    if let Ok(mut active) = ACTIVE_CHECKSUMS.lock() {
        active.remove(&operation_id);
    }

    result.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn cancel_checksum_calculation(operation_id: String) -> Result<(), String> {
    let mut active = ACTIVE_CHECKSUMS.lock().map_err(|e| e.to_string())?;
    active.remove(&operation_id);
    Ok(())
}
