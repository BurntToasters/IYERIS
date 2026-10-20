//! Privileged file operations.
//!
//! ## Cancellation
//!
//! None of the commands in this module are cancellable. They run through an OS
//! privilege prompt (UAC, `osascript`, or `pkexec`) and hand the actual mutation
//! to a separate privileged process. The unprivileged parent cannot safely stop
//! that process, and killing it can leave a half-applied copy/move behind.
//! These commands therefore do not accept an operation id and must never be
//! registered in the cancellation registry (`ACTIVE_FILE_OPERATIONS`) or wired
//! to `cancel_file_operation`. The frontend marks them non-cancellable to match.
//!
//! ## Atomicity
//!
//! Each item in an elevated transfer gets its own rollback copy. When an
//! overwrite replaces an existing destination, the previous entry is renamed to
//! a hidden `.iyeris-elevated-backup-*` sibling first; it is restored if that
//! item fails and removed after that item succeeds. Directory replacement uses
//! the same per-item backup through `replace_directory_transaction`.
//!
//! Batch operations are deliberately **not transactional across items**. Item
//! N is published before item N+1 starts, so a failure leaves earlier items
//! applied. Error text says so explicitly; callers must not report batch
//! atomicity or automatic whole-batch rollback.

#[cfg(any(target_os = "macos", target_os = "linux"))]
use std::process::Command;

const MAX_ELEVATED_ITEMS: usize = 10_000;
const MAX_ELEVATED_PATH_BYTES: usize = 8 * 1024 * 1024;

fn validate_elevated_list(paths: &[String]) -> Result<(), String> {
    if paths.len() > MAX_ELEVATED_ITEMS {
        return Err(format!(
            "Elevated operation contains too many items (max {})",
            MAX_ELEVATED_ITEMS
        ));
    }
    let total = paths.iter().map(String::len).sum::<usize>();
    if total > MAX_ELEVATED_PATH_BYTES {
        return Err(format!(
            "Elevated paths exceed aggregate size limit (max {} bytes)",
            MAX_ELEVATED_PATH_BYTES
        ));
    }
    Ok(())
}

/// Escape a string for safe embedding in a POSIX shell single-quoted context.
/// The only character that needs escaping in single quotes is the single quote itself.
/// We also strip null bytes and newlines to prevent argument injection.
///
/// Only used on macOS: the `osascript`/`do shell script` elevation path builds
/// a shell command line that must be escaped. Linux elevation goes through
/// `pkexec` with an argv vector (no shell involved), so it never needs this.
#[cfg(target_os = "macos")]
fn shell_escape(s: &str) -> String {
    if s.contains('\0') || s.contains('\n') || s.contains('\r') {
        log::warn!("[Elevated] shell_escape: path contains null/newline characters");
    }
    s.replace('\'', "'\\''").replace(['\0', '\n', '\r'], "")
}

/// Escape a string for safe embedding in an AppleScript double-quoted string literal.
/// AppleScript inside "..." treats \", \\, \n, \t, \r as escapes. Backslash and double
/// quote must be doubled; control characters are rejected outright.
#[cfg(target_os = "macos")]
fn osa_escape(s: &str) -> String {
    s.replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace(['\0', '\n', '\r'], "")
}

fn validate_elevated_path(path: &str, label: &str) -> Result<(), String> {
    if path.is_empty() {
        return Err(format!("{} path is empty", label));
    }
    for ch in path.chars() {
        if ch == '\0' || (ch.is_control() && ch != '\t') {
            return Err(format!(
                "{} path contains a control character — refuse elevation",
                label
            ));
        }
        if matches!(ch, '$' | '`' | ';' | '|' | '&' | '<' | '>' | '\n' | '\r') {
            return Err(format!(
                "{} path contains a shell metacharacter ({:?}) — refuse elevation. Rename the file in userland first.",
                label, ch
            ));
        }
    }
    // A path component starting with `-` would be interpreted as a flag by
    // a privileged cp/mv/rm. We additionally protect by using `--` separators
    // below, but rejecting here is belt + suspenders.
    let basename_starts_with_dash = std::path::Path::new(path)
        .file_name()
        .and_then(|n| n.to_str())
        .map(|n| n.starts_with('-'))
        .unwrap_or(false);
    if path.starts_with('-') || basename_starts_with_dash {
        return Err(format!(
            "{} path starts with '-' — refuse elevation to avoid flag parsing",
            label
        ));
    }
    Ok(())
}

/// Re-resolve paths immediately before spawning the privileged helper to narrow
/// the TOCTOU window between IPC validation and elevation.
fn resolve_elevated_source_before_exec(source: &str, op: &str) -> Result<String, String> {
    validate_elevated_path(source, "Source")?;
    let path = crate::validate_existing_path(source, "Source")?;
    std::fs::symlink_metadata(&path)
        .map_err(|e| format!("Source path no longer accessible before elevation: {}", e))?;
    if matches!(op, "delete" | "copy" | "move") {
        // Preserve a final symlink as the object to unlink, while resolving
        // and validating its parent. Passing the original unresolved path to
        // a privileged rm allowed a parent symlink swap to redirect deletion.
        let parent = path
            .parent()
            .ok_or_else(|| "Delete path has no parent directory".to_string())?;
        let parent_meta = std::fs::symlink_metadata(parent)
            .map_err(|e| format!("Delete parent is no longer accessible: {}", e))?;
        if parent_meta.file_type().is_symlink() || !parent_meta.is_dir() {
            return Err("Delete parent is not a real directory".to_string());
        }
        let canonical_parent = parent
            .canonicalize()
            .map_err(|e| format!("Cannot canonicalize delete parent: {}", e))?;
        let name = path
            .file_name()
            .ok_or_else(|| "Delete path has no file name".to_string())?;
        let resolved = canonical_parent.join(name);
        crate::ensure_not_root_path(&resolved, "delete")?;
        return Ok(resolved.to_string_lossy().to_string());
    }
    let canonical = path
        .canonicalize()
        .map_err(|e| format!("Cannot canonicalize source before elevation: {}", e))?;
    crate::ensure_not_root_path(&canonical, op)?;
    Ok(canonical.to_string_lossy().to_string())
}

fn resolve_elevated_dest_before_exec(dest: &str) -> Result<String, String> {
    validate_elevated_path(dest, "Destination")?;
    let path = crate::validate_path(dest, "Destination")?;
    if let Ok(metadata) = std::fs::symlink_metadata(&path) {
        if metadata.file_type().is_symlink() {
            return Err("Destination is a symbolic link — refusing elevated operation".to_string());
        }
    }
    let parent = path
        .parent()
        .ok_or_else(|| "Destination has no parent directory".to_string())?;
    let parent_meta = std::fs::symlink_metadata(parent).map_err(|e| {
        format!(
            "Destination parent no longer accessible before elevation: {}",
            e
        )
    })?;
    if parent_meta.file_type().is_symlink() {
        return Err(
            "Destination parent is a symbolic link — refusing elevated operation".to_string(),
        );
    }
    let parent_canonical = parent
        .canonicalize()
        .map_err(|e| format!("Cannot canonicalize destination parent: {}", e))?;
    crate::ensure_not_root_path(&parent_canonical, "destination parent")?;
    let file_name = path
        .file_name()
        .ok_or_else(|| "Destination has no file name".to_string())?;
    let resolved = parent_canonical.join(file_name);
    let resolved_str = resolved.to_string_lossy().to_string();
    validate_elevated_path(&resolved_str, "Destination")?;
    Ok(resolved_str)
}

