use super::*;

#[test]
fn validate_elevated_path_rejects_metacharacters() {
    assert!(validate_elevated_path("/tmp/foo$(rm -rf ~).txt", "Source").is_err());
    assert!(validate_elevated_path("/tmp/foo`whoami`.txt", "Source").is_err());
    assert!(validate_elevated_path("/tmp/foo;bar", "Source").is_err());
    assert!(validate_elevated_path("/tmp/foo|bar", "Source").is_err());
    assert!(validate_elevated_path("/tmp/foo&bar", "Source").is_err());
    assert!(validate_elevated_path("/tmp/foo<bar", "Source").is_err());
    assert!(validate_elevated_path("/tmp/foo>bar", "Source").is_err());
    assert!(validate_elevated_path("/tmp/foo\nbar", "Source").is_err());
}

#[test]
fn validate_elevated_path_rejects_dash_basename() {
    // A path whose basename starts with `-` would be parsed as a flag
    // by the privileged cp/mv/rm if `--` wasn't there. We reject anyway.
    assert!(validate_elevated_path("--no-preserve-root", "Source").is_err());
    assert!(validate_elevated_path("/tmp/-rf", "Source").is_err());
    assert!(validate_elevated_path("-target-directory=/etc/cron.d", "Source").is_err());
}

#[test]
fn validate_elevated_path_rejects_control_chars() {
    assert!(validate_elevated_path("/tmp/foo\0bar", "Source").is_err());
    assert!(validate_elevated_path("/tmp/foo\x07bar", "Source").is_err());
}

#[test]
fn validate_elevated_path_accepts_normal_paths() {
    assert!(validate_elevated_path("/tmp/foo.txt", "Source").is_ok());
    assert!(validate_elevated_path("/Users/dev/My File.txt", "Source").is_ok());
    assert!(validate_elevated_path("/var/log/system.log", "Source").is_ok());
    assert!(validate_elevated_path("/tmp/file with spaces.txt", "Source").is_ok());
    // Apostrophes in filenames are OK — shell_escape handles them.
    assert!(validate_elevated_path("/tmp/Joe's File.txt", "Source").is_ok());
}

#[cfg(target_os = "macos")]
#[test]
fn shell_escape_handles_apostrophes() {
    assert_eq!(shell_escape("foo's"), "foo'\\''s");
    assert_eq!(shell_escape("plain"), "plain");
}

#[cfg(target_os = "linux")]
#[test]
fn elevation_rejects_user_owned_executable_chain() {
    use std::os::unix::fs::MetadataExt;

    let temp = tempfile::tempdir().unwrap();
    let executable = temp.path().join("iyeris");
    std::fs::write(&executable, b"test").unwrap();
    if std::fs::metadata(&executable).unwrap().uid() != 0 {
        assert!(verify_root_owned_nonwritable_chain(&executable).is_err());
    }
}

