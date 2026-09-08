//! 앱 데이터 디렉터리 안 휴지통(G7)의 공통 저장 구조.
//!
//! 스킬 휴지통(`skill_trash`)과 지침 휴지통(`instruction_trash`)은 담는 항목만 다를 뿐
//! `<휴지통 루트>/<항목ID>/`에 `manifest.json`과 실체(`content`)를 두고, manifest를
//! 이동이 끝난 뒤 마지막에 쓰며, 실패하면 실체를 원래 자리로 되돌린다는 순서가 같다.
//! 두 모듈이 그 순서를 각자 복사해 두고 있었고 이미 미세하게 갈라져 있었다 — 되돌릴
//! 실체가 있는지 판정하는 기준이 한쪽은 `exists()`(심볼릭 링크를 따라간다), 다른 쪽은
//! `symlink_metadata()`(끊어진 링크도 있다고 본다)였다. 순서가 어긋나면 실체는
//! 사라졌는데 목록에는 남거나 그 반대가 되므로, 순서 자체는 이 모듈 한 곳에만 둔다.
//!
//! 항목의 모양(무엇을 manifest에 적는지, 복구 순서를 어떻게 잡는지, 복구 뒤에 원장을
//! 손보는지)은 휴지통마다 다르므로 각 모듈에 남긴다.

use std::fs;
use std::path::{Path, PathBuf};

use serde::de::DeserializeOwned;
use serde::Serialize;

use crate::clock;
use crate::CoreError;

const MANIFEST_FILE: &str = "manifest.json";
const CONTENT_NAME: &str = "content";

/// 앱 데이터 디렉터리 아래 휴지통 루트. `relative`는 휴지통 종류별 하위 경로다.
pub(crate) fn trash_root(app_data_dir: &Path, relative: &str) -> PathBuf {
    app_data_dir.join(relative)
}

/// 함께 지운 항목을 묶는 ID. 복구도 이 단위로 한다.
pub(crate) fn new_trash_group_id() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

/// 실체를 받을 준비가 끝난 휴지통 항목 디렉터리.
///
/// [`begin_entry`]가 디렉터리를 만들어 돌려주고, 호출부가 [`TrashEntry::content`]로
/// 실체를 옮긴 뒤 [`TrashEntry::commit`]으로 manifest를 쓴다. 실체 이동에 실패하면
/// [`TrashEntry::abort`]로 빈 항목을 남기지 않고 접는다.
pub(crate) struct TrashEntry {
    id: String,
    deleted_at_ms: i64,
    entry_dir: PathBuf,
    content: PathBuf,
}

impl TrashEntry {
    /// manifest에 적을 항목 ID.
    pub(crate) fn id(&self) -> &str {
        &self.id
    }

    /// 항목 디렉터리를 만든 시각. manifest의 삭제 시각과 항목 ID가 같은 값을 쓴다.
    pub(crate) fn deleted_at_ms(&self) -> i64 {
        self.deleted_at_ms
    }

    /// 실체를 옮겨 놓을 자리.
    pub(crate) fn content(&self) -> &Path {
        &self.content
    }

    /// 실체를 옮기지 못했을 때 항목 디렉터리를 지운다.
    pub(crate) fn abort(self) {
        let _ = fs::remove_dir_all(&self.entry_dir);
    }

    /// manifest를 써서 항목을 완성한다. 쓰지 못하면 옮겨 둔 실체를 `source`로
    /// 되돌리려 시도한 뒤 항목 디렉터리를 지우고 실패를 알린다.
    pub(crate) fn commit(self, manifest: &impl Serialize, source: &Path) -> Result<(), CoreError> {
        let bytes = serde_json::to_vec_pretty(manifest)?;
        if let Err(error) = fs::write(self.entry_dir.join(MANIFEST_FILE), bytes) {
            if fs::symlink_metadata(&self.content).is_ok() {
                let _ = move_path(&self.content, source);
            }
            let _ = fs::remove_dir_all(&self.entry_dir);
            return Err(CoreError::Io(error));
        }
        Ok(())
    }
}

/// 휴지통 루트 아래에 새 항목 디렉터리를 만든다. 항목 ID는 삭제 시각·키·난수를 이어
/// 만들어 같은 키를 연달아 지워도 부딪치지 않는다.
pub(crate) fn begin_entry(root: &Path, key: &str) -> Result<TrashEntry, CoreError> {
    fs::create_dir_all(root)?;
    let deleted_at_ms = clock::now_ms();
    let nonce = uuid::Uuid::new_v4().simple().to_string();
    let id = format!("{deleted_at_ms}-{key}-{}", &nonce[..8]);
    let entry_dir = root.join(&id);
    fs::create_dir(&entry_dir)?;
    let content = entry_dir.join(CONTENT_NAME);
    Ok(TrashEntry {
        id,
        deleted_at_ms,
        entry_dir,
        content,
    })
}

