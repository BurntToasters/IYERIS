use notify::event::{EventKind, ModifyKind};
use notify::{Event, RecursiveMode, Watcher};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager};

pub struct DirectoryWatcher {
    _watcher: notify::RecommendedWatcher,
    _path: PathBuf,
    watcher_id: u64,
}

static WATCH_EVENT_COUNTER: AtomicU64 = AtomicU64::new(1);
static WATCHER_COUNTER: AtomicU64 = AtomicU64::new(1);
const WATCH_OVERFLOW_LOG_INTERVAL: Duration = Duration::from_secs(5);

#[derive(Default)]
struct WatchOverflowReporter {
    dropped_since_report: u64,
    last_report: Option<Instant>,
}

impl WatchOverflowReporter {
    fn record_drop(&mut self, now: Instant) -> Option<u64> {
        self.dropped_since_report = self.dropped_since_report.saturating_add(1);
        let report_due = self
            .last_report
            .is_none_or(|last| now.duration_since(last) >= WATCH_OVERFLOW_LOG_INTERVAL);
        if !report_due {
            return None;
        }
        self.last_report = Some(now);
        Some(std::mem::take(&mut self.dropped_since_report))
    }
}

fn is_noise_change_path(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .map(|name| {
            let lower = name.to_ascii_lowercase();
            lower == ".ds_store" || lower == "thumbs.db" || lower == "desktop.ini"
        })
        .unwrap_or(false)
}

