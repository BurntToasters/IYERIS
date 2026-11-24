use super::*;
use std::path::Path;

#[test]
fn should_exclude_skips_node_modules() {
    let segs = exclude_segments();
    let files = exclude_files();
    let p = Path::new("/home/u/proj/node_modules/pkg/index.js");
    assert!(should_exclude(p, &segs, &files));
}

#[test]
fn should_not_exclude_plain_cache_folder_name() {
    let segs = exclude_segments();
    let files = exclude_files();
    let p = Path::new("/home/u/proj/build/cache/output.bin");
    assert!(!should_exclude(p, &segs, &files));
}

#[test]
fn should_exclude_dot_cache() {
    let segs = exclude_segments();
    let files = exclude_files();
    let p = Path::new("/home/u/.cache/foo");
    assert!(should_exclude(p, &segs, &files));
}

#[test]
fn should_not_exclude_macos_library_tree() {
    let segs = exclude_segments();
    let files = exclude_files();
    let p = Path::new("/Users/dev/Library/Fonts/Arial.ttf");
    assert!(!should_exclude(p, &segs, &files));
}

#[test]
fn should_exclude_dot_snap() {
    let segs = exclude_segments();
    let files = exclude_files();
    let p = Path::new("/home/u/.snap/somepkg");
    assert!(should_exclude(p, &segs, &files));
}

#[test]
fn search_in_index_stops_when_cancelled() {
    let mut index = FILE_INDEX.write().unwrap();
    index.entries = vec![
        IndexEntry {
            name: "alpha.txt".to_string(),
            name_lower: "alpha.txt".to_string(),
            path: "/tmp/alpha.txt".to_string(),
            is_directory: false,
            is_file: true,
            is_hidden: false,
            size: 1,
            modified: 0.0,
        },
        IndexEntry {
            name: "alpine.txt".to_string(),
            name_lower: "alpine.txt".to_string(),
            path: "/tmp/alpine.txt".to_string(),
            is_directory: false,
            is_file: true,
            is_hidden: false,
            size: 1,
            modified: 0.0,
        },
    ];
    drop(index);

    let results = search_in_index_cancellable("al", || true);
    assert!(results.is_empty());

    FILE_INDEX.write().unwrap().entries.clear();
}

fn index_entry(
    name: &str,
    is_directory: bool,
    size: u64,
    modified: f64,
    is_hidden: bool,
) -> IndexEntry {
    IndexEntry {
        name: name.to_string(),
        name_lower: name.to_lowercase(),
        path: format!("/tmp/{}", name),
        is_directory,
        is_file: !is_directory,
        is_hidden,
        size,
        modified,
    }
}

fn matched_names<'a>(
    entries: &'a [IndexEntry],
    query: &str,
    filters: &IndexSearchFilters,
) -> Vec<&'a str> {
    let query_lower = query.to_lowercase();
    entries
        .iter()
        .filter(|entry| index_entry_matches_search(entry, &query_lower, filters))
        .map(|entry| entry.name.as_str())
        .collect()
}

#[test]
fn index_entry_hidden_flag_uses_dot_names_and_windows_attribute() {
    let temp = tempfile::tempdir().unwrap();
    let visible = temp.path().join("visible.txt");
    fs::write(&visible, "visible").unwrap();
    let meta = fs::symlink_metadata(&visible).unwrap();
    assert!(!compute_is_hidden("visible.txt", &meta));
    assert!(compute_is_hidden(".secret", &meta));

    #[cfg(target_os = "windows")]
    {
        crate::native_windows::update_file_attributes(&visible, None, Some(true), None).unwrap();
        let hidden_meta = fs::symlink_metadata(&visible).unwrap();
        assert!(compute_is_hidden("visible.txt", &hidden_meta));
    }
}

#[test]
fn legacy_index_files_recompute_dotfile_hidden_flag() {
    let temp = tempfile::tempdir().unwrap();
    let index_path = temp.path().join("file-index.json");
    fs::write(
            &index_path,
            r#"{"index":[
                {"name":"plain.txt","path":"/tmp/plain.txt","isDirectory":false,"isFile":true,"size":1,"modified":0.0},
                {"name":".secret","path":"/tmp/.secret","isDirectory":false,"isFile":true,"size":1,"modified":0.0}
            ],"lastIndexTime":0.0,"version":1}"#,
        )
        .unwrap();

    let data = load_index_from_disk(&index_path).expect("legacy index file should load");
    assert!(!data.metadata.truncated);
    assert!(data.metadata.truncation_reasons.is_empty());
    assert!(data.metadata.indexed_roots.is_empty());
    let plain = data
        .index
        .iter()
        .find(|entry| entry.name == "plain.txt")
        .unwrap();
    assert!(!plain.is_hidden);
    let secret = data
        .index
        .iter()
        .find(|entry| entry.name == ".secret")
        .unwrap();
    assert!(secret.is_hidden);
}

