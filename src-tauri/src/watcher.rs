use notify::event::{EventKind, ModifyKind};
use notify::{Event, RecursiveMode, Watcher};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::time::{Duration, Instant};
use tauri::Emitter;

pub struct DirectoryWatcher {
    _watcher: notify::RecommendedWatcher,
    _path: PathBuf,
}

static WATCH_EVENT_COUNTER: AtomicU64 = AtomicU64::new(1);

fn is_noise_change_path(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .map(|name| {
            let lower = name.to_ascii_lowercase();
            lower == ".ds_store" || lower == "thumbs.db" || lower == "desktop.ini"
        })
        .unwrap_or(false)
}

fn classify_directory_change_event(event: &Event, watch_path: &Path) -> (&'static str, Vec<String>) {
    let is_meaningful_kind = matches!(
        event.kind,
        EventKind::Create(_)
            | EventKind::Remove(_)
            | EventKind::Modify(ModifyKind::Data(_))
            | EventKind::Modify(ModifyKind::Name(_))
    );
    if !is_meaningful_kind {
        return ("ignored-kind", Vec::new());
    }

    if event.paths.is_empty() {
        return ("no-paths", Vec::new());
    }

    if matches!(event.kind, EventKind::Remove(_))
        && event.paths.iter().any(|p| p == watch_path)
    {
        return ("watched-dir-removed", Vec::new());
    }

    let relevant_paths = event
        .paths
        .iter()
        .filter(|event_path| *event_path != watch_path && !is_noise_change_path(event_path))
        .map(|event_path| event_path.to_string_lossy().to_string())
        .collect::<Vec<_>>();

    if relevant_paths.is_empty() {
        return ("noise-or-root-path", Vec::new());
    }

    ("emit", relevant_paths)
}

#[tauri::command]
pub fn watch_directory(
    dir_path: String,
    window: tauri::Window,
    state: tauri::State<'_, crate::AppState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let window_label = window.label().to_string();
    log::debug!("[Watcher] watch_directory request: {} (window={})", dir_path, window_label);
    let path = crate::validate_existing_path(&dir_path, "Directory")?;
    let path_display = path.to_string_lossy().to_string();

    // Build and start the new watcher BEFORE dropping the old one.
    // If watcher creation fails the existing watcher remains active.
    let (tx, rx) = mpsc::channel::<notify::Result<Event>>();
    let mut new_watcher = notify::recommended_watcher(tx).map_err(|e| e.to_string())?;
    new_watcher
        .watch(&path, RecursiveMode::NonRecursive)
        .map_err(|e| e.to_string())?;

    let watch_path = path.clone();
    log::debug!("[Watcher] Started watcher thread for {}", path_display);

    // Acquire the watcher map lock BEFORE spawning the thread so that
    // a concurrent unwatch_directory call cannot slip in between the
    // thread start and the map insertion.
    let mut w = state.watchers.lock().map_err(|e| e.to_string())?;
    if let Some(existing) = w.get(&window_label) {
        log::debug!(
            "[Watcher] Replacing existing watcher for window {}: {}",
            window_label,
            existing._path.display()
        );
    }

    std::thread::spawn(move || {
        let debounce_duration = Duration::from_millis(500);
        let startup_suppression_duration = Duration::from_millis(800);
        let watch_started_at = Instant::now();
        let mut last_emit = Instant::now() - debounce_duration;

        while let Ok(event) = rx.recv() {
            match event {
                Ok(event) => {
                    let event_id = WATCH_EVENT_COUNTER.fetch_add(1, Ordering::Relaxed);
                    let now = Instant::now();
                    let event_kind = format!("{:?}", event.kind);
                    let event_paths = event
                        .paths
                        .iter()
                        .map(|path| path.to_string_lossy().to_string())
                        .collect::<Vec<_>>();

                    if now.duration_since(watch_started_at) < startup_suppression_duration {
                        log::debug!(
                            "[Watcher] [{}] Suppressed startup event kind={} paths={:?}",
                            event_id,
                            event_kind,
                            event_paths
                        );
                        continue;
                    }
                    let (decision, relevant_paths) =
                        classify_directory_change_event(&event, &watch_path);
                    if decision == "watched-dir-removed" {
                        log::debug!(
                            "[Watcher] [{}] Watched directory removed, emitting watched-dir-removed",
                            event_id
                        );
                        let _ = app.emit(
                            "watched-dir-removed",
                            serde_json::json!({
                                "dirPath": watch_path.to_string_lossy(),
                            }),
                        );
                        break;
                    }
                    if decision != "emit" {
                        log::debug!(
                            "[Watcher] [{}] Ignored event decision={} kind={} paths={:?}",
                            event_id,
                            decision,
                            event_kind,
                            event_paths
                        );
                        continue;
                    }
                    let elapsed_since_last_emit = now.duration_since(last_emit);
                    if elapsed_since_last_emit < debounce_duration {
                        log::debug!(
                            "[Watcher] [{}] Debounced event ({}ms < {}ms) kind={} paths={:?}",
                            event_id,
                            elapsed_since_last_emit.as_millis(),
                            debounce_duration.as_millis(),
                            event_kind,
                            relevant_paths
                        );
                        continue;
                    }
                    last_emit = now;
                    log::debug!(
                        "[Watcher] [{}] Emitting directory-changed kind={} paths={:?}",
                        event_id,
                        event_kind,
                        relevant_paths
                    );
                    let _ = app.emit(
                        "directory-changed",
                        serde_json::json!({
                            "dirPath": watch_path.to_string_lossy(),
                            "eventId": event_id,
                            "eventKind": event_kind,
                            "eventPaths": relevant_paths,
                        }),
                    );
                }
                Err(error) => log::warn!("[Watcher] notify error: {}", error),
            }
        }
        log::debug!(
            "[Watcher] Watch channel closed for {}",
            watch_path.to_string_lossy()
        );
    });

    w.insert(window_label, DirectoryWatcher {
        _watcher: new_watcher,
        _path: path,
    });

    Ok(())
}

#[tauri::command]
pub fn unwatch_directory(
    window: tauri::Window,
    state: tauri::State<'_, crate::AppState>,
) -> Result<(), String> {
    let window_label = window.label().to_string();
    log::debug!("[Watcher] unwatch_directory request (window={})", window_label);
    let mut w = state.watchers.lock().map_err(|e| e.to_string())?;
    w.remove(&window_label);
    Ok(())
}
