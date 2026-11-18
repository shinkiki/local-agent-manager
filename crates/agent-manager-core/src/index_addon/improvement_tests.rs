use super::*;

fn setup() -> (tempfile::TempDir, PathBuf, PathBuf, String) {
    // G10: macOS's /var temp alias must not make valid fixtures look symlinked.
    let temporary_root = fs::canonicalize(std::env::temp_dir()).unwrap();
    let temp = tempfile::tempdir_in(temporary_root).unwrap();
    let app = temp.path().join("app");
    let root = temp.path().join("source");
    fs::create_dir(&root).unwrap();
    let view = add_index_source(
        &app,
        AddIndexSourceRequest {
            name: "Review fixtures".into(),
            path: root.to_string_lossy().into(),
        },
    )
    .unwrap();
    let id = view.sources[0].id.clone();
    set_index_settings(
        &app,
        SetIndexSettingsRequest {
            enabled: true,
            auto_refresh: true,
        },
    )
    .unwrap();
    set_index_source_enabled(
        &app,
        SetIndexSourceEnabledRequest {
            id: id.clone(),
            enabled: true,
        },
    )
    .unwrap();
    (temp, app, root, id)
}
fn find(app: &Path, query: &str) -> IndexSearchResult {
    search_index(
        app,
        SearchIndexRequest {
            query: query.into(),
            ..Default::default()
        },
    )
    .unwrap()
}

