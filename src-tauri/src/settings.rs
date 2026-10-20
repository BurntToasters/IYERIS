use std::fs;
use std::io::{Read, Write};
use std::sync::Mutex;
use tauri::{Emitter, Manager};

static SETTINGS_LOCK: std::sync::LazyLock<Mutex<()>> = std::sync::LazyLock::new(|| Mutex::new(()));
const MAX_SETTINGS_JSON_BYTES: u64 = 8 * 1024 * 1024;

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsSaveResult {
    pub status: String,
    pub settings: serde_json::Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub conflict_keys: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub changed_keys: Option<Vec<String>>,
}

#[derive(Debug)]
struct SettingsConflict {
    latest: serde_json::Value,
    keys: Vec<String>,
}

fn settings_revision(settings: &serde_json::Value) -> u64 {
    settings
        .get("_revision")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(0)
}

fn next_revision(settings: &serde_json::Value) -> u64 {
    settings_revision(settings).saturating_add(1)
}

fn replace_settings_full(
    current: &serde_json::Value,
    replacement: &serde_json::Value,
) -> serde_json::Value {
    let mut next = replacement.as_object().cloned().unwrap_or_default();
    next.remove("_revision");
    // Renderer timestamps are retained only for old settings-file compatibility;
    // they never participate in write ordering.
    next.remove("_timestamp");
    next.insert(
        "_revision".to_string(),
        serde_json::Value::from(next_revision(current)),
    );
    serde_json::Value::Object(next)
}

fn reset_settings_snapshot(current: &serde_json::Value) -> serde_json::Value {
    serde_json::json!({ "_revision": next_revision(current) })
}

fn merge_settings_patch(
    current: &serde_json::Value,
    expected_revision: u64,
    base_values: &serde_json::Value,
    patch: &serde_json::Value,
) -> Result<serde_json::Value, SettingsConflict> {
    let Some(patch) = patch.as_object() else {
        return Err(SettingsConflict {
            latest: current.clone(),
            keys: vec!["patch".to_string()],
        });
    };
    let Some(base_values) = base_values.as_object() else {
        return Err(SettingsConflict {
            latest: current.clone(),
            keys: vec!["baseValues".to_string()],
        });
    };
    let Some(mut next) = current.as_object().cloned() else {
        return Err(SettingsConflict {
            latest: current.clone(),
            keys: vec!["settings".to_string()],
        });
    };

    let current_revision = settings_revision(current);
    let mut conflicts = Vec::new();
    if expected_revision > current_revision {
        conflicts.push("_revision".to_string());
    }
    for key in patch.keys() {
        if matches!(key.as_str(), "_revision" | "_timestamp") {
            continue;
        }
        let patch_value = patch.get(key);
        if patch_value.is_some_and(serde_json::Value::is_null) {
            // A null patch value asks for key removal. Once the key is absent
            // (or already null) the requested state is reached, so a stale
            // delete is idempotent instead of conflicting.
            let current_value = current.get(key);
            if current_value.is_some_and(|value| !value.is_null())
                && current_value != base_values.get(key)
            {
                conflicts.push(key.clone());
            }
            continue;
        }
        if current.get(key) != base_values.get(key) && current.get(key) != patch_value {
            conflicts.push(key.clone());
        }
    }
    conflicts.sort();
    if !conflicts.is_empty() {
        return Err(SettingsConflict {
            latest: current.clone(),
            keys: conflicts,
        });
    }

    let mut applied = false;
    for (key, value) in patch {
        if matches!(key.as_str(), "_revision" | "_timestamp") {
            continue;
        }
        if value.is_null() {
            if next.remove(key).is_some() {
                applied = true;
            }
        } else if next.get(key) != Some(value) {
            next.insert(key.clone(), value.clone());
            applied = true;
        }
    }
    if applied {
        next.insert(
            "_revision".to_string(),
            serde_json::Value::from(next_revision(current)),
        );
    }
    Ok(serde_json::Value::Object(next))
}

