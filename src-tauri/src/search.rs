use chrono::{NaiveDate, TimeZone, Utc};
use serde::{Deserialize, Serialize};
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

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawSearchFilters {
    file_type: Option<String>,
    min_size: Option<u64>,
    max_size: Option<u64>,
    date_from: Option<String>,
    date_to: Option<String>,
    regex: Option<bool>,
}

#[derive(Default)]
struct ParsedFilters {
    file_type: Option<String>,
    min_size: Option<u64>,
    max_size: Option<u64>,
    date_from_ms: Option<f64>,
    date_to_ms: Option<f64>,
    regex: bool,
}

fn is_search_active(op_id: &str) -> bool {
    ACTIVE_SEARCHES.lock().map(|s| s.contains(op_id)).unwrap_or(false)
}

fn parse_date_to_ms(raw: &str, end_of_day: bool) -> Option<f64> {
    if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(raw) {
        return Some(dt.timestamp_millis() as f64);
    }
    if let Ok(date) = NaiveDate::parse_from_str(raw, "%Y-%m-%d") {
        let datetime = if end_of_day {
            date.and_hms_opt(23, 59, 59)?
        } else {
            date.and_hms_opt(0, 0, 0)?
        };
        return Some(Utc.from_utc_datetime(&datetime).timestamp_millis() as f64);
    }
    None
}

fn parse_filters(raw: Option<serde_json::Value>) -> ParsedFilters {
    let raw_filters = match raw {
        Some(serde_json::Value::String(value)) => {
            serde_json::from_str::<RawSearchFilters>(&value).ok()
        }
        Some(value) => serde_json::from_value::<RawSearchFilters>(value).ok(),
        None => None,
    }
    .unwrap_or_default();

    ParsedFilters {
        file_type: raw_filters.file_type.map(|value| value.trim().to_ascii_lowercase()),
        min_size: raw_filters.min_size,
        max_size: raw_filters.max_size,
        date_from_ms: raw_filters
            .date_from
            .as_deref()
            .and_then(|value| parse_date_to_ms(value, false)),
        date_to_ms: raw_filters
            .date_to
            .as_deref()
            .and_then(|value| parse_date_to_ms(value, true)),
        regex: raw_filters.regex.unwrap_or(false),
    }
}

fn matches_filters(
    entry_path: &std::path::Path,
    meta: &std::fs::Metadata,
    filters: &ParsedFilters,
) -> bool {
    if let Some(file_type) = &filters.file_type {
        if meta.is_dir() {
            return false;
        }
        let ext = entry_path
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        let normalized_filter = file_type.trim_start_matches('.').to_ascii_lowercase();
        if ext != normalized_filter {
            return false;
        }
    }

    if let Some(min_size) = filters.min_size {
        if meta.is_file() && meta.len() < min_size {
            return false;
        }
    }

    if let Some(max_size) = filters.max_size {
        if meta.is_file() && meta.len() > max_size {
            return false;
        }
    }

    if filters.date_from_ms.is_some() || filters.date_to_ms.is_some() {
        let modified = meta
            .modified()
            .ok()
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|duration| duration.as_secs_f64() * 1000.0);

        if let (Some(required), Some(actual)) = (filters.date_from_ms, modified) {
            if actual < required {
                return false;
            }
        }

        if let (Some(required), Some(actual)) = (filters.date_to_ms, modified) {
            if actual > required {
                return false;
            }
        }
    }

    true
}

