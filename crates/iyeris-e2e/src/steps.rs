//! The harness steps. Each one calls a real iyeris-core function, then checks
//! the filesystem. Trash and elevated helpers are never called.
//!
//! Undo and redo are process-global, so steps run in one fixed order. The
//! undo sequence is the reverse of the operations, and the redo sequence is
//! the reverse of the undo sequence. The copy is undone and redone first,
//! before later operations prune its recovery record.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use iyeris_core::file_operations::{
    batch_rename, calculate_checksum, copy_items, create_file, create_folder, find_duplicate_files,
    move_items, rename_item,
};
use iyeris_core::recovery::{initialize_app_data, list_transfer_recovery};
use iyeris_core::undo::{redo_action, undo_action, UndoRedoState};
use iyeris_core::{EventSink, FixedPathProvider, PathProvider, RecordingSink};
use serde_json::{json, Value};

use crate::artifact::{normalize_events, Step};
use crate::fixture::{self, Entry};

/// Paths for one run. Everything lives under `root`, which is a canonical
/// temp directory that is deleted when the run ends.
pub struct Ctx {
    pub root: PathBuf,
    pub work: PathBuf,
    pub source: PathBuf,
}

impl Ctx {
    pub fn new(root: PathBuf) -> Self {
        let work = root.join("work");
        let source = work.join("source");
        Ctx { root, work, source }
    }
}

fn ensure(condition: bool, message: &str) -> Result<(), String> {
    if condition {
        Ok(())
    } else {
        Err(message.to_string())
    }
}

