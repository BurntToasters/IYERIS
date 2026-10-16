use chrono::{NaiveDate, TimeZone, Utc};
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{BufRead, Read};
use std::path::Path;
use walkdir::WalkDir;

use crate::cancellation::{is_cancelled, CancellationRegistry, CancellationToken};
use crate::indexer;

static ACTIVE_SEARCHES: std::sync::LazyLock<CancellationRegistry> =
    std::sync::LazyLock::new(CancellationRegistry::default);
const MAX_QUERY_BYTES: usize = 4096;
const MAX_REGEX_QUERY_BYTES: usize = 1024;
const MAX_FILTER_PAYLOAD_BYTES: usize = 64 * 1024;

fn validate_query(query: &str) -> Result<(), String> {
    if query.is_empty() {
        return Err("Search query cannot be empty".to_string());
    }
    if query.len() > MAX_QUERY_BYTES {
        return Err(format!(
            "Search query too long (max {} bytes)",
            MAX_QUERY_BYTES
        ));
    }
    Ok(())
}

fn register_search_operation(operation_id: &str) -> Result<Option<CancellationToken>, String> {
    if operation_id.is_empty() {
        return Ok(None);
    }
    ACTIVE_SEARCHES
        .register(operation_id)
        .ok_or_else(|| "Search operation ID is too long".to_string())
        .map(Some)
}

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
    pub is_hidden: bool,
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
        file_type: raw_filters
            .file_type
            .map(|value| value.trim().to_ascii_lowercase()),
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

fn validate_filter_payload(raw: Option<&serde_json::Value>) -> Result<(), String> {
    let Some(value) = raw else {
        return Ok(());
    };
    let size = serde_json::to_vec(value)
        .map_err(|error| format!("Invalid search filters: {}", error))?
        .len();
    if size > MAX_FILTER_PAYLOAD_BYTES {
        return Err(format!(
            "Search filters exceed the {} byte limit",
            MAX_FILTER_PAYLOAD_BYTES
        ));
    }
    Ok(())
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

fn is_hidden_name(name: &str) -> bool {
    name.starts_with('.')
}

fn has_hidden_attribute(meta: &fs::Metadata) -> bool {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::fs::MetadataExt;
        if meta.file_attributes() & 0x2 != 0 {
            return true;
        }
    }
    #[cfg(not(target_os = "windows"))]
    let _ = meta;
    false
}

fn is_hidden_entry(name: &str, path: &Path) -> bool {
    if is_hidden_name(name) {
        return true;
    }
    #[cfg(target_os = "windows")]
    {
        if let Ok(meta) = fs::symlink_metadata(path) {
            return has_hidden_attribute(&meta);
        }
    }
    #[cfg(not(target_os = "windows"))]
    let _ = path;
    false
}

fn allow_search_walk_entry(entry: &walkdir::DirEntry, include_hidden: bool) -> bool {
    include_hidden
        || entry.depth() == 0
        || !is_hidden_entry(&entry.file_name().to_string_lossy(), entry.path())
}

fn open_content_search_file(path: &Path) -> Result<fs::File, String> {
    // Denylist the walk path (and a resolved target, for planted links).
    // Open the walk path with O_NOFOLLOW so a swapped symlink cannot redirect
    // the read to an external canonical target.
    crate::file_operations::ensure_safe_preview_read_path(path)?;
    crate::file_operations::open_regular_read(path)
}

fn make_search_result(
    name: String,
    path: &Path,
    meta: &fs::Metadata,
    match_context: Option<String>,
) -> SearchResult {
    SearchResult {
        is_hidden: is_hidden_name(&name) || has_hidden_attribute(meta),
        name,
        path: path.to_string_lossy().into_owned(),
        is_directory: meta.is_dir(),
        size: meta.len(),
        modified: meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs_f64() * 1000.0)
            .unwrap_or(0.0),
        extension: path
            .extension()
            .map(|e| e.to_string_lossy().into_owned())
            .unwrap_or_default(),
        match_context,
    }
}

fn build_safe_regex(pattern: &str, case_insensitive: bool) -> Result<regex::Regex, String> {
    regex::RegexBuilder::new(pattern)
        .case_insensitive(case_insensitive)
        .size_limit(1_000_000)
        .dfa_size_limit(1_000_000)
        .build()
        .map_err(|e| format!("Invalid regex: {}", e))
}

