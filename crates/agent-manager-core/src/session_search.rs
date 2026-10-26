//! Rebuildable, credential-redacted transcript index in G7 app-owned storage.
//! Provider records remain read-only. Search uses literal substrings, including IPs,
//! punctuation and short Korean queries; FTS trigram narrows longer queries.
//!
//! Only the conversation (user questions and assistant answers) is indexed. Tool inputs
//! and results are never stored here: they carry `.env` dumps, connection strings and
//! headers in shapes the line-based `redact` cannot reliably recognise, and this file
//! must not become a second copy of those secrets (G4).
use std::collections::hash_map::DefaultHasher;
use std::collections::{HashMap, HashSet};
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant, UNIX_EPOCH};

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use unicode_normalization::UnicodeNormalization;

use crate::catalog::{SUPPLEMENT_TRUNCATION_MARK, TRANSCRIPT_TRUNCATION_MARK};
use crate::domain::{ContentBlock, ProviderId, SessionRef, SessionSummary};
use crate::session_context::{redact, SessionReadRedaction};
use crate::store::{session_key, CapturedTranscriptTurn};
use crate::CoreError;

const INDEX_FILE_NAME: &str = "session-search-v4.sqlite3";
/// Never shipped; earlier schemas (no per-session state, case-folding trigram, tool
/// records). Deleted on open so no tool text from them stays on disk.
const LEGACY_INDEX_FILE_NAMES: [&str; 3] = [
    "session-search-v1.sqlite3",
    "session-search-v2.sqlite3",
    "session-search-v3.sqlite3",
];
/// Stored with every session row. The stored text is already redacted, so rows built
/// by a release with different `redact`, block selection or `normalize` rules are
/// neither served nor treated as current. Each release therefore re-indexes once.
const INDEX_RULES: &str = concat!("2:", env!("CARGO_PKG_VERSION"));
/// Parsing time one bounded call may spend. The first search after install or a
/// release would otherwise parse every transcript before answering.
const INDEX_BUDGET: Duration = Duration::from_secs(3);
/// A load error may be transient (a lock, a file mid-rotation). It is retried after
/// this long instead of on every keystroke, and nothing about it is persisted.
const FAILURE_RETRY: Duration = Duration::from_secs(60);
const MAX_QUERY_CHARS: usize = 512;
/// Transcript text is searched from two characters up. A single character would scan
/// every stored block for almost no signal; metadata is still matched.
const MIN_CONTENT_QUERY_CHARS: usize = 2;
/// How long a paged caller waits for indexing to finish before it is answered with the
/// remaining `pending_sessions` instead (the first search after a release can mean
/// re-parsing every transcript).
const COMPLETE_LIMIT: Duration = Duration::from_secs(10);

/// How much indexing one call may do.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum IndexBudget {
    /// The screen: spend at most `INDEX_BUDGET` (always at least one session) and
    /// report what is left as `pending_sessions` for the next call.
    Bounded,
    /// Paged callers: a cursor must cut the same result set on every page. Runs
    /// bounded passes until nothing is pending, releasing the index between passes so
    /// the screen's searches are not held behind a full re-index. Gives up after
    /// `COMPLETE_LIMIT` and reports `pending_sessions` like a bounded call.
    Complete,
}

/// One open index and one indexing pass at a time. Overlapping searches (a debounced
/// keystroke and the next one, or the UI and AIA) would otherwise parse the same
/// transcripts twice and race for the SQLite write lock.
static INDEX: Mutex<Option<IndexHandle>> = Mutex::new(None);

/// The newest bounded call. A bounded call that waited on `INDEX` while a newer one
/// arrived (the screen typed on) skips parsing and answers from what is indexed, so
/// queued keystrokes do not each spend `INDEX_BUDGET` before the latest query runs.
static LATEST_BOUNDED: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

#[derive(Debug, Default, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionSearchRequest {
    pub query: String,
    /// Omitted means every session in the active catalog. Unknown identities never
    /// grant access to a provider file outside that catalog.
    pub sessions: Option<Vec<SessionRef>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSearchMatch {
    pub source: ProviderId,
    pub id: String,
    pub index: Option<usize>,
    pub snippet: String,
}

#[derive(Debug, Default, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSearchResponse {
    pub matches: Vec<SessionSearchMatch>,
    pub checked_sessions: usize,
    pub unavailable_sessions: usize,
    pub partial_sessions: usize,
    /// Sessions with no searchable rows yet because a bounded call ran out of time.
    /// Their metadata was still searched; calling again continues indexing.
    pub pending_sessions: usize,
    /// Sessions whose record failed to load this time (a lock, a file mid-rotation).
    /// They are retried after a minute; this is not a verdict that they are unreadable.
    pub failed_sessions: usize,
}

/// What a stored session row says about its blocks.
#[derive(Debug, Clone, Copy, Default)]
struct IndexState {
    unavailable: bool,
    partial: bool,
}

/// Captured turns grouped by session key.
type GroupedTurns = HashMap<String, Vec<CapturedTranscriptTurn>>;

#[derive(Debug, Clone)]
struct StoredRow {
    version: String,
    /// Built under the current `INDEX_RULES`, so its rows may be served even when the
    /// session has changed since.
    current_rules: bool,
    state: IndexState,
}

