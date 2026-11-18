//! G7/G10: directory notifications queue changes, with a bounded metadata fallback.
//! No watcher state contains document bodies, and full reconciliation remains periodic.
use super::{
    allowed_name, database_path, invalid, validate_root, validate_root_path, IndexProgress,
    IndexSnapshot, MAX_SCAN,
};
use crate::CoreError;
use rusqlite::Connection;
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeSet, HashMap},
    fs,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
};

type Key = (PathBuf, String);
static PROGRESS: OnceLock<Mutex<HashMap<Key, IndexProgress>>> = OnceLock::new();
fn running() -> &'static Mutex<HashMap<Key, IndexProgress>> {
    PROGRESS.get_or_init(Mutex::default)
}

pub(super) struct RefreshGuard(Key);
impl RefreshGuard {
    pub(super) fn begin(app: &Path, id: &str) -> Result<Self, CoreError> {
        let key = (database_path(app, false)?, id.to_owned());
        let mut entries = running()
            .lock()
            .map_err(|_| invalid("색인 진행 상태를 읽지 못했습니다"))?;
        if entries.contains_key(&key) {
            return Err(CoreError::Conflict(
                "이 폴더를 이미 색인하고 있습니다".into(),
            ));
        }
        entries.insert(
            key.clone(),
            IndexProgress {
                started_at: crate::clock::now_ms(),
                ..Default::default()
            },
        );
        Ok(Self(key))
    }
    pub(super) fn update(&self, scanned: usize, read_files: usize) {
        if let Ok(mut entries) = running().lock() {
            if let Some(progress) = entries.get_mut(&self.0) {
                progress.scanned_entries = scanned;
                progress.read_files = read_files;
            }
        }
    }
}
impl Drop for RefreshGuard {
    fn drop(&mut self) {
        if let Ok(mut entries) = running().lock() {
            entries.remove(&self.0);
        }
    }
}
pub(super) fn progress(connection: &Connection, id: &str) -> Option<IndexProgress> {
    let key = (PathBuf::from(connection.path()?), id.to_owned());
    running().lock().ok()?.get(&key).cloned()
}

pub(super) fn stamp(meta: &fs::Metadata) -> String {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        format!(
            "{}:{}:{}:{}:{}:{}:{}",
            meta.dev(),
            meta.ino(),
            meta.len(),
            meta.mtime(),
            meta.mtime_nsec(),
            meta.ctime(),
            meta.ctime_nsec()
        )
    }
    #[cfg(not(unix))]
    {
        format!(
            "{}:{:?}:{:?}",
            meta.len(),
            meta.modified().ok(),
            meta.created().ok()
        )
    }
}

fn fingerprint(app: &Path, raw: &str) -> Result<String, CoreError> {
    let root = validate_root(app, raw)?;
    let mut directories = vec![root.clone()];
    let mut values = Vec::new();
    let mut scanned = 0;
    while let Some(directory) = directories.pop() {
        let canonical = validate_root_path(app, &directory)?;
        if !canonical.starts_with(&root) {
            return Err(invalid("인덱스 폴더 밖 경로입니다"));
        }
        for entry in fs::read_dir(&directory)? {
            let entry = entry?;
            scanned += 1;
            if scanned > MAX_SCAN {
                values.push((PathBuf::from("scan-limit"), String::new()));
                break;
            }
            let meta = fs::symlink_metadata(entry.path())?;
            let name = entry.file_name();
            let relative = entry
                .path()
                .strip_prefix(&root)
                .map_err(|_| invalid("폴더 밖 경로입니다"))?
                .to_path_buf();
            // G7/G10: excluded entries still invalidate diagnostics; keep non-UTF-8 names distinct.
            values.push((
                relative,
                format!("{}:{}", meta.file_type().is_symlink(), stamp(&meta)),
            ));
            let Some(name) = name.to_str() else {
                continue;
            };
            if !meta.file_type().is_symlink() && meta.is_dir() && allowed_name(name, true) {
                directories.push(entry.path());
            }
        }
        if scanned > MAX_SCAN {
            break;
        }
    }
    values.sort_unstable();
    let mut hash = Sha256::new();
    for (relative, metadata) in values {
        hash.update(relative.as_os_str().as_encoded_bytes());
        hash.update([0]);
        hash.update(metadata.as_bytes());
        hash.update([0]);
    }
    Ok(format!("{:x}", hash.finalize()))
}

