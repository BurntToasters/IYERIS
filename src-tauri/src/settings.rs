use std::fs;
use std::io::{Read, Write};
use std::sync::Mutex;
use tauri::{Emitter, Manager};

static SETTINGS_LOCK: std::sync::LazyLock<Mutex<()>> = std::sync::LazyLock::new(|| Mutex::new(()));
const MAX_SETTINGS_JSON_BYTES: u64 = 8 * 1024 * 1024;

fn settings_lock() -> std::sync::MutexGuard<'static, ()> {
    SETTINGS_LOCK.lock().unwrap_or_else(|poisoned| {
        log::warn!("[Settings] settings lock poisoned; recovering");
        poisoned.into_inner()
    })
}

fn open_settings_read(path: &std::path::Path) -> Result<fs::File, String> {
    crate::file_operations::open_regular_read(path)
}

fn settings_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e: tauri::Error| e.to_string())?;
    crate::ensure_real_directory_tree(&dir, "Settings directory")?;
    Ok(dir)
}

fn settings_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(settings_dir(app)?.join("settings.json"))
}

fn home_settings_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(settings_dir(app)?.join("home-settings.json"))
}

fn read_json_file(path: &std::path::Path, default: &str) -> Result<String, String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(default.to_string()),
        Err(e) => return Err(e.to_string()),
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("Settings path is not a regular file".to_string());
    }
    if metadata.len() > MAX_SETTINGS_JSON_BYTES {
        return Err("Settings file exceeds size limit".to_string());
    }
    let file = open_settings_read(path)?;
    let mut bytes = Vec::with_capacity(metadata.len().min(MAX_SETTINGS_JSON_BYTES) as usize);
    file.take(MAX_SETTINGS_JSON_BYTES.saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_SETTINGS_JSON_BYTES {
        return Err("Settings file exceeds size limit".to_string());
    }
    String::from_utf8(bytes).map_err(|e| format!("Settings file is not valid UTF-8: {}", e))
}

fn write_json_file(path: &std::path::Path, data: &str) -> Result<(), String> {
    if data.len() as u64 > MAX_SETTINGS_JSON_BYTES {
        return Err("Settings payload exceeds size limit".to_string());
    }
    if let Ok(metadata) = fs::symlink_metadata(path) {
        if metadata.file_type().is_symlink() {
            return Err("Refusing to overwrite a symbolic-link settings path".to_string());
        }
    }
    let (tmp, mut file) = crate::create_secure_temp_file(path, "settings")?;
    let write_result = (|| -> Result<(), String> {
        file.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        Ok(())
    })();
    drop(file);
    if let Err(error) = write_result {
        let _ = fs::remove_file(&tmp);
        return Err(error);
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let perms = fs::Permissions::from_mode(0o600);
        let _ = fs::set_permissions(&tmp, perms);
    }

    crate::atomic_replace_file(&tmp, path).inspect_err(|_| {
        let _ = fs::remove_file(&tmp);
    })
}

#[tauri::command]
pub async fn get_settings(app: tauri::AppHandle) -> Result<String, String> {
    tokio::task::spawn_blocking(move || get_settings_sync(app))
        .await
        .map_err(|error| error.to_string())?
}

pub(crate) fn get_settings_sync(app: tauri::AppHandle) -> Result<String, String> {
    let _lock = settings_lock();
    let path = settings_path(&app)?;
    read_json_file(&path, "{}")
}

#[tauri::command]
pub async fn save_settings(app: tauri::AppHandle, settings: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || save_settings_sync(app, settings))
        .await
        .map_err(|error| error.to_string())?
}

