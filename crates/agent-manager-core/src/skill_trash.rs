//! 스킬 휴지통. 스킬 삭제는 주체(사용자 UI·AIA)와 대상(에이전트 스킬·공유 배포본·
//! 공유 원본) 구분 없이 모두 이 모듈을 거쳐 앱 데이터 디렉터리의 휴지통으로
//! 이동하고, 필요하면 원래 경로로 복구할 수 있다.
//!
//! # 구조
//!
//! 저장 구조(`app_data_dir/trash/skills/<항목ID>/`에 manifest와 실체를 두고 manifest를
//! 마지막에 쓰는 순서)는 [`crate::trash_store`]가 지침 휴지통과 함께 소유한다. 이
//! 모듈은 스킬 항목의 모양과 링크 복구만 정한다.
//!
//! 심볼릭 링크 삭제는 링크 자체만 휴지통으로 옮기고 링크 대상(공유 원본)은 절대
//! 옮기지 않는다. 복구 시 링크 실체가 없으면 manifest의 대상 경로로 링크를 다시
//! 만든다.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::domain::ProviderId;
use crate::trash_store::{self, RestoreTarget};
use crate::CoreError;

const TRASH_RELATIVE: &str = "trash/skills";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SkillTrashItemKind {
    /// 스킬 디렉터리 실체.
    Directory,
    /// 공급자 루트에 있던 심볼릭 링크. 대상은 옮기지 않는다.
    Link,
}

impl SkillTrashItemKind {
    pub const ALL: [Self; 2] = [Self::Directory, Self::Link];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Directory => "directory",
            Self::Link => "link",
        }
    }

    /// 디렉터리 실체인지 여부.
    pub fn is_directory(self) -> bool {
        matches!(self, Self::Directory)
    }

    /// 심볼릭 링크인지 여부.
    pub fn is_link(self) -> bool {
        matches!(self, Self::Link)
    }
}

impl std::fmt::Display for SkillTrashItemKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

impl std::str::FromStr for SkillTrashItemKind {
    type Err = CoreError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.trim() {
            "directory" => Ok(Self::Directory),
            "link" => Ok(Self::Link),
            _ => Err(CoreError::InvalidInput(format!(
                "알 수 없는 스킬 휴지통 항목 종류입니다: {s}"
            ))),
        }
    }
}

/// 휴지통 항목 하나. 파일시스템에서 옮긴 실체 하나에 대응한다.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillTrashItem {
    pub id: String,
    /// 공유 스킬 일괄 삭제처럼 함께 지운 항목을 묶는 ID. 복구도 이 단위로 한다.
    pub group_id: String,
    pub key: String,
    pub kind: SkillTrashItemKind,
    /// 삭제 전 절대 경로. 복구 대상 위치다.
    pub original_path: String,
    #[serde(default)]
    pub link_target: Option<String>,
    /// 공급자 설치본이면 해당 공급자, 공유 원본이면 없음.
    #[serde(default)]
    pub provider: Option<ProviderId>,
    #[serde(default)]
    pub scope: Option<String>,
    /// 삭제 시점에 설정된 공유 스킬 저장소에 같은 키가 있었는지.
    pub shared: bool,
    /// 삭제 주체 구분. 감사 로그가 권위 있는 기록이고 이 값은 표시용이다.
    pub deleted_by: String,
    pub deleted_at_ms: i64,
    #[serde(default)]
    pub content_digest: Option<String>,
    #[serde(default)]
    pub file_count: usize,
    #[serde(default)]
    pub total_bytes: u64,
    pub name: String,
    #[serde(default)]
    pub description: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillTrashOverview {
    pub root: String,
    pub items: Vec<SkillTrashItem>,
    pub total_bytes: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SkillTrashRestoreOutcome {
    Restored,
    /// 원래 경로에 이미 다른 항목이 있어 복구하지 않았다.
    Skipped,
    Failed,
}

impl SkillTrashRestoreOutcome {
    pub const ALL: [Self; 3] = [Self::Restored, Self::Skipped, Self::Failed];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Restored => "restored",
            Self::Skipped => "skipped",
            Self::Failed => "failed",
        }
    }

    /// 성공적으로 복구되었는지 여부.
    pub fn is_restored(self) -> bool {
        matches!(self, Self::Restored)
    }

    /// 대상 경로 충돌 등으로 건너뛰었는지 여부.
    pub fn is_skipped(self) -> bool {
        matches!(self, Self::Skipped)
    }

    /// 복구에 실패했는지 여부.
    pub fn is_failed(self) -> bool {
        matches!(self, Self::Failed)
    }
}

