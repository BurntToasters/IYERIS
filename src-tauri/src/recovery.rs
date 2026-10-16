use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

pub const MAX_JOURNAL_BYTES: usize = 4 * 1024 * 1024;
const MAX_RECORDS: usize = 512;
const MAX_PATHS_PER_RECORD: usize = 10_000;
const MAX_PATH_BYTES: usize = 32 * 1024;
const MAX_RECORD_PATH_BYTES: usize = 2 * 1024 * 1024;
const MAX_ERRORS_PER_RECORD: usize = 64;
const MAX_ERROR_BYTES: usize = 4096;

static RECORD_COUNTER: AtomicU64 = AtomicU64::new(1);
static GLOBAL_JOURNAL: LazyLock<Mutex<Option<Result<Arc<RecoveryJournal>, String>>>> =
    LazyLock::new(|| Mutex::new(None));
#[cfg(test)]
static TEST_JOURNAL: LazyLock<Result<(tempfile::TempDir, Arc<RecoveryJournal>), String>> =
    LazyLock::new(|| {
        let directory = tempfile::tempdir().map_err(|error| error.to_string())?;
        let journal = Arc::new(RecoveryJournal::open(&directory.path().join("journal.json"))?);
        Ok((directory, journal))
    });

#[derive(Debug, Clone, Default)]
pub(crate) struct RecoveryPaths {
    pub staging: Vec<PathBuf>,
    pub backups: Vec<PathBuf>,
    pub retained: Vec<PathBuf>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryRecord {
    pub id: String,
    pub operation_id: Option<String>,
    pub kind: String,
    pub status: String,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
    pub source_paths: Vec<String>,
    pub destination_paths: Vec<String>,
    pub staging_paths: Vec<String>,
    pub backup_paths: Vec<String>,
    pub retained_paths: Vec<String>,
    pub errors: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize)]
struct JournalFile {
    version: u32,
    records: Vec<RecoveryRecord>,
}

struct JournalState {
    records: Vec<RecoveryRecord>,
}

pub struct RecoveryJournal {
    path: PathBuf,
    state: Mutex<JournalState>,
}