fn classify_directory_change_event(
    event: &Event,
    watch_path: &Path,
) -> (&'static str, Vec<String>) {
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

    if matches!(event.kind, EventKind::Remove(_)) && event.paths.iter().any(|p| p == watch_path) {
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

fn watcher_id_matches(existing_id: Option<u64>, watcher_id: u64) -> bool {
    existing_id == Some(watcher_id)
}

fn watcher_is_current(app: &tauri::AppHandle, window_label: &str, watcher_id: u64) -> bool {
    let Some(state) = app.try_state::<crate::AppState>() else {
        return false;
    };
    let is_current = match state.watchers.lock() {
        Ok(watchers) => watchers
            .get(window_label)
            .is_some_and(|existing| watcher_id_matches(Some(existing.watcher_id), watcher_id)),
        Err(poisoned) => {
            log::warn!("[Watcher] watcher map mutex poisoned while checking identity");
            poisoned
                .into_inner()
                .get(window_label)
                .is_some_and(|existing| watcher_id_matches(Some(existing.watcher_id), watcher_id))
        }
    };
    is_current
}

fn emit_pending_if_current(
    app: &tauri::AppHandle,
    window_label: &str,
    watcher_id: u64,
    watch_path: &Path,
    pending: &mut Option<(u64, String, Vec<String>)>,
) {
    let Some((event_id, event_kind, event_paths)) = pending.take() else {
        return;
    };
    let Some(state) = app.try_state::<crate::AppState>() else {
        return;
    };
    // Keep the identity guard locked through the emit. A replacement can
    // otherwise land between the check and the event dispatch.
    let watchers = match state.watchers.lock() {
        Ok(watchers) => watchers,
        Err(poisoned) => {
            log::warn!("[Watcher] watcher map mutex poisoned while emitting");
            poisoned.into_inner()
        }
    };
    if !watchers
        .get(window_label)
        .is_some_and(|existing| watcher_id_matches(Some(existing.watcher_id), watcher_id))
    {
        log::debug!(
            "[Watcher] [{}] Dropping pending event from replaced watcher",
            event_id
        );
        return;
    }
    log::debug!(
        "[Watcher] [{}] Emitting directory-changed kind={} paths={:?}",
        event_id,
        event_kind,
        event_paths
    );
    if let Err(e) = app.emit(
        "directory-changed",
        serde_json::json!({
            "dirPath": watch_path.to_string_lossy(),
            "eventId": event_id,
            "eventKind": event_kind,
            "eventPaths": event_paths,
        }),
    ) {
        log::warn!("[Watcher] Failed to emit directory-changed: {}", e);
    }
}

fn emit_watched_dir_removed_if_current(
    app: &tauri::AppHandle,
    window_label: &str,
    watcher_id: u64,
    watch_path: &Path,
) -> bool {
    let Some(state) = app.try_state::<crate::AppState>() else {
        return false;
    };
    let mut watchers = match state.watchers.lock() {
        Ok(watchers) => watchers,
        Err(poisoned) => {
            log::warn!("[Watcher] watcher map mutex poisoned while handling removal");
            poisoned.into_inner()
        }
    };
    if !watchers
        .get(window_label)
        .is_some_and(|existing| watcher_id_matches(Some(existing.watcher_id), watcher_id))
    {
        return false;
    }
    if let Err(e) = app.emit(
        "watched-dir-removed",
        serde_json::json!({
            "dirPath": watch_path.to_string_lossy(),
        }),
    ) {
        log::warn!("[Watcher] Failed to emit watched-dir-removed: {}", e);
    }
    watchers.remove(window_label);
    true
}

#[tauri::command]
pub fn watch_directory(
    dir_path: String,
    window: tauri::Window,
    state: tauri::State<'_, crate::AppState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let window_label = window.label().to_string();
    log::debug!(
        "[Watcher] watch_directory request: {} (window={})",
        dir_path,
        window_label
    );
    let path = crate::validate_existing_path(&dir_path, "Directory")?;
    let metadata = std::fs::symlink_metadata(&path)
        .map_err(|error| format!("Cannot inspect watched path: {}", error))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("Watched path must be a real directory".to_string());
    }
    let path_display = path.to_string_lossy().to_string();

    // Build and start the new watcher BEFORE dropping the old one.
    // If watcher creation fails the existing watcher remains active.
    //
    // M5: previously this was an unbounded `mpsc::channel`. A noisy directory
    // (e.g. a tight touch loop, an unzip into the watched dir, build-system
    // churn) could fill the channel faster than the debouncer drains it,
    // growing heap until the consumer caught up. Now we use a bounded
    // sync_channel and drop overflow events. The debouncer's job is to coalesce
    // anyway, so dropping individual events is harmless — the next emit will
    // still trigger a refresh.
    const WATCH_CHANNEL_CAPACITY: usize = 1024;
    let (tx, rx) = mpsc::sync_channel::<notify::Result<Event>>(WATCH_CHANNEL_CAPACITY);
    let mut overflow_reporter = WatchOverflowReporter::default();
    let mut new_watcher = notify::recommended_watcher(move |res: notify::Result<Event>| {
        if let Err(e) = tx.try_send(res) {
            match e {
                mpsc::TrySendError::Full(_) => {
                    if let Some(dropped) = overflow_reporter.record_drop(Instant::now()) {
                        log::warn!(
                            "[Watcher] channel full ({} queued); dropped {} event(s) since last warning",
                            WATCH_CHANNEL_CAPACITY,
                            dropped
                        );
                    }
                }
                mpsc::TrySendError::Disconnected(_) => {
                    log::debug!("[Watcher] channel disconnected; watcher thread exiting");
                }
            }
        }
    })
    .map_err(|e| e.to_string())?;
    new_watcher
        .watch(&path, RecursiveMode::NonRecursive)
        .map_err(|e| e.to_string())?;

    let watch_path = path.clone();
    let thread_window_label = window_label.clone();
    let watcher_id = WATCHER_COUNTER.fetch_add(1, Ordering::Relaxed);
    log::debug!("[Watcher] Started watcher thread for {}", path_display);

    // Acquire the watcher map lock BEFORE spawning the thread so that
    // a concurrent unwatch_directory call cannot slip in between the
    // thread start and the map insertion.
    let mut w = state.watchers.lock().unwrap_or_else(|poisoned| {
        log::warn!("[Watcher] watcher map mutex poisoned while replacing; recovering");
        poisoned.into_inner()
    });
    if let Some(existing) = w.get(&window_label) {
        log::debug!(
            "[Watcher] Replacing existing watcher for window {}: {}",
            window_label,
            existing._path.display()
        );
    }

    std::thread::spawn(move || {
        let debounce_duration = Duration::from_millis(500);
        let mut pending: Option<(u64, String, Vec<String>)> = None;
        let mut last_relevant_event = Instant::now();
        let mut consecutive_errors: u32 = 0;
        const MAX_CONSECUTIVE_ERRORS: u32 = 5;

        let emit_pending = |pending: &mut Option<(u64, String, Vec<String>)>| {
            emit_pending_if_current(&app, &thread_window_label, watcher_id, &watch_path, pending);
        };

        loop {
            let wait = pending
                .as_ref()
                .map(|_| debounce_duration.saturating_sub(last_relevant_event.elapsed()))
                .unwrap_or(Duration::from_secs(1));
            let event = match rx.recv_timeout(wait) {
                Ok(event) => event,
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    emit_pending(&mut pending);
                    continue;
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            };

            // Flush the previous burst before handling an event that arrived
            // after the quiet period. This gives every burst a trailing emit,
            // instead of dropping the final change as the old leading-edge
            // debounce did.
            if pending.is_some() && last_relevant_event.elapsed() >= debounce_duration {
                emit_pending(&mut pending);
            }

            match event {
                Ok(event) => {
                    consecutive_errors = 0;
                    let event_id = WATCH_EVENT_COUNTER.fetch_add(1, Ordering::Relaxed);
                    let event_kind = format!("{:?}", event.kind);
                    let event_paths = event
                        .paths
                        .iter()
                        .map(|path| path.to_string_lossy().to_string())
                        .collect::<Vec<_>>();

                    let (decision, relevant_paths) =
                        classify_directory_change_event(&event, &watch_path);
                    if decision == "watched-dir-removed" {
                        // A removal notification supersedes any earlier
                        // debounced change. Do not emit a stale refresh after
                        // the UI has been told that the watched directory is
                        // gone.
                        pending = None;
                        log::debug!(
                            "[Watcher] [{}] Watched directory removed, emitting watched-dir-removed",
                            event_id
                        );
                        // Emit and remove only while holding the identity
                        // guard, so a replacement watcher cannot be told that
                        // its directory was removed by an older watcher.
                        let _ = emit_watched_dir_removed_if_current(
                            &app,
                            &thread_window_label,
                            watcher_id,
                            &watch_path,
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
                    last_relevant_event = Instant::now();
                    pending = Some((event_id, event_kind, relevant_paths));
                }
                Err(error) => {
                    log::warn!("[Watcher] notify error: {}", error);
                    consecutive_errors += 1;
                    if consecutive_errors >= MAX_CONSECUTIVE_ERRORS {
                        log::warn!(
                            "[Watcher] Aborting after {} consecutive errors for {}",
                            consecutive_errors,
                            watch_path.to_string_lossy()
                        );
                        break;
                    }
                }
            }
        }
        // A replaced watcher may disconnect after its successor is installed.
        // Do not flush that old watcher's pending event into the new stream.
        let is_current = watcher_is_current(&app, &thread_window_label, watcher_id);
        if is_current {
            emit_pending(&mut pending);
        }
        if let Some(state) = app.try_state::<crate::AppState>() {
            // Cleanup must still happen after a prior watcher operation
            // poisoned the map mutex; otherwise stale watcher entries leak
            // and future watches can be rejected or misidentified.
            let mut watchers = state.watchers.lock().unwrap_or_else(|poisoned| {
                log::warn!("[Watcher] watcher map mutex poisoned during cleanup; recovering");
                poisoned.into_inner()
            });
            if watchers
                .get(&thread_window_label)
                .map(|existing| existing.watcher_id == watcher_id)
                .unwrap_or(false)
            {
                watchers.remove(&thread_window_label);
            }
        }
        log::debug!(
            "[Watcher] Watch channel closed for {}",
            watch_path.to_string_lossy()
        );
    });

    w.insert(
        window_label,
        DirectoryWatcher {
            _watcher: new_watcher,
            _path: path,
            watcher_id,
        },
    );

    Ok(())
}

#[tauri::command]
pub fn unwatch_directory(
    window: tauri::Window,
    state: tauri::State<'_, crate::AppState>,
) -> Result<(), String> {
    let window_label = window.label().to_string();
    log::debug!(
        "[Watcher] unwatch_directory request (window={})",
        window_label
    );
    let mut w = state.watchers.lock().unwrap_or_else(|poisoned| {
        log::warn!("[Watcher] watcher map mutex poisoned while unwatching; recovering");
        poisoned.into_inner()
    });
    w.remove(&window_label);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn detects_os_noise_files() {
        assert!(is_noise_change_path(Path::new("/x/.DS_Store")));
        assert!(is_noise_change_path(Path::new("/x/Thumbs.db")));
        assert!(is_noise_change_path(Path::new("/x/desktop.ini")));
    }

    #[test]
    fn real_files_are_not_noise() {
        assert!(!is_noise_change_path(Path::new("/x/report.txt")));
        assert!(!is_noise_change_path(Path::new("/x/.ds_store_notes.md")));
    }

    #[test]
    fn watcher_identity_guard_rejects_replacements_and_missing_entries() {
        assert!(watcher_id_matches(Some(7), 7));
        assert!(!watcher_id_matches(Some(8), 7));
        assert!(!watcher_id_matches(None, 7));
    }

    #[test]
    fn overflow_warnings_are_rate_limited_and_aggregated() {
        let start = Instant::now();
        let mut reporter = WatchOverflowReporter::default();

        assert_eq!(reporter.record_drop(start), Some(1));
        assert_eq!(reporter.record_drop(start + Duration::from_secs(1)), None);
        assert_eq!(reporter.record_drop(start + Duration::from_secs(2)), None);
        assert_eq!(
            reporter.record_drop(start + WATCH_OVERFLOW_LOG_INTERVAL),
            Some(3)
        );
    }
}
