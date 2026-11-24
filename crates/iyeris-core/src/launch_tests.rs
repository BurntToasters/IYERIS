use super::*;

#[test]
fn has_minimized_launch_arg_detects_supported_flags() {
    let args = vec!["app".to_string(), "--minimized".to_string()];
    assert!(has_minimized_launch_arg(&args));

    let args = vec!["app".to_string(), "--hidden".to_string()];
    assert!(has_minimized_launch_arg(&args));

    let args = vec!["app".to_string(), "--dev".to_string()];
    assert!(!has_minimized_launch_arg(&args));
}

#[cfg(unix)]
#[test]
fn first_open_path_arg_accepts_shell_looking_filenames() {
    let temp = tempfile::tempdir().expect("tempdir");
    let suspicious = temp.path().join("bad $`;|&<>\nname.txt");
    std::fs::write(&suspicious, "valid").expect("write temp file");
    let args = vec!["app".to_string(), suspicious.to_string_lossy().to_string()];
    assert_eq!(
        first_open_path_arg(&args),
        Some(
            suspicious
                .canonicalize()
                .expect("canonical path")
                .to_string_lossy()
                .to_string()
        )
    );
}

#[cfg(windows)]
#[test]
fn first_open_path_arg_accepts_shell_looking_filenames() {
    let temp = tempfile::tempdir().expect("tempdir");
    let suspicious = temp.path().join("bad $`;&name.txt");
    std::fs::write(&suspicious, "valid").expect("write temp file");
    let args = vec!["app".to_string(), suspicious.to_string_lossy().to_string()];
    assert_eq!(
        first_open_path_arg(&args),
        Some(
            suspicious
                .canonicalize()
                .expect("canonical path")
                .to_string_lossy()
                .to_string()
        )
    );
}

#[test]
fn first_open_path_arg_rejects_control_characters() {
    let temp = tempfile::tempdir().expect("tempdir");
    let control = temp.path().join("bad\u{1}name.txt");
    let args = vec!["app".to_string(), control.to_string_lossy().to_string()];
    assert!(first_open_path_arg(&args).is_none());
}

#[test]
fn first_open_path_arg_accepts_existing_absolute_path() {
    let temp = tempfile::tempdir().expect("tempdir");
    let file_path = temp.path().join("ok.txt");
    std::fs::write(&file_path, "ok").expect("write temp file");
    let args = vec!["app".to_string(), file_path.to_string_lossy().to_string()];
    assert_eq!(
        first_open_path_arg(&args),
        Some(
            file_path
                .canonicalize()
                .expect("canonical path")
                .to_string_lossy()
                .to_string()
        )
    );
}