impl RecoveryJournal {
    pub fn open(path: &Path) -> Result<Self, String> {
        let parent = path
            .parent()
            .ok_or_else(|| "Recovery journal has no parent directory".to_string())?;
        crate::ensure_real_directory_tree(parent, "Recovery state")?;
        crate::ensure_no_symlink_components(parent, "Recovery state")?;
        let records = match fs::symlink_metadata(path) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() || !metadata.is_file() {
                    return Err("Recovery journal is not a regular file".to_string());
                }
                if metadata.len() > MAX_JOURNAL_BYTES as u64 {
                    return Err("Recovery journal exceeds its size limit".to_string());
                }
                let bytes = fs::read(path).map_err(|error| error.to_string())?;
                if bytes.len() > MAX_JOURNAL_BYTES {
                    return Err("Recovery journal exceeds its size limit".to_string());
                }
                let file: JournalFile = serde_json::from_slice(&bytes)
                    .map_err(|error| format!("Recovery journal is invalid: {}", error))?;
                if file.version != 1 {
                    return Err("Recovery journal version is unsupported".to_string());
                }
                validate_records(file.records)?
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(error) => return Err(error.to_string()),
        };
        Ok(Self {
            path: path.to_path_buf(),
            state: Mutex::new(JournalState { records }),
        })
    }

    fn state(&self) -> std::sync::MutexGuard<'_, JournalState> {
        self.state.lock().unwrap_or_else(|poisoned| {
            log::warn!("[Recovery] journal mutex poisoned; recovering");
            poisoned.into_inner()
        })
    }

    fn persist(&self, records: &[RecoveryRecord]) -> Result<(), String> {
        if records.len() > MAX_RECORDS {
            return Err("Recovery journal has too many records".to_string());
        }
        let payload = serde_json::to_vec(&JournalFile {
            version: 1,
            records: records.to_vec(),
        })
        .map_err(|error| error.to_string())?;
        if payload.len() > MAX_JOURNAL_BYTES {
            return Err("Recovery journal exceeds its size limit".to_string());
        }
        let (temporary, mut file) = crate::create_secure_temp_file(&self.path, "recovery")?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            file.set_permissions(fs::Permissions::from_mode(0o600))
                .map_err(|error| format!("Cannot secure recovery journal: {}", error))?;
        }
        file.write_all(&payload)
            .map_err(|error| format!("Cannot write recovery journal: {}", error))?;
        file.sync_all()
            .map_err(|error| format!("Cannot flush recovery journal: {}", error))?;
        drop(file);
        crate::atomic_replace_file(&temporary, &self.path)?;
        #[cfg(unix)]
        if let Some(parent) = self.path.parent() {
            fs::File::open(parent)
                .and_then(|directory| directory.sync_all())
                .map_err(|error| format!("Cannot flush recovery directory: {}", error))?;
        }
        Ok(())
    }

    fn update_record(
        &self,
        id: &str,
        update: impl FnOnce(&mut RecoveryRecord) -> Result<(), String>,
    ) -> Result<(), String> {
        let mut state = self.state();
        let mut records = state.records.clone();
        let record = records
            .iter_mut()
            .find(|record| record.id == id)
            .ok_or_else(|| "Recovery record was not found".to_string())?;
        update(record)?;
        record.updated_at_ms = current_time_ms();
        validate_record(record)?;
        self.persist(&records)?;
        state.records = records;
        Ok(())
    }

    pub fn begin_operation(
        &self,
        kind: &str,
        operation_id: Option<&str>,
        sources: &[PathBuf],
        destinations: &[PathBuf],
    ) -> Result<String, String> {
        if !matches!(kind, "copy" | "move" | "copy-undo" | "move-undo" | "recovery") {
            return Err("Recovery operation kind is unsupported".to_string());
        }
        if operation_id.is_some_and(|id| id.len() > 256 || id.contains('\0')) {
            return Err("Recovery operation ID is invalid".to_string());
        }
        let now = current_time_ms();
        let counter = RECORD_COUNTER.fetch_add(1, Ordering::Relaxed);
        let id = format!("recovery-{}-{}-{}", std::process::id(), now, counter);
        let record = RecoveryRecord {
            id: id.clone(),
            operation_id: operation_id.map(str::to_string),
            kind: kind.to_string(),
            status: "inProgress".to_string(),
            created_at_ms: now,
            updated_at_ms: now,
            source_paths: path_strings(sources)?,
            destination_paths: path_strings(destinations)?,
            staging_paths: Vec::new(),
            backup_paths: Vec::new(),
            retained_paths: Vec::new(),
            errors: Vec::new(),
        };
        validate_record(&record)?;
        let mut state = self.state();
        let mut records = state.records.clone();
        records.retain(|record| {
            !matches!(record.status.as_str(), "complete" | "acknowledged")
                || !terminal_record_has_no_retained_paths(record)
        });
        if records.len() >= MAX_RECORDS {
            return Err("Recovery journal is full; acknowledge or finish old records first".to_string());
        }
        records.push(record);
        self.persist(&records)?;
        state.records = records;
        Ok(id)
    }

    pub fn record_paths(&self, id: &str, paths: RecoveryPaths) -> Result<(), String> {
        self.update_record(id, |record| {
            merge_paths(&mut record.staging_paths, &paths.staging)?;
            merge_paths(&mut record.backup_paths, &paths.backups)?;
            merge_paths(&mut record.retained_paths, &paths.retained)?;
            if matches!(record.status.as_str(), "complete" | "acknowledged") {
                record.status = "inProgress".to_string();
            }
            Ok(())
        })
    }

    pub fn record_error(&self, id: &str, error: &str) -> Result<(), String> {
        let message = bounded_error(error);
        self.update_record(id, |record| {
            record.status = "needsAttention".to_string();
            if !record.errors.contains(&message) && record.errors.len() < MAX_ERRORS_PER_RECORD {
                record.errors.push(message);
            }
            Ok(())
        })
    }

    pub fn mark_history_owned(&self, id: &str, backups: &[PathBuf]) -> Result<(), String> {
        self.update_record(id, |record| {
            merge_paths(&mut record.backup_paths, backups)?;
            record.status = if record.backup_paths.is_empty() {
                "complete".to_string()
            } else {
                "historyOwned".to_string()
            };
            Ok(())
        })
    }

    pub fn complete(&self, id: &str) -> Result<(), String> {
        let record = self
            .state()
            .records
            .iter()
            .find(|record| record.id == id)
            .cloned()
            .ok_or_else(|| "Recovery record was not found".to_string())?;
        for path in record
            .staging_paths
            .iter()
            .chain(record.backup_paths.iter())
            .chain(record.retained_paths.iter())
        {
            match fs::symlink_metadata(path) {
                Ok(_) => {
                    return Err(format!(
                        "Recovery data remains at {}; record stays unfinished",
                        path
                    ));
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => {
                    return Err(format!(
                        "Cannot verify recovery path {}; record stays unfinished: {}",
                        path, error
                    ));
                }
            }
        }
        self.update_record(id, |record| {
            record.status = "complete".to_string();
            Ok(())
        })
    }

    pub fn acknowledge(&self, id: &str) -> Result<(), String> {
        self.update_record(id, |record| {
            record.status = "acknowledged".to_string();
            Ok(())
        })
    }

    pub fn list_unfinished(&self) -> Result<Vec<RecoveryRecord>, String> {
        Ok(self
            .state()
            .records
            .iter()
            .filter(|record| !matches!(record.status.as_str(), "complete" | "acknowledged"))
            .cloned()
            .collect())
    }

    fn records_referencing(&self, paths: &[PathBuf]) -> Vec<String> {
        let keys: HashSet<String> = paths
            .iter()
            .map(|path| path.to_string_lossy().into_owned())
            .collect();
        self.state()
            .records
            .iter()
            .filter(|record| {
                record
                    .backup_paths
                    .iter()
                    .chain(record.staging_paths.iter())
                    .chain(record.retained_paths.iter())
                    .any(|path| keys.contains(path))
            })
            .map(|record| record.id.clone())
            .collect()
    }

    fn complete_if_retained_paths_are_absent(&self, id: &str) -> Result<(), String> {
        let record = self
            .state()
            .records
            .iter()
            .find(|record| record.id == id)
            .cloned()
            .ok_or_else(|| "Recovery record was not found".to_string())?;
        for path in record
            .staging_paths
            .iter()
            .chain(record.backup_paths.iter())
            .chain(record.retained_paths.iter())
        {
            match fs::symlink_metadata(path) {
                Ok(_) => return Ok(()),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => return Ok(()),
            }
        }
        self.complete(id)
    }
}