impl std::fmt::Display for SkillTrashRestoreOutcome {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

impl std::str::FromStr for SkillTrashRestoreOutcome {
    type Err = CoreError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.trim() {
            "restored" => Ok(Self::Restored),
            "skipped" => Ok(Self::Skipped),
            "failed" => Ok(Self::Failed),
            _ => Err(CoreError::InvalidInput(format!(
                "알 수 없는 스킬 휴지통 복구 결과입니다: {s}"
            ))),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillTrashRestoreResult {
    pub id: String,
    pub key: String,
    pub original_path: String,
    pub outcome: SkillTrashRestoreOutcome,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillTrashRestoreReceipt {
    pub group_id: String,
    pub results: Vec<SkillTrashRestoreResult>,
}

fn trash_root(app_data_dir: &Path) -> PathBuf {
    trash_store::trash_root(app_data_dir, TRASH_RELATIVE)
}

/// 휴지통에 넣기 전에 계산해 둔 항목 정보. 실체 이동은 `store_trash_item`이 한다.
#[derive(Debug, Clone)]
pub(crate) struct SkillTrashItemDraft {
    pub group_id: String,
    pub key: String,
    pub kind: SkillTrashItemKind,
    pub link_target: Option<String>,
    pub provider: Option<ProviderId>,
    pub scope: Option<String>,
    pub shared: bool,
    pub deleted_by: String,
    pub content_digest: Option<String>,
    pub file_count: usize,
    pub total_bytes: u64,
    pub name: String,
    pub description: String,
}

/// 실체(디렉터리 또는 링크)를 휴지통 항목으로 옮긴다. 이동에 성공한 뒤에만
/// manifest를 써서 미완성 항목이 목록에 섞이지 않게 한다.
pub(crate) fn store_trash_item(
    app_data_dir: &Path,
    source: &Path,
    draft: SkillTrashItemDraft,
) -> Result<SkillTrashItem, CoreError> {
    let root = trash_root(app_data_dir);
    let entry = trash_store::begin_entry(&root, &draft.key)?;

    let moved = match draft.kind {
        SkillTrashItemKind::Directory => trash_store::move_path(source, entry.content()),
        SkillTrashItemKind::Link => {
            // 링크는 링크 파일 자체만 옮긴다. rename이 안 되는 환경이면 manifest의
            // 대상 경로로 복구할 수 있으므로 링크를 지우는 것으로 충분하다.
            if fs::rename(source, entry.content()).is_err() {
                fs::remove_file(source).map_err(CoreError::Io)
            } else {
                Ok(())
            }
        }
    };
    if let Err(error) = moved {
        entry.abort();
        return Err(error);
    }

    let item = SkillTrashItem {
        id: entry.id().to_owned(),
        group_id: draft.group_id,
        key: draft.key,
        kind: draft.kind,
        original_path: source.to_string_lossy().into_owned(),
        link_target: draft.link_target,
        provider: draft.provider,
        scope: draft.scope,
        shared: draft.shared,
        deleted_by: draft.deleted_by,
        deleted_at_ms: entry.deleted_at_ms(),
        content_digest: draft.content_digest,
        file_count: draft.file_count,
        total_bytes: draft.total_bytes,
        name: draft.name,
        description: draft.description,
    };
    entry.commit(&item, source)?;
    Ok(item)
}

/// 휴지통 목록. 최근 삭제가 먼저 온다.
pub fn list_skill_trash(app_data_dir: &Path) -> Result<SkillTrashOverview, CoreError> {
    let root = trash_root(app_data_dir);
    let items = trash_store::read_entries::<SkillTrashItem>(&root, |item| item.deleted_at_ms)?;
    let total_bytes = items.iter().map(|item| item.total_bytes).sum();
    Ok(SkillTrashOverview {
        root: root.to_string_lossy().into_owned(),
        items,
        total_bytes,
    })
}

/// 휴지통 항목을 원래 경로로 복구한다. 항목이 그룹에 속하면 같은 그룹 전체를
/// 복구한다. 공유 원본을 먼저 되살려 링크 복구가 끊기지 않게 한다.
pub fn restore_skill_trash(
    app_data_dir: &Path,
    id: &str,
) -> Result<SkillTrashRestoreReceipt, CoreError> {
    let overview = list_skill_trash(app_data_dir)?;
    let (group_id, group) = trash_store::ordered_restore_group(
        &overview.items,
        id,
        |item| &item.id,
        |item| &item.group_id,
        |item| item.provider.is_some(),
        |item| item.deleted_at_ms,
    )?;

    let root = trash_root(app_data_dir);
    let mut results = Vec::new();
    for item in group {
        results.push(restore_single_item(&root, item));
    }
    Ok(SkillTrashRestoreReceipt { group_id, results })
}

fn restore_single_item(trash_root: &Path, item: &SkillTrashItem) -> SkillTrashRestoreResult {
    let original = PathBuf::from(&item.original_path);
    let result = |outcome, message: Option<String>| SkillTrashRestoreResult {
        id: item.id.clone(),
        key: item.key.clone(),
        original_path: item.original_path.clone(),
        outcome,
        message,
    };

    match trash_store::prepare_restore_target(&original) {
        RestoreTarget::Ready => {}
        RestoreTarget::Occupied => {
            return result(
                SkillTrashRestoreOutcome::Skipped,
                Some("원래 경로에 이미 항목이 있어 덮어쓰지 않았습니다".to_owned()),
            )
        }
        RestoreTarget::ParentFailed(message) => {
            return result(SkillTrashRestoreOutcome::Failed, Some(message))
        }
    }

    let (entry_dir, content) = trash_store::entry_paths(trash_root, &item.id);
    let restored = if fs::symlink_metadata(&content).is_ok() {
        trash_store::move_path(&content, &original)
    } else if item.kind.is_link() {
        // 링크 실체를 옮기지 못한 채 지운 항목은 manifest의 대상 경로로 다시 만든다.
        match &item.link_target {
            Some(target) => trash_store::create_symlink(Path::new(target), &original),
            None => Err(CoreError::InvalidInput(
                "링크 대상 정보가 없어 복구할 수 없습니다".to_owned(),
            )),
        }
    } else {
        Err(CoreError::InvalidInput(
            "휴지통에 실체가 없어 복구할 수 없습니다".to_owned(),
        ))
    };

    match restored {
        Ok(()) => {
            let _ = fs::remove_dir_all(&entry_dir);
            result(SkillTrashRestoreOutcome::Restored, None)
        }
        Err(error) => result(SkillTrashRestoreOutcome::Failed, Some(error.to_string())),
    }
}

/// 휴지통 비우기. `id`가 있으면 해당 항목만, 없으면 전체를 지운다. 지운 항목 수를
/// 돌려준다.
pub fn purge_skill_trash(app_data_dir: &Path, id: Option<&str>) -> Result<usize, CoreError> {
    trash_store::purge(&trash_root(app_data_dir), id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn skill_trash_item_kind_display_and_from_str_round_trip() {
        assert_eq!(
            SkillTrashItemKind::ALL,
            [SkillTrashItemKind::Directory, SkillTrashItemKind::Link]
        );
        for kind in SkillTrashItemKind::ALL {
            assert_eq!(kind.to_string(), kind.as_str());
            assert_eq!(kind.as_str().parse::<SkillTrashItemKind>().unwrap(), kind);
            // serde_json 직렬화 및 역직렬화 라운드트립 검증
            let serialized = serde_json::to_string(&kind).unwrap();
            assert_eq!(serialized, format!("\"{}\"", kind.as_str()));
            let deserialized: SkillTrashItemKind = serde_json::from_str(&serialized).unwrap();
            assert_eq!(deserialized, kind);
        }
        assert_eq!(
            "  directory  ".parse::<SkillTrashItemKind>().unwrap(),
            SkillTrashItemKind::Directory
        );
        assert_eq!(
            "  link  ".parse::<SkillTrashItemKind>().unwrap(),
            SkillTrashItemKind::Link
        );
        assert!(matches!(
            "invalid".parse::<SkillTrashItemKind>(),
            Err(CoreError::InvalidInput(_))
        ));
        assert!(SkillTrashItemKind::Directory.is_directory());
        assert!(!SkillTrashItemKind::Directory.is_link());
        assert!(SkillTrashItemKind::Link.is_link());
        assert!(!SkillTrashItemKind::Link.is_directory());
    }

    #[test]
    fn skill_trash_restore_outcome_display_and_from_str_round_trip() {
        assert_eq!(
            SkillTrashRestoreOutcome::ALL,
            [
                SkillTrashRestoreOutcome::Restored,
                SkillTrashRestoreOutcome::Skipped,
                SkillTrashRestoreOutcome::Failed,
            ]
        );
        for outcome in SkillTrashRestoreOutcome::ALL {
            assert_eq!(outcome.to_string(), outcome.as_str());
            assert_eq!(
                outcome
                    .as_str()
                    .parse::<SkillTrashRestoreOutcome>()
                    .unwrap(),
                outcome
            );
            // serde_json 직렬화 및 역직렬화 라운드트립 검증
            let serialized = serde_json::to_string(&outcome).unwrap();
            assert_eq!(serialized, format!("\"{}\"", outcome.as_str()));
            let deserialized: SkillTrashRestoreOutcome = serde_json::from_str(&serialized).unwrap();
            assert_eq!(deserialized, outcome);
        }
        assert_eq!(
            "  restored  ".parse::<SkillTrashRestoreOutcome>().unwrap(),
            SkillTrashRestoreOutcome::Restored
        );
        assert_eq!(
            "  skipped  ".parse::<SkillTrashRestoreOutcome>().unwrap(),
            SkillTrashRestoreOutcome::Skipped
        );
        assert_eq!(
            "  failed  ".parse::<SkillTrashRestoreOutcome>().unwrap(),
            SkillTrashRestoreOutcome::Failed
        );
        assert!(matches!(
            "invalid".parse::<SkillTrashRestoreOutcome>(),
            Err(CoreError::InvalidInput(_))
        ));
        assert!(SkillTrashRestoreOutcome::Restored.is_restored());
        assert!(!SkillTrashRestoreOutcome::Restored.is_skipped());
        assert!(!SkillTrashRestoreOutcome::Restored.is_failed());
        assert!(SkillTrashRestoreOutcome::Skipped.is_skipped());
        assert!(!SkillTrashRestoreOutcome::Skipped.is_restored());
        assert!(!SkillTrashRestoreOutcome::Skipped.is_failed());
        assert!(SkillTrashRestoreOutcome::Failed.is_failed());
        assert!(!SkillTrashRestoreOutcome::Failed.is_restored());
        assert!(!SkillTrashRestoreOutcome::Failed.is_skipped());
    }

    #[test]
    fn skill_trash_lifecycle_and_restore() {
        let temp = tempdir().expect("임시 디렉터리 생성");
        let app_data = temp.path().join("app_data");
        let source_root = temp.path().join("skills");
        let skill_dir = source_root.join("my-skill");
        fs::create_dir_all(&skill_dir).expect("스킬 디렉터리 생성");
        fs::write(skill_dir.join("SKILL.md"), "test skill").expect("스킬 파일 작성");

        let draft = SkillTrashItemDraft {
            group_id: "group-1".to_owned(),
            key: "my-skill".to_owned(),
            kind: SkillTrashItemKind::Directory,
            link_target: None,
            provider: None,
            scope: None,
            shared: true,
            deleted_by: "user".to_owned(),
            content_digest: None,
            file_count: 1,
            total_bytes: 10,
            name: "my-skill".to_owned(),
            description: "test".to_owned(),
        };

        let item = store_trash_item(&app_data, &skill_dir, draft).expect("휴지통 보관");
        assert_eq!(item.kind, SkillTrashItemKind::Directory);
        assert!(item.kind.is_directory());
        assert!(!skill_dir.exists());

        let list = list_skill_trash(&app_data).expect("휴지통 목록");
        assert_eq!(list.items.len(), 1);
        assert_eq!(list.items[0].id, item.id);

        let receipt = restore_skill_trash(&app_data, &item.id).expect("복구");
        assert_eq!(receipt.results.len(), 1);
        assert!(receipt.results[0].outcome.is_restored());
        assert!(skill_dir.join("SKILL.md").exists());

        // 이미 복구되어 휴지통에 없는 항목 복구 시도 시 에러
        let receipt_missing = restore_skill_trash(&app_data, &item.id);
        assert!(receipt_missing.is_err());

        // 다시 보관 후 동일 경로에 실체가 이미 있어 충돌하는 경우
        let draft2 = SkillTrashItemDraft {
            group_id: "group-2".to_owned(),
            key: "my-skill".to_owned(),
            kind: SkillTrashItemKind::Directory,
            link_target: None,
            provider: None,
            scope: None,
            shared: true,
            deleted_by: "user".to_owned(),
            content_digest: None,
            file_count: 1,
            total_bytes: 10,
            name: "my-skill".to_owned(),
            description: "test".to_owned(),
        };
        let item2 = store_trash_item(&app_data, &skill_dir, draft2).expect("휴지통 재보관");
        // 동일 위치에 파일 생성하여 충돌 유도
        fs::write(&skill_dir, "conflict").expect("충돌 파일 생성");

        let receipt_conflict = restore_skill_trash(&app_data, &item2.id).expect("복구 시도");
        assert_eq!(receipt_conflict.results.len(), 1);
        assert!(receipt_conflict.results[0].outcome.is_skipped());

        // 휴지통 비우기
        let purged = purge_skill_trash(&app_data, None).expect("휴지통 비우기");
        assert_eq!(purged, 1);
        let list_after = list_skill_trash(&app_data).expect("비운 후 목록");
        assert!(list_after.items.is_empty());
    }
}