fn save_settings_sync(app: tauri::AppHandle, settings: String) -> Result<(), String> {
    log::debug!("[Settings] save_settings ({} bytes)", settings.len());
    if settings.len() as u64 > MAX_SETTINGS_JSON_BYTES {
        return Err("Settings payload exceeds size limit".to_string());
    }
    let _lock = settings_lock();

    let parsed: serde_json::Value =
        serde_json::from_str(&settings).map_err(|e| format!("Invalid settings JSON: {}", e))?;

    let path = settings_path(&app)?;
    write_json_file(&path, &settings)?;

    let enable_indexer = parsed
        .get("enableIndexer")
        .and_then(|flag| flag.as_bool())
        .unwrap_or(true);

    let indexer_was_enabled = crate::indexer::is_enabled();

    let _ = app.emit("settings-changed", &settings);
    // Keep the settings lock through the live-indexer reconciliation. Two
    // concurrent saves can otherwise persist in order but apply enable/disable
    // side effects out of order, leaving the running indexer inconsistent with
    // the last settings payload.
    if enable_indexer && !indexer_was_enabled {
        // Explicit enable: load + build now (launch stays lazy).
        crate::indexer::set_enabled(true, None);
        crate::indexer::initialize_index(&app);
        crate::indexer::ensure_index_built(&app);
    } else if !enable_indexer {
        crate::indexer::set_enabled(false, Some(&app));
    }

    Ok(())
}

#[tauri::command]
pub async fn reset_settings(app: tauri::AppHandle) -> Result<(), String> {
    tokio::task::spawn_blocking(move || reset_settings_sync(app))
        .await
        .map_err(|error| error.to_string())?
}

fn reset_settings_sync(app: tauri::AppHandle) -> Result<(), String> {
    let _lock = settings_lock();
    let path = settings_path(&app)?;
    match fs::symlink_metadata(&path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            return Err("Refusing to reset a symbolic-link settings path".to_string())
        }
        Ok(metadata) if metadata.is_file() => fs::remove_file(&path).map_err(|e| e.to_string())?,
        Ok(_) => return Err("Settings path is not a regular file".to_string()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.to_string()),
    }
    Ok(())
}

#[tauri::command]
pub async fn get_settings_path(app: tauri::AppHandle) -> Result<String, String> {
    tokio::task::spawn_blocking(move || get_settings_path_sync(app))
        .await
        .map_err(|error| error.to_string())?
}

fn get_settings_path_sync(app: tauri::AppHandle) -> Result<String, String> {
    settings_path(&app).map(|p| p.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn get_home_settings(app: tauri::AppHandle) -> Result<String, String> {
    tokio::task::spawn_blocking(move || get_home_settings_sync(app))
        .await
        .map_err(|error| error.to_string())?
}

fn get_home_settings_sync(app: tauri::AppHandle) -> Result<String, String> {
    let _lock = settings_lock();
    let path = home_settings_path(&app)?;
    read_json_file(&path, "{}")
}

#[tauri::command]
pub async fn save_home_settings(app: tauri::AppHandle, settings: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || save_home_settings_sync(app, settings))
        .await
        .map_err(|error| error.to_string())?
}

fn save_home_settings_sync(app: tauri::AppHandle, settings: String) -> Result<(), String> {
    if settings.len() as u64 > MAX_SETTINGS_JSON_BYTES {
        return Err("Settings payload exceeds size limit".to_string());
    }
    let _lock = settings_lock();
    serde_json::from_str::<serde_json::Value>(&settings)
        .map_err(|e| format!("Invalid home settings JSON: {}", e))?;
    let path = home_settings_path(&app)?;
    write_json_file(&path, &settings)?;

    let _ = app.emit("home-settings-changed", &settings);
    Ok(())
}

#[tauri::command]
pub async fn reset_home_settings(app: tauri::AppHandle) -> Result<(), String> {
    tokio::task::spawn_blocking(move || reset_home_settings_sync(app))
        .await
        .map_err(|error| error.to_string())?
}

fn reset_home_settings_sync(app: tauri::AppHandle) -> Result<(), String> {
    let _lock = settings_lock();
    let path = home_settings_path(&app)?;
    match fs::symlink_metadata(&path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            return Err("Refusing to reset a symbolic-link home settings path".to_string())
        }
        Ok(metadata) if metadata.is_file() => fs::remove_file(&path).map_err(|e| e.to_string())?,
        Ok(_) => return Err("Home settings path is not a regular file".to_string()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.to_string()),
    }
    Ok(())
}

#[tauri::command]
pub async fn get_home_settings_path(app: tauri::AppHandle) -> Result<String, String> {
    tokio::task::spawn_blocking(move || get_home_settings_path_sync(app))
        .await
        .map_err(|error| error.to_string())?
}

fn get_home_settings_path_sync(app: tauri::AppHandle) -> Result<String, String> {
    home_settings_path(&app).map(|p| p.to_string_lossy().to_string())
}