/// The open index plus what every call would otherwise re-read: the per-session
/// versions in the table, recent load failures, per-session supplement digests, and
/// the last answer.
struct IndexHandle {
    dir: PathBuf,
    db: Connection,
    rows: HashMap<String, StoredRow>,
    failures: HashMap<String, (String, Instant)>,
    /// Store file stamp and each session's supplement digest. Only digests are kept;
    /// the captured texts are read again only when a session has to be re-indexed.
    supplement_digests: Option<(String, HashMap<String, String>)>,
    /// The grouped captured turns, kept only while a bounded search still has pending
    /// sessions so the next pass (a poll, a `Complete` loop) does not re-read the store.
    pending_turns: Option<(String, GroupedTurns)>,
    catalog_digest: u64,
    /// `PRAGMA data_version` when `rows` was last loaded. It changes only when another
    /// connection commits, so the cache follows writes this process did not make.
    data_version: i64,
    memo: Option<(u64, SessionSearchResponse)>,
}

fn load_rows(db: &Connection) -> Result<HashMap<String, StoredRow>, CoreError> {
    let rows = db
        .prepare("SELECT key,version,rules,unavailable,partial FROM sessions")?
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                StoredRow {
                    version: r.get(1)?,
                    current_rules: r.get::<_, String>(2)? == INDEX_RULES,
                    state: IndexState {
                        unavailable: r.get(3)?,
                        partial: r.get(4)?,
                    },
                },
            ))
        })?
        .collect::<Result<_, _>>()?;
    Ok(rows)
}

fn data_version(db: &Connection) -> Result<i64, CoreError> {
    Ok(db.query_row("PRAGMA data_version", [], |r| r.get(0))?)
}

impl IndexHandle {
    fn open(app_data_dir: &Path) -> Result<Self, CoreError> {
        let db = open_index(app_data_dir)?;
        let rows = load_rows(&db)?;
        let data_version = data_version(&db)?;
        Ok(Self {
            dir: app_data_dir.to_path_buf(),
            db,
            rows,
            failures: HashMap::new(),
            supplement_digests: None,
            pending_turns: None,
            catalog_digest: 0,
            data_version,
            memo: None,
        })
    }

    /// Reloads the row cache when another connection changed the file.
    fn follow_external_writes(&mut self) -> Result<(), CoreError> {
        let current = data_version(&self.db)?;
        if current != self.data_version {
            self.rows = load_rows(&self.db)?;
            self.data_version = current;
            self.catalog_digest = 0;
            self.memo = None;
        }
        Ok(())
    }

    /// Refreshes the digests when the store file changed. Returns the store stamp and
    /// any grouped turns already in hand (read for the refresh, or kept from a pass
    /// that left work pending), so the same call can index from them instead of
    /// reading the store again.
    fn refresh_supplement_digests(
        &mut self,
        app_data_dir: &Path,
    ) -> Result<(String, Option<GroupedTurns>), CoreError> {
        let stamp = fingerprint(&crate::store::supplement_store_path(app_data_dir));
        let kept = self
            .pending_turns
            .take()
            .filter(|(kept, _)| kept == &stamp)
            .map(|(_, grouped)| grouped);
        if self
            .supplement_digests
            .as_ref()
            .is_some_and(|(cached, _)| cached == &stamp)
        {
            return Ok((stamp, kept));
        }
        let grouped = crate::store::captured_turns_by_session(app_data_dir)?;
        let digests = grouped
            .iter()
            .map(|(key, turns)| (key.clone(), supplement_digest(turns)))
            .collect();
        self.supplement_digests = Some((stamp.clone(), digests));
        Ok((stamp, Some(grouped)))
    }

    /// Removes derived rows for sessions no longer in the catalog, including cleanup
    /// and inactive projects, so the index never keeps search-only access to removed
    /// sessions. Runs only when the catalog's membership changed. An empty catalog is
    /// a snapshot that has not loaded yet, not a cleanup of everything.
    fn prune_removed(&mut self, sessions: &[SessionSummary]) -> Result<(), CoreError> {
        if sessions.is_empty() {
            return Ok(());
        }
        // A provider missing from a partial snapshot (a scan that failed) loses its rows
        // too and is re-indexed when it returns. Keeping them would leave the text of a
        // provider's last deleted session on disk with nothing to prune it.
        // Order-independent, so a live session moving to the top of the list does not
        // count as a membership change.
        let mut digest = 0u64;
        let current: HashSet<_> = sessions
            .iter()
            .map(|s| {
                let key = session_key(s.source, &s.id);
                let mut hasher = DefaultHasher::new();
                key.hash(&mut hasher);
                digest = digest.wrapping_add(hasher.finish());
                key
            })
            .collect();
        if digest == self.catalog_digest {
            return Ok(());
        }
        let stale: Vec<String> = self
            .rows
            .keys()
            .filter(|key| !current.contains(*key))
            .cloned()
            .collect();
        let tx = self.db.transaction()?;
        for key in &stale {
            tx.execute("DELETE FROM sessions WHERE key=?1", [key])?;
        }
        tx.commit()?;
        for key in stale {
            self.rows.remove(&key);
        }
        self.failures.retain(|key, _| current.contains(key));
        self.catalog_digest = digest;
        Ok(())
    }
}