#[tauri::command]
pub async fn search_files(
    dir_path: String,
    query: String,
    filters: Option<serde_json::Value>,
    operation_id: Option<String>,
) -> Result<Vec<SearchResult>, String> {
    log::debug!("[Search] search_files: q={:?} in {}", query, dir_path);
    let path = crate::validate_existing_path(&dir_path, "Directory")?;
    let op_id = operation_id.unwrap_or_default();
    let parsed_filters = parse_filters(filters);
    let regex = if parsed_filters.regex {
        if query.len() > 1024 {
            return Err("Regex pattern too long (max 1024 characters)".to_string());
        }
        Some(regex::Regex::new(&query).map_err(|e| format!("Invalid regex: {}", e))?)
    } else {
        None
    };

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
            .filter_map(|e| e.map_err(|err| log::warn!("[Search] walk error: {}", err)).ok())
        {
            if !search_op_id.is_empty() && !is_search_active(&search_op_id) {
                break;
            }

            let entry_path = entry.path();
            let name = entry
                .file_name()
                .to_string_lossy()
                .to_string();

            let name_matches = if let Some(regex) = &regex {
                regex.is_match(&name)
            } else {
                name.to_lowercase().contains(&query_lower)
            };

            if name_matches {
                let meta = match entry.metadata() {
                    Ok(m) => m,
                    Err(_) => continue,
                };
                if !matches_filters(entry_path, &meta, &parsed_filters) {
                    continue;
                }

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
    .await;

    if !op_id.is_empty() {
        if let Ok(mut searches) = ACTIVE_SEARCHES.lock() {
            searches.remove(&op_id);
        }
    }

    result.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn search_files_content(
    dir_path: String,
    query: String,
    filters: Option<serde_json::Value>,
    operation_id: Option<String>,
) -> Result<Vec<SearchResult>, String> {
    log::debug!("[Search] search_files_content: q={:?} in {}", query, dir_path);
    let path = crate::validate_existing_path(&dir_path, "Directory")?;
    let op_id = operation_id.unwrap_or_default();
    let parsed_filters = parse_filters(filters);
    let regex = if parsed_filters.regex {
        if query.len() > 1024 {
            return Err("Regex pattern too long (max 1024 characters)".to_string());
        }
        Some(regex::Regex::new(&query).map_err(|e| format!("Invalid regex: {}", e))?)
    } else {
        Some(
            regex::RegexBuilder::new(&regex::escape(&query))
                .case_insensitive(true)
                .build()
                .map_err(|e| format!("Regex build error: {}", e))?,
        )
    };

    if !op_id.is_empty() {
        let mut searches = ACTIVE_SEARCHES.lock().map_err(|e| e.to_string())?;
        searches.insert(op_id.clone());
    }

    let search_op_id = op_id.clone();
    let result = tokio::task::spawn_blocking(move || {
        let _query = query;
        let mut results = Vec::new();
        let max_file_size: u64 = 10 * 1024 * 1024;

        for entry in WalkDir::new(&path)
            .max_depth(20)
            .into_iter()
            .filter_map(|e| e.map_err(|err| log::warn!("[Search] content walk error: {}", err)).ok())
        {
            if !search_op_id.is_empty() && !is_search_active(&search_op_id) {
                break;
            }

            let entry_path = entry.path();
            let meta = match entry.metadata() {
                Ok(m) => m,
                Err(_) => continue,
            };
            if !matches_filters(entry_path, &meta, &parsed_filters) {
                continue;
            }

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

            let matched_position = if let Some(regex) = &regex {
                regex.find(&content).map(|match_result| (match_result.start(), match_result.end() - match_result.start()))
            } else {
                None
            };

            if let Some((pos, match_len)) = matched_position {
                let start = content[..pos].char_indices()
                    .rev()
                    .nth(49)
                    .map(|(i, _)| i)
                    .unwrap_or(0);
                let end = content[pos..].char_indices()
                    .nth(match_len + 50)
                    .map(|(i, _)| pos + i)
                    .unwrap_or(content.len());
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
    .await;

    if !op_id.is_empty() {
        if let Ok(mut searches) = ACTIVE_SEARCHES.lock() {
            searches.remove(&op_id);
        }
    }

    result.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn search_files_content_global(
    query: String,
    filters: Option<serde_json::Value>,
    operation_id: Option<String>,
) -> Result<Vec<SearchResult>, String> {
    let home = directories::UserDirs::new()
        .map(|dirs| dirs.home_dir().to_string_lossy().to_string())
        .ok_or_else(|| "Could not determine home directory".to_string())?;

    search_files_content(home, query, filters, operation_id).await
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
