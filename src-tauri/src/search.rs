use serde::Serialize;
use std::collections::HashSet;
use std::fs;
use std::io::Read;
use std::sync::Mutex;
use walkdir::WalkDir;

use crate::indexer;

static ACTIVE_SEARCHES: std::sync::LazyLock<Mutex<HashSet<String>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashSet::new()));

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub name: String,
    pub path: String,
    pub is_directory: bool,
    pub size: u64,
    pub modified: f64,
    pub extension: String,
    pub match_context: Option<String>,
}

fn is_search_active(op_id: &str) -> bool {
    ACTIVE_SEARCHES.lock().map(|s| s.contains(op_id)).unwrap_or(false)
}

#[tauri::command]
pub async fn search_files(
    dir_path: String,
    query: String,
    _filters: Option<serde_json::Value>,
    operation_id: Option<String>,
) -> Result<Vec<SearchResult>, String> {
    let path = crate::validate_existing_path(&dir_path, "Directory")?;
    let op_id = operation_id.unwrap_or_default();

    if !op_id.is_empty() {
        let mut searches = ACTIVE_SEARCHES.lock().map_err(|e| e.to_string())?;
        searches.insert(op_id.clone());
    }

    let search_op_id = op_id.clone();
    let result = tokio::task::spawn_blocking(move || {
        let query_lower = query.to_lowercase();
        let mut results = Vec::new();

        for entry in WalkDir::new(&path)
            .max_depth(20)
            .into_iter()
            .flatten()
        {
            if !search_op_id.is_empty() && !is_search_active(&search_op_id) {
                break;
            }

            let entry_path = entry.path();
            let name = entry
                .file_name()
                .to_string_lossy()
                .to_string();

            if name.to_lowercase().contains(&query_lower) {
                let meta = match entry.metadata() {
                    Ok(m) => m,
                    Err(_) => continue,
                };

                let modified = meta
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_secs_f64() * 1000.0)
                    .unwrap_or(0.0);

                results.push(SearchResult {
                    name,
                    path: entry_path.to_string_lossy().to_string(),
                    is_directory: meta.is_dir(),
                    size: meta.len(),
                    modified,
                    extension: entry_path
                        .extension()
                        .map(|e| e.to_string_lossy().to_string())
                        .unwrap_or_default(),
                    match_context: None,
                });

                if results.len() >= 10000 {
                    break;
                }
            }
        }

        Ok(results)
    })
    .await
    .map_err(|e| e.to_string())?;

    if !op_id.is_empty() {
        let mut searches = ACTIVE_SEARCHES.lock().map_err(|e| e.to_string())?;
        searches.remove(&op_id);
    }

    result
}

#[tauri::command]
pub async fn search_files_content(
    dir_path: String,
    query: String,
    _filters: Option<serde_json::Value>,
    operation_id: Option<String>,
) -> Result<Vec<SearchResult>, String> {
    let path = crate::validate_existing_path(&dir_path, "Directory")?;
    let op_id = operation_id.unwrap_or_default();

    if !op_id.is_empty() {
        let mut searches = ACTIVE_SEARCHES.lock().map_err(|e| e.to_string())?;
        searches.insert(op_id.clone());
    }

    let search_op_id = op_id.clone();
    let result = tokio::task::spawn_blocking(move || {
        let query_lower = query.to_lowercase();
        let mut results = Vec::new();
        let max_file_size: u64 = 10 * 1024 * 1024;

        for entry in WalkDir::new(&path)
            .max_depth(20)
            .into_iter()
            .flatten()
        {
            if !search_op_id.is_empty() && !is_search_active(&search_op_id) {
                break;
            }

            let entry_path = entry.path();
            let meta = match entry.metadata() {
                Ok(m) => m,
                Err(_) => continue,
            };

            if !meta.is_file() || meta.len() > max_file_size {
                continue;
            }

            let mut file = match fs::File::open(entry_path) {
                Ok(f) => f,
                Err(_) => continue,
            };

            let mut content = String::new();
            if file.read_to_string(&mut content).is_err() {
                continue;
            }

            if let Some(pos) = content.to_lowercase().find(&query_lower) {
                let start = pos.saturating_sub(50);
                let end = (pos + query.len() + 50).min(content.len());
                let context = content[start..end].to_string();

                let modified = meta
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_secs_f64() * 1000.0)
                    .unwrap_or(0.0);

                results.push(SearchResult {
                    name: entry_path
                        .file_name()
                        .map(|n| n.to_string_lossy().to_string())
                        .unwrap_or_default(),
                    path: entry_path.to_string_lossy().to_string(),
                    is_directory: false,
                    size: meta.len(),
                    modified,
                    extension: entry_path
                        .extension()
                        .map(|e| e.to_string_lossy().to_string())
                        .unwrap_or_default(),
                    match_context: Some(context),
                });

                if results.len() >= 5000 {
                    break;
                }
            }
        }

        Ok(results)
    })
    .await
    .map_err(|e| e.to_string())?;

    if !op_id.is_empty() {
        let mut searches = ACTIVE_SEARCHES.lock().map_err(|e| e.to_string())?;
        searches.remove(&op_id);
    }

    result
}

#[tauri::command]
pub async fn cancel_search(operation_id: String) -> Result<(), String> {
    let mut searches = ACTIVE_SEARCHES.lock().map_err(|e| e.to_string())?;
    searches.remove(&operation_id);
    Ok(())
}

#[tauri::command]
pub async fn search_index(
    query: String,
    _operation_id: Option<String>,
) -> Result<Vec<SearchResult>, String> {
    let results = tokio::task::spawn_blocking(move || indexer::search_in_index(&query))
        .await
        .map_err(|e| e.to_string())?;

    Ok(results
        .into_iter()
        .map(|e| SearchResult {
            extension: std::path::Path::new(&e.path)
                .extension()
                .map(|ext| ext.to_string_lossy().to_string())
                .unwrap_or_default(),
            name: e.name,
            path: e.path,
            is_directory: e.is_directory,
            size: e.size,
            modified: e.modified,
            match_context: None,
        })
        .collect())
}

#[tauri::command]
pub async fn rebuild_index(app: tauri::AppHandle) -> Result<(), String> {
    indexer::trigger_rebuild(&app);
    Ok(())
}

#[tauri::command]
pub async fn get_index_status() -> Result<serde_json::Value, String> {
    let (is_building, entry_count, last_built) = indexer::get_status();
    Ok(serde_json::json!({
        "isBuilding": is_building,
        "entryCount": entry_count,
        "lastBuilt": last_built,
    }))
}