#[cfg(target_os = "macos")]
#[test]
fn osa_escape_handles_backslash_and_quote() {
    assert_eq!(osa_escape(r#"with"quote"#), r#"with\"quote"#);
    assert_eq!(osa_escape(r"with\back"), r"with\\back");
}

#[cfg(unix)]
fn owner_of(path: &std::path::Path) -> DestinationOwner {
    use std::os::unix::fs::MetadataExt;
    let metadata = std::fs::metadata(path).unwrap();
    DestinationOwner {
        uid: metadata.uid(),
        gid: metadata.gid(),
    }
}

#[cfg(unix)]
fn run_transfer_script(
    op: &str,
    overwrite: bool,
    source: &std::path::Path,
    destination: &std::path::Path,
    owner: &DestinationOwner,
    backup: Option<&std::path::Path>,
) -> std::process::Output {
    let source = source.to_string_lossy().into_owned();
    let destination = destination.to_string_lossy().into_owned();
    let backup = backup.map(|path| path.to_string_lossy().into_owned());
    let (script, args) = elevated_transfer_invocation(
        op,
        overwrite,
        &source,
        &destination,
        &owner.spec(),
        backup.as_deref(),
    )
    .unwrap();
    std::process::Command::new("/bin/sh")
        .arg("-c")
        .arg(script)
        .arg("iyeris-elevated-test")
        .args(args)
        .output()
        .unwrap()
}

#[cfg(unix)]
#[test]
fn destination_owner_is_derived_from_resolved_parent() {
    let temp = tempfile::tempdir().unwrap();
    let destination = temp.path().join("child");
    let owner = destination_parent_owner(destination.to_str().unwrap()).unwrap();
    assert_eq!(owner, owner_of(temp.path()));
    assert_eq!(owner.spec(), format!("{}:{}", owner.uid, owner.gid));
}

#[cfg(unix)]
#[test]
fn destination_owner_rejects_missing_parent_metadata() {
    let temp = tempfile::tempdir().unwrap();
    let destination = temp.path().join("missing").join("child");
    assert!(destination_parent_owner(destination.to_str().unwrap()).is_err());
}

#[cfg(unix)]
#[test]
fn rollback_backup_is_a_hidden_sibling_without_collisions() {
    let temp = tempfile::tempdir().unwrap();
    let destination = temp.path().join("target");
    let first = elevated_rollback_path(&destination).unwrap();
    let second = elevated_rollback_path(&destination).unwrap();
    assert_eq!(first.parent(), Some(temp.path()));
    assert!(first
        .file_name()
        .unwrap()
        .to_string_lossy()
        .starts_with(".iyeris-elevated-backup-"));
    assert_ne!(first, second);
    assert!(!first.exists());
    assert!(!second.exists());
}

#[cfg(unix)]
#[test]
fn transfer_invocation_preserves_ownership_and_passes_paths_as_arguments() {
    let (copy_overwrite, args) = elevated_transfer_invocation(
        "copy",
        true,
        "/source",
        "/destination",
        "501:20",
        Some("/backup"),
    )
    .unwrap();
    assert!(copy_overwrite.contains("/bin/cp -RPp"));
    assert!(copy_overwrite.contains(&format!("{ELEVATED_CHOWN} -R -h")));
    assert!(!copy_overwrite.contains("/source"));
    assert_eq!(args, ["/source", "/destination", "501:20", "/backup"]);

    let (copy_exclusive, args) =
        elevated_transfer_invocation("copy", false, "/source", "/destination", "501:20", None)
            .unwrap();
    assert!(copy_exclusive.contains("/bin/cp -RPpn"));
    assert_eq!(args, ["/source", "/destination", "501:20"]);

    let (move_overwrite, args) = elevated_transfer_invocation(
        "move",
        true,
        "/source",
        "/destination",
        "501:20",
        Some("/backup"),
    )
    .unwrap();
    assert!(move_overwrite.contains("/bin/mv -f"));
    assert_eq!(args, ["/source", "/destination", "/backup"]);

    let (move_exclusive, args) =
        elevated_transfer_invocation("move", false, "/source", "/destination", "501:20", None)
            .unwrap();
    assert!(move_exclusive.contains("/bin/mv -n"));
    assert_eq!(args, ["/source", "/destination"]);
}

#[cfg(unix)]
#[test]
fn overwrite_copy_replaces_destination_and_removes_backup() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("source");
    let destination = temp.path().join("destination");
    std::fs::write(&source, b"new contents").unwrap();
    std::fs::write(&destination, b"old contents").unwrap();
    let owner = owner_of(temp.path());
    let backup = elevated_rollback_path(&destination).unwrap();

    let output = run_transfer_script("copy", true, &source, &destination, &owner, Some(&backup));
    assert!(output.status.success(), "{output:?}");
    assert_eq!(std::fs::read(&destination).unwrap(), b"new contents");
    assert!(!backup.exists());
}

#[cfg(unix)]
#[test]
fn overwrite_copy_restores_destination_when_copy_fails() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("missing-source");
    let destination = temp.path().join("destination");
    std::fs::write(&destination, b"old contents").unwrap();
    let owner = owner_of(temp.path());
    let backup = elevated_rollback_path(&destination).unwrap();

    let output = run_transfer_script("copy", true, &source, &destination, &owner, Some(&backup));
    assert!(!output.status.success());
    assert_eq!(std::fs::read(&destination).unwrap(), b"old contents");
    assert!(!backup.exists());
}

