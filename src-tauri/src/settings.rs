use std::fs;
use std::io::Write;
use std::sync::Mutex;
use tauri::{Emitter, Manager};

static SETTINGS_LOCK: std::sync::LazyLock<Mutex<()>> =
    std::sync::LazyLock::new(|| Mutex::new(()));

fn settings_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e: tauri::Error| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn settings_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(settings_dir(app)?.join("settings.json"))
}

fn home_settings_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(settings_dir(app)?.join("home-settings.json"))
}

fn read_json_file(path: &std::path::Path, default: &str) -> Result<String, String> {
    match fs::read_to_string(path) {
        Ok(content) => Ok(content),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(default.to_string()),
        Err(e) => Err(e.to_string()),
    }
}

fn write_json_file(path: &std::path::Path, data: &str) -> Result<(), String> {
    let tmp = crate::make_temp_path(path, "settings");
    let mut file = fs::File::create(&tmp).map_err(|e| e.to_string())?;
    file.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
    file.sync_all().map_err(|e| e.to_string())?;
    drop(file);
    fs::rename(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        e.to_string()
    })
}

#[tauri::command]
pub fn get_settings(app: tauri::AppHandle) -> Result<String, String> {
    let _lock = SETTINGS_LOCK.lock().map_err(|e| e.to_string())?;
    let path = settings_path(&app)?;
    read_json_file(&path, "{}")
}

#[tauri::command]
pub fn save_settings(app: tauri::AppHandle, settings: String) -> Result<(), String> {
    log::debug!("[Settings] save_settings ({} bytes)", settings.len());
    let _lock = SETTINGS_LOCK.lock().map_err(|e| e.to_string())?;

    let parsed: serde_json::Value = serde_json::from_str(&settings)
        .map_err(|e| format!("Invalid settings JSON: {}", e))?;

    let path = settings_path(&app)?;
    write_json_file(&path, &settings)?;

    let enable_indexer = parsed.get("enableIndexer")
        .and_then(|flag| flag.as_bool())
        .unwrap_or(true);

    let _ = app.emit("settings-changed", &settings);
    drop(_lock);

    if enable_indexer {
        crate::indexer::initialize_index(&app);
    } else {
        crate::indexer::cancel_build();
    }

    Ok(())
}

#[tauri::command]
pub fn reset_settings(app: tauri::AppHandle) -> Result<(), String> {
    let _lock = SETTINGS_LOCK.lock().map_err(|e| e.to_string())?;
    let path = settings_path(&app)?;
    if path.exists() {
        fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn get_settings_path(app: tauri::AppHandle) -> Result<String, String> {
    settings_path(&app).map(|p| p.to_string_lossy().to_string())
}

#[tauri::command]
pub fn get_home_settings(app: tauri::AppHandle) -> Result<String, String> {
    let _lock = SETTINGS_LOCK.lock().map_err(|e| e.to_string())?;
    let path = home_settings_path(&app)?;
    read_json_file(&path, "{}")
}

#[tauri::command]
pub fn save_home_settings(app: tauri::AppHandle, settings: String) -> Result<(), String> {
    let _lock = SETTINGS_LOCK.lock().map_err(|e| e.to_string())?;
    serde_json::from_str::<serde_json::Value>(&settings)
        .map_err(|e| format!("Invalid home settings JSON: {}", e))?;
    let path = home_settings_path(&app)?;
    write_json_file(&path, &settings)?;

    let _ = app.emit("home-settings-changed", &settings);
    Ok(())
}

#[tauri::command]
pub fn reset_home_settings(app: tauri::AppHandle) -> Result<(), String> {
    let _lock = SETTINGS_LOCK.lock().map_err(|e| e.to_string())?;
    let path = home_settings_path(&app)?;
    if path.exists() {
        fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn get_home_settings_path(app: tauri::AppHandle) -> Result<String, String> {
    home_settings_path(&app).map(|p| p.to_string_lossy().to_string())
}