fn legacy_full_save(
    current: &serde_json::Value,
    incoming: &serde_json::Value,
) -> Result<serde_json::Value, SettingsConflict> {
    if let Some(revision) = incoming
        .get("_revision")
        .and_then(serde_json::Value::as_u64)
    {
        if revision != settings_revision(current) {
            return Err(SettingsConflict {
                latest: current.clone(),
                keys: vec!["settings".to_string()],
            });
        }
    }
    Ok(replace_settings_full(current, incoming))
}

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
    crate::ensure_app_state_directory(&dir, "Settings directory")
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
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        // Restrict the staging file before any payload is written so a crash
        // cannot leave private settings readable under the process umask.
        if let Err(error) = file.set_permissions(fs::Permissions::from_mode(0o600)) {
            drop(file);
            let _ = fs::remove_file(&tmp);
            return Err(format!(
                "Failed to secure settings temporary file: {}",
                error
            ));
        }
    }
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
pub async fn save_settings(
    app: tauri::AppHandle,
    settings: String,
    expected_revision: Option<u64>,
    patch: Option<String>,
    base_values: Option<String>,
    replace: Option<bool>,
) -> Result<SettingsSaveResult, String> {
    tokio::task::spawn_blocking(move || {
        save_settings_sync(
            app,
            settings,
            expected_revision,
            patch,
            base_values,
            replace.unwrap_or(false),
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

fn save_settings_sync(
    app: tauri::AppHandle,
    settings: String,
    expected_revision: Option<u64>,
    patch: Option<String>,
    base_values: Option<String>,
    replace: bool,
) -> Result<SettingsSaveResult, String> {
    log::debug!("[Settings] save_settings ({} bytes)", settings.len());
    if settings.len() as u64 > MAX_SETTINGS_JSON_BYTES {
        return Err("Settings payload exceeds size limit".to_string());
    }
    let _lock = settings_lock();

    let incoming: serde_json::Value =
        serde_json::from_str(&settings).map_err(|e| format!("Invalid settings JSON: {}", e))?;
    let path = settings_path(&app)?;
    let current_json = read_json_file(&path, "{}")?;
    let current: serde_json::Value =
        serde_json::from_str(&current_json).map_err(|e| format!("Invalid settings JSON: {}", e))?;

    let canonical = if replace {
        if expected_revision.is_some_and(|revision| revision != settings_revision(&current)) {
            return Ok(SettingsSaveResult {
                status: "conflict".to_string(),
                settings: current,
                conflict_keys: Some(vec!["settings".to_string()]),
                changed_keys: Some(
                    incoming
                        .as_object()
                        .map(|values| {
                            values
                                .keys()
                                .filter(|key| !matches!(key.as_str(), "_revision" | "_timestamp"))
                                .cloned()
                                .collect()
                        })
                        .unwrap_or_default(),
                ),
            });
        }
        replace_settings_full(&current, &incoming)
    } else if let Some(patch_json) = patch {
        if patch_json.len() as u64 > MAX_SETTINGS_JSON_BYTES {
            return Err("Settings patch exceeds size limit".to_string());
        }
        let base_json =
            base_values.ok_or_else(|| "Settings patch is missing base values".to_string())?;
        if base_json.len() as u64 > MAX_SETTINGS_JSON_BYTES {
            return Err("Settings base values exceed size limit".to_string());
        }
        let parsed_patch = serde_json::from_str::<serde_json::Value>(&patch_json)
            .map_err(|e| format!("Invalid settings patch JSON: {}", e))?;
        let parsed_base = serde_json::from_str::<serde_json::Value>(&base_json)
            .map_err(|e| format!("Invalid settings base values JSON: {}", e))?;
        let expected_revision = expected_revision.unwrap_or(0);
        match merge_settings_patch(&current, expected_revision, &parsed_base, &parsed_patch) {
            Ok(settings) => settings,
            Err(conflict) => {
                return Ok(SettingsSaveResult {
                    status: "conflict".to_string(),
                    settings: conflict.latest,
                    conflict_keys: Some(conflict.keys),
                    changed_keys: Some(
                        parsed_patch
                            .as_object()
                            .map(|values| values.keys().cloned().collect())
                            .unwrap_or_default(),
                    ),
                })
            }
        }
    } else {
        match legacy_full_save(&current, &incoming) {
            Ok(settings) => settings,
            Err(conflict) => {
                return Ok(SettingsSaveResult {
                    status: "conflict".to_string(),
                    settings: conflict.latest,
                    conflict_keys: Some(conflict.keys),
                    changed_keys: Some(vec!["settings".to_string()]),
                })
            }
        }
    };
    let additional_index_locations = match canonical.get("additionalIndexLocations") {
        Some(value) => {
            let values = value
                .as_array()
                .ok_or_else(|| "Additional index locations must be a list".to_string())?;
            values
                .iter()
                .map(|value| {
                    value
                        .as_str()
                        .map(str::to_string)
                        .ok_or_else(|| "Additional index locations must be paths".to_string())
                })
                .collect::<Result<Vec<_>, _>>()?
        }
        None => Vec::new(),
    };
    crate::indexer::validate_additional_index_locations(&additional_index_locations)?;
    let canonical_json = serde_json::to_string(&canonical).map_err(|e| e.to_string())?;
    write_json_file(&path, &canonical_json)?;
    crate::indexer::set_additional_index_locations(additional_index_locations)?;

    let enable_indexer = canonical
        .get("enableIndexer")
        .and_then(|flag| flag.as_bool())
        .unwrap_or(true);

    let indexer_was_enabled = crate::indexer::is_enabled();

    let _ = app.emit("settings-changed", &canonical_json);
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

    Ok(SettingsSaveResult {
        status: "saved".to_string(),
        settings: canonical,
        conflict_keys: None,
        changed_keys: None,
    })
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
    let current_json = read_json_file(&path, "{}")?;
    let current: serde_json::Value =
        serde_json::from_str(&current_json).map_err(|e| format!("Invalid settings JSON: {}", e))?;
    let reset = reset_settings_snapshot(&current);
    let reset_json = serde_json::to_string(&reset).map_err(|e| e.to_string())?;
    write_json_file(&path, &reset_json)?;
    crate::indexer::set_additional_index_locations(Vec::new())?;
    let _ = app.emit("settings-changed", &reset_json);

    // Defaults enable indexing, so keep the live indexer's state aligned with
    // the reset snapshot while preserving lazy startup behavior.
    if !crate::indexer::is_enabled() {
        crate::indexer::set_enabled(true, None);
        crate::indexer::initialize_index(&app);
        crate::indexer::ensure_index_built(&app);
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
pub async fn save_home_settings(
    app: tauri::AppHandle,
    settings: String,
    expected_revision: Option<u64>,
    patch: Option<String>,
    base_values: Option<String>,
    replace: Option<bool>,
) -> Result<SettingsSaveResult, String> {
    tokio::task::spawn_blocking(move || {
        save_home_settings_sync(
            app,
            settings,
            expected_revision,
            patch,
            base_values,
            replace.unwrap_or(false),
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

fn save_home_settings_sync(
    app: tauri::AppHandle,
    settings: String,
    expected_revision: Option<u64>,
    patch: Option<String>,
    base_values: Option<String>,
    replace: bool,
) -> Result<SettingsSaveResult, String> {
    if settings.len() as u64 > MAX_SETTINGS_JSON_BYTES {
        return Err("Settings payload exceeds size limit".to_string());
    }
    let _lock = settings_lock();
    let incoming = serde_json::from_str::<serde_json::Value>(&settings)
        .map_err(|e| format!("Invalid home settings JSON: {}", e))?;
    let path = home_settings_path(&app)?;
    let current_json = read_json_file(&path, "{}")?;
    let current = serde_json::from_str::<serde_json::Value>(&current_json)
        .map_err(|e| format!("Invalid home settings JSON: {}", e))?;

    let canonical = if replace {
        if expected_revision.is_some_and(|revision| revision != settings_revision(&current)) {
            return Ok(SettingsSaveResult {
                status: "conflict".to_string(),
                settings: current,
                conflict_keys: Some(vec!["settings".to_string()]),
                changed_keys: Some(vec!["settings".to_string()]),
            });
        }
        replace_settings_full(&current, &incoming)
    } else if let Some(patch_json) = patch {
        if patch_json.len() as u64 > MAX_SETTINGS_JSON_BYTES {
            return Err("Home settings patch exceeds size limit".to_string());
        }
        let base_json =
            base_values.ok_or_else(|| "Home settings patch is missing base values".to_string())?;
        if base_json.len() as u64 > MAX_SETTINGS_JSON_BYTES {
            return Err("Home settings base values exceed size limit".to_string());
        }
        let parsed_patch = serde_json::from_str::<serde_json::Value>(&patch_json)
            .map_err(|e| format!("Invalid home settings patch JSON: {}", e))?;
        let parsed_base = serde_json::from_str::<serde_json::Value>(&base_json)
            .map_err(|e| format!("Invalid home settings base values JSON: {}", e))?;
        match merge_settings_patch(
            &current,
            expected_revision.unwrap_or(0),
            &parsed_base,
            &parsed_patch,
        ) {
            Ok(settings) => settings,
            Err(conflict) => {
                return Ok(SettingsSaveResult {
                    status: "conflict".to_string(),
                    settings: conflict.latest,
                    conflict_keys: Some(conflict.keys),
                    changed_keys: Some(
                        parsed_patch
                            .as_object()
                            .map(|values| values.keys().cloned().collect())
                            .unwrap_or_default(),
                    ),
                })
            }
        }
    } else {
        match legacy_full_save(&current, &incoming) {
            Ok(settings) => settings,
            Err(conflict) => {
                return Ok(SettingsSaveResult {
                    status: "conflict".to_string(),
                    settings: conflict.latest,
                    conflict_keys: Some(conflict.keys),
                    changed_keys: Some(vec!["settings".to_string()]),
                })
            }
        }
    };
    let canonical_json = serde_json::to_string(&canonical).map_err(|e| e.to_string())?;
    write_json_file(&path, &canonical_json)?;

    let _ = app.emit("home-settings-changed", &canonical_json);
    Ok(SettingsSaveResult {
        status: "saved".to_string(),
        settings: canonical,
        conflict_keys: None,
        changed_keys: None,
    })
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
    let current_json = read_json_file(&path, "{}")?;
    let current = serde_json::from_str::<serde_json::Value>(&current_json)
        .map_err(|e| format!("Invalid home settings JSON: {}", e))?;
    let reset = reset_settings_snapshot(&current);
    let reset_json = serde_json::to_string(&reset).map_err(|e| e.to_string())?;
    write_json_file(&path, &reset_json)?;
    let _ = app.emit("home-settings-changed", &reset_json);
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

#[cfg(test)]
mod tests {
    use serde_json::{json, Value};

    #[test]
    fn stale_independent_setting_patches_merge_monotonically() {
        let legacy = json!({
            "theme": "dark",
            "viewMode": "grid",
            "enableIndexer": false,
            "emptyState": true
        });

        let first = super::merge_settings_patch(
            &legacy,
            0,
            &json!({ "theme": "dark" }),
            &json!({ "theme": "light" }),
        )
        .expect("first patch should apply");
        let second = super::merge_settings_patch(
            &first,
            0,
            &json!({ "viewMode": "grid" }),
            &json!({ "viewMode": "list" }),
        )
        .expect("stale independent patch should merge");

        assert_eq!(second["theme"], "light");
        assert_eq!(second["viewMode"], "list");
        assert_eq!(second["enableIndexer"], false);
        assert_eq!(second["emptyState"], true);
        assert_eq!(super::settings_revision(&second), 2);
    }

    #[test]
    fn stale_independent_null_patch_deletes_without_conflict() {
        let current = json!({
            "theme": "dark",
            "optionalFlag": true,
            "viewMode": "grid",
            "_revision": 1
        });

        let deleted = super::merge_settings_patch(
            &current,
            1,
            &json!({ "optionalFlag": true }),
            &json!({ "optionalFlag": null }),
        )
        .expect("null patch should delete the key");
        assert!(deleted.get("optionalFlag").is_none());
        assert_eq!(deleted["theme"], "dark");
        assert_eq!(super::settings_revision(&deleted), 2);

        let merged = super::merge_settings_patch(
            &deleted,
            1,
            &json!({ "viewMode": "grid" }),
            &json!({ "viewMode": "list" }),
        )
        .expect("stale independent patch after a delete should merge");
        assert!(merged.get("optionalFlag").is_none());
        assert_eq!(merged["viewMode"], "list");
        assert_eq!(merged["theme"], "dark");
        assert_eq!(super::settings_revision(&merged), 3);

        let repeated = super::merge_settings_patch(
            &merged,
            1,
            &json!({ "optionalFlag": true }),
            &json!({ "optionalFlag": null }),
        )
        .expect("deleting an already absent key should be idempotent");
        assert!(repeated.get("optionalFlag").is_none());
        assert_eq!(super::settings_revision(&repeated), 3);
    }

    #[test]
    fn stale_null_patch_conflicts_when_current_value_changed() {
        let current = json!({ "optionalFlag": false, "_revision": 2 });
        let conflict = super::merge_settings_patch(
            &current,
            2,
            &json!({ "optionalFlag": true }),
            &json!({ "optionalFlag": null }),
        )
        .expect_err("changed current value must conflict with a stale delete");

        assert_eq!(conflict.keys, vec!["optionalFlag"]);
        assert_eq!(conflict.latest["optionalFlag"], false);
        assert_eq!(super::settings_revision(&conflict.latest), 2);
    }

    #[test]
    fn stale_same_setting_patch_returns_latest_canonical_settings() {
        let first = super::merge_settings_patch(
            &json!({ "theme": "dark" }),
            0,
            &json!({ "theme": "dark" }),
            &json!({ "theme": "light" }),
        )
        .expect("first patch should apply");
        let conflict = super::merge_settings_patch(
            &first,
            0,
            &json!({ "theme": "dark" }),
            &json!({ "theme": "nord" }),
        )
        .expect_err("same-key stale patch must conflict");

        assert_eq!(conflict.keys, vec!["theme"]);
        assert_eq!(conflict.latest["theme"], "light");
        assert_eq!(super::settings_revision(&conflict.latest), 1);
    }

    #[test]
    fn legacy_settings_without_revision_start_at_zero_and_ignore_timestamp() {
        let legacy: Value = serde_json::from_value(json!({ "theme": "dark", "_timestamp": 999 }))
            .expect("legacy JSON should parse");
        assert_eq!(super::settings_revision(&legacy), 0);
    }

    #[test]
    fn explicit_full_import_replacement_and_reset_advance_revision() {
        let current = json!({ "theme": "dark", "bookmarks": ["private"], "_revision": 4 });
        let imported = json!({ "theme": "nord", "viewMode": "list" });
        let replaced = super::replace_settings_full(&current, &imported);
        assert_eq!(replaced["theme"], "nord");
        assert_eq!(replaced["viewMode"], "list");
        assert!(replaced.get("bookmarks").is_none());
        assert_eq!(super::settings_revision(&replaced), 5);

        let reset = super::reset_settings_snapshot(&replaced);
        assert_eq!(reset.as_object().map(|settings| settings.len()), Some(1));
        assert_eq!(super::settings_revision(&reset), 6);
    }

    #[test]
    fn malformed_patch_is_rejected_without_changing_current_settings() {
        let current = json!({ "theme": "dark", "_revision": 2 });
        let result = super::merge_settings_patch(
            &current,
            2,
            &json!({ "theme": "dark" }),
            &json!(["not", "an", "object"]),
        );
        assert!(result.is_err());
        assert_eq!(current["theme"], "dark");
    }
}
