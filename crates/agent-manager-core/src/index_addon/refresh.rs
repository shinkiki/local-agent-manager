//! G4/G7: stage bounded, sanitized updates before atomically replacing the derived index.
use super::*;

pub(super) fn run(
    app: &Path,
    id: &str,
    agent_only: bool,
    automatic: bool,
    caller: Option<&[PathBuf]>,
    max_files: usize,
) -> Result<IndexSnapshot, CoreError> {
    let mut connection = open(app, true)?;
    source(&connection, id, agent_only, caller)?;
    let guard = watch::RefreshGuard::begin(app, id)?;
    let attempted_at = crate::clock::now_ms();
    let timer = std::time::Instant::now();
    let result = rebuild(
        app,
        id,
        agent_only,
        automatic,
        caller,
        max_files,
        &mut connection,
        &guard,
    );
    let failed_reads = watch::progress(&connection, id).map_or(0, |progress| progress.read_files);
    // Turning automatic indexing off is cancellation, not a new failed source.
    if automatic && !settings(&connection).is_ok_and(|(enabled, automatic)| enabled && automatic) {
        drop(guard);
        result?;
        return snapshot(&connection, agent_only, caller);
    }
    // G4: errors here come from path/SQLite validation, never document contents.
    let error = result.as_ref().err().map(ToString::to_string);
    connection.execute(
        "UPDATE sources SET attempt_at=?1,duration_ms=?2,last_error=?3,error_at=?4,
        read_files=CASE WHEN ?3 IS NULL THEN read_files ELSE ?6 END WHERE id=?5",
        params![
            attempted_at,
            timer.elapsed().as_millis().min(i64::MAX as u128) as i64,
            error,
            result.as_ref().err().map(|_| attempted_at),
            id,
            failed_reads
        ],
    )?;
    // Keep the source locked until its outcome is stored. Otherwise a newer refresh
    // may finish first and have its status overwritten by this attempt.
    drop(guard);
    result?;
    snapshot(&connection, agent_only, caller)
}

