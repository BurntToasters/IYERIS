use std::process::{ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::{Child, Command};
use tokio::sync::Notify;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

const GIT_TIMEOUT: Duration = Duration::from_secs(5);
const GIT_OUTPUT_LIMIT: usize = 4 * 1024 * 1024;

#[derive(Default)]
struct PorcelainStatus {
    modified: Vec<String>,
    added: Vec<String>,
    deleted: Vec<String>,
    untracked: Vec<String>,
}

/// Parse `git status --porcelain -z` output.
///
/// `-z` gives NUL-separated records with literal (unquoted) paths, so paths
/// with spaces / unicode / special characters need no C-style unescaping. The
/// first two bytes of each record are the XY status code, byte 2 is a space,
/// and the path starts at byte 3. Rename/copy records (X = R or C) carry the
/// original path in the *next* NUL field; we surface the destination and skip
/// the original so it isn't parsed as its own record.
fn parse_porcelain_z(stdout: &str) -> PorcelainStatus {
    let mut status = PorcelainStatus::default();
    let mut fields = stdout.split('\0');
    while let Some(record) = fields.next() {
        if record.len() < 4 {
            continue;
        }
        let bytes = record.as_bytes();
        let status_x = bytes[0] as char;
        let status_y = bytes[1] as char;
        let file = record[3..].to_string();

        if status_x == 'R' || status_x == 'C' {
            // Consume the original-path field that follows a rename/copy.
            let _ = fields.next();
        }

        if status_x == '?' && status_y == '?' {
            status.untracked.push(file);
        } else if status_x == 'A' || status_y == 'A' {
            status.added.push(file);
        } else if status_x == 'D' || status_y == 'D' {
            status.deleted.push(file);
        } else if status_x != ' ' || status_y != ' ' {
            // Any other real status (M, R, C, T, U, …) is surfaced as a change.
            status.modified.push(file);
        }
    }
    status
}

fn git_common_config_args() -> [&'static str; 4] {
    [
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.hooksPath=/dev/null",
    ]
}

fn absolutize_git_path(repo_root: &std::path::Path, relative: &str) -> String {
    let normalized = relative.replace('\\', "/");
    repo_root
        .join(std::path::Path::new(&normalized))
        .to_string_lossy()
        .into_owned()
}

fn absolutize_git_paths(repo_root: &std::path::Path, files: Vec<String>) -> Vec<String> {
    files
        .into_iter()
        .map(|relative| absolutize_git_path(repo_root, &relative))
        .collect()
}

/// Map Git's physical toplevel onto the path prefix the explorer used to list
/// files. Renderer badges key by those listing paths (`/tmp` vs `/private/tmp`,
/// `C:\` vs Git's `C:/`).
fn align_git_root_to_requested_path(
    requested_dir: &std::path::Path,
    git_toplevel: &std::path::Path,
) -> std::path::PathBuf {
    let canonical_dir = requested_dir
        .canonicalize()
        .unwrap_or_else(|_| requested_dir.to_path_buf());
    let canonical_root = git_toplevel
        .canonicalize()
        .unwrap_or_else(|_| git_toplevel.to_path_buf());
    let Ok(suffix) = canonical_dir.strip_prefix(&canonical_root) else {
        return git_toplevel.to_path_buf();
    };
    let mut root = requested_dir.to_path_buf();
    for _ in suffix.components() {
        match root.parent() {
            Some(parent) => root = parent.to_path_buf(),
            None => return git_toplevel.to_path_buf(),
        }
    }
    root
}

async fn git_toplevel(path: &std::path::Path) -> Result<std::path::PathBuf, String> {
    let mut args = git_common_config_args().to_vec();
    args.extend(["rev-parse", "--show-toplevel"]);
    let output = run_git(args.as_slice(), path).await?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    let root = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if root.is_empty() {
        return Err("Git repository root is empty".to_string());
    }
    Ok(std::path::PathBuf::from(root))
}

fn git_status_args(include_untracked: bool) -> Vec<&'static str> {
    vec![
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.hooksPath=/dev/null",
        "status",
        "--porcelain",
        "-z",
        if include_untracked {
            "--untracked-files=all"
        } else {
            "--untracked-files=no"
        },
    ]
}