fn build_index_search_regex(
    query: &str,
    parsed_filters: &ParsedFilters,
) -> Result<Option<regex::Regex>, String> {
    if !parsed_filters.regex {
        return Ok(None);
    }
    if query.len() > MAX_REGEX_QUERY_BYTES {
        return Err(format!(
            "Regex pattern too long (max {} bytes)",
            MAX_REGEX_QUERY_BYTES
        ));
    }
    build_safe_regex(query, false).map(Some)
}

fn to_index_filters(
    parsed_filters: &ParsedFilters,
    include_hidden: bool,
    regex: Option<regex::Regex>,
) -> indexer::IndexSearchFilters {
    indexer::IndexSearchFilters {
        include_hidden,
        regex,
        file_type: parsed_filters.file_type.clone(),
        min_size: parsed_filters.min_size,
        max_size: parsed_filters.max_size,
        date_from_ms: parsed_filters.date_from_ms,
        date_to_ms: parsed_filters.date_to_ms,
    }
}

fn snippet_around_match(
    line: &str,
    match_start: usize,
    match_end: usize,
    context_chars: usize,
) -> String {
    if match_start > line.len() || match_end > line.len() || match_start > match_end {
        return line.to_string();
    }
    let start = line[..match_start]
        .char_indices()
        .rev()
        .nth(context_chars.saturating_sub(1))
        .map(|(i, _)| i)
        .unwrap_or(0);
    let end = line[match_end..]
        .char_indices()
        .nth(context_chars)
        .map(|(i, _)| match_end + i)
        .unwrap_or(line.len());
    line[start..end].to_string()
}

fn collect_name_search_results(
    path: &Path,
    query: &str,
    include_hidden: bool,
    regex: Option<&regex::Regex>,
    parsed_filters: &ParsedFilters,
    cancelled: impl Fn() -> bool,
) -> Result<Vec<SearchResult>, String> {
    let query_lower = query.to_lowercase();
    let mut results = Vec::new();

    for entry in WalkDir::new(path)
        .max_depth(20)
        .follow_links(false)
        .into_iter()
        .filter_entry(|entry| allow_search_walk_entry(entry, include_hidden))
        .filter_map(|entry| {
            entry
                .map_err(|err| log::warn!("[Search] walk error: {}", err))
                .ok()
        })
    {
        if cancelled() {
            break;
        }

        let entry_path = entry.path();
        let name_cow = entry.file_name().to_string_lossy();

        let name_matches = if let Some(regex) = regex {
            regex.is_match(&name_cow)
        } else {
            name_cow.to_lowercase().contains(&query_lower)
        };

        if !name_matches {
            continue;
        }

        let meta = match fs::symlink_metadata(entry_path) {
            Ok(m) => m,
            Err(e) => {
                if e.kind() != std::io::ErrorKind::NotFound {
                    log::debug!(
                        "[Search] metadata error for {}: {}",
                        entry_path.display(),
                        e
                    );
                }
                continue;
            }
        };
        if !matches_filters(entry_path, &meta, parsed_filters) {
            continue;
        }

        results.push(make_search_result(
            name_cow.into_owned(),
            entry_path,
            &meta,
            None,
        ));

        if results.len() >= 10000 {
            log::info!("[Search] Results capped at 10000 for query {:?}", query);
            break;
        }
    }

    Ok(results)
}

