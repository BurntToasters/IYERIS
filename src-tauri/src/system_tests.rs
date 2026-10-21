#[test]
fn system_text_scale_is_finite_and_bounded() {
    assert_eq!(super::sanitize_system_text_scale(f64::NAN), 1.0);
    assert_eq!(super::sanitize_system_text_scale(f64::INFINITY), 1.0);
    assert_eq!(super::sanitize_system_text_scale(-10.0), 0.5);
    assert_eq!(super::sanitize_system_text_scale(10.0), 3.0);
    assert_eq!(super::sanitize_system_text_scale(1.25), 1.25);
}

#[cfg(not(target_os = "windows"))]
#[test]
fn native_integration_exe_validation_rejects_shell_delimiters() {
    assert!(super::validate_native_integration_exe_path("/opt/IYERIS/app").is_ok());
    assert!(super::validate_native_integration_exe_path("/opt/IYERIS's/app").is_err());
    assert!(super::validate_native_integration_exe_path("/opt/IYERIS\"s/app").is_err());
    assert!(super::validate_native_integration_exe_path("/opt/IYERIS;app").is_err());
    assert!(super::validate_native_integration_exe_path("/opt/IYERIS%f/app").is_err());
}

#[test]
fn diagnostics_settings_allowlist_excludes_private_and_unknown_fields() {
    let private_marker = "private-value-must-not-leak";
    let raw = serde_json::json!({
        "theme": "dark",
        "viewMode": "list",
        "enableIndexer": true,
        "maxSearchHistoryItems": 12,
        "startupPath": private_marker,
        "savedSearches": [{ "query": private_marker, "scopePath": private_marker }],
        "recentTransferDestinations": [private_marker],
        "folderIcons": { private_marker: private_marker },
        "searchHistory": [private_marker],
        "directoryHistory": [private_marker],
        "bookmarks": [private_marker],
        "arbitraryFutureField": private_marker
    });

    let safe = super::diagnostics_settings_allowlist(&raw);
    let serialized = serde_json::to_string(&safe).expect("safe settings should serialize");
    assert_eq!(safe["theme"], "dark");
    assert_eq!(safe["viewMode"], "list");
    assert_eq!(safe["enableIndexer"], true);
    assert_eq!(safe["maxSearchHistoryItems"], 12);
    assert!(!serialized.contains(private_marker));
    assert!(safe.get("savedSearches").is_none());
    assert!(safe.get("arbitraryFutureField").is_none());
}

#[test]
fn diagnostics_export_writes_real_json_and_returns_the_chosen_path() {
    let directory = tempfile::tempdir().expect("temporary directory should be created");
    let path = directory.path().join("diagnostics.json");
    let content = r#"{"version":"3.0","settings":{"theme":"dark"}}"#;

    super::write_diagnostics_file(&path, content).expect("diagnostics should be written");
    let actual = std::fs::read_to_string(&path).expect("chosen output should exist");
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&actual).unwrap(),
        serde_json::json!({ "version": "3.0", "settings": { "theme": "dark" } })
    );
    let result = super::diagnostics_export_result(Some(path.clone()));
    assert_eq!(result.status, "saved");
    assert_eq!(result.path.as_deref(), path.to_str());
}

#[test]
fn diagnostics_export_cancellation_is_distinct_from_failure() {
    let result = super::diagnostics_export_result(None);
    assert_eq!(result.status, "cancelled");
    assert!(result.path.is_none());
}

#[cfg(unix)]
#[test]
fn diagnostics_export_refuses_to_clobber_symlink_destinations() {
    use std::os::unix::fs::symlink;

    let directory = tempfile::tempdir().expect("temporary directory should be created");
    let target = directory.path().join("target.json");
    let link = directory.path().join("diagnostics.json");
    std::fs::write(&target, "keep target").expect("target should be written");
    symlink(&target, &link).expect("symlink should be created");

    assert!(super::write_diagnostics_file(&link, "{} ").is_err());
    assert_eq!(std::fs::read_to_string(&target).unwrap(), "keep target");
}