#[test]
fn index_scan_skips_overlapping_roots_and_deduplicates_canonical_entries() {
    let temp = tempfile::tempdir().unwrap();
    let child = temp.path().join("child");
    fs::create_dir_all(&child).unwrap();
    fs::write(child.join("needle.txt"), "x").unwrap();
    fs::write(temp.path().join("other.txt"), "y").unwrap();

    let result = build_index_from_locations_with_limits(
        &[temp.path().to_path_buf(), child.clone()],
        MAX_INDEX_SIZE,
        MAX_SCAN_DEPTH,
    );

    let paths: HashSet<_> = result
        .entries
        .iter()
        .map(|entry| normalized_path_key(Path::new(&entry.path)))
        .collect();
    assert_eq!(paths.len(), result.entries.len());
    assert!(!result.metadata.truncated);
    assert!(result.metadata.truncation_reasons.is_empty());
    assert_eq!(
        result.metadata.indexed_roots,
        [canonical_path_string(
            &temp.path().canonicalize().expect("canonical temp root")
        )]
    );
}

#[test]
fn index_scan_reports_entry_limit_only_when_an_unique_entry_is_omitted() {
    let exact = tempfile::tempdir().unwrap();
    fs::write(exact.path().join("only.txt"), "x").unwrap();
    let exact_result =
        build_index_from_locations_with_limits(&[exact.path().to_path_buf()], 2, MAX_SCAN_DEPTH);
    assert_eq!(exact_result.entries.len(), 2);
    assert!(!exact_result.metadata.truncated);
    assert!(exact_result.metadata.truncation_reasons.is_empty());

    let over = tempfile::tempdir().unwrap();
    fs::write(over.path().join("one.txt"), "x").unwrap();
    fs::write(over.path().join("two.txt"), "y").unwrap();
    let over_result =
        build_index_from_locations_with_limits(&[over.path().to_path_buf()], 2, MAX_SCAN_DEPTH);
    assert_eq!(over_result.entries.len(), 2);
    assert!(over_result.metadata.truncated);
    assert_eq!(over_result.metadata.truncation_reasons, ["entryLimit"]);
}

#[test]
fn index_scan_reports_depth_and_filesystem_errors_as_partial() {
    let deep = tempfile::tempdir().unwrap();
    let mut directory = deep.path().to_path_buf();
    for level in 0..3 {
        directory.push(format!("level-{level}"));
    }
    fs::create_dir_all(&directory).unwrap();
    fs::write(directory.join("deep.txt"), "x").unwrap();
    let depth_result =
        build_index_from_locations_with_limits(&[deep.path().to_path_buf()], MAX_INDEX_SIZE, 2);
    assert!(depth_result.metadata.truncated);
    assert_eq!(depth_result.metadata.truncation_reasons, ["depthLimit"]);

    let parent = tempfile::tempdir().unwrap();
    let missing = parent.path().join("missing-root");
    let error_result =
        build_index_from_locations_with_limits(&[missing], MAX_INDEX_SIZE, MAX_SCAN_DEPTH);
    assert!(error_result.metadata.truncated);
    assert_eq!(error_result.metadata.truncation_reasons, ["readErrors"]);
}

#[test]
fn index_metadata_persists_and_legacy_index_loads_with_defaults() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("file-index.json");
    let metadata = IndexMetadata {
        truncated: true,
        truncation_reasons: vec!["entryLimit".to_string(), "readErrors".to_string()],
        indexed_roots: vec![canonical_path_string(temp.path())],
    };

    save_index_to_disk(&path, &[], &metadata).unwrap();
    let data = load_index_from_disk(&path).expect("new metadata should load");
    assert_eq!(data.metadata.truncated, metadata.truncated);
    assert_eq!(
        data.metadata.truncation_reasons,
        metadata.truncation_reasons
    );
    assert_eq!(data.metadata.indexed_roots, metadata.indexed_roots);
}