/// 휴지통 루트의 manifest를 모두 읽어 최근 삭제가 먼저 오도록 정렬해 돌려준다.
///
/// manifest가 없거나 읽지 못하는 디렉터리는 미완성 항목으로 보고 건너뛴다 — 실체는
/// 옮겼는데 manifest를 쓰기 전에 죽은 흔적이라, 목록에 섞으면 복구할 수 없는 항목을
/// 보여 주게 된다.
pub(crate) fn read_entries<T: DeserializeOwned>(
    root: &Path,
    deleted_at_ms: impl Fn(&T) -> i64,
) -> Result<Vec<T>, CoreError> {
    let mut items = Vec::new();
    if root.is_dir() {
        for entry in fs::read_dir(root)?.flatten() {
            let Ok(bytes) = fs::read(entry.path().join(MANIFEST_FILE)) else {
                continue;
            };
            if let Ok(item) = serde_json::from_slice::<T>(&bytes) {
                items.push(item);
            }
        }
    }
    items.sort_by_key(|item| std::cmp::Reverse(deleted_at_ms(item)));
    Ok(items)
}

/// 선택한 항목과 같은 삭제 그룹을 복구 순서로 돌려준다.
///
/// 공유 원본(provider 없음)을 배포본보다 먼저, 같은 종류 안에서는 먼저 삭제된 항목을
/// 먼저 복구한다. 스킬과 지침 휴지통이 이 순서를 따로 적으면 링크·배포본이 원본보다
/// 먼저 복구될 수 있으므로 그룹 선택과 정렬을 한곳에서 맡는다.
pub(crate) fn ordered_restore_group<'a, T>(
    items: &'a [T],
    requested_id: &str,
    id_of: impl Fn(&'a T) -> &'a str,
    group_id_of: impl Fn(&'a T) -> &'a str,
    has_provider: impl Fn(&T) -> bool,
    deleted_at_ms: impl Fn(&T) -> i64,
) -> Result<(String, Vec<&'a T>), CoreError> {
    let target = items
        .iter()
        .find(|item| id_of(item) == requested_id)
        .ok_or_else(|| CoreError::NotFound("휴지통에서 항목을 찾지 못했습니다".to_owned()))?;
    let group_id = group_id_of(target).to_owned();
    let mut group = items
        .iter()
        .filter(|item| group_id_of(item) == group_id)
        .collect::<Vec<_>>();
    group.sort_by_key(|item| (has_provider(item), deleted_at_ms(item)));
    Ok((group_id, group))
}

/// 항목 하나의 디렉터리와 그 안의 실체 경로.
pub(crate) fn entry_paths(root: &Path, id: &str) -> (PathBuf, PathBuf) {
    let entry_dir = root.join(id);
    let content = entry_dir.join(CONTENT_NAME);
    (entry_dir, content)
}

/// 복구를 시작하기 전 원래 경로의 상태.
pub(crate) enum RestoreTarget {
    /// 자리가 비어 있고 상위 폴더도 준비됐다.
    Ready,
    /// 원래 경로에 이미 무언가 있어 덮어쓰지 않는다.
    Occupied,
    /// 상위 폴더를 만들지 못했다.
    ParentFailed(String),
}

/// 복구 대상 자리를 확인하고 상위 폴더를 만든다. 이미 있는 항목은 덮어쓰지 않는다.
pub(crate) fn prepare_restore_target(original: &Path) -> RestoreTarget {
    if fs::symlink_metadata(original).is_ok() {
        return RestoreTarget::Occupied;
    }
    if let Some(parent) = original.parent() {
        if let Err(error) = fs::create_dir_all(parent) {
            return RestoreTarget::ParentFailed(error.to_string());
        }
    }
    RestoreTarget::Ready
}

/// 휴지통 비우기. `id`가 있으면 해당 항목만, 없으면 전체를 지운다. 지운 항목 수를
/// 돌려준다.
pub(crate) fn purge(root: &Path, id: Option<&str>) -> Result<usize, CoreError> {
    if !root.is_dir() {
        return Ok(0);
    }
    let mut removed = 0;
    match id {
        Some(id) => {
            // 항목 ID는 단일 디렉터리 이름이어야 한다. 경로 구분자를 막아 휴지통
            // 밖 삭제를 차단한다.
            if id.is_empty() || id.contains(['/', '\\']) || id.contains("..") {
                return Err(CoreError::InvalidInput(
                    "휴지통 항목 ID가 올바르지 않습니다".to_owned(),
                ));
            }
            let entry_dir = root.join(id);
            if !entry_dir.is_dir() {
                return Err(CoreError::NotFound(
                    "휴지통에서 항목을 찾지 못했습니다".to_owned(),
                ));
            }
            fs::remove_dir_all(&entry_dir)?;
            removed = 1;
        }
        None => {
            for entry in fs::read_dir(root)?.flatten() {
                if entry.path().is_dir() {
                    fs::remove_dir_all(entry.path())?;
                    removed += 1;
                }
            }
        }
    }
    Ok(removed)
}

/// rename을 우선하고, 볼륨이 다르거나 Windows에서 rename이 거부되면 재귀 복사 후
/// 원본을 지우는 방식으로 옮긴다.
pub(crate) fn move_path(source: &Path, destination: &Path) -> Result<(), CoreError> {
    if fs::rename(source, destination).is_ok() {
        return Ok(());
    }
    let metadata = fs::symlink_metadata(source)?;
    if metadata.file_type().is_symlink() {
        let target = fs::read_link(source)?;
        create_symlink(&target, destination)?;
        fs::remove_file(source)?;
        return Ok(());
    }
    if metadata.is_dir() {
        copy_directory_recursive(source, destination)?;
        fs::remove_dir_all(source)?;
        return Ok(());
    }
    fs::copy(source, destination)?;
    fs::remove_file(source)?;
    Ok(())
}

fn copy_directory_recursive(source: &Path, destination: &Path) -> Result<(), CoreError> {
    fs::create_dir_all(destination)?;
    for entry in fs::read_dir(source)?.flatten() {
        let from = entry.path();
        let to = destination.join(entry.file_name());
        let metadata = fs::symlink_metadata(&from)?;
        if metadata.file_type().is_symlink() {
            let target = fs::read_link(&from)?;
            create_symlink(&target, &to)?;
        } else if metadata.is_dir() {
            copy_directory_recursive(&from, &to)?;
        } else {
            fs::copy(&from, &to)?;
        }
    }
    Ok(())
}

#[cfg(unix)]
pub(crate) fn create_symlink(target: &Path, link: &Path) -> Result<(), CoreError> {
    std::os::unix::fs::symlink(target, link).map_err(CoreError::Io)
}

#[cfg(windows)]
pub(crate) fn create_symlink(target: &Path, link: &Path) -> Result<(), CoreError> {
    if target.is_dir() {
        std::os::windows::fs::symlink_dir(target, link).map_err(CoreError::Io)
    } else {
        std::os::windows::fs::symlink_file(target, link).map_err(CoreError::Io)
    }
}

#[cfg(not(any(unix, windows)))]
pub(crate) fn create_symlink(_target: &Path, _link: &Path) -> Result<(), CoreError> {
    Err(CoreError::InvalidInput(
        "이 플랫폼에서는 심볼릭 링크 복구를 지원하지 않습니다".to_owned(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(serde::Serialize, serde::Deserialize, PartialEq, Debug)]
    struct Manifest {
        id: String,
        deleted_at_ms: i64,
    }

    fn manifest(entry: &TrashEntry) -> Manifest {
        Manifest {
            id: entry.id().to_owned(),
            deleted_at_ms: entry.deleted_at_ms(),
        }
    }

    #[test]
    fn commit_writes_the_manifest_only_after_the_content_moved() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let root = directory.path().join("trash");
        let source = directory.path().join("source");
        fs::create_dir(&source).expect("source directory");
        fs::write(source.join("file.txt"), b"payload").expect("source file");

        let entry = begin_entry(&root, "key").expect("entry");
        let entry_dir = root.join(entry.id());
        // manifest는 아직 없다 — 이 상태의 디렉터리는 목록에서 빠져야 한다.
        assert!(entry_dir.is_dir());
        assert!(read_entries::<Manifest>(&root, |item| item.deleted_at_ms)
            .expect("listing")
            .is_empty());

        move_path(&source, entry.content()).expect("move");
        let stored = manifest(&entry);
        entry.commit(&stored, &source).expect("commit");
        assert!(!source.exists());

        let items = read_entries::<Manifest>(&root, |item| item.deleted_at_ms).expect("listing");
        assert_eq!(items, vec![stored]);
    }

    #[test]
    fn abort_leaves_no_entry_behind() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let root = directory.path().join("trash");
        let entry = begin_entry(&root, "key").expect("entry");
        let entry_dir = root.join(entry.id());
        entry.abort();
        assert!(!entry_dir.exists());
    }

    #[test]
    fn commit_returns_the_content_when_the_manifest_cannot_be_written() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let root = directory.path().join("trash");
        let source = directory.path().join("source.txt");
        fs::write(&source, b"payload").expect("source file");

        let entry = begin_entry(&root, "key").expect("entry");
        let entry_dir = root.join(entry.id());
        move_path(&source, entry.content()).expect("move");
        // manifest 자리에 디렉터리를 놓아 쓰기를 실패시킨다.
        fs::create_dir(entry_dir.join(MANIFEST_FILE)).expect("blocking directory");

        assert!(entry.commit(&serde_json::json!({}), &source).is_err());
        assert_eq!(fs::read(&source).expect("restored content"), b"payload");
        assert!(!entry_dir.exists());
    }

    #[test]
    fn read_entries_sorts_the_most_recent_deletion_first() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let root = directory.path().join("trash");
        fs::create_dir_all(root.join("older")).expect("older entry");
        fs::create_dir_all(root.join("newer")).expect("newer entry");
        fs::write(
            root.join("older").join(MANIFEST_FILE),
            serde_json::to_vec(&serde_json::json!({ "id": "older", "deletedAtMs": 1 }))
                .expect("older manifest"),
        )
        .expect("older manifest write");
        fs::write(
            root.join("newer").join(MANIFEST_FILE),
            serde_json::to_vec(&serde_json::json!({ "id": "newer", "deletedAtMs": 2 }))
                .expect("newer manifest"),
        )
        .expect("newer manifest write");
        // 깨진 manifest는 건너뛴다.
        fs::create_dir_all(root.join("broken")).expect("broken entry");
        fs::write(root.join("broken").join(MANIFEST_FILE), b"{ not json")
            .expect("broken manifest write");

        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Stored {
            id: String,
            deleted_at_ms: i64,
        }
        let items = read_entries::<Stored>(&root, |item| item.deleted_at_ms).expect("listing");
        assert_eq!(
            items
                .iter()
                .map(|item| item.id.as_str())
                .collect::<Vec<_>>(),
            vec!["newer", "older"]
        );
    }

    #[test]
    fn ordered_restore_group_selects_the_group_and_puts_its_source_first() {
        #[derive(Debug)]
        struct Item {
            id: &'static str,
            group_id: &'static str,
            provider: Option<&'static str>,
            deleted_at_ms: i64,
        }
        let items = [
            Item {
                id: "deployment-later",
                group_id: "selected",
                provider: Some("codex"),
                deleted_at_ms: 30,
            },
            Item {
                id: "unrelated",
                group_id: "other",
                provider: None,
                deleted_at_ms: 5,
            },
            Item {
                id: "source",
                group_id: "selected",
                provider: None,
                deleted_at_ms: 20,
            },
            Item {
                id: "deployment-earlier",
                group_id: "selected",
                provider: Some("claude"),
                deleted_at_ms: 10,
            },
        ];

        let (group_id, group) = ordered_restore_group(
            &items,
            "deployment-later",
            |item| item.id,
            |item| item.group_id,
            |item| item.provider.is_some(),
            |item| item.deleted_at_ms,
        )
        .expect("ordered group");

        assert_eq!(group_id, "selected");
        assert_eq!(
            group.iter().map(|item| item.id).collect::<Vec<_>>(),
            vec!["source", "deployment-earlier", "deployment-later"]
        );
        assert!(matches!(
            ordered_restore_group(
                &items,
                "missing",
                |item| item.id,
                |item| item.group_id,
                |item| item.provider.is_some(),
                |item| item.deleted_at_ms,
            ),
            Err(CoreError::NotFound(_))
        ));
    }

    #[test]
    fn purge_refuses_an_item_id_that_escapes_the_trash_root() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let root = directory.path().join("trash");
        fs::create_dir_all(root.join("kept")).expect("kept entry");

        for escaping in ["", "../outside", "nested/entry", "..\\outside"] {
            assert!(matches!(
                purge(&root, Some(escaping)),
                Err(CoreError::InvalidInput(_))
            ));
        }
        assert!(matches!(
            purge(&root, Some("absent")),
            Err(CoreError::NotFound(_))
        ));
        assert!(root.join("kept").is_dir());
        assert_eq!(purge(&root, None).expect("purge all"), 1);
        assert_eq!(
            purge(&directory.path().join("absent"), None).expect("no root"),
            0
        );
    }

    #[test]
    fn prepare_restore_target_creates_the_parent_and_refuses_an_occupied_path() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let original = directory.path().join("nested").join("item");
        assert!(matches!(
            prepare_restore_target(&original),
            RestoreTarget::Ready
        ));
        assert!(original.parent().expect("parent").is_dir());

        fs::write(&original, b"occupying").expect("occupying file");
        assert!(matches!(
            prepare_restore_target(&original),
            RestoreTarget::Occupied
        ));
    }
}
