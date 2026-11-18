//! Bounded search with explicit filters, identifier matching, and fresh source verification.
use super::*;
use rusqlite::functions::FunctionFlags;

const MAX_MATCHED_CHUNKS: usize = 20_000;
const MAX_MULTITERM_EXCERPT_LINES: usize = 32;

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum IndexSearchMode {
    #[default]
    Prefix,
    Exact,
}

fn terms(query: &str) -> Vec<&str> {
    query
        .split(|c: char| !c.is_alphanumeric() && c != '_')
        .filter(|s| !s.is_empty())
        .collect()
}

pub(super) fn match_query(query: &str, mode: IndexSearchMode) -> Result<String, CoreError> {
    if query.len() > 512 {
        return Err(invalid("검색어는 512바이트 이하여야 합니다"));
    }
    let terms = terms(query);
    if terms.is_empty() {
        return Err(invalid("검색어를 입력해 주세요"));
    }
    if terms.len() > 16 {
        return Err(invalid("검색어는 16개 단어 이하여야 합니다"));
    }
    Ok(terms
        .iter()
        .map(|term| {
            format!(
                "\"{term}\"{}",
                if mode == IndexSearchMode::Prefix {
                    "*"
                } else {
                    ""
                }
            )
        })
        .collect::<Vec<_>>()
        .join(" AND "))
}

fn word(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}
fn exact_position(text: &str, query: &str) -> Option<usize> {
    let lower = text.to_lowercase();
    let query = query.trim().to_lowercase();
    exact_position_lowered(&lower, &query)
}

fn exact_position_lowered(lower: &str, query: &str) -> Option<usize> {
    if query.is_empty() {
        return None;
    }
    lower.match_indices(query).find_map(|(at, _)| {
        let before = lower[..at].chars().next_back();
        let after = lower[at + query.len()..].chars().next();
        ((!query.chars().next().is_some_and(word) || !before.is_some_and(word))
            && (!query.chars().next_back().is_some_and(word) || !after.is_some_and(word)))
        .then_some(at)
    })
}

fn declaration_position(text: &str, query: &str) -> Option<usize> {
    let query = query.trim();
    if query.is_empty() || !query.chars().all(word) {
        return None;
    }
    let lower = text.to_lowercase();
    let query = query.to_lowercase();
    let mut offset = 0;
    for line in lower.lines() {
        if let Some(at) = exact_position_lowered(line, &query) {
            if line[..at]
                .split_whitespace()
                .next_back()
                .is_some_and(|keyword| {
                    [
                        "fn",
                        "function",
                        "def",
                        "func",
                        "fun",
                        "class",
                        "interface",
                        "struct",
                        "enum",
                        "type",
                        "const",
                        "let",
                        "var",
                    ]
                    .contains(&keyword)
                })
            {
                return Some(offset + at);
            }
        }
        offset += line.len() + 1;
    }
    None
}

fn filters(request: &SearchIndexRequest) -> Result<(Option<String>, Option<String>), CoreError> {
    let prefix = request
        .path_prefix
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    if let Some(path) = prefix {
        if path.len() > 512
            || path.contains('\\')
            || path.chars().any(char::is_control)
            || Path::new(path).is_absolute()
            || !Path::new(path)
                .components()
                .all(|component| matches!(component, Component::Normal(_)))
        {
            return Err(invalid(
                "검색 경로는 폴더 안의 정규 상대 경로 접두어여야 합니다",
            ));
        }
    }
    let extension = request
        .extension
        .as_deref()
        .map(str::trim)
        .map(|s| s.trim_start_matches('.'))
        .filter(|s| !s.is_empty());
    if extension.is_some_and(|s| s.len() > 16 || !s.chars().all(|c| c.is_ascii_alphanumeric())) {
        return Err(invalid("확장자는 영문·숫자 16자 이하여야 합니다"));
    }
    Ok((
        prefix.map(str::to_owned),
        extension.map(|s| format!(".{}", s.to_ascii_lowercase())),
    ))
}