/// Drops the derived rows of sessions that cleanup removed, so their redacted text
/// does not wait on disk for the next search to notice they left the catalog.
pub(crate) fn forget_sessions(
    app_data_dir: &Path,
    keys: &std::collections::BTreeSet<String>,
) -> Result<(), CoreError> {
    if keys.is_empty() || !app_data_dir.join(INDEX_FILE_NAME).exists() {
        return Ok(());
    }
    let delete = |db: &mut Connection| -> Result<(), CoreError> {
        let tx = db.transaction()?;
        for key in keys {
            tx.execute("DELETE FROM sessions WHERE key=?1", [key])?;
        }
        tx.commit()?;
        Ok(())
    };
    let mut guard = match INDEX.try_lock() {
        Ok(guard) => guard,
        Err(std::sync::TryLockError::Poisoned(poisoned)) => poisoned.into_inner(),
        // A search pass is indexing. Cleanup does not wait behind it: a separate
        // connection deletes the rows, and the busy handle reloads its cache when it
        // sees another connection's commit (`follow_external_writes`).
        Err(std::sync::TryLockError::WouldBlock) => {
            return delete(&mut open_index(app_data_dir)?);
        }
    };
    let handle = ready_handle(&mut guard, app_data_dir)?;
    delete(&mut handle.db)?;
    for key in keys {
        handle.rows.remove(key);
        handle.failures.remove(key);
    }
    handle.memo = None;
    Ok(())
}

/// Errors that mean the file itself cannot be used. Busy, locked or full are transient
/// and must not cost a full rebuild.
fn corrupt(error: &rusqlite::Error) -> bool {
    matches!(
        error.sqlite_error_code(),
        Some(rusqlite::ErrorCode::DatabaseCorrupt | rusqlite::ErrorCode::NotADatabase)
    )
}

/// Closes the cached handle and deletes the index files; the next search rebuilds them.
fn discard_index(app_data_dir: &Path) {
    let mut guard = INDEX
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    *guard = None;
    for file in index_files(&app_data_dir.join(INDEX_FILE_NAME)) {
        let _ = std::fs::remove_file(file);
    }
}

/// The cached handle for `app_data_dir`, reopened when it belongs to another folder
/// or the derived store was deleted (storage reset, manual cleanup) so nothing keeps
/// writing to an unlinked file. The old connection is closed first so its WAL is not
/// left open beside the new database.
fn ready_handle<'a>(
    slot: &'a mut Option<IndexHandle>,
    app_data_dir: &Path,
) -> Result<&'a mut IndexHandle, CoreError> {
    let reopen = slot.as_ref().is_none_or(|handle| {
        handle.dir != app_data_dir || !app_data_dir.join(INDEX_FILE_NAME).exists()
    });
    if reopen {
        *slot = None;
        *slot = Some(IndexHandle::open(app_data_dir)?);
    }
    let handle = slot.as_mut().expect("index opened above");
    handle.follow_external_writes()?;
    Ok(handle)
}

pub(crate) fn normalize(text: &str) -> String {
    text.nfc().flat_map(char::to_lowercase).collect()
}

/// The literal match the session-list searches apply to metadata fields: NFC, case
/// folded, no pattern syntax. The screen mirrors it in `matchesSessionQuery`. The
/// needle is passed through `normalize` once by the caller, so a filter over thousands
/// of sessions does not re-normalize it per item, and the fields are joined first: one
/// normalization per item instead of one per field.
pub(crate) fn literal_match(fields: &[&str], needle: &str) -> bool {
    if needle.is_empty() {
        return false;
    }
    let joined = fields.join("\n");
    // ASCII is already NFC and lowercases one to one, the common case for ids and paths.
    if joined.is_ascii() {
        return joined.to_ascii_lowercase().contains(needle);
    }
    normalize(&joined).contains(needle)
}

fn fingerprint(path: &Path) -> String {
    std::fs::metadata(path)
        .map(|m| {
            format!(
                "{}:{:?}",
                m.len(),
                m.modified()
                    .ok()
                    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            )
        })
        .unwrap_or_default()
}

/// The database file and the WAL companions SQLite keeps beside it.
fn index_files(path: &Path) -> [PathBuf; 3] {
    let companion = |suffix: &str| {
        let mut name = path.as_os_str().to_owned();
        name.push(suffix);
        PathBuf::from(name)
    };
    [path.to_path_buf(), companion("-wal"), companion("-shm")]
}

