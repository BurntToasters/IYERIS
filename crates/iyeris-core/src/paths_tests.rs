use super::*;

#[cfg(unix)]
#[test]
fn validate_path_preserves_trailing_spaces() {
    let temp = tempfile::tempdir().unwrap();
    let intended = temp.path().join("report ");
    let sibling = temp.path().join("report");
    std::fs::write(&intended, b"selected").unwrap();
    std::fs::write(&sibling, b"unselected").unwrap();
    let validated = validate_path(intended.to_str().unwrap(), "File").unwrap();
    assert_eq!(validated, intended);
    assert_eq!(std::fs::read(validated).unwrap(), b"selected");
}

#[cfg(unix)]
#[test]
fn state_directory_rejects_symlink_above_existing_parent() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let real = root.join("real");
    std::fs::create_dir_all(real.join("existing")).unwrap();
    std::os::unix::fs::symlink(&real, root.join("link")).unwrap();
    assert!(ensure_real_directory_tree(&root.join("link/existing/new"), "State").is_err());
    assert!(!real.join("existing/new").exists());
}

#[test]
fn make_temp_path_includes_purpose() {
    let base = Path::new("/tmp/test.json");
    let temp = make_temp_path(base, "download");
    let name = temp
        .file_name()
        .and_then(|n| n.to_str())
        .expect("temp path should have a valid UTF-8 filename");
    assert!(name.contains("download"));
    assert!(name.ends_with(".tmp"));
}

#[test]
fn make_temp_path_unique() {
    let base = Path::new("/tmp/test.json");
    let t1 = make_temp_path(base, "test");
    let t2 = make_temp_path(base, "test");
    assert_ne!(t1, t2);
}

#[test]
fn validate_path_rejects_empty() {
    assert!(validate_path("", "Test").is_err());
    assert!(validate_path("   ", "Test").is_err());
}

#[test]
fn validate_path_rejects_relative() {
    assert!(validate_path("relative/path", "Test").is_err());
}

#[test]
fn validate_path_rejects_nul_and_oversized_input() {
    assert!(validate_path("/tmp/bad\0name", "Test").is_err());
    let oversized = format!("/tmp/{}", "x".repeat(1_048_576));
    assert!(validate_path(&oversized, "Test").is_err());
}

#[test]
fn app_state_directory_creates_nested_tree_and_canonicalizes() {
    let temp = tempfile::tempdir().expect("tempdir");
    let path = temp.path().join("state").join("nested");
    let resolved = ensure_app_state_directory(&path, "Test state").expect("create state dir");
    assert!(path.is_dir());
    assert_eq!(resolved, path.canonicalize().expect("canonical path"));
}

#[cfg(unix)]
#[test]
fn app_state_directory_allows_symlinked_ancestor() {
    use std::os::unix::fs::symlink;
    let temp = tempfile::tempdir().expect("tempdir");
    let real = temp.path().join("real");
    std::fs::create_dir_all(&real).expect("create real dir");
    let link = temp.path().join("link");
    symlink(&real, &link).expect("create ancestor symlink");

    let resolved = ensure_app_state_directory(&link.join("state"), "Test state")
        .expect("trusted ancestor symlink should be allowed");
    assert!(resolved.starts_with(real.canonicalize().expect("canonical real dir")));
    assert!(resolved.ends_with("state"));
}

#[cfg(unix)]
#[test]
fn app_state_directory_rejects_symlinked_final_component() {
    use std::os::unix::fs::symlink;
    let temp = tempfile::tempdir().expect("tempdir");
    let real = temp.path().join("real");
    std::fs::create_dir_all(&real).expect("create real dir");
    let link = temp.path().join("link");
    symlink(&real, &link).expect("create symlink");

    assert!(ensure_app_state_directory(&link, "Test state").is_err());
}

#[test]
fn app_state_directory_rejects_non_directory() {
    let temp = tempfile::tempdir().expect("tempdir");
    let file = temp.path().join("state");
    std::fs::write(&file, "not a directory").expect("write temp file");

    assert!(ensure_app_state_directory(&file, "Test state").is_err());
}