// G7/V2: keep every term witness; spend the line budget on evidence before context.
fn excerpt_windows(
    positions: &[usize],
    lines: usize,
    context: usize,
) -> Vec<std::ops::Range<usize>> {
    let mut positions = positions.to_vec();
    positions.sort_unstable();
    let mut ranges: Vec<std::ops::Range<usize>> = Vec::new();
    for position in positions {
        let start = position.saturating_sub(context);
        let end = (position + context + 1).min(lines);
        if let Some(last) = ranges.last_mut() {
            // Omitting just one line would cost another line for the gap marker.
            if start <= last.end + 1 {
                last.end = last.end.max(end);
                continue;
            }
        }
        ranges.push(start..end);
    }
    ranges
}

// unicode61 treats ASCII punctuation (including underscores) as separators.
// Unknown Unicode boundaries stay conservative: retain the full chunk instead of
// mistaking a combining mark/private-use character for a token boundary.
fn token_separator(c: char) -> bool {
    (c.is_ascii() && !c.is_ascii_alphanumeric()) || c.is_whitespace()
}

fn term_position(line: &str, term: &str, mode: IndexSearchMode) -> Option<usize> {
    let lower = line.to_lowercase();
    lower.match_indices(term).find_map(|(at, _)| {
        let before = lower[..at].chars().next_back();
        let after = lower[at + term.len()..].chars().next();
        (before.is_none_or(token_separator)
            && (mode == IndexSearchMode::Prefix || after.is_none_or(token_separator)))
        .then_some(at)
    })
}

fn excerpt(hit: &mut IndexHit, query: &str, mode: IndexSearchMode) {
    let lines: Vec<_> = hit.excerpt.lines().collect();
    if lines.len() <= 8 {
        return;
    }
    let lower = hit.excerpt.to_lowercase();
    let query_lower = query.trim().to_lowercase();
    let query_terms = terms(query.trim())
        .into_iter()
        .map(str::to_lowercase)
        .collect::<Vec<_>>();
    let at = declaration_position(&hit.excerpt, query)
        .or_else(|| exact_position(&hit.excerpt, query))
        .filter(|&at| {
            let before = lower[..at].chars().next_back();
            let after = lower[at + query_lower.len()..].chars().next();
            before.is_none_or(token_separator)
                && after.is_none_or(token_separator)
                && query_terms.iter().all(|term| {
                    term_position(&lower[at..at + query_lower.len()], term, mode).is_some()
                })
        });
    let positions = if let Some(at) = at {
        vec![
            lower[..at].bytes().filter(|b| *b == b'\n').count(),
            lower[..at + query_lower.len()]
                .bytes()
                .filter(|b| *b == b'\n')
                .count(),
        ]
    } else {
        let positions = query_terms
            .iter()
            .map(|term| {
                lines
                    .iter()
                    .position(|line| term_position(line, term, mode).is_some())
            })
            .collect::<Option<Vec<_>>>();
        // FTS may fold accents or match the path. If any witness cannot be mapped
        // conservatively to source lines, do not omit potentially necessary evidence.
        let Some(positions) = positions else {
            return;
        };
        positions
    };
    if at.is_none() && positions.len() > 1 {
        // At most 16 terms need 16 witness lines and 15 gap markers at zero context.
        let mut context = 3;
        let ranges = loop {
            let ranges = excerpt_windows(&positions, lines.len(), context);
            let count = ranges.iter().map(|range| range.len()).sum::<usize>() + ranges.len() - 1;
            if count <= MAX_MULTITERM_EXCERPT_LINES || context == 0 {
                break ranges;
            }
            context -= 1;
        };
        let mut parts = Vec::new();
        for (index, range) in ranges.iter().enumerate() {
            if index > 0 {
                // Absolute source lines keep every omitted interval available to read_index_excerpt.
                parts.push(format!(
                    "... [lines {}-{} omitted] ...",
                    hit.start_line + ranges[index - 1].end,
                    hit.start_line + range.start - 1
                ));
            }
            parts.push(lines[range.clone()].join("\n"));
        }
        hit.excerpt = parts.join("\n");
        hit.end_line = hit.start_line + ranges.last().unwrap().end - 1;
        hit.start_line += ranges[0].start;
        return;
    }
    let first = positions
        .iter()
        .min()
        .copied()
        .unwrap_or(0)
        .saturating_sub(3);
    let end = (positions.iter().max().copied().unwrap_or(0) + 4)
        .min(lines.len())
        .max((first + 1).min(lines.len()));
    hit.excerpt = lines[first..end].join("\n");
    hit.start_line += first;
    hit.end_line = hit.start_line + end - first - 1;
}