fn resolve_elevated_paths_before_exec(
    op: &str,
    source: &str,
    dest: Option<&str>,
) -> Result<(String, Option<String>), String> {
    let source = resolve_elevated_source_before_exec(source, op)?;
    let dest = match dest {
        Some(d) => Some(resolve_elevated_dest_before_exec(d)?),
        None => None,
    };
    Ok((source, dest))
}

/// Owner that elevated copies must end up with: whoever owns the destination
/// parent. Derived only after the destination parent has been resolved and
/// canonicalized, so a symlink swap cannot redirect the chown.
#[cfg(unix)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct DestinationOwner {
    uid: u32,
    gid: u32,
}

#[cfg(unix)]
impl DestinationOwner {
    fn spec(&self) -> String {
        format!("{}:{}", self.uid, self.gid)
    }
}

#[cfg(target_os = "macos")]
const ELEVATED_CHOWN: &str = "/usr/sbin/chown";
#[cfg(target_os = "linux")]
const ELEVATED_CHOWN: &str = "/bin/chown";

/// Guarantees distinct rollback names even when the platform clock has coarse
/// resolution and multiple items are planned in the same tick.
#[cfg(unix)]
static ELEVATED_BACKUP_SEQUENCE: std::sync::atomic::AtomicU64 =
    std::sync::atomic::AtomicU64::new(0);

#[cfg(unix)]
fn destination_parent_owner(destination: &str) -> Result<DestinationOwner, String> {
    destination_parent_owner_path(std::path::Path::new(destination))
}

#[cfg(unix)]
fn destination_parent_owner_path(
    destination: &std::path::Path,
) -> Result<DestinationOwner, String> {
    use std::os::unix::fs::MetadataExt;

    let parent = destination.parent().ok_or_else(|| {
        format!(
            "Destination has no parent directory: {}",
            destination.display()
        )
    })?;
    let metadata = std::fs::symlink_metadata(parent).map_err(|error| {
        format!(
            "Cannot determine destination parent ownership before elevation: {}",
            error
        )
    })?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(
            "Destination parent is not a real directory — refusing elevated operation".to_string(),
        );
    }
    Ok(DestinationOwner {
        uid: metadata.uid(),
        gid: metadata.gid(),
    })
}

/// Reserve a hidden sibling path for one item's rollback copy. The path is only
/// claimed by the privileged rename; checking here catches the (unlikely)
/// collision without requiring write access to the parent from userland.
#[cfg(unix)]
fn elevated_backup_candidate(
    destination: &std::path::Path,
    attempt: u32,
) -> Result<std::path::PathBuf, String> {
    let parent = destination.parent().ok_or_else(|| {
        format!(
            "Destination has no parent directory: {}",
            destination.display()
        )
    })?;
    let sequence = ELEVATED_BACKUP_SEQUENCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos()
        .saturating_add(u128::from(sequence))
        .saturating_add(u128::from(attempt));
    Ok(parent.join(format!(
        ".iyeris-elevated-backup-{}-{}",
        std::process::id(),
        stamp
    )))
}

#[cfg(unix)]
fn elevated_rollback_path(destination: &std::path::Path) -> Result<std::path::PathBuf, String> {
    for attempt in 0..128u32 {
        let candidate = elevated_backup_candidate(destination, attempt)?;
        match std::fs::symlink_metadata(&candidate) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(candidate),
            Ok(_) => continue,
            Err(error) => {
                return Err(format!(
                    "Cannot inspect rollback backup path {}: {}",
                    candidate.display(),
                    error
                ))
            }
        }
    }
    Err("Could not reserve a unique elevated rollback path".to_string())
}

/// Move the existing destination aside before replacement. Runs in the
/// privileged process, so it works in directories the user cannot write.
#[cfg(unix)]
fn reserve_elevated_backup(destination: &std::path::Path) -> Result<std::path::PathBuf, String> {
    use crate::file_operations::rename_exclusive;

    for attempt in 0..128u32 {
        let candidate = elevated_backup_candidate(destination, attempt)?;
        match rename_exclusive(destination, &candidate) {
            Ok(()) => return Ok(candidate),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(format!(
                    "Cannot stage the previous destination at {}: {}",
                    candidate.display(),
                    error
                ))
            }
        }
    }
    Err("Could not reserve a unique elevated rollback path".to_string())
}

/// Fixed shell programs. Untrusted source/destination/owner values are always
/// positional arguments (`$1`, `$2`, ...), never interpolated into the script.
/// That keeps Linux's `pkexec /bin/sh -c` path injection-free while still
/// allowing one privilege prompt for the copy plus the ownership fix.
#[cfg(unix)]
fn elevated_copy_overwrite_script() -> String {
    r#"set -u
src=$1
dst=$2
owner=$3
backup=$4
backed_up=0
if [ -e "$dst" ] || [ -L "$dst" ]; then
    /bin/mv -n -- "$dst" "$backup" || { echo "elevated copy: cannot stage the existing destination" >&2; exit 1; }
    if [ -e "$dst" ] || [ -L "$dst" ]; then
        echo "elevated copy: existing destination could not be staged" >&2
        exit 1
    fi
    backed_up=1
fi
if /bin/cp -RPp -- "$src" "$dst" && %CHOWN% -R -h "$owner" "$dst"; then
    if [ "$backed_up" -eq 1 ]; then
        /bin/rm -rf -- "$backup" || { echo "elevated copy completed but the rollback backup could not be removed" >&2; exit 1; }
    fi
    exit 0
else
    status=$?
fi
/bin/rm -rf -- "$dst"
if [ "$backed_up" -eq 1 ]; then
    /bin/mv -- "$backup" "$dst" || { echo "elevated copy failed and the previous destination could not be restored" >&2; exit 1; }
fi
exit "$status"
"#
    .replace("%CHOWN%", ELEVATED_CHOWN)
}

#[cfg(unix)]
fn elevated_copy_exclusive_script() -> String {
    r#"set -u
src=$1
dst=$2
owner=$3
if [ -e "$dst" ] || [ -L "$dst" ]; then
    echo "elevated copy: destination is occupied" >&2
    exit 1
fi
/bin/cp -RPpn -- "$src" "$dst" || exit $?
%CHOWN% -R -h "$owner" "$dst"
"#
    .replace("%CHOWN%", ELEVATED_CHOWN)
}