fn current_time_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}

fn terminal_record_has_no_retained_paths(record: &RecoveryRecord) -> bool {
    record
        .backup_paths
        .iter()
        .chain(record.staging_paths.iter())
        .chain(record.retained_paths.iter())
        .all(|path| match fs::symlink_metadata(path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => true,
            Ok(_) | Err(_) => false,
        })
}

fn path_strings(paths: &[PathBuf]) -> Result<Vec<String>, String> {
    if paths.len() > MAX_PATHS_PER_RECORD {
        return Err("Recovery record has too many paths".to_string());
    }
    let values = paths
        .iter()
        .map(|path| path.to_string_lossy().into_owned())
        .collect::<Vec<_>>();
    validate_paths(&values)?;
    Ok(values)
}

fn merge_paths(target: &mut Vec<String>, paths: &[PathBuf]) -> Result<(), String> {
    let mut seen: HashSet<String> = target.iter().cloned().collect();
    for path in path_strings(paths)? {
        if seen.insert(path.clone()) {
            target.push(path);
        }
    }
    validate_paths(target)
}

fn validate_paths(paths: &[String]) -> Result<(), String> {
    if paths.len() > MAX_PATHS_PER_RECORD
        || paths.iter().any(|path| path.len() > MAX_PATH_BYTES || path.contains('\0'))
        || paths.iter().map(String::len).sum::<usize>() > MAX_RECORD_PATH_BYTES
    {
        return Err("Recovery record paths exceed their limits".to_string());
    }
    Ok(())
}

fn bounded_error(error: &str) -> String {
    error.chars().take(MAX_ERROR_BYTES).collect()
}

fn validate_record(record: &RecoveryRecord) -> Result<(), String> {
    if record.id.is_empty()
        || record.id.len() > 256
        || record.id.contains('\0')
        || record.kind.len() > 64
        || record.status.len() > 64
        || record.operation_id.as_ref().is_some_and(|id| id.len() > 256 || id.contains('\0'))
        || record.errors.len() > MAX_ERRORS_PER_RECORD
        || record.errors.iter().any(|error| error.len() > MAX_ERROR_BYTES)
    {
        return Err("Recovery record contains invalid metadata".to_string());
    }
    validate_paths(&record.source_paths)?;
    validate_paths(&record.destination_paths)?;
    validate_paths(&record.staging_paths)?;
    validate_paths(&record.backup_paths)?;
    validate_paths(&record.retained_paths)?;
    Ok(())
}

fn validate_records(records: Vec<RecoveryRecord>) -> Result<Vec<RecoveryRecord>, String> {
    if records.len() > MAX_RECORDS {
        return Err("Recovery journal has too many records".to_string());
    }
    let mut ids = HashSet::new();
    for record in &records {
        validate_record(record)?;
        if !ids.insert(record.id.clone()) {
            return Err("Recovery journal contains duplicate record IDs".to_string());
        }
    }
    Ok(records)
}