#[test]
fn index_locations_include_existing_os_resolved_user_directories() {
    let user_dirs = directories::UserDirs::new().expect("user directories are available");
    let expected: Vec<_> = [
        user_dirs.desktop_dir(),
        user_dirs.document_dir(),
        user_dirs.download_dir(),
        user_dirs.picture_dir(),
        user_dirs.audio_dir(),
        user_dirs.video_dir(),
    ]
    .into_iter()
    .flatten()
    .filter(|path| path.exists())
    .filter_map(|path| path.canonicalize().ok())
    .map(|path| canonical_path_string(&path))
    .collect();
    let actual: HashSet<_> = get_index_locations()
        .iter()
        .filter_map(|path| path.canonicalize().ok())
        .map(|path| canonical_path_string(&path))
        .collect();

    // Minimal CI homes may not have any of the standard user folders.
    // In that case there is nothing this host can prove about them.
    if expected.is_empty() {
        return;
    }
    for path in expected {
        assert!(
            actual.contains(&path),
            "missing OS-resolved location {path}"
        );
    }
}

#[test]
fn index_search_excludes_hidden_entries_unless_include_hidden() {
    let entries = [
        index_entry("notes.txt", false, 1, 0.0, false),
        index_entry(".secret.txt", false, 1, 0.0, true),
        index_entry("hidden-by-attribute.txt", false, 1, 0.0, true),
        // Entries written before the flag existed still hide by dot name.
        index_entry(".legacy.txt", false, 1, 0.0, false),
    ];

    let visible_only = IndexSearchFilters {
        include_hidden: false,
        ..IndexSearchFilters::default()
    };
    assert_eq!(matched_names(&entries, "txt", &visible_only), ["notes.txt"]);

    let with_hidden = IndexSearchFilters {
        include_hidden: true,
        ..IndexSearchFilters::default()
    };
    assert_eq!(matched_names(&entries, "txt", &with_hidden).len(), 4);
}

#[test]
fn index_search_file_type_filter_skips_directories_and_other_extensions() {
    let entries = [
        index_entry("photo.PNG", false, 1, 0.0, false),
        index_entry("photo.txt", false, 1, 0.0, false),
        index_entry("photo.png", true, 1, 0.0, false),
    ];
    let filters = IndexSearchFilters {
        file_type: Some(".PNG".to_string()),
        ..IndexSearchFilters::default()
    };
    assert_eq!(matched_names(&entries, "photo", &filters), ["photo.PNG"]);
}

#[test]
fn index_search_size_filters_bound_files_only() {
    let entries = [
        index_entry("small.bin", false, 10, 0.0, false),
        index_entry("medium.bin", false, 100, 0.0, false),
        index_entry("large.bin", false, 1000, 0.0, false),
        index_entry("folder.bin", true, 1000, 0.0, false),
    ];

    let min_filters = IndexSearchFilters {
        min_size: Some(100),
        ..IndexSearchFilters::default()
    };
    assert_eq!(
        matched_names(&entries, "bin", &min_filters),
        ["medium.bin", "large.bin", "folder.bin"]
    );

    let max_filters = IndexSearchFilters {
        max_size: Some(100),
        ..IndexSearchFilters::default()
    };
    assert_eq!(
        matched_names(&entries, "bin", &max_filters),
        ["small.bin", "medium.bin", "folder.bin"]
    );
}

#[test]
fn index_search_date_filters_bound_modified_time() {
    let entries = [
        index_entry("old.txt", false, 1, 1_000.0, false),
        index_entry("current.txt", false, 1, 2_000.0, false),
        index_entry("future.txt", false, 1, 3_000.0, false),
    ];

    let from_filters = IndexSearchFilters {
        date_from_ms: Some(2_000.0),
        ..IndexSearchFilters::default()
    };
    assert_eq!(
        matched_names(&entries, "txt", &from_filters),
        ["current.txt", "future.txt"]
    );

    let to_filters = IndexSearchFilters {
        date_to_ms: Some(2_000.0),
        ..IndexSearchFilters::default()
    };
    assert_eq!(
        matched_names(&entries, "txt", &to_filters),
        ["old.txt", "current.txt"]
    );
}

#[test]
fn index_search_regex_filter_matches_entry_names() {
    let entries = [
        index_entry("report-12.pdf", false, 1, 0.0, false),
        index_entry("report-x.pdf", false, 1, 0.0, false),
        index_entry("annual-report-3.pdf", false, 1, 0.0, false),
    ];
    let filters = IndexSearchFilters {
        regex: Some(regex::Regex::new(r"^report-\d+\.pdf$").unwrap()),
        ..IndexSearchFilters::default()
    };
    assert_eq!(matched_names(&entries, "txt", &filters), ["report-12.pdf"]);
}
