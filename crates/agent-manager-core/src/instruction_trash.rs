//! 프로젝트 지침 휴지통. 지침 삭제는 대상(프로젝트 배포 파일·공통 원본) 구분
//! 없이 모두 이 모듈을 거쳐 앱 데이터 디렉터리의 휴지통으로 이동하고, 필요하면
//! 원래 경로로 복구할 수 있다. 구조는 스킬 휴지통과 같되 배포본이 디렉터리가
//! 아니라 단일 파일이므로 항목 종류에 File을 둔다.
//!
//! 저장 구조(`app_data_dir/trash/instructions/<항목ID>/`에 manifest와 실체를 두고
//! manifest를 마지막에 쓰는 순서)는 [`crate::trash_store`]가 스킬 휴지통과 함께
//! 소유한다. 이 모듈은 지침 항목의 모양과 복구 뒤 배포 원장 되돌리기만 정한다.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::domain::ProviderId;
use crate::trash_store::{self, RestoreTarget};
use crate::CoreError;

const TRASH_RELATIVE: &str = "trash/instructions";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum InstructionTrashItemKind {
    /// 공통 원본 디렉터리 실체.
    Directory,
    /// 프로젝트에 배포되어 있던 지침 파일 하나.
    File,
}

impl InstructionTrashItemKind {
    pub const ALL: [Self; 2] = [Self::Directory, Self::File];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Directory => "directory",
            Self::File => "file",
        }
    }

    /// 디렉터리 실체인지 여부.
    pub fn is_directory(self) -> bool {
        matches!(self, Self::Directory)
    }

    /// 파일 실체인지 여부.
    pub fn is_file(self) -> bool {
        matches!(self, Self::File)
    }
}

impl std::fmt::Display for InstructionTrashItemKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

impl std::str::FromStr for InstructionTrashItemKind {
    type Err = CoreError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.trim() {
            "directory" => Ok(Self::Directory),
            "file" => Ok(Self::File),
            _ => Err(CoreError::InvalidInput(format!(
                "알 수 없는 지침 휴지통 항목 종류입니다: {s}"
            ))),
        }
    }
}