#[tauri::command]
pub async fn search_files(
    dir_path: String,
    query: String,
    filters: Option<serde_json::Value>,
    operation_id: Option<String>,
    include_hidden: Option<bool>,
) -> Result<Vec<SearchResult>, String> {
    log::debug!("[Search] search_files: q={:?} in {}", query, dir_path);
    validate_query(&query)?;
    validate_filter_payload(filters.as_ref())?;
    let op_id = operation_id.unwrap_or_default();
    let cancellation = register_search_operation(&op_id)?;
    let path = match crate::validate_existing_path(&dir_path, "Directory") {
        Ok(path) => path,
        Err(error) => {
            ACTIVE_SEARCHES.finish(&op_id, cancellation.as_ref());
            return Err(error);
        }
    };
    let parsed_filters = parse_filters(filters);
    let include_hidden = include_hidden.unwrap_or(false);
    let regex = if parsed_filters.regex {
        if query.len() > MAX_REGEX_QUERY_BYTES {
            ACTIVE_SEARCHES.finish(&op_id, cancellation.as_ref());
            return Err(format!(
                "Regex pattern too long (max {} bytes)",
                MAX_REGEX_QUERY_BYTES
            ));
        }
        match build_safe_regex(&query, false) {
            Ok(regex) => Some(regex),
            Err(error) => {
                ACTIVE_SEARCHES.finish(&op_id, cancellation.as_ref());
                return Err(error);
            }
        }
    } else {
        None
    };

    let scan_cancellation = cancellation.clone();
    let result = tokio::task::spawn_blocking(move || {
        collect_name_search_results(
            &path,
            &query,
            include_hidden,
            regex.as_ref(),
            &parsed_filters,
            || is_cancelled(scan_cancellation.as_ref()),
        )
    })
    .await;

    ACTIVE_SEARCHES.finish(&op_id, cancellation.as_ref());

    result.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn search_files_content(
    dir_path: String,
    query: String,
    filters: Option<serde_json::Value>,
    operation_id: Option<String>,
    include_hidden: Option<bool>,
) -> Result<Vec<SearchResult>, String> {
    log::debug!(
        "[Search] search_files_content: q={:?} in {}",
        query,
        dir_path
    );
    validate_query(&query)?;
    validate_filter_payload(filters.as_ref())?;
    let op_id = operation_id.unwrap_or_default();
    let cancellation = register_search_operation(&op_id)?;
    let path = match crate::validate_existing_path(&dir_path, "Directory") {
        Ok(path) => path,
        Err(error) => {
            ACTIVE_SEARCHES.finish(&op_id, cancellation.as_ref());
            return Err(error);
        }
    };
    let parsed_filters = parse_filters(filters);
    let include_hidden = include_hidden.unwrap_or(false);
    let regex = if parsed_filters.regex {
        if query.len() > MAX_REGEX_QUERY_BYTES {
            ACTIVE_SEARCHES.finish(&op_id, cancellation.as_ref());
            return Err(format!(
                "Regex pattern too long (max {} bytes)",
                MAX_REGEX_QUERY_BYTES
            ));
        }
        // Route user-supplied regex through build_safe_regex so the same
        // size/dfa ReDoS caps apply here as in search_files and the literal
        // content path. Previously this used a bare Regex::new with no limits.
        match build_safe_regex(&query, false) {
            Ok(regex) => Some(regex),
            Err(error) => {
                ACTIVE_SEARCHES.finish(&op_id, cancellation.as_ref());
                return Err(error);
            }
        }
    } else {
        match build_safe_regex(&regex::escape(&query), true) {
            Ok(regex) => Some(regex),
            Err(error) => {
                ACTIVE_SEARCHES.finish(&op_id, cancellation.as_ref());
                return Err(format!("Regex build error: {}", error));
            }
        }
    };

    let scan_cancellation = cancellation.clone();
    let result = tokio::task::spawn_blocking(move || {
        let _query = query;
        let mut results = Vec::new();
        let max_file_size: u64 = 10 * 1024 * 1024;

        for entry in WalkDir::new(&path)
            .max_depth(20)
            .follow_links(false)
            .into_iter()
            .filter_entry(|entry| allow_search_walk_entry(entry, include_hidden))
            .filter_map(|e| {
                e.map_err(|err| log::warn!("[Search] content walk error: {}", err))
                    .ok()
            })
        {
            if is_cancelled(scan_cancellation.as_ref()) {
                break;
            }

            let entry_path = entry.path();
            // Content search must never follow symlinks out of the requested
            // tree. WalkDir does not descend into links, but a metadata/open
            // sequence that follows one would still disclose an external
            // target's contents.
            let meta = match fs::symlink_metadata(entry_path) {
                Ok(m) => m,
                Err(_) => continue,
            };
            if meta.file_type().is_symlink() {
                continue;
            }
            if !matches_filters(entry_path, &meta, &parsed_filters) {
                continue;
            }

            if !meta.is_file() || meta.len() > max_file_size {
                continue;
            }

            // Don't scan/return snippets from secret files (ssh keys, .pem, credentials).
            let file = match open_content_search_file(entry_path) {
                Ok(f) => f,
                Err(_) => continue,
            };

            // Bound the bytes consumed from the opened handle as well as the
            // pre-open metadata check. A file can be replaced or grow between
            // lstat and open; without this Take wrapper a single large line
            // could make content search read unbounded data into memory.
            let reader = std::io::BufReader::new(file.take(max_file_size.saturating_add(1)));
            let mut matched_context: Option<String> = None;

            for line_result in reader.lines() {
                if is_cancelled(scan_cancellation.as_ref()) {
                    break;
                }
                let line = match line_result {
                    Ok(l) => l,
                    Err(_) => break, // binary or encoding error, skip file
                };
                if let Some(regex) = &regex {
                    if let Some(m) = regex.find(&line) {
                        let start = m.start();
                        let end = m.end();
                        matched_context = Some(snippet_around_match(&line, start, end, 50));
                        break;
                    }
                }
            }

            if is_cancelled(scan_cancellation.as_ref()) {
                break;
            }

            if let Some(context) = matched_context {
                results.push(make_search_result(
                    entry_path
                        .file_name()
                        .map(|n| n.to_string_lossy().to_string())
                        .unwrap_or_default(),
                    entry_path,
                    &meta,
                    Some(context),
                ));

                if results.len() >= 5000 {
                    break;
                }
            }
        }

        Ok(results)
    })
    .await;

    ACTIVE_SEARCHES.finish(&op_id, cancellation.as_ref());

    result.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn search_files_content_global(
    query: String,
    filters: Option<serde_json::Value>,
    operation_id: Option<String>,
    include_hidden: Option<bool>,
) -> Result<Vec<SearchResult>, String> {
    let home = directories::UserDirs::new()
        .map(|dirs| dirs.home_dir().to_string_lossy().to_string())
        .ok_or_else(|| "Could not determine home directory".to_string())?;

    search_files_content(home, query, filters, operation_id, include_hidden).await
}

#[tauri::command]
pub async fn cancel_search(operation_id: String) -> Result<(), String> {
    ACTIVE_SEARCHES.cancel(&operation_id);
    Ok(())
}

#[tauri::command]
pub async fn search_index(
    app: tauri::AppHandle,
    query: String,
    operation_id: Option<String>,
    filters: Option<serde_json::Value>,
    include_hidden: Option<bool>,
) -> Result<Vec<SearchResult>, String> {
    validate_query(&query)?;
    validate_filter_payload(filters.as_ref())?;
    let op_id = operation_id.unwrap_or_default();
    let cancellation = register_search_operation(&op_id)?;
    if !indexer::is_enabled() {
        ACTIVE_SEARCHES.finish(&op_id, cancellation.as_ref());
        return Err("Indexer is disabled".to_string());
    }
    let parsed_filters = parse_filters(filters);
    let regex = match build_index_search_regex(&query, &parsed_filters) {
        Ok(regex) => regex,
        Err(error) => {
            ACTIVE_SEARCHES.finish(&op_id, cancellation.as_ref());
            return Err(error);
        }
    };
    let index_filters = to_index_filters(&parsed_filters, include_hidden.unwrap_or(false), regex);
    // Lazy build on first search; poller reflects progress.
    indexer::ensure_index_built(&app);
    let scan_cancellation = cancellation.clone();
    let result = tokio::task::spawn_blocking(move || {
        indexer::search_in_index_filtered_cancellable(&query, &index_filters, || {
            is_cancelled(scan_cancellation.as_ref())
        })
    })
    .await;
    ACTIVE_SEARCHES.finish(&op_id, cancellation.as_ref());
    let results = result.map_err(|e| e.to_string())?;

    Ok(results
        .into_iter()
        .map(|e| SearchResult {
            extension: std::path::Path::new(&e.path)
                .extension()
                .map(|ext| ext.to_string_lossy().to_string())
                .unwrap_or_default(),
            is_hidden: e.is_hidden || is_hidden_name(&e.name),
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
    indexer::trigger_rebuild(&app).await;
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_query_is_rejected_before_scan() {
        assert_eq!(
            validate_query(""),
            Err("Search query cannot be empty".to_string())
        );
        assert!(validate_query(" ").is_ok());
    }

    #[test]
    fn snippet_uses_unicode_characters_not_match_byte_length() {
        let line = "aa日本語bb";
        let match_start = line.find("日本語").unwrap();
        let match_end = match_start + "日本語".len();
        assert_eq!(
            snippet_around_match(line, match_start, match_end, 1),
            "a日本語b"
        );
    }

    #[test]
    fn snippet_does_not_overshoot_ascii_matches() {
        let line = "abcdefghij";
        let match_start = 3; // 'd'
        let match_end = 4;
        assert_eq!(
            snippet_around_match(line, match_start, match_end, 2),
            "bcdef"
        );
    }

    fn write_tree() -> tempfile::TempDir {
        let temp = tempfile::tempdir().unwrap();
        fs::write(temp.path().join("readme.md"), "visible").unwrap();
        fs::write(temp.path().join(".secret"), "hidden file").unwrap();
        fs::create_dir(temp.path().join(".git")).unwrap();
        fs::write(temp.path().join(".git").join("config"), "git config").unwrap();
        fs::create_dir(temp.path().join("src")).unwrap();
        fs::write(temp.path().join("src").join("config"), "src config").unwrap();
        temp
    }

    #[test]
    fn name_search_skips_hidden_trees_when_hidden_off() {
        let temp = write_tree();
        let results = collect_name_search_results(
            temp.path(),
            "config",
            false,
            None,
            &ParsedFilters::default(),
            || false,
        )
        .unwrap();
        let names: Vec<_> = results.iter().map(|r| r.name.as_str()).collect();
        assert_eq!(names, ["config"]);
        assert!(results[0].path.replace('\\', "/").ends_with("src/config"));
        assert!(!results.iter().any(|r| r.path.contains(".git")));
        assert!(!results.iter().any(|r| r.name == ".secret"));
    }

    #[test]
    fn name_search_includes_hidden_trees_when_hidden_on() {
        let temp = write_tree();
        let results = collect_name_search_results(
            temp.path(),
            "config",
            true,
            None,
            &ParsedFilters::default(),
            || false,
        )
        .unwrap();
        assert!(results
            .iter()
            .any(|r| r.path.contains(".git") && !r.is_hidden));
        let git = results
            .iter()
            .find(|r| r.path.contains(".git"))
            .expect("git config");
        assert_eq!(git.name, "config");
        assert!(!git.is_hidden);
    }

    #[test]
    fn name_search_marks_dotfile_hidden() {
        let temp = write_tree();
        let results = collect_name_search_results(
            temp.path(),
            "secret",
            true,
            None,
            &ParsedFilters::default(),
            || false,
        )
        .unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].name, ".secret");
        assert!(results[0].is_hidden);
    }

    #[test]
    fn content_search_open_refuses_symlink() {
        let temp = tempfile::tempdir().unwrap();
        let target = temp.path().join("secret.txt");
        fs::write(&target, "needle").unwrap();
        let link = temp.path().join("visible.txt");
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&target, &link).unwrap();
            assert!(open_content_search_file(&link).is_err());
            assert!(open_content_search_file(&target).is_ok());
        }
        #[cfg(not(unix))]
        {
            let _ = (target, link);
        }
    }

    #[test]
    fn hidden_entry_detection_covers_dotfiles_without_metadata() {
        assert!(is_hidden_name(".bashrc"));
        assert!(!is_hidden_name("bashrc"));
        assert!(is_hidden_entry(".bashrc", Path::new("/home/u/.bashrc")));
    }

    #[test]
    fn hidden_entry_detection_reads_windows_file_attribute() {
        let temp = tempfile::tempdir().unwrap();
        let visible = temp.path().join("visible.txt");
        fs::write(&visible, "visible").unwrap();
        let meta = fs::symlink_metadata(&visible).unwrap();
        assert!(!has_hidden_attribute(&meta));
        assert!(!is_hidden_entry("visible.txt", &visible));

        #[cfg(target_os = "windows")]
        {
            crate::native_windows::update_file_attributes(&visible, None, Some(true), None)
                .unwrap();
            let hidden_meta = fs::symlink_metadata(&visible).unwrap();
            assert!(has_hidden_attribute(&hidden_meta));
            assert!(is_hidden_entry("visible.txt", &visible));
            assert!(
                make_search_result("visible.txt".to_string(), &visible, &hidden_meta, None)
                    .is_hidden
            );
        }
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn name_search_skips_windows_hidden_attribute_entries() {
        let temp = write_tree();
        let flagged = temp.path().join("flagged.txt");
        fs::write(&flagged, "flagged").unwrap();
        crate::native_windows::update_file_attributes(&flagged, None, Some(true), None).unwrap();

        let hidden_off = collect_name_search_results(
            temp.path(),
            "flagged",
            false,
            None,
            &ParsedFilters::default(),
            || false,
        )
        .unwrap();
        assert!(hidden_off.is_empty());

        let hidden_on = collect_name_search_results(
            temp.path(),
            "flagged",
            true,
            None,
            &ParsedFilters::default(),
            || false,
        )
        .unwrap();
        assert_eq!(hidden_on.len(), 1);
        assert!(hidden_on[0].is_hidden);
    }

    #[test]
    fn parse_filters_reads_bounds_types_dates_and_regex() {
        let parsed = parse_filters(Some(serde_json::json!({
            "fileType": " .PNG ",
            "minSize": 10,
            "maxSize": 2048,
            "dateFrom": "2024-01-02",
            "dateTo": "2024-01-03T04:05:06Z",
            "regex": true,
        })));

        assert_eq!(parsed.file_type.as_deref(), Some(".png"));
        assert_eq!(parsed.min_size, Some(10));
        assert_eq!(parsed.max_size, Some(2048));
        assert_eq!(
            parsed.date_from_ms,
            Some(
                Utc.with_ymd_and_hms(2024, 1, 2, 0, 0, 0)
                    .unwrap()
                    .timestamp_millis() as f64
            )
        );
        assert_eq!(
            parsed.date_to_ms,
            Some(
                Utc.with_ymd_and_hms(2024, 1, 3, 4, 5, 6)
                    .unwrap()
                    .timestamp_millis() as f64
            )
        );
        assert!(parsed.regex);
    }

    #[test]
    fn parse_filters_ignores_invalid_dates_and_defaults_regex_off() {
        let parsed = parse_filters(Some(serde_json::json!({
            "dateFrom": "not-a-date",
            "dateTo": "",
        })));
        assert!(parsed.date_from_ms.is_none());
        assert!(parsed.date_to_ms.is_none());
        assert!(!parsed.regex);
        assert_eq!(parse_filters(None).file_type, None);
    }

    #[test]
    fn index_filter_conversion_carries_all_parsed_fields() {
        let parsed = parse_filters(Some(serde_json::json!({
            "fileType": "txt",
            "minSize": 5,
            "maxSize": 50,
            "dateFrom": "2024-01-02",
            "dateTo": "2024-01-03",
        })));
        let regex = build_safe_regex(r"^notes", false).unwrap();
        let filters = to_index_filters(&parsed, true, Some(regex));

        assert!(filters.include_hidden);
        assert_eq!(filters.file_type.as_deref(), Some("txt"));
        assert_eq!(filters.min_size, Some(5));
        assert_eq!(filters.max_size, Some(50));
        assert_eq!(filters.date_from_ms, parsed.date_from_ms);
        assert_eq!(filters.date_to_ms, parsed.date_to_ms);
        assert!(filters.regex.is_some());
    }

    #[test]
    fn index_search_regex_is_skipped_when_not_requested() {
        let literal = build_index_search_regex("alpha", &ParsedFilters::default()).unwrap();
        assert!(literal.is_none());
    }

    #[test]
    fn index_search_regex_compiles_with_size_caps() {
        let parsed = ParsedFilters {
            regex: true,
            ..ParsedFilters::default()
        };
        let regex = build_index_search_regex(r"^alpha\.\d+$", &parsed)
            .unwrap()
            .expect("regex should compile");
        assert!(regex.is_match("alpha.42"));
        assert!(!regex.is_match("alpha.x"));
    }

    #[test]
    fn index_search_regex_rejects_oversized_pattern() {
        let parsed = ParsedFilters {
            regex: true,
            ..ParsedFilters::default()
        };
        let query = "a".repeat(MAX_REGEX_QUERY_BYTES + 1);
        let error = build_index_search_regex(&query, &parsed).unwrap_err();
        assert_eq!(
            error,
            format!(
                "Regex pattern too long (max {} bytes)",
                MAX_REGEX_QUERY_BYTES
            )
        );
    }

    #[test]
    fn index_search_regex_rejects_invalid_pattern() {
        let parsed = ParsedFilters {
            regex: true,
            ..ParsedFilters::default()
        };
        let error = build_index_search_regex("([unclosed", &parsed).unwrap_err();
        assert!(error.starts_with("Invalid regex"), "{error}");
    }
}