pub(super) fn run(app: &Path, request: SearchIndexRequest) -> Result<IndexSearchResult, CoreError> {
    run_with_candidate_limit(app, request, MAX_MATCHED_CHUNKS)
}

pub(super) fn run_with_candidate_limit(
    app: &Path,
    request: SearchIndexRequest,
    max_chunks: usize,
) -> Result<IndexSearchResult, CoreError> {
    let query = match_query(&request.query, request.mode)?;
    let (prefix, extension) = filters(&request)?;
    let mut result = IndexSearchResult {
        hits: Vec::new(),
        stale_files: Vec::new(),
        truncated: false,
        untrusted: true,
        partial_sources: Vec::new(),
        pending_sources: Vec::new(),
    };
    if !app.join(DATABASE).try_exists()? {
        return Ok(result);
    }
    let connection = open(app, false)?;
    connection.create_scalar_function(
        "am_index_score",
        2,
        FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DETERMINISTIC,
        |context| {
            let text = context.get::<String>(0)?;
            let query = context.get::<String>(1)?;
            Ok(if declaration_position(&text, &query).is_some() {
                2_i32
            } else if exact_position(&text, &query).is_some() {
                1
            } else {
                0
            })
        },
    )?;
    connection.execute_batch("BEGIN")?;
    if !settings(&connection)?.0 {
        return Err(invalid(
            "인덱스 사용이 꺼져 있습니다. 애드온 → 인덱스에서 켜 주세요",
        ));
    }
    let caller = caller_roots(request.project.as_deref());
    if let Some(id) = &request.source_id {
        source(&connection, id, true, caller.as_deref())?;
    }
    let sources = snapshot(&connection, true, caller.as_deref())?
        .sources
        .into_iter()
        .filter(|s| request.source_id.as_ref().is_none_or(|id| id == &s.id))
        .collect::<Vec<_>>();
    result.partial_sources = sources
        .iter()
        .filter(|s| s.truncated)
        .map(|s| s.id.clone())
        .collect();
    result.pending_sources = sources
        .iter()
        .filter(|s| s.indexed_at.is_none())
        .map(|s| s.id.clone())
        .collect();
    let allowed = serde_json::to_string(&sources.iter().map(|s| &s.id).collect::<Vec<_>>())?;
    // Rank one chunk per file before applying the candidate budget. A repeated or stale file
    // cannot consume all 200 candidates and hide fresh matches in other files.
    let mut statement = connection.prepare("WITH ranked AS MATERIALIZED (
        SELECT c.rowid chunk_id,f.rowid file_id,c.start_line,
        bm25(chunks) score,max(am_index_score(c.body,?4),am_index_score(c.path,?4)) exact_match
        FROM chunks c JOIN sources s ON s.id=c.source_id
        JOIN files f ON f.source_id=c.source_id AND f.path=c.path
        WHERE chunks MATCH ?1 AND s.enabled=1 AND s.id IN (SELECT value FROM json_each(?2))
        AND lower(c.path) NOT GLOB '*cypress.env.json'
        AND (?5 IS NULL OR substr(c.path,1,length(?5))=?5)
        AND (?6 IS NULL OR substr(lower(c.path),-length(?6))=?6)
        AND (?3=0 OR am_index_score(c.body,?4) OR am_index_score(c.path,?4))
        ORDER BY exact_match DESC,score,c.rowid LIMIT ?7
        ), best AS (
        SELECT *,row_number() OVER (PARTITION BY file_id ORDER BY exact_match DESC,score,start_line) position FROM ranked)
        SELECT c.source_id,s.name,s.path,c.path,c.start_line,c.end_line,c.digest,c.body,
        (SELECT count(*) FROM ranked)>=?7
        FROM best b JOIN chunks c ON c.rowid=b.chunk_id JOIN sources s ON s.id=c.source_id WHERE b.position=1
        ORDER BY b.exact_match DESC,b.score,c.source_id,c.path LIMIT 201")?;
    let rows = statement.query_map(
        params![
            query,
            allowed,
            request.mode == IndexSearchMode::Exact,
            request.query.trim(),
            prefix,
            extension,
            max_chunks + 1
        ],
        |row| {
            Ok((
                row.get::<_, String>(2)?,
                IndexHit {
                    source_id: row.get(0)?,
                    source_name: row.get(1)?,
                    relative_path: row.get(3)?,
                    start_line: row.get(4)?,
                    end_line: row.get(5)?,
                    digest: row.get(6)?,
                    excerpt: row.get(7)?,
                    untrusted: true,
                },
                row.get::<_, bool>(8)?,
            ))
        },
    )?;
    let limit = request.limit.unwrap_or(8).clamp(1, 20);
    let mut chars = result
        .partial_sources
        .iter()
        .chain(&result.pending_sources)
        .map(|id| id.chars().count() + 4)
        .sum::<usize>();
    for (candidate, row) in rows.enumerate() {
        if candidate >= 200 || result.hits.len() >= limit {
            result.truncated = true;
            break;
        }
        let (root, mut hit, limited) = row?;
        result.truncated |= limited;
        let key = format!("{}/{}", hit.source_id, hit.relative_path);
        let fresh = validate_root(app, &root)
            .and_then(|root| resolve_file(app, &root, &hit.relative_path))
            .and_then(|path| read_text(&path))
            .ok()
            .flatten()
            .is_some_and(|(_, digest)| digest == hit.digest);
        if !fresh {
            chars += key.chars().count();
            if chars > MAX_RESULT_CHARS {
                result.truncated = true;
                break;
            }
            result.stale_files.push(key);
            continue;
        }
        excerpt(&mut hit, &request.query, request.mode);
        chars += hit.excerpt.chars().count()
            + hit.relative_path.chars().count()
            + hit.source_name.chars().count()
            + 160;
        if chars > MAX_RESULT_CHARS {
            result.truncated = true;
            break;
        }
        result.hits.push(hit);
    }
    Ok(result)
}