/// 휴지통 항목 하나. 파일시스템에서 옮긴 실체 하나에 대응한다.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstructionTrashItem {
    pub id: String,
    /// 공통 원본 일괄 삭제처럼 함께 지운 항목을 묶는 ID. 복구도 이 단위로 한다.
    pub group_id: String,
    pub key: String,
    pub kind: InstructionTrashItemKind,
    /// 삭제 전 절대 경로. 복구 대상 위치다.
    pub original_path: String,
    /// 프로젝트 배포 파일이면 해당 공급자, 공통 원본이면 없음.
    #[serde(default)]
    pub provider: Option<ProviderId>,
    /// 배포 파일 위치 구분("personal" | "project"). 공통 원본이면 없음.
    #[serde(default)]
    pub scope: Option<String>,
    /// 배포 파일이 있던 디렉터리. personal이면 공급자 홈 설정 디렉터리다.
    #[serde(default)]
    pub project_path: Option<String>,
    /// 삭제 시점에 공통 저장소에 같은 키의 원본이 있었는지.
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
pub struct InstructionTrashOverview {
    pub root: String,
    pub items: Vec<InstructionTrashItem>,
    pub total_bytes: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum InstructionTrashRestoreOutcome {
    Restored,
    /// 원래 경로에 이미 다른 항목이 있어 복구하지 않았다.
    Skipped,
    Failed,
}

impl InstructionTrashRestoreOutcome {
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

impl std::fmt::Display for InstructionTrashRestoreOutcome {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

impl std::str::FromStr for InstructionTrashRestoreOutcome {
    type Err = CoreError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.trim() {
            "restored" => Ok(Self::Restored),
            "skipped" => Ok(Self::Skipped),
            "failed" => Ok(Self::Failed),
            _ => Err(CoreError::InvalidInput(format!(
                "알 수 없는 지침 휴지통 복구 결과입니다: {s}"
            ))),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstructionTrashRestoreResult {
    pub id: String,
    pub key: String,
    pub original_path: String,
    pub outcome: InstructionTrashRestoreOutcome,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstructionTrashRestoreReceipt {
    pub group_id: String,
    pub results: Vec<InstructionTrashRestoreResult>,
}

fn trash_root(app_data_dir: &Path) -> PathBuf {
    trash_store::trash_root(app_data_dir, TRASH_RELATIVE)
}

/// 휴지통에 넣기 전에 계산해 둔 항목 정보. 실체 이동은 `store_instruction_trash_item`이 한다.
#[derive(Debug, Clone)]
pub(crate) struct InstructionTrashItemDraft {
    pub group_id: String,
    pub key: String,
    pub kind: InstructionTrashItemKind,
    pub provider: Option<ProviderId>,
    pub scope: Option<String>,
    pub project_path: Option<String>,
    pub shared: bool,
    pub deleted_by: String,
    pub content_digest: Option<String>,
    pub file_count: usize,
    pub total_bytes: u64,
    pub name: String,
    pub description: String,
}

/// 실체(디렉터리 또는 파일)를 휴지통 항목으로 옮긴다. 이동에 성공한 뒤에만
/// manifest를 써서 미완성 항목이 목록에 섞이지 않게 한다.
pub(crate) fn store_instruction_trash_item(
    app_data_dir: &Path,
    source: &Path,
    draft: InstructionTrashItemDraft,
) -> Result<InstructionTrashItem, CoreError> {
    let root = trash_root(app_data_dir);
    let entry = trash_store::begin_entry(&root, &draft.key)?;

    if let Err(error) = trash_store::move_path(source, entry.content()) {
        entry.abort();
        return Err(error);
    }

    let item = InstructionTrashItem {
        id: entry.id().to_owned(),
        group_id: draft.group_id,
        key: draft.key,
        kind: draft.kind,
        original_path: source.to_string_lossy().into_owned(),
        provider: draft.provider,
        scope: draft.scope,
        project_path: draft.project_path,
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
pub fn list_instruction_trash(app_data_dir: &Path) -> Result<InstructionTrashOverview, CoreError> {
    let root = trash_root(app_data_dir);
    let items =
        trash_store::read_entries::<InstructionTrashItem>(&root, |item| item.deleted_at_ms)?;
    let total_bytes = items.iter().map(|item| item.total_bytes).sum();
    Ok(InstructionTrashOverview {
        root: root.to_string_lossy().into_owned(),
        items,
        total_bytes,
    })
}

/// 휴지통 항목을 원래 경로로 복구한다. 항목이 그룹에 속하면 같은 그룹 전체를
/// 복구한다. 공통 원본(provider 없음)을 먼저 되살린다.
pub fn restore_instruction_trash(
    app_data_dir: &Path,
    id: &str,
) -> Result<InstructionTrashRestoreReceipt, CoreError> {
    let overview = list_instruction_trash(app_data_dir)?;
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
        let result = restore_single_item(&root, item);
        // 되살린 배포 지침 파일은 배포 원장에도 되돌려야 이후 편집이 이 위치를 함께 갱신한다.
        if result.outcome.is_restored() {
            readopt_restored_instruction_deployment(app_data_dir, item);
        }
        results.push(result);
    }
    Ok(InstructionTrashRestoreReceipt { group_id, results })
}

/// 배포 지침 파일 항목이면 원장에 다시 올린다. 연결 문서와 공통 원본 디렉터리는
/// 대상이 아니다(원본을 되살리면 원장은 이관에서 다시 채워진다).
fn readopt_restored_instruction_deployment(app_data_dir: &Path, item: &InstructionTrashItem) {
    if !item.kind.is_file() || !item.shared {
        return;
    }
    let (Some(provider), Some(scope), Some(project_path)) = (
        item.provider,
        item.scope.as_deref(),
        item.project_path.as_deref(),
    ) else {
        return;
    };
    let original = Path::new(&item.original_path);
    if original.file_name() != Some(std::ffi::OsStr::new(&item.name)) {
        // 연결 문서는 상대 경로가 이름이라 지침 파일과 구분된다.
        return;
    }
    crate::project_instructions::readopt_restored_deployment(
        app_data_dir,
        &item.key,
        provider,
        scope,
        Path::new(project_path),
    );
}

fn restore_single_item(
    trash_root: &Path,
    item: &InstructionTrashItem,
) -> InstructionTrashRestoreResult {
    let original = PathBuf::from(&item.original_path);
    let result = |outcome, message: Option<String>| InstructionTrashRestoreResult {
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
                InstructionTrashRestoreOutcome::Skipped,
                Some("원래 경로에 이미 항목이 있어 덮어쓰지 않았습니다".to_owned()),
            )
        }
        RestoreTarget::ParentFailed(message) => {
            return result(InstructionTrashRestoreOutcome::Failed, Some(message))
        }
    }

    let (entry_dir, content) = trash_store::entry_paths(trash_root, &item.id);
    if fs::symlink_metadata(&content).is_err() {
        return result(
            InstructionTrashRestoreOutcome::Failed,
            Some("휴지통에 실체가 없어 복구할 수 없습니다".to_owned()),
        );
    }
    match trash_store::move_path(&content, &original) {
        Ok(()) => {
            let _ = fs::remove_dir_all(&entry_dir);
            result(InstructionTrashRestoreOutcome::Restored, None)
        }
        Err(error) => result(
            InstructionTrashRestoreOutcome::Failed,
            Some(error.to_string()),
        ),
    }
}

/// 휴지통 비우기. `id`가 있으면 해당 항목만, 없으면 전체를 지운다. 지운 항목 수를
/// 돌려준다.
pub fn purge_instruction_trash(app_data_dir: &Path, id: Option<&str>) -> Result<usize, CoreError> {
    trash_store::purge(&trash_root(app_data_dir), id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn instruction_trash_item_kind_display_and_from_str_round_trip() {
        assert_eq!(
            InstructionTrashItemKind::ALL,
            [
                InstructionTrashItemKind::Directory,
                InstructionTrashItemKind::File
            ]
        );
        for kind in InstructionTrashItemKind::ALL {
            assert_eq!(kind.to_string(), kind.as_str());
            assert_eq!(
                kind.as_str().parse::<InstructionTrashItemKind>().unwrap(),
                kind
            );
            // serde_json 직렬화 및 역직렬화 라운드트립 검증
            let serialized = serde_json::to_string(&kind).unwrap();
            assert_eq!(serialized, format!("\"{}\"", kind.as_str()));
            let deserialized: InstructionTrashItemKind = serde_json::from_str(&serialized).unwrap();
            assert_eq!(deserialized, kind);
        }
        assert_eq!(
            "  directory  ".parse::<InstructionTrashItemKind>().unwrap(),
            InstructionTrashItemKind::Directory
        );
        assert_eq!(
            "  file  ".parse::<InstructionTrashItemKind>().unwrap(),
            InstructionTrashItemKind::File
        );
        assert!(matches!(
            "invalid".parse::<InstructionTrashItemKind>(),
            Err(CoreError::InvalidInput(_))
        ));
        assert!(InstructionTrashItemKind::Directory.is_directory());
        assert!(!InstructionTrashItemKind::Directory.is_file());
        assert!(InstructionTrashItemKind::File.is_file());
        assert!(!InstructionTrashItemKind::File.is_directory());
    }

    #[test]
    fn instruction_trash_restore_outcome_display_and_from_str_round_trip() {
        assert_eq!(
            InstructionTrashRestoreOutcome::ALL,
            [
                InstructionTrashRestoreOutcome::Restored,
                InstructionTrashRestoreOutcome::Skipped,
                InstructionTrashRestoreOutcome::Failed,
            ]
        );
        for outcome in InstructionTrashRestoreOutcome::ALL {
            assert_eq!(outcome.to_string(), outcome.as_str());
            assert_eq!(
                outcome
                    .as_str()
                    .parse::<InstructionTrashRestoreOutcome>()
                    .unwrap(),
                outcome
            );
            // serde_json 직렬화 및 역직렬화 라운드트립 검증
            let serialized = serde_json::to_string(&outcome).unwrap();
            assert_eq!(serialized, format!("\"{}\"", outcome.as_str()));
            let deserialized: InstructionTrashRestoreOutcome =
                serde_json::from_str(&serialized).unwrap();
            assert_eq!(deserialized, outcome);
        }
        assert_eq!(
            "  restored  "
                .parse::<InstructionTrashRestoreOutcome>()
                .unwrap(),
            InstructionTrashRestoreOutcome::Restored
        );
        assert_eq!(
            "  skipped  "
                .parse::<InstructionTrashRestoreOutcome>()
                .unwrap(),
            InstructionTrashRestoreOutcome::Skipped
        );
        assert_eq!(
            "  failed  "
                .parse::<InstructionTrashRestoreOutcome>()
                .unwrap(),
            InstructionTrashRestoreOutcome::Failed
        );
        assert!(matches!(
            "invalid".parse::<InstructionTrashRestoreOutcome>(),
            Err(CoreError::InvalidInput(_))
        ));
        assert!(InstructionTrashRestoreOutcome::Restored.is_restored());
        assert!(!InstructionTrashRestoreOutcome::Restored.is_skipped());
        assert!(!InstructionTrashRestoreOutcome::Restored.is_failed());
        assert!(InstructionTrashRestoreOutcome::Skipped.is_skipped());
        assert!(!InstructionTrashRestoreOutcome::Skipped.is_restored());
        assert!(!InstructionTrashRestoreOutcome::Skipped.is_failed());
        assert!(InstructionTrashRestoreOutcome::Failed.is_failed());
        assert!(!InstructionTrashRestoreOutcome::Failed.is_restored());
        assert!(!InstructionTrashRestoreOutcome::Failed.is_skipped());
    }

    #[test]
    fn instruction_trash_lifecycle_and_restore() {
        let temp = tempdir().expect("임시 디렉터리 생성");
        let app_data = temp.path().join("app_data");
        let instructions_root = temp.path().join("instructions");
        let policy_dir = instructions_root.join("my-policy");
        fs::create_dir_all(&policy_dir).expect("지침 디렉터리 생성");
        fs::write(policy_dir.join("AGENTS.md"), "test agents policy").expect("지침 파일 작성");

        let draft = InstructionTrashItemDraft {
            group_id: "group-inst-1".to_owned(),
            key: "my-policy".to_owned(),
            kind: InstructionTrashItemKind::Directory,
            provider: None,
            scope: None,
            project_path: None,
            shared: true,
            deleted_by: "user".to_owned(),
            content_digest: None,
            file_count: 1,
            total_bytes: 18,
            name: "my-policy".to_owned(),
            description: "test policy".to_owned(),
        };

        let item =
            store_instruction_trash_item(&app_data, &policy_dir, draft).expect("지침 휴지통 보관");
        assert_eq!(item.kind, InstructionTrashItemKind::Directory);
        assert!(item.kind.is_directory());
        assert!(!policy_dir.exists());

        let list = list_instruction_trash(&app_data).expect("지침 휴지통 목록");
        assert_eq!(list.items.len(), 1);
        assert_eq!(list.items[0].id, item.id);

        let receipt = restore_instruction_trash(&app_data, &item.id).expect("지침 복구");
        assert_eq!(receipt.results.len(), 1);
        assert!(receipt.results[0].outcome.is_restored());
        assert!(policy_dir.join("AGENTS.md").exists());

        // 이미 복구되어 휴지통에 없는 항목 복구 시도 시 에러
        let receipt_missing = restore_instruction_trash(&app_data, &item.id);
        assert!(receipt_missing.is_err());

        // 파일 항목 보관 및 충돌 시 skipped 테스트
        let single_file = temp.path().join("AGENTS.md");
        fs::write(&single_file, "single file policy").expect("단일 파일 작성");

        let draft_file = InstructionTrashItemDraft {
            group_id: "group-inst-2".to_owned(),
            key: "single-file".to_owned(),
            kind: InstructionTrashItemKind::File,
            provider: None,
            scope: None,
            project_path: None,
            shared: false,
            deleted_by: "user".to_owned(),
            content_digest: None,
            file_count: 1,
            total_bytes: 18,
            name: "AGENTS.md".to_owned(),
            description: "single file".to_owned(),
        };
        let file_item = store_instruction_trash_item(&app_data, &single_file, draft_file)
            .expect("파일 휴지통 보관");
        assert!(file_item.kind.is_file());
        assert!(!single_file.exists());

        // 원래 경로에 파일 새로 생성하여 복구 충돌 유도
        fs::write(&single_file, "conflict file").expect("충돌 파일 생성");
        let receipt_conflict =
            restore_instruction_trash(&app_data, &file_item.id).expect("복구 시도");
        assert_eq!(receipt_conflict.results.len(), 1);
        assert!(receipt_conflict.results[0].outcome.is_skipped());

        // 휴지통 비우기
        let purged = purge_instruction_trash(&app_data, None).expect("휴지통 비우기");
        assert_eq!(purged, 1);
        let list_after = list_instruction_trash(&app_data).expect("비운 후 목록");
        assert!(list_after.items.is_empty());
    }
}
