use notify::event::{EventKind, ModifyKind};
use notify::{Event, RecursiveMode, Watcher};
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::{Duration, Instant};
use tauri::Emitter;

pub struct DirectoryWatcher {
    _watcher: notify::RecommendedWatcher,
    _path: PathBuf,
}

fn should_emit_directory_change(event: &Event, watch_path: &Path) -> bool {
    let emits_for_kind = matches!(
        event.kind,
        EventKind::Any
            | EventKind::Create(_)
            | EventKind::Remove(_)
            | EventKind::Modify(ModifyKind::Any)
            | EventKind::Modify(ModifyKind::Data(_))
            | EventKind::Modify(ModifyKind::Name(_))
    );
    if !emits_for_kind {
        return false;
    }

    if event.paths.is_empty() {
        return true;
    }

    event.paths.iter().any(|event_path| event_path != watch_path)
}

#[tauri::command]
pub fn watch_directory(
    dir_path: String,
    state: tauri::State<'_, crate::AppState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    log::debug!("[Watcher] watch_directory: {}", dir_path);
    let path = crate::validate_existing_path(&dir_path, "Directory")?;

    // Drop existing watcher first to prevent duplicate watchers
    {
        let mut w = state.watcher.lock().map_err(|e| e.to_string())?;
        *w = None;
    }

    let (tx, rx) = mpsc::channel::<notify::Result<Event>>();
    let mut watcher = notify::recommended_watcher(tx).map_err(|e| e.to_string())?;
    watcher
        .watch(&path, RecursiveMode::NonRecursive)
        .map_err(|e| e.to_string())?;

    let watch_path = path.clone();
    std::thread::spawn(move || {
        let debounce_duration = Duration::from_millis(500);
        let startup_suppression_duration = Duration::from_millis(800);
        let watch_started_at = Instant::now();
        let mut last_emit = Instant::now() - debounce_duration;

        while let Ok(event) = rx.recv() {
            match event {
                Ok(event) => {
                    let now = Instant::now();
                    if now.duration_since(watch_started_at) < startup_suppression_duration {
                        continue;
                    }
                    if !should_emit_directory_change(&event, &watch_path) {
                        continue;
                    }
                    if now.duration_since(last_emit) >= debounce_duration {
                        last_emit = now;
                        let _ = app.emit(
                            "directory-changed",
                            serde_json::json!({
                                "dirPath": watch_path.to_string_lossy(),
                            }),
                        );
                    }
                }
                Err(error) => log::warn!("[Watcher] notify error: {}", error),
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
