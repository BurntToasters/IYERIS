use notify::{Event, RecursiveMode, Watcher};
use std::path::PathBuf;
use std::sync::mpsc;
use tauri::Emitter;

pub struct DirectoryWatcher {
    _watcher: notify::RecommendedWatcher,
    _path: PathBuf,
}

#[tauri::command]
pub fn watch_directory(
    dir_path: String,
    state: tauri::State<'_, crate::AppState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let path = crate::validate_existing_path(&dir_path, "Directory")?;

    let (tx, rx) = mpsc::channel::<notify::Result<Event>>();
    let mut watcher = notify::recommended_watcher(tx).map_err(|e| e.to_string())?;
    watcher
        .watch(&path, RecursiveMode::NonRecursive)
        .map_err(|e| e.to_string())?;

    let watch_path = path.clone();
    std::thread::spawn(move || {
        while let Ok(event) = rx.recv() {
            if event.is_ok() {
                let _ = app.emit(
                    "directory-changed",
                    serde_json::json!({
                        "dirPath": watch_path.to_string_lossy(),
                    }),
                );
            }
        }
    });

    let mut w = state.watcher.lock().map_err(|e| e.to_string())?;
    *w = Some(DirectoryWatcher {
        _watcher: watcher,
        _path: path,
    });

    Ok(())
}

#[tauri::command]
pub fn unwatch_directory(
    state: tauri::State<'_, crate::AppState>,
) -> Result<(), String> {
    let mut w = state.watcher.lock().map_err(|e| e.to_string())?;
    *w = None;
    Ok(())
}