#[test]
fn g4_typescript_declarations_are_indexed_but_values_and_data_files_are_blocked() {
    let (_temp, app, root, id) = setup();
    fs::write(
        root.join("view.tsx"),
        "export function probeParameter(token: string, password: string | null) { return token; }",
    )
    .unwrap();
    for (name, text) in [
        (
            "assigned.ts",
            "let token: string = 'fixture-value-never-persist';",
        ),
        ("data.yaml", "password: string;"),
        ("data.json", r#"{"token": "string"}"#),
        (
            "unknown.ts",
            "const token: Something = 'fixture-value-never-persist';",
        ),
    ] {
        fs::write(root.join(name), text).unwrap();
    }
    let view = refresh_index_source(&app, &id).unwrap();
    // A one-line source file that is nothing but a credential value scrubs to nothing and is
    // reported as the whole-file exclusion it is; the YAML and JSON data files are excluded whole.
    assert_eq!((view.sources[0].files, view.sources[0].excluded), (1, 4));
    assert!(view.sources[0]
        .exclusion_counts
        .iter()
        .all(|count| count.reason != IndexExclusionReason::CredentialLines));
    assert_eq!(
        find(&app, "probeParameter").hits[0].relative_path,
        "view.tsx"
    );
    assert!(find(&app, "fixture-value-never-persist").hits.is_empty());
    let bytes = fs::read(app.join(DATABASE)).unwrap();
    assert!(!bytes
        .windows(b"fixture-value-never-persist".len())
        .any(|part| part == b"fixture-value-never-persist"));
}

#[test]
fn g4_g7_exclusion_diagnostics_are_bounded_metadata_and_follow_project_scope() {
    let (temp, app, root, id) = setup();
    fs::write(
        root.join("blocked.yaml"),
        "password: fixture-value-never-persist",
    )
    .unwrap();
    fs::write(root.join("binary.txt"), b"binary\0").unwrap();
    fs::write(root.join("image.png"), "unsupported").unwrap();
    fs::create_dir(root.join("node_modules")).unwrap();
    fs::write(root.join("node_modules/nested.txt"), "not traversed").unwrap();
    for n in 0..23 {
        fs::write(root.join(format!("hidden{n}.zip")), "unsupported").unwrap();
    }
    let view = refresh_index_source(&app, &id).unwrap();
    assert_eq!(view.sources[0].excluded, 27);
    assert_eq!(
        view.sources[0]
            .exclusion_counts
            .iter()
            .map(|c| c.count)
            .sum::<usize>(),
        27
    );
    let page = get_index_exclusions(
        &app,
        IndexExclusionsRequest {
            id: id.clone(),
            offset: 0,
            limit: Some(20),
            project: None,
        },
    )
    .unwrap();
    assert_eq!(
        (page.items.len(), page.total, page.next_offset),
        (20, 27, Some(20))
    );
    let encoded = serde_json::to_string(&page).unwrap();
    assert!(!encoded.contains("fixture-value"));
    assert!(!encoded.contains("not traversed"));
    assert!(!encoded.contains(root.to_str().unwrap()));
    assert!(page
        .items
        .iter()
        .any(|item| item.relative_path == "blocked.yaml"
            && item.reason == IndexExclusionReason::Credentials));
    let project = temp.path().join("project");
    let other = temp.path().join("other");
    fs::create_dir(&project).unwrap();
    fs::create_dir(&other).unwrap();
    set_index_source_projects(
        &app,
        SetIndexSourceProjectsRequest {
            id: id.clone(),
            projects: Some(vec![project.to_string_lossy().into()]),
        },
    )
    .unwrap();
    assert!(get_index_exclusions(
        &app,
        IndexExclusionsRequest {
            id,
            offset: 0,
            limit: None,
            project: Some(other.to_string_lossy().into())
        }
    )
    .is_err());
}

#[test]
fn g7_search_filters_exact_identifiers_and_prefers_literal_evidence() {
    let (_temp, app, root, id) = setup();
    fs::create_dir(root.join("src")).unwrap();
    fs::write(root.join("src/a.ts"), "export function orchardProbe() {}\n").unwrap();
    fs::write(root.join("b.md"), "orchardProbeSuffix").unwrap();
    fs::write(root.join("c.rs"), "fn orchardProbe() {}\n").unwrap();
    refresh_index_source(&app, &id).unwrap();
    assert_ne!(find(&app, "orchardProbe").hits[0].relative_path, "b.md");
    let exact = search_index(
        &app,
        SearchIndexRequest {
            query: "orchardProbe".into(),
            mode: IndexSearchMode::Exact,
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(exact.hits.len(), 2);
    let filtered = search_index(
        &app,
        SearchIndexRequest {
            query: "orchardProbe".into(),
            path_prefix: Some("src/".into()),
            extension: Some(".TS".into()),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(filtered.hits.len(), 1);
    assert_eq!(filtered.hits[0].relative_path, "src/a.ts");
    assert!(search_index(
        &app,
        SearchIndexRequest {
            query: "orchard".into(),
            path_prefix: Some("../".into()),
            ..Default::default()
        }
    )
    .is_err());
}

#[test]
fn g7_chunk_boundary_queries_and_short_excerpts_preserve_original_lines() {
    let (_temp, app, root, id) = setup();
    let mut lines = (1..=110)
        .map(|n| format!("ordinary line {n}"))
        .collect::<Vec<_>>();
    lines[49] = "orchard boundary witness".into();
    lines[50] = "기록 갱신 작업".into();
    fs::write(root.join("guide.md"), lines.join("\n")).unwrap();
    refresh_index_source(&app, &id).unwrap();
    let result = find(&app, "orchard 갱신");
    assert_eq!(result.hits.len(), 1);
    let hit = &result.hits[0];
    assert!(hit.excerpt.contains("orchard boundary witness"));
    assert!(hit.excerpt.contains("기록 갱신 작업"));
    assert!(hit.excerpt.lines().count() <= 8);
    let read = read_index_excerpt(
        &app,
        ReadIndexExcerptRequest {
            source_id: id,
            relative_path: hit.relative_path.clone(),
            digest: hit.digest.clone(),
            start_line: hit.start_line,
            end_line: hit.end_line,
            project: None,
        },
    )
    .unwrap();
    assert_eq!(read.excerpt, hit.excerpt);
}

#[test]
fn g7_stale_repeated_file_cannot_fill_the_candidate_budget() {
    let (_temp, app, root, id) = setup();
    fs::write(
        root.join("repeated.md"),
        "orchard repeated\n".repeat(12_000),
    )
    .unwrap();
    fs::write(root.join("fresh.md"), "orchard witness").unwrap();
    refresh_index_source(&app, &id).unwrap();
    fs::write(root.join("repeated.md"), "changed").unwrap();
    let result = find(&app, "orchard");
    assert_eq!(result.hits.len(), 1);
    assert_eq!(result.hits[0].relative_path, "fresh.md");
    assert_eq!(result.stale_files.len(), 1);
    assert!(!result.truncated);
}

#[test]
fn g7_search_reports_incomplete_and_pending_sources_separately_from_result_limit() {
    let (temp, app, root, id) = setup();
    fs::write(root.join("a.md"), "orchard").unwrap();
    fs::write(root.join("b.md"), "orchard").unwrap();
    refresh_source_with_limit(&app, &id, false, false, None, 1).unwrap();
    let partial = find(&app, "orchard");
    assert_eq!(partial.partial_sources, vec![id]);
    assert!(!partial.truncated);
    assert!(partial.pending_sources.is_empty());
    let other = temp.path().join("pending");
    fs::create_dir(&other).unwrap();
    let view = add_index_source(
        &app,
        AddIndexSourceRequest {
            name: "Pending".into(),
            path: other.to_string_lossy().into(),
        },
    )
    .unwrap();
    let pending = view
        .sources
        .iter()
        .find(|source| source.name == "Pending")
        .unwrap()
        .id
        .clone();
    set_index_source_enabled(
        &app,
        SetIndexSourceEnabledRequest {
            id: pending.clone(),
            enabled: true,
        },
    )
    .unwrap();
    assert_eq!(find(&app, "orchard").pending_sources, vec![pending]);
}

#[test]
fn g7_failed_refresh_keeps_last_success_and_manual_retry_clears_the_error() {
    let (temp, app, root, id) = setup();
    fs::write(root.join("a.md"), "orchard").unwrap();
    refresh_index_source(&app, &id).unwrap();
    let moved = temp.path().join("moved");
    fs::rename(&root, &moved).unwrap();
    assert!(refresh_index_source(&app, &id).is_err());
    let failed = get_index_sources(&app, false).unwrap().sources.remove(0);
    assert!(failed.indexed_at.is_some());
    assert!(failed.last_error.is_some());
    assert!(failed.next_retry_at.is_some());
    assert!(matches!(failed.refresh_state, IndexRefreshState::Failed));
    set_index_settings(
        &app,
        SetIndexSettingsRequest {
            enabled: true,
            auto_refresh: false,
        },
    )
    .unwrap();
    assert!(
        get_index_sources(&app, false).unwrap().sources[0]
            .next_retry_at
            .is_none(),
        "auto refresh off must not advertise an automatic retry"
    );
    fs::rename(moved, &root).unwrap();
    let source = refresh_index_source(&app, &id).unwrap().sources.remove(0);
    assert!(source.last_error.is_none());
    assert!(source.next_retry_at.is_none());
    assert!(matches!(source.refresh_state, IndexRefreshState::Ready));
    let guard = watch::RefreshGuard::begin(&app, &id).unwrap();
    guard.update(64, 7);
    let source = get_index_sources(&app, false).unwrap().sources.remove(0);
    assert!(matches!(source.refresh_state, IndexRefreshState::Indexing));
    assert_eq!(source.progress.unwrap().read_files, 7);
    assert!(watch::RefreshGuard::begin(&app, &id).is_err());
    drop(guard);
}

#[test]
fn g7_automatic_refresh_reads_only_changed_files_and_periodically_reconciles() {
    let (_temp, app, root, id) = setup();
    for name in ["a.md", "b.md", "c.md"] {
        fs::write(root.join(name), "orchard").unwrap();
    }
    refresh_index_source(&app, &id).unwrap();
    let unchanged = refresh_source(&app, &id, true, true, None).unwrap();
    assert_eq!(unchanged.sources[0].read_files, 0);
    fs::write(root.join("a.md"), "orchard changed").unwrap();
    fs::write(root.join("d.md"), "orchard added").unwrap();
    fs::remove_file(root.join("c.md")).unwrap();
    let changed = refresh_source(&app, &id, true, true, None).unwrap();
    assert_eq!(changed.sources[0].read_files, 2);
    assert_eq!(changed.sources[0].files, 3);
    open(&app, true)
        .unwrap()
        .execute(
            "UPDATE sources SET full_checked_at=0,project_path=path WHERE id=?1",
            [&id],
        )
        .unwrap();
    refresh_automatic_sources(&app);
    let reconciled = get_index_sources(&app, false).unwrap();
    assert_eq!(reconciled.sources[0].read_files, 3);
    assert_eq!(find(&app, "changed").hits.len(), 1);
}

#[test]
fn g7_metadata_watcher_queues_create_update_delete_and_respects_global_disable() {
    let (_temp, app, root, id) = setup();
    let mut queue = watch::WatchQueue::default();
    let view = get_index_sources(&app, true).unwrap();
    assert_eq!(queue.poll(&app, &view), vec![id.clone()]);
    #[cfg(target_os = "linux")]
    assert!(
        queue.has_native(&id),
        "Linux uses native notifications for an eligible source"
    );
    queue.complete(&id);
    assert!(queue.poll(&app, &view).is_empty());
    fs::write(root.join("a.md"), "orchard").unwrap();
    assert_eq!(queue.poll(&app, &view), vec![id.clone()]);
    queue.complete(&id);
    fs::write(root.join("a.md"), "changed").unwrap();
    assert_eq!(queue.poll(&app, &view), vec![id.clone()]);
    queue.complete(&id);
    fs::remove_file(root.join("a.md")).unwrap();
    assert_eq!(queue.poll(&app, &view), vec![id.clone()]);
    let disabled = set_index_source_enabled(
        &app,
        SetIndexSourceEnabledRequest {
            id: id.clone(),
            enabled: false,
        },
    )
    .unwrap();
    assert!(queue.poll(&app, &disabled).is_empty());
    #[cfg(target_os = "linux")]
    assert!(!queue.has_native(&id));
    let reenabled = set_index_source_enabled(
        &app,
        SetIndexSourceEnabledRequest {
            id: id.clone(),
            enabled: true,
        },
    )
    .unwrap();
    assert_eq!(queue.poll(&app, &reenabled), vec![id.clone()]);
    #[cfg(target_os = "linux")]
    assert!(queue.has_native(&id));
    set_index_settings(
        &app,
        SetIndexSettingsRequest {
            enabled: false,
            auto_refresh: true,
        },
    )
    .unwrap();
    assert!(queue
        .poll(&app, &get_index_sources(&app, true).unwrap())
        .is_empty());
}

#[test]
fn g7_metadata_fallback_and_new_directory_notifications_preserve_changes() {
    let (_temp, app, root, id) = setup();
    let view = get_index_sources(&app, true).unwrap();
    let mut native = watch::WatchQueue::default();
    let mut fallback = watch::WatchQueue::default();
    fallback.use_metadata(&id);
    native.poll(&app, &view);
    fallback.poll(&app, &view);
    native.complete(&id);
    fallback.complete(&id);
    let nested = root.join("nested");
    fs::create_dir(&nested).unwrap();
    fs::write(nested.join("a.md"), "created").unwrap();
    assert_eq!(native.poll(&app, &view), vec![id.clone()]);
    assert_eq!(fallback.poll(&app, &view), vec![id.clone()]);
    native.complete(&id);
    fallback.complete(&id);
    // G7: the metadata fallback is stamp-based (size + timestamps) and bounded by the 10-minute
    // full check, so change the size here rather than relying on timestamp precision.
    fs::write(nested.join("a.md"), "changed content").unwrap();
    assert_eq!(native.poll(&app, &view), vec![id.clone()]);
    assert_eq!(fallback.poll(&app, &view), vec![id]);
}

#[test]
fn g7_symbol_search_keeps_the_declaration_instead_of_a_call_in_the_same_file() {
    let (_temp, app, root, id) = setup();
    let mut lines = vec!["callProbe();".to_owned(); 100];
    lines[89] = "pub fn callProbe() {}".into();
    fs::write(root.join("app.rs"), lines.join("\n")).unwrap();
    refresh_index_source(&app, &id).unwrap();
    let result = find(&app, "callProbe");
    assert_eq!(result.hits.len(), 1);
    assert!(result.hits[0].excerpt.contains("pub fn callProbe()"));
}

#[test]
fn g7_symbol_search_ignores_surrounding_whitespace_when_selecting_evidence() {
    let (_temp, app, root, id) = setup();
    let mut lines = vec!["ordinary context"; 40];
    lines[0] = "spaceProbe();";
    lines[29] = "pub fn spaceProbe() {}";
    fs::write(root.join("app.rs"), lines.join("\n")).unwrap();
    refresh_index_source(&app, &id).unwrap();
    let result = find(&app, "  spaceProbe\t");
    assert_eq!(result.hits.len(), 1);
    let hit = &result.hits[0];
    assert!(hit.excerpt.contains("pub fn spaceProbe()"));
    assert!(hit.start_line <= 30 && hit.end_line >= 30);
}

#[test]
fn g7_idle_manual_sources_wait_for_full_reconciliation_without_losing_retry() {
    let (_temp, app, root, id) = setup();
    fs::write(root.join("a.md"), "orchard").unwrap();
    refresh_index_source(&app, &id).unwrap();
    let connection = open(&app, true).unwrap();
    connection
        .execute("UPDATE sources SET attempt_at=1 WHERE id=?1", [&id])
        .unwrap();
    refresh_automatic_sources(&app);
    assert_eq!(
        get_index_sources(&app, false).unwrap().sources[0].last_attempt_at,
        Some(1),
        "idle sources must not be scanned on every periodic tick"
    );
    connection
        .execute("UPDATE sources SET full_checked_at=0 WHERE id=?1", [&id])
        .unwrap();
    refresh_automatic_sources(&app);
    let reconciled = get_index_sources(&app, false).unwrap().sources.remove(0);
    assert_eq!(reconciled.read_files, 1);
    assert_ne!(reconciled.last_attempt_at, Some(1));
    // A due manual-source retry still runs before the ten-minute full check.
    connection
        .execute(
            "UPDATE sources SET last_error='fixture failure',error_at=0,attempt_at=1 WHERE id=?1",
            [&id],
        )
        .unwrap();
    refresh_automatic_sources(&app);
    let retried = get_index_sources(&app, false).unwrap().sources.remove(0);
    assert!(retried.last_error.is_none());
    assert_ne!(retried.last_attempt_at, Some(1));
}

// This filesystem regression requires Linux byte-preserving filenames.
#[cfg(target_os = "linux")]
#[test]
fn g10_non_utf8_exclusion_names_do_not_collide_or_abort_a_refresh() {
    use std::os::unix::ffi::OsStringExt;
    let (_temp, app, root, id) = setup();
    for byte in [0xfe, 0xff] {
        let name = std::ffi::OsString::from_vec(vec![byte, b'.', b't', b'x', b't']);
        fs::write(root.join(name), "unindexed").unwrap();
    }
    let view = refresh_index_source(&app, &id).unwrap();
    assert_eq!(view.sources[0].excluded, 2);
    let page = get_index_exclusions(
        &app,
        IndexExclusionsRequest {
            id,
            offset: 0,
            limit: None,
            project: None,
        },
    )
    .unwrap();
    assert_eq!(page.items.len(), 2);
    assert!(page
        .items
        .iter()
        .all(|item| item.reason == IndexExclusionReason::InvalidUtf8));
}

#[test]
fn g7_search_candidate_memory_is_bounded_and_reports_its_limit() {
    let (_temp, app, root, id) = setup();
    for name in ["a-orchard.md", "b-orchard.md"] {
        fs::write(root.join(name), "\n".repeat(1_000)).unwrap();
    }
    refresh_index_source(&app, &id).unwrap();
    let result = search::run_with_candidate_limit(
        &app,
        SearchIndexRequest {
            query: "orchard".into(),
            ..Default::default()
        },
        32,
    )
    .unwrap();
    assert_eq!(result.hits.len(), 2);
    assert!(
        result.truncated,
        "chunk candidate cap must be visible even with two file hits"
    );
    assert!(result.partial_sources.is_empty());
    let store: i64 = open(&app, false)
        .unwrap()
        .query_row("PRAGMA temp_store", [], |row| row.get(0))
        .unwrap();
    assert_eq!(store, 2, "G7: intermediate query data stays in memory");
}

#[test]
fn g4_c7_cypress_environment_never_enters_search_or_legacy_cache_results() {
    let (_temp, app, root, id) = setup();
    let body = r#"{"CUSTOM_ENV":"fixture-private-sentinel"}"#;
    fs::write(root.join("cypress.env.json"), body).unwrap();
    let view = refresh_index_source(&app, &id).unwrap();
    assert_eq!(view.sources[0].files, 0);
    assert_eq!(
        view.sources[0].exclusion_counts[0].reason,
        IndexExclusionReason::SensitivePath
    );
    // Emulate an old index that admitted a custom env key. New search filters the path
    // before reading/ranking its body, including the stale-file side channel.
    let connection = open(&app, true).unwrap();
    connection
        .execute(
            "INSERT INTO files(source_id,path,digest) VALUES(?1,'cypress.env.json','old-digest')",
            [&id],
        )
        .unwrap();
    connection.execute("INSERT INTO chunks(source_id,path,start_line,end_line,digest,body) VALUES(?1,'cypress.env.json',1,1,'old-digest',?2)", params![id,body]).unwrap();
    let result = find(&app, "fixture");
    assert!(result.hits.is_empty());
    assert!(result.stale_files.is_empty());
    refresh_index_source(&app, &id).unwrap();
    let remaining: usize = connection
        .query_row(
            "SELECT count(*) FROM chunks WHERE source_id=?1",
            [&id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(remaining, 0);
}

#[test]
fn v2_multiterm_search_marks_gaps_and_keeps_the_original_range_readable() {
    let (_temp, app, root, id) = setup();
    let mut lines = (1..=50)
        .map(|n| format!("ordinary row {n}"))
        .collect::<Vec<_>>();
    lines[3] = "orchard evidence".into();
    lines[45] = "갱신 evidence".into();
    fs::write(root.join("guide.md"), lines.join("\n")).unwrap();
    refresh_index_source(&app, &id).unwrap();
    let result = find(&app, "orchard 갱신");
    assert_eq!(result.hits.len(), 1);
    let hit = &result.hits[0];
    assert_eq!((hit.start_line, hit.end_line), (1, 49));
    assert_eq!(hit.excerpt.lines().count(), 15);
    assert_eq!(
        hit.excerpt,
        format!(
            "{}\n... [lines 8-42 omitted] ...\n{}",
            lines[..7].join("\n"),
            lines[42..49].join("\n")
        )
    );
    // G10: the same digest/range still reads the full contiguous original on request.
    let read = read_index_excerpt(
        &app,
        ReadIndexExcerptRequest {
            source_id: id,
            relative_path: hit.relative_path.clone(),
            digest: hit.digest.clone(),
            start_line: hit.start_line,
            end_line: hit.end_line,
            project: None,
        },
    )
    .unwrap();
    assert_eq!(read.excerpt, lines[..49].join("\n"));
    assert_eq!(read.digest, hit.digest);
}

#[test]
fn v2_multiterm_search_preserves_fts_witnesses_and_normalized_matches() {
    let (_temp, app, root, id) = setup();
    for (name, query, decoy, witness) in [
        ("embedded.md", "cat dog", "concatenate", "cat evidence"),
        ("prefix.md", "cat dog", "concatenate", "catalog evidence"),
        ("accent.md", "cafe dog", "ordinary", "café evidence"),
    ] {
        let mut lines = vec!["ordinary".to_owned(); 50];
        lines[3] = decoy.into();
        lines[24] = witness.into();
        lines[45] = "dog evidence".into();
        fs::write(root.join(name), lines.join("\n")).unwrap();
        refresh_index_source(&app, &id).unwrap();
        let result = search_index(
            &app,
            SearchIndexRequest {
                query: query.into(),
                path_prefix: Some(name.into()),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(result.hits.len(), 1, "{name}");
        assert!(
            result.hits[0].excerpt.lines().any(|line| line == witness),
            "{name}"
        );
        assert!(result.hits[0].excerpt.contains("dog evidence"), "{name}");
    }
}

#[cfg(unix)]
#[test]
fn g10_walked_subdirectory_refresh_preserves_trailing_spaces() {
    let (_temp, app, root, id) = setup();
    let spaced = root.join("notes ");
    fs::create_dir(&spaced).unwrap();
    fs::write(spaced.join("a.md"), "spacedDirectoryMarker\n").unwrap();
    // G10: no trimmed sibling exists, but the actual directory is valid.
    refresh_index_source(&app, &id).unwrap();
    let spaced_hits = find(&app, "spacedDirectoryMarker").hits;
    assert_eq!(spaced_hits.len(), 1);
    assert_eq!(spaced_hits[0].relative_path, "notes /a.md");

    let plain = root.join("notes");
    fs::create_dir(&plain).unwrap();
    fs::write(plain.join("a.md"), "plainDirectoryMarker\n").unwrap();
    refresh_index_source(&app, &id).unwrap();
    assert_eq!(
        find(&app, "spacedDirectoryMarker").hits[0].relative_path,
        "notes /a.md"
    );
    assert_eq!(
        find(&app, "plainDirectoryMarker").hits[0].relative_path,
        "notes/a.md"
    );
}

#[cfg(unix)]
#[test]
fn g10_walked_subdirectory_metadata_watch_preserves_trailing_spaces() {
    let (_temp, app, root, id) = setup();
    let spaced = root.join("notes ");
    fs::create_dir(&spaced).unwrap();
    let file = spaced.join("a.md");
    fs::write(&file, "initial").unwrap();
    let view = get_index_sources(&app, true).unwrap();
    let mut queue = watch::WatchQueue::default();
    queue.use_metadata(&id);
    assert_eq!(queue.poll(&app, &view), vec![id.clone()]);
    queue.complete(&id);
    // G7/G10: a valid folder must settle rather than re-queue a validation error.
    assert!(queue.poll(&app, &view).is_empty());
    fs::write(&file, "changed with a different size").unwrap();
    assert_eq!(queue.poll(&app, &view), vec![id.clone()]);
    queue.complete(&id);
    assert!(queue.poll(&app, &view).is_empty());
}

#[cfg(target_os = "linux")]
#[test]
fn g10_walked_subdirectory_native_watch_preserves_trailing_spaces() {
    let (_temp, app, root, _id) = setup();
    let plain = root.join("notes");
    let spaced = root.join("notes ");
    fs::create_dir(&plain).unwrap();
    fs::create_dir(&spaced).unwrap();
    let file = spaced.join("a.md");
    fs::write(&file, "initial").unwrap();
    let mut native = native::NativeWatch::create(&app, root.to_str().unwrap()).unwrap();
    assert!(!native.changed().unwrap());
    // G10: watching the trimmed sibling must not replace the actual directory's watch.
    fs::write(&file, "changed with a different size").unwrap();
    assert!(native.changed().unwrap());
    assert!(!native.changed().unwrap());
}

#[test]
fn g4_credential_lines_are_scrubbed_while_the_rest_of_a_source_file_is_indexed() {
    let (_temp, app, root, id) = setup();
    fs::write(
        root.join("probe.rs"),
        concat!(
            "pub fn probe_before_value() {}\n",
            "\n",
            "let password = \"fixture-value-never-persist\";\n",
            "pub fn probe_inside_block() {}\n",
            "\n",
            "pub fn probe_after_value() {}\n",
            "// 사용자ID 주석은 다국어 문자 뒤의 식별자다\n",
            "password += \"fixture-value-never-persist\";\n",
            "\n",
            "password.push_str(\"fixture-value-never-persist\");\n",
            "\n",
            "let token = \"fixture-value-never-persist\"; // don't persist\n",
            "\n",
            "let github_token = \"fixture-value-never-persist\";\n",
            "\n",
            "let password: &'static str = \"fixture-value-never-persist\";\n",
            "\n",
            "let password = if debug { \"fixture-value-never-persist\" } else { \"b\" };\n",
            "\n",
            "pub fn probe_tail() {}\n",
        ),
    )
    .unwrap();
    fs::write(
        root.join("block.php"),
        "<?php\nif ($x) {\n    $password = 'fixture-value-never-persist';\n}\n\n$db = probe_php_after();\n",
    )
    .unwrap();
    fs::write(
        root.join("crlf.ts"),
        "const a = 1;\r\nconst token = 'fixture-value-never-persist';\r\nconst apiKey = await fetchKey('fixture-value-never-persist');\r\n\r\nexport function probeCrlf() {}\r\n",
    )
    .unwrap();
    // A closed signature followed by an Allman brace is not a continuation: the method body
    // whose name merely ends in a key word stays searchable.
    fs::write(
        root.join("allman.cs"),
        "public string GetAccessToken()\n{\n    return probe_allman_body();\n}\n",
    )
    .unwrap();
    // A read of the variable next to a string literal is not a value assignment.
    fs::write(
        root.join("reads.ts"),
        "if (!token.startsWith('Bearer ')) {\n  return probe_token_read();\n}\n",
    )
    .unwrap();
    // Data formats keep the whole-file rule: a block scalar could carry the value onward.
    fs::write(
        root.join("blocked.yaml"),
        "probe_in_yaml: 1\npassword: fixture-value-never-persist",
    )
    .unwrap();
    let view = refresh_index_source(&app, &id).unwrap();
    let source = &view.sources[0];
    assert_eq!((source.files, source.excluded), (5, 1));
    // probe.rs: 2 + 1 + 1 + 1 + 1 + 1 + 1, block.php: 2 (`$password` and the closing brace),
    // crlf.ts: 2 — the block runs from the flagged line to the next blank line.
    assert!(source
        .exclusion_counts
        .iter()
        .any(|count| count.reason == IndexExclusionReason::CredentialLines && count.count == 12));
    assert!(source
        .exclusion_counts
        .iter()
        .any(|count| count.reason == IndexExclusionReason::Credentials && count.count == 1));
    assert_eq!(
        find(&app, "probe_after_value").hits[0].relative_path,
        "probe.rs"
    );
    assert_eq!(find(&app, "probe_before_value").hits.len(), 1);
    assert_eq!(find(&app, "probe_tail").hits.len(), 1);
    // The line after the secret in the same paragraph goes with it.
    assert!(find(&app, "probe_inside_block").hits.is_empty());
    assert_eq!(find(&app, "probeCrlf").hits[0].relative_path, "crlf.ts");
    assert_eq!(
        find(&app, "probe_php_after").hits[0].relative_path,
        "block.php"
    );
    assert_eq!(
        find(&app, "probe_allman_body").hits[0].relative_path,
        "allman.cs"
    );
    assert_eq!(
        find(&app, "probe_token_read").hits[0].relative_path,
        "reads.ts"
    );
    assert!(find(&app, "fixture-value-never-persist").hits.is_empty());
    assert!(find(&app, "probe_in_yaml").hits.is_empty());
    let hit = &find(&app, "probe_before_value").hits[0];
    let excerpt = read_index_excerpt(
        &app,
        ReadIndexExcerptRequest {
            source_id: id.clone(),
            relative_path: "probe.rs".into(),
            digest: hit.digest.clone(),
            start_line: 1,
            end_line: 4,
            project: None,
        },
    )
    .unwrap();
    // Line numbering survives the scrub, so the excerpt range still lands on the right lines,
    // and the excerpt path (which re-reads the file) shows placeholders, never the value.
    assert_eq!(
        excerpt.excerpt,
        format!(
            "pub fn probe_before_value() {{}}\n\n{0}\n{0}",
            content::CREDENTIAL_LINE_PLACEHOLDER
        )
    );
    assert!(!hit.excerpt.contains("fixture-value"));
    let bytes = fs::read(app.join(DATABASE)).unwrap();
    assert!(!bytes
        .windows(b"fixture-value-never-persist".len())
        .any(|part| part == b"fixture-value-never-persist"));
    // An unchanged file keeps its line count in the diagnostics across an incremental refresh.
    fs::write(root.join("other.rs"), "pub fn probe_other() {}").unwrap();
    let view = refresh_source(&app, &id, true, true, None).unwrap();
    assert_eq!(view.sources[0].files, 6);
    assert!(view.sources[0]
        .exclusion_counts
        .iter()
        .any(|count| count.reason == IndexExclusionReason::CredentialLines && count.count == 12));
}

/// G4/G7: the digest is of the original bytes, so a body derived under an older chunk format
/// (or an older scrub rule) is not told apart by it. A format bump must re-derive every stored
/// body, or a value the old rule let through stays searchable while the diagnostics claim it
/// was scrubbed.
#[test]
fn g4_chunk_format_bump_rederives_bodies_of_unchanged_files() {
    let (_temp, app, root, id) = setup();
    fs::write(
        root.join("stale.rs"),
        "pub fn probe_stale() {}\n\nlet password = \"fixture-value-never-persist\";\n",
    )
    .unwrap();
    refresh_index_source(&app, &id).unwrap();
    assert_eq!(find(&app, "probe_stale").hits.len(), 1);
    {
        // A store written by an older release: the body still carries the value and the
        // source records the previous format.
        let connection = Connection::open(app.join(DATABASE)).unwrap();
        connection
            .execute(
                "UPDATE chunks SET body = body || ' fixture-value-never-persist' WHERE source_id=?1",
                [&id],
            )
            .unwrap();
        connection
            .execute(
                "UPDATE sources SET chunk_format = ?1 WHERE id=?2",
                params![CHUNK_FORMAT - 1, &id],
            )
            .unwrap();
    }
    assert_eq!(find(&app, "fixture-value-never-persist").hits.len(), 1);
    let view = refresh_index_source(&app, &id).unwrap();
    assert_eq!(view.sources[0].files, 1);
    assert_eq!(find(&app, "probe_stale").hits.len(), 1);
    assert!(find(&app, "fixture-value-never-persist").hits.is_empty());
    let bytes = fs::read(app.join(DATABASE)).unwrap();
    assert!(!bytes
        .windows(b"fixture-value-never-persist".len())
        .any(|part| part == b"fixture-value-never-persist"));
}

/// G4/G7: the same store, same format — a stricter scrub rule shows up only as a different
/// `redacted_lines` for an unchanged digest, and that difference alone must re-stage the body.
#[test]
fn g4_changed_redacted_line_count_restages_an_unchanged_file() {
    let (_temp, app, root, id) = setup();
    fs::write(
        root.join("stale.rs"),
        "pub fn probe_stale() {}\n\nlet password = \"fixture-value-never-persist\";\n",
    )
    .unwrap();
    refresh_index_source(&app, &id).unwrap();
    {
        let connection = Connection::open(app.join(DATABASE)).unwrap();
        connection
            .execute(
                "UPDATE chunks SET body = body || ' fixture-value-never-persist' WHERE source_id=?1",
                [&id],
            )
            .unwrap();
        connection
            .execute(
                "UPDATE files SET redacted_lines = 0 WHERE source_id=?1",
                [&id],
            )
            .unwrap();
    }
    assert_eq!(find(&app, "fixture-value-never-persist").hits.len(), 1);
    refresh_index_source(&app, &id).unwrap();
    assert_eq!(find(&app, "probe_stale").hits.len(), 1);
    assert!(find(&app, "fixture-value-never-persist").hits.is_empty());
    let bytes = fs::read(app.join(DATABASE)).unwrap();
    assert!(!bytes
        .windows(b"fixture-value-never-persist".len())
        .any(|part| part == b"fixture-value-never-persist"));
}

/// G4: every shape in which a value can continue past the line that names the key — open
/// quotes, brackets, heredocs, raw and triple-quoted strings, percent literals, trailing and
/// leading operators, getters, case arms, block comments, backslash continuations — is covered
/// by the paragraph rule without a grammar: the block ends at the next blank line, so the
/// identifier after that blank line is still searchable while the value is nowhere.
#[test]
fn g4_credential_values_continuing_on_later_lines_are_scrubbed_with_their_paragraph() {
    let (_temp, app, root, id) = setup();
    let cases: &[(&str, &str)] = &[
        (
            "open_quote.py",
            "password = \"\"\"\nfixture-value-never-persist\n\"\"\"\n",
        ),
        (
            "next_line.rs",
            "let password =\n    \"fixture-value-never-persist\";\n",
        ),
        (
            "dangling_key.rs",
            "let token: &str\n= \"fixture-value-never-persist\";\n",
        ),
        (
            "open_paren.js",
            "const apiKey = f(api_key=(\n'fixture-value-never-persist'));\n",
        ),
        (
            "heredoc.rb",
            "password = <<~EOS\nfixture-value-never-persist\nEOS\n",
        ),
        (
            "template.ts",
            "const token = `\nfixture-value-never-persist`;\n",
        ),
        (
            "concat.java",
            "String password = \"a\" +\n\"fixture-value-never-persist\";\n",
        ),
        (
            "chained.ts",
            "const token = 'a'\n+ 'fixture-value-never-persist';\n",
        ),
        (
            "escaped.rs",
            "let password = \"abc\\\"\nfixture-value-never-persist\";\n",
        ),
        (
            "percent.rb",
            "password = %q|\nfixture-value-never-persist\n|\n",
        ),
        (
            "concat.php",
            "$password = 'a' .\n$suffix . 'fixture-value-never-persist';\n",
        ),
        (
            "ternary.ts",
            "const token = isDev ?\n  devToken : 'fixture-value-never-persist';\n",
        ),
        (
            "comment_quote.rs",
            "let password = 'x' // it's\n+ \"fixture-value-never-persist\";\n",
        ),
        (
            "raw.rs",
            "let password = r#\"\nfixture-value-never-persist\n\"#;\n",
        ),
        (
            "case.rb",
            "password = case env\nwhen \"prod\" then \"fixture-value-never-persist\"\nend\n",
        ),
        (
            "dangling.php",
            "$password\n.= 'fixture-value-never-persist';\n",
        ),
        (
            "block_comment.ts",
            "const token = \"a\" /* note\n continues */ + \"fixture-value-never-persist\";\n",
        ),
        (
            "closed_comment.ts",
            "const token = \"a\" /* note */\n+ \"fixture-value-never-persist\";\n",
        ),
        (
            "getter.kt",
            "val password: String\n    get() = \"fixture-value-never-persist\"\n",
        ),
        (
            "word_or.rb",
            "password = ENV[\"PW\"] or\n  decode \"fixture-value-never-persist\"\n",
        ),
        (
            "percent_mid.rb",
            "password = String %q|part\nfixture-value-never-persist|\n",
        ),
        (
            "backtick.go",
            "password := `\nfixture-value-never-persist`\n",
        ),
        (
            "verbatim.cs",
            "var password = @\"\nfixture-value-never-persist\";\n",
        ),
        (
            "adjacent.c",
            "const char *password = \"a\"\n\"fixture-value-never-persist\";\n",
        ),
        (
            "rawcpp.cpp",
            "auto password = R\"(\nfixture-value-never-persist)\";\n",
        ),
        (
            "paren.py",
            "password = (\n    \"fixture-value-never-persist\")\n",
        ),
        (
            "backslash.py",
            "password = \\\n    \"fixture-value-never-persist\"\n",
        ),
        (
            "key_comment.py",
            "password = \\ # see below\n    \"fixture-value-never-persist\"\n",
        ),
        (
            "call_arg.ts",
            "const token = check(isDev)\n  ('fixture-value-never-persist');\n",
        ),
        (
            "triple.kt",
            "val password = \"\"\"\nfixture-value-never-persist\"\"\"\n",
        ),
        (
            "heredoc.php",
            "$password = <<<EOT\nfixture-value-never-persist\nEOT;\n",
        ),
        (
            "words.rb",
            "password = %w[\nfixture-value-never-persist\n]\n",
        ),
    ];
    for (index, (name, body)) in cases.iter().enumerate() {
        fs::write(
            root.join(name),
            format!("{body}\nfn probe_case_{index}() {{}}\n"),
        )
        .unwrap();
    }
    // A JSON document with a secret key keeps the whole-file rule.
    fs::write(
        root.join("data.json"),
        "{\"token\": \"fixture-value-never-persist\", \"probe_json\": 1}",
    )
    .unwrap();
    let view = refresh_index_source(&app, &id).unwrap();
    assert_eq!(
        (view.sources[0].files, view.sources[0].excluded),
        (cases.len(), 1)
    );
    for (index, (name, _)) in cases.iter().enumerate() {
        assert_eq!(
            find(&app, &format!("probe_case_{index}")).hits[0].relative_path,
            *name,
            "case {index}"
        );
    }
    assert!(find(&app, "fixture-value-never-persist").hits.is_empty());
    assert!(find(&app, "probe_json").hits.is_empty());
    let bytes = fs::read(app.join(DATABASE)).unwrap();
    assert!(!bytes
        .windows(b"fixture-value-never-persist".len())
        .any(|part| part == b"fixture-value-never-persist"));
    // Every scrubbed file re-reads through the excerpt path with placeholders only.
    for (index, (name, body)) in cases.iter().enumerate() {
        let hit = &find(&app, &format!("probe_case_{index}")).hits[0];
        let excerpt = read_index_excerpt(
            &app,
            ReadIndexExcerptRequest {
                source_id: id.clone(),
                relative_path: (*name).into(),
                digest: hit.digest.clone(),
                start_line: 1,
                end_line: body.lines().count() + 2,
                project: None,
            },
        )
        .unwrap();
        assert!(!excerpt.excerpt.contains("fixture-value"), "{name}");
    }
}