fn open_index(app_data_dir: &Path) -> Result<Connection, CoreError> {
    for legacy in LEGACY_INDEX_FILE_NAMES {
        for file in index_files(&app_data_dir.join(legacy)) {
            let _ = std::fs::remove_file(file);
        }
    }
    let path = app_data_dir.join(INDEX_FILE_NAME);
    // A WAL left behind by a deleted database must not be paired with the new file.
    if !path.exists() {
        for companion in &index_files(&path)[1..] {
            let _ = std::fs::remove_file(companion);
        }
    }
    // G10: reject a symlink before SQLite opens the app-owned derived store.
    drop(crate::app_data_file::open_private_file(&path, false)?);
    let db = Connection::open(path)?;
    db.busy_timeout(Duration::from_secs(10))?;
    // WAL lets a reader in another process (desktop shell and server) coexist with
    // the indexing writer instead of failing on the rollback journal's lock.
    db.query_row("PRAGMA journal_mode=WAL", [], |_| Ok(()))?;
    db.execute_batch("PRAGMA foreign_keys=ON;
        CREATE TABLE IF NOT EXISTS sessions(key TEXT PRIMARY KEY, version TEXT NOT NULL, rules TEXT NOT NULL,
            unavailable INTEGER NOT NULL, partial INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS blocks(key TEXT NOT NULL REFERENCES sessions(key) ON DELETE CASCADE,
            idx INTEGER NOT NULL, text TEXT NOT NULL, normalized TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS blocks_key ON blocks(key);
        CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(normalized, content='blocks', content_rowid='rowid', tokenize='trigram case_sensitive 1');
        CREATE TRIGGER IF NOT EXISTS blocks_insert AFTER INSERT ON blocks BEGIN
            INSERT INTO search_fts(rowid,normalized) VALUES(new.rowid,new.normalized); END;
        CREATE TRIGGER IF NOT EXISTS blocks_delete AFTER DELETE ON blocks BEGIN
            INSERT INTO search_fts(search_fts,rowid,normalized) VALUES('delete',old.rowid,old.normalized); END;")?;
    Ok(db)
}

/// Conversation text only: what the user asked and the assistant answered. Tool calls
/// and results, context envelopes, reasoning, raw records and images are left out.
fn block_text<'a>(block: &'a ContentBlock, role: &str) -> Option<&'a str> {
    match block {
        ContentBlock::Text { text } if role == "user" || role == "assistant" => Some(text),
        _ => None,
    }
}

/// Display and storage caps append these marks; text quoting them mid-message is
/// not a cut.
fn truncated(text: &str) -> bool {
    text.ends_with(TRANSCRIPT_TRUNCATION_MARK) || text.ends_with(SUPPLEMENT_TRUNCATION_MARK)
}

/// The original character offset where the normalized text reaches `target`
/// characters. Normalization is applied per segment split before ASCII characters:
/// no ASCII character composes with what precedes it and lowercasing is per
/// character, so segment counts add up to the whole text's count. Inside the segment
/// that crosses `target`, a binary search over that segment's prefixes finds the
/// position, so long runs without ASCII (CJK, full-width punctuation) stay exact while
/// the walk over the rest of the text is one linear pass.
fn original_offset(text: &str, target: usize) -> usize {
    // Almost all text is already NFC and lowercases one character to one, where the
    // positions are the same.
    if unicode_normalization::is_nfc(text) && text.chars().all(|c| c.to_lowercase().count() == 1) {
        return target;
    }
    let (mut normalized, mut original) = (0, 0);
    let mut segment: Vec<char> = Vec::new();
    for ch in text.chars().chain(std::iter::once('\0')) {
        if ch.is_ascii() && !segment.is_empty() {
            let count = if segment.len() == 1 && segment[0].is_ascii() {
                1
            } else {
                normalize(&segment.iter().collect::<String>())
                    .chars()
                    .count()
            };
            if normalized + count > target {
                // The longest prefix that does not go past `target`. The shortest prefix
                // that reaches it can end inside a decomposed syllable (`가` + `ᄂ` already
                // counts two), so the window would start one jamo early.
                let (mut low, mut high) = (0, segment.len());
                while low < high {
                    let mid = (low + high).div_ceil(2);
                    let reached = normalize(&segment[..mid].iter().collect::<String>())
                        .chars()
                        .count();
                    if normalized + reached <= target {
                        low = mid;
                    } else {
                        high = mid - 1;
                    }
                }
                return original + low;
            }
            normalized += count;
            original += segment.len();
            segment.clear();
        }
        segment.push(ch);
    }
    original
}

/// The snippet is bounded and preserves the original spelling. Normalization can
/// compose Korean jamo or expand case mappings, so the match position found in the
/// normalized text is mapped back with `original_offset` before slicing.
fn excerpt(text: &str, needle: &str) -> String {
    let normalized = normalize(text);
    let before = normalized
        .find(needle)
        .map(|at| normalized[..at].chars().count())
        .unwrap_or(0);
    let chars: Vec<char> = text.chars().collect();
    // Both ends of the match are mapped back, so a long match in decomposed text (two
    // or three original characters per normalized one) is still inside the window.
    let match_start = original_offset(text, before);
    let match_end = original_offset(text, before + needle.chars().count()).max(match_start);
    let start = match_start.saturating_sub(65);
    let end = (start + 220).max(match_end + 65).min(chars.len());
    format!(
        "{}{}{}",
        if start > 0 { "…" } else { "" },
        chars[start..end].iter().collect::<String>(),
        if end < chars.len() { "…" } else { "" }
    )
}

/// Captured replies can change independently of the provider transcript. Each
/// session's own supplements go into its version, so one active chat does not
/// invalidate the rest; the turn identity, time and length change whenever a reply is
/// added or replaced.
fn supplement_digest(turns: &[CapturedTranscriptTurn]) -> String {
    let mut hasher = DefaultHasher::new();
    for turn in turns {
        (&turn.turn_id, turn.completed_at, turn.text.len()).hash(&mut hasher);
    }
    format!("{:016x}", hasher.finish())
}

/// Built from what the catalog already knows, without a stat per session. The record
/// file is not stat'ed on purpose: sessions without a size (opencode) share one
/// harness database as their file, and its size and time change with every write to
/// any of them; their own update time and message count do not.
/// A change detector, not a security boundary, so a fast non-cryptographic hash is
/// enough; it runs for every selected session on every pass.
fn session_version(session: &SessionSummary, supplement_digest: &str) -> String {
    let mut hasher = DefaultHasher::new();
    (
        &session.file_path,
        session.size_bytes,
        session.message_count,
        session.updated_at,
        supplement_digest,
    )
        .hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

/// Parses one session and replaces its rows. A record the catalog reports as
/// unreadable is stored as unavailable under its version, so it is not re-parsed on
/// every call. A load error returns `None` and stores nothing.
fn index_session(
    handle: &mut IndexHandle,
    home: &Path,
    session: &SessionSummary,
    supplements: Vec<CapturedTranscriptTurn>,
    key: &str,
    version: &str,
) -> Result<Option<IndexState>, CoreError> {
    let Ok(detail) = crate::catalog::load_search_session_detail(home, session.clone(), supplements)
    else {
        return Ok(None);
    };
    let blocks: Vec<(usize, &str)> = detail
        .transcript
        .iter()
        .flat_map(|item| {
            item.blocks
                .iter()
                .filter_map(|b| block_text(b, &item.role))
                .map(|text| (item.index, text))
        })
        .collect();
    let state = IndexState {
        // A record the catalog already marks unreadable (an encrypted Antigravity
        // conversation) has nothing more to search than its captured replies, which are
        // indexed. Counting it would keep the "could not search" notice up for good.
        unavailable: session.readable && detail.unavailable_reason.is_some(),
        partial: detail.truncated
            || detail.skipped_lines > 0
            || blocks.iter().any(|(_, text)| truncated(text)),
    };
    let tx = handle.db.transaction()?;
    tx.execute("DELETE FROM sessions WHERE key=?1", [key])?;
    // No transcript or supplement text is persisted in the version.
    tx.execute(
        "INSERT INTO sessions VALUES(?1,?2,?3,?4,?5)",
        params![key, version, INDEX_RULES, state.unavailable, state.partial],
    )?;
    for (index, text) in blocks {
        let text = redact(text, SessionReadRedaction::Credentials);
        tx.execute(
            "INSERT INTO blocks VALUES(?1,?2,?3,?4)",
            params![key, index as i64, text, normalize(&text)],
        )?;
    }
    tx.commit()?;
    handle.rows.insert(
        key.to_owned(),
        StoredRow {
            version: version.to_owned(),
            current_rules: true,
            state,
        },
    );
    Ok(Some(state))
}

/// The first matching block of each searchable session, earliest first. Grouping in
/// SQL keeps a two-letter query from loading every matching block's text. Trigram
/// candidates are confirmed with the same literal `instr` the short path uses, so both
/// paths answer the same question.
fn first_hits(
    db: &Connection,
    needle: &str,
    keys: &[&str],
) -> Result<Vec<(String, i64, String)>, CoreError> {
    let trigram = needle.chars().count() >= 3;
    let source = if trigram {
        "search_fts f JOIN blocks b2 ON b2.rowid=f.rowid WHERE search_fts MATCH ?1 AND"
    } else {
        "blocks b2 WHERE ?1 IS NULL AND"
    };
    let sql = format!(
        "SELECT b.key,b.idx,b.text FROM blocks b WHERE b.rowid IN (
            SELECT MIN(b2.rowid) FROM {source} b2.key IN (SELECT value FROM json_each(?2))
            AND instr(b2.normalized,?3)>0 GROUP BY b2.key) ORDER BY b.rowid"
    );
    let phrase = trigram.then(|| format!("\"{}\"", needle.replace('"', "\"\"")));
    let rows = db
        .prepare(&sql)?
        .query_map(
            params![phrase, serde_json::to_string(keys)?, needle],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )?
        .collect::<Result<_, _>>()?;
    Ok(rows)
}

/// Where one selected session stands before this call indexes anything.
enum Standing {
    /// Rows match the session's current version.
    Current(IndexState),
    /// Rows exist under the current rules but the session changed since. `retry` is
    /// false while a recent load failure is waiting out `FAILURE_RETRY`; the old rows
    /// are served meanwhile.
    Stale { state: IndexState, retry: bool },
    /// No rows this call may serve.
    Missing,
    /// No rows, and loading failed recently; retried after `FAILURE_RETRY`.
    RecentlyFailed,
}

pub(crate) fn search(
    app_data_dir: &Path,
    home: &Path,
    sessions: Vec<SessionSummary>,
    request: SessionSearchRequest,
    budget: IndexBudget,
) -> Result<SessionSearchResponse, CoreError> {
    let started = Instant::now();
    let ticket = (budget == IndexBudget::Bounded)
        .then(|| LATEST_BOUNDED.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1);
    let mut rebuilt = false;
    loop {
        // Past the limit, one last pass answers with what is indexed and how much is
        // left; the caller is told to ask again rather than being held for minutes.
        let final_pass = budget == IndexBudget::Bounded || started.elapsed() >= COMPLETE_LIMIT;
        let response = match search_pass(
            app_data_dir,
            home,
            &sessions,
            &request,
            budget,
            final_pass,
            ticket,
        ) {
            // The index is derived and rebuildable: a corrupt or foreign file is discarded
            // once and rebuilt instead of failing every search from now on.
            Err(CoreError::Sqlite(error)) if !rebuilt && corrupt(&error) => {
                rebuilt = true;
                discard_index(app_data_dir);
                continue;
            }
            other => other?,
        };
        if final_pass || response.pending_sessions == 0 {
            return Ok(response);
        }
    }
}

fn search_pass(
    app_data_dir: &Path,
    home: &Path,
    sessions: &[SessionSummary],
    request: &SessionSearchRequest,
    budget: IndexBudget,
    final_pass: bool,
    ticket: Option<u64>,
) -> Result<SessionSearchResponse, CoreError> {
    let needle = normalize(request.query.trim());
    if needle.is_empty() {
        return Ok(SessionSearchResponse::default());
    }
    if needle.chars().count() > MAX_QUERY_CHARS {
        return Err(CoreError::InvalidInput(format!(
            "검색어는 {MAX_QUERY_CHARS}자 이하여야 합니다"
        )));
    }
    let allowed: Option<HashSet<_>> = request
        .sessions
        .as_ref()
        .map(|refs| refs.iter().map(|r| (r.source, r.id.as_str())).collect());
    let selected: Vec<&SessionSummary> = sessions
        .iter()
        .filter(|s| {
            allowed
                .as_ref()
                .is_none_or(|refs| refs.contains(&(s.source, s.id.as_str())))
        })
        .collect();
    if needle.chars().count() < MIN_CONTENT_QUERY_CHARS {
        return Ok(SessionSearchResponse {
            checked_sessions: selected.len(),
            matches: selected
                .into_iter()
                .filter(|session| metadata_matches(session, &needle))
                .map(metadata_hit)
                .collect(),
            ..SessionSearchResponse::default()
        });
    }
    let mut guard = INDEX
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let superseded = ticket
        .is_some_and(|ticket| LATEST_BOUNDED.load(std::sync::atomic::Ordering::SeqCst) != ticket);
    let handle = ready_handle(&mut guard, app_data_dir)?;
    handle.prune_removed(sessions)?;
    let (supplement_stamp, mut captured) = handle.refresh_supplement_digests(app_data_dir)?;
    let digests = &handle
        .supplement_digests
        .as_ref()
        .expect("refreshed above")
        .1;
    let now = Instant::now();
    let mut work = Vec::with_capacity(selected.len());
    let mut memo_key = DefaultHasher::new();
    needle.hash(&mut memo_key);
    let mut all_current = true;
    let mut any_recent_failure = false;
    for session in selected {
        let key = session_key(session.source, &session.id);
        let version = session_version(session, digests.get(&key).map_or("", String::as_str));
        let failed_recently = handle.failures.get(&key).is_some_and(|(failed, at)| {
            failed == &version && now.duration_since(*at) < FAILURE_RETRY
        });
        let standing = match handle.rows.get(&key) {
            Some(row) if row.current_rules && row.version == version => {
                Standing::Current(row.state)
            }
            Some(row) if row.current_rules => Standing::Stale {
                state: row.state,
                retry: !failed_recently,
            },
            _ if failed_recently => Standing::RecentlyFailed,
            _ => Standing::Missing,
        };
        all_current &= matches!(standing, Standing::Current(_));
        any_recent_failure |= failed_recently;
        // Metadata hits depend on these fields, which the version does not cover.
        (
            &key,
            &version,
            &session.title,
            &session.project,
            &session.cwd,
            &session.meta.note,
        )
            .hash(&mut memo_key);
        work.push((session, key, version, standing));
    }
    // The same question over unchanged rows (the next page of a list, a repeated
    // poll) gets the same answer without re-running the match.
    let memo_key = memo_key.finish();
    if all_current {
        if let Some((cached, response)) = &handle.memo {
            if *cached == memo_key {
                return Ok(response.clone());
            }
        }
    }
    // Sessions with nothing searchable go first, so a few live sessions that change on
    // every call cannot use up the budget before never-indexed ones get a turn.
    work.sort_by_key(|(_, _, _, standing)| !matches!(standing, Standing::Missing));
    let started = Instant::now();
    let mut response = SessionSearchResponse::default();
    let mut parsed_any = false;
    // Captured texts are read only when something has to be re-indexed.
    let mut indexed: HashMap<String, (&SessionSummary, bool)> = HashMap::new();
    for (session, key, version, standing) in work {
        response.checked_sessions += 1;
        let out_of_time = superseded || (parsed_any && started.elapsed() >= INDEX_BUDGET);
        let state = match standing {
            Standing::Current(state) => Some(state),
            Standing::RecentlyFailed => None,
            Standing::Stale {
                state,
                retry: false,
            } => Some(state),
            // The screen gets the older rows now; a paged caller must not cut its pages
            // from a mix of old and new rows, so for it a stale session is still work.
            Standing::Stale { state, .. } if out_of_time && budget == IndexBudget::Bounded => {
                Some(state)
            }
            Standing::Stale { .. } | Standing::Missing if out_of_time => {
                response.pending_sessions += 1;
                indexed.insert(key, (session, false));
                continue;
            }
            Standing::Stale { .. } | Standing::Missing => {
                parsed_any = true;
                if captured.is_none() {
                    captured = Some(crate::store::captured_turns_by_session(app_data_dir)?);
                }
                let own = captured
                    .as_ref()
                    .and_then(|grouped| grouped.get(&key).cloned())
                    .unwrap_or_default();
                let fresh = index_session(handle, home, session, own, &key, &version)?;
                if fresh.is_none() {
                    handle
                        .failures
                        .insert(key.clone(), (version, Instant::now()));
                }
                // A failed re-index keeps serving the session's older rows.
                fresh.or(match standing {
                    Standing::Stale { state, .. } => Some(state),
                    _ => None,
                })
            }
        };
        match state {
            Some(state) if state.unavailable => response.unavailable_sessions += 1,
            Some(state) if state.partial => response.partial_sessions += 1,
            Some(_) => {}
            None => response.failed_sessions += 1,
        }
        let searchable = handle.rows.get(&key).is_some_and(|row| row.current_rules);
        indexed.insert(key, (session, searchable));
    }
    if response.pending_sessions > 0 {
        handle.pending_turns = captured.map(|grouped| (supplement_stamp, grouped));
    }
    // A paged caller only uses the pass that finished indexing; matching now would be
    // thrown away by the next pass.
    if budget == IndexBudget::Complete && response.pending_sessions > 0 && !final_pass {
        return Ok(response);
    }
    let searchable: Vec<&str> = indexed
        .iter()
        .filter(|(_, (_, rows))| *rows)
        .map(|(key, _)| key.as_str())
        .collect();
    let mut found = HashMap::new();
    for (key, index, text) in first_hits(&handle.db, &needle, &searchable)? {
        if let Some((session, _)) = indexed.get(&key) {
            let hit = SessionSearchMatch {
                source: session.source,
                id: session.id.clone(),
                index: Some(index as usize),
                snippet: excerpt(&text, &needle),
            };
            found.insert(key, hit);
        }
    }
    for (session, _) in sessions
        .iter()
        .filter_map(|s| indexed.get(&session_key(s.source, &s.id)))
    {
        if let Some(hit) = found.remove(&session_key(session.source, &session.id)) {
            response.matches.push(hit);
        } else if metadata_matches(session, &needle) {
            response.matches.push(metadata_hit(session));
        }
    }
    // Unreadable records stored as unavailable are a stable answer; only a pass that
    // parsed, left work pending, or skipped a recent failure may change on retry.
    handle.memo = (all_current && !any_recent_failure && response.pending_sessions == 0)
        .then(|| (memo_key, response.clone()));
    Ok(response)
}

fn metadata_hit(session: &SessionSummary) -> SessionSearchMatch {
    SessionSearchMatch {
        source: session.source,
        id: session.id.clone(),
        index: None,
        snippet: String::new(),
    }
}

/// The metadata fields the session screen matches (`matchesSessionQuery`, which adds
/// live chat ids the catalog does not have). The comparison is the shared
/// `literal_match`; the field sets differ on purpose. The provider name is absent here:
/// "claude" or "co" would otherwise match every session of that provider, and the
/// screen has a provider filter. `list_sessions` keeps it (and lacks the note, which
/// its summaries do not carry) for existing callers.
fn metadata_matches(session: &SessionSummary, needle: &str) -> bool {
    literal_match(
        &[
            session.title.as_str(),
            session.project.as_deref().unwrap_or(""),
            session.cwd.as_deref().unwrap_or(""),
            session.id.as_str(),
            session.meta.note.as_deref().unwrap_or(""),
        ],
        needle,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::SessionMeta;
    use serde_json::json;

    fn claude_session(home: &Path, id: &str, records: &[serde_json::Value]) -> SessionSummary {
        let project = home.join(".claude/projects/search-project");
        std::fs::create_dir_all(&project).expect("project directory");
        let path = project.join(format!("{id}.jsonl"));
        let text: String = records.iter().map(|record| format!("{record}\n")).collect();
        std::fs::write(&path, &text).expect("transcript");
        SessionSummary {
            source: ProviderId::Claude,
            id: id.to_owned(),
            title: "제목".to_owned(),
            source_title: None,
            project: None,
            cwd: None,
            started_at: None,
            updated_at: Some(1),
            message_count: None,
            token_total: None,
            token_usage: None,
            model: None,
            git_branch: None,
            is_subagent: false,
            parent_session_id: None,
            aia_workspace: false,
            aia_chat: false,
            aia_chat_opens_as_standard: false,
            default_workspace: false,
            archived: false,
            readable: true,
            size_bytes: Some(text.len() as u64),
            file_path: path.to_string_lossy().into_owned(),
            meta: SessionMeta::default(),
            last_failure: None,
            related_projects: Vec::new(),
            written_dirs: Vec::new(),
        }
    }

    fn ask(
        app: &Path,
        home: &Path,
        sessions: &[SessionSummary],
        query: &str,
    ) -> SessionSearchResponse {
        search(
            app,
            home,
            sessions.to_vec(),
            SessionSearchRequest {
                query: query.to_owned(),
                sessions: None,
            },
            IndexBudget::Complete,
        )
        .expect("search")
    }

    #[test]
    fn indexes_conversation_text_but_never_tool_records() {
        let app = tempfile::tempdir().expect("app data");
        let home = tempfile::tempdir().expect("home");
        let id = "search-session-0001";
        let session = claude_session(
            home.path(),
            id,
            &[
                json!({"type":"user","uuid":"u1","parentUuid":null,"message":{"role":"user","content":"서버 220.149.36.220 접속 확인"}}),
                json!({"type":"assistant","uuid":"a1","parentUuid":"u1","message":{"role":"assistant","content":[
                    {"type":"text","text":"검색 결과를 정리했습니다"},
                    {"type":"tool_use","id":"t1","name":"Bash","input":{"command":"grep needle-in-tool"}}
                ]}}),
            ],
        );
        let sessions = [session];

        let hit = ask(app.path(), home.path(), &sessions, "220.149.36.220");
        assert_eq!(hit.matches.len(), 1, "{hit:?}");
        assert!(hit.matches[0].index.is_some());
        assert!(hit.matches[0].snippet.contains("220.149.36.220"));
        assert_eq!(hit.pending_sessions, 0);

        // Two characters take the instr path instead of trigram FTS.
        assert_eq!(
            ask(app.path(), home.path(), &sessions, "검색")
                .matches
                .len(),
            1
        );
        // One character searches metadata only.
        assert!(ask(app.path(), home.path(), &sessions, "접")
            .matches
            .is_empty());
        assert_eq!(
            ask(app.path(), home.path(), &sessions, "제").matches.len(),
            1
        );

        assert!(ask(app.path(), home.path(), &sessions, "needle-in-tool")
            .matches
            .is_empty());
        let db = Connection::open(app.path().join(INDEX_FILE_NAME)).expect("index");
        let tool_rows: i64 = db
            .query_row(
                "SELECT COUNT(*) FROM blocks WHERE normalized LIKE '%needle-in-tool%'",
                [],
                |r| r.get(0),
            )
            .expect("count");
        assert_eq!(tool_rows, 0, "tool text must never be stored");

        // A repeated question over unchanged rows is answered from the memo.
        let again = ask(app.path(), home.path(), &sessions, "220.149.36.220");
        assert_eq!(again.matches.len(), 1);

        // A session that left the catalog loses its rows.
        let other = claude_session(
            home.path(),
            "search-session-0002",
            &[
                json!({"type":"user","uuid":"u9","parentUuid":null,"message":{"role":"user","content":"다른 대화"}}),
            ],
        );
        let remaining = [other];
        assert!(ask(app.path(), home.path(), &remaining, "220.149.36.220")
            .matches
            .is_empty());
        let left: i64 = db
            .query_row(
                "SELECT COUNT(*) FROM sessions WHERE key=?1",
                [session_key(ProviderId::Claude, id)],
                |r| r.get(0),
            )
            .expect("count");
        assert_eq!(left, 0);

        // Cleanup drops a removed session's rows without waiting for a search.
        let other_key = session_key(ProviderId::Claude, "search-session-0002");
        forget_sessions(app.path(), &[other_key.clone()].into_iter().collect()).expect("forget");
        let left: i64 = db
            .query_row(
                "SELECT COUNT(*) FROM sessions WHERE key=?1",
                [other_key],
                |r| r.get(0),
            )
            .expect("count");
        assert_eq!(left, 0);
    }

    #[test]
    fn excerpt_window_follows_match_through_decomposed_korean() {
        // 80 NFD syllables are 240 jamo but only 80 normalized characters.
        let prefix: String = "가".repeat(80).nfd().collect();
        let text = format!("{prefix} 220.149.36.220 끝");
        let snippet = excerpt(&text, &normalize("220.149.36.220"));
        assert!(snippet.contains("220.149.36.220"), "{snippet}");
    }

    #[test]
    fn excerpt_keeps_original_spelling_and_marks_cut_edges() {
        let text = format!("{}Needle{}", "a".repeat(300), "b".repeat(300));
        let snippet = excerpt(&text, "needle");
        assert!(snippet.starts_with('…') && snippet.ends_with('…'));
        assert!(snippet.contains("Needle"));
    }

    #[test]
    fn original_offset_maps_normalized_positions_back() {
        let decomposed: String = "한글".nfd().collect();
        let text = format!("{decomposed} abc");
        // Normalized: "한글 abc" — 'a' is normalized char 3, original char 7 (6 jamo + space).
        assert_eq!(original_offset(&text, 3), 7);
        assert_eq!(original_offset("plain", 2), 2);
        // "가나다" decomposed: 가 and 나 are two jamo each, so 다 starts at char 4.
        let syllables: String = "가나다".nfd().collect();
        assert_eq!(original_offset(&syllables, 2), 4);
    }

    #[test]
    fn excerpt_keeps_a_long_decomposed_match_whole() {
        let needle: String = "검색".repeat(40);
        let text: String = format!("{}{}{}", "앞".repeat(100), needle, "뒤".repeat(100))
            .nfd()
            .collect();
        let snippet: String = excerpt(&text, &normalize(&needle)).nfc().collect();
        assert!(snippet.contains(&needle), "{snippet}");
    }

    #[test]
    fn excerpt_finds_a_match_deep_inside_text_without_ascii() {
        let text = format!("{}検索語{}", "日本語の文章。".repeat(80), "続き");
        let snippet = excerpt(&text, &normalize("検索語"));
        assert!(snippet.contains("検索語"), "{snippet}");
    }

    #[test]
    fn only_a_trailing_cap_mark_counts_as_truncation() {
        assert!(truncated(&format!("본문{TRANSCRIPT_TRUNCATION_MARK}")));
        assert!(truncated(&format!("응답{SUPPLEMENT_TRUNCATION_MARK}")));
        assert!(!truncated(&format!(
            "인용{TRANSCRIPT_TRUNCATION_MARK} 뒤에 이어지는 글"
        )));
    }

    #[test]
    fn literal_match_ignores_case_and_composition_but_not_punctuation() {
        let decomposed: String = "검색".nfd().collect();
        assert!(literal_match(&[&decomposed], &normalize("검색")));
        assert!(literal_match(
            &["Server 220.149.36.220"],
            &normalize("Server 220.149")
        ));
        assert!(!literal_match(&["220x149"], &normalize("220.149")));
        assert!(!literal_match(&["anything"], &normalize("  ".trim())));
    }

    #[test]
    fn a_corrupt_index_file_is_discarded_and_rebuilt() {
        let app = tempfile::tempdir().expect("app data");
        let home = tempfile::tempdir().expect("home");
        std::fs::write(app.path().join(INDEX_FILE_NAME), b"not a database at all")
            .expect("garbage");
        let session = claude_session(
            home.path(),
            "search-session-corrupt",
            &[
                json!({"type":"user","uuid":"u1","parentUuid":null,"message":{"role":"user","content":"복구 뒤에도 찾는다"}}),
            ],
        );
        let found = ask(app.path(), home.path(), &[session], "복구 뒤에도");
        assert_eq!(found.matches.len(), 1, "{found:?}");
    }
}