#[cfg(test)]
mod excerpt_tests {
    use super::*;

    fn hit(lines: Vec<String>) -> IndexHit {
        IndexHit {
            source_id: "fixture".into(),
            source_name: "Fixture".into(),
            relative_path: "guide.md".into(),
            start_line: 101,
            end_line: 100 + lines.len(),
            digest: "fixture".into(),
            excerpt: lines.join("\n"),
            untrusted: true,
        }
    }

    #[test]
    fn v2_multiterm_excerpt_preserves_evidence_and_absolute_gap_lines() {
        let mut lines = (1..=50)
            .map(|n| format!("ordinary row {n}"))
            .collect::<Vec<_>>();
        lines[3] = "orchard evidence".into();
        lines[45] = "갱신 evidence".into();
        let mut result = hit(lines.clone());
        excerpt(&mut result, "ORCHARD 갱신", IndexSearchMode::Prefix);
        assert_eq!((result.start_line, result.end_line), (101, 149));
        assert_eq!(result.excerpt.lines().count(), 15);
        assert_eq!(
            result.excerpt,
            format!(
                "{}\n... [lines 108-142 omitted] ...\n{}",
                lines[..7].join("\n"),
                lines[42..49].join("\n")
            )
        );
    }

    #[test]
    fn v2_multiterm_excerpt_reduces_context_before_any_of_sixteen_terms() {
        for stem in ["witness", "wİtness"] {
            let mut lines = vec!["ordinary context".to_owned(); 80];
            let words = (0..16).map(|n| format!("{stem}{n:02}")).collect::<Vec<_>>();
            for (n, word) in words.iter().enumerate() {
                lines[n * 5] = word.clone();
            }
            let mut result = hit(lines);
            excerpt(&mut result, &words.join(" "), IndexSearchMode::Prefix);
            assert!(result.excerpt.lines().count() <= 32);
            for word in words {
                assert!(result.excerpt.lines().any(|line| line == word));
            }
            assert_eq!((result.start_line, result.end_line), (101, 176));
        }
    }