#[cfg(unix)]
fn elevated_move_overwrite_script() -> String {
    r#"set -u
src=$1
dst=$2
backup=$3
backed_up=0
if [ -e "$dst" ] || [ -L "$dst" ]; then
    /bin/mv -n -- "$dst" "$backup" || { echo "elevated move: cannot stage the existing destination" >&2; exit 1; }
    if [ -e "$dst" ] || [ -L "$dst" ]; then
        echo "elevated move: existing destination could not be staged" >&2
        exit 1
    fi
    backed_up=1
fi
if /bin/mv -f -- "$src" "$dst"; then
    if [ "$backed_up" -eq 1 ]; then
        /bin/rm -rf -- "$backup" || { echo "elevated move completed but the rollback backup could not be removed" >&2; exit 1; }
    fi
    exit 0
else
    status=$?
fi
/bin/rm -rf -- "$dst"
if [ "$backed_up" -eq 1 ]; then
    /bin/mv -- "$backup" "$dst" || { echo "elevated move failed and the previous destination could not be restored" >&2; exit 1; }
fi
exit "$status"
"#
    .to_string()
}

#[cfg(unix)]
fn elevated_move_exclusive_script() -> String {
    r#"set -u
src=$1
dst=$2
if [ -e "$dst" ] || [ -L "$dst" ]; then
    echo "elevated move: destination is occupied" >&2
    exit 1
fi
/bin/mv -n -- "$src" "$dst" || exit $?
if [ -e "$src" ] || [ -L "$src" ]; then
    echo "elevated move: destination is occupied; source was not moved" >&2
    exit 1
fi
"#
    .to_string()
}

