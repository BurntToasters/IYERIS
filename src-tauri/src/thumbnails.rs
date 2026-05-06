use std::fs;
use std::io::Write;
use std::path::PathBuf;
use tauri::Manager;

const MAX_THUMBNAIL_BYTES: usize = 10 * 1024 * 1024;
const MAX_CACHE_BYTES: u64 = 256 * 1024 * 1024;
const MAX_CACHE_FILES: usize = 5000;

fn cache_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e: tauri::Error| e.to_string())?
        .join("thumbnails");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn cache_key(file_path: &str) -> String {
    use sha2::{Digest, Sha256};
    let hash = Sha256::digest(file_path.as_bytes());
    hex::encode(&hash[..16])
}

fn trim_cache_if_needed(dir: &PathBuf) -> Result<(), String> {
    let mut entries: Vec<(PathBuf, u64, std::time::SystemTime)> = Vec::new();
    let mut total_bytes = 0u64;

    for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = match entry {
            Ok(value) => value,
            Err(error) => {
                log::warn!("[Thumbnails] cache entry error: {}", error);
                continue;
            }
        };
        let metadata = match entry.metadata() {
            Ok(value) => value,
            Err(error) => {
                log::warn!("[Thumbnails] cache metadata error: {}", error);
                continue;
            }
        };
        if !metadata.is_file() {
            continue;
        }
        let modified = metadata.modified().unwrap_or(std::time::SystemTime::UNIX_EPOCH);
        total_bytes = total_bytes.saturating_add(metadata.len());
        entries.push((entry.path(), metadata.len(), modified));
    }

    let mut file_count = entries.len();

    if total_bytes <= MAX_CACHE_BYTES && file_count <= MAX_CACHE_FILES {
        return Ok(());
    }

    entries.sort_by_key(|(_, _, modified)| *modified);
    for (path, size, _) in entries {
        if total_bytes <= MAX_CACHE_BYTES && file_count <= MAX_CACHE_FILES {
            break;
        }
        if fs::remove_file(&path).is_ok() {
            total_bytes = total_bytes.saturating_sub(size);
            file_count -= 1;
        }
    }
    Ok(())
}

#[tauri::command]
pub fn get_cached_thumbnail(
    app: tauri::AppHandle,
    file_path: String,
) -> Result<Option<String>, String> {
    let dir = cache_dir(&app)?;
    let key = cache_key(&file_path);
    let thumb_path = dir.join(&key);

    match fs::read_to_string(&thumb_path) {
        Ok(data) => Ok(Some(data)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub fn save_cached_thumbnail(
    app: tauri::AppHandle,
    file_path: String,
    data_url: String,
) -> Result<(), String> {
    if data_url.len() > MAX_THUMBNAIL_BYTES {
        return Err("Thumbnail payload too large".to_string());
    }
    let dir = cache_dir(&app)?;
    let key = cache_key(&file_path);
    let thumb_path = dir.join(&key);

    let mut file = fs::File::create(&thumb_path).map_err(|e| e.to_string())?;
    file.write_all(data_url.as_bytes())
        .map_err(|e| e.to_string())?;
    trim_cache_if_needed(&dir)?;
    Ok(())
}

#[tauri::command]
pub fn clear_thumbnail_cache(app: tauri::AppHandle) -> Result<(), String> {
    let dir = cache_dir(&app)?;
    if dir.exists() {
        fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[derive(serde::Serialize)]
pub struct ThumbnailCacheInfo {
    #[serde(rename = "sizeBytes")]
    pub size_bytes: u64,
    #[serde(rename = "fileCount")]
    pub file_count: u64,
}

#[tauri::command]
pub fn get_thumbnail_cache_size(app: tauri::AppHandle) -> Result<ThumbnailCacheInfo, String> {
    let dir = cache_dir(&app)?;
    let mut total = 0u64;
    let mut count = 0u64;
    if let Ok(entries) = fs::read_dir(&dir) {
        for entry in entries.filter_map(|e| {
            e.map_err(|err| log::warn!("[Thumbnails] cache dir entry error: {}", err))
                .ok()
        }) {
            if let Ok(meta) = entry.metadata() {
                total += meta.len();
                count += 1;
            }
        }
    }
    Ok(ThumbnailCacheInfo {
        size_bytes: total,
        file_count: count,
    })
}