#[allow(clippy::too_many_arguments)]
fn rebuild(
    app: &Path,
    id: &str,
    agent_only: bool,
    automatic: bool,
    caller: Option<&[PathBuf]>,
    max_files: usize,
    connection: &mut Connection,
    guard: &watch::RefreshGuard,
) -> Result<(), CoreError> {
    if automatic && !settings(connection)?.1 {
        return Err(invalid("자동 갱신이 꺼져 있습니다"));
    }
    let (_, path) = source(connection, id, agent_only, caller)?;
    let root = validate_root(app, &path)?;
    let (format, full_at): (i64, Option<i64>) = connection.query_row(
        "SELECT chunk_format,full_checked_at FROM sources WHERE id=?1",
        [id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    let full = !automatic
        || format != CHUNK_FORMAT
        || full_at.is_none_or(|at| crate::clock::now_ms() - at >= PROJECT_REFRESH_MS);
    let previous = {
        let mut statement = connection
            .prepare("SELECT path,digest,stamp,redacted_lines FROM files WHERE source_id=?1")?;
        let values = statement
            .query_map([id], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    (
                        r.get::<_, String>(1)?,
                        r.get::<_, Option<String>>(2)?,
                        r.get::<_, usize>(3)?,
                    ),
                ))
            })?
            .collect::<Result<HashMap<_, _>, _>>()?;
        values
    };
    let previous_exclusions = {
        let mut statement =
            connection.prepare("SELECT path,reason,stamp FROM exclusions WHERE source_id=?1")?;
        let values = statement
            .query_map([id], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    (r.get::<_, String>(1)?, r.get::<_, Option<String>>(2)?),
                ))
            })?
            .collect::<Result<HashMap<_, _>, _>>()?;
        values
    };
    let mut queue = vec![root.clone()];
    let mut seen = BTreeSet::new();
    let mut excluded = Vec::new();
    let mut counts = BTreeMap::<IndexExclusionReason, usize>::new();
    let mut scanned = 0;
    let mut read_files = 0;
    let mut total_bytes = 0;
    let mut truncated = false;
    let mut staged = Vec::new();
    let mut stamps = Vec::new();
    'scan: while let Some(directory) = queue.pop() {
        let safe_directory = validate_root_path(app, &directory)?;
        if !safe_directory.starts_with(&root) {
            return Err(invalid("인덱스 폴더 밖 경로입니다"));
        }
        for entry in fs::read_dir(&directory)? {
            let entry = entry?;
            scanned += 1;
            if scanned % 64 == 0 {
                guard.update(scanned, read_files);
                source(connection, id, agent_only, caller)?;
                if automatic && !settings(connection)?.1 {
                    return Err(invalid("자동 갱신이 꺼져 있습니다"));
                }
            }
            if scanned > MAX_SCAN {
                truncated = true;
                break 'scan;
            }
            let meta = fs::symlink_metadata(entry.path())?;
            let name = entry.file_name();
            let relative = entry
                .path()
                .strip_prefix(&root)
                .map_err(|_| invalid("폴더 밖 경로입니다"))?
                .components()
                .map(|component| component.as_os_str().to_string_lossy())
                .collect::<Vec<_>>()
                .join("/");
            let stamp = watch::stamp(&meta);
            let name_reason = if meta.file_type().is_symlink() {
                Some(IndexExclusionReason::Symlink)
            } else {
                name.to_str()
                    .map_or(Some(IndexExclusionReason::InvalidUtf8), |name| {
                        classify_name(name, meta.is_dir())
                    })
            };
            if let Some(reason) = name_reason {
                *counts.entry(reason).or_default() += 1;
                // Display strings of non-UTF-8 names may coincide. They are diagnostics only,
                // never content-cache keys; the table uses a separate ordinal identity.
                excluded.push((relative, reason, String::new()));
                continue;
            }
            if meta.is_dir() {
                queue.push(entry.path());
                continue;
            }
            if !meta.is_file() {
                *counts.entry(IndexExclusionReason::NonRegular).or_default() += 1;
                excluded.push((relative, IndexExclusionReason::NonRegular, stamp));
                continue;
            }
            let safe = resolve_file(app, &root, &relative)?;
            if !full {
                if let Some((reason, Some(old_stamp))) = previous_exclusions.get(&relative) {
                    if *old_stamp == stamp {
                        let reason = serde_json::from_value::<IndexExclusionReason>(
                            serde_json::Value::String(reason.clone()),
                        )?;
                        *counts.entry(reason).or_default() += 1;
                        excluded.push((relative, reason, stamp));
                        continue;
                    }
                }
                if let Some((_, Some(old_stamp), redacted_lines)) = previous.get(&relative) {
                    if *old_stamp == stamp {
                        // The unchanged file keeps its stored scrub count in the diagnostics.
                        if *redacted_lines > 0 {
                            *counts
                                .entry(IndexExclusionReason::CredentialLines)
                                .or_default() += redacted_lines;
                        }
                        total_bytes += meta.len();
                        if seen.len() >= max_files || total_bytes > MAX_TOTAL_BYTES {
                            truncated = true;
                            break 'scan;
                        }
                        seen.insert(relative);
                        continue;
                    }
                }
            }
            read_files += 1;
            guard.update(scanned, read_files);
            let (text, digest, redacted_lines) = match read_text_detailed(&safe)? {
                ContentRead::Text {
                    text,
                    digest,
                    redacted_lines,
                } => (text, digest, redacted_lines),
                ContentRead::Excluded(reason) => {
                    *counts.entry(reason).or_default() += 1;
                    excluded.push((relative, reason, stamp));
                    continue;
                }
            };
            total_bytes += text.len() as u64;
            if seen.len() >= max_files || total_bytes > MAX_TOTAL_BYTES {
                truncated = true;
                break 'scan;
            }
            seen.insert(relative.clone());
            if redacted_lines > 0 {
                *counts
                    .entry(IndexExclusionReason::CredentialLines)
                    .or_default() += redacted_lines;
            }
            stamps.push((relative.clone(), digest.clone(), stamp, redacted_lines));
            // The digest is of the original bytes, so a scrub-rule change that flags more (or
            // fewer) lines of an unchanged file shows up only in `redacted_lines`; re-stage then too.
            if format != CHUNK_FORMAT
                || previous
                    .get(&relative)
                    .map(|(old, _, old_redacted)| (old, *old_redacted))
                    != Some((&digest, redacted_lines))
            {
                staged.push((
                    relative,
                    digest,
                    redact(&text, SessionReadRedaction::Credentials),
                ));
            }
        }
    }
    guard.update(scanned, read_files);
    let tx = connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let (_, current_path) = source(&tx, id, agent_only, caller)?;
    if current_path != path || (automatic && !settings(&tx)?.1) {
        return Err(CoreError::Conflict(
            "갱신 중 인덱스 설정이 변경되었습니다".into(),
        ));
    }
    for (relative, digest, clean) in staged {
        tx.execute(
            "DELETE FROM chunks WHERE source_id=?1 AND path=?2",
            params![id, relative],
        )?;
        let lines = clean.lines().collect::<Vec<_>>();
        let mut start = 0;
        while start < lines.len() {
            let mut end = start;
            let mut bytes = 0;
            while end < lines.len()
                && end - start < 50
                && (end == start || bytes + lines[end].len() < 6_000)
            {
                bytes += lines[end].len() + 1;
                end += 1;
            }
            tx.execute("INSERT INTO chunks(source_id,path,start_line,end_line,digest,body) VALUES(?1,?2,?3,?4,?5,?6)", params![id,relative,start+1,end,digest,lines[start..end].join("\n")])?;
            if end == lines.len() {
                break;
            }
            // Neighbouring chunks share eight lines so boundary queries retain their evidence.
            start = end.saturating_sub(8).max(start + 1);
        }
    }
    for (relative, digest, stamp, redacted_lines) in stamps {
        tx.execute(
            "INSERT OR REPLACE INTO files(source_id,path,digest,stamp,redacted_lines) VALUES(?1,?2,?3,?4,?5)",
            params![id, relative, digest, stamp, redacted_lines],
        )?;
    }
    // G7: partial refreshes replace the bounded subset rather than accumulating old rows.
    for path in previous.keys().filter(|path| !seen.contains(*path)) {
        tx.execute(
            "DELETE FROM chunks WHERE source_id=?1 AND path=?2",
            params![id, path],
        )?;
        tx.execute(
            "DELETE FROM files WHERE source_id=?1 AND path=?2",
            params![id, path],
        )?;
    }
    tx.execute("DELETE FROM exclusions WHERE source_id=?1", [id])?;
    for (ordinal, (relative, reason, stamp)) in excluded.iter().enumerate() {
        tx.execute(
            "INSERT INTO exclusions(source_id,ordinal,path,reason,stamp) VALUES(?1,?2,?3,?4,?5)",
            params![
                id,
                ordinal,
                relative,
                reason.key(),
                (!stamp.is_empty()).then_some(stamp)
            ],
        )?;
    }
    let counts = counts
        .into_iter()
        .map(|(reason, count)| IndexExclusionCount { reason, count })
        .collect::<Vec<_>>();
    tx.execute(
        "UPDATE sources SET indexed_at=?1,excluded=?2,truncated=?3,
        file_count=(SELECT count(*) FROM files WHERE source_id=?4),
        chunk_count=(SELECT count(*) FROM chunks WHERE source_id=?4),
        exclusion_counts=?5,read_files=?6,chunk_format=?7,
        full_checked_at=CASE WHEN ?8 THEN ?1 ELSE full_checked_at END WHERE id=?4",
        params![
            crate::clock::now_ms(),
            excluded.len(),
            truncated,
            id,
            serde_json::to_string(&counts)?,
            read_files,
            CHUNK_FORMAT,
            full
        ],
    )?;
    tx.commit()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn g10_v2_literal_backslashes_do_not_alias_nested_paths() {
        let temp = tempfile::tempdir().unwrap();
        let base = fs::canonicalize(temp.path()).unwrap();
        let app = base.join("app");
        let root = base.join("documents");
        fs::create_dir_all(root.join("a")).unwrap();
        let documents = [
            (r"a\b.md", "distinctpath literal document"),
            ("a/b.md", "distinctpath nested document"),
        ];
        for (path, body) in documents {
            fs::write(root.join(path), body).unwrap();
        }
        for path in [r"a\image.png", "a/image.png"] {
            fs::write(root.join(path), b"ignored image").unwrap();
        }
        let view = add_index_source(
            &app,
            AddIndexSourceRequest {
                name: "Documents".into(),
                path: root.to_string_lossy().into(),
            },
        )
        .unwrap();
        set_index_settings(
            &app,
            SetIndexSettingsRequest {
                enabled: true,
                auto_refresh: true,
            },
        )
        .unwrap();
        let id = view.sources[0].id.clone();
        set_index_source_enabled(
            &app,
            SetIndexSourceEnabledRequest {
                id: id.clone(),
                enabled: true,
            },
        )
        .unwrap();

        for automatic in [false, true] {
            let snapshot = run(&app, &id, false, automatic, None, MAX_FILES).unwrap();
            assert_eq!(snapshot.sources[0].files, 2);
            assert_eq!(snapshot.sources[0].excluded, 2);
            if automatic {
                assert_eq!(snapshot.sources[0].read_files, 0);
            }
            let result = search_index(
                &app,
                SearchIndexRequest {
                    query: "distinctpath".into(),
                    ..Default::default()
                },
            )
            .unwrap();
            assert_eq!(result.hits.len(), 2);
            assert!(result.stale_files.is_empty());
            for (path, body) in documents {
                let hit = result
                    .hits
                    .iter()
                    .find(|hit| hit.relative_path == path)
                    .unwrap();
                assert_eq!(hit.excerpt, body);
                let excerpt = read_index_excerpt(
                    &app,
                    ReadIndexExcerptRequest {
                        source_id: id.clone(),
                        relative_path: path.into(),
                        digest: hit.digest.clone(),
                        start_line: 1,
                        end_line: 1,
                        project: None,
                    },
                )
                .unwrap();
                assert_eq!(excerpt.excerpt, body);
            }
            let exclusions = get_index_exclusions(
                &app,
                IndexExclusionsRequest {
                    id: id.clone(),
                    offset: 0,
                    limit: Some(10),
                    project: None,
                },
            )
            .unwrap();
            assert_eq!(
                exclusions
                    .items
                    .iter()
                    .map(|item| item.relative_path.as_str())
                    .collect::<BTreeSet<_>>(),
                BTreeSet::from([r"a\image.png", "a/image.png"])
            );
        }
        // G10: a changed literal filename must not be replaced by its unchanged nested sibling.
        fs::write(root.join(r"a\b.md"), "updated literal document").unwrap();
        let result = search_index(
            &app,
            SearchIndexRequest {
                query: "distinctpath".into(),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(result.hits.len(), 1);
        assert_eq!(result.hits[0].relative_path, "a/b.md");
        assert_eq!(result.stale_files.len(), 1);
        let snapshot = run(&app, &id, false, true, None, MAX_FILES).unwrap();
        assert_eq!(snapshot.sources[0].files, 2);
        assert_eq!(snapshot.sources[0].read_files, 1);
        let result = search_index(
            &app,
            SearchIndexRequest {
                query: "updated".into(),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(result.hits.len(), 1);
        assert_eq!(result.hits[0].relative_path, r"a\b.md");
    }

    #[test]
    fn g7_v2_max_files_limit_counts_only_indexed_text_files() {
        let temp = tempfile::tempdir().unwrap();
        let base = fs::canonicalize(temp.path()).unwrap();
        let app = base.join("app");
        let root = base.join("documents");
        let sub = root.join("sub");
        fs::create_dir_all(&sub).unwrap();
        fs::create_dir_all(root.join("empty")).unwrap();
        fs::write(root.join("a.md"), "alpha document").unwrap();
        fs::write(root.join("b.md"), "beta document").unwrap();
        fs::write(sub.join("Cargo.lock"), "# generated lockfile").unwrap();
        fs::write(sub.join("notes.toml"), "api_key = \"demo-value\"").unwrap();

        let view = add_index_source(
            &app,
            AddIndexSourceRequest {
                name: "Documents".into(),
                path: root.to_string_lossy().into(),
            },
        )
        .unwrap();
        set_index_settings(
            &app,
            SetIndexSettingsRequest {
                enabled: true,
                auto_refresh: true,
            },
        )
        .unwrap();
        let id = view.sources[0].id.clone();
        set_index_source_enabled(
            &app,
            SetIndexSourceEnabledRequest {
                id: id.clone(),
                enabled: true,
            },
        )
        .unwrap();

        let snap = run(&app, &id, false, false, None, 2).unwrap();
        let source = &snap.sources[0];
        assert_eq!(source.files, 2);
        assert!(!source.truncated);
        assert_eq!(source.excluded, 2);

        let exclusions = get_index_exclusions(
            &app,
            IndexExclusionsRequest {
                id: id.clone(),
                offset: 0,
                limit: Some(10),
                project: None,
            },
        )
        .unwrap();
        assert_eq!(exclusions.total, 2);
        assert_eq!(
            exclusions
                .items
                .iter()
                .map(|item| (item.relative_path.as_str(), item.reason))
                .collect::<Vec<_>>(),
            vec![
                ("sub/Cargo.lock", IndexExclusionReason::DependencyOrBuild),
                ("sub/notes.toml", IndexExclusionReason::Credentials),
            ]
        );

        let search = search_index(
            &app,
            SearchIndexRequest {
                query: "alpha".into(),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(search.hits.len(), 1);
        assert!(search.partial_sources.is_empty());

        let incremental = run(&app, &id, false, true, None, 2).unwrap();
        let inc_source = &incremental.sources[0];
        assert_eq!(inc_source.files, 2);
        assert!(!inc_source.truncated);
        assert_eq!(inc_source.read_files, 0);
        assert_eq!(inc_source.excluded, 2);

        fs::write(sub.join("c.md"), "gamma document").unwrap();
        let full_three = run(&app, &id, false, false, None, 3).unwrap();
        assert_eq!(full_three.sources[0].files, 3);
        assert!(!full_three.sources[0].truncated);

        let inc_truncated = run(&app, &id, false, true, None, 2).unwrap();
        assert_eq!(inc_truncated.sources[0].files, 2);
        assert!(inc_truncated.sources[0].truncated);

        let full_truncated = run(&app, &id, false, false, None, 2).unwrap();
        assert_eq!(full_truncated.sources[0].files, 2);
        assert!(full_truncated.sources[0].truncated);
        let partial_search = search_index(
            &app,
            SearchIndexRequest {
                query: "alpha".into(),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(partial_search.partial_sources, vec![id]);
    }
}