    #[test]
    fn v2_multiterm_excerpt_merges_adjacent_windows_without_a_gap() {
        let mut lines = vec!["ordinary".to_owned(); 20];
        lines[5] = "orchard".into();
        lines[10] = "witness".into();
        let mut result = hit(lines.clone());
        excerpt(&mut result, "orchard witness", IndexSearchMode::Prefix);
        assert_eq!(result.excerpt, lines[2..14].join("\n"));
        assert_eq!((result.start_line, result.end_line), (103, 114));
    }

    #[test]
    fn v2_exact_multiline_phrase_keeps_its_interior_even_over_context_budget() {
        let mut lines = vec![String::new(); 45];
        lines[2] = "orchard".into();
        lines[39] = "witness".into();
        let query = lines[2..40].join("\n");
        let mut result = hit(lines.clone());
        excerpt(&mut result, &query, IndexSearchMode::Prefix);
        assert_eq!(result.excerpt, lines[..43].join("\n"));
        assert_eq!((result.start_line, result.end_line), (101, 143));
    }

    #[test]
    fn v2_multiterm_excerpt_uses_token_witnesses_after_embedded_substrings() {
        for decoy in [
            "concatenate",
            "x\u{301}cat",
            "\u{e000}cat",
            "갱cat",
            "x\u{301}cat dog",
        ] {
            let mut lines = vec!["ordinary".to_owned(); 50];
            lines[3] = decoy.into();
            lines[24] = "cat evidence".into();
            lines[45] = "dog evidence".into();
            let mut result = hit(lines);
            excerpt(&mut result, "cat dog", IndexSearchMode::Prefix);
            assert!(
                result.excerpt.lines().any(|line| line == "cat evidence"),
                "{decoy}"
            );
        }
    }

    #[test]
    fn v2_multiterm_excerpt_distinguishes_prefix_and_exact_witnesses() {
        let mut lines = vec!["ordinary".to_owned(); 50];
        lines[3] = "catalog evidence".into();
        lines[24] = "cat evidence".into();
        lines[45] = "dog evidence".into();
        let mut prefix = hit(lines.clone());
        excerpt(&mut prefix, "cat dog", IndexSearchMode::Prefix);
        assert!(prefix.excerpt.contains("catalog evidence"));
        let mut exact = hit(lines);
        excerpt(&mut exact, "cat dog", IndexSearchMode::Exact);
        assert!(exact.excerpt.lines().any(|line| line == "cat evidence"));
        assert!(!exact.excerpt.contains("catalog evidence"));
    }

    #[test]
    fn v2_multiterm_excerpt_keeps_unmapped_normalized_evidence() {
        let mut lines = vec!["ordinary".to_owned(); 50];
        lines[24] = "café evidence".into();
        lines[45] = "dog evidence".into();
        let mut result = hit(lines.clone());
        excerpt(&mut result, "cafe dog", IndexSearchMode::Prefix);
        assert_eq!(result.excerpt, lines.join("\n"));
        assert_eq!((result.start_line, result.end_line), (101, 150));
    }

    #[test]
    fn v2_multiterm_excerpt_checks_each_term_inside_a_literal_phrase() {
        let mut lines = vec!["ordinary".to_owned(); 50];
        lines[3] = "cat\u{301}dog".into();
        lines[45] = "dog evidence".into();
        let mut result = hit(lines);
        excerpt(&mut result, "cat\u{301}dog", IndexSearchMode::Prefix);
        assert!(result.excerpt.contains("dog evidence"));
    }
}