#[cfg(unix)]
#[test]
fn overwrite_copy_restores_destination_when_ownership_fix_fails() {
    let temp = tempfile::tempdir().unwrap();
    let current = owner_of(temp.path());
    if current.uid == 0 {
        // Root can chown to any uid, so this failure cannot be induced.
        return;
    }
    let source = temp.path().join("source");
    let destination = temp.path().join("destination");
    std::fs::write(&source, b"new contents").unwrap();
    std::fs::write(&destination, b"old contents").unwrap();
    let bad_owner = DestinationOwner {
        uid: if current.uid == 999_999 {
            999_998
        } else {
            999_999
        },
        gid: current.gid,
    };
    let backup = elevated_rollback_path(&destination).unwrap();

    let output = run_transfer_script(
        "copy",
        true,
        &source,
        &destination,
        &bad_owner,
        Some(&backup),
    );
    assert!(!output.status.success());
    assert_eq!(std::fs::read(&destination).unwrap(), b"old contents");
    assert!(!backup.exists());
}

#[cfg(unix)]
#[test]
fn overwrite_move_restores_destination_when_move_fails() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("missing-source");
    let destination = temp.path().join("destination");
    std::fs::write(&destination, b"old contents").unwrap();
    let owner = owner_of(temp.path());
    let backup = elevated_rollback_path(&destination).unwrap();

    let output = run_transfer_script("move", true, &source, &destination, &owner, Some(&backup));
    assert!(!output.status.success());
    assert_eq!(std::fs::read(&destination).unwrap(), b"old contents");
    assert!(!backup.exists());
}

#[cfg(unix)]
#[test]
fn overwrite_move_replaces_destination_and_removes_backup() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("source");
    let destination = temp.path().join("destination");
    std::fs::write(&source, b"new contents").unwrap();
    std::fs::write(&destination, b"old contents").unwrap();
    let owner = owner_of(temp.path());
    let backup = elevated_rollback_path(&destination).unwrap();

    let output = run_transfer_script("move", true, &source, &destination, &owner, Some(&backup));
    assert!(output.status.success(), "{output:?}");
    assert_eq!(std::fs::read(&destination).unwrap(), b"new contents");
    assert!(!source.exists());
    assert!(!backup.exists());
}

#[cfg(unix)]
#[test]
fn ownership_walk_does_not_follow_symlinks() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("tree");
    std::fs::create_dir(&root).unwrap();
    std::fs::create_dir(root.join("nested")).unwrap();
    std::fs::write(root.join("nested").join("file"), b"x").unwrap();
    std::os::unix::fs::symlink(root.join("missing-target"), root.join("dangling")).unwrap();
    let owner = owner_of(temp.path());

    chown_tree_symlink_safe(&root, owner).unwrap();
    assert!(std::fs::symlink_metadata(root.join("dangling"))
        .unwrap()
        .file_type()
        .is_symlink());
}

#[cfg(unix)]
#[test]
fn replacement_publishes_parent_owned_destination() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("source");
    let destination = temp.path().join("destination");
    std::fs::create_dir(&source).unwrap();
    std::fs::create_dir(&destination).unwrap();
    std::fs::write(source.join("new"), b"new contents").unwrap();
    std::fs::write(destination.join("old"), b"old contents").unwrap();

    replace_directory_transaction("copy", &source, &destination).unwrap();
    assert_eq!(owner_of(&destination), owner_of(temp.path()));
}
