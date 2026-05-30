use std::process::Command;
use std::time::Duration;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

const GIT_TIMEOUT: Duration = Duration::from_secs(5);

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

#[tauri::command]
pub async fn get_git_status(
    dir_path: String,
    include_untracked: Option<bool>,
) -> Result<serde_json::Value, String> {
    log::debug!("[Git] get_git_status: {}", dir_path);
    let path = crate::validate_existing_path(&dir_path, "Directory")?;
    let include_untracked = include_untracked.unwrap_or(false);

    match tokio::time::timeout(
        GIT_TIMEOUT,
        tokio::task::spawn_blocking(move || {
            let mut probe_cmd = Command::new("git");
            probe_cmd
                .args(["rev-parse", "--is-inside-work-tree"])
                .current_dir(&path);
            #[cfg(target_os = "windows")]
            probe_cmd.creation_flags(0x08000000);
            let probe = probe_cmd.output().map_err(|e| e.to_string())?;
            if !probe.status.success() {
                return Ok(serde_json::json!({
                    "isGitRepo": false,
                    "modified": [],
                    "added": [],
                    "deleted": [],
                    "untracked": [],
                }));
            }

            // -z: NUL-terminated records with literal (unquoted) paths, so we
            // don't have to decode git's C-style `"..."` quoting for paths with
            // spaces/unicode/special chars. For rename/copy records (X = R or C)
            // git emits the destination path first, then the original path as a
            // separate NUL-terminated field; we surface the destination.
            let mut args = vec!["status", "--porcelain", "-z"];
            if include_untracked {
                args.push("-uall");
            }

            let mut cmd = Command::new("git");
            cmd.args(&args).current_dir(&path);
            #[cfg(target_os = "windows")]
            cmd.creation_flags(0x08000000);
            match cmd.output() {
                Ok(out) if out.status.success() => {
                    let stdout = String::from_utf8_lossy(&out.stdout);
                    let parsed = parse_porcelain_z(&stdout);
                    Ok(serde_json::json!({
                        "isGitRepo": true,
                        "modified": parsed.modified,
                        "added": parsed.added,
                        "deleted": parsed.deleted,
                        "untracked": parsed.untracked,
                    }))
                }
                Ok(out) => Err(String::from_utf8_lossy(&out.stderr).trim().to_string()),
                Err(error) => Err(error.to_string()),
            }
        }),
    )
    .await
    {
        Ok(Ok(Ok(val))) => Ok(val),
        Ok(Ok(Err(e))) => Err(e),
        Ok(Err(e)) => Err(e.to_string()),
        Err(_) => Err("Git status timed out".to_string()),
    }
}

#[tauri::command]
pub async fn get_git_branch(dir_path: String) -> Result<String, String> {
    log::debug!("[Git] get_git_branch: {}", dir_path);
    let path = crate::validate_existing_path(&dir_path, "Directory")?;

    match tokio::time::timeout(
        GIT_TIMEOUT,
        tokio::task::spawn_blocking(move || {
            let mut cmd = Command::new("git");
            cmd.args(["rev-parse", "--abbrev-ref", "HEAD"])
                .current_dir(&path);
            #[cfg(target_os = "windows")]
            cmd.creation_flags(0x08000000);
            let mut probe_cmd = Command::new("git");
            probe_cmd
                .args(["rev-parse", "--is-inside-work-tree"])
                .current_dir(&path);
            #[cfg(target_os = "windows")]
            probe_cmd.creation_flags(0x08000000);
            let probe = probe_cmd.output().map_err(|e| e.to_string())?;
            if !probe.status.success() {
                return Ok(String::new());
            }

            match cmd.output() {
                Ok(out) if out.status.success() => Ok(String::from_utf8_lossy(&out.stdout).trim().to_string()),
                Ok(out) => Err(String::from_utf8_lossy(&out.stderr).trim().to_string()),
                Err(error) => Err(error.to_string()),
            }
        }),
    )
    .await
    {
        Ok(Ok(Ok(val))) => Ok(val),
        Ok(Ok(Err(e))) => Err(e),
        Ok(Err(e)) => Err(e.to_string()),
        Err(_) => Err("Git branch query timed out".to_string()),
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
}