struct GitOutput {
    status: ExitStatus,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}

async fn read_git_stream<R: AsyncRead + Unpin>(
    mut reader: R,
    output_limit: usize,
    output_exceeded: Arc<AtomicBool>,
    overflow_notify: Arc<Notify>,
) -> Result<Vec<u8>, String> {
    let mut output = Vec::with_capacity(output_limit.min(64 * 1024));
    let mut buffer = [0u8; 16 * 1024];
    loop {
        let read = reader
            .read(&mut buffer)
            .await
            .map_err(|error| error.to_string())?;
        if read == 0 {
            return Ok(output);
        }
        if output.len().saturating_add(read) > output_limit {
            if !output_exceeded.swap(true, Ordering::Relaxed) {
                overflow_notify.notify_one();
            }
            // Keep draining until the child is killed so it cannot block on a
            // full pipe while the parent performs cleanup.
            continue;
        }
        output.extend_from_slice(&buffer[..read]);
    }
}

async fn kill_and_reap(child: &mut Child) {
    let _ = child.kill().await;
    let _ = child.wait().await;
}

async fn run_git(args: &[&str], path: &std::path::Path) -> Result<GitOutput, String> {
    let mut command = Command::new("git");
    command
        .args(args)
        .current_dir(path)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(target_os = "windows")]
    command.as_std_mut().creation_flags(0x08000000);

    let mut child = command.spawn().map_err(|error| error.to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Git stdout pipe unavailable".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Git stderr pipe unavailable".to_string())?;
    let output_exceeded = Arc::new(AtomicBool::new(false));
    let overflow_notify = Arc::new(Notify::new());
    let stdout_task = tokio::spawn(read_git_stream(
        stdout,
        GIT_OUTPUT_LIMIT,
        Arc::clone(&output_exceeded),
        Arc::clone(&overflow_notify),
    ));
    let stderr_task = tokio::spawn(read_git_stream(
        stderr,
        GIT_OUTPUT_LIMIT,
        Arc::clone(&output_exceeded),
        Arc::clone(&overflow_notify),
    ));

    let deadline = tokio::time::sleep(GIT_TIMEOUT);
    tokio::pin!(deadline);
    let overflow = overflow_notify.notified();
    tokio::pin!(overflow);
    let wait_result = tokio::select! {
        result = child.wait() => result.map(Some).map_err(|error| error.to_string()),
        _ = &mut deadline => Ok(None),
        _ = &mut overflow => Ok(None),
    }?;

    let Some(status) = wait_result else {
        kill_and_reap(&mut child).await;
        stdout_task.abort();
        stderr_task.abort();
        return if output_exceeded.load(Ordering::Relaxed) {
            Err(format!("Git output exceeded {} bytes", GIT_OUTPUT_LIMIT))
        } else {
            Err("Git command timed out".to_string())
        };
    };

    let stdout = stdout_task.await.map_err(|error| error.to_string())??;
    let stderr = stderr_task.await.map_err(|error| error.to_string())??;
    if output_exceeded.load(Ordering::Relaxed) {
        return Err(format!("Git output exceeded {} bytes", GIT_OUTPUT_LIMIT));
    }
    Ok(GitOutput {
        status,
        stdout,
        stderr,
    })
}

