use std::fs;
use std::io::Write;
use std::path::PathBuf;
use tauri::Manager;

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
    use sha2::{Sha256, Digest};
    let hash = Sha256::digest(file_path.as_bytes());
    hex::encode(&hash[..16])
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
    let dir = cache_dir(&app)?;
    let key = cache_key(&file_path);
    let thumb_path = dir.join(&key);

    let mut file = fs::File::create(&thumb_path).map_err(|e| e.to_string())?;
    file.write_all(data_url.as_bytes())
        .map_err(|e| e.to_string())?;
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

#[tauri::command]
pub fn get_thumbnail_cache_size(app: tauri::AppHandle) -> Result<u64, String> {
    let dir = cache_dir(&app)?;
    let mut total = 0u64;
    if let Ok(entries) = fs::read_dir(&dir) {
        for entry in entries.flatten() {
            if let Ok(meta) = entry.metadata() {
                total += meta.len();
            }
        }
    }
    Ok(total)
}