#[cfg(unix)]
fn elevated_batch_copy_script() -> String {
    r#"set -u
owner=$1
dst=$2
shift 2
if [ "$#" -eq 0 ]; then
    echo "elevated copy: no sources supplied" >&2
    exit 1
fi
for src do
    /bin/cp -RPpn -- "$src" "$dst" || exit $?
    name=${src##*/}
    %CHOWN% -R -h "$owner" "$dst/$name"
done
"#
    .replace("%CHOWN%", ELEVATED_CHOWN)
}

#[cfg(unix)]
fn elevated_batch_move_script() -> String {
    r#"set -u
dst=$1
shift
if [ "$#" -eq 0 ]; then
    echo "elevated move: no sources supplied" >&2
    exit 1
fi
/bin/mv -n -- "$@" "$dst"
"#
    .to_string()
}

#[cfg(unix)]
fn elevated_transfer_invocation(
    op: &str,
    overwrite: bool,
    source: &str,
    destination: &str,
    owner: &str,
    backup: Option<&str>,
) -> Result<(String, Vec<String>), String> {
    let source = source.to_string();
    let destination = destination.to_string();
    let owner = owner.to_string();
    match (op, overwrite) {
        ("copy", true) => {
            let backup = backup
                .ok_or_else(|| "Overwrite copy requires a rollback backup path".to_string())?;
            Ok((
                elevated_copy_overwrite_script(),
                vec![source, destination, owner, backup.to_string()],
            ))
        }
        ("copy", false) => Ok((
            elevated_copy_exclusive_script(),
            vec![source, destination, owner],
        )),
        ("move", true) => {
            let backup = backup
                .ok_or_else(|| "Overwrite move requires a rollback backup path".to_string())?;
            Ok((
                elevated_move_overwrite_script(),
                vec![source, destination, backup.to_string()],
            ))
        }
        ("move", false) => Ok((elevated_move_exclusive_script(), vec![source, destination])),
        _ => Err(format!("Unknown elevated transfer operation: {}", op)),
    }
}

#[cfg(unix)]
fn elevated_batch_transfer_invocation(
    op: &str,
    sources: &[String],
    destination: &str,
    owner: &str,
) -> Result<(String, Vec<String>), String> {
    if sources.is_empty() {
        return Err("Elevated batch transfer has no sources".to_string());
    }
    match op {
        "copy" => {
            let mut args = Vec::with_capacity(sources.len() + 2);
            args.push(owner.to_string());
            args.push(destination.to_string());
            args.extend(sources.iter().cloned());
            Ok((elevated_batch_copy_script(), args))
        }
        "move" => {
            let mut args = Vec::with_capacity(sources.len() + 1);
            args.push(destination.to_string());
            args.extend(sources.iter().cloned());
            Ok((elevated_batch_move_script(), args))
        }
        _ => Err(format!("Unknown elevated transfer operation: {}", op)),
    }
}

#[cfg(target_os = "macos")]
fn run_macos_elevated_script(script: &str, args: &[String]) -> Result<(), String> {
    let mut line = format!("/bin/sh -c '{}' iyeris-elevated", shell_escape(script));
    for arg in args {
        line.push_str(&format!(" '{}'", shell_escape(arg)));
    }
    let osa = osa_escape(&line);
    let output = Command::new("osascript")
        .args([
            "-e",
            &format!("do shell script \"{}\" with administrator privileges", osa),
        ])
        .output()
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err(format!(
            "Elevated operation failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn run_linux_elevated_script(script: &str, args: &[String]) -> Result<(), String> {
    // The script is a fixed literal; all untrusted paths/owners follow `$0`
    // as positional arguments. stdin is not used, so `sh -c` cannot read a
    // second, attacker-supplied program from the terminal.
    let mut pkexec_args: Vec<String> = vec![
        "--".to_string(),
        "/bin/sh".to_string(),
        "-c".to_string(),
        script.to_string(),
        "iyeris-elevated".to_string(),
    ];
    pkexec_args.extend(args.iter().cloned());
    let output = Command::new("pkexec")
        .args(&pkexec_args)
        .output()
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err(format!(
            "Elevated operation failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    Ok(())
}

/// Recursively apply the destination parent owner without ever following a
/// symlink. `lchown` changes the link entry itself; recursion only descends
/// into entries whose `symlink_metadata` says they are directories.
#[cfg(unix)]
fn chown_tree_symlink_safe(root: &std::path::Path, owner: DestinationOwner) -> Result<(), String> {
    use std::os::unix::fs::lchown;

    fn visit(path: &std::path::Path, owner: DestinationOwner) -> Result<(), String> {
        let metadata = std::fs::symlink_metadata(path).map_err(|error| {
            format!(
                "Cannot inspect {} while updating ownership: {}",
                path.display(),
                error
            )
        })?;
        lchown(path, Some(owner.uid), Some(owner.gid)).map_err(|error| {
            format!(
                "Cannot update ownership of {} to {}: {}",
                path.display(),
                owner.spec(),
                error
            )
        })?;
        if metadata.is_dir() && !metadata.file_type().is_symlink() {
            let entries = std::fs::read_dir(path).map_err(|error| {
                format!(
                    "Cannot read {} while updating ownership: {}",
                    path.display(),
                    error
                )
            })?;
            for entry in entries {
                let entry = entry.map_err(|error| {
                    format!(
                        "Cannot read an entry in {} while updating ownership: {}",
                        path.display(),
                        error
                    )
                })?;
                visit(&entry.path(), owner)?;
            }
        }
        Ok(())
    }

    visit(root, owner)
}

/// Run privileged Windows file operations through the native Shell API.
///
/// `IFileOperation` owns the UAC prompt and performs copy/move/delete directly,
/// avoiding shell command construction and encoded PowerShell launchers. The
/// latter look indistinguishable from common malware loaders to heuristic AV.
#[cfg(target_os = "windows")]
fn run_windows_file_operations(
    op: &str,
    items: &[(String, Option<String>)],
    destination_is_folder: bool,
    overwrite: bool,
) -> Result<(), String> {
    use std::path::Path;
    use windows::{
        core::{HSTRING, PCWSTR},
        Win32::{
            System::Com::{
                CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER,
                COINIT_APARTMENTTHREADED,
            },
            UI::Shell::{
                FileOperation, IFileOperation, IShellItem, SHCreateItemFromParsingName,
                FOFX_EARLYFAILURE, FOFX_REQUIREELEVATION, FOFX_SHOWELEVATIONPROMPT,
                FOF_NOCONFIRMATION, FOF_NOCONFIRMMKDIR, FOF_NOERRORUI, FOF_RENAMEONCOLLISION,
                FOF_SILENT,
            },
        },
    };

    fn destination_parts(
        dest: &str,
        destination_is_folder: bool,
    ) -> Result<(String, Option<String>), String> {
        let path = Path::new(dest);
        if destination_is_folder {
            return Ok((dest.to_string(), None));
        }

        let parent = path
            .parent()
            .ok_or_else(|| format!("Destination has no parent directory: {dest}"))?;
        let name = path
            .file_name()
            .and_then(|value| value.to_str())
            .ok_or_else(|| format!("Destination has no valid file name: {dest}"))?;
        Ok((parent.to_string_lossy().to_string(), Some(name.to_string())))
    }

    unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) }
        .ok()
        .map_err(|error| format!("Failed to initialize Windows COM: {error}"))?;

    let result = (|| unsafe {
        let file_operation: IFileOperation =
            CoCreateInstance(&FileOperation, None, CLSCTX_INPROC_SERVER)
                .map_err(|error| format!("Failed to create Windows file operation: {error}"))?;

        file_operation
            .SetOperationFlags(
                (if overwrite {
                    FOF_NOCONFIRMATION
                } else {
                    FOF_RENAMEONCOLLISION
                }) | FOF_NOCONFIRMMKDIR
                    | FOF_SILENT
                    | FOF_NOERRORUI
                    | FOFX_SHOWELEVATIONPROMPT
                    | FOFX_REQUIREELEVATION
                    | FOFX_EARLYFAILURE,
            )
            .map_err(|error| format!("Failed to configure Windows file operation: {error}"))?;

        for (source, dest) in items {
            let source_path = HSTRING::from(source.as_str());
            let source_item: IShellItem = SHCreateItemFromParsingName(&source_path, None)
                .map_err(|error| format!("Failed to open source path {source}: {error}"))?;

            match op {
                "delete" => file_operation
                    .DeleteItem(&source_item, None)
                    .map_err(|error| format!("Failed to queue delete for {source}: {error}"))?,
                "copy" | "move" => {
                    let dest = dest
                        .as_deref()
                        .ok_or_else(|| format!("Destination required for {op}"))?;
                    let (destination_folder, new_name) =
                        destination_parts(dest, destination_is_folder)?;
                    let destination_path = HSTRING::from(destination_folder.as_str());
                    let destination_item: IShellItem =
                        SHCreateItemFromParsingName(&destination_path, None).map_err(|error| {
                            format!(
                                "Failed to open destination folder {destination_folder}: {error}"
                            )
                        })?;
                    let new_name = new_name.map(HSTRING::from);
                    let new_name = new_name
                        .as_ref()
                        .map_or(PCWSTR::null(), |value| PCWSTR(value.as_ptr()));

                    if op == "copy" {
                        file_operation
                            .CopyItem(&source_item, &destination_item, new_name, None)
                            .map_err(|error| {
                                format!("Failed to queue copy for {source}: {error}")
                            })?;
                    } else {
                        file_operation
                            .MoveItem(&source_item, &destination_item, new_name, None)
                            .map_err(|error| {
                                format!("Failed to queue move for {source}: {error}")
                            })?;
                    }
                }
                _ => return Err(format!("Unknown operation: {op}")),
            }
        }

        file_operation
            .PerformOperations()
            .map_err(|error| format!("Elevated Windows file operation failed: {error}"))?;
        if file_operation
            .GetAnyOperationsAborted()
            .map_err(|error| format!("Failed to read Windows file operation status: {error}"))?
            .as_bool()
        {
            return Err("Elevated Windows file operation was cancelled or aborted".to_string());
        }

        Ok(())
    })();

    unsafe { CoUninitialize() };
    result
}

/// Linux: verify the current_exe lives under a trusted system path before
/// re-launching it through the platform elevation API. Without this check, a
/// writable install location (snap extraction dir, sideloaded AppImage,
/// hostile $PATH shadowing) lets an attacker get a free root shell when
/// the user clicks "Restart as Admin." (M1)
#[cfg(any(target_os = "linux", target_os = "macos"))]
fn verify_root_owned_nonwritable_chain(path: &std::path::Path) -> Result<(), String> {
    use std::os::unix::fs::MetadataExt;

    for candidate in path.ancestors() {
        let metadata = std::fs::symlink_metadata(candidate).map_err(|error| {
            format!(
                "Cannot inspect elevated executable path component {}: {}",
                candidate.display(),
                error
            )
        })?;
        if metadata.uid() != 0 {
            return Err(format!(
                "Refusing to elevate executable through non-root-owned path component: {}",
                candidate.display()
            ));
        }
        if metadata.mode() & 0o022 != 0 {
            return Err(format!(
                "Refusing to elevate executable through group/world-writable path component: {}",
                candidate.display()
            ));
        }
    }
    Ok(())
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn verify_trusted_exe_path(exe: &std::path::Path) -> Result<std::path::PathBuf, String> {
    let canonical = exe
        .canonicalize()
        .map_err(|e| format!("Cannot canonicalize current_exe: {}", e))?;
    const TRUSTED_PREFIXES: &[&str] = &[
        "/usr/bin/",
        "/usr/local/bin/",
        "/usr/sbin/",
        "/usr/local/sbin/",
        "/opt/",
        "/snap/",
        "/var/lib/flatpak/",
        "/app/",          // flatpak runtime
        "/run/host/usr/", // flatpak host fallback
        "/Applications/", // unlikely on Linux but harmless
    ];
    let s = canonical.to_string_lossy();
    if TRUSTED_PREFIXES.iter().any(|p| s.starts_with(p)) {
        verify_root_owned_nonwritable_chain(&canonical)?;
        Ok(canonical)
    } else {
        Err(format!(
            "Refusing to elevate untrusted exe path: {} (not under a trusted system prefix)",
            s
        ))
    }
}

#[tauri::command]
pub async fn elevated_copy(source_path: String, dest_path: String) -> Result<(), String> {
    crate::validate_existing_path(&source_path, "Source")?;
    let dest = crate::validate_path(&dest_path, "Destination")?;
    validate_elevated_path(&source_path, "Source")?;
    validate_elevated_path(&dest_path, "Destination")?;
    crate::ensure_not_root_path(&dest, "copy destination")?;
    run_elevated_file_op("copy", &source_path, Some(&dest_path), false).await
}

#[tauri::command]
pub async fn elevated_move(source_path: String, dest_path: String) -> Result<(), String> {
    let src = crate::validate_existing_path(&source_path, "Source")?;
    let dest = crate::validate_path(&dest_path, "Destination")?;
    validate_elevated_path(&source_path, "Source")?;
    validate_elevated_path(&dest_path, "Destination")?;
    crate::ensure_not_root_path(&src, "move source")?;
    crate::ensure_not_root_path(&dest, "move destination")?;
    run_elevated_file_op("move", &source_path, Some(&dest_path), false).await
}

#[tauri::command]
pub async fn elevated_delete(item_path: String) -> Result<(), String> {
    let path = crate::validate_existing_path(&item_path, "Item")?;
    crate::ensure_not_root_path(&path, "delete")?;
    validate_elevated_path(&item_path, "Item")?;
    run_elevated_file_op("delete", &item_path, None, false).await?;
    crate::undo::clear_undo_redo_for_path(&item_path)?;
    Ok(())
}

#[tauri::command]
pub async fn elevated_rename(item_path: String, new_name: String) -> Result<(), String> {
    let path = crate::validate_existing_path(&item_path, "Item")?;
    let new_name = crate::file_operations::validate_child_name(&new_name, "New name")?;
    let new_path = path
        .parent()
        .ok_or("Cannot determine parent directory")?
        .join(&new_name);
    let new_path_str = new_path.to_string_lossy().to_string();
    validate_elevated_path(&item_path, "Item")?;
    validate_elevated_path(&new_path_str, "New path")?;
    run_elevated_file_op("move", &item_path, Some(&new_path_str), false).await
}

#[tauri::command]
pub async fn restart_as_admin() -> Result<(), String> {
    log::info!("[Elevated] restart_as_admin requested");
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::ffi::OsStrExt;
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        use windows::{
            core::{HSTRING, PCWSTR},
            Win32::{
                Foundation::HWND,
                UI::{Shell::ShellExecuteW, WindowsAndMessaging::SW_SHOWNORMAL},
            },
        };
        let verb = HSTRING::from("runas");
        let executable: Vec<u16> = exe
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let result = unsafe {
            ShellExecuteW(
                HWND::default(),
                PCWSTR(verb.as_ptr()),
                PCWSTR(executable.as_ptr()),
                PCWSTR::null(),
                PCWSTR::null(),
                SW_SHOWNORMAL,
            )
        };
        let status = result.0 as isize;
        if status <= 32 {
            return Err(format!(
                "Failed to restart as admin (ShellExecuteW status {status})"
            ));
        }
    }

    #[cfg(target_os = "macos")]
    {
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let exe_str = exe.display().to_string();
        // Build the shell command, then escape it for the AppleScript "..."
        // string literal. The previous version only escaped \ and " on the
        // _whole_ command; here we escape the path itself first as well so
        // a `"` in the install path cannot break out of AppleScript quoting. (M2)
        let inner = format!("open '{}'", shell_escape(&exe_str));
        let osa = osa_escape(&inner);
        Command::new("osascript")
            .args([
                "-e",
                &format!("do shell script \"{}\" with administrator privileges", osa),
            ])
            .spawn()
            .map_err(|e| format!("Failed to restart as admin: {}", e))?;
    }

    #[cfg(target_os = "linux")]
    {
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let trusted = verify_trusted_exe_path(&exe)?; // M1
        Command::new("pkexec")
            .arg("--")
            .arg(trusted)
            .spawn()
            .map_err(|e| format!("Failed to restart as admin: {}", e))?;
    }

    Ok(())
}

async fn run_elevated_file_op(
    op: &str,
    source: &str,
    dest: Option<&str>,
    overwrite: bool,
) -> Result<(), String> {
    log::debug!("[Elevated] {} src={} dst={:?}", op, source, dest);
    let source = source.to_string();
    let dest = dest.map(String::from);
    let op = op.to_string();

    tokio::task::spawn_blocking(move || {
        let _mutation_lock = crate::file_operations::mutation_lock()?;
        let (source, dest) = resolve_elevated_paths_before_exec(&op, &source, dest.as_deref())?;
        if let Some(target) = &dest {
            match std::fs::symlink_metadata(target) {
                Ok(_) if !overwrite => {
                    return Err(format!("Destination became occupied: {}", target))
                }
                Ok(metadata) if metadata.is_dir() => {
                    return launch_transfer_helper(&op, &source, target);
                }
                Ok(_) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => {
                    return Err(format!(
                        "Cannot inspect destination before elevation: {}",
                        error
                    ))
                }
            }
        }
        // Ownership is derived only after the destination parent has been
        // resolved/canonicalized above. A failed metadata lookup refuses the
        // operation rather than chowning to a guessed or stale owner.
        //
        // This function intentionally has no operation id and is never entered
        // into the cancellation registry: the privileged child cannot be
        // cancelled safely once the OS prompt has been accepted.
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        let transfer = match op.as_str() {
            "copy" | "move" => {
                let destination = dest
                    .as_deref()
                    .ok_or_else(|| format!("Destination required for {}", op))?;
                let owner = destination_parent_owner(destination)?;
                // Even if the destination is currently absent, pass a backup
                // path so a concurrent create still gets per-item rollback.
                let backup = if overwrite {
                    Some(elevated_rollback_path(std::path::Path::new(destination))?)
                } else {
                    None
                };
                Some((destination.to_string(), owner, backup))
            }
            _ => None,
        };

        #[cfg(target_os = "windows")]
        {
            run_windows_file_operations(&op, &[(source.clone(), dest.clone())], false, overwrite)?;
        }

        #[cfg(target_os = "macos")]
        {
            match op.as_str() {
                "copy" | "move" => {
                    let (destination, owner, backup) = transfer
                        .as_ref()
                        .ok_or_else(|| format!("Destination required for {}", op))?;
                    let backup = backup
                        .as_ref()
                        .map(|path| path.to_string_lossy().into_owned());
                    let (script, args) = elevated_transfer_invocation(
                        &op,
                        overwrite,
                        &source,
                        destination,
                        &owner.spec(),
                        backup.as_deref(),
                    )?;
                    run_macos_elevated_script(&script, &args)?;
                }
                "delete" => {
                    let line = format!("/bin/rm -rf -- '{}'", shell_escape(&source));
                    let osa = osa_escape(&line);
                    let output = Command::new("osascript")
                        .args([
                            "-e",
                            &format!("do shell script \"{}\" with administrator privileges", osa),
                        ])
                        .output()
                        .map_err(|e| e.to_string())?;
                    if !output.status.success() {
                        return Err(format!(
                            "Elevated operation failed: {}",
                            String::from_utf8_lossy(&output.stderr)
                        ));
                    }
                }
                _ => return Err(format!("Unknown operation: {}", op)),
            }
        }

        #[cfg(target_os = "linux")]
        {
            match op.as_str() {
                "copy" | "move" => {
                    let (destination, owner, backup) = transfer
                        .as_ref()
                        .ok_or_else(|| format!("Destination required for {}", op))?;
                    let backup = backup
                        .as_ref()
                        .map(|path| path.to_string_lossy().into_owned());
                    let (script, args) = elevated_transfer_invocation(
                        &op,
                        overwrite,
                        &source,
                        destination,
                        &owner.spec(),
                        backup.as_deref(),
                    )?;
                    run_linux_elevated_script(&script, &args)?;
                }
                "delete" => {
                    // Keep `--` so a path beginning with `-` is never parsed
                    // as a flag by the privileged rm.
                    let pkexec_args = ["--", "rm", "-rf", "--", source.as_str()];
                    let output = Command::new("pkexec")
                        .args(pkexec_args)
                        .output()
                        .map_err(|e| e.to_string())?;
                    if !output.status.success() {
                        return Err(format!(
                            "Elevated operation failed: {}",
                            String::from_utf8_lossy(&output.stderr)
                        ));
                    }
                }
                _ => return Err(format!("Unknown operation: {}", op)),
            }
        }

        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

async fn run_elevated_transfer_batch(
    operation: &str,
    source_paths: Vec<String>,
    dest_path: String,
    conflict_behavior: Option<String>,
    conflict_resolutions: Option<std::collections::HashMap<String, String>>,
) -> Result<(), String> {
    validate_elevated_list(&source_paths)?;
    for source in &source_paths {
        validate_elevated_path(source, "Source")?;
        let path = crate::validate_existing_path(source, "Source")?;
        crate::ensure_not_root_path(&path, "elevated source")?;
    }
    validate_elevated_path(&dest_path, "Destination")?;
    let destination = crate::validate_path(&dest_path, "Destination")?;
    crate::ensure_not_root_path(&destination, "elevated destination")?;
    let planned = {
        let _lock = crate::file_operations::mutation_lock()?;
        crate::file_operations::plan_file_operations(
            &source_paths,
            &destination,
            conflict_behavior.as_deref().unwrap_or("ask"),
            operation,
            &conflict_resolutions.unwrap_or_default(),
        )?
    };
    // Every item keeps its resolved name and overwrite choice. The privileged
    // executor rechecks collisions immediately before launching the native tool.
    // Items are committed one at a time; this is deliberately not a batch
    // transaction, and none of the item operations are cancellable.
    let total = planned.len();
    for (index, item) in planned.into_iter().enumerate() {
        run_elevated_file_op(
            operation,
            &item.source_path.to_string_lossy(),
            Some(&item.dest_path.to_string_lossy()),
            item.overwrite,
        )
        .await
        .map_err(|error| {
            format!(
                "Elevated {} failed for item {}/{} ({} -> {}): {}. \
                 Batch operations are not transactional: the {} item(s) completed before this failure remain applied.",
                operation,
                index + 1,
                total,
                item.source_path.display(),
                item.dest_path.display(),
                error,
                index
            )
        })?;
    }
    Ok(())
}

#[tauri::command]
pub async fn elevated_copy_batch(
    source_paths: Vec<String>,
    dest_path: String,
    conflict_behavior: Option<String>,
    conflict_resolutions: Option<std::collections::HashMap<String, String>>,
) -> Result<(), String> {
    run_elevated_transfer_batch(
        "copy",
        source_paths,
        dest_path,
        conflict_behavior,
        conflict_resolutions,
    )
    .await
}

#[tauri::command]
pub async fn elevated_move_batch(
    source_paths: Vec<String>,
    dest_path: String,
    conflict_behavior: Option<String>,
    conflict_resolutions: Option<std::collections::HashMap<String, String>>,
) -> Result<(), String> {
    run_elevated_transfer_batch(
        "move",
        source_paths,
        dest_path,
        conflict_behavior,
        conflict_resolutions,
    )
    .await
}

#[tauri::command]
pub async fn elevated_delete_batch(item_paths: Vec<String>) -> Result<(), String> {
    validate_elevated_list(&item_paths)?;
    for p in &item_paths {
        let path = crate::validate_existing_path(p, "Item")?;
        crate::ensure_not_root_path(&path, "delete")?;
        validate_elevated_path(p, "Item")?;
    }
    let items: Vec<(String, Option<String>)> = item_paths.into_iter().map(|s| (s, None)).collect();
    run_elevated_batch_op("delete", items.clone()).await?;
    for (item_path, _) in &items {
        crate::undo::clear_undo_redo_for_path(item_path)?;
    }
    Ok(())
}

/// Batch privileged primitive used by elevated batch delete. Like the other
/// elevated commands it is not cancellable, and it is not transactional across
/// items: `delete` stops at the first failing rm, leaving earlier removals
/// applied. The item-by-item copy/move batch path lives in
/// `run_elevated_transfer_batch`, which gives every item its own rollback copy.
async fn run_elevated_batch_op(
    op: &str,
    items: Vec<(String, Option<String>)>,
) -> Result<(), String> {
    if items.is_empty() {
        return Ok(());
    }
    if items.len() == 1 {
        let (src, dst) = &items[0];
        return run_elevated_file_op(op, src, dst.as_deref(), false).await;
    }
    let op = op.to_string();

    tokio::task::spawn_blocking(move || {
        let _mutation_lock = crate::file_operations::mutation_lock()?;
        let mut resolved_items: Vec<(String, Option<String>)> = Vec::with_capacity(items.len());
        for (src, dst) in &items {
            resolved_items.push(resolve_elevated_paths_before_exec(
                &op,
                src,
                dst.as_deref(),
            )?);
        }

        #[cfg(unix)]
        let batch_destination = if matches!(op.as_str(), "copy" | "move") {
            let destination = resolved_items
                .first()
                .and_then(|(_, destination)| destination.as_deref())
                .ok_or_else(|| format!("Destination required for {}", op))?;
            if resolved_items
                .iter()
                .any(|(_, candidate)| candidate.as_deref() != Some(destination))
            {
                return Err("Batch operation contains inconsistent destinations".to_string());
            }
            Some(destination.to_string())
        } else {
            None
        };

        #[cfg(unix)]
        let batch_owner = match (op.as_str(), batch_destination.as_deref()) {
            ("copy", Some(destination)) => Some(destination_parent_owner(destination)?),
            ("move", Some(destination)) => {
                destination_parent_owner(destination)?;
                None
            }
            _ => None,
        };

        #[cfg(target_os = "windows")]
        {
            run_windows_file_operations(&op, &resolved_items, true, false)?;
        }

        #[cfg(target_os = "macos")]
        {
            match op.as_str() {
                "copy" | "move" => {
                    let destination = batch_destination
                        .as_deref()
                        .ok_or_else(|| format!("Destination required for {}", op))?;
                    let sources: Vec<String> = resolved_items
                        .iter()
                        .map(|(source, _)| source.clone())
                        .collect();
                    let owner = batch_owner
                        .as_ref()
                        .map(DestinationOwner::spec)
                        .unwrap_or_default();
                    let (script, args) =
                        elevated_batch_transfer_invocation(&op, &sources, destination, &owner)?;
                    run_macos_elevated_script(&script, &args)?;
                }
                "delete" => {
                    let mut lines = Vec::new();
                    for (src, _) in &resolved_items {
                        lines.push(format!("/bin/rm -rf -- '{}'", shell_escape(src)));
                    }
                    let script_content = lines.join(" && ");
                    let osa = osa_escape(&script_content);
                    let output = Command::new("osascript")
                        .args([
                            "-e",
                            &format!("do shell script \"{}\" with administrator privileges", osa),
                        ])
                        .output()
                        .map_err(|e| e.to_string())?;
                    if !output.status.success() {
                        return Err(format!(
                            "Elevated operation failed: {}",
                            String::from_utf8_lossy(&output.stderr)
                        ));
                    }
                }
                _ => return Err(format!("Unknown operation: {}", op)),
            }
        }

        #[cfg(target_os = "linux")]
        {
            match op.as_str() {
                "copy" | "move" => {
                    let destination = batch_destination
                        .as_deref()
                        .ok_or_else(|| format!("Destination required for {}", op))?;
                    let sources: Vec<String> = resolved_items
                        .iter()
                        .map(|(source, _)| source.clone())
                        .collect();
                    let owner = batch_owner
                        .as_ref()
                        .map(DestinationOwner::spec)
                        .unwrap_or_default();
                    let (script, args) =
                        elevated_batch_transfer_invocation(&op, &sources, destination, &owner)?;
                    run_linux_elevated_script(&script, &args)?;
                }
                "delete" => {
                    // rm accepts multiple paths. Build argv directly so
                    // elevation never interprets a generated shell program.
                    let mut args = vec!["--", "rm", "-rf", "--"];
                    for (source, _) in &resolved_items {
                        args.push(source.as_str());
                    }
                    let output = Command::new("pkexec")
                        .args(args)
                        .output()
                        .map_err(|e| e.to_string())?;
                    if !output.status.success() {
                        return Err(format!(
                            "Elevated operation failed: {}",
                            String::from_utf8_lossy(&output.stderr)
                        ));
                    }
                }
                _ => return Err(format!("Unknown operation: {}", op)),
            }
        }

        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
#[path = "elevated_tests.rs"]
mod tests;

/// A narrowly scoped CLI mode, handled before Tauri initializes any UI/plugins.
/// The OS elevation prompt authorizes this one transfer; no arbitrary commands.
pub(crate) fn handle_transfer_helper(args: &[String]) -> Option<Result<(), String>> {
    if args.get(1).map(String::as_str) != Some("--iyeris-elevated-transfer") {
        return None;
    }
    Some((|| {
        if args.len() != 5 || !matches!(args[2].as_str(), "copy" | "move") {
            return Err("Invalid elevated transfer arguments".to_string());
        }
        validate_elevated_list(&args[3..])?;
        let (source, destination) =
            resolve_elevated_paths_before_exec(&args[2], &args[3], Some(&args[4]))?;
        replace_directory_transaction(
            &args[2],
            std::path::Path::new(&source),
            std::path::Path::new(destination.as_deref().ok_or("Missing destination")?),
        )
    })())
}

fn replace_directory_transaction(
    operation: &str,
    source: &std::path::Path,
    destination: &std::path::Path,
) -> Result<(), String> {
    use crate::file_operations::{
        copy_entry_exclusive, remove_existing_path, rename_exclusive, reserve_staging_rename,
    };
    if !matches!(operation, "copy" | "move") {
        return Err("Invalid transfer operation".to_string());
    }
    if source == destination || destination.starts_with(source) || source.starts_with(destination) {
        return Err("Cannot replace overlapping directories".to_string());
    }
    // Resolve ownership before touching the destination and fail closed: a
    // metadata error must not fall back to copying root-owned output in place.
    #[cfg(unix)]
    let destination_owner = destination_parent_owner_path(destination)?;
    let parent = destination.parent().ok_or("Destination has no parent")?;
    let workspace = tempfile::Builder::new()
        .prefix(".iyeris-elevated-")
        .tempdir_in(parent)
        .map_err(|error| error.to_string())?;
    let staged_source = if operation == "move" {
        Some(reserve_staging_rename(source)?)
    } else {
        None
    };
    let original_source = source;
    let source = staged_source.as_deref().unwrap_or(source);
    let result = (|| {
        let staged = workspace.path().join("content");
        // Finish all data/metadata copying before moving the original destination.
        copy_entry_exclusive(source, &staged, &|| false)?;
        let backup = match std::fs::symlink_metadata(destination) {
            Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {
                // One hidden sibling backup per item. The source is already
                // staged, so this is the only destination backup taken.
                #[cfg(unix)]
                {
                    Some(reserve_elevated_backup(destination)?)
                }
                #[cfg(not(unix))]
                {
                    Some(reserve_staging_rename(destination)?)
                }
            }
            Ok(_) => return Err("Replacement destination changed type".to_string()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(error.to_string()),
        };
        if let Err(error) = rename_exclusive(&staged, destination) {
            if let Some(backup) = &backup {
                if let Err(recovery) = rename_exclusive(backup, destination) {
                    return Err(format!(
                        "{error}; recovery failed: {recovery}; original retained at {}",
                        backup.display()
                    ));
                }
            }
            return Err(error.to_string());
        }
        #[cfg(unix)]
        if let Err(error) = chown_tree_symlink_safe(destination, destination_owner) {
            match remove_existing_path(destination) {
                Ok(()) => {
                    if let Some(backup) = &backup {
                        if let Err(recovery) = rename_exclusive(backup, destination) {
                            return Err(format!(
                                "{error}; recovery failed: {recovery}; previous destination retained at {}",
                                backup.display()
                            ));
                        }
                        return Err(format!("{error}; the previous destination was restored"));
                    }
                    return Err(format!(
                        "{error}; the new destination was removed because ownership could not be fixed"
                    ));
                }
                Err(rollback) => {
                    return Err(format!(
                        "{error}; ownership rollback failed: {rollback}; previous destination retained at {}",
                        backup
                            .as_ref()
                            .map(|path| path.display().to_string())
                            .unwrap_or_else(|| "none".to_string())
                    ));
                }
            }
        }
        if operation == "move" {
            let metadata = std::fs::symlink_metadata(source).map_err(|error| error.to_string())?;
            let cleanup = if metadata.is_dir() && !metadata.file_type().is_symlink() {
                std::fs::remove_dir_all(source)
            } else {
                std::fs::remove_file(source)
            };
            if let Err(error) = cleanup {
                return Err(format!(
                    "Move copy retained at {}; source cleanup incomplete: {}; previous destination retained at {}",
                    destination.display(),
                    error,
                    backup
                        .as_ref()
                        .map(|path| path.display().to_string())
                        .unwrap_or_else(|| "none".to_string())
                ));
            }
        }
        if let Some(backup) = backup {
            remove_existing_path(&backup).map_err(|error| {
                format!(
                    "Transfer completed; previous destination remains at {}: {}",
                    backup.display(),
                    error
                )
            })?;
        }
        Ok(())
    })();
    if let Err(error) = result {
        if let Some(staged_source) = staged_source {
            if std::fs::symlink_metadata(&staged_source).is_ok() {
                if let Err(recovery) = rename_exclusive(&staged_source, original_source) {
                    return Err(format!(
                        "{error}; source recovery failed: {recovery}; source retained at {}",
                        staged_source.display()
                    ));
                }
            }
        }
        return Err(error);
    }
    Ok(())
}

fn launch_transfer_helper(operation: &str, source: &str, destination: &str) -> Result<(), String> {
    let executable = std::env::current_exe().map_err(|error| error.to_string())?;
    #[cfg(unix)]
    let executable = verify_trusted_exe_path(&executable)?;
    let arguments = ["--iyeris-elevated-transfer", operation, source, destination];
    #[cfg(target_os = "linux")]
    let output = Command::new("pkexec")
        .arg("--")
        .arg(&executable)
        .args(arguments)
        .output()
        .map_err(|error| error.to_string())?;
    #[cfg(target_os = "macos")]
    let output = {
        let line = std::iter::once(executable.to_string_lossy().into_owned())
            .chain(arguments.iter().map(|arg| (*arg).to_string()))
            .map(|arg| format!("'{}'", shell_escape(&arg)))
            .collect::<Vec<_>>()
            .join(" ");
        Command::new("/usr/bin/osascript")
            .args([
                "-e",
                &format!(
                    "do shell script \"{}\" with administrator privileges",
                    osa_escape(&line)
                ),
            ])
            .output()
            .map_err(|error| error.to_string())?
    };
    #[cfg(unix)]
    {
        if !output.status.success() {
            return Err(format!(
                "Elevated replacement failed: {}",
                String::from_utf8_lossy(&output.stderr)
            ));
        }
        Ok(())
    }
    #[cfg(windows)]
    {
        use windows::{
            core::HSTRING,
            Win32::{
                Foundation::{CloseHandle, WAIT_OBJECT_0},
                System::Threading::{GetExitCodeProcess, WaitForSingleObject, INFINITE},
                UI::{
                    Shell::{ShellExecuteExW, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW},
                    WindowsAndMessaging::SW_HIDE,
                },
            },
        };
        // Windows argv quoting doubles backslashes only before quotes/end quotes.
        fn quote(arg: &str) -> String {
            let mut out = String::from("\"");
            let mut slashes = 0;
            for ch in arg.chars() {
                if ch == '\\' {
                    slashes += 1;
                    continue;
                }
                out.push_str(&"\\".repeat(if ch == '"' { slashes * 2 + 1 } else { slashes }));
                slashes = 0;
                out.push(ch);
            }
            out.push_str(&"\\".repeat(slashes * 2));
            out.push('"');
            out
        }
        let executable = HSTRING::from(executable.as_os_str());
        let parameters = HSTRING::from(arguments.map(quote).join(" "));
        let verb = HSTRING::from("runas");
        let mut info = SHELLEXECUTEINFOW {
            cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
            fMask: SEE_MASK_NOCLOSEPROCESS,
            lpVerb: windows::core::PCWSTR(verb.as_ptr()),
            lpFile: windows::core::PCWSTR(executable.as_ptr()),
            lpParameters: windows::core::PCWSTR(parameters.as_ptr()),
            nShow: SW_HIDE.0,
            ..Default::default()
        };
        unsafe {
            ShellExecuteExW(&mut info).map_err(|error| error.to_string())?;
            let waited = WaitForSingleObject(info.hProcess, INFINITE);
            let mut code = 1;
            let status = GetExitCodeProcess(info.hProcess, &mut code);
            let _ = CloseHandle(info.hProcess);
            if waited != WAIT_OBJECT_0 || status.is_err() || code != 0 {
                return Err(format!("Elevated replacement failed. Check {} for retained .iyeris-rename-tmp backups before retrying.", destination));
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod replacement_tests {
    use super::*;
    use std::fs;

    #[test]
    fn replacement_is_exact_and_move_removes_source_only_after_copy() {
        for operation in ["copy", "move"] {
            let temp = tempfile::tempdir().unwrap();
            let source = temp.path().join("source");
            let destination = temp.path().join("destination");
            fs::create_dir(&source).unwrap();
            fs::create_dir(&destination).unwrap();
            fs::write(source.join("new"), b"new contents").unwrap();
            fs::write(destination.join("old"), b"old contents").unwrap();
            replace_directory_transaction(operation, &source, &destination).unwrap();
            assert_eq!(fs::read(destination.join("new")).unwrap(), b"new contents");
            assert!(!destination.join("old").exists());
            assert_eq!(source.exists(), operation == "copy");
            assert!(!fs::read_dir(temp.path()).unwrap().any(|entry| entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(".iyeris-")));
        }
    }

    #[test]
    fn failed_staging_leaves_previous_destination_intact() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("missing");
        let destination = temp.path().join("destination");
        fs::create_dir(&destination).unwrap();
        fs::write(destination.join("old"), b"old contents").unwrap();
        assert!(replace_directory_transaction("copy", &source, &destination).is_err());
        assert_eq!(fs::read(destination.join("old")).unwrap(), b"old contents");
    }

    #[test]
    fn helper_rejects_unknown_commands_and_overlapping_paths() {
        let args = [
            "iyeris",
            "--iyeris-elevated-transfer",
            "delete",
            "/tmp/source",
            "/tmp/destination",
        ]
        .map(String::from);
        assert!(handle_transfer_helper(&args).unwrap().is_err());
        assert!(replace_directory_transaction(
            "copy",
            std::path::Path::new("/tmp/source"),
            std::path::Path::new("/tmp/source/child")
        )
        .is_err());
    }
}