#[tauri::command]
pub async fn get_git_status(
    dir_path: String,
    include_untracked: Option<bool>,
) -> Result<serde_json::Value, String> {
    log::debug!("[Git] get_git_status: {}", dir_path);
    let path = crate::validate_existing_path(&dir_path, "Directory")?;
    let include_untracked = include_untracked.unwrap_or(false);

    let probe = run_git(
        &[
            "-c",
            "core.fsmonitor=false",
            "-c",
            "core.hooksPath=/dev/null",
            "rev-parse",
            "--is-inside-work-tree",
        ],
        &path,
    )
    .await
    .map_err(|error| {
        if error == "Git command timed out" {
            "Git status timed out".to_string()
        } else {
            error
        }
    })?;
    if !probe.status.success() {
        return Ok(serde_json::json!({
            "isGitRepo": false,
            "modified": [],
            "added": [],
            "deleted": [],
            "untracked": [],
        }));
    }

    // -z gives literal NUL-terminated paths. `all` lists files inside untracked
    // directories so renderer badges can match individual items.
    let args = git_status_args(include_untracked);
    let output = run_git(&args, &path).await.map_err(|error| {
        if error == "Git command timed out" {
            "Git status timed out".to_string()
        } else {
            error
        }
    })?;
    if output.status.success() {
        let stdout = String::from_utf8_lossy(&output.stdout);
        let parsed = parse_porcelain_z(&stdout);
        let git_root = git_toplevel(&path).await?;
        let repo_root = align_git_root_to_requested_path(&path, &git_root);
        Ok(serde_json::json!({
            "isGitRepo": true,
            "modified": absolutize_git_paths(&repo_root, parsed.modified),
            "added": absolutize_git_paths(&repo_root, parsed.added),
            "deleted": absolutize_git_paths(&repo_root, parsed.deleted),
            "untracked": absolutize_git_paths(&repo_root, parsed.untracked),
        }))
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

#[tauri::command]
pub async fn get_git_branch(dir_path: String) -> Result<String, String> {
    log::debug!("[Git] get_git_branch: {}", dir_path);
    let path = crate::validate_existing_path(&dir_path, "Directory")?;

    let probe = run_git(
        &[
            "-c",
            "core.fsmonitor=false",
            "-c",
            "core.hooksPath=/dev/null",
            "rev-parse",
            "--is-inside-work-tree",
        ],
        &path,
    )
    .await
    .map_err(|error| {
        if error == "Git command timed out" {
            "Git branch query timed out".to_string()
        } else {
            error
        }
    })?;
    if !probe.status.success() {
        return Ok(String::new());
    }
    let output = run_git(
        &[
            "-c",
            "core.fsmonitor=false",
            "-c",
            "core.hooksPath=/dev/null",
            "rev-parse",
            "--abbrev-ref",
            "HEAD",
        ],
        &path,
    )
    .await
    .map_err(|error| {
        if error == "Git command timed out" {
            "Git branch query timed out".to_string()
        } else {
            error
        }
    })?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_basic_statuses() {
        // " M file" modified, "A  added" added, " D gone" deleted, "?? new" untracked
        let out = " M src/main.rs\0A  new.txt\0 D removed.rs\0?? scratch.tmp\0";
        let s = parse_porcelain_z(out);
        assert_eq!(s.modified, vec!["src/main.rs"]);
        assert_eq!(s.added, vec!["new.txt"]);
        assert_eq!(s.deleted, vec!["removed.rs"]);
        assert_eq!(s.untracked, vec!["scratch.tmp"]);
    }

    #[test]
    fn rename_surfaces_destination_and_skips_original() {
        // "R  new\0old\0" — destination first, original in the next NUL field.
        let out = "R  dest/new name.rs\0src/old name.rs\0 M other.rs\0";
        let s = parse_porcelain_z(out);
        // The destination is surfaced as a change; the original is not parsed
        // as its own record (which would otherwise look like status "sr").
        assert_eq!(s.modified, vec!["dest/new name.rs", "other.rs"]);
        assert!(s.added.is_empty());
        assert!(s.deleted.is_empty());
    }

    #[test]
    fn paths_with_spaces_and_unicode_are_literal() {
        // -z means no surrounding quotes / C-escapes, so these come through verbatim.
        let out = " M My Documents/café ☕.txt\0?? wösp \"quoted\".log\0";
        let s = parse_porcelain_z(out);
        assert_eq!(s.modified, vec!["My Documents/café ☕.txt"]);
        assert_eq!(s.untracked, vec!["wösp \"quoted\".log"]);
    }

    #[test]
    fn empty_and_trailing_records_are_ignored() {
        // Trailing NUL produces an empty final field; short records are skipped.
        let out = " M a.rs\0\0";
        let s = parse_porcelain_z(out);
        assert_eq!(s.modified, vec!["a.rs"]);
    }

    #[test]
    fn staged_and_worktree_both_modified_counts_once() {
        // "MM file" — modified in index and worktree.
        let out = "MM both.rs\0";
        let s = parse_porcelain_z(out);
        assert_eq!(s.modified, vec!["both.rs"]);
    }

    #[test]
    fn git_status_args_match_untracked_setting() {
        assert!(git_status_args(false).contains(&"--untracked-files=no"));
        assert!(!git_status_args(false).contains(&"--untracked-files=all"));
        assert!(git_status_args(true).contains(&"--untracked-files=all"));
        assert!(!git_status_args(true).contains(&"--untracked-files=no"));
        assert!(!git_status_args(true).contains(&"--untracked-files=normal"));
        assert!(!git_status_args(true).contains(&"-u"));
    }

    #[test]
    fn absolutize_git_path_joins_repo_relative_paths() {
        let root = std::path::PathBuf::from("/repo");
        assert_eq!(
            std::path::PathBuf::from(absolutize_git_path(&root, "src/main.rs")),
            root.join("src/main.rs")
        );
        assert_eq!(
            std::path::PathBuf::from(absolutize_git_path(&root, "src\\win.rs")),
            root.join("src/win.rs")
        );
    }

    #[cfg(unix)]
    #[test]
    fn align_git_root_keeps_requested_symlink_prefix() {
        use std::os::unix::fs::symlink;

        let tmp = tempfile::tempdir().unwrap();
        let real = tmp.path().join("real-root");
        std::fs::create_dir_all(real.join("src")).unwrap();
        let link = tmp.path().join("link-root");
        symlink(&real, &link).unwrap();

        let requested = link.join("src");
        let git_root = real.canonicalize().unwrap();
        let aligned = align_git_root_to_requested_path(&requested, &git_root);
        assert_eq!(aligned, link);
        assert_eq!(
            std::path::PathBuf::from(absolutize_git_path(&aligned, "src/file.txt")),
            link.join("src").join("file.txt")
        );
    }

    fn git_init(path: &std::path::Path, template: &std::path::Path) {
        let status = std::process::Command::new("git")
            .args([
                "-c",
                "init.defaultBranch=main",
                "init",
                "--quiet",
                "--template",
            ])
            .arg(template)
            .current_dir(path)
            .status()
            .expect("git must be available for nested-repository status tests");
        assert!(status.success(), "git init failed in {}", path.display());
    }

    #[test]
    fn nested_git_repository_returns_absolute_untracked_files() {
        let tmp = tempfile::tempdir().unwrap();
        let template = tmp.path().join("empty-git-template");
        std::fs::create_dir_all(&template).unwrap();
        let parent = tmp.path().join("parent");
        let nested = parent.join("nested");
        std::fs::create_dir_all(nested.join("dir")).unwrap();
        git_init(&parent, &template);
        git_init(&nested, &template);
        let nested_file = nested.join("dir").join("file.txt");
        std::fs::write(&nested_file, "x").unwrap();
        std::fs::write(parent.join("outer.txt"), "y").unwrap();

        let runtime = tokio::runtime::Runtime::new().unwrap();
        let status = runtime
            .block_on(get_git_status(
                nested.to_string_lossy().to_string(),
                Some(true),
            ))
            .unwrap();

        assert_eq!(status["isGitRepo"], true);
        let untracked: Vec<String> = status["untracked"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|value| value.as_str().map(str::to_string))
            .collect();
        let expected = nested_file.to_string_lossy().into_owned();
        assert!(
            untracked.iter().any(|path| path == &expected),
            "expected {expected} in {untracked:?}"
        );
        assert!(
            untracked.iter().all(|path| !path.ends_with("outer.txt")),
            "nested status leaked parent paths: {untracked:?}"
        );
    }
}