fn text(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

/// Sorted names of the direct children of `dir`. Core's undo keeps a copy's
/// content in a `.iyeris-undo-*` workspace until redo, and that suffix is
/// random, so each one is reported as `<undo-workspace>`.
fn children(dir: &Path) -> Result<Vec<String>, String> {
    let read = fs::read_dir(dir).map_err(|e| format!("read {}: {e}", dir.display()))?;
    let mut names = Vec::new();
    for entry in read {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name().to_string_lossy().into_owned();
        names.push(if name.starts_with(".iyeris-undo-") {
            "<undo-workspace>".to_string()
        } else {
            name
        });
    }
    names.sort();
    Ok(names)
}

fn expect_children(dir: &Path, expected: &[&str]) -> Result<Vec<String>, String> {
    let actual = children(dir)?;
    let wanted: Vec<String> = expected.iter().map(|name| name.to_string()).collect();
    ensure(
        actual == wanted,
        &format!(
            "{} holds {:?}, expected {:?}",
            dir.display(),
            actual,
            wanted
        ),
    )?;
    Ok(actual)
}

fn sha_of(path: &Path) -> Result<String, String> {
    let bytes = fs::read(path).map_err(|e| format!("read {}: {e}", path.display()))?;
    Ok(fixture::sha256_bytes(&bytes))
}

fn entries_json(entries: &[Entry]) -> Value {
    Value::Array(entries.iter().map(Entry::to_json).collect())
}

fn record(steps: &mut Vec<Step>, ctx: &Ctx, name: &'static str, result: Result<Value, String>) {
    steps.push(Step::new(name, result, &ctx.root));
}

pub fn initialize_recovery(ctx: &Ctx) -> Result<Value, String> {
    let provider = FixedPathProvider {
        data: ctx.root.join("app-data"),
        cache: ctx.root.join("app-cache"),
    };
    let data = provider.app_data_dir().map_err(|e| e.to_string())?;
    initialize_app_data(&data)?;
    ensure(
        data.join("transfer-recovery").is_dir(),
        "transfer-recovery directory was not created",
    )?;
    Ok(json!({ "recoveryDirectory": "app-data/transfer-recovery" }))
}

pub fn build_fixture(ctx: &Ctx) -> Result<Value, String> {
    fixture::build(&ctx.source)?;
    Ok(json!({ "files": fixture::FILES.len(), "directories": fixture::DIRS.len() }))
}

async fn create_folder_step(ctx: &Ctx, name: &str) -> Result<Value, String> {
    let made = create_folder(text(&ctx.work), name.to_string()).await?;
    let expected = ctx.work.join(name);
    ensure(
        Path::new(&made) == expected,
        "create_folder returned an unexpected path",
    )?;
    ensure(expected.is_dir(), "created folder is missing")?;
    Ok(json!({ "path": fixture::rel(&ctx.root, Path::new(&made)) }))
}

async fn create_file_step(ctx: &Ctx) -> Result<Value, String> {
    let projects = ctx.work.join("projects");
    let made = create_file(text(&projects), "draft.txt".to_string()).await?;
    let expected = projects.join("draft.txt");
    ensure(
        Path::new(&made) == expected,
        "create_file returned an unexpected path",
    )?;
    let size = fs::metadata(&expected)
        .map_err(|e| format!("stat draft.txt: {e}"))?
        .len();
    ensure(size == 0, "new file is not empty")?;
    Ok(json!({ "path": fixture::rel(&ctx.root, &expected), "size": size }))
}

async fn copy_step(ctx: &Ctx) -> Result<Value, String> {
    let recorder = Arc::new(RecordingSink::new());
    let sink: Arc<dyn EventSink> = recorder.clone();
    let copies = ctx.work.join("copies");
    let sources: Vec<String> = ["notes.txt", "photos", "unicode"]
        .iter()
        .map(|name| text(&ctx.source.join(name)))
        .collect();
    let result = copy_items(
        sources,
        text(&copies),
        None,
        None,
        Some("e2e-copy".to_string()),
        sink,
    )
    .await;
    let events = normalize_events(recorder.take());
    result?;
    let entries = fixture::walk(&copies, &copies)?;
    let keep =
        |rel: &str| rel == "notes.txt" || rel.starts_with("photos/") || rel.starts_with("unicode/");
    ensure(
        fixture::file_pairs(&entries) == fixture::expected_files(keep),
        "copied files do not match the source fixture",
    )?;
    Ok(json!({ "entries": entries_json(&entries), "events": events }))
}

async fn move_step(ctx: &Ctx) -> Result<Value, String> {
    let recorder = Arc::new(RecordingSink::new());
    let sink: Arc<dyn EventSink> = recorder.clone();
    let from = ctx.work.join("copies").join("notes.txt");
    let projects = ctx.work.join("projects");
    let result = move_items(
        vec![text(&from)],
        text(&projects),
        None,
        None,
        Some("e2e-move".to_string()),
        sink,
    )
    .await;
    let events = normalize_events(recorder.take());
    result?;
    ensure(!from.exists(), "moved source still exists")?;
    ensure(
        sha_of(&projects.join("notes.txt"))? == fixture::sha256_bytes(b"alpha\n"),
        "moved file content changed",
    )?;
    Ok(json!({ "projects": children(&projects)?, "events": events }))
}

async fn rename_step(ctx: &Ctx) -> Result<Value, String> {
    let projects = ctx.work.join("projects");
    let old = projects.join("draft.txt");
    let new_path = rename_item(text(&old), "draft-renamed.txt".to_string()).await?;
    ensure(!old.exists(), "rename left the old name behind")?;
    ensure(
        projects.join("draft-renamed.txt").is_file(),
        "renamed file is missing",
    )?;
    Ok(json!({ "path": fixture::rel(&ctx.root, Path::new(&new_path)) }))
}

async fn batch_rename_step(ctx: &Ctx) -> Result<Value, String> {
    let projects = ctx.work.join("projects");
    let items = vec![
        json!({
            "oldPath": text(&projects.join("notes.txt")),
            "newName": "notes-batch.txt",
        }),
        json!({
            "oldPath": text(&projects.join("draft-renamed.txt")),
            "newName": "draft-final.txt",
        }),
    ];
    let results = batch_rename(items).await?;
    ensure(
        results.len() == 2,
        "batch rename returned the wrong number of results",
    )?;
    expect_children(&projects, &["draft-final.txt", "notes-batch.txt"])?;
    Ok(json!({ "projects": children(&projects)? }))
}

async fn checksum_step(ctx: &Ctx) -> Result<Value, String> {
    let recorder = Arc::new(RecordingSink::new());
    let sink: Arc<dyn EventSink> = recorder.clone();
    let file = ctx.work.join("projects").join("notes-batch.txt");
    let algorithms = ["sha256", "sha512", "md5", "crc32", "blake3"];
    let result = calculate_checksum(
        text(&file),
        "e2e-checksum".to_string(),
        algorithms.iter().map(|name| name.to_string()).collect(),
        sink,
    )
    .await;
    let events = recorder.take();
    let hashes = result?;
    for algorithm in algorithms {
        ensure(
            hashes.get(algorithm).is_some(),
            "checksum result is missing an algorithm",
        )?;
    }
    ensure(
        hashes["sha256"] == json!(fixture::sha256_bytes(b"alpha\n")),
        "sha256 from the core does not match the independent digest",
    )?;
    // Progress timing is not deterministic, so only the event names are checked.
    ensure(
        events
            .iter()
            .all(|(name, _)| name.as_str() == "checksum-progress"),
        "checksum emitted an unexpected event",
    )?;
    Ok(json!({ "hashes": hashes }))
}

async fn duplicates_step(ctx: &Ctx) -> Result<Value, String> {
    let result = find_duplicate_files(
        "e2e-main".to_string(),
        text(&ctx.source),
        Some(1),
        Some(false),
    )
    .await?;
    ensure(!result.partial, "duplicate scan reported partial results")?;
    let mut actual: Vec<(u64, Vec<String>)> = result
        .groups
        .iter()
        .map(|group| {
            let mut paths: Vec<String> = group
                .paths
                .iter()
                .map(|path| fixture::rel(&ctx.root, Path::new(path)))
                .collect();
            paths.sort();
            (group.size, paths)
        })
        .collect();
    actual.sort();
    let expected: Vec<(u64, Vec<String>)> = fixture::expected_duplicate_groups()
        .into_iter()
        .map(|(size, paths)| {
            let joined = paths
                .iter()
                .map(|rel| fixture::rel(&ctx.root, &ctx.source.join(rel)))
                .collect();
            (size, joined)
        })
        .collect();
    ensure(
        actual == expected,
        "duplicate groups do not match the fixture",
    )?;
    let groups: Vec<Value> = actual
        .iter()
        .map(|(size, paths)| json!({ "size": size, "paths": paths }))
        .collect();
    Ok(json!({ "groups": groups, "partial": false }))
}

/// Shared check for undo and redo: the state the core reports, plus the exact
/// names expected in `projects` and `copies` afterwards.
async fn history_step(
    ctx: &Ctx,
    state: Result<UndoRedoState, String>,
    projects: &[&str],
    copies: &[&str],
) -> Result<Value, String> {
    let state = state?;
    let projects_now = expect_children(&ctx.work.join("projects"), projects)?;
    let copies_now = expect_children(&ctx.work.join("copies"), copies)?;
    Ok(json!({
        "canUndo": state.can_undo,
        "canRedo": state.can_redo,
        "projects": projects_now,
        "copies": copies_now,
    }))
}

async fn recovery_step() -> Result<Value, String> {
    let unfinished = list_transfer_recovery()?;
    ensure(
        unfinished.is_empty(),
        "recovery journal still lists unfinished operations",
    )?;
    Ok(json!({ "unfinished": 0 }))
}

async fn final_state_step(ctx: &Ctx) -> Result<Value, String> {
    let entries = fixture::walk(&ctx.root, &ctx.work)?;
    let mut expected: Vec<(String, String)> = fixture::expected_files(|_| true)
        .into_iter()
        .map(|(rel, sha)| (format!("work/source/{rel}"), sha))
        .collect();
    expected.push((
        "work/projects/draft-final.txt".to_string(),
        fixture::sha256_bytes(b""),
    ));
    expected.push((
        "work/projects/notes-batch.txt".to_string(),
        fixture::sha256_bytes(b"alpha\n"),
    ));
    let copies_keep = |rel: &str| rel.starts_with("photos/") || rel.starts_with("unicode/");
    for (rel, sha) in fixture::expected_files(copies_keep) {
        expected.push((format!("work/copies/{rel}"), sha));
    }
    expected.sort();
    ensure(
        fixture::file_pairs(&entries) == expected,
        "final file tree does not match the expected state",
    )?;
    Ok(json!({ "files": expected.len() }))
}

/// Runs every step in order. Failures are recorded and the run continues, so
/// the artifact shows every step's outcome.
pub async fn run_all(ctx: &Ctx, steps: &mut Vec<Step>) {
    let result = build_fixture(ctx);
    record(steps, ctx, "build-fixture", result);
    let result = initialize_recovery(ctx);
    record(steps, ctx, "initialize-recovery", result);

    let result = create_folder_step(ctx, "projects").await;
    record(steps, ctx, "create-folder-projects", result);
    let result = create_folder_step(ctx, "copies").await;
    record(steps, ctx, "create-folder-copies", result);
    let result = create_file_step(ctx).await;
    record(steps, ctx, "create-file-draft", result);
    let result = copy_step(ctx).await;
    record(steps, ctx, "copy-items", result);
    // Undo and redo the copy before any later operation. Core prunes a completed
    // operation's recovery record when the next operation begins, so a copy undo
    // issued after a move fails with "Recovery record was not found".
    let undo_copy = history_step(
        ctx,
        undo_action().await,
        &["draft.txt"],
        &["<undo-workspace>", "<undo-workspace>", "<undo-workspace>"],
    )
    .await;
    record(steps, ctx, "undo-copy", undo_copy);
    let redo_copy = history_step(
        ctx,
        redo_action().await,
        &["draft.txt"],
        &["notes.txt", "photos", "unicode"],
    )
    .await;
    record(steps, ctx, "redo-copy", redo_copy);
    let result = move_step(ctx).await;
    record(steps, ctx, "move-items", result);
    let result = rename_step(ctx).await;
    record(steps, ctx, "rename-item", result);
    let result = batch_rename_step(ctx).await;
    record(steps, ctx, "batch-rename", result);
    let result = checksum_step(ctx).await;
    record(steps, ctx, "checksum-calculate", result);
    let result = duplicates_step(ctx).await;
    record(steps, ctx, "find-duplicates", result);

    let shared = ["photos", "unicode"];
    let undo_batch = history_step(
        ctx,
        undo_action().await,
        &["draft-renamed.txt", "notes.txt"],
        &shared,
    )
    .await;
    record(steps, ctx, "undo-batch-rename", undo_batch);
    let undo_rename = history_step(
        ctx,
        undo_action().await,
        &["draft.txt", "notes.txt"],
        &shared,
    )
    .await;
    record(steps, ctx, "undo-rename", undo_rename);
    let undo_move = history_step(
        ctx,
        undo_action().await,
        &["draft.txt"],
        &["notes.txt", "photos", "unicode"],
    )
    .await;
    record(steps, ctx, "undo-move", undo_move);

    let redo_move = history_step(
        ctx,
        redo_action().await,
        &["draft.txt", "notes.txt"],
        &shared,
    )
    .await;
    record(steps, ctx, "redo-move", redo_move);
    let redo_rename = history_step(
        ctx,
        redo_action().await,
        &["draft-renamed.txt", "notes.txt"],
        &shared,
    )
    .await;
    record(steps, ctx, "redo-rename", redo_rename);
    let redo_batch = history_step(
        ctx,
        redo_action().await,
        &["draft-final.txt", "notes-batch.txt"],
        &shared,
    )
    .await;
    record(steps, ctx, "redo-batch-rename", redo_batch);

    let result = recovery_step().await;
    record(steps, ctx, "recovery-journal-empty", result);
    let result = final_state_step(ctx).await;
    record(steps, ctx, "final-state", result);
}

/// The fixture tree that the artifact records.
pub fn tree(ctx: &Ctx) -> Result<Vec<Entry>, String> {
    fixture::walk(&ctx.root, &ctx.work)
}