#[derive(Default)]
pub(super) struct WatchQueue {
    fingerprints: HashMap<String, String>,
    pending: BTreeSet<String>,
    native: HashMap<String, super::native::NativeWatch>,
    attempted_native: BTreeSet<String>,
}
impl WatchQueue {
    pub(super) fn poll(&mut self, app: &Path, view: &IndexSnapshot) -> Vec<String> {
        if !view.enabled || !view.auto_refresh {
            self.fingerprints.clear();
            self.pending.clear();
            self.native.clear();
            self.attempted_native.clear();
            return Vec::new();
        }
        let ids: BTreeSet<_> = view
            .sources
            .iter()
            .filter(|source| source.agent_enabled)
            .map(|source| source.id.as_str())
            .collect();
        self.fingerprints.retain(|id, _| ids.contains(id.as_str()));
        self.pending.retain(|id| ids.contains(id.as_str()));
        self.native.retain(|id, _| ids.contains(id.as_str()));
        self.attempted_native.retain(|id| ids.contains(id.as_str()));
        let now = crate::clock::now_ms();
        for source in &view.sources {
            if !source.agent_enabled
                || source.next_retry_at.is_some_and(|at| at > now)
                || source.progress.is_some()
            {
                continue;
            }
            if self.attempted_native.insert(source.id.clone()) {
                if let Ok(watch) = super::native::NativeWatch::create(app, &source.path) {
                    self.native.insert(source.id.clone(), watch);
                    self.pending.insert(source.id.clone());
                }
            }
            if let Some(watch) = self.native.get_mut(&source.id) {
                match watch.changed() {
                    Ok(false) => continue,
                    Ok(true) => {
                        self.pending.insert(source.id.clone());
                        if watch.sync(app, &source.path).is_ok() {
                            continue;
                        }
                    }
                    Err(_) => {
                        self.pending.insert(source.id.clone());
                    }
                }
                // A lost/overflowing watch is reconciled via metadata, never silently ignored.
                self.native.remove(&source.id);
            }
            match fingerprint(app, &source.path) {
                Ok(value) => {
                    if self.fingerprints.get(&source.id) != Some(&value) {
                        self.pending.insert(source.id.clone());
                        self.fingerprints.insert(source.id.clone(), value);
                    }
                }
                Err(_) => {
                    self.pending.insert(source.id.clone());
                }
            }
        }
        self.pending
            .iter()
            .filter(|id| {
                view.sources.iter().any(|source| {
                    &source.id == *id
                        && source.next_retry_at.is_none_or(|at| at <= now)
                        && source.progress.is_none()
                })
            })
            .cloned()
            .collect()
    }
    pub(super) fn complete(&mut self, id: &str) {
        self.pending.remove(id);
    }
    #[cfg(all(test, target_os = "linux"))]
    pub(super) fn has_native(&self, id: &str) -> bool {
        self.native.contains_key(id)
    }
    #[cfg(test)]
    pub(super) fn use_metadata(&mut self, id: &str) {
        self.attempted_native.insert(id.to_owned());
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::index_addon::*;
    use std::{ffi::OsStr, os::unix::ffi::OsStrExt};

    /// APFS(macOS 기본 파일시스템)는 UTF-8이 아닌 파일 이름을 EILSEQ로 거절한다. 그런
    /// 파일시스템에서는 이 시험들이 보려는 상태 자체를 만들 수 없으므로 건너뛰고, 계약은
    /// 그런 이름을 받는 리눅스 파일시스템에서 지킨다.
    fn non_utf8_names_supported(dir: &std::path::Path) -> bool {
        let probe = dir.join(OsStr::from_bytes(b"probe\xff"));
        match fs::write(&probe, b"") {
            Ok(()) => {
                let _ = fs::remove_file(&probe);
                true
            }
            Err(error) if error.raw_os_error() == Some(libc::EILSEQ) => {
                eprintln!("skipped: filesystem rejects non-UTF-8 names");
                false
            }
            Err(error) => panic!("non-UTF-8 name probe: {error}"),
        }
    }

    #[test]
    fn g7_g10_fingerprint_tracks_non_utf8_entries_without_descending() {
        let temporary_root = fs::canonicalize(std::env::temp_dir()).unwrap();
        let temp = tempfile::tempdir_in(temporary_root).unwrap();
        if !non_utf8_names_supported(temp.path()) {
            return;
        }
        let app = temp.path().join("app");
        let root = temp.path().join("source");
        fs::create_dir(&root).unwrap();
        let raw = root.to_str().unwrap();
        let empty = fingerprint(&app, raw).unwrap();
        let file = root.join(OsStr::from_bytes(b"bad\xff.md"));
        fs::write(&file, "excluded content").unwrap();
        assert_ne!(fingerprint(&app, raw).unwrap(), empty);
        // The same inode/stamp under names with identical lossy displays must stay distinct.
        let alias_root = temp.path().join("alias");
        fs::create_dir(&alias_root).unwrap();
        let alias = alias_root.join(OsStr::from_bytes(b"bad\xfe.md"));
        assert_eq!(
            file.file_name().unwrap().to_string_lossy(),
            alias.file_name().unwrap().to_string_lossy()
        );
        fs::hard_link(&file, &alias).unwrap();
        assert_ne!(
            fingerprint(&app, raw).unwrap(),
            fingerprint(&app, alias_root.to_str().unwrap()).unwrap()
        );
        fs::remove_file(file).unwrap();
        assert_eq!(fingerprint(&app, raw).unwrap(), empty);

        let directory = root.join(OsStr::from_bytes(b"bad\xfe"));
        fs::create_dir(&directory).unwrap();
        let child = directory.join("child.md");
        fs::write(&child, "before").unwrap();
        let with_directory = fingerprint(&app, raw).unwrap();
        assert_ne!(with_directory, empty);
        fs::write(&child, "after with different size").unwrap();
        assert_eq!(fingerprint(&app, raw).unwrap(), with_directory);
        fs::remove_dir_all(directory).unwrap();
        assert_eq!(fingerprint(&app, raw).unwrap(), empty);
    }

    #[test]
    fn g7_metadata_fallback_refreshes_non_utf8_exclusions() {
        let temporary_root = fs::canonicalize(std::env::temp_dir()).unwrap();
        let temp = tempfile::tempdir_in(temporary_root).unwrap();
        if !non_utf8_names_supported(temp.path()) {
            return;
        }
        let app = temp.path().join("app");
        let root = temp.path().join("source");
        fs::create_dir(&root).unwrap();
        let view = add_index_source(
            &app,
            AddIndexSourceRequest {
                name: "Filename diagnostics".into(),
                path: root.to_str().unwrap().into(),
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
        let view = set_index_source_enabled(
            &app,
            SetIndexSourceEnabledRequest {
                id: id.clone(),
                enabled: true,
            },
        )
        .unwrap();
        let mut queue = WatchQueue::default();
        queue.use_metadata(&id);
        assert_eq!(queue.poll(&app, &view), vec![id.clone()]);
        queue.complete(&id);
        assert!(queue.poll(&app, &view).is_empty());
        let file = root.join(OsStr::from_bytes(b"bad\xff.md"));
        fs::write(&file, "excluded content").unwrap();
        assert_eq!(queue.poll(&app, &view), vec![id.clone()]);
        let refreshed = refresh_index_source(&app, &id).unwrap();
        assert_eq!(refreshed.sources[0].files, 0);
        assert_eq!(refreshed.sources[0].excluded, 1);
        let exclusions = get_index_exclusions(
            &app,
            IndexExclusionsRequest {
                id: id.clone(),
                offset: 0,
                limit: None,
                project: None,
            },
        )
        .unwrap();
        assert_eq!(
            exclusions.items[0].reason,
            IndexExclusionReason::InvalidUtf8
        );
        queue.complete(&id);
        assert!(queue.poll(&app, &view).is_empty());
        fs::remove_file(file).unwrap();
        assert_eq!(queue.poll(&app, &view), vec![id.clone()]);
        assert_eq!(
            refresh_index_source(&app, &id).unwrap().sources[0].excluded,
            0
        );
    }
}