pub fn initialize_app_data(app_data: &Path) -> Result<(), String> {
    let result = (|| {
        crate::ensure_real_directory_tree(app_data, "Application data")?;
        crate::ensure_no_symlink_components(app_data, "Application data")?;
        let directory = app_data.join("transfer-recovery");
        crate::ensure_real_directory_tree(&directory, "Transfer recovery")?;
        crate::ensure_no_symlink_components(&directory, "Transfer recovery")?;
        let journal = Arc::new(RecoveryJournal::open(&directory.join("journal.json"))?);
        Ok(journal)
    })();
    set_global_journal(result.clone());
    result.map(|_| ())
}

pub(crate) fn set_initialization_error(error: impl Into<String>) {
    set_global_journal(Err(error.into()));
}

fn set_global_journal(result: Result<Arc<RecoveryJournal>, String>) {
    *GLOBAL_JOURNAL
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(result);
}

fn global_journal() -> Result<Arc<RecoveryJournal>, String> {
    let configured = GLOBAL_JOURNAL
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone();
    if let Some(configured) = configured {
        return configured;
    }
    #[cfg(test)]
    {
        return TEST_JOURNAL
            .as_ref()
            .map(|(_, journal)| Arc::clone(journal))
            .map_err(Clone::clone);
    }
    #[cfg(not(test))]
    Err("Transfer recovery journal has not been initialized".to_string())
}

pub(crate) fn begin_operation(
    kind: &str,
    operation_id: Option<&str>,
    sources: &[PathBuf],
    destinations: &[PathBuf],
) -> Result<Option<String>, String> {
    global_journal()?
        .begin_operation(kind, operation_id, sources, destinations)
        .map(Some)
}

pub(crate) fn record_paths(id: Option<&str>, paths: RecoveryPaths) -> Result<(), String> {
    let Some(id) = id else { return Ok(()) };
    global_journal()?.record_paths(id, paths)
}

pub(crate) fn record_error(id: Option<&str>, error: &str) {
    let Some(id) = id else { return };
    if let Err(journal_error) = global_journal().and_then(|journal| journal.record_error(id, error)) {
        log::error!("[Recovery] could not persist operation error for {}: {}", id, journal_error);
    }
}

pub(crate) fn mark_history_owned(id: Option<&str>, backups: &[PathBuf]) -> Result<(), String> {
    let Some(id) = id else { return Ok(()) };
    global_journal()?.mark_history_owned(id, backups)
}

pub(crate) fn complete(id: Option<&str>) -> Result<(), String> {
    let Some(id) = id else { return Ok(()) };
    global_journal()?.complete(id)
}

pub(crate) fn finish_records_referencing(paths: &[PathBuf], error: Option<&str>) {
    let Ok(journal) = global_journal() else { return };
    for id in journal.records_referencing(paths) {
        let result = if let Some(error) = error {
            journal.record_error(&id, error)
        } else {
            journal.complete_if_retained_paths_are_absent(&id)
        };
        if let Err(error) = result {
            log::error!("[Recovery] could not update retained-path record {}: {}", id, error);
        }
    }
}

pub(crate) fn record_unowned_retained_path(path: &Path, kind: &str) {
    let Ok(journal) = global_journal() else { return };
    let path = path.to_path_buf();
    match journal.begin_operation("recovery", Some(kind), &[], &[]) {
        Ok(id) => {
            let result = journal
                .record_paths(
                    &id,
                    RecoveryPaths {
                        retained: vec![path.clone()],
                        ..RecoveryPaths::default()
                    },
                )
                .and_then(|()| journal.record_error(&id, "Retained data requires manual review"));
            if let Err(error) = result {
                log::error!("[Recovery] could not record retained path {}: {}", path.display(), error);
            }
        }
        Err(error) => log::error!("[Recovery] could not create retained-path record: {}", error),
    }
}

#[tauri::command]
pub fn list_transfer_recovery() -> Result<Vec<RecoveryRecord>, String> {
    global_journal()?.list_unfinished()
}

#[tauri::command]
pub fn acknowledge_transfer_recovery(record_id: String) -> Result<(), String> {
    if record_id.len() > 256 || record_id.contains('\0') {
        return Err("Recovery record ID is invalid".to_string());
    }
    global_journal()?.acknowledge(&record_id)
}
