//! 프로젝트 에이전트 지침을 공통 저장소에 보관하고 등록 프로젝트에 게시한다.
//!
//! 공통 원본은 `resource-repository/instructions/<key>` 아래에 공급자별 지침 파일을
//! 보관한다. 프로젝트 목록은 공급자 한 곳의 별도 설정이 아니라 실제 세션의 cwd를
//! 기준으로 만들며, 게시 대상은 그 목록과 정확히 일치하는 프로젝트만 허용한다.
//! 지침은 `@경로` 가져오기로 다른 문서를 함께 읽게 하므로, 보관과 게시는 그 연결
//! 문서까지 한 세트로 다룬다. 배포 위치 안의 상대 경로 링크를 재귀로 따라가 같은
//! 상대 경로로 보관하고, 위치에 매인 링크(`~/`, 절대 경로)는 뜻이 달라지므로 보관
//! 하지 않고 이유를 남긴다. 쓰기는 같은 디렉터리의 임시 파일/백업을 거친 rename으로
//! 기존 파일이 반쯤 바뀌는 일을 막고, 연결 문서를 먼저 쓰고 지침 파일을 마지막에
//! 써서 중간에 실패해도 없는 문서를 가리키는 지침이 남지 않게 한다.

use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::fs;
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use unicode_normalization::UnicodeNormalization;

use crate::domain::{ProviderId, SessionSummary};
use crate::file_kind::{
    ensure_directory, ensure_regular_file, ensure_within_limit, regular_file_metadata,
};
use crate::instruction_links::local_document_links;
use crate::instruction_trash::{
    restore_instruction_trash, store_instruction_trash_item, InstructionTrashItem,
    InstructionTrashItemDraft, InstructionTrashItemKind,
};
use crate::linked_file::{self, LinkedFile, LinkedFileDownload};
use crate::path_guard::{self, CurDirPolicy, RootLabels};
use crate::resource_repository::{
    load_resource_manifest, repository_instructions_root, resource_manifest_path,
    validate_platform_variant_path, validate_variant_relative_path, HostPlatform,
    ResourcePlatformManifest,
};
use crate::skill_library::SkillOverwritePolicy;
use crate::staged_replace::{StagedKind, StagedReplace};
use crate::trash_store::new_trash_group_id;
use crate::user_home::home_dir;
use crate::CoreError;

const LIBRARY_SCHEMA_VERSION: u32 = 1;
const INSTRUCTION_META_RELATIVE: &str = ".agent-manager/instruction.json";
const MAX_INSTRUCTION_KEY_CHARS: usize = 64;
const MAX_INSTRUCTION_NAME_CHARS: usize = 120;
const MAX_INSTRUCTION_DESCRIPTION_CHARS: usize = 1_024;
const MAX_INSTRUCTION_FILE_BYTES: u64 = 2 * 1024 * 1024;
const MAX_INSTRUCTION_TOTAL_BYTES: u64 = 8 * 1024 * 1024;
const STAGE_PREFIX: &str = ".agent-manager-instruction-stage-";
const BACKUP_PREFIX: &str = ".agent-manager-instruction-backup-";
const PROVIDERS: [ProviderId; 3] = ProviderId::ALL;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectInstructionLibrary {
    pub schema_version: u32,
    pub common_root: String,
    pub common_root_present: bool,
    pub current_platform: HostPlatform,
    pub projects: Vec<String>,
    pub entries: Vec<ProjectInstructionEntry>,
    /// 등록 프로젝트에서 발견한 현재 지침. 공통 원본이 하나도 없어도 가져오기
    /// 화면이 기존 지침을 보여줄 수 있도록 원본별 배포 상태와 별도로 제공한다.
    pub deployments: Vec<ProjectInstructionDeployment>,
    pub issues: Vec<ProjectInstructionIssue>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectInstructionEntry {
    pub key: String,
    pub name: String,
    pub description: String,
    pub directory: String,
    pub source_digest: String,
    pub providers: Vec<ProviderId>,
    pub platforms: Vec<HostPlatform>,
    pub current_platform_supported: bool,
    pub current_platform_variant: Option<String>,
    /// 외부 수정 감지 시 그 버전을 자동으로 원본에 반영하고 재배포할지. 장치별
    /// 설정이라 공통 저장소가 아닌 앱 데이터 메타에 있다.
    pub auto_sync: bool,
    /// 지침과 함께 보관한 연결 문서(원본 루트 기준 상대 경로). 게시하면 배포 위치의
    /// 같은 상대 경로로 함께 간다.
    pub linked_files: Vec<String>,
    pub deployments: Vec<ProjectInstructionDeployment>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum InstructionPublishOutcome {
    /// 새로 게시했다.
    Published,
    /// 기존 배포본을 교체했다.
    Replaced,
    /// 이미 같은 내용이라 바꾸지 않았다.
    Unchanged,
    /// 게시하지 않았다. 이유는 link issues 등에 있다.
    Skipped,
    /// 배포 작업 중 오류가 발생했다.
    Failed,
}

impl InstructionPublishOutcome {
    pub const ALL: [Self; 5] = [
        Self::Published,
        Self::Replaced,
        Self::Unchanged,
        Self::Skipped,
        Self::Failed,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Published => "published",
            Self::Replaced => "replaced",
            Self::Unchanged => "unchanged",
            Self::Skipped => "skipped",
            Self::Failed => "failed",
        }
    }

    /// 신규 게시 결과인지 여부.
    pub fn is_published(self) -> bool {
        matches!(self, Self::Published)
    }

    /// 기존 교체 게시 결과인지 여부.
    pub fn is_replaced(self) -> bool {
        matches!(self, Self::Replaced)
    }

    /// 내용 불변 유지 결과인지 여부.
    pub fn is_unchanged(self) -> bool {
        matches!(self, Self::Unchanged)
    }

    /// 건너뜀 결과인지 여부.
    pub fn is_skipped(self) -> bool {
        matches!(self, Self::Skipped)
    }

    /// 실패 결과인지 여부.
    pub fn is_failed(self) -> bool {
        matches!(self, Self::Failed)
    }

    /// 배포가 정상적으로 완료되거나 유지된 성공 상태인지 여부.
    pub fn is_successful(self) -> bool {
        matches!(self, Self::Published | Self::Replaced | Self::Unchanged)
    }
}

impl std::fmt::Display for InstructionPublishOutcome {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

impl std::str::FromStr for InstructionPublishOutcome {
    type Err = CoreError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.trim() {
            "published" => Ok(Self::Published),
            "replaced" => Ok(Self::Replaced),
            "unchanged" => Ok(Self::Unchanged),
            "skipped" => Ok(Self::Skipped),
            "failed" => Ok(Self::Failed),
            _ => Err(CoreError::InvalidInput(format!(
                "알 수 없는 지침 게시 결과입니다: {s}. published|replaced|unchanged|skipped|failed 중 하나를 쓰세요"
            ))),
        }
    }
}

/// 함께 보관하지 못한 링크. 화면이 이유를 그대로 보여 사람이 판단하게 한다.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstructionLinkIssue {
    /// 링크를 만난 문서의 배포 루트 기준 상대 경로. 지침 파일 자신이면 빈 문자열이다.
    pub source: String,
    pub href: String,
    pub reason: String,
}

/// 연결 문서 하나의 게시 결과.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstructionLinkedFileResult {
    pub relative: String,
    pub outcome: InstructionPublishOutcome,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectInstructionDeployment {
    pub provider: ProviderId,
    /// "personal"(공급자 홈 설정 디렉터리) | "project"(등록 프로젝트 루트).
    pub scope: String,
    /// 파일이 놓이는 디렉터리. personal이면 공급자 설정 디렉터리다.
    pub project_path: String,
    pub file_path: String,
    pub present: bool,
    /// 이 위치가 이 원본의 배포로 원장에 기록되어 있는지. 지침 파일 이름은 공급자당
    /// 하나로 고정이라 파일이 있다는 사실만으로는 우리가 배포한 것인지 알 수 없다.
    /// 비교·재배포·삭제는 모두 이 값이 참인 위치만 대상으로 한다.
    pub managed: bool,
    pub content_digest: Option<String>,
    pub source_digest: Option<String>,
    /// 지침 파일과 연결 문서를 한 세트로 본 결과. 연결 문서만 달라도 참이다.
    /// 원장에 없는 위치는 비교 대상이 아니라 항상 거짓이다.
    pub divergent: bool,
    /// 원본이 함께 보관한 연결 문서(배포 루트 기준 상대 경로).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub linked_files: Vec<String>,
    /// 배포 위치에 없는 연결 문서.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub linked_missing: Vec<String>,
    /// 배포 위치에서 내용이 달라진 연결 문서.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub linked_changed: Vec<String>,
    /// 배포된 지침이 참조하는데 원본에는 없는 연결 문서. 연결 문서를 함께 보관하기
    /// 전에 만든 원본이 여기 걸리고, 동기화하면 세트가 채워진다.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub linked_unarchived: Vec<String>,
    /// 함께 보관하지 못한 링크. 정보이므로 세트 판정에는 넣지 않는다.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub link_issues: Vec<InstructionLinkIssue>,
    /// 게시에서 연결 문서별 결과.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub linked_results: Vec<InstructionLinkedFileResult>,
    /// 배포 위치의 세트(지침 파일 + 연결 문서) 지문. 두 위치가 같은 수정을 갖고
    /// 있는지 비교해야 자동 동기화가 어느 쪽을 채택할지 판단할 수 있다.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub set_digest: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub outcome: Option<InstructionPublishOutcome>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

impl ProjectInstructionDeployment {
    /// 이 위치의 게시를 여기서 끝낸다. 게시 경로는 어느 단계에서 걸리든 배포 행에
    /// 결과와 사유를 적어 그대로 결과 목록에 싣는 모양이 같아서 한 곳에 둔다.
    fn concluded(mut self, outcome: InstructionPublishOutcome, message: String) -> Self {
        self.outcome = Some(outcome);
        self.message = Some(message);
        self
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectInstructionIssue {
    pub provider: Option<ProviderId>,
    pub path: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstructionProviderFileWrite {
    pub provider: ProviderId,
    pub content: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateProjectInstructionRequest {
    pub key: String,
    pub name: String,
    pub description: String,
    pub files: Vec<InstructionProviderFileWrite>,
    #[serde(default)]
    pub platforms: Vec<HostPlatform>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportProjectInstructionRequest {
    pub key: String,
    /// "personal"이면 projectPath 없이 공급자 홈 설정 파일을 가져온다.
    #[serde(default)]
    pub scope: Option<String>,
    #[serde(default)]
    pub project_path: Option<String>,
    pub provider: ProviderId,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    /// 함께 보관할 연결 문서(배포 루트 기준 상대 경로). 비우면 링크를 따라가 찾은
    /// 문서를 모두 보관한다. 화면에서 트리로 고른 문서만 담고 싶을 때 채운다.
    #[serde(default)]
    pub linked_files: Option<Vec<String>>,
}

/// 가져오기 전에 그 지침이 링크로 끌고 오는 문서를 미리 본다. 파일을 쓰지 않는
/// 읽기 작업이라 화면이 트리를 그리며 고를 수 있게 한다.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstructionImportPreviewRequest {
    /// "personal"이면 projectPath 없이 공급자 홈 설정 파일을 본다.
    #[serde(default)]
    pub scope: Option<String>,
    #[serde(default)]
    pub project_path: Option<String>,
    pub provider: ProviderId,
}

/// 미리보기에서 본 연결 문서 하나.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstructionImportLinkedDoc {
    /// 배포 루트 기준 상대 경로. 그대로 가져오기 선택 값이 된다.
    pub relative: String,
    /// 이 문서를 링크한 문서의 상대 경로. 지침 파일 자신이면 빈 문자열이다.
    pub source: String,
    pub size_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstructionImportPreview {
    pub scope: String,
    pub project_path: String,
    pub provider: ProviderId,
    pub file_path: String,
    pub size_bytes: u64,
    pub linked_docs: Vec<InstructionImportLinkedDoc>,
    /// 함께 보관할 수 없는 링크. 이유를 그대로 보여 사람이 판단하게 한다.
    pub link_issues: Vec<InstructionLinkIssue>,
    /// 지침 파일과 연결 문서를 전부 담았을 때의 바이트 합.
    pub total_bytes: u64,
    /// 원본 한 세트가 담을 수 있는 바이트 한도.
    pub max_total_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishProjectInstructionRequest {
    pub key: String,
    /// "personal"이면 projectPath 없이 공급자 홈 설정 파일로 게시한다.
    #[serde(default)]
    pub scope: Option<String>,
    #[serde(default)]
    pub project_path: Option<String>,
    pub providers: Vec<ProviderId>,
    #[serde(default)]
    pub overwrite: SkillOverwritePolicy,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstructionPublishReceipt {
    pub key: String,
    pub source_digest: String,
    pub project_path: String,
    pub results: Vec<ProjectInstructionDeployment>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectInstructionMigrationPlan {
    pub key: String,
    pub source_platforms: Vec<HostPlatform>,
    pub target_platform: HostPlatform,
    pub source_digest: String,
    pub providers: Vec<ProviderId>,
    pub variant_directory: String,
    pub automatic_execution: bool,
    pub aia_prompt: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectInstructionFileContent {
    pub key: String,
    pub provider: ProviderId,
    pub source_variant: Option<HostPlatform>,
    pub content: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveProjectInstructionPlatformVariantRequest {
    pub key: String,
    pub target_platform: HostPlatform,
    #[serde(default)]
    pub source_platform: Option<HostPlatform>,
    pub files: Vec<InstructionProviderFileWrite>,
    pub expected_digest: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetProjectInstructionPlatformsRequest {
    pub key: String,
    #[serde(default)]
    pub platforms: Vec<HostPlatform>,
    pub expected_digest: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredInstructionMeta {
    schema_version: u32,
    name: String,
    description: String,
}

#[derive(Debug, Clone)]
struct RegisteredProject {
    path: PathBuf,
    /// 프로젝트를 등록시킨 세션의 공급자들. 현재는 테스트 검증에만 읽는다.
    #[cfg_attr(not(test), allow(dead_code))]
    providers: BTreeSet<ProviderId>,
}

#[derive(Debug, Clone)]
struct InstructionContent {
    digest: String,
    files: Vec<InstructionFile>,
    symlinks: Vec<String>,
    total_bytes: u64,
}

#[derive(Debug, Clone)]
struct InstructionFile {
    relative: PathBuf,
    size_bytes: u64,
}

/// 지침이 링크로 함께 읽게 하는 문서. 배포 루트 기준 상대 경로와 원문 바이트다.
/// 다이어그램 같은 비텍스트 문서도 링크로 걸리므로 바이트로 다룬다.
#[derive(Debug, Clone)]
struct InstructionLinkedDoc {
    relative: String,
    /// 이 문서를 링크한 문서의 상대 경로. 지침 파일 자신이면 빈 문자열이다.
    /// 가져오기 화면이 트리로 보여줘 어디서 딸려 오는 문서인지 알게 한다.
    source: String,
    bytes: Vec<u8>,
}

pub fn load_project_instruction_library(
    app_data_dir: &Path,
    sessions: &[SessionSummary],
) -> Result<ProjectInstructionLibrary, CoreError> {
    let projects = project_paths_from_sessions(sessions);
    let home = home_dir()?;
    let mut library = load_project_instruction_library_from_paths(
        &repository_instructions_root(app_data_dir),
        app_data_dir,
        Some(&home),
        &projects,
    )?;
    let meta = load_instruction_meta_store(app_data_dir);
    for entry in &mut library.entries {
        entry.auto_sync = meta
            .instructions
            .get(&entry.key)
            .map(|entry| entry.auto_sync)
            .unwrap_or(false);
    }
    Ok(library)
}

fn load_project_instruction_library_from_paths(
    root: &Path,
    app_data_dir: &Path,
    home: Option<&Path>,
    projects: &[RegisteredProject],
) -> Result<ProjectInstructionLibrary, CoreError> {
    let mut entries = Vec::new();
    let mut issues = Vec::new();
    if root.is_dir() {
        let mut directories = fs::read_dir(root)?
            .flatten()
            .map(|entry| entry.path())
            .collect::<Vec<_>>();
        directories.sort();
        for directory in directories {
            if directory
                .file_name()
                .is_some_and(|name| name.to_string_lossy().starts_with('.'))
            {
                continue;
            }
            let metadata = match fs::symlink_metadata(&directory) {
                Ok(metadata) => metadata,
                Err(error) => {
                    issues.push(ProjectInstructionIssue {
                        provider: None,
                        path: directory.to_string_lossy().into_owned(),
                        message: format!("공통 지침 원본 상태를 읽지 못했습니다: {error}"),
                    });
                    continue;
                }
            };
            if metadata.file_type().is_symlink() {
                issues.push(ProjectInstructionIssue {
                    provider: None,
                    path: directory.to_string_lossy().into_owned(),
                    message: "심볼릭 링크 공통 지침은 관리하지 않습니다".to_owned(),
                });
                continue;
            }
            if !metadata.is_dir() {
                continue;
            }
            let key = directory
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_default();
            let ledger = instruction_ledger(app_data_dir, root, &key, home, projects);
            match read_entry(&directory, home, projects, &ledger) {
                Ok(entry) => entries.push(entry),
                Err(error) => issues.push(ProjectInstructionIssue {
                    provider: None,
                    path: directory.to_string_lossy().into_owned(),
                    message: format!("공통 지침 원본을 읽지 못했습니다: {error}"),
                }),
            }
        }
    }
    // 개인(공급자 홈) 위치를 먼저, 그 다음 등록 프로젝트 순으로 나열한다.
    let mut deployments = home
        .map(|home| {
            PROVIDERS
                .into_iter()
                .map(|provider| {
                    installed_deployment_status(
                        provider,
                        &personal_instruction_dir(home, provider),
                        SCOPE_PERSONAL,
                    )
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    deployments.extend(projects.iter().flat_map(|project| {
        PROVIDERS
            .into_iter()
            .map(|provider| installed_deployment_status(provider, &project.path, SCOPE_PROJECT))
    }));
    issues.extend(deployments.iter().filter_map(|deployment| {
        deployment
            .message
            .as_ref()
            .map(|message| ProjectInstructionIssue {
                provider: Some(deployment.provider),
                path: deployment.file_path.clone(),
                message: message.clone(),
            })
    }));
    Ok(ProjectInstructionLibrary {
        schema_version: LIBRARY_SCHEMA_VERSION,
        common_root: root.to_string_lossy().into_owned(),
        common_root_present: root.is_dir(),
        current_platform: HostPlatform::current(),
        projects: projects
            .iter()
            .map(|project| project.path.to_string_lossy().into_owned())
            .collect(),
        entries,
        deployments,
        issues,
    })
}

fn read_entry(
    directory: &Path,
    home: Option<&Path>,
    projects: &[RegisteredProject],
    ledger: &InstructionLedger,
) -> Result<ProjectInstructionEntry, CoreError> {
    let key = directory
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .ok_or_else(|| CoreError::InvalidInput("지침 키를 읽지 못했습니다".to_owned()))?;
    let key = validate_instruction_key(&key)?;
    read_entry_with_key(directory, key, home, projects, ledger)
}

fn read_entry_with_key(
    directory: &Path,
    key: String,
    home: Option<&Path>,
    projects: &[RegisteredProject],
    ledger: &InstructionLedger,
) -> Result<ProjectInstructionEntry, CoreError> {
    let content = validated_instruction_content(directory)?;
    let manifest = validate_manifest(directory)?;
    let meta = load_instruction_meta(directory).unwrap_or_else(|| StoredInstructionMeta {
        schema_version: 1,
        name: key.clone(),
        description: String::new(),
    });
    let providers = PROVIDERS
        .iter()
        .copied()
        .filter(|provider| instruction_provider_present(directory, &manifest, *provider))
        .collect::<Vec<_>>();
    let current_supported = manifest.supports(HostPlatform::current());
    let current_platform_variant = manifest
        .active_variant(HostPlatform::current())
        .map(str::to_owned);
    let linked_files = archive_linked_doc_paths(&content, &manifest);
    // 이 원본이 갖고 있는 공급자만 훑는다. 화면은 위치 매트릭스를 그려야 하므로 후보
    // 위치 전체의 존재 여부는 담고, 세트 비교와 연결 문서 해석은 원장에 오른 곳만 한다.
    let mut deployments = Vec::new();
    for provider in providers.iter().copied() {
        let source_digest = projected_source_digest(directory, &manifest, provider);
        let mut locations = deployment_dirs_for_provider(home, projects, provider);
        for (recorded, candidate, scope) in ledger.directories() {
            if recorded != provider {
                continue;
            }
            if !locations.iter().any(|(known, _)| *known == candidate) {
                locations.push((candidate, scope));
            }
        }
        for (location, scope) in locations {
            deployments.push(deployment_status(
                directory,
                &manifest,
                provider,
                source_digest.as_deref(),
                &location,
                scope,
                &linked_files,
                ledger.contains(provider, &location),
            ));
        }
    }
    Ok(ProjectInstructionEntry {
        key,
        name: meta.name,
        description: meta.description,
        directory: directory.to_string_lossy().into_owned(),
        source_digest: content.digest,
        providers,
        platforms: manifest.platforms,
        current_platform_supported: current_supported,
        current_platform_variant,
        auto_sync: false,
        linked_files,
        deployments,
    })
}

pub fn create_project_instruction(
    app_data_dir: &Path,
    request: &CreateProjectInstructionRequest,
) -> Result<ProjectInstructionEntry, CoreError> {
    create_project_instruction_in_root(&repository_instructions_root(app_data_dir), request)
}

fn create_project_instruction_in_root(
    root: &Path,
    request: &CreateProjectInstructionRequest,
) -> Result<ProjectInstructionEntry, CoreError> {
    let key = validate_instruction_key(&request.key)?;
    let name = validate_name(&request.name, &key)?;
    let description = validate_description(&request.description)?;
    if request.files.is_empty() {
        return Err(CoreError::InvalidInput(
            "하나 이상의 공급자 지침 파일이 필요합니다".to_owned(),
        ));
    }
    let mut providers = BTreeSet::new();
    for file in &request.files {
        if !providers.insert(file.provider) {
            return Err(CoreError::InvalidInput(format!(
                "{} 지침 파일이 중복되었습니다",
                file.provider
            )));
        }
        validate_instruction_text(&file.content)?;
    }

    fs::create_dir_all(root)?;
    let target = root.join(&key);
    assert_within_root(root, &target)?;
    if fs::symlink_metadata(&target).is_ok() {
        return Err(CoreError::Conflict(format!(
            "'{key}' 공통 프로젝트 지침이 이미 있습니다"
        )));
    }
    let staging = SourceStage::create(root, &key)?;
    let stage = staging.stage.clone();
    let result = (|| {
        for file in &request.files {
            fs::write(
                stage.join(instruction_file_name(file.provider)),
                &file.content,
            )?;
        }
        write_instruction_meta(&stage, &name, &description)?;
        if !request.platforms.is_empty() {
            let platforms = request
                .platforms
                .iter()
                .copied()
                .collect::<BTreeSet<_>>()
                .into_iter()
                .collect();
            write_manifest(
                &stage,
                &ResourcePlatformManifest {
                    schema_version: 1,
                    platforms,
                    variants: BTreeMap::new(),
                    variant_deletes: BTreeMap::new(),
                },
            )?;
        }
        validated_instruction_content(&stage)?;
        fs::rename(&stage, &target)?;
        read_entry(&target, None, &[], &InstructionLedger::default())
    })();
    staging.finish(&target, result)
}

/// 배포 위치의 지침 파일을 읽고 링크를 따라가 연결 문서를 모은다. 미리보기와 실제
/// 가져오기가 같은 경로를 쓰므로, 화면 트리에서 고른 문서가 보관되는 문서와 어긋나지
/// 않는다.
fn read_importable_deployment(
    directory: &Path,
    provider: ProviderId,
) -> Result<
    (
        PathBuf,
        String,
        Vec<InstructionLinkedDoc>,
        Vec<InstructionLinkIssue>,
    ),
    CoreError,
> {
    let source = directory.join(instruction_file_name(provider));
    assert_within_root(directory, &source)?;
    let metadata = fs::symlink_metadata(&source)
        .map_err(|_| CoreError::NotFound("프로젝트 지침 파일을 찾지 못했습니다".to_owned()))?;
    ensure_regular_file(
        &metadata,
        "심볼릭 링크나 일반 파일이 아닌 지침은 가져올 수 없습니다",
    )?;
    ensure_within_limit(&metadata, MAX_INSTRUCTION_FILE_BYTES)?;
    let text = String::from_utf8(fs::read(&source)?)
        .map_err(|_| CoreError::InvalidInput("지침 파일은 UTF-8 텍스트여야 합니다".to_owned()))?;
    validate_instruction_text(&text)?;
    // 지침은 연결 문서까지 읽으라는 것이므로 링크를 따라가 한 세트로 본다.
    let (docs, issues) =
        collect_deployed_linked_docs(directory, &text, &reserved_archive_paths(None));
    Ok((source, text, docs, issues))
}

/// 요청이 고른 연결 문서만 남긴다. 모르는 경로가 오면 조용히 빼지 않고 막는다.
/// 사람이 트리에서 고른 것과 보관된 것이 달라지면 지침이 반쪽으로 남기 때문이다.
fn select_linked_docs(
    docs: Vec<InstructionLinkedDoc>,
    selection: Option<&[String]>,
) -> Result<Vec<InstructionLinkedDoc>, CoreError> {
    let Some(selection) = selection else {
        return Ok(docs);
    };
    let wanted: BTreeSet<String> = selection
        .iter()
        .map(|relative| normalized_relative(Path::new(relative.trim())))
        .collect();
    let found: BTreeSet<&str> = docs.iter().map(|doc| doc.relative.as_str()).collect();
    if let Some(unknown) = wanted
        .iter()
        .find(|relative| !found.contains(relative.as_str()))
    {
        return Err(CoreError::InvalidInput(format!(
            "지침이 링크로 가리키지 않는 문서는 함께 보관할 수 없습니다: {unknown}"
        )));
    }
    Ok(docs
        .into_iter()
        .filter(|doc| wanted.contains(&doc.relative))
        .collect())
}

/// 가져오기 전에 지침이 링크로 끌고 오는 문서를 훑어 보여준다. 파일을 쓰지 않는다.
pub fn preview_project_instruction_import(
    sessions: &[SessionSummary],
    request: &InstructionImportPreviewRequest,
) -> Result<InstructionImportPreview, CoreError> {
    let projects = project_paths_from_sessions(sessions);
    let home = home_dir()?;
    preview_project_instruction_import_from_paths(Some(&home), &projects, request)
}

fn preview_project_instruction_import_from_paths(
    home: Option<&Path>,
    projects: &[RegisteredProject],
    request: &InstructionImportPreviewRequest,
) -> Result<InstructionImportPreview, CoreError> {
    let (directory, scope) = resolve_deployment_dir(
        home,
        projects,
        &BTreeSet::new(),
        request.scope.as_deref(),
        request.project_path.as_deref(),
        request.provider,
    )?;
    let (source, text, docs, link_issues) =
        read_importable_deployment(&directory, request.provider)?;
    let total_bytes = docs
        .iter()
        .map(|doc| doc.bytes.len() as u64)
        .sum::<u64>()
        .saturating_add(text.len() as u64);
    Ok(InstructionImportPreview {
        scope: scope.to_owned(),
        project_path: directory.to_string_lossy().into_owned(),
        provider: request.provider,
        file_path: source.to_string_lossy().into_owned(),
        size_bytes: text.len() as u64,
        linked_docs: docs
            .into_iter()
            .map(|doc| InstructionImportLinkedDoc {
                relative: doc.relative,
                source: doc.source,
                size_bytes: doc.bytes.len() as u64,
            })
            .collect(),
        link_issues,
        total_bytes,
        max_total_bytes: MAX_INSTRUCTION_TOTAL_BYTES,
    })
}

pub fn import_project_instruction(
    app_data_dir: &Path,
    sessions: &[SessionSummary],
    request: &ImportProjectInstructionRequest,
) -> Result<ProjectInstructionEntry, CoreError> {
    let projects = project_paths_from_sessions(sessions);
    let home = home_dir()?;
    import_project_instruction_from_paths(
        &repository_instructions_root(app_data_dir),
        app_data_dir,
        Some(&home),
        &projects,
        request,
    )
}

fn import_project_instruction_from_paths(
    root: &Path,
    app_data_dir: &Path,
    home: Option<&Path>,
    projects: &[RegisteredProject],
    request: &ImportProjectInstructionRequest,
) -> Result<ProjectInstructionEntry, CoreError> {
    let key = validate_instruction_key(&request.key)?;
    let (directory, scope) = resolve_deployment_dir(
        home,
        projects,
        &BTreeSet::new(),
        request.scope.as_deref(),
        request.project_path.as_deref(),
        request.provider,
    )?;
    let (_source, text, linked_docs, _issues) =
        read_importable_deployment(&directory, request.provider)?;
    // 화면에서 트리로 고른 문서만 담는다. 고르지 않았으면 링크로 찾은 전부를 담는다.
    let linked_docs = select_linked_docs(linked_docs, request.linked_files.as_deref())?;
    ensure_archive_capacity(text.len() as u64, &linked_docs)?;
    let name = validate_name(request.name.as_deref().unwrap_or(&key), &key)?;
    let description = validate_description(request.description.as_deref().unwrap_or(""))?;

    fs::create_dir_all(root)?;
    let target = root.join(&key);
    assert_within_root(root, &target)?;
    if fs::symlink_metadata(&target).is_ok() {
        return Err(CoreError::Conflict(format!(
            "'{key}' 공통 프로젝트 지침이 이미 있습니다"
        )));
    }
    let staging = SourceStage::create(root, &key)?;
    let stage = staging.stage.clone();
    let result = (|| {
        fs::write(stage.join(instruction_file_name(request.provider)), text)?;
        write_linked_docs(&stage, &linked_docs)?;
        write_instruction_meta(&stage, &name, &description)?;
        validated_instruction_content(&stage)?;
        fs::rename(&stage, &target)?;
        // 가져온 그 위치가 이 원본의 첫 배포다. 내용이 같으니 그대로 원장에 올린다.
        let manifest = validate_manifest(&target)?;
        let linked = archived_linked_docs(&target, &manifest);
        record_instruction_deployment(
            app_data_dir,
            &key,
            request.provider,
            scope,
            &directory,
            digest_file(&directory.join(instruction_file_name(request.provider))).ok(),
            deployed_linked_digests(&directory, &linked),
        );
        let ledger = instruction_ledger(app_data_dir, root, &key, home, projects);
        read_entry(&target, home, projects, &ledger)
    })();
    staging.finish(&target, result)
}

pub fn publish_project_instruction(
    app_data_dir: &Path,
    sessions: &[SessionSummary],
    request: &PublishProjectInstructionRequest,
) -> Result<InstructionPublishReceipt, CoreError> {
    let projects = project_paths_from_sessions(sessions);
    let home = home_dir()?;
    publish_project_instruction_from_paths(
        &repository_instructions_root(app_data_dir),
        app_data_dir,
        Some(&home),
        &projects,
        request,
    )
}

pub fn get_project_instruction_migration_plan(
    app_data_dir: &Path,
    key: &str,
    target_platform: HostPlatform,
) -> Result<ProjectInstructionMigrationPlan, CoreError> {
    let key = validate_instruction_key(key)?;
    let root = repository_instructions_root(app_data_dir);
    let directory = root.join(&key);
    assert_within_root(&root, &directory)?;
    let content = validated_instruction_content(&directory)?;
    let manifest = validate_manifest(&directory)?;
    let providers = PROVIDERS
        .into_iter()
        .filter(|provider| instruction_provider_present(&directory, &manifest, *provider))
        .collect::<Vec<_>>();
    if providers.is_empty() {
        return Err(CoreError::NotFound(
            "마이그레이션할 프로젝트 지침 파일이 없습니다".to_owned(),
        ));
    }
    let variant_directory = format!(".agent-manager/variants/{}", target_platform.as_str());
    Ok(ProjectInstructionMigrationPlan {
        key: key.clone(),
        source_platforms: manifest.platforms,
        target_platform,
        source_digest: content.digest,
        providers: providers.clone(),
        variant_directory: variant_directory.clone(),
        automatic_execution: false,
        aia_prompt: format!(
            "'{key}' 프로젝트 지침을 {}용으로 마이그레이션하세요. get_project_instruction_migration_plan에서 공급자 목록을 확인하고 각 원문은 read_project_instruction_file로 읽으세요. 공급자({})별 지침에서 OS 차이가 있는 내용만 변환한 뒤 save_project_instruction_platform_variant로 {variant_directory} overlay에 저장하세요. 생성한 스크립트나 명령은 자동 실행하지 마세요.",
            target_platform.as_str(),
            providers
                .iter()
                .map(|provider| provider.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        ),
    })
}

pub fn read_project_instruction_file(
    app_data_dir: &Path,
    key: &str,
    provider: ProviderId,
) -> Result<ProjectInstructionFileContent, CoreError> {
    let key = validate_instruction_key(key)?;
    let root = repository_instructions_root(app_data_dir);
    let directory = root.join(&key);
    assert_within_root(&root, &directory)?;
    validated_instruction_content(&directory)?;
    let manifest = validate_manifest(&directory)?;
    let (path, source_variant) =
        migration_source_instruction_file(&directory, &manifest, provider)?;
    let bytes = fs::read(path)?;
    let content = String::from_utf8(bytes).map_err(|_| {
        CoreError::InvalidInput("프로젝트 지침은 UTF-8 텍스트여야 합니다".to_owned())
    })?;
    validate_instruction_text(&content)?;
    Ok(ProjectInstructionFileContent {
        key,
        provider,
        source_variant,
        content,
    })
}

fn migration_source_instruction_file(
    directory: &Path,
    manifest: &ResourcePlatformManifest,
    provider: ProviderId,
) -> Result<(PathBuf, Option<HostPlatform>), CoreError> {
    let file_name = instruction_file_name(provider);
    let base = directory.join(file_name);
    if base.is_file() {
        reject_symlink_file(&base)?;
        return Ok((base, None));
    }
    for (platform, variant) in &manifest.variants {
        let variant = validate_platform_variant_path(*platform, variant)?;
        let candidate = directory.join(variant).join(file_name);
        if candidate.is_file() {
            reject_symlink_file(&candidate)?;
            return Ok((candidate, Some(*platform)));
        }
    }
    Err(CoreError::NotFound(format!(
        "{} 공통 지침 파일이 없습니다",
        provider.as_str()
    )))
}

pub fn save_project_instruction_platform_variant(
    app_data_dir: &Path,
    request: &SaveProjectInstructionPlatformVariantRequest,
) -> Result<ProjectInstructionEntry, CoreError> {
    if request.files.is_empty() {
        return Err(CoreError::InvalidInput(
            "OS 변형 지침 파일을 하나 이상 제공하세요".to_owned(),
        ));
    }
    let key = validate_instruction_key(&request.key)?;
    let mut seen = BTreeSet::new();
    for file in &request.files {
        if !seen.insert(file.provider) {
            return Err(CoreError::InvalidInput(format!(
                "{} 지침 파일이 중복되었습니다",
                file.provider
            )));
        }
        validate_instruction_text(&file.content)?;
    }

    let mut edit = ManifestSource::open(app_data_dir, &key, &request.expected_digest)?;
    if edit.manifest.platforms.is_empty() {
        edit.manifest.platforms.push(
            request
                .source_platform
                .unwrap_or_else(HostPlatform::current),
        );
    }
    let variant_relative = format!(
        ".agent-manager/variants/{}",
        request.target_platform.as_str()
    );
    edit.manifest
        .variants
        .insert(request.target_platform, variant_relative.clone());
    edit.manifest.schema_version = 1;

    edit.replace(
        &key,
        "지침 원본이 변형 생성 중 변경되었습니다. 다시 시도하세요",
        |stage| {
            let variant = stage.join(&variant_relative);
            assert_within_root(stage, &variant)?;
            fs::create_dir_all(&variant)?;
            for file in &request.files {
                fs::write(
                    variant.join(instruction_file_name(file.provider)),
                    &file.content,
                )?;
            }
            Ok(())
        },
    )
}

pub fn set_project_instruction_platforms(
    app_data_dir: &Path,
    request: &SetProjectInstructionPlatformsRequest,
) -> Result<ProjectInstructionEntry, CoreError> {
    let key = validate_instruction_key(&request.key)?;
    let mut edit = ManifestSource::open(app_data_dir, &key, &request.expected_digest)?;
    edit.manifest.platforms = request
        .platforms
        .iter()
        .copied()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    edit.manifest.schema_version = 1;

    edit.replace(
        &key,
        "지침 원본이 OS 메타 저장 중 변경되었습니다. 다시 시도하세요",
        |_| Ok(()),
    )
}

fn publish_project_instruction_from_paths(
    root: &Path,
    app_data_dir: &Path,
    home: Option<&Path>,
    projects: &[RegisteredProject],
    request: &PublishProjectInstructionRequest,
) -> Result<InstructionPublishReceipt, CoreError> {
    let key = validate_instruction_key(&request.key)?;
    let source_directory = root.join(&key);
    assert_within_root(root, &source_directory)?;
    if !source_directory.is_dir() {
        return Err(CoreError::NotFound(format!(
            "'{key}' 공통 프로젝트 지침을 찾지 못했습니다"
        )));
    }
    let ledger_dirs = ledger_project_dirs(app_data_dir);
    let content = validated_instruction_content(&source_directory)?;
    let manifest = validate_manifest(&source_directory)?;
    let platform = HostPlatform::current();
    if manifest.migration_required(platform) {
        return Err(CoreError::InvalidInput(format!(
            "현재 OS({})용 지침 변형이 없습니다",
            platform.as_str()
        )));
    }
    if request.providers.is_empty() {
        return Err(CoreError::InvalidInput(
            "게시할 공급자를 하나 이상 선택하세요".to_owned(),
        ));
    }
    // 영수증의 project_path는 위치 하나만 담는다. personal은 공급자별로 디렉터리가
    // 갈리므로 공통 상위인 홈을 싣고, 위치별 경로는 각 배포 행이 들고 있다.
    let receipt_directory = if matches!(request.scope.as_deref(), Some(SCOPE_PERSONAL)) {
        home.ok_or_else(|| CoreError::InvalidInput("홈 디렉터리를 확인할 수 없습니다".to_owned()))?
            .to_path_buf()
    } else {
        resolve_deployment_dir(
            home,
            projects,
            &ledger_dirs,
            request.scope.as_deref(),
            request.project_path.as_deref(),
            request.providers[0],
        )?
        .0
    };

    let linked = archive_linked_doc_paths(&content, &manifest);
    let mut seen = BTreeSet::new();
    let mut results = Vec::new();
    for provider in request.providers.iter().copied() {
        if !seen.insert(provider) {
            continue;
        }
        let (directory, scope) = resolve_deployment_dir(
            home,
            projects,
            &ledger_dirs,
            request.scope.as_deref(),
            request.project_path.as_deref(),
            provider,
        )?;
        // 공급자 홈 설정 디렉터리는 아직 없을 수 있다(예: 미사용 CLI).
        if scope == SCOPE_PERSONAL {
            fs::create_dir_all(&directory)?;
        }
        let target = directory.join(instruction_file_name(provider));
        let mut deployment = empty_deployment(provider, &directory, &target, scope);
        if validated_instruction_content(&source_directory)?.digest != content.digest {
            results.push(deployment.concluded(
                InstructionPublishOutcome::Failed,
                "게시 중 공통 지침 원본이 변경되었습니다. 새로고침 후 다시 시도하세요".to_owned(),
            ));
            continue;
        }
        let source = match projected_instruction_file(&source_directory, &manifest, provider) {
            Ok(path) => path,
            Err(error) => {
                results.push(
                    deployment.concluded(InstructionPublishOutcome::Skipped, error.to_string()),
                );
                continue;
            }
        };
        let linked_results = match publish_linked_docs(
            &source_directory,
            &linked,
            &directory,
            request.overwrite,
            None,
        ) {
            Ok(linked) => linked,
            Err(error) => {
                results.push(deployment.concluded(
                    InstructionPublishOutcome::Failed,
                    format!("연결 문서를 게시하지 못했습니다: {error}"),
                ));
                continue;
            }
        };
        match publish_instruction_file(&directory, &source, &target, request.overwrite) {
            Ok(outcome) => {
                // 실제로 놓인(또는 이미 같은 내용인) 위치만 원장에 올린다. 건너뛴
                // 위치는 남의 파일이 있는 곳이라 이 원본의 배포가 아니다.
                if !outcome.is_skipped() {
                    record_instruction_deployment(
                        app_data_dir,
                        &key,
                        provider,
                        scope,
                        &directory,
                        digest_file(&target).ok(),
                        published_linked_digests(&directory, &linked_results),
                    );
                }
                deployment = deployment_status(
                    &source_directory,
                    &manifest,
                    provider,
                    projected_source_digest(&source_directory, &manifest, provider).as_deref(),
                    &directory,
                    scope,
                    &linked,
                    !outcome.is_skipped(),
                );
                deployment.outcome = Some(outcome);
                deployment.message = publish_message(outcome, &linked_results);
            }
            Err(error) => {
                deployment =
                    deployment.concluded(InstructionPublishOutcome::Failed, error.to_string());
            }
        }
        deployment.linked_results = linked_results;
        results.push(deployment);
    }
    Ok(InstructionPublishReceipt {
        key,
        source_digest: content.digest,
        project_path: receipt_directory.to_string_lossy().into_owned(),
        results,
    })
}

fn publish_instruction_file(
    project_root: &Path,
    source: &Path,
    target: &Path,
    overwrite: SkillOverwritePolicy,
) -> Result<InstructionPublishOutcome, CoreError> {
    assert_within_root(project_root, target)?;
    let source_meta = fs::symlink_metadata(source)?;
    ensure_regular_file(&source_meta, "공통 원본 지침은 일반 파일이어야 합니다")?;
    ensure_within_limit(&source_meta, MAX_INSTRUCTION_FILE_BYTES)?;
    let source_digest = digest_file(source)?;
    let existed = match fs::symlink_metadata(target) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            return Err(CoreError::InvalidInput(
                "프로젝트 지침 심볼릭 링크는 교체하지 않습니다".to_owned(),
            ));
        }
        Ok(metadata) if !metadata.is_file() => {
            return Err(CoreError::Conflict(
                "프로젝트 지침 경로가 일반 파일이 아닙니다".to_owned(),
            ));
        }
        Ok(_) => true,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Err(error) => return Err(CoreError::Io(error)),
    };
    if existed && digest_file(target)? == source_digest {
        return Ok(InstructionPublishOutcome::Unchanged);
    }
    if existed && matches!(overwrite, SkillOverwritePolicy::Fail) {
        return Ok(InstructionPublishOutcome::Skipped);
    }

    let nonce = publish_nonce();
    let stage = project_root.join(format!(
        "{STAGE_PREFIX}{}-{nonce}",
        instruction_file_name_from_path(target)?
    ));
    let backup = project_root.join(format!(
        "{BACKUP_PREFIX}{}-{nonce}",
        instruction_file_name_from_path(target)?
    ));
    assert_within_root(project_root, &stage)?;
    assert_within_root(project_root, &backup)?;
    fs::copy(source, &stage)?;
    if digest_file(&stage)? != source_digest {
        let _ = fs::remove_file(&stage);
        return Err(CoreError::Conflict(
            "지침 스테이징 사본 검증에 실패했습니다".to_owned(),
        ));
    }
    StagedReplace {
        kind: StagedKind::File,
        stage: &stage,
        target,
        backup: existed.then_some(backup.as_path()),
    }
    .commit()?;
    if existed {
        let _ = fs::remove_file(backup);
        Ok(InstructionPublishOutcome::Replaced)
    } else {
        Ok(InstructionPublishOutcome::Published)
    }
}

/// 보관한 연결 문서를 배포 위치의 같은 상대 경로에 쓴다. 지침 파일보다 먼저 써서
/// 중간에 실패해도 없는 문서를 가리키는 새 지침이 남지 않게 한다.
/// `guard`가 주어지면 그 위치에 마지막으로 배포한 지문과 다른 문서는 건드리지 않는다.
/// 재배포는 사람이 고른 적 없는 위치의 문서까지 같은 상대 경로로 덮을 수 있어, 우리가
/// 써 넣은 그대로인 문서만 갱신한다(C5-4).
fn publish_linked_docs(
    source_directory: &Path,
    linked: &[String],
    directory: &Path,
    overwrite: SkillOverwritePolicy,
    guard: Option<&BTreeMap<String, String>>,
) -> Result<Vec<InstructionLinkedFileResult>, CoreError> {
    let mut results = Vec::new();
    for relative in linked {
        let path = PathBuf::from(relative);
        validate_relative_path(&path)?;
        let source = source_directory.join(&path);
        assert_within_root(source_directory, &source)?;
        let target = directory.join(&path);
        if let Some(guard) = guard {
            let current = digest_file(&target).ok();
            if current.is_some() && current.as_deref() != guard.get(relative).map(String::as_str) {
                results.push(InstructionLinkedFileResult {
                    relative: relative.clone(),
                    outcome: InstructionPublishOutcome::Skipped,
                });
                continue;
            }
        }
        let outcome = publish_linked_doc_file(directory, &source, &target, overwrite)?;
        results.push(InstructionLinkedFileResult {
            relative: relative.clone(),
            outcome,
        });
    }
    Ok(results)
}

/// 원장에 남길 연결 문서 지문. 건너뛴 문서는 우리가 쓴 내용이 아니므로 기록하지 않아,
/// 다음 재배포에서도 계속 보호된다.
fn published_linked_digests(
    directory: &Path,
    results: &[InstructionLinkedFileResult],
) -> BTreeMap<String, String> {
    let mut digests = BTreeMap::new();
    for result in results {
        if result.outcome.is_skipped() {
            continue;
        }
        let path = directory.join(&result.relative);
        if assert_within_root(directory, &path).is_err() {
            continue;
        }
        if let Ok(digest) = digest_file(&path) {
            digests.insert(result.relative.clone(), digest);
        }
    }
    digests
}

/// 연결 문서 하나를 원자적으로 배포한다. 지침 파일과 같은 스테이지·백업 교체를
/// 쓰지만 하위 디렉터리에 놓이므로 스테이지도 그 문서가 놓일 디렉터리에서 만든다.
fn publish_linked_doc_file(
    root: &Path,
    source: &Path,
    target: &Path,
    overwrite: SkillOverwritePolicy,
) -> Result<InstructionPublishOutcome, CoreError> {
    assert_within_root(root, target)?;
    let source_meta = fs::symlink_metadata(source)?;
    ensure_regular_file(&source_meta, "보관한 연결 문서는 일반 파일이어야 합니다")?;
    ensure_within_limit(&source_meta, MAX_INSTRUCTION_FILE_BYTES)?;
    let source_digest = digest_file(source)?;
    let parent = target
        .parent()
        .ok_or_else(|| CoreError::InvalidInput("연결 문서 폴더를 알 수 없습니다".to_owned()))?;
    let existed = match fs::symlink_metadata(target) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            return Err(CoreError::InvalidInput(
                "연결 문서 심볼릭 링크는 교체하지 않습니다".to_owned(),
            ));
        }
        Ok(metadata) if !metadata.is_file() => {
            return Err(CoreError::Conflict(
                "연결 문서 경로가 일반 파일이 아닙니다".to_owned(),
            ));
        }
        Ok(_) => true,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Err(error) => return Err(CoreError::Io(error)),
    };
    if existed && digest_file(target)? == source_digest {
        return Ok(InstructionPublishOutcome::Unchanged);
    }
    if existed && matches!(overwrite, SkillOverwritePolicy::Fail) {
        return Ok(InstructionPublishOutcome::Skipped);
    }
    prepare_linked_doc_dir(root, parent)?;

    let name = instruction_file_name_from_path(target)?;
    let nonce = publish_nonce();
    let stage = parent.join(format!("{STAGE_PREFIX}{name}-{nonce}"));
    let backup = parent.join(format!("{BACKUP_PREFIX}{name}-{nonce}"));
    assert_within_root(root, &stage)?;
    assert_within_root(root, &backup)?;
    fs::copy(source, &stage)?;
    if digest_file(&stage)? != source_digest {
        let _ = fs::remove_file(&stage);
        return Err(CoreError::Conflict(
            "연결 문서 스테이징 사본 검증에 실패했습니다".to_owned(),
        ));
    }
    StagedReplace {
        kind: StagedKind::File,
        stage: &stage,
        target,
        backup: existed.then_some(backup.as_path()),
    }
    .commit()?;
    if existed {
        let _ = fs::remove_file(backup);
        Ok(InstructionPublishOutcome::Replaced)
    } else {
        Ok(InstructionPublishOutcome::Published)
    }
}

/// 연결 문서가 놓일 하위 디렉터리를 만든다. 도중에 심볼릭 링크가 있으면 배포 위치
/// 밖으로 쓸 수 있어 거부한다.
fn prepare_linked_doc_dir(root: &Path, directory: &Path) -> Result<(), CoreError> {
    let relative = directory
        .strip_prefix(root)
        .map_err(|_| CoreError::InvalidInput("연결 문서 경로가 배포 위치 밖입니다".to_owned()))?;
    let mut current = root.to_path_buf();
    for component in relative.components() {
        let Component::Normal(name) = component else {
            return Err(CoreError::InvalidInput(
                "연결 문서 경로에 쓸 수 없는 조각이 있습니다".to_owned(),
            ));
        };
        current = current.join(name);
        match fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(CoreError::InvalidInput(format!(
                    "심볼릭 링크 폴더에는 연결 문서를 두지 않습니다: {}",
                    current.display()
                )));
            }
            Ok(metadata) if metadata.is_dir() => {}
            Ok(_) => {
                return Err(CoreError::Conflict(format!(
                    "연결 문서 폴더 자리에 파일이 있습니다: {}",
                    current.display()
                )));
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                fs::create_dir(&current)?;
            }
            Err(error) => return Err(CoreError::Io(error)),
        }
    }
    Ok(())
}

/// 게시 결과 안내. 지침 파일 결과에 연결 문서 결과를 덧붙여, 파일만 보고 세트가
/// 다 갔다고 오해하지 않게 한다.
fn publish_message(
    outcome: InstructionPublishOutcome,
    linked: &[InstructionLinkedFileResult],
) -> Option<String> {
    let count = |wanted: InstructionPublishOutcome| {
        linked
            .iter()
            .filter(|result| result.outcome == wanted)
            .count()
    };
    let written =
        count(InstructionPublishOutcome::Published) + count(InstructionPublishOutcome::Replaced);
    let skipped = count(InstructionPublishOutcome::Skipped);
    let mut parts = Vec::new();
    match outcome {
        InstructionPublishOutcome::Skipped => {
            parts.push("기존 프로젝트 지침이 있습니다. 덮어쓰기(Replace)를 선택하세요".to_owned())
        }
        InstructionPublishOutcome::Unchanged => {
            parts.push("이미 공통 원본과 같은 지침입니다".to_owned());
            if written > 0 {
                parts.push(format!("연결 문서 {written}개를 배포했습니다"));
            }
        }
        _ => {}
    }
    if skipped > 0 {
        parts.push(format!(
            "연결 문서 {skipped}개는 기존 파일이 있어 건너뜁니다. 덮어쓰기(Replace)를 선택하세요"
        ));
    }
    (!parts.is_empty()).then(|| parts.join(" · "))
}

/// 공급자 홈의 개인 지침 디렉터리. CLI들이 읽는 전역 지침 파일이 놓이는 곳이다.
fn personal_instruction_dir(home: &Path, provider: ProviderId) -> PathBuf {
    match provider {
        ProviderId::Claude => home.join(".claude"),
        ProviderId::Codex => home.join(".codex"),
        ProviderId::Antigravity => home.join(".gemini"),
    }
}

const SCOPE_PERSONAL: &str = "personal";
const SCOPE_PROJECT: &str = "project";

/// 한 공급자의 지침 파일이 놓일 수 있는 모든 위치. 개인(홈 설정)이 먼저 온다.
fn deployment_dirs_for_provider(
    home: Option<&Path>,
    projects: &[RegisteredProject],
    provider: ProviderId,
) -> Vec<(PathBuf, &'static str)> {
    let mut dirs = Vec::new();
    if let Some(home) = home {
        dirs.push((personal_instruction_dir(home, provider), SCOPE_PERSONAL));
    }
    dirs.extend(
        projects
            .iter()
            .map(|project| (project.path.clone(), SCOPE_PROJECT)),
    );
    dirs
}

/// scope와 projectPath 요청 값을 파일이 놓일 디렉터리로 해석한다. personal은
/// 공급자 홈 설정 디렉터리, 그 외에는 등록 프로젝트와 `allowed`(배포 원장에 남은
/// 위치)만 허용한다. 원장을 허용하는 이유는, 세션이 사라져 등록 프로젝트에서 빠진
/// 뒤에도 이미 배포해 둔 파일은 계속 갱신하고 회수할 수 있어야 하기 때문이다.
fn resolve_deployment_dir(
    home: Option<&Path>,
    projects: &[RegisteredProject],
    allowed: &BTreeSet<PathBuf>,
    scope: Option<&str>,
    project_path: Option<&str>,
    provider: ProviderId,
) -> Result<(PathBuf, &'static str), CoreError> {
    match scope {
        Some(SCOPE_PERSONAL) => {
            let home = home.ok_or_else(|| {
                CoreError::InvalidInput("홈 디렉터리를 확인할 수 없습니다".to_owned())
            })?;
            Ok((personal_instruction_dir(home, provider), SCOPE_PERSONAL))
        }
        None | Some(SCOPE_PROJECT) => {
            let requested = project_path.ok_or_else(|| {
                CoreError::InvalidInput("프로젝트 위치에는 projectPath가 필요합니다".to_owned())
            })?;
            match resolve_project(projects, requested) {
                Ok(project) => Ok((project.path.clone(), SCOPE_PROJECT)),
                Err(error) => {
                    let canonical = canonical_project_path(requested).map_err(|_| error)?;
                    if allowed.contains(&canonical) {
                        Ok((canonical, SCOPE_PROJECT))
                    } else {
                        Err(CoreError::InvalidInput(
                            "Agent Manager에 등록된 프로젝트가 아닙니다".to_owned(),
                        ))
                    }
                }
            }
        }
        Some(other) => Err(CoreError::InvalidInput(format!(
            "지원하지 않는 위치입니다: {other}"
        ))),
    }
}

// ---------------------------------------------------------------------------
// 연결 문서 세트
// ---------------------------------------------------------------------------

/// 보관 원본이 자기 구조로 쓰는 경로. 연결 문서가 이 자리와 겹치면 함께 보관하지
/// 않는다(공급자 지침 파일과 메타, 플랫폼 변형은 원본이 따로 관리한다).
fn reserved_archive_paths(manifest: Option<&ResourcePlatformManifest>) -> Vec<String> {
    let mut reserved = vec![".agent-manager".to_owned()];
    reserved.extend(
        PROVIDERS
            .iter()
            .map(|provider| instruction_file_name(*provider).to_owned()),
    );
    if let Some(manifest) = manifest {
        reserved.extend(
            manifest
                .variants
                .values()
                .filter_map(|variant| validate_variant_relative_path(variant).ok())
                .map(|variant| normalized_relative(&variant)),
        );
    }
    reserved
}

fn is_reserved_archive_path(relative: &str, reserved: &[String]) -> bool {
    reserved
        .iter()
        .any(|name| relative == name || relative.starts_with(&format!("{name}/")))
}

fn normalized_relative(relative: &Path) -> String {
    relative.to_string_lossy().replace('\\', "/")
}

/// 보관 원본에 함께 들어 있는 연결 문서. 원본 구조가 쓰는 자리를 뺀 나머지가 곧
/// 지침과 함께 읽히는 문서다. 플랫폼 변형은 지침 파일만 갈아 끼우므로 연결 문서는
/// 변형과 무관하게 원본 루트 기준으로 한 세트다.
/// 디렉터리에 보관된 연결 문서 목록. 원본을 읽지 못하면 연결 문서가 없는 것으로
/// 본다 — 호출자들은 모두 "함께 보낼 문서"를 묻는 자리라 빈 목록이 안전한 답이다.
fn archived_linked_docs(directory: &Path, manifest: &ResourcePlatformManifest) -> Vec<String> {
    validated_instruction_content(directory)
        .map(|content| archive_linked_doc_paths(&content, manifest))
        .unwrap_or_default()
}

fn archive_linked_doc_paths(
    content: &InstructionContent,
    manifest: &ResourcePlatformManifest,
) -> Vec<String> {
    let reserved = reserved_archive_paths(Some(manifest));
    content
        .files
        .iter()
        .map(|file| normalized_relative(&file.relative))
        .filter(|relative| !is_reserved_archive_path(relative, &reserved))
        .collect()
}

/// 위치에 매인 링크. 배포 위치가 달라지면 가리키는 곳이 달라지므로 함께 보관해도
/// 뜻이 이어지지 않는다.
fn is_location_bound_link(href: &str) -> bool {
    let target = href.trim();
    if target.starts_with('~') {
        return true;
    }
    let path = target.split('#').next().unwrap_or(target);
    Path::new(path).is_absolute()
}

/// 링크를 만난 문서 기준으로 먼저 찾고, 없으면 배포 루트에서 다시 찾는다. 화면의
/// 연결 문서 트리와 같은 순서라 트리에서 열리는 문서가 그대로 보관 대상이 된다.
fn read_deployment_link(
    root: &Path,
    source: &str,
    href: &str,
) -> Result<LinkedFileDownload, CoreError> {
    let base = link_base_dir(root, Some(source));
    let read = |base: &Path| {
        linked_file::read_linked_file_download_within(root, base, href, MAX_INSTRUCTION_FILE_BYTES)
    };
    match read(&base) {
        Ok(file) => Ok(file),
        // 실패 이유는 링크를 만난 문서 기준의 것을 남긴다. 루트 재시도의 "없다"가
        // "폴더다" 같은 진짜 이유를 덮으면 사람이 고칠 수 없다.
        Err(error) => {
            if base == root {
                return Err(error);
            }
            read(root).map_err(|_| error)
        }
    }
}

/// 배포된 지침 파일에서 링크를 재귀로 따라가 배포 루트 안의 문서를 모은다. 열지
/// 못한 링크와 위치에 매인 링크는 모으지 않고 이유를 남겨 사람이 판단하게 한다.
fn collect_deployed_linked_docs(
    root: &Path,
    instruction_text: &str,
    reserved: &[String],
) -> (Vec<InstructionLinkedDoc>, Vec<InstructionLinkIssue>) {
    let mut docs: Vec<InstructionLinkedDoc> = Vec::new();
    let mut issues: Vec<InstructionLinkIssue> = Vec::new();
    let mut visited: BTreeSet<String> = BTreeSet::new();
    let mut pending: VecDeque<(String, String)> = VecDeque::new();
    pending.push_back((String::new(), instruction_text.to_owned()));
    while let Some((source, text)) = pending.pop_front() {
        for href in local_document_links(&text) {
            if is_location_bound_link(&href) {
                issues.push(InstructionLinkIssue {
                    source: source.clone(),
                    href,
                    reason: "배포 위치에 매인 링크라 함께 보관하지 않습니다".to_owned(),
                });
                continue;
            }
            let file = match read_deployment_link(root, &source, &href) {
                Ok(file) => file,
                Err(error) => {
                    issues.push(InstructionLinkIssue {
                        source: source.clone(),
                        href,
                        reason: error.to_string(),
                    });
                    continue;
                }
            };
            if is_reserved_archive_path(&file.relative_path, reserved) {
                issues.push(InstructionLinkIssue {
                    source: source.clone(),
                    href,
                    reason: "보관 원본이 쓰는 경로와 겹쳐 함께 보관하지 않습니다".to_owned(),
                });
                continue;
            }
            if !visited.insert(file.relative_path.clone()) {
                continue;
            }
            // 텍스트 문서만 더 따라간다. 이미지 같은 문서는 링크의 끝이다.
            if let Ok(text) = String::from_utf8(file.bytes.clone()) {
                pending.push_back((file.relative_path.clone(), text));
            }
            docs.push(InstructionLinkedDoc {
                relative: file.relative_path,
                source: source.clone(),
                bytes: file.bytes,
            });
        }
    }
    (docs, issues)
}

/// 지침 파일과 메타, 연결 문서를 합쳐 원본 한도 안에 들어오는지 본다. 세트로
/// 담을 수 없으면 반쪽만 보관하지 않고 거부한다. 문서 수는 제한하지 않고 전체
/// 바이트만 본다. 지침이 링크로 끌고 오는 문서 수는 프로젝트마다 달라, 개수로
/// 자르면 세트가 반쪽이 되는 쪽이 더 위험하다.
fn ensure_archive_capacity(
    instruction_bytes: u64,
    docs: &[InstructionLinkedDoc],
) -> Result<(), CoreError> {
    let total = docs
        .iter()
        .map(|doc| doc.bytes.len() as u64)
        .sum::<u64>()
        .saturating_add(instruction_bytes);
    if total > MAX_INSTRUCTION_TOTAL_BYTES {
        return Err(CoreError::TooLarge(MAX_INSTRUCTION_TOTAL_BYTES));
    }
    Ok(())
}

/// 스테이지에 연결 문서를 같은 상대 경로로 쓴다.
fn write_linked_docs(stage: &Path, docs: &[InstructionLinkedDoc]) -> Result<(), CoreError> {
    for doc in docs {
        let relative = PathBuf::from(&doc.relative);
        validate_relative_path(&relative)?;
        let target = stage.join(&relative);
        assert_within_root(stage, &target)?;
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(&target, &doc.bytes)?;
    }
    Ok(())
}

fn same_file_content(left: &Path, right: &Path) -> bool {
    match (digest_file(left), digest_file(right)) {
        (Ok(left), Ok(right)) => left == right,
        _ => false,
    }
}

/// 배포 위치 한 곳의 상태. `managed`가 거짓이면 존재 여부만 싣고 비교는 하지 않는다.
/// 지침 파일 이름은 공급자당 고정이라, 원장에 없는 위치의 파일은 이 원본과 아무 관계가
/// 없을 수 있고 비교했다면 그 전부가 "외부 수정"으로 잡힌다.
#[allow(clippy::too_many_arguments)]
fn deployment_status(
    source_directory: &Path,
    manifest: &ResourcePlatformManifest,
    provider: ProviderId,
    source_digest: Option<&str>,
    directory: &Path,
    scope: &str,
    linked: &[String],
    managed: bool,
) -> ProjectInstructionDeployment {
    let mut deployment = installed_deployment_status(provider, directory, scope);
    deployment.managed = managed;
    deployment.source_digest = source_digest.map(str::to_owned);
    if !managed {
        return deployment;
    }
    deployment.divergent = deployment.present
        && match (&deployment.content_digest, source_digest) {
            (Some(installed), Some(source)) => installed != source,
            _ => false,
        };
    if deployment.present && deployment.message.is_none() {
        fill_linked_status(
            &mut deployment,
            source_directory,
            manifest,
            provider,
            directory,
            linked,
        );
    }
    deployment
}

/// 배포 위치의 연결 문서를 원본과 맞춰 본다. 지침은 연결 문서까지 읽으라는 것이므로
/// 문서가 없거나 달라지면 지침 파일이 같아도 세트로는 다른 상태다.
#[allow(clippy::too_many_arguments)]
fn fill_linked_status(
    deployment: &mut ProjectInstructionDeployment,
    source_directory: &Path,
    manifest: &ResourcePlatformManifest,
    provider: ProviderId,
    directory: &Path,
    linked: &[String],
) {
    for relative in linked {
        let deployed = directory.join(relative);
        if assert_within_root(directory, &deployed).is_err() {
            continue;
        }
        match fs::symlink_metadata(&deployed) {
            Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => {
                if !same_file_content(&deployed, &source_directory.join(relative)) {
                    deployment.linked_changed.push(relative.clone());
                }
            }
            Ok(_) => deployment.linked_changed.push(relative.clone()),
            Err(_) => deployment.linked_missing.push(relative.clone()),
        }
    }
    deployment.linked_files = linked.to_vec();

    // 배포된 지침이 참조하는 문서 중 원본에 없는 것과, 아예 보관하지 못한 링크를
    // 나눠 싣는다. 앞은 세트가 덜 찬 상태이고 뒤는 사람이 판단할 정보다.
    let reserved = reserved_archive_paths(Some(manifest));
    if let Ok(text) = fs::read_to_string(directory.join(instruction_file_name(provider))) {
        let (docs, issues) = collect_deployed_linked_docs(directory, &text, &reserved);
        deployment.linked_unarchived = docs
            .into_iter()
            .map(|doc| doc.relative)
            .filter(|relative| !deployment.linked_files.contains(relative))
            .collect();
        deployment.link_issues = issues;
    }
    deployment.divergent = deployment.divergent
        || !deployment.linked_missing.is_empty()
        || !deployment.linked_changed.is_empty()
        || !deployment.linked_unarchived.is_empty();
    deployment.set_digest = Some(deployed_set_digest(deployment, directory));
}

/// 배포 위치에 실제로 놓인 세트의 지문. 지침 파일 지문에 연결 문서의 경로와 지문을
/// 이어 붙여, 세트가 똑같이 수정된 위치끼리만 같은 값이 나오게 한다.
fn deployed_set_digest(deployment: &ProjectInstructionDeployment, directory: &Path) -> String {
    let mut hasher = Sha256::new();
    hasher.update(
        deployment
            .content_digest
            .clone()
            .unwrap_or_default()
            .as_bytes(),
    );
    let mut relatives: Vec<&String> = deployment
        .linked_files
        .iter()
        .chain(deployment.linked_unarchived.iter())
        .collect();
    relatives.sort();
    relatives.dedup();
    for relative in relatives {
        hasher.update(relative.as_bytes());
        hasher.update([0]);
        hasher.update(
            digest_file(&directory.join(relative))
                .unwrap_or_default()
                .as_bytes(),
        );
        hasher.update([0]);
    }
    format!("{:x}", hasher.finalize())
}

fn installed_deployment_status(
    provider: ProviderId,
    project: &Path,
    scope: &str,
) -> ProjectInstructionDeployment {
    let target = project.join(instruction_file_name(provider));
    let mut deployment = empty_deployment(provider, project, &target, scope);
    match fs::symlink_metadata(&target) {
        Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => {
            deployment.present = true;
            deployment.content_digest = digest_file(&target).ok();
        }
        Ok(metadata) if metadata.file_type().is_symlink() => {
            deployment.present = true;
            deployment.message = Some("심볼릭 링크 지침은 관리하지 않습니다".to_owned());
        }
        Ok(_) => {
            deployment.present = true;
            deployment.message = Some("지침 경로가 일반 파일이 아닙니다".to_owned());
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            deployment.message = Some(format!("프로젝트 지침 상태를 읽지 못했습니다: {error}"));
        }
    }
    deployment
}

fn empty_deployment(
    provider: ProviderId,
    project: &Path,
    target: &Path,
    scope: &str,
) -> ProjectInstructionDeployment {
    ProjectInstructionDeployment {
        provider,
        scope: scope.to_owned(),
        project_path: project.to_string_lossy().into_owned(),
        file_path: target.to_string_lossy().into_owned(),
        present: false,
        managed: false,
        content_digest: None,
        source_digest: None,
        divergent: false,
        linked_files: Vec::new(),
        linked_missing: Vec::new(),
        linked_changed: Vec::new(),
        linked_unarchived: Vec::new(),
        link_issues: Vec::new(),
        linked_results: Vec::new(),
        set_digest: None,
        outcome: None,
        message: None,
    }
}

fn project_paths_from_sessions(sessions: &[SessionSummary]) -> Vec<RegisteredProject> {
    let mut projects: BTreeMap<PathBuf, BTreeSet<ProviderId>> = BTreeMap::new();
    for session in sessions {
        if session.meta.hidden || session.aia_workspace {
            continue;
        }
        let Some(cwd) = session.cwd.as_deref() else {
            continue;
        };
        let Ok(path) = fs::canonicalize(cwd) else {
            continue;
        };
        if path.is_dir() {
            projects.entry(path).or_default().insert(session.source);
        }
    }
    projects
        .into_iter()
        .map(|(path, providers)| RegisteredProject { path, providers })
        .collect()
}

/// 요청받은 프로젝트 경로를 검증하고 정규화한다. 상위 경로(..)가 섞인 값과 실체가
/// 없는 경로는 여기서 막는다.
fn canonical_project_path(requested: &str) -> Result<PathBuf, CoreError> {
    let requested = Path::new(requested);
    if !requested.is_absolute() || path_guard::has_parent_dir(requested) {
        return Err(CoreError::InvalidInput(
            "프로젝트 경로는 상위 경로(..)가 없는 절대 경로여야 합니다".to_owned(),
        ));
    }
    fs::canonicalize(requested)
        .map_err(|_| CoreError::InvalidInput("프로젝트 경로를 확인할 수 없습니다".to_owned()))
}

fn resolve_project<'a>(
    projects: &'a [RegisteredProject],
    requested: &str,
) -> Result<&'a RegisteredProject, CoreError> {
    let requested = canonical_project_path(requested)?;
    projects
        .iter()
        .find(|project| project.path == requested)
        .ok_or_else(|| {
            CoreError::InvalidInput("Agent Manager에 등록된 프로젝트가 아닙니다".to_owned())
        })
}

fn validated_instruction_content(directory: &Path) -> Result<InstructionContent, CoreError> {
    let content = read_instruction_content(directory)?;
    if content.total_bytes > MAX_INSTRUCTION_TOTAL_BYTES {
        return Err(CoreError::TooLarge(MAX_INSTRUCTION_TOTAL_BYTES));
    }
    if content
        .files
        .iter()
        .any(|file| file.size_bytes > MAX_INSTRUCTION_FILE_BYTES)
    {
        return Err(CoreError::TooLarge(MAX_INSTRUCTION_FILE_BYTES));
    }
    if let Some(link) = content.symlinks.first() {
        return Err(CoreError::InvalidInput(format!(
            "심볼릭 링크가 있어 지침을 관리할 수 없습니다: {link}"
        )));
    }
    Ok(content)
}

fn read_instruction_content(directory: &Path) -> Result<InstructionContent, CoreError> {
    let metadata = fs::symlink_metadata(directory)?;
    ensure_directory(
        &metadata,
        "지침 원본은 심볼릭 링크가 아닌 디렉터리여야 합니다",
    )?;
    let mut files = Vec::new();
    let mut symlinks = Vec::new();
    let mut total_bytes = 0_u64;
    let mut pending = vec![PathBuf::new()];
    while let Some(relative_dir) = pending.pop() {
        for entry in fs::read_dir(directory.join(&relative_dir))?.flatten() {
            let relative = relative_dir.join(entry.file_name());
            validate_relative_path(&relative)?;
            let metadata = fs::symlink_metadata(entry.path())?;
            if metadata.file_type().is_symlink() {
                symlinks.push(relative.to_string_lossy().into_owned());
            } else if metadata.is_dir() {
                pending.push(relative);
            } else if metadata.is_file() {
                total_bytes = total_bytes.saturating_add(metadata.len());
                files.push(InstructionFile {
                    relative,
                    size_bytes: metadata.len(),
                });
            }
        }
    }
    files.sort_by(|left, right| left.relative.cmp(&right.relative));
    symlinks.sort();
    let mut hasher = Sha256::new();
    for file in &files {
        hasher.update(file.relative.to_string_lossy().as_bytes());
        hasher.update([0]);
        hasher.update(file.size_bytes.to_le_bytes());
        hasher.update(fs::read(directory.join(&file.relative))?);
    }
    Ok(InstructionContent {
        digest: format!("{:x}", hasher.finalize()),
        files,
        symlinks,
        total_bytes,
    })
}

fn validate_manifest(directory: &Path) -> Result<ResourcePlatformManifest, CoreError> {
    let path = resource_manifest_path(directory);
    let manifest = load_resource_manifest(directory);
    if path.exists() {
        let metadata = fs::symlink_metadata(&path)?;
        ensure_regular_file(&metadata, "리소스 메타는 일반 파일이어야 합니다")?;
        let parsed: ResourcePlatformManifest = serde_json::from_slice(&fs::read(&path)?)?;
        if parsed.schema_version != 1 {
            return Err(CoreError::InvalidInput(format!(
                "지원하지 않는 지침 OS 메타 버전입니다: {}",
                parsed.schema_version
            )));
        }
        if parsed != manifest {
            return Err(CoreError::InvalidInput(
                "리소스 메타를 해석하지 못했습니다".to_owned(),
            ));
        }
    }
    if !manifest.variant_deletes.is_empty() {
        return Err(CoreError::InvalidInput(
            "프로젝트 지침 메타에는 스킬용 제외 경로를 사용할 수 없습니다".to_owned(),
        ));
    }
    for (platform, variant) in &manifest.variants {
        let relative = validate_platform_variant_path(*platform, variant)?;
        let variant_directory = directory.join(relative);
        assert_within_root(directory, &variant_directory)?;
        if variant_directory.exists() {
            validated_instruction_content(&variant_directory)?;
        }
    }
    Ok(manifest)
}

fn projected_instruction_file(
    directory: &Path,
    manifest: &ResourcePlatformManifest,
    provider: ProviderId,
) -> Result<PathBuf, CoreError> {
    if manifest.migration_required(HostPlatform::current()) {
        return Err(CoreError::InvalidInput(format!(
            "현재 OS({})용 지침 변형이 없습니다",
            HostPlatform::current().as_str()
        )));
    }
    let file_name = instruction_file_name(provider);
    if let Some(variant) = manifest.active_variant(HostPlatform::current()) {
        let variant = validate_variant_relative_path(variant)?;
        let candidate = directory.join(variant).join(file_name);
        assert_within_root(directory, &candidate)?;
        if candidate.is_file() {
            reject_symlink_file(&candidate)?;
            return Ok(candidate);
        }
    }
    let candidate = directory.join(file_name);
    assert_within_root(directory, &candidate)?;
    match fs::symlink_metadata(&candidate) {
        Ok(_) => reject_symlink_file(&candidate)?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err(CoreError::NotFound(format!(
                "{provider} 공통 지침 파일이 없습니다"
            )))
        }
        Err(error) => return Err(CoreError::Io(error)),
    }
    Ok(candidate)
}

fn instruction_provider_present(
    directory: &Path,
    manifest: &ResourcePlatformManifest,
    provider: ProviderId,
) -> bool {
    let file_name = instruction_file_name(provider);
    if directory.join(file_name).is_file() {
        return true;
    }
    manifest.variants.values().any(|variant| {
        validate_variant_relative_path(variant)
            .ok()
            .is_some_and(|variant| directory.join(variant).join(file_name).is_file())
    })
}

fn reject_symlink_file(path: &Path) -> Result<(), CoreError> {
    let metadata = regular_file_metadata(path, "지침은 심볼릭 링크가 아닌 일반 파일이어야 합니다")?;
    ensure_within_limit(&metadata, MAX_INSTRUCTION_FILE_BYTES)?;
    Ok(())
}

fn load_instruction_meta(directory: &Path) -> Option<StoredInstructionMeta> {
    fs::read(directory.join(INSTRUCTION_META_RELATIVE))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
}

fn write_instruction_meta(
    directory: &Path,
    name: &str,
    description: &str,
) -> Result<(), CoreError> {
    let path = directory.join(INSTRUCTION_META_RELATIVE);
    fs::create_dir_all(path.parent().expect("instruction meta parent"))?;
    fs::write(
        path,
        serde_json::to_vec_pretty(&StoredInstructionMeta {
            schema_version: 1,
            name: name.to_owned(),
            description: description.to_owned(),
        })?,
    )?;
    Ok(())
}

fn write_manifest(directory: &Path, manifest: &ResourcePlatformManifest) -> Result<(), CoreError> {
    let path = resource_manifest_path(directory);
    fs::create_dir_all(path.parent().expect("manifest parent"))?;
    fs::write(path, serde_json::to_vec_pretty(manifest)?)?;
    Ok(())
}

fn validate_instruction_key(value: &str) -> Result<String, CoreError> {
    let value = value.trim();
    if value.is_empty() || value.chars().count() > MAX_INSTRUCTION_KEY_CHARS {
        return Err(CoreError::InvalidInput(format!(
            "지침 키는 1~{MAX_INSTRUCTION_KEY_CHARS}자여야 합니다"
        )));
    }
    if value.starts_with('.')
        || value.ends_with(['.', ' '])
        || !crate::identifier::is_slug_body(value)
        || is_windows_reserved_stem(value)
    {
        return Err(CoreError::InvalidInput(
            "지침 키에는 영문, 숫자, 하이픈, 밑줄만 사용할 수 있습니다".to_owned(),
        ));
    }
    Ok(value.to_owned())
}

fn validate_name(value: &str, fallback: &str) -> Result<String, CoreError> {
    let value = value.trim();
    let value = if value.is_empty() { fallback } else { value };
    if value.chars().count() > MAX_INSTRUCTION_NAME_CHARS {
        return Err(CoreError::InvalidInput(format!(
            "지침 이름은 {MAX_INSTRUCTION_NAME_CHARS}자까지 허용됩니다"
        )));
    }
    Ok(value.nfc().collect())
}

fn validate_description(value: &str) -> Result<String, CoreError> {
    let value = value.trim();
    if value.chars().count() > MAX_INSTRUCTION_DESCRIPTION_CHARS {
        return Err(CoreError::InvalidInput(format!(
            "지침 설명은 {MAX_INSTRUCTION_DESCRIPTION_CHARS}자까지 허용됩니다"
        )));
    }
    Ok(value.nfc().collect())
}

fn validate_instruction_text(value: &str) -> Result<(), CoreError> {
    if value.len() as u64 > MAX_INSTRUCTION_FILE_BYTES {
        return Err(CoreError::TooLarge(MAX_INSTRUCTION_FILE_BYTES));
    }
    if value.contains('\0') {
        return Err(CoreError::InvalidInput(
            "지침 파일에는 NUL 문자를 사용할 수 없습니다".to_owned(),
        ));
    }
    Ok(())
}

/// 원본이 `./doc.md` 꼴로 적어 둔 연결 문서를 그대로 받아야 해서 `.`만 통과시킨다.
fn validate_relative_path(relative: &Path) -> Result<(), CoreError> {
    if path_guard::classify_relative_path(relative, CurDirPolicy::Allow).is_some() {
        return Err(CoreError::InvalidInput(
            "지침 구성 파일 경로는 원본 안의 상대 경로여야 합니다".to_owned(),
        ));
    }
    Ok(())
}

const INSTRUCTION_PATH_LABELS: RootLabels = RootLabels {
    subject: "지침 경로",
    escaped: "지침 경로가 허용된 루트를 벗어납니다",
};

fn assert_within_root(root: &Path, candidate: &Path) -> Result<(), CoreError> {
    path_guard::assert_within_root(root, candidate, INSTRUCTION_PATH_LABELS)
}

fn digest_file(path: &Path) -> Result<String, CoreError> {
    let metadata = regular_file_metadata(path, "지침은 심볼릭 링크가 아닌 일반 파일이어야 합니다")?;
    ensure_within_limit(&metadata, MAX_INSTRUCTION_FILE_BYTES)?;
    Ok(format!("{:x}", Sha256::digest(fs::read(path)?)))
}

fn instruction_file_name(provider: ProviderId) -> &'static str {
    match provider {
        ProviderId::Claude => "CLAUDE.md",
        ProviderId::Codex => "AGENTS.md",
        ProviderId::Antigravity => "GEMINI.md",
    }
}

fn instruction_file_name_from_path(path: &Path) -> Result<String, CoreError> {
    path.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .ok_or_else(|| CoreError::InvalidInput("지침 파일 이름을 읽지 못했습니다".to_owned()))
}

fn is_windows_reserved_stem(value: &str) -> bool {
    let stem = value
        .split('.')
        .next()
        .unwrap_or(value)
        .to_ascii_uppercase();
    matches!(
        stem.as_str(),
        "CON"
            | "PRN"
            | "AUX"
            | "NUL"
            | "COM1"
            | "COM2"
            | "COM3"
            | "COM4"
            | "COM5"
            | "COM6"
            | "COM7"
            | "COM8"
            | "COM9"
            | "LPT1"
            | "LPT2"
            | "LPT3"
            | "LPT4"
            | "LPT5"
            | "LPT6"
            | "LPT7"
            | "LPT8"
            | "LPT9"
    )
}

fn publish_nonce() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

/// 보관 원본을 통째로 바꿀 때 쓰는 임시 스테이지와 백업 한 쌍. 두 경로가 같은 회차
/// nonce를 나눠 가져야 되살리기가 어느 스테이지에서 나온 백업인지 헷갈리지 않는다.
struct SourceStage {
    stage: PathBuf,
    backup: PathBuf,
}

impl SourceStage {
    /// `root` 안에 빈 스테이지 디렉터리를 만든다. 백업 경로는 이름만 잡아 두고
    /// 실제 디렉터리는 교체(`StagedReplace`)가 만든다.
    fn create(root: &Path, key: &str) -> Result<Self, CoreError> {
        let nonce = publish_nonce();
        let stage = root.join(format!("{STAGE_PREFIX}{key}-{nonce}"));
        let backup = root.join(format!("{BACKUP_PREFIX}{key}-{nonce}"));
        assert_within_root(root, &stage)?;
        assert_within_root(root, &backup)?;
        fs::create_dir(&stage)?;
        Ok(Self { stage, backup })
    }

    /// 스테이지를 채우거나 교체하는 일이 실패하면 스테이지를 지우고, 교체 도중이라
    /// 원본이 사라진 상태라면 백업으로 되살린다. 성공·실패 모두 받은 결과를 그대로
    /// 돌려준다.
    fn finish<T>(self, target: &Path, result: Result<T, CoreError>) -> Result<T, CoreError> {
        if result.is_err() {
            let _ = fs::remove_dir_all(&self.stage);
            if !target.exists() && self.backup.exists() {
                let _ = fs::rename(&self.backup, target);
            }
        }
        result
    }
}

/// 원본 구성 파일을 스테이지로 옮겨 담는다. `keep`이 거짓인 상대 경로는 건너뛰어,
/// 채택처럼 일부 파일을 새로 쓰는 쪽이 옛 사본을 남기지 않게 한다.
fn copy_source_files(
    source: &Path,
    files: &[InstructionFile],
    stage: &Path,
    keep: impl Fn(&Path) -> bool,
) -> Result<(), CoreError> {
    for file in files {
        if !keep(&file.relative) {
            continue;
        }
        let to = stage.join(&file.relative);
        assert_within_root(stage, &to)?;
        if let Some(parent) = to.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::copy(source.join(&file.relative), to)?;
    }
    Ok(())
}

/// OS 메타만 손보는 편집(변형 저장·지원 플랫폼 저장)이 공통으로 쓰는 원본 상태.
struct ManifestSource {
    root: PathBuf,
    source: PathBuf,
    current: InstructionContent,
    manifest: ResourcePlatformManifest,
}

impl ManifestSource {
    /// 보관 원본을 열고 낙관적 잠금을 확인한다. 지문이 어긋나면 편집을 시작하지 않는다.
    fn open(app_data_dir: &Path, key: &str, expected_digest: &str) -> Result<Self, CoreError> {
        let root = repository_instructions_root(app_data_dir);
        let source = root.join(key);
        assert_within_root(&root, &source)?;
        let current = validated_instruction_content(&source)?;
        if current.digest != expected_digest {
            return Err(CoreError::Conflict(
                "지침 원본이 다른 장치에서 변경되었습니다. 새로고침 후 다시 시도하세요".to_owned(),
            ));
        }
        let manifest = validate_manifest(&source)?;
        Ok(Self {
            root,
            source,
            current,
            manifest,
        })
    }

    /// 현재 원본을 스테이지로 옮겨 담고 `fill`이 스테이지를 더 손본 뒤, 손본 OS 메타를
    /// 쓰고 저장 직전 지문을 다시 확인해 원본을 교체한다. `conflict`는 그 사이 원본이
    /// 바뀌었을 때 알릴 말이다.
    fn replace(
        self,
        key: &str,
        conflict: &str,
        fill: impl FnOnce(&Path) -> Result<(), CoreError>,
    ) -> Result<ProjectInstructionEntry, CoreError> {
        let stage = SourceStage::create(&self.root, key)?;
        let result = (|| -> Result<ProjectInstructionEntry, CoreError> {
            copy_source_files(&self.source, &self.current.files, &stage.stage, |_| true)?;
            fill(&stage.stage)?;
            write_manifest(&stage.stage, &self.manifest)?;
            validated_instruction_content(&stage.stage)?;
            let mut entry = read_entry_with_key(
                &stage.stage,
                key.to_owned(),
                None,
                &[],
                &InstructionLedger::default(),
            )?;
            if validated_instruction_content(&self.source)?.digest != self.current.digest {
                return Err(CoreError::Conflict(conflict.to_owned()));
            }
            StagedReplace {
                kind: StagedKind::Directory,
                stage: &stage.stage,
                target: &self.source,
                backup: Some(&stage.backup),
            }
            .commit()?;
            entry.directory = self.source.to_string_lossy().into_owned();
            let _ = fs::remove_dir_all(&stage.backup);
            Ok(entry)
        })();
        stage.finish(&self.source, result)
    }
}

/// 자동 번역이 수집하는 지침 원본의 표시 텍스트. 이름·설명만 담고 본문은
/// 에이전트가 읽는 원문이라 번역 대상에서 제외한다.
#[derive(Debug, Clone)]
pub(crate) struct ProjectInstructionTranslationSource {
    /// 번역 레코드 조회 키. 지침 키를 그대로 쓴다.
    pub id: String,
    pub name: String,
    pub description: String,
}

pub(crate) fn list_instruction_translation_sources(
    app_data_dir: &Path,
) -> Vec<ProjectInstructionTranslationSource> {
    let root = repository_instructions_root(app_data_dir);
    let Ok(entries) = fs::read_dir(&root) else {
        return Vec::new();
    };
    let mut directories = entries
        .flatten()
        .map(|entry| entry.path())
        .collect::<Vec<_>>();
    directories.sort();
    let mut sources = Vec::new();
    for directory in directories {
        let Some(key) = directory
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
        else {
            continue;
        };
        if key.starts_with('.') || !directory.is_dir() {
            continue;
        }
        let meta = load_instruction_meta(&directory).unwrap_or_else(|| StoredInstructionMeta {
            schema_version: 1,
            name: key.clone(),
            description: String::new(),
        });
        sources.push(ProjectInstructionTranslationSource {
            id: key,
            name: meta.name,
            description: meta.description,
        });
    }
    sources
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadDeployedInstructionFileRequest {
    /// "personal"이면 projectPath 없이 공급자 홈 설정 파일을 읽는다.
    #[serde(default)]
    pub scope: Option<String>,
    #[serde(default)]
    pub project_path: Option<String>,
    pub provider: ProviderId,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeployedInstructionFileContent {
    pub scope: String,
    pub project_path: String,
    pub provider: ProviderId,
    pub file_path: String,
    pub content: String,
}

/// 개인 설정 또는 등록 프로젝트에 실제로 놓여 있는 지침 파일 원문을 읽는다.
/// 원본과 다른지 비교하거나 내용을 확인하는 열람용 읽기 작업이다.
pub fn read_deployed_instruction_file(
    app_data_dir: &Path,
    sessions: &[SessionSummary],
    request: &ReadDeployedInstructionFileRequest,
) -> Result<DeployedInstructionFileContent, CoreError> {
    let projects = project_paths_from_sessions(sessions);
    let home = home_dir()?;
    read_deployed_instruction_file_from_paths(
        Some(&home),
        &projects,
        &ledger_project_dirs(app_data_dir),
        request,
    )
}

fn read_deployed_instruction_file_from_paths(
    home: Option<&Path>,
    projects: &[RegisteredProject],
    allowed: &BTreeSet<PathBuf>,
    request: &ReadDeployedInstructionFileRequest,
) -> Result<DeployedInstructionFileContent, CoreError> {
    let (directory, scope) = resolve_deployment_dir(
        home,
        projects,
        allowed,
        request.scope.as_deref(),
        request.project_path.as_deref(),
        request.provider,
    )?;
    let target = directory.join(instruction_file_name(request.provider));
    managed_deployment_file(&target)?;
    let content = String::from_utf8(fs::read(&target)?)
        .map_err(|_| CoreError::InvalidInput("지침 파일은 UTF-8 텍스트여야 합니다".to_owned()))?;
    Ok(DeployedInstructionFileContent {
        scope: scope.to_owned(),
        project_path: directory.to_string_lossy().into_owned(),
        provider: request.provider,
        file_path: target.to_string_lossy().into_owned(),
        content,
    })
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeployedInstructionLinkedFileRequest {
    /// "personal"이면 projectPath 없이 공급자 홈 설정 파일을 기준으로 삼는다.
    #[serde(default)]
    pub scope: Option<String>,
    #[serde(default)]
    pub project_path: Option<String>,
    pub provider: ProviderId,
    /// 링크를 발견한 문서의 배포 루트 기준 상대 경로. 비우면 지침 파일 자신이다.
    #[serde(default)]
    pub current_path: Option<String>,
    pub href: String,
}

/// 배포된 지침 파일이 참조하는 로컬 문서(`@context/...` 가져오기나 마크다운 링크)를 읽는다.
/// 지침 하나만 봐서는 알 수 없는 연결 문서를 앱 안에서 이어 보게 하는 열람용 작업이다.
pub fn read_deployed_instruction_linked_file(
    app_data_dir: &Path,
    sessions: &[SessionSummary],
    request: &DeployedInstructionLinkedFileRequest,
) -> Result<LinkedFile, CoreError> {
    let projects = project_paths_from_sessions(sessions);
    let home = home_dir().ok();
    read_deployed_instruction_link(
        home.as_deref(),
        &projects,
        &ledger_project_dirs(app_data_dir),
        request,
        linked_file::read_linked_file_from,
    )
}

/// 연결 문서 다운로드. 미리보기가 막는 바이너리도 원본 그대로 내려받게 한다.
pub fn read_deployed_instruction_linked_file_download(
    app_data_dir: &Path,
    sessions: &[SessionSummary],
    request: &DeployedInstructionLinkedFileRequest,
) -> Result<LinkedFileDownload, CoreError> {
    let projects = project_paths_from_sessions(sessions);
    let home = home_dir().ok();
    read_deployed_instruction_link(
        home.as_deref(),
        &projects,
        &ledger_project_dirs(app_data_dir),
        request,
        linked_file::read_linked_file_download_from,
    )
}

/// 지침 파일이 놓인 디렉터리를 루트로 삼아 링크를 푼다. 링크 기준 디렉터리에서
/// 찾지 못하면 배포 루트에서 다시 찾고, 그래도 없으면 공급자 홈 설정 디렉터리까지
/// 본다. 프로젝트 지침이 `@~/.claude/...`처럼 홈 설정 문서를 가져오는 경우가 있다.
fn read_deployed_instruction_link<T>(
    home: Option<&Path>,
    projects: &[RegisteredProject],
    allowed: &BTreeSet<PathBuf>,
    request: &DeployedInstructionLinkedFileRequest,
    read: impl Fn(&Path, &Path, &str) -> Result<T, CoreError>,
) -> Result<T, CoreError> {
    let (directory, _) = resolve_deployment_dir(
        home,
        projects,
        allowed,
        request.scope.as_deref(),
        request.project_path.as_deref(),
        request.provider,
    )?;
    // 관리 대상 지침 파일이 실제로 있는 위치에서만 링크를 연다.
    managed_deployment_file(&directory.join(instruction_file_name(request.provider)))?;

    let href = expand_home_prefix(&request.href, home);
    let mut roots = vec![directory.clone()];
    // 상대 경로는 지침이 놓인 위치 안에서만 뜻이 통한다. 홈 설정 디렉터리는
    // `@~/.claude/...`처럼 절대 경로로 가리킬 때만 후보로 본다. 후보를 늘리지 않아야
    // "폴더다", "없다" 같은 실제 실패 이유가 마지막 시도에 덮이지 않는다.
    if Path::new(&href).is_absolute() {
        if let Some(home) = home {
            let personal = personal_instruction_dir(home, request.provider);
            if personal != directory && personal.is_dir() {
                roots.push(personal);
            }
        }
    }

    let mut failure: Option<CoreError> = None;
    for root in &roots {
        let mut bases = vec![link_base_dir(root, request.current_path.as_deref())];
        if bases[0] != *root {
            bases.push(root.clone());
        }
        for base in bases {
            match read(root, &base, &href) {
                Ok(value) => return Ok(value),
                Err(error) => failure = Some(error),
            }
        }
    }
    Err(failure.unwrap_or_else(|| {
        CoreError::NotFound(format!("링크 파일을 찾을 수 없습니다: {}", request.href))
    }))
}

/// 링크를 만난 문서가 있는 디렉터리. 경로 확인은 링크 해석이 canonicalize로 하므로
/// 여기서는 이어 붙이기만 한다.
fn link_base_dir(root: &Path, current_path: Option<&str>) -> PathBuf {
    let Some(current) = current_path
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return root.to_path_buf();
    };
    root.join(current)
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| root.to_path_buf())
}

/// `~/...`로 시작하는 가져오기 경로를 홈 기준 절대 경로로 바꾼다.
fn expand_home_prefix(href: &str, home: Option<&Path>) -> String {
    let trimmed = href.trim();
    let Some(home) = home else {
        return trimmed.to_owned();
    };
    match trimmed
        .strip_prefix("~/")
        .or_else(|| trimmed.strip_prefix("~\\"))
    {
        Some(rest) => home.join(rest).to_string_lossy().into_owned(),
        None => trimmed.to_owned(),
    }
}

// ---------------------------------------------------------------------------
// 앱 데이터 메타(자동 동기화)
// ---------------------------------------------------------------------------

const INSTRUCTION_META_FILE: &str = "instruction-meta.json";
const INSTRUCTION_META_VERSION: u32 = 1;

/// 배포 원장 한 줄. "이 원본을 이 위치에 우리가 놓았다"는 기록이고, 마지막으로
/// 써 넣은 내용의 지문을 함께 들고 있어 그 뒤 외부에서 고쳤는지 구분할 수 있다.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InstructionDeploymentRecord {
    provider: ProviderId,
    /// `SCOPE_PERSONAL` | `SCOPE_PROJECT`.
    scope: String,
    /// project 범위에서 파일이 놓인 디렉터리. personal은 공급자 홈에서 유도한다.
    #[serde(default)]
    project_path: Option<String>,
    /// 마지막으로 배포한 지침 파일의 지문.
    #[serde(default)]
    instruction_digest: Option<String>,
    /// 마지막으로 배포한 연결 문서의 상대 경로별 지문.
    #[serde(default)]
    linked_digests: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InstructionMetaEntry {
    #[serde(default)]
    auto_sync: bool,
    /// 이 지침의 배포 원장. 파일 존재가 아니라 이 목록이 배포 소유권의 근거다.
    #[serde(default)]
    deployments: Vec<InstructionDeploymentRecord>,
    /// 원장 도입 전 배포본을 한 번 훑어 옮겼는지. 한 번만 하는 이유는, 지문이
    /// 우연히 같은 남의 파일을 계속 배포로 끌어들이지 않기 위해서다.
    #[serde(default)]
    deployments_migrated: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InstructionMetaStore {
    #[serde(default)]
    version: u32,
    #[serde(default)]
    instructions: BTreeMap<String, InstructionMetaEntry>,
}

fn load_instruction_meta_store(app_data_dir: &Path) -> InstructionMetaStore {
    let path = app_data_dir.join(INSTRUCTION_META_FILE);
    let Ok(bytes) = fs::read(&path) else {
        return InstructionMetaStore::default();
    };
    serde_json::from_slice(&bytes).unwrap_or_default()
}

fn save_instruction_meta_store(
    app_data_dir: &Path,
    store: &InstructionMetaStore,
) -> Result<(), CoreError> {
    fs::create_dir_all(app_data_dir)?;
    let path = app_data_dir.join(INSTRUCTION_META_FILE);
    let temporary = app_data_dir.join(format!(".{INSTRUCTION_META_FILE}.{}.tmp", publish_nonce()));
    let mut next = store.clone();
    next.version = INSTRUCTION_META_VERSION;
    fs::write(&temporary, serde_json::to_vec_pretty(&next)?)?;
    if let Err(error) = fs::rename(&temporary, &path) {
        let _ = fs::remove_file(&temporary);
        return Err(CoreError::Io(error));
    }
    Ok(())
}

pub fn set_project_instruction_auto_sync(
    app_data_dir: &Path,
    key: &str,
    auto_sync: bool,
) -> Result<(), CoreError> {
    let key = validate_instruction_key(key)?;
    let mut store = load_instruction_meta_store(app_data_dir);
    store.instructions.entry(key).or_default().auto_sync = auto_sync;
    save_instruction_meta_store(app_data_dir, &store)
}

/// 배포 원장 손질 요청. 이미 그 위치에 있는 파일을 이 원본의 배포로 인정하거나, 잘못
/// 올라온 기록을 내린다. 파일 자체는 건드리지 않는다.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstructionDeploymentLinkRequest {
    pub key: String,
    /// "personal"이면 공급자 홈 설정 디렉터리, 그 외에는 projectPath가 필요하다.
    #[serde(default)]
    pub scope: Option<String>,
    #[serde(default)]
    pub project_path: Option<String>,
    pub provider: ProviderId,
}

/// 이미 그 위치에 있는 지침 파일을 이 원본의 배포로 등록한다. 원장 도입 전에 외부에서
/// 고쳐 이관되지 못한 배포본과, 사람이 직접 옮겨 놓은 파일을 다시 관리 대상으로
/// 되돌리는 유일한 경로다. 등록 시점의 내용을 "우리가 배포한 내용"으로 적어 두므로,
/// 다음 편집은 이 위치까지 함께 갱신한다.
pub fn attach_project_instruction_deployment(
    app_data_dir: &Path,
    sessions: &[SessionSummary],
    request: &InstructionDeploymentLinkRequest,
) -> Result<ProjectInstructionEntry, CoreError> {
    let projects = project_paths_from_sessions(sessions);
    let home = home_dir()?;
    let root = repository_instructions_root(app_data_dir);
    let key = validate_instruction_key(&request.key)?;
    let source_directory = root.join(&key);
    assert_within_root(&root, &source_directory)?;
    if !source_directory.is_dir() {
        return Err(CoreError::NotFound(format!("보관 원본이 없습니다: {key}")));
    }
    let manifest = validate_manifest(&source_directory)?;
    if !instruction_provider_present(&source_directory, &manifest, request.provider) {
        return Err(CoreError::InvalidInput(format!(
            "{} 공통 지침 파일이 없어 배포로 등록할 수 없습니다",
            request.provider
        )));
    }
    let (directory, scope) = resolve_deployment_dir(
        Some(&home),
        &projects,
        &ledger_project_dirs(app_data_dir),
        request.scope.as_deref(),
        request.project_path.as_deref(),
        request.provider,
    )?;
    let target = directory.join(instruction_file_name(request.provider));
    assert_within_root(&directory, &target)?;
    let (digest, _) = managed_deployment_file(&target)?;
    let linked = archived_linked_docs(&source_directory, &manifest);
    record_instruction_deployment(
        app_data_dir,
        &key,
        request.provider,
        scope,
        &directory,
        Some(digest),
        deployed_linked_digests(&directory, &linked),
    );
    let ledger = instruction_ledger(app_data_dir, &root, &key, Some(&home), &projects);
    read_entry_with_key(&source_directory, key, Some(&home), &projects, &ledger)
}

/// 배포 등록만 해제한다. 파일은 그 자리에 그대로 남고, 다음 편집부터 갱신 대상에서 빠진다.
pub fn detach_project_instruction_deployment(
    app_data_dir: &Path,
    sessions: &[SessionSummary],
    request: &InstructionDeploymentLinkRequest,
) -> Result<ProjectInstructionEntry, CoreError> {
    let projects = project_paths_from_sessions(sessions);
    let home = home_dir()?;
    let root = repository_instructions_root(app_data_dir);
    let key = validate_instruction_key(&request.key)?;
    let source_directory = root.join(&key);
    assert_within_root(&root, &source_directory)?;
    if !source_directory.is_dir() {
        return Err(CoreError::NotFound(format!("보관 원본이 없습니다: {key}")));
    }
    let (directory, scope) = resolve_deployment_dir(
        Some(&home),
        &projects,
        &ledger_project_dirs(app_data_dir),
        request.scope.as_deref(),
        request.project_path.as_deref(),
        request.provider,
    )?;
    forget_instruction_deployment(
        app_data_dir,
        Some(&key),
        request.provider,
        scope,
        &directory,
    );
    let ledger = instruction_ledger(app_data_dir, &root, &key, Some(&home), &projects);
    read_entry_with_key(&source_directory, key, Some(&home), &projects, &ledger)
}

// ---------------------------------------------------------------------------
// 배포 원장
// ---------------------------------------------------------------------------

/// 원장이 가리키는 배포 위치 한 곳.
#[derive(Debug, Clone)]
struct LedgerLocation {
    provider: ProviderId,
    scope: &'static str,
    directory: PathBuf,
    instruction_digest: Option<String>,
    linked_digests: BTreeMap<String, String>,
}

/// 한 지침의 배포 원장. 비교·재배포·삭제가 볼 수 있는 위치는 `locations`에 담긴 것뿐이다.
/// 설정에서 비활성화한 프로젝트의 기록은 `inactive`로 따로 두어 표시·재배포·채택·회수
/// 대상에서 빼되, 공유 삭제 미리보기가 "남겨둔다"고 알릴 수 있게 한다. 기록 자체는
/// 지우지 않으므로 프로젝트를 다시 켜면 그대로 돌아온다.
#[derive(Debug, Clone, Default)]
struct InstructionLedger {
    locations: Vec<LedgerLocation>,
    inactive: Vec<LedgerLocation>,
}

impl InstructionLedger {
    fn location(&self, provider: ProviderId, directory: &Path) -> Option<&LedgerLocation> {
        self.locations
            .iter()
            .find(|location| location.provider == provider && location.directory == directory)
    }

    fn contains(&self, provider: ProviderId, directory: &Path) -> bool {
        self.location(provider, directory).is_some()
    }

    fn for_provider(&self, provider: ProviderId) -> impl Iterator<Item = &LedgerLocation> {
        self.locations
            .iter()
            .filter(move |location| location.provider == provider)
    }

    /// 원장에만 있는(등록 프로젝트 목록에서 빠진) 위치까지 화면에 싣기 위한 목록.
    fn directories(&self) -> Vec<(ProviderId, PathBuf, &'static str)> {
        self.locations
            .iter()
            .map(|location| {
                (
                    location.provider,
                    location.directory.clone(),
                    location.scope,
                )
            })
            .collect()
    }
}

/// 원장 한 줄을 실제 디렉터리로 해석한다. personal은 공급자 홈 설정 디렉터리다.
fn record_directory(
    record: &InstructionDeploymentRecord,
    home: Option<&Path>,
) -> Option<(PathBuf, &'static str)> {
    if record.scope == SCOPE_PERSONAL {
        return home.map(|home| {
            (
                personal_instruction_dir(home, record.provider),
                SCOPE_PERSONAL,
            )
        });
    }
    let path = record.project_path.as_deref()?;
    let path = PathBuf::from(path);
    if !path.is_absolute() {
        return None;
    }
    Some((path, SCOPE_PROJECT))
}

/// 현재 OS 투영 기준 원본 지침 파일의 지문. 위치마다 다시 계산하지 않도록 한 번만 구한다.
fn projected_source_digest(
    source_directory: &Path,
    manifest: &ResourcePlatformManifest,
    provider: ProviderId,
) -> Option<String> {
    projected_instruction_file(source_directory, manifest, provider)
        .ok()
        .and_then(|path| digest_file(&path).ok())
}

/// 이 지침의 배포 원장을 읽는다. 파일이 사라진 기록은 지우고, 원장 도입 전 배포본은
/// 한 번만 훑어 옮긴다(지침 파일이 원본과 지문까지 같은 위치만 옮긴다. 그 사이 외부에서
/// 고친 배포본은 남의 파일과 구분할 방법이 없어 사용자가 직접 등록해야 한다).
fn instruction_ledger(
    app_data_dir: &Path,
    root: &Path,
    key: &str,
    home: Option<&Path>,
    projects: &[RegisteredProject],
) -> InstructionLedger {
    let mut store = load_instruction_meta_store(app_data_dir);
    let source_directory = root.join(key);
    // 원본이 없으면 manifest 기본값이 나오므로 디렉터리 존재를 먼저 본다. 보관취소로
    // 원본이 빠진 키를 "공급자 없는 원본"으로 읽어 기록을 지워 버리면 안 된다.
    let archived = source_directory
        .is_dir()
        .then(|| validate_manifest(&source_directory).ok())
        .flatten();
    let entry = store.instructions.entry(key.to_owned()).or_default();
    let mut dirty = false;

    // 실체가 사라진 기록과, 원본이 더는 갖지 않는 공급자의 기록을 원장에서 뺀다.
    let before = entry.deployments.len();
    entry.deployments.retain(|record| {
        if archived.as_ref().is_some_and(|manifest| {
            !instruction_provider_present(&source_directory, manifest, record.provider)
        }) {
            return false;
        }
        record_directory(record, home).is_some_and(|(directory, _)| {
            directory
                .join(instruction_file_name(record.provider))
                .is_file()
        })
    });
    dirty |= entry.deployments.len() != before;

    // 보관 원본이 없는 동안에는 이관을 마쳤다고 표시하지 않는다. 보관취소 뒤
    // 원본을 복구했을 때 내용이 같은 배포를 다시 찾아낼 기회가 남아야 한다.
    if !entry.deployments_migrated {
        if let Some(manifest) = archived.as_ref() {
            entry.deployments_migrated = true;
            dirty = true;
            let linked = archived_linked_docs(&source_directory, manifest);
            for provider in PROVIDERS {
                if !instruction_provider_present(&source_directory, manifest, provider) {
                    continue;
                }
                let Some(source_digest) =
                    projected_source_digest(&source_directory, manifest, provider)
                else {
                    continue;
                };
                for (directory, scope) in deployment_dirs_for_provider(home, projects, provider) {
                    let status = installed_deployment_status(provider, &directory, scope);
                    if status.message.is_some()
                        || status.content_digest.as_deref() != Some(source_digest.as_str())
                    {
                        continue;
                    }
                    entry.deployments.push(deployment_record(
                        provider,
                        scope,
                        &directory,
                        Some(source_digest.clone()),
                        deployed_linked_digests(&directory, &linked),
                    ));
                }
            }
        }
    }

    let excluded = crate::store::excluded_project_paths(app_data_dir).unwrap_or_default();
    let ledger = ledger_from_records(&entry.deployments, home, &excluded);
    if dirty {
        // 원장 정리는 화면을 여는 것만으로도 일어난다. 실패해도 읽기를 막지 않는다.
        let _ = save_instruction_meta_store(app_data_dir, &store);
    }
    ledger
}

fn ledger_from_records(
    records: &[InstructionDeploymentRecord],
    home: Option<&Path>,
    excluded_projects: &BTreeSet<PathBuf>,
) -> InstructionLedger {
    let mut locations: Vec<LedgerLocation> = Vec::new();
    let mut inactive: Vec<LedgerLocation> = Vec::new();
    for record in records {
        let Some((directory, scope)) = record_directory(record, home) else {
            continue;
        };
        let bucket =
            if scope == SCOPE_PROJECT && is_excluded_project_dir(&directory, excluded_projects) {
                &mut inactive
            } else {
                &mut locations
            };
        if bucket.iter().any(|existing: &LedgerLocation| {
            existing.provider == record.provider && existing.directory == directory
        }) {
            continue;
        }
        bucket.push(LedgerLocation {
            provider: record.provider,
            scope,
            directory,
            instruction_digest: record.instruction_digest.clone(),
            linked_digests: record.linked_digests.clone(),
        });
    }
    InstructionLedger {
        locations,
        inactive,
    }
}

/// 원장 디렉터리가 설정에서 비활성화한 프로젝트인지. 원장은 정규 경로를 적지만 디렉터리가
/// 사라져 정규화할 수 없는 경우까지 원문으로도 비교한다.
fn is_excluded_project_dir(directory: &Path, excluded_projects: &BTreeSet<PathBuf>) -> bool {
    if excluded_projects.is_empty() {
        return false;
    }
    excluded_projects.contains(directory)
        || fs::canonicalize(directory).is_ok_and(|canonical| excluded_projects.contains(&canonical))
}

fn deployment_record(
    provider: ProviderId,
    scope: &str,
    directory: &Path,
    instruction_digest: Option<String>,
    linked_digests: BTreeMap<String, String>,
) -> InstructionDeploymentRecord {
    InstructionDeploymentRecord {
        provider,
        scope: scope.to_owned(),
        project_path: (scope != SCOPE_PERSONAL).then(|| directory.to_string_lossy().into_owned()),
        instruction_digest,
        linked_digests,
    }
}

/// 배포 위치에 실제로 놓여 있는 연결 문서의 지문. 원장에 "우리가 써 넣은 내용"으로 남긴다.
fn deployed_linked_digests(directory: &Path, linked: &[String]) -> BTreeMap<String, String> {
    let mut digests = BTreeMap::new();
    for relative in linked {
        let path = directory.join(relative);
        if assert_within_root(directory, &path).is_err() {
            continue;
        }
        if let Ok(digest) = digest_file(&path) {
            digests.insert(relative.clone(), digest);
        }
    }
    digests
}

/// 배포 한 곳을 원장에 올린다(같은 위치가 이미 있으면 지문만 갱신).
fn record_instruction_deployment(
    app_data_dir: &Path,
    key: &str,
    provider: ProviderId,
    scope: &str,
    directory: &Path,
    instruction_digest: Option<String>,
    linked_digests: BTreeMap<String, String>,
) {
    let mut store = load_instruction_meta_store(app_data_dir);
    let entry = store.instructions.entry(key.to_owned()).or_default();
    // 원장을 처음 쓰는 지침이면 이관 대상이 아니다(이 배포부터가 기록의 시작이다).
    entry.deployments_migrated = true;
    let next = deployment_record(
        provider,
        scope,
        directory,
        instruction_digest,
        linked_digests,
    );
    match entry.deployments.iter_mut().find(|record| {
        record.provider == provider
            && record.scope == scope
            && record.project_path == next.project_path
    }) {
        Some(existing) => *existing = next,
        None => entry.deployments.push(next),
    }
    let _ = save_instruction_meta_store(app_data_dir, &store);
}

/// 휴지통에서 배포 지침 파일을 되살렸을 때 원장 기록도 되돌린다. 삭제로 지워진
/// 기록을 복구가 남겨 두면, 그 위치는 파일만 있고 등록은 없는 상태가 되어 이후 편집이
/// 지나쳐 버린다. 되살린 내용이 그대로 우리가 배포한 내용이므로 그 지문을 적는다.
pub(crate) fn readopt_restored_deployment(
    app_data_dir: &Path,
    key: &str,
    provider: ProviderId,
    scope: &str,
    directory: &Path,
) {
    let Ok(key) = validate_instruction_key(key) else {
        return;
    };
    let source_directory = repository_instructions_root(app_data_dir).join(&key);
    if !source_directory.is_dir() {
        return;
    }
    let Ok(manifest) = validate_manifest(&source_directory) else {
        return;
    };
    if !instruction_provider_present(&source_directory, &manifest, provider) {
        return;
    }
    let target = directory.join(instruction_file_name(provider));
    let Ok(digest) = digest_file(&target) else {
        return;
    };
    let linked = archived_linked_docs(&source_directory, &manifest);
    record_instruction_deployment(
        app_data_dir,
        &key,
        provider,
        scope,
        directory,
        Some(digest),
        deployed_linked_digests(directory, &linked),
    );
}

/// 배포 한 곳을 원장에서 뺀다. 키를 모르는 호출(배포 파일 삭제)은 모든 지침에서 지운다.
fn forget_instruction_deployment(
    app_data_dir: &Path,
    key: Option<&str>,
    provider: ProviderId,
    scope: &str,
    directory: &Path,
) {
    let mut store = load_instruction_meta_store(app_data_dir);
    let project_path = (scope != SCOPE_PERSONAL).then(|| directory.to_string_lossy().into_owned());
    let mut dirty = false;
    for (candidate, entry) in store.instructions.iter_mut() {
        if key.is_some_and(|key| key != candidate.as_str()) {
            continue;
        }
        let before = entry.deployments.len();
        entry.deployments.retain(|record| {
            !(record.provider == provider
                && record.scope == scope
                && record.project_path == project_path)
        });
        dirty |= entry.deployments.len() != before;
    }
    if dirty {
        let _ = save_instruction_meta_store(app_data_dir, &store);
    }
}

/// 원장에 남아 있는 프로젝트 디렉터리 전체. 세션 목록에서 빠진 프로젝트라도 이미
/// 배포한 곳이면 계속 다룰 수 있어야 한다(C5-3 예외). 설정에서 비활성화한 프로젝트는
/// 원장에 있어도 빼서, 다시 켜기 전까지는 어떤 지침 작업도 그 프로젝트를 건드리지 않는다.
fn ledger_project_dirs(app_data_dir: &Path) -> BTreeSet<PathBuf> {
    let excluded = crate::store::excluded_project_paths(app_data_dir).unwrap_or_default();
    load_instruction_meta_store(app_data_dir)
        .instructions
        .values()
        .flat_map(|entry| entry.deployments.iter())
        .filter(|record| record.scope != SCOPE_PERSONAL)
        .filter_map(|record| record.project_path.as_deref().map(PathBuf::from))
        .filter(|directory| !is_excluded_project_dir(directory, &excluded))
        .collect()
}

/// 공통 원본 삭제 시 장치 메타도 함께 정리한다.
fn remove_instruction_meta_entry(app_data_dir: &Path, key: &str) -> Result<(), CoreError> {
    let mut store = load_instruction_meta_store(app_data_dir);
    if store.instructions.remove(key).is_some() {
        save_instruction_meta_store(app_data_dir, &store)?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// 삭제(휴지통 경유)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstructionDeleteCheckRequest {
    /// 공통 원본과 일치하는 모든 배포본의 삭제 영향을 볼 때의 키.
    #[serde(default)]
    pub key: Option<String>,
    /// 배포 파일 하나를 볼 때의 위치. "personal"이면 projectPath가 필요 없다.
    #[serde(default)]
    pub scope: Option<String>,
    /// 프로젝트 배포 파일 하나의 삭제 영향을 볼 때의 프로젝트 경로.
    #[serde(default)]
    pub project_path: Option<String>,
    #[serde(default)]
    pub provider: Option<ProviderId>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstructionDeleteImpactItem {
    pub path: String,
    pub kind: InstructionTrashItemKind,
    pub provider: Option<ProviderId>,
    pub project_path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstructionDeleteImpact {
    pub key: String,
    /// 공통 저장소에 같은 키의 원본이 있는지. 배포 파일만 지우면 원본은 남는다.
    pub shared: bool,
    pub items: Vec<InstructionDeleteImpactItem>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteProjectInstructionDeploymentRequest {
    /// "personal"이면 projectPath 없이 공급자 홈 설정 파일을 지운다.
    #[serde(default)]
    pub scope: Option<String>,
    #[serde(default)]
    pub project_path: Option<String>,
    pub provider: ProviderId,
    /// 삭제 주체 표시용 값. `aia`만 별도 인정하고 나머지는 `user`로 기록한다.
    #[serde(default)]
    pub deleted_by: Option<String>,
    /// 확정 삭제 의사 표시. `check_project_instruction_delete`로 영향을 확인한 뒤 true로 보낸다.
    #[serde(default)]
    pub confirm: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteSharedProjectInstructionRequest {
    /// 공통 원본 키. 원본과 원본 내용 그대로인 배포 파일을 한 그룹으로 삭제한다.
    pub key: String,
    #[serde(default)]
    pub deleted_by: Option<String>,
    #[serde(default)]
    pub confirm: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnarchiveSharedProjectInstructionRequest {
    /// 보관 원본 키. 원본만 휴지통으로 옮기고 배포 파일은 그 자리에 남긴다.
    pub key: String,
    #[serde(default)]
    pub deleted_by: Option<String>,
    /// 확정 의사 표시. 배포가 없는 지침은 목록에서 사라지므로 UI가 먼저 알린다.
    #[serde(default)]
    pub confirm: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstructionDeleteReceipt {
    pub key: String,
    /// 휴지통 그룹 ID. 복구는 이 그룹 단위로 이루어진다.
    pub group_id: String,
    pub items: Vec<InstructionTrashItem>,
    pub warnings: Vec<String>,
}

fn normalized_instruction_delete_actor(value: Option<&str>) -> String {
    match value {
        Some("aia") => "aia".to_owned(),
        _ => "user".to_owned(),
    }
}

fn require_instruction_unarchive_confirm(confirm: bool) -> Result<(), CoreError> {
    if confirm {
        Ok(())
    } else {
        Err(CoreError::InvalidInput(
            "보관취소는 confirm: true를 함께 보내야 합니다. 배포가 없으면 목록에서 사라집니다"
                .to_owned(),
        ))
    }
}

fn require_instruction_delete_confirm(confirm: bool) -> Result<(), CoreError> {
    if confirm {
        Ok(())
    } else {
        Err(CoreError::InvalidInput(
            "삭제는 confirm: true를 함께 보내야 합니다. check_project_instruction_delete로 영향 범위를 먼저 확인하세요"
                .to_owned(),
        ))
    }
}

/// 배포 파일이 삭제 가능한 관리 대상(심볼릭 링크가 아닌 일반 파일)인지 확인하고
/// 내용 지문을 돌려준다.
fn managed_deployment_file(target: &Path) -> Result<(String, u64), CoreError> {
    let metadata = fs::symlink_metadata(target)
        .map_err(|_| CoreError::NotFound("프로젝트 지침 파일을 찾지 못했습니다".to_owned()))?;
    ensure_regular_file(
        &metadata,
        "심볼릭 링크나 일반 파일이 아닌 지침은 관리하지 않습니다",
    )?;
    Ok((digest_file(target)?, metadata.len()))
}

/// 배포 파일 내용이 어느 공통 원본에서 나왔는지 찾는다. 현재 OS 투영 기준으로
/// 지문이 같은 첫 원본 키를 돌려준다.
fn matching_entry_key(root: &Path, provider: ProviderId, digest: &str) -> Option<String> {
    let directories = fs::read_dir(root).ok()?;
    let mut names = directories
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            path.is_dir()
                && !path
                    .file_name()
                    .is_some_and(|name| name.to_string_lossy().starts_with('.'))
        })
        .collect::<Vec<_>>();
    names.sort();
    for directory in names {
        let Ok(manifest) = validate_manifest(&directory) else {
            continue;
        };
        let Ok(source) = projected_instruction_file(&directory, &manifest, provider) else {
            continue;
        };
        if digest_file(&source).ok().as_deref() == Some(digest) {
            return directory
                .file_name()
                .map(|name| name.to_string_lossy().into_owned());
        }
    }
    None
}

/// 공통 원본 삭제 시 함께 지울 배포 파일 수집. 원본 내용 그대로인 배포 파일만
/// 대상이고, 외부에서 수정된(divergent) 파일은 남기고 경고로 알린다.
/// 원본 삭제로 함께 지울 배포 한 곳. 지침 파일과 그 위치의 연결 문서를 같은
/// 휴지통 그룹으로 묶어야 되살릴 때도 세트로 돌아온다.
#[derive(Debug, Clone)]
struct SharedDeleteTarget {
    deployment: ProjectInstructionDeployment,
    linked: Vec<PathBuf>,
}

/// 배포 위치에서 이 원본과 같은 연결 문서들. 내용이 다르면 사람이 고친 것이라
/// 남기고 경고한다.
fn deployed_linked_doc_targets(
    entry_dir: &Path,
    manifest: &ResourcePlatformManifest,
    directory: &Path,
) -> (Vec<PathBuf>, Vec<String>) {
    let Ok(content) = validated_instruction_content(entry_dir) else {
        return (Vec::new(), Vec::new());
    };
    let mut targets = Vec::new();
    let mut warnings = Vec::new();
    for relative in archive_linked_doc_paths(&content, manifest) {
        let deployed = directory.join(&relative);
        if assert_within_root(directory, &deployed).is_err() {
            continue;
        }
        match fs::symlink_metadata(&deployed) {
            Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => {
                if same_file_content(&deployed, &entry_dir.join(&relative)) {
                    targets.push(deployed);
                } else {
                    warnings.push(format!(
                        "{}: 외부에서 수정된 연결 문서라 남겨둡니다",
                        deployed.display()
                    ));
                }
            }
            Ok(_) => warnings.push(format!(
                "{}: 관리하지 않는 연결 문서라 남겨둡니다",
                deployed.display()
            )),
            Err(_) => {}
        }
    }
    (targets, warnings)
}

/// 배포된 지침 파일 자체는 원본과 같은지. 세트 판정(`divergent`)과 달리 파일만 본다.
fn instruction_file_matches(deployment: &ProjectInstructionDeployment) -> bool {
    match (&deployment.content_digest, &deployment.source_digest) {
        (Some(installed), Some(source)) => installed == source,
        _ => false,
    }
}

/// 연결 문서 하나를 휴지통에 넣기 위한 항목 정보.
#[allow(clippy::too_many_arguments)]
fn linked_doc_trash_draft(
    key: &str,
    directory: &Path,
    scope: &str,
    provider: ProviderId,
    target: &Path,
    group_id: &str,
    actor: &str,
) -> Result<InstructionTrashItemDraft, CoreError> {
    let metadata = fs::symlink_metadata(target)?;
    let name = target
        .strip_prefix(directory)
        .map(normalized_relative)
        .unwrap_or_else(|_| instruction_file_name_from_path(target).unwrap_or_default());
    Ok(InstructionTrashItemDraft {
        group_id: group_id.to_owned(),
        key: key.to_owned(),
        kind: InstructionTrashItemKind::File,
        provider: Some(provider),
        scope: Some(scope.to_owned()),
        project_path: Some(directory.to_string_lossy().into_owned()),
        shared: true,
        deleted_by: actor.to_owned(),
        content_digest: digest_file(target).ok(),
        file_count: 1,
        total_bytes: metadata.len(),
        name,
        description: "지침이 함께 읽는 연결 문서".to_owned(),
    })
}

fn collect_shared_instruction_delete_targets(
    root: &Path,
    app_data_dir: &Path,
    home: Option<&Path>,
    projects: &[RegisteredProject],
    key: &str,
) -> Result<(PathBuf, Vec<SharedDeleteTarget>, Vec<String>), CoreError> {
    let key = validate_instruction_key(key)?;
    let directory = root.join(&key);
    assert_within_root(root, &directory)?;
    if !directory.is_dir() {
        return Err(CoreError::NotFound(format!(
            "'{key}' 공통 프로젝트 지침을 찾지 못했습니다"
        )));
    }
    let content = validated_instruction_content(&directory)?;
    let manifest = validate_manifest(&directory)?;
    let linked = archive_linked_doc_paths(&content, &manifest);
    let mut targets = Vec::new();
    let mut warnings = Vec::new();
    // 같은 위치에 여러 공급자 지침이 있으면 연결 문서가 겹친다. 한 번만 지운다.
    let mut seen_linked: BTreeSet<PathBuf> = BTreeSet::new();
    let ledger = instruction_ledger(app_data_dir, root, &key, home, projects);
    for provider in PROVIDERS {
        if !instruction_provider_present(&directory, &manifest, provider) {
            continue;
        }
        let source_digest = projected_source_digest(&directory, &manifest, provider);
        // 원장에 오른 위치만 함께 지운다. 파일 이름이 같다는 이유로 남의 지침을
        // 지우지 않기 위해서다.
        for recorded in ledger.for_provider(provider) {
            let (location, scope) = (recorded.directory.clone(), recorded.scope);
            let deployment = deployment_status(
                &directory,
                &manifest,
                provider,
                source_digest.as_deref(),
                &location,
                scope,
                &linked,
                true,
            );
            if !deployment.present {
                continue;
            }
            if deployment.message.is_some() {
                warnings.push(format!(
                    "{}: 관리하지 않는 지침이라 남겨둡니다",
                    deployment.file_path
                ));
                continue;
            }
            if deployment.divergent {
                warnings.push(format!(
                    "{}: {}라 남겨둡니다",
                    deployment.file_path,
                    if instruction_file_matches(&deployment) {
                        "연결 문서가 원본과 다른 지침이"
                    } else {
                        "외부에서 수정된 지침이"
                    }
                ));
                continue;
            }
            let (linked, linked_warnings) =
                deployed_linked_doc_targets(&directory, &manifest, &location);
            warnings.extend(linked_warnings);
            let linked = linked
                .into_iter()
                .filter(|path| seen_linked.insert(path.clone()))
                .collect();
            targets.push(SharedDeleteTarget { deployment, linked });
        }
    }
    // 비활성 프로젝트의 배포는 건드리지 않는다. 원본을 지우면 그 원장 기록도 함께 사라져
    // 다시 켠 뒤에는 "파일만 있는" 미관리 위치가 되므로 미리 알린다.
    for location in &ledger.inactive {
        warnings.push(format!(
            "{}: 비활성 프로젝트라 배포 파일은 남겨둡니다(원장 기록은 원본 삭제와 함께 사라집니다)",
            location
                .directory
                .join(instruction_file_name(location.provider))
                .display()
        ));
    }
    Ok((directory, targets, warnings))
}

/// 삭제 영향 확인. 파일을 쓰지 않는 읽기 작업이다. `projectPath`+`provider`는
/// 배포 파일 하나, `key`는 공통 원본과 일치하는 배포 파일 전체를 대상으로 본다.
pub fn check_project_instruction_delete(
    app_data_dir: &Path,
    sessions: &[SessionSummary],
    request: &InstructionDeleteCheckRequest,
) -> Result<InstructionDeleteImpact, CoreError> {
    let projects = project_paths_from_sessions(sessions);
    let home = home_dir()?;
    check_project_instruction_delete_from_paths(
        &repository_instructions_root(app_data_dir),
        app_data_dir,
        Some(&home),
        &projects,
        request,
    )
}

fn check_project_instruction_delete_from_paths(
    root: &Path,
    app_data_dir: &Path,
    home: Option<&Path>,
    projects: &[RegisteredProject],
    request: &InstructionDeleteCheckRequest,
) -> Result<InstructionDeleteImpact, CoreError> {
    match (&request.key, &request.provider) {
        (Some(key), None) => {
            let (directory, targets, warnings) =
                collect_shared_instruction_delete_targets(root, app_data_dir, home, projects, key)?;
            let mut items = targets
                .iter()
                .flat_map(|target| {
                    let deployment = &target.deployment;
                    std::iter::once(InstructionDeleteImpactItem {
                        path: deployment.file_path.clone(),
                        kind: InstructionTrashItemKind::File,
                        provider: Some(deployment.provider),
                        project_path: Some(deployment.project_path.clone()),
                    })
                    .chain(target.linked.iter().map(|path| {
                        InstructionDeleteImpactItem {
                            path: path.to_string_lossy().into_owned(),
                            kind: InstructionTrashItemKind::File,
                            provider: Some(deployment.provider),
                            project_path: Some(deployment.project_path.clone()),
                        }
                    }))
                })
                .collect::<Vec<_>>();
            items.push(InstructionDeleteImpactItem {
                path: directory.to_string_lossy().into_owned(),
                kind: InstructionTrashItemKind::Directory,
                provider: None,
                project_path: None,
            });
            Ok(InstructionDeleteImpact {
                key: validate_instruction_key(key)?,
                shared: true,
                items,
                warnings,
            })
        }
        (None, Some(provider)) => {
            let (directory, _scope) = resolve_deployment_dir(
                home,
                projects,
                &ledger_project_dirs(app_data_dir),
                request.scope.as_deref(),
                request.project_path.as_deref(),
                *provider,
            )?;
            let target = directory.join(instruction_file_name(*provider));
            let (digest, _) = managed_deployment_file(&target)?;
            let matched = matching_entry_key(root, *provider, &digest);
            Ok(InstructionDeleteImpact {
                key: matched
                    .clone()
                    .unwrap_or_else(|| instruction_file_name(*provider).to_owned()),
                shared: matched.is_some(),
                items: vec![InstructionDeleteImpactItem {
                    path: target.to_string_lossy().into_owned(),
                    kind: InstructionTrashItemKind::File,
                    provider: Some(*provider),
                    project_path: Some(directory.to_string_lossy().into_owned()),
                }],
                warnings: Vec::new(),
            })
        }
        _ => Err(CoreError::InvalidInput(
            "key 또는 (scope·projectPath)+provider 중 한 조합만 지정하세요".to_owned(),
        )),
    }
}

#[allow(clippy::too_many_arguments)]
fn deployment_trash_draft(
    root: &Path,
    directory: &Path,
    scope: &str,
    provider: ProviderId,
    target: &Path,
    group_id: &str,
    actor: &str,
    known_key: Option<&str>,
) -> Result<InstructionTrashItemDraft, CoreError> {
    let (digest, size) = managed_deployment_file(target)?;
    let matched = known_key
        .map(str::to_owned)
        .or_else(|| matching_entry_key(root, provider, &digest));
    Ok(InstructionTrashItemDraft {
        group_id: group_id.to_owned(),
        key: matched
            .clone()
            .unwrap_or_else(|| instruction_file_name(provider).to_owned()),
        kind: InstructionTrashItemKind::File,
        provider: Some(provider),
        scope: Some(scope.to_owned()),
        project_path: Some(directory.to_string_lossy().into_owned()),
        shared: matched.is_some(),
        deleted_by: actor.to_owned(),
        content_digest: Some(digest),
        file_count: 1,
        total_bytes: size,
        name: instruction_file_name(provider).to_owned(),
        description: String::new(),
    })
}

/// 프로젝트에 배포된 지침 파일 하나를 확정 삭제한다. 실체는 휴지통으로 이동해
/// 복구할 수 있고, 공통 원본은 남는다.
pub fn delete_project_instruction_deployment(
    app_data_dir: &Path,
    sessions: &[SessionSummary],
    request: &DeleteProjectInstructionDeploymentRequest,
) -> Result<InstructionDeleteReceipt, CoreError> {
    let projects = project_paths_from_sessions(sessions);
    let home = home_dir()?;
    delete_project_instruction_deployment_from_paths(
        &repository_instructions_root(app_data_dir),
        Some(&home),
        &projects,
        app_data_dir,
        request,
    )
}

fn delete_project_instruction_deployment_from_paths(
    root: &Path,
    home: Option<&Path>,
    projects: &[RegisteredProject],
    app_data_dir: &Path,
    request: &DeleteProjectInstructionDeploymentRequest,
) -> Result<InstructionDeleteReceipt, CoreError> {
    require_instruction_delete_confirm(request.confirm)?;
    let (directory, scope) = resolve_deployment_dir(
        home,
        projects,
        &ledger_project_dirs(app_data_dir),
        request.scope.as_deref(),
        request.project_path.as_deref(),
        request.provider,
    )?;
    let target = directory.join(instruction_file_name(request.provider));
    assert_within_root(&directory, &target)?;
    let actor = normalized_instruction_delete_actor(request.deleted_by.as_deref());
    let group_id = new_trash_group_id();
    let draft = deployment_trash_draft(
        root,
        &directory,
        scope,
        request.provider,
        &target,
        &group_id,
        &actor,
        None,
    )?;
    let key = draft.key.clone();
    // 지침 파일이 어느 원본과 같은지 알 때만 연결 문서도 함께 지운다. 그 원본이
    // 함께 보관한 문서만 대상이고, 사람이 고친 문서는 남는다.
    let entry_dir = root.join(&key);
    let (linked, mut warnings) = match (draft.shared, validate_manifest(&entry_dir)) {
        (true, Ok(manifest)) => deployed_linked_doc_targets(&entry_dir, &manifest, &directory),
        _ => (Vec::new(), Vec::new()),
    };
    let mut items = vec![store_instruction_trash_item(app_data_dir, &target, draft)?];
    // 파일이 사라졌으니 원장 기록도 남길 이유가 없다.
    forget_instruction_deployment(app_data_dir, None, request.provider, scope, &directory);
    for path in linked {
        let draft = linked_doc_trash_draft(
            &key,
            &directory,
            scope,
            request.provider,
            &path,
            &group_id,
            &actor,
        )?;
        match store_instruction_trash_item(app_data_dir, &path, draft) {
            Ok(item) => items.push(item),
            Err(error) => warnings.push(format!("{}: {error}", path.display())),
        }
    }
    Ok(InstructionDeleteReceipt {
        key,
        group_id,
        items,
        warnings,
    })
}

/// 공통 지침 원본을 통째로 삭제한다. 원본 내용 그대로인 배포 파일을 먼저, 원본을
/// 마지막에 옮기고 전부 한 휴지통 그룹으로 묶어 그룹 단위로 복구한다. 외부에서
/// 수정된 배포 파일은 남기고 경고로 알린다.
pub fn delete_shared_project_instruction(
    app_data_dir: &Path,
    sessions: &[SessionSummary],
    request: &DeleteSharedProjectInstructionRequest,
) -> Result<InstructionDeleteReceipt, CoreError> {
    let projects = project_paths_from_sessions(sessions);
    let home = home_dir()?;
    delete_shared_project_instruction_from_paths(
        &repository_instructions_root(app_data_dir),
        Some(&home),
        &projects,
        app_data_dir,
        request,
    )
}

fn delete_shared_project_instruction_from_paths(
    root: &Path,
    home: Option<&Path>,
    projects: &[RegisteredProject],
    app_data_dir: &Path,
    request: &DeleteSharedProjectInstructionRequest,
) -> Result<InstructionDeleteReceipt, CoreError> {
    require_instruction_delete_confirm(request.confirm)?;
    let (directory, targets, warnings) = collect_shared_instruction_delete_targets(
        root,
        app_data_dir,
        home,
        projects,
        &request.key,
    )?;
    let key = validate_instruction_key(&request.key)?;
    let actor = normalized_instruction_delete_actor(request.deleted_by.as_deref());
    let group_id = new_trash_group_id();

    let mut warnings = warnings;
    let mut items = Vec::new();
    for target_group in &targets {
        let deployment = &target_group.deployment;
        let location = PathBuf::from(&deployment.project_path);
        let target = PathBuf::from(&deployment.file_path);
        let draft = deployment_trash_draft(
            root,
            &location,
            &deployment.scope,
            deployment.provider,
            &target,
            &group_id,
            &actor,
            Some(&key),
        )?;
        // 지침 파일을 먼저 옮긴다. 연결 문서만 남는 순간이 있어도 지침이 없으므로
        // 아무도 반쪽 세트를 읽지 않는다.
        items.push(store_instruction_trash_item(app_data_dir, &target, draft)?);
        for path in &target_group.linked {
            let draft = linked_doc_trash_draft(
                &key,
                &location,
                &deployment.scope,
                deployment.provider,
                path,
                &group_id,
                &actor,
            )?;
            match store_instruction_trash_item(app_data_dir, path, draft) {
                Ok(item) => items.push(item),
                Err(error) => warnings.push(format!("{}: {error}", path.display())),
            }
        }
    }

    let meta = load_instruction_meta(&directory).unwrap_or_else(|| StoredInstructionMeta {
        schema_version: 1,
        name: key.clone(),
        description: String::new(),
    });
    let content = validated_instruction_content(&directory)?;
    items.push(store_instruction_trash_item(
        app_data_dir,
        &directory,
        InstructionTrashItemDraft {
            group_id: group_id.clone(),
            key: key.clone(),
            kind: InstructionTrashItemKind::Directory,
            provider: None,
            scope: None,
            project_path: None,
            shared: true,
            deleted_by: actor,
            content_digest: Some(content.digest),
            file_count: content.files.len(),
            total_bytes: content.total_bytes,
            name: meta.name,
            description: meta.description,
        },
    )?);

    // 원본 자체를 지웠으므로 장치 메타도 함께 정리한다.
    let _ = remove_instruction_meta_entry(app_data_dir, &key);

    Ok(InstructionDeleteReceipt {
        key,
        group_id,
        items,
        warnings,
    })
}

/// 보관만 취소한다. 배포된 지침 파일과 함께 놓인 연결 문서는 그 자리에 그대로
/// 두고 보관 원본만 휴지통으로 옮기므로, 지침은 다시 "미보관 파일"로 돌아가
/// 가져오기로 언제든 다시 보관할 수 있다.
pub fn unarchive_shared_project_instruction(
    app_data_dir: &Path,
    request: &UnarchiveSharedProjectInstructionRequest,
) -> Result<InstructionDeleteReceipt, CoreError> {
    unarchive_shared_project_instruction_in(
        &repository_instructions_root(app_data_dir),
        app_data_dir,
        request,
    )
}

fn unarchive_shared_project_instruction_in(
    root: &Path,
    app_data_dir: &Path,
    request: &UnarchiveSharedProjectInstructionRequest,
) -> Result<InstructionDeleteReceipt, CoreError> {
    require_instruction_unarchive_confirm(request.confirm)?;
    let key = validate_instruction_key(&request.key)?;
    let directory = root.join(&key);
    assert_within_root(root, &directory)?;
    if !directory.is_dir() {
        return Err(CoreError::NotFound(format!("보관 원본이 없습니다: {key}")));
    }
    let actor = normalized_instruction_delete_actor(request.deleted_by.as_deref());
    let group_id = new_trash_group_id();
    let meta = load_instruction_meta(&directory).unwrap_or_else(|| StoredInstructionMeta {
        schema_version: 1,
        name: key.clone(),
        description: String::new(),
    });
    let content = validated_instruction_content(&directory)?;
    let item = store_instruction_trash_item(
        app_data_dir,
        &directory,
        InstructionTrashItemDraft {
            group_id: group_id.clone(),
            key: key.clone(),
            kind: InstructionTrashItemKind::Directory,
            provider: None,
            scope: None,
            project_path: None,
            shared: true,
            deleted_by: actor,
            content_digest: Some(content.digest),
            file_count: content.files.len(),
            total_bytes: content.total_bytes,
            name: meta.name,
            description: meta.description,
        },
    )?;

    // 원본이 사라졌으므로 배포 원장도 함께 비운다. 남겨 두면 없는 원본을 가리키는
    // 기록이 되고, 복구했을 때는 원장이 비어 있어야 내용이 같은 배포를 다시 찾아낸다.
    let _ = remove_instruction_meta_entry(app_data_dir, &key);

    Ok(InstructionDeleteReceipt {
        key,
        group_id,
        items: vec![item],
        warnings: Vec::new(),
    })
}

// ---------------------------------------------------------------------------
// 동기화·편집
// ---------------------------------------------------------------------------

/// 원장에 오른 위치에만 원본을 재배포한다. 파일이 있다는 이유로 덮어쓰지 않는다.
/// 마지막으로 배포한 지문과 다른 위치는 그 사이 사람이 고친 것이므로 손대지 않고
/// 건너뛴다(C5-4). 그 위치는 "외부 수정 감지"에서 채택 여부를 사람이 정한다.
fn republish_provider_to_locations(
    source_directory: &Path,
    manifest: &ResourcePlatformManifest,
    provider: ProviderId,
    app_data_dir: &Path,
    key: &str,
    ledger: &InstructionLedger,
    skip_dir: Option<&Path>,
) -> Vec<ProjectInstructionDeployment> {
    let mut results = Vec::new();
    // 연결 문서까지 한 세트로 다시 보낸다.
    let linked = archived_linked_docs(source_directory, manifest);
    let source_digest = projected_source_digest(source_directory, manifest, provider);
    for recorded in ledger.for_provider(provider) {
        let location = recorded.directory.clone();
        let scope = recorded.scope;
        if skip_dir.is_some_and(|skip| skip == location) {
            continue;
        }
        let status = installed_deployment_status(provider, &location, scope);
        if !status.present {
            continue;
        }
        let target = location.join(instruction_file_name(provider));
        let mut deployment = deployment_status(
            source_directory,
            manifest,
            provider,
            source_digest.as_deref(),
            &location,
            scope,
            &linked,
            true,
        );
        if let Some(message) = deployment.message.clone() {
            results.push(deployment.concluded(InstructionPublishOutcome::Skipped, message));
            continue;
        }
        // 우리가 마지막으로 써 넣은 내용이 그대로 있을 때만 덮어쓴다.
        let published = recorded.instruction_digest.as_deref();
        if deployment.content_digest.as_deref() != published {
            results.push(deployment.concluded(
                InstructionPublishOutcome::Skipped,
                "이 위치의 지침 파일이 배포 후 외부에서 수정되어 덮어쓰지 않았습니다. 외부 수정 감지에서 처리하세요"
                    .to_owned(),
            ));
            continue;
        }
        let source = match projected_instruction_file(source_directory, manifest, provider) {
            Ok(path) => path,
            Err(error) => {
                results.push(
                    deployment.concluded(InstructionPublishOutcome::Skipped, error.to_string()),
                );
                continue;
            }
        };
        let linked_results = match publish_linked_docs(
            source_directory,
            &linked,
            &location,
            SkillOverwritePolicy::Replace,
            Some(&recorded.linked_digests),
        ) {
            Ok(linked) => linked,
            Err(error) => {
                results.push(deployment.concluded(
                    InstructionPublishOutcome::Failed,
                    format!("연결 문서를 게시하지 못했습니다: {error}"),
                ));
                continue;
            }
        };
        match publish_instruction_file(&location, &source, &target, SkillOverwritePolicy::Replace) {
            Ok(outcome) => {
                record_instruction_deployment(
                    app_data_dir,
                    key,
                    provider,
                    scope,
                    &location,
                    digest_file(&target).ok(),
                    published_linked_digests(&location, &linked_results),
                );
                deployment = deployment_status(
                    source_directory,
                    manifest,
                    provider,
                    source_digest.as_deref(),
                    &location,
                    scope,
                    &linked,
                    true,
                );
                deployment.outcome = Some(outcome);
            }
            Err(error) => {
                deployment =
                    deployment.concluded(InstructionPublishOutcome::Failed, error.to_string());
            }
        }
        deployment.linked_results = linked_results;
        results.push(deployment);
    }
    results
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncProjectInstructionRequest {
    pub key: String,
    /// 채택할 배포 파일의 위치. "personal"이면 projectPath가 필요 없다.
    #[serde(default)]
    pub scope: Option<String>,
    /// 새 원본으로 채택할 배포 파일이 있는 프로젝트.
    #[serde(default)]
    pub project_path: Option<String>,
    pub provider: ProviderId,
    #[serde(default)]
    pub deleted_by: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstructionSyncReceipt {
    pub key: String,
    pub provider: ProviderId,
    /// 채택한 배포 파일 경로.
    pub adopted_from: String,
    /// 교체 전 원본이 이동한 휴지통 항목 ID.
    pub previous_source_trash_id: Option<String>,
    pub source_digest: String,
    /// 나머지 배포 위치 재배포 결과.
    pub results: Vec<ProjectInstructionDeployment>,
}

/// 외부에서 수정된 배포 파일을 공통 원본의 해당 공급자 지침으로 채택하고, 그
/// 공급자 지침이 배포된 나머지 프로젝트에 재배포한다. 교체되는 이전 원본은
/// 휴지통으로 옮겨 복구할 수 있다.
pub fn sync_project_instruction_from_deployment(
    app_data_dir: &Path,
    sessions: &[SessionSummary],
    request: &SyncProjectInstructionRequest,
) -> Result<InstructionSyncReceipt, CoreError> {
    let projects = project_paths_from_sessions(sessions);
    let home = home_dir()?;
    sync_project_instruction_from_deployment_from_paths(
        &repository_instructions_root(app_data_dir),
        Some(&home),
        &projects,
        app_data_dir,
        request,
    )
}

fn sync_project_instruction_from_deployment_from_paths(
    root: &Path,
    home: Option<&Path>,
    projects: &[RegisteredProject],
    app_data_dir: &Path,
    request: &SyncProjectInstructionRequest,
) -> Result<InstructionSyncReceipt, CoreError> {
    let key = validate_instruction_key(&request.key)?;
    let (adopted_dir, adopted_scope) = resolve_deployment_dir(
        home,
        projects,
        &ledger_project_dirs(app_data_dir),
        request.scope.as_deref(),
        request.project_path.as_deref(),
        request.provider,
    )?;
    let source_dir = root.join(&key);
    assert_within_root(root, &source_dir)?;
    if !source_dir.is_dir() {
        return Err(CoreError::NotFound(format!("보관 원본이 없습니다: {key}")));
    }
    let adopted_path = adopted_dir.join(instruction_file_name(request.provider));
    managed_deployment_file(&adopted_path)?;
    let adopted_bytes = fs::read(&adopted_path)?;
    let adopted_text = String::from_utf8(adopted_bytes)
        .map_err(|_| CoreError::InvalidInput("지침 파일은 UTF-8 텍스트여야 합니다".to_owned()))?;
    validate_instruction_text(&adopted_text)?;

    let content = validated_instruction_content(&source_dir)?;
    let manifest = validate_manifest(&source_dir)?;
    // 현재 OS 투영이 읽는 자리(변형이 있으면 변형 파일)에 채택본을 쓴다.
    let projected = projected_instruction_file(&source_dir, &manifest, request.provider)?;
    let relative = projected
        .strip_prefix(&source_dir)
        .map_err(|_| CoreError::InvalidInput("지침 투영 경로를 확인할 수 없습니다".to_owned()))?
        .to_path_buf();

    // 채택은 배포본을 그대로 원본으로 삼는 일이라 연결 문서도 그 위치가 기준이다.
    // 더 이상 참조하지 않는 문서는 함께 사라진다.
    let reserved = reserved_archive_paths(Some(&manifest));
    let (adopted_docs, _issues) =
        collect_deployed_linked_docs(&adopted_dir, &adopted_text, &reserved);
    ensure_archive_capacity(adopted_text.len() as u64, &adopted_docs)?;

    let staging = SourceStage::create(root, &key)?;
    let stage = staging.stage.clone();
    let staged = (|| -> Result<String, CoreError> {
        // 원본 구조(공급자 지침 파일·메타·플랫폼 변형)만 옮기고, 연결 문서는
        // 채택본이 참조하는 세트로 새로 쓴다.
        copy_source_files(&source_dir, &content.files, &stage, |relative| {
            is_reserved_archive_path(&normalized_relative(relative), &reserved)
        })?;
        write_linked_docs(&stage, &adopted_docs)?;
        let target = stage.join(&relative);
        assert_within_root(&stage, &target)?;
        fs::write(&target, &adopted_text)?;
        Ok(validated_instruction_content(&stage)?.digest)
    })();
    let new_digest = staging.finish(&source_dir, staged)?;

    // 이전 원본을 휴지통으로 옮긴다. 교체가 실패하면 되살린다.
    let actor = normalized_instruction_delete_actor(request.deleted_by.as_deref());
    let meta = load_instruction_meta(&source_dir).unwrap_or_else(|| StoredInstructionMeta {
        schema_version: 1,
        name: key.clone(),
        description: String::new(),
    });
    let trash_item = store_instruction_trash_item(
        app_data_dir,
        &source_dir,
        InstructionTrashItemDraft {
            group_id: new_trash_group_id(),
            key: key.clone(),
            kind: InstructionTrashItemKind::Directory,
            provider: None,
            scope: None,
            project_path: None,
            shared: true,
            deleted_by: actor,
            content_digest: Some(content.digest.clone()),
            file_count: content.files.len(),
            total_bytes: content.total_bytes,
            name: meta.name,
            description: meta.description,
        },
    )?;
    let swapped = StagedReplace {
        kind: StagedKind::Directory,
        stage: &stage,
        target: &source_dir,
        backup: None,
    }
    .commit();
    if let Err(error) = swapped {
        let _ = restore_instruction_trash(app_data_dir, &trash_item.id);
        return Err(error);
    }

    let manifest = validate_manifest(&source_dir)?;
    // 채택본이 새 원본이 되었으므로 그 위치는 원장에 오른 배포로 확정한다.
    let adopted_linked = archived_linked_docs(&source_dir, &manifest);
    record_instruction_deployment(
        app_data_dir,
        &key,
        request.provider,
        adopted_scope,
        &adopted_dir,
        digest_file(&adopted_path).ok(),
        deployed_linked_digests(&adopted_dir, &adopted_linked),
    );
    let ledger = instruction_ledger(app_data_dir, root, &key, home, projects);
    let results = republish_provider_to_locations(
        &source_dir,
        &manifest,
        request.provider,
        app_data_dir,
        &key,
        &ledger,
        Some(&adopted_dir),
    );

    Ok(InstructionSyncReceipt {
        key,
        provider: request.provider,
        adopted_from: adopted_path.to_string_lossy().into_owned(),
        previous_source_trash_id: Some(trash_item.id),
        source_digest: new_digest,
        results,
    })
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateProjectInstructionRequest {
    pub key: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    /// base 원본에 쓸 공급자별 지침 파일. 새 공급자 파일 추가도 허용한다.
    #[serde(default)]
    pub files: Vec<InstructionProviderFileWrite>,
    /// base 원본에서 제거할 공급자 지침 파일. 배포된 프로젝트 파일은 지우지 않는다.
    #[serde(default)]
    pub deletes: Vec<ProviderId>,
    /// 낙관적 잠금. 현재 원본 내용 지문과 다르면 실패한다.
    pub expected_digest: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstructionUpdateReceipt {
    pub key: String,
    pub source_digest: String,
    /// 저장 직후 변경 공급자 지침이 배포된 프로젝트 재배포 결과.
    pub results: Vec<ProjectInstructionDeployment>,
}

/// 공통 지침 원본의 base 파일과 표시 메타를 편집하고, 변경한 공급자 지침이 이미
/// 배포된 프로젝트에 즉시 재배포한다. OS 변형 편집은 전용 작업으로만 한다.
pub fn update_project_instruction(
    app_data_dir: &Path,
    sessions: &[SessionSummary],
    request: &UpdateProjectInstructionRequest,
) -> Result<InstructionUpdateReceipt, CoreError> {
    let projects = project_paths_from_sessions(sessions);
    let home = home_dir()?;
    update_project_instruction_from_paths(
        &repository_instructions_root(app_data_dir),
        app_data_dir,
        Some(&home),
        &projects,
        request,
    )
}

fn update_project_instruction_from_paths(
    root: &Path,
    app_data_dir: &Path,
    home: Option<&Path>,
    projects: &[RegisteredProject],
    request: &UpdateProjectInstructionRequest,
) -> Result<InstructionUpdateReceipt, CoreError> {
    let key = validate_instruction_key(&request.key)?;
    if request.files.is_empty()
        && request.deletes.is_empty()
        && request.name.is_none()
        && request.description.is_none()
    {
        return Err(CoreError::InvalidInput("변경 내용이 없습니다".to_owned()));
    }
    let mut seen = BTreeSet::new();
    for file in &request.files {
        if !seen.insert(file.provider) {
            return Err(CoreError::InvalidInput(format!(
                "{} 지침 파일이 중복되었습니다",
                file.provider
            )));
        }
        if request.deletes.contains(&file.provider) {
            return Err(CoreError::InvalidInput(format!(
                "{} 지침을 쓰기와 삭제에 동시에 지정할 수 없습니다",
                file.provider
            )));
        }
        validate_instruction_text(&file.content)?;
    }

    let source_dir = root.join(&key);
    assert_within_root(root, &source_dir)?;
    if !source_dir.is_dir() {
        return Err(CoreError::NotFound(format!(
            "보관 원본을 찾지 못했습니다: {key}"
        )));
    }
    let current = validated_instruction_content(&source_dir)?;
    if current.digest != request.expected_digest {
        return Err(CoreError::Conflict(
            "원본이 다른 곳에서 수정되었습니다. 새로고침 후 다시 편집하세요".to_owned(),
        ));
    }
    let current_meta =
        load_instruction_meta(&source_dir).unwrap_or_else(|| StoredInstructionMeta {
            schema_version: 1,
            name: key.clone(),
            description: String::new(),
        });
    let name = validate_name(request.name.as_deref().unwrap_or(&current_meta.name), &key)?;
    let description = validate_description(
        request
            .description
            .as_deref()
            .unwrap_or(&current_meta.description),
    )?;

    let staging = SourceStage::create(root, &key)?;
    let stage = staging.stage.clone();
    let backup = staging.backup.clone();
    let staged = (|| -> Result<String, CoreError> {
        copy_source_files(&source_dir, &current.files, &stage, |_| true)?;
        for provider in &request.deletes {
            let target = stage.join(instruction_file_name(*provider));
            if fs::symlink_metadata(&target).is_ok() {
                fs::remove_file(&target)?;
            }
        }
        for file in &request.files {
            fs::write(
                stage.join(instruction_file_name(file.provider)),
                &file.content,
            )?;
        }
        write_instruction_meta(&stage, &name, &description)?;
        let result = validated_instruction_content(&stage)?;
        let manifest = validate_manifest(&stage)?;
        if !PROVIDERS
            .into_iter()
            .any(|provider| instruction_provider_present(&stage, &manifest, provider))
        {
            return Err(CoreError::InvalidInput(
                "공급자 지침 파일이 하나도 남지 않아 저장할 수 없습니다".to_owned(),
            ));
        }
        Ok(result.digest)
    })();
    let staged = staged.and_then(|digest| {
        if validated_instruction_content(&source_dir)?.digest != request.expected_digest {
            return Err(CoreError::Conflict(
                "지침 원본이 편집 중 변경되었습니다. 다시 시도하세요".to_owned(),
            ));
        }
        StagedReplace {
            kind: StagedKind::Directory,
            stage: &stage,
            target: &source_dir,
            backup: Some(&backup),
        }
        .commit()?;
        Ok(digest)
    });
    let new_digest = staging.finish(&source_dir, staged)?;
    let _ = fs::remove_dir_all(&backup);

    let manifest = validate_manifest(&source_dir)?;
    let ledger = instruction_ledger(app_data_dir, root, &key, home, projects);
    let mut results = Vec::new();
    for file in &request.files {
        results.extend(republish_provider_to_locations(
            &source_dir,
            &manifest,
            file.provider,
            app_data_dir,
            &key,
            &ledger,
            None,
        ));
    }

    Ok(InstructionUpdateReceipt {
        key,
        source_digest: new_digest,
        results,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{SessionMeta, TokenUsage};

    fn registered(path: &Path, providers: &[ProviderId]) -> RegisteredProject {
        RegisteredProject {
            path: fs::canonicalize(path).expect("canonical project"),
            providers: providers.iter().copied().collect(),
        }
    }

    fn session(
        id: &str,
        source: ProviderId,
        cwd: &Path,
        hidden: bool,
        aia_workspace: bool,
    ) -> SessionSummary {
        SessionSummary {
            source,
            id: id.to_owned(),
            title: id.to_owned(),
            source_title: None,
            project: None,
            cwd: Some(cwd.to_string_lossy().into_owned()),
            started_at: None,
            updated_at: None,
            message_count: None,
            token_total: None,
            token_usage: None::<TokenUsage>,
            model: None,
            git_branch: None,
            is_subagent: false,
            aia_workspace,
            archived: false,
            readable: true,
            size_bytes: None,
            file_path: String::new(),
            meta: SessionMeta {
                hidden,
                ..SessionMeta::default()
            },
            last_failure: None,
        }
    }

    #[test]
    fn projects_come_from_all_provider_sessions_and_exclude_hidden_or_aia() {
        let temp = tempfile::tempdir().expect("temp");
        let shared = temp.path().join("shared");
        let hidden = temp.path().join("hidden");
        let aia = temp.path().join("aia-workspace");
        for path in [&shared, &hidden, &aia] {
            fs::create_dir(path).expect("project");
        }
        let sessions = vec![
            session("claude", ProviderId::Claude, &shared, false, false),
            session("codex", ProviderId::Codex, &shared, false, false),
            session("hidden", ProviderId::Codex, &hidden, true, false),
            session("aia", ProviderId::Antigravity, &aia, false, true),
        ];
        let projects = project_paths_from_sessions(&sessions);
        assert_eq!(projects.len(), 1);
        assert_eq!(
            projects[0].providers,
            BTreeSet::from([ProviderId::Claude, ProviderId::Codex])
        );
    }

    #[test]
    fn create_lists_portable_provider_instruction() {
        let temp = tempfile::tempdir().expect("temp");
        let root = temp.path().join("instructions");
        let entry = create_project_instruction_in_root(
            &root,
            &CreateProjectInstructionRequest {
                key: "team-default".to_owned(),
                name: "팀 기본 지침".to_owned(),
                description: "세 공급자가 공유하는 지침".to_owned(),
                files: vec![InstructionProviderFileWrite {
                    provider: ProviderId::Codex,
                    content: "# AGENTS\n\n테스트 우선\n".to_owned(),
                }],
                platforms: Vec::new(),
            },
        )
        .expect("create");
        assert_eq!(entry.providers, vec![ProviderId::Codex]);
        assert!(entry.current_platform_supported);
        assert!(root.join("team-default/AGENTS.md").is_file());
        assert!(!resource_manifest_path(&root.join("team-default")).exists());
    }

    #[test]
    fn import_requires_unified_registered_project_and_refuses_conflict() {
        let temp = tempfile::tempdir().expect("temp");
        let project = temp.path().join("project");
        let root = temp.path().join("instructions");
        fs::create_dir(&project).expect("project");
        fs::write(project.join("CLAUDE.md"), "# Claude\n").expect("instruction");
        let projects = vec![registered(&project, &[ProviderId::Claude])];
        let request = ImportProjectInstructionRequest {
            key: "imported".to_owned(),
            scope: None,
            project_path: Some(project.to_string_lossy().into_owned()),
            provider: ProviderId::Claude,
            name: None,
            description: None,
            linked_files: None,
        };
        let entry = import_project_instruction_from_paths(
            &root,
            &app_data_of(&root),
            None,
            &projects,
            &request,
        )
        .expect("import");
        assert_eq!(entry.providers, vec![ProviderId::Claude]);
        assert!(matches!(
            import_project_instruction_from_paths(
                &root,
                &app_data_of(&root),
                None,
                &projects,
                &request
            ),
            Err(CoreError::Conflict(_))
        ));
    }

    #[test]
    fn unified_project_can_receive_an_instruction_for_another_provider() {
        let temp = tempfile::tempdir().expect("temp");
        let project = temp.path().join("project");
        let root = temp.path().join("instructions");
        fs::create_dir(&project).expect("project");
        create_project_instruction_in_root(
            &root,
            &CreateProjectInstructionRequest {
                key: "cross-provider".to_owned(),
                name: "공급자 공통".to_owned(),
                description: String::new(),
                files: vec![InstructionProviderFileWrite {
                    provider: ProviderId::Antigravity,
                    content: "# GEMINI\n".to_owned(),
                }],
                platforms: Vec::new(),
            },
        )
        .expect("create");
        let projects = vec![registered(&project, &[ProviderId::Codex])];

        let receipt = publish_project_instruction_from_paths(
            &root,
            &app_data_of(&root),
            None,
            &projects,
            &PublishProjectInstructionRequest {
                key: "cross-provider".to_owned(),
                scope: None,
                project_path: Some(project.to_string_lossy().into_owned()),
                providers: vec![ProviderId::Antigravity],
                overwrite: SkillOverwritePolicy::Fail,
            },
        )
        .expect("publish");

        assert_eq!(
            receipt.results[0].outcome,
            Some(InstructionPublishOutcome::Published)
        );
        assert_eq!(
            fs::read_to_string(project.join("GEMINI.md")).unwrap(),
            "# GEMINI\n"
        );
        let library = load_project_instruction_library_from_paths(
            &root,
            &app_data_of(&root),
            None,
            &projects,
        )
        .expect("library");
        assert!(library.deployments.iter().any(|deployment| {
            deployment.provider == ProviderId::Antigravity && deployment.present
        }));
    }

    #[test]
    fn publish_needs_replace_and_then_atomically_replaces() {
        let temp = tempfile::tempdir().expect("temp");
        let project = temp.path().join("project");
        let root = temp.path().join("instructions");
        fs::create_dir(&project).expect("project");
        create_project_instruction_in_root(
            &root,
            &CreateProjectInstructionRequest {
                key: "shared".to_owned(),
                name: "공통".to_owned(),
                description: String::new(),
                files: vec![InstructionProviderFileWrite {
                    provider: ProviderId::Codex,
                    content: "new\n".to_owned(),
                }],
                platforms: Vec::new(),
            },
        )
        .expect("create");
        fs::write(project.join("AGENTS.md"), "old\n").expect("old");
        let projects = vec![registered(&project, &[ProviderId::Codex])];
        let skipped = publish_project_instruction_from_paths(
            &root,
            &app_data_of(&root),
            None,
            &projects,
            &PublishProjectInstructionRequest {
                key: "shared".to_owned(),
                scope: None,
                project_path: Some(project.to_string_lossy().into_owned()),
                providers: vec![ProviderId::Codex],
                overwrite: SkillOverwritePolicy::Fail,
            },
        )
        .expect("skip receipt");
        assert_eq!(
            skipped.results[0].outcome,
            Some(InstructionPublishOutcome::Skipped)
        );
        assert_eq!(
            fs::read_to_string(project.join("AGENTS.md")).unwrap(),
            "old\n"
        );

        let replaced = publish_project_instruction_from_paths(
            &root,
            &app_data_of(&root),
            None,
            &projects,
            &PublishProjectInstructionRequest {
                key: "shared".to_owned(),
                scope: None,
                project_path: Some(project.to_string_lossy().into_owned()),
                providers: vec![ProviderId::Codex],
                overwrite: SkillOverwritePolicy::Replace,
            },
        )
        .expect("replace receipt");
        assert_eq!(
            replaced.results[0].outcome,
            Some(InstructionPublishOutcome::Replaced)
        );
        assert_eq!(
            fs::read_to_string(project.join("AGENTS.md")).unwrap(),
            "new\n"
        );
    }

    #[test]
    fn unsupported_platform_blocks_publish() {
        let temp = tempfile::tempdir().expect("temp");
        let project = temp.path().join("project");
        let root = temp.path().join("instructions");
        fs::create_dir(&project).expect("project");
        let unsupported = match HostPlatform::current() {
            HostPlatform::Macos => HostPlatform::Windows,
            HostPlatform::Windows | HostPlatform::Linux => HostPlatform::Macos,
        };
        create_project_instruction_in_root(
            &root,
            &CreateProjectInstructionRequest {
                key: "foreign".to_owned(),
                name: "다른 OS".to_owned(),
                description: String::new(),
                files: vec![InstructionProviderFileWrite {
                    provider: ProviderId::Claude,
                    content: "foreign\n".to_owned(),
                }],
                platforms: vec![unsupported],
            },
        )
        .expect("create");
        let projects = vec![registered(&project, &[ProviderId::Claude])];
        let result = publish_project_instruction_from_paths(
            &root,
            &app_data_of(&root),
            None,
            &projects,
            &PublishProjectInstructionRequest {
                key: "foreign".to_owned(),
                scope: None,
                project_path: Some(project.to_string_lossy().into_owned()),
                providers: vec![ProviderId::Claude],
                overwrite: SkillOverwritePolicy::Fail,
            },
        );
        assert!(matches!(result, Err(CoreError::InvalidInput(_))));
        assert!(!project.join("CLAUDE.md").exists());
    }

    #[test]
    fn platform_variant_is_saved_without_executing_content() {
        let data = tempfile::tempdir().expect("data");
        let created = create_project_instruction(
            data.path(),
            &CreateProjectInstructionRequest {
                key: "portable-command".to_owned(),
                name: "명령 지침".to_owned(),
                description: String::new(),
                files: vec![InstructionProviderFileWrite {
                    provider: ProviderId::Codex,
                    content: "# Base\n".to_owned(),
                }],
                platforms: Vec::new(),
            },
        )
        .expect("create");
        let target = match HostPlatform::current() {
            HostPlatform::Windows => HostPlatform::Linux,
            HostPlatform::Macos | HostPlatform::Linux => HostPlatform::Windows,
        };
        let plan = get_project_instruction_migration_plan(data.path(), "portable-command", target)
            .expect("plan");
        assert!(!plan.automatic_execution);
        let source_file =
            read_project_instruction_file(data.path(), "portable-command", ProviderId::Codex)
                .expect("source file");
        assert_eq!(source_file.content, "# Base\n");
        assert_eq!(source_file.source_variant, None);
        let updated = save_project_instruction_platform_variant(
            data.path(),
            &SaveProjectInstructionPlatformVariantRequest {
                key: "portable-command".to_owned(),
                target_platform: target,
                source_platform: Some(HostPlatform::current()),
                files: vec![InstructionProviderFileWrite {
                    provider: ProviderId::Codex,
                    content: "# Variant\n\nDo not execute this text.\n".to_owned(),
                }],
                expected_digest: created.source_digest,
            },
        )
        .expect("save variant");
        assert_eq!(updated.platforms, vec![HostPlatform::current()]);
        let variant = data
            .path()
            .join("resource-repository/instructions/portable-command/.agent-manager/variants")
            .join(target.as_str())
            .join("AGENTS.md");
        assert_eq!(
            fs::read_to_string(variant).expect("variant"),
            "# Variant\n\nDo not execute this text.\n"
        );
    }

    #[test]
    fn instruction_supported_platform_metadata_requires_the_current_digest() {
        let data = tempfile::tempdir().expect("data");
        let created = create_project_instruction(
            data.path(),
            &CreateProjectInstructionRequest {
                key: "platform-meta".to_owned(),
                name: "플랫폼 지침".to_owned(),
                description: String::new(),
                files: vec![InstructionProviderFileWrite {
                    provider: ProviderId::Codex,
                    content: "# Base\n".to_owned(),
                }],
                platforms: Vec::new(),
            },
        )
        .expect("create");

        let updated = set_project_instruction_platforms(
            data.path(),
            &SetProjectInstructionPlatformsRequest {
                key: "platform-meta".to_owned(),
                platforms: vec![HostPlatform::Linux, HostPlatform::Linux],
                expected_digest: created.source_digest.clone(),
            },
        )
        .expect("set platforms");

        assert_eq!(updated.platforms, vec![HostPlatform::Linux]);
        assert!(matches!(
            set_project_instruction_platforms(
                data.path(),
                &SetProjectInstructionPlatformsRequest {
                    key: "platform-meta".to_owned(),
                    platforms: vec![HostPlatform::Windows],
                    expected_digest: created.source_digest,
                },
            ),
            Err(CoreError::Conflict(_))
        ));
    }

    /// C5-10 남의 지침 파일은 이 원본의 배포가 아니다. 파일 이름이 공급자당 고정이라
    /// 존재만으로 배포로 보면, 보관만 해 둔 지침이 등록된 모든 프로젝트의 지침을
    /// "외부 수정"으로 잡고 편집 한 번에 전부 덮어쓴다.
    #[test]
    fn unregistered_instruction_files_are_neither_divergent_nor_overwritten() {
        let temp = tempfile::tempdir().expect("temp");
        let root = temp.path().join("instructions");
        let stranger = temp.path().join("stranger");
        fs::create_dir(&stranger).expect("stranger");
        fs::write(stranger.join("AGENTS.md"), "# 남의 지침\n").expect("stranger file");
        fs::write(stranger.join("CLAUDE.md"), "# 남의 Claude 지침\n").expect("stranger claude");
        let projects = vec![registered(&stranger, &[ProviderId::Codex])];
        create_codex_instruction(&root, "archived", "# AGENTS\n");

        let library = load_project_instruction_library_from_paths(
            &root,
            &app_data_of(&root),
            None,
            &projects,
        )
        .expect("library");
        let row = library.entries[0]
            .deployments
            .iter()
            .find(|deployment| deployment.provider == ProviderId::Codex && deployment.present)
            .expect("stranger row");
        assert!(row.present, "파일은 있다고 보여야 한다");
        assert!(!row.managed, "원장에 없으니 이 원본의 배포가 아니다");
        assert!(!row.divergent, "배포가 아니면 외부 수정으로 잡히지 않는다");
        assert!(
            !library.entries[0]
                .deployments
                .iter()
                .any(|deployment| deployment.provider == ProviderId::Claude),
            "원본이 갖지 않은 공급자는 배포 행 자체가 없다"
        );

        let receipt = update_project_instruction_from_paths(
            &root,
            &app_data_of(&root),
            None,
            &projects,
            &UpdateProjectInstructionRequest {
                key: "archived".to_owned(),
                name: None,
                description: None,
                files: vec![InstructionProviderFileWrite {
                    provider: ProviderId::Codex,
                    content: "# 편집한 원본\n".to_owned(),
                }],
                deletes: Vec::new(),
                expected_digest: library.entries[0].source_digest.clone(),
            },
        )
        .expect("update");
        assert!(receipt.results.is_empty(), "재배포 대상이 없어야 한다");
        assert_eq!(
            fs::read_to_string(stranger.join("AGENTS.md")).unwrap(),
            "# 남의 지침\n",
            "남의 지침은 그대로 남아야 한다"
        );
    }

    /// C5-10 원장에 오른 위치라도 배포 뒤 외부에서 고쳐진 파일은 재배포가 덮지 않는다.
    /// 사람의 수정을 조용히 지우지 않고 "외부 수정 감지"로 넘긴다.
    #[test]
    fn republish_skips_locations_edited_after_deployment() {
        let temp = tempfile::tempdir().expect("temp");
        let root = temp.path().join("instructions");
        let project = temp.path().join("project");
        fs::create_dir(&project).expect("project");
        let projects = vec![registered(&project, &[ProviderId::Codex])];
        let entry = create_codex_instruction(&root, "guarded", "# AGENTS\n");
        publish_codex(&root, &projects, "guarded", &project);
        fs::write(project.join("AGENTS.md"), "# 현장에서 고친 지침\n").expect("mutate");

        let receipt = update_project_instruction_from_paths(
            &root,
            &app_data_of(&root),
            None,
            &projects,
            &UpdateProjectInstructionRequest {
                key: "guarded".to_owned(),
                name: None,
                description: None,
                files: vec![InstructionProviderFileWrite {
                    provider: ProviderId::Codex,
                    content: "# 편집한 원본\n".to_owned(),
                }],
                deletes: Vec::new(),
                expected_digest: entry.source_digest.clone(),
            },
        )
        .expect("update");
        assert_eq!(receipt.results.len(), 1);
        assert_eq!(
            receipt.results[0].outcome,
            Some(InstructionPublishOutcome::Skipped)
        );
        assert!(receipt.results[0].message.is_some(), "이유를 알려야 한다");
        assert_eq!(
            fs::read_to_string(project.join("AGENTS.md")).unwrap(),
            "# 현장에서 고친 지침\n"
        );

        // 그 위치는 외부 수정으로 잡혀 사람이 채택 여부를 정한다.
        let library = load_project_instruction_library_from_paths(
            &root,
            &app_data_of(&root),
            None,
            &projects,
        )
        .expect("library");
        let row = library.entries[0]
            .deployments
            .iter()
            .find(|deployment| deployment.present)
            .expect("row");
        assert!(row.managed && row.divergent);
    }

    /// C5-10 원장 도입 전 배포본은 첫 조회에서 한 번만 옮겨 붙인다. 그 뒤에 생긴
    /// 우연히 같은 내용의 남의 파일은 배포로 끌어들이지 않는다.
    #[test]
    fn ledger_migration_adopts_matching_deployments_once() {
        let temp = tempfile::tempdir().expect("temp");
        let root = temp.path().join("instructions");
        let legacy = temp.path().join("legacy");
        let later = temp.path().join("later");
        fs::create_dir(&legacy).expect("legacy");
        fs::create_dir(&later).expect("later");
        create_codex_instruction(&root, "legacy-key", "# AGENTS\n");
        // 원장 없이 이미 배포되어 있던 상태를 흉내낸다.
        fs::write(legacy.join("AGENTS.md"), "# AGENTS\n").expect("legacy file");
        let projects = vec![
            registered(&legacy, &[ProviderId::Codex]),
            registered(&later, &[ProviderId::Codex]),
        ];

        let library = load_project_instruction_library_from_paths(
            &root,
            &app_data_of(&root),
            None,
            &projects,
        )
        .expect("library");
        let managed = library.entries[0]
            .deployments
            .iter()
            .filter(|deployment| deployment.managed)
            .count();
        assert_eq!(managed, 1, "내용이 같은 기존 배포본만 원장에 오른다");

        // 이관은 한 번뿐이다. 나중에 같은 내용이 나타나도 배포로 보지 않는다.
        fs::write(later.join("AGENTS.md"), "# AGENTS\n").expect("later file");
        let library = load_project_instruction_library_from_paths(
            &root,
            &app_data_of(&root),
            None,
            &projects,
        )
        .expect("library");
        let managed = library.entries[0]
            .deployments
            .iter()
            .filter(|deployment| deployment.managed)
            .map(|deployment| deployment.project_path.clone())
            .collect::<Vec<_>>();
        assert_eq!(
            managed,
            vec![fs::canonicalize(&legacy)
                .expect("canonical")
                .to_string_lossy()
                .into_owned()]
        );
    }

    /// C5-10 배포 파일을 휴지통에서 되살리면 원장 기록도 함께 돌아온다. 기록이 빠진
    /// 채 파일만 남으면 이후 편집이 그 위치를 조용히 지나친다.
    #[test]
    fn restoring_a_deployment_returns_it_to_the_ledger() {
        let temp = tempfile::tempdir().expect("temp");
        let data = temp.path().join("app-data");
        fs::create_dir_all(&data).expect("data");
        let root = repository_instructions_root(&data);
        fs::create_dir_all(&root).expect("root");
        let project = temp.path().join("project");
        fs::create_dir(&project).expect("project");
        let projects = vec![registered(&project, &[ProviderId::Codex])];
        create_codex_instruction(&root, "restore-key", "# AGENTS\n");
        publish_project_instruction_from_paths(
            &root,
            &data,
            None,
            &projects,
            &PublishProjectInstructionRequest {
                key: "restore-key".to_owned(),
                scope: None,
                project_path: Some(project.to_string_lossy().into_owned()),
                providers: vec![ProviderId::Codex],
                overwrite: SkillOverwritePolicy::Fail,
            },
        )
        .expect("publish");

        let receipt = delete_project_instruction_deployment_from_paths(
            &root,
            None,
            &projects,
            &data,
            &DeleteProjectInstructionDeploymentRequest {
                scope: None,
                project_path: Some(project.to_string_lossy().into_owned()),
                provider: ProviderId::Codex,
                deleted_by: Some("user".to_owned()),
                confirm: true,
            },
        )
        .expect("delete");
        let ledger = instruction_ledger(&data, &root, "restore-key", None, &projects);
        assert!(ledger.locations.is_empty(), "삭제하면 기록도 빠진다");

        crate::restore_instruction_trash(&data, &receipt.items[0].id).expect("restore");
        let ledger = instruction_ledger(&data, &root, "restore-key", None, &projects);
        assert_eq!(ledger.locations.len(), 1, "복구하면 기록이 돌아온다");
        assert!(ledger.contains(
            ProviderId::Codex,
            &fs::canonicalize(&project).expect("canonical")
        ));
    }

    /// C5-10 이관되지 못한 배포본과 사람이 직접 옮긴 파일을 다시 관리 대상으로
    /// 되돌리는 경로. 등록하면 그 위치가 배포가 되어 이후 편집이 함께 반영되고,
    /// 해제하면 파일은 남고 갱신 대상에서만 빠진다.
    #[test]
    fn attach_and_detach_move_a_location_in_and_out_of_the_ledger() {
        let temp = tempfile::tempdir().expect("temp");
        let data = temp.path().join("app-data");
        fs::create_dir_all(&data).expect("data");
        let root = repository_instructions_root(&data);
        fs::create_dir_all(&root).expect("root");
        let project = temp.path().join("project");
        fs::create_dir(&project).expect("project");
        fs::write(project.join("AGENTS.md"), "# 손으로 옮긴 지침\n").expect("deployed");
        create_codex_instruction(&root, "attach-key", "# AGENTS\n");
        let sessions = vec![session("s1", ProviderId::Codex, &project, false, false)];
        let request = InstructionDeploymentLinkRequest {
            key: "attach-key".to_owned(),
            scope: Some(SCOPE_PROJECT.to_owned()),
            project_path: Some(project.to_string_lossy().into_owned()),
            provider: ProviderId::Codex,
        };

        let entry =
            attach_project_instruction_deployment(&data, &sessions, &request).expect("attach");
        // 개인(홈 설정) 행은 이 기기의 실제 파일에 따라 달라지므로 프로젝트 행만 본다.
        let project_row = |entry: &ProjectInstructionEntry| {
            entry
                .deployments
                .iter()
                .find(|deployment| deployment.scope == SCOPE_PROJECT && deployment.present)
                .cloned()
                .expect("project row")
        };
        let row = project_row(&entry);
        assert!(row.managed, "등록하면 이 원본의 배포가 된다");
        assert!(row.divergent, "내용이 원본과 달라 외부 수정으로 잡힌다");

        // 등록 시점 내용이 기준이므로, 이어지는 편집은 이 위치까지 갱신한다.
        let receipt = update_project_instruction_from_paths(
            &root,
            &data,
            None,
            &[registered(&project, &[ProviderId::Codex])],
            &UpdateProjectInstructionRequest {
                key: "attach-key".to_owned(),
                name: None,
                description: None,
                files: vec![InstructionProviderFileWrite {
                    provider: ProviderId::Codex,
                    content: "# 편집한 원본\n".to_owned(),
                }],
                deletes: Vec::new(),
                expected_digest: entry.source_digest.clone(),
            },
        )
        .expect("update");
        assert_eq!(
            receipt.results[0].outcome,
            Some(InstructionPublishOutcome::Replaced)
        );
        assert_eq!(
            fs::read_to_string(project.join("AGENTS.md")).unwrap(),
            "# 편집한 원본\n"
        );

        let entry =
            detach_project_instruction_deployment(&data, &sessions, &request).expect("detach");
        let row = project_row(&entry);
        assert!(!row.managed && !row.divergent);
        assert!(project.join("AGENTS.md").is_file(), "파일은 남는다");
    }

    fn create_codex_instruction(root: &Path, key: &str, content: &str) -> ProjectInstructionEntry {
        create_project_instruction_in_root(
            root,
            &CreateProjectInstructionRequest {
                key: key.to_owned(),
                name: format!("{key} 이름"),
                description: "지침 삭제·동기화 테스트".to_owned(),
                files: vec![InstructionProviderFileWrite {
                    provider: ProviderId::Codex,
                    content: content.to_owned(),
                }],
                platforms: Vec::new(),
            },
        )
        .expect("create instruction")
    }

    /// 원장 허용 목록이 필요 없는 열람 테스트용 래퍼.
    fn read_deployed_instruction_file_from_paths_for_test(
        home: Option<&Path>,
        projects: &[RegisteredProject],
        request: &ReadDeployedInstructionFileRequest,
    ) -> Result<DeployedInstructionFileContent, CoreError> {
        read_deployed_instruction_file_from_paths(home, projects, &BTreeSet::new(), request)
    }

    /// 테스트의 앱 데이터 디렉터리. 원장(instruction-meta.json)이 여기 놓인다.
    fn app_data_of(root: &Path) -> PathBuf {
        let directory = root.parent().expect("temp root").join("app-data");
        fs::create_dir_all(&directory).expect("app data");
        directory
    }

    fn publish_codex(root: &Path, projects: &[RegisteredProject], key: &str, project: &Path) {
        let receipt = publish_project_instruction_from_paths(
            root,
            &app_data_of(root),
            None,
            projects,
            &PublishProjectInstructionRequest {
                key: key.to_owned(),
                scope: None,
                project_path: Some(project.to_string_lossy().into_owned()),
                providers: vec![ProviderId::Codex],
                overwrite: SkillOverwritePolicy::Replace,
            },
        )
        .expect("publish");
        assert!(receipt.results.iter().all(|result| matches!(
            result.outcome,
            Some(InstructionPublishOutcome::Published)
                | Some(InstructionPublishOutcome::Replaced)
                | Some(InstructionPublishOutcome::Unchanged)
        )));
    }

    #[test]
    fn deployment_delete_requires_confirm_and_restores_from_trash() {
        let temp = tempfile::tempdir().expect("temp");
        let data = temp.path().join("app-data");
        let root = temp.path().join("instructions");
        let project = temp.path().join("project");
        fs::create_dir_all(&data).expect("data");
        fs::create_dir(&project).expect("project");
        let projects = vec![registered(&project, &[ProviderId::Codex])];
        create_codex_instruction(&root, "trash-roundtrip", "# AGENTS\n");
        publish_codex(&root, &projects, "trash-roundtrip", &project);
        let deployed = project.join("AGENTS.md");
        assert!(deployed.is_file());

        let request = DeleteProjectInstructionDeploymentRequest {
            scope: None,
            project_path: Some(project.to_string_lossy().into_owned()),
            provider: ProviderId::Codex,
            deleted_by: None,
            confirm: false,
        };
        assert!(matches!(
            delete_project_instruction_deployment_from_paths(
                &root, None, &projects, &data, &request
            ),
            Err(CoreError::InvalidInput(_))
        ));

        let receipt = delete_project_instruction_deployment_from_paths(
            &root,
            None,
            &projects,
            &data,
            &DeleteProjectInstructionDeploymentRequest {
                confirm: true,
                ..request
            },
        )
        .expect("delete deployment");
        assert!(!deployed.exists());
        assert_eq!(receipt.items.len(), 1);
        assert_eq!(receipt.key, "trash-roundtrip");
        assert!(receipt.items[0].shared);

        let overview = crate::list_instruction_trash(&data).expect("trash list");
        assert_eq!(overview.items.len(), 1);
        let restored =
            crate::restore_instruction_trash(&data, &overview.items[0].id).expect("restore");
        assert!(restored.results.iter().all(|result| matches!(
            result.outcome,
            crate::instruction_trash::InstructionTrashRestoreOutcome::Restored
        )));
        assert!(deployed.is_file());
    }

    #[test]
    fn shared_delete_moves_matching_deployments_and_keeps_divergent_files() {
        let temp = tempfile::tempdir().expect("temp");
        let data = temp.path().join("app-data");
        let root = temp.path().join("instructions");
        let matching = temp.path().join("matching");
        let divergent = temp.path().join("divergent");
        fs::create_dir_all(&data).expect("data");
        fs::create_dir(&matching).expect("matching");
        fs::create_dir(&divergent).expect("divergent");
        let projects = vec![
            registered(&matching, &[ProviderId::Codex]),
            registered(&divergent, &[ProviderId::Codex]),
        ];
        create_codex_instruction(&root, "shared-delete", "# AGENTS\n");
        publish_codex(&root, &projects, "shared-delete", &matching);
        publish_codex(&root, &projects, "shared-delete", &divergent);
        fs::write(divergent.join("AGENTS.md"), "# 외부 수정\n").expect("mutate");

        let impact = check_project_instruction_delete_from_paths(
            &root,
            &app_data_of(&root),
            None,
            &projects,
            &InstructionDeleteCheckRequest {
                key: Some("shared-delete".to_owned()),
                scope: None,
                project_path: None,
                provider: None,
            },
        )
        .expect("check");
        assert!(impact.shared);
        assert_eq!(impact.items.len(), 2);
        assert_eq!(impact.warnings.len(), 1);

        let receipt = delete_shared_project_instruction_from_paths(
            &root,
            None,
            &projects,
            &data,
            &DeleteSharedProjectInstructionRequest {
                key: "shared-delete".to_owned(),
                deleted_by: Some("aia".to_owned()),
                confirm: true,
            },
        )
        .expect("shared delete");
        assert!(!root.join("shared-delete").exists());
        assert!(!matching.join("AGENTS.md").exists());
        assert!(divergent.join("AGENTS.md").is_file());
        assert_eq!(receipt.items.len(), 2);
        assert_eq!(receipt.warnings.len(), 1);
        assert!(receipt
            .items
            .iter()
            .all(|item| item.deleted_by == "aia" && item.group_id == receipt.group_id));

        let restored =
            crate::restore_instruction_trash(&data, &receipt.items[0].id).expect("restore group");
        assert_eq!(restored.results.len(), 2);
        assert!(root.join("shared-delete/AGENTS.md").is_file());
        assert!(matching.join("AGENTS.md").is_file());
    }

    #[test]
    fn unarchiving_a_shared_instruction_keeps_deployments_and_clears_the_ledger() {
        let temp = tempfile::tempdir().expect("temp");
        let data = temp.path().join("app-data");
        let root = temp.path().join("instructions");
        let project = temp.path().join("project");
        fs::create_dir_all(&data).expect("data");
        fs::create_dir(&project).expect("project");
        let projects = vec![registered(&project, &[ProviderId::Codex])];
        create_codex_instruction(&root, "keep-files", "# AGENTS\n");
        publish_codex(&root, &projects, "keep-files", &project);
        let deployed = project.join("AGENTS.md");
        assert!(deployed.is_file());

        let request = UnarchiveSharedProjectInstructionRequest {
            key: "keep-files".to_owned(),
            deleted_by: None,
            confirm: false,
        };
        assert!(matches!(
            unarchive_shared_project_instruction_in(&root, &data, &request),
            Err(CoreError::InvalidInput(_))
        ));

        let receipt = unarchive_shared_project_instruction_in(
            &root,
            &data,
            &UnarchiveSharedProjectInstructionRequest {
                confirm: true,
                ..request
            },
        )
        .expect("unarchive");
        assert_eq!(receipt.items.len(), 1, "원본 하나만 옮긴다");
        assert!(receipt.items[0].shared);
        assert!(!root.join("keep-files").exists());
        // 배포 파일은 그 자리에 남고 원장은 비워진다.
        assert!(deployed.is_file());
        let ledger = instruction_ledger(&data, &root, "keep-files", None, &projects);
        assert!(ledger.locations.is_empty());

        // 복구하면 내용이 같은 배포를 원장이 다시 받아들인다.
        crate::restore_instruction_trash(&data, &receipt.items[0].id).expect("restore");
        assert!(root.join("keep-files/AGENTS.md").is_file());
        let ledger = instruction_ledger(&data, &root, "keep-files", None, &projects);
        assert_eq!(ledger.locations.len(), 1);
    }

    #[test]
    fn sync_adopts_deployment_and_republishes_other_projects() {
        let temp = tempfile::tempdir().expect("temp");
        let data = temp.path().join("app-data");
        let root = temp.path().join("instructions");
        let adopted = temp.path().join("adopted");
        let follower = temp.path().join("follower");
        fs::create_dir_all(&data).expect("data");
        fs::create_dir(&adopted).expect("adopted");
        fs::create_dir(&follower).expect("follower");
        let projects = vec![
            registered(&adopted, &[ProviderId::Codex]),
            registered(&follower, &[ProviderId::Codex]),
        ];
        create_codex_instruction(&root, "sync-source", "# AGENTS\n");
        publish_codex(&root, &projects, "sync-source", &adopted);
        publish_codex(&root, &projects, "sync-source", &follower);
        fs::write(adopted.join("AGENTS.md"), "# 채택할 수정본\n").expect("mutate");

        let receipt = sync_project_instruction_from_deployment_from_paths(
            &root,
            None,
            &projects,
            &data,
            &SyncProjectInstructionRequest {
                key: "sync-source".to_owned(),
                scope: None,
                project_path: Some(adopted.to_string_lossy().into_owned()),
                provider: ProviderId::Codex,
                deleted_by: None,
            },
        )
        .expect("sync");
        assert_eq!(
            fs::read_to_string(root.join("sync-source/AGENTS.md")).expect("source"),
            "# 채택할 수정본\n"
        );
        assert_eq!(
            fs::read_to_string(follower.join("AGENTS.md")).expect("follower"),
            "# 채택할 수정본\n"
        );
        assert_eq!(receipt.results.len(), 1);
        assert!(matches!(
            receipt.results[0].outcome,
            Some(InstructionPublishOutcome::Replaced)
        ));
        assert!(receipt.previous_source_trash_id.is_some());
        let overview = crate::list_instruction_trash(&data).expect("trash");
        assert_eq!(overview.items.len(), 1);
        assert_eq!(overview.items[0].key, "sync-source");
    }

    #[test]
    fn excluded_project_ledger_locations_are_hidden_and_skipped() {
        let temp = tempfile::tempdir().expect("temp");
        let root = temp.path().join("instructions");
        let active = temp.path().join("active");
        let inactive = temp.path().join("inactive");
        fs::create_dir(&active).expect("active");
        fs::create_dir(&inactive).expect("inactive");
        let data = app_data_of(&root);
        let all_projects = vec![
            registered(&active, &[ProviderId::Codex]),
            registered(&inactive, &[ProviderId::Codex]),
        ];
        let entry = create_codex_instruction(&root, "excluded-ledger", "# AGENTS\n");
        publish_codex(&root, &all_projects, "excluded-ledger", &active);
        publish_codex(&root, &all_projects, "excluded-ledger", &inactive);

        // 설정에서 제외하면 세션 카탈로그가 그 프로젝트를 등록 목록에서 빼므로, 지침 쪽에도
        // 활성 프로젝트만 넘어온다. 원장에 남은 비활성 위치는 표시·재배포·회수 대상이 아니다.
        crate::store::set_project_active(&data, &inactive.to_string_lossy(), false)
            .expect("exclude project");
        let active_projects = vec![registered(&active, &[ProviderId::Codex])];
        let library =
            load_project_instruction_library_from_paths(&root, &data, None, &active_projects)
                .expect("library");
        let inactive_canonical = fs::canonicalize(&inactive).expect("canonical inactive");
        assert!(library.entries[0].deployments.iter().all(|deployment| {
            Path::new(&deployment.file_path).parent() != Some(inactive_canonical.as_path())
        }));
        assert!(!ledger_project_dirs(&data).contains(&inactive_canonical));
        let refused = resolve_deployment_dir(
            None,
            &active_projects,
            &ledger_project_dirs(&data),
            None,
            Some(&inactive.to_string_lossy()),
            ProviderId::Codex,
        );
        assert!(matches!(refused, Err(CoreError::InvalidInput(_))));

        let receipt = update_project_instruction_from_paths(
            &root,
            &data,
            None,
            &active_projects,
            &UpdateProjectInstructionRequest {
                key: "excluded-ledger".to_owned(),
                name: None,
                description: None,
                files: vec![InstructionProviderFileWrite {
                    provider: ProviderId::Codex,
                    content: "# AGENTS v2\n".to_owned(),
                }],
                deletes: Vec::new(),
                expected_digest: entry.source_digest.clone(),
            },
        )
        .expect("update");
        assert!(receipt
            .results
            .iter()
            .all(|result| Path::new(&result.file_path).parent()
                != Some(inactive_canonical.as_path())));
        assert_eq!(
            fs::read_to_string(active.join("AGENTS.md")).expect("active deployed"),
            "# AGENTS v2\n"
        );
        assert_eq!(
            fs::read_to_string(inactive.join("AGENTS.md")).expect("inactive untouched"),
            "# AGENTS\n"
        );

        // 공유 삭제 미리보기는 비활성 위치를 남겨둔다고 알린다.
        let (_, targets, warnings) = collect_shared_instruction_delete_targets(
            &root,
            &data,
            None,
            &active_projects,
            "excluded-ledger",
        )
        .expect("delete targets");
        assert_eq!(targets.len(), 1);
        assert!(warnings.iter().any(|warning| {
            warning.contains("비활성 프로젝트")
                && warning.contains(&inactive_canonical.to_string_lossy().into_owned())
        }));

        // 다시 켜면 원장 기록이 그대로 돌아온다.
        crate::store::set_project_active(&data, &inactive.to_string_lossy(), true)
            .expect("reactivate project");
        assert!(ledger_project_dirs(&data).contains(&inactive_canonical));
        let library =
            load_project_instruction_library_from_paths(&root, &data, None, &all_projects)
                .expect("library");
        assert!(library.entries[0].deployments.iter().any(|deployment| {
            deployment.managed
                && Path::new(&deployment.file_path).parent() == Some(inactive_canonical.as_path())
        }));
    }

    #[test]
    fn update_edits_base_meta_and_republishes_with_optimistic_lock() {
        let temp = tempfile::tempdir().expect("temp");
        let root = temp.path().join("instructions");
        let project = temp.path().join("project");
        fs::create_dir(&project).expect("project");
        let projects = vec![registered(&project, &[ProviderId::Codex])];
        let entry = create_codex_instruction(&root, "update-base", "# AGENTS\n");
        publish_codex(&root, &projects, "update-base", &project);

        let receipt = update_project_instruction_from_paths(
            &root,
            &app_data_of(&root),
            None,
            &projects,
            &UpdateProjectInstructionRequest {
                key: "update-base".to_owned(),
                name: Some("업데이트된 이름".to_owned()),
                description: None,
                files: vec![InstructionProviderFileWrite {
                    provider: ProviderId::Codex,
                    content: "# AGENTS v2\n".to_owned(),
                }],
                deletes: Vec::new(),
                expected_digest: entry.source_digest.clone(),
            },
        )
        .expect("update");
        assert_eq!(
            fs::read_to_string(project.join("AGENTS.md")).expect("deployed"),
            "# AGENTS v2\n"
        );
        assert_ne!(receipt.source_digest, entry.source_digest);
        let reloaded = read_entry(
            &root.join("update-base"),
            None,
            &projects,
            &instruction_ledger(&app_data_of(&root), &root, "update-base", None, &projects),
        )
        .expect("entry");
        assert_eq!(reloaded.name, "업데이트된 이름");
        assert_eq!(reloaded.description, "지침 삭제·동기화 테스트");

        assert!(matches!(
            update_project_instruction_from_paths(
                &root,
                &app_data_of(&root),
                None,
                &projects,
                &UpdateProjectInstructionRequest {
                    key: "update-base".to_owned(),
                    name: None,
                    description: None,
                    files: vec![InstructionProviderFileWrite {
                        provider: ProviderId::Codex,
                        content: "# 낡은 지문\n".to_owned(),
                    }],
                    deletes: Vec::new(),
                    expected_digest: entry.source_digest,
                },
            ),
            Err(CoreError::Conflict(_))
        ));

        // 마지막 공급자 파일을 지우는 편집은 거부한다.
        assert!(matches!(
            update_project_instruction_from_paths(
                &root,
                &app_data_of(&root),
                None,
                &projects,
                &UpdateProjectInstructionRequest {
                    key: "update-base".to_owned(),
                    name: None,
                    description: None,
                    files: Vec::new(),
                    deletes: vec![ProviderId::Codex],
                    expected_digest: receipt.source_digest,
                },
            ),
            Err(CoreError::InvalidInput(_))
        ));
    }

    #[test]
    fn reads_documents_linked_from_a_deployed_instruction() {
        let temp = tempfile::tempdir().expect("temp");
        let home = temp.path().join("home");
        let project = temp.path().join("project");
        fs::create_dir_all(home.join(".codex")).expect("home config");
        fs::create_dir_all(project.join("context/agent")).expect("context");
        fs::write(
            project.join("AGENTS.md"),
            "# 지침\n\n@context/agent/development-rules.md\n",
        )
        .expect("instruction file");
        fs::write(
            project.join("context/agent/development-rules.md"),
            "# 개발 규칙\n",
        )
        .expect("linked file");
        fs::write(project.join("context/agent/source-map.md"), "# 소스 맵\n")
            .expect("sibling file");
        fs::write(home.join(".codex/shared.md"), "# 홈 설정 문서\n").expect("home doc");
        fs::write(temp.path().join("outside.md"), "# 바깥\n").expect("outside file");
        let projects = vec![registered(&project, &[ProviderId::Codex])];
        let request =
            |current_path: Option<&str>, href: &str| DeployedInstructionLinkedFileRequest {
                scope: Some("project".to_owned()),
                project_path: Some(project.to_string_lossy().into_owned()),
                provider: ProviderId::Codex,
                current_path: current_path.map(str::to_owned),
                href: href.to_owned(),
            };
        let read = |request: &DeployedInstructionLinkedFileRequest| {
            read_deployed_instruction_link(
                Some(&home),
                &projects,
                &BTreeSet::new(),
                request,
                linked_file::read_linked_file_from,
            )
        };

        // 지침 파일 기준 상대 경로(`@context/...` 가져오기 포함)를 그대로 연다.
        let linked = read(&request(None, "context/agent/development-rules.md")).expect("linked");
        assert_eq!(linked.relative_path, "context/agent/development-rules.md");
        assert_eq!(linked.content, "# 개발 규칙\n");

        // 지침 파일 자신도 이름으로 연다. 가져오기 트리의 뿌리가 이 경로로 원문을 본다.
        let root_file = read(&request(None, "AGENTS.md")).expect("instruction file");
        assert_eq!(root_file.relative_path, "AGENTS.md");
        assert_eq!(
            root_file.content,
            "# 지침\n\n@context/agent/development-rules.md\n"
        );

        // 연결 문서 안의 상대 링크는 그 문서가 있는 디렉터리 기준으로 푼다.
        let nested = read(&request(
            Some("context/agent/development-rules.md"),
            "source-map.md",
        ))
        .expect("nested link");
        assert_eq!(nested.relative_path, "context/agent/source-map.md");

        // 기준 디렉터리에 없으면 프로젝트 루트에서 다시 찾는다.
        let from_root = read(&request(
            Some("context/agent/development-rules.md"),
            "context/agent/development-rules.md",
        ))
        .expect("root fallback");
        assert_eq!(
            from_root.relative_path,
            "context/agent/development-rules.md"
        );

        // `~/`로 시작하는 가져오기는 공급자 홈 설정 디렉터리에서 읽는다.
        let personal = read(&request(None, "~/.codex/shared.md")).expect("home link");
        assert_eq!(personal.content, "# 홈 설정 문서\n");

        // 실패 이유는 지침이 놓인 위치에서 본 그대로 알린다. 홈 설정으로 넘어가며
        // "없다"로 덮이면 링크가 폴더인지 없는 파일인지 구분할 수 없다.
        assert!(matches!(
            read(&request(None, "context/agent")),
            Err(CoreError::InvalidInput(message)) if message.contains("일반 파일이 아닙니다")
        ));
        assert!(matches!(
            read(&request(None, "context/agent/missing.md")),
            Err(CoreError::NotFound(_))
        ));

        // 프로젝트와 홈 설정 밖의 파일은 열지 않는다.
        assert!(read(&request(None, "../outside.md")).is_err());
        assert!(read(&request(None, "https://example.com/doc.md")).is_err());
    }

    #[test]
    fn personal_scope_round_trips_publish_read_sync_and_delete() {
        let temp = tempfile::tempdir().expect("temp");
        let data = temp.path().join("app-data");
        let home = temp.path().join("home");
        let root = temp.path().join("instructions");
        fs::create_dir_all(&data).expect("data");
        fs::create_dir_all(&home).expect("home");
        let projects: Vec<RegisteredProject> = Vec::new();
        create_codex_instruction(&root, "personal-scope", "# AGENTS\n");

        // 게시: 개인 위치는 projectPath 없이 공급자 홈 설정 디렉터리로 간다.
        let receipt = publish_project_instruction_from_paths(
            &root,
            &app_data_of(&root),
            Some(&home),
            &projects,
            &PublishProjectInstructionRequest {
                key: "personal-scope".to_owned(),
                scope: Some("personal".to_owned()),
                project_path: None,
                providers: vec![ProviderId::Codex],
                overwrite: SkillOverwritePolicy::Replace,
            },
        )
        .expect("publish personal");
        let personal_file = home.join(".codex/AGENTS.md");
        assert!(personal_file.is_file());
        assert_eq!(receipt.results[0].scope, "personal");

        // 라이브러리와 원본 엔트리가 개인 배포 행을 함께 보여준다.
        let library = load_project_instruction_library_from_paths(
            &root,
            &app_data_of(&root),
            Some(&home),
            &projects,
        )
        .expect("library");
        let personal_row = library.entries[0]
            .deployments
            .iter()
            .find(|deployment| {
                deployment.scope == "personal" && deployment.provider == ProviderId::Codex
            })
            .expect("personal deployment row");
        assert!(personal_row.present && !personal_row.divergent);

        // 열람: 실제 파일 원문을 그대로 돌려준다.
        let read = read_deployed_instruction_file_from_paths_for_test(
            Some(&home),
            &projects,
            &ReadDeployedInstructionFileRequest {
                scope: Some("personal".to_owned()),
                project_path: None,
                provider: ProviderId::Codex,
            },
        )
        .expect("read personal");
        assert_eq!(read.content, "# AGENTS\n");

        // 외부 수정 채택: 개인 파일 수정본이 원본이 된다.
        fs::write(&personal_file, "# 개인 수정\n").expect("mutate");
        sync_project_instruction_from_deployment_from_paths(
            &root,
            Some(&home),
            &projects,
            &data,
            &SyncProjectInstructionRequest {
                key: "personal-scope".to_owned(),
                scope: Some("personal".to_owned()),
                project_path: None,
                provider: ProviderId::Codex,
                deleted_by: None,
            },
        )
        .expect("sync personal");
        assert_eq!(
            fs::read_to_string(root.join("personal-scope/AGENTS.md")).expect("source"),
            "# 개인 수정\n"
        );

        // 삭제: 개인 배포 파일도 휴지통을 경유한다.
        let receipt = delete_project_instruction_deployment_from_paths(
            &root,
            Some(&home),
            &projects,
            &data,
            &DeleteProjectInstructionDeploymentRequest {
                scope: Some("personal".to_owned()),
                project_path: None,
                provider: ProviderId::Codex,
                deleted_by: None,
                confirm: true,
            },
        )
        .expect("delete personal");
        assert!(!personal_file.exists());
        assert_eq!(receipt.items[0].scope.as_deref(), Some("personal"));
    }

    #[test]
    fn auto_sync_meta_is_stored_per_device_and_cleared_on_shared_delete() {
        let temp = tempfile::tempdir().expect("temp");
        let data = temp.path().join("app-data");
        fs::create_dir_all(&data).expect("data");
        set_project_instruction_auto_sync(&data, "auto-key", true).expect("set");
        let store = load_instruction_meta_store(&data);
        assert!(store.instructions.get("auto-key").expect("entry").auto_sync);
        remove_instruction_meta_entry(&data, "auto-key").expect("remove");
        assert!(!load_instruction_meta_store(&data)
            .instructions
            .contains_key("auto-key"));
    }

    /// 보관 원본 하나를 만들고, 지침이 참조하는 연결 문서까지 함께 담기는지 본다.
    fn import_codex_with_links(
        root: &Path,
        home: &Path,
        projects: &[RegisteredProject],
        key: &str,
        origin: &Path,
    ) -> ProjectInstructionEntry {
        import_project_instruction_from_paths(
            root,
            &app_data_of(root),
            Some(home),
            projects,
            &ImportProjectInstructionRequest {
                key: key.to_owned(),
                scope: None,
                project_path: Some(origin.to_string_lossy().into_owned()),
                provider: ProviderId::Codex,
                name: None,
                description: None,
                linked_files: None,
            },
        )
        .expect("import")
    }

    /// 지침 + 연결 문서 두 단계를 갖춘 프로젝트를 만든다. 홈 설정 문서 링크는 위치에
    /// 매인 링크라 보관 대상이 아니다.
    fn write_linked_instruction(origin: &Path, home: &Path) {
        fs::create_dir_all(origin.join("context/agent")).expect("context");
        fs::create_dir_all(home.join(".codex")).expect("home config");
        fs::write(home.join(".codex/shared.md"), "# 홈 문서\n").expect("home doc");
        fs::write(
            origin.join("AGENTS.md"),
            "# 지침\n\n@context/agent/rules.md\n@~/.codex/shared.md\n",
        )
        .expect("instruction");
        fs::write(
            origin.join("context/agent/rules.md"),
            "# 규칙\n\n[소스 맵](source-map.md)\n",
        )
        .expect("rules");
        fs::write(origin.join("context/agent/source-map.md"), "# 소스 맵\n").expect("map");
    }

    #[test]
    fn preview_lists_linked_documents_as_a_tree_and_import_takes_only_the_selected_ones() {
        let temp = tempfile::tempdir().expect("temp");
        let home = temp.path().join("home");
        let root = temp.path().join("instructions");
        let origin = temp.path().join("origin");
        fs::create_dir_all(&origin).expect("origin");
        write_linked_instruction(&origin, &home);
        let projects = vec![registered(&origin, &[ProviderId::Codex])];

        // 미리보기: 어떤 문서가 어떤 문서에서 딸려 오는지 source로 알 수 있어야
        // 화면이 트리로 그린다. 위치에 매인 링크는 이유와 함께 남는다.
        let preview = preview_project_instruction_import_from_paths(
            Some(&home),
            &projects,
            &InstructionImportPreviewRequest {
                scope: None,
                project_path: Some(origin.to_string_lossy().into_owned()),
                provider: ProviderId::Codex,
            },
        )
        .expect("preview");
        let rules = preview
            .linked_docs
            .iter()
            .find(|doc| doc.relative == "context/agent/rules.md")
            .expect("rules doc");
        assert_eq!(rules.source, "");
        let map = preview
            .linked_docs
            .iter()
            .find(|doc| doc.relative == "context/agent/source-map.md")
            .expect("map doc");
        assert_eq!(map.source, "context/agent/rules.md");
        assert!(map.size_bytes > 0);
        assert!(preview
            .link_issues
            .iter()
            .any(|issue| issue.href == "~/.codex/shared.md"));

        // 고른 문서만 보관한다.
        import_project_instruction_from_paths(
            &root,
            &app_data_of(&root),
            Some(&home),
            &projects,
            &ImportProjectInstructionRequest {
                key: "selected".to_owned(),
                scope: None,
                project_path: Some(origin.to_string_lossy().into_owned()),
                provider: ProviderId::Codex,
                name: None,
                description: None,
                linked_files: Some(vec!["context/agent/rules.md".to_owned()]),
            },
        )
        .expect("import");
        let archived = root.join("selected");
        assert!(archived.join("context/agent/rules.md").is_file());
        assert!(!archived.join("context/agent/source-map.md").exists());

        // 지침이 가리키지 않는 문서는 고를 수 없다. 조용히 빼면 사람이 고른 세트와
        // 보관된 세트가 달라진다.
        assert!(matches!(
            import_project_instruction_from_paths(
                &root,
                &app_data_of(&root),
                Some(&home),
                &projects,
                &ImportProjectInstructionRequest {
                    key: "unknown-doc".to_owned(),
                    scope: None,
                    project_path: Some(origin.to_string_lossy().into_owned()),
                    provider: ProviderId::Codex,
                    name: None,
                    description: None,
                    linked_files: Some(vec!["context/agent/missing.md".to_owned()]),
                },
            ),
            Err(CoreError::InvalidInput(_))
        ));
    }

    /// 지침 구성 파일에는 개수 한도가 없다. 링크로 끌고 오는 문서 수는 프로젝트마다
    /// 다르고, 개수로 자르면 세트가 반쪽으로 남는다.
    #[test]
    fn archives_more_linked_documents_than_the_old_file_count_cap() {
        let temp = tempfile::tempdir().expect("temp");
        let root = temp.path().join("instructions");
        let origin = temp.path().join("origin");
        fs::create_dir_all(origin.join("context")).expect("context");
        let mut instruction = String::from("# 지침\n\n");
        for index in 0..120 {
            let relative = format!("context/doc-{index}.md");
            fs::write(origin.join(&relative), format!("# 문서 {index}\n")).expect("doc");
            instruction.push_str(&format!("@{relative}\n"));
        }
        fs::write(origin.join("AGENTS.md"), &instruction).expect("instruction");
        let projects = vec![registered(&origin, &[ProviderId::Codex])];

        let entry = import_project_instruction_from_paths(
            &root,
            &app_data_of(&root),
            None,
            &projects,
            &ImportProjectInstructionRequest {
                key: "many-docs".to_owned(),
                scope: None,
                project_path: Some(origin.to_string_lossy().into_owned()),
                provider: ProviderId::Codex,
                name: None,
                description: None,
                linked_files: None,
            },
        )
        .expect("import");
        assert_eq!(entry.linked_files.len(), 120);
        assert!(root.join("many-docs/context/doc-119.md").is_file());
    }

    #[test]
    fn archives_publishes_and_syncs_linked_documents_as_one_set() {
        let temp = tempfile::tempdir().expect("temp");
        let data = temp.path().join("app-data");
        let home = temp.path().join("home");
        let root = temp.path().join("instructions");
        let origin = temp.path().join("origin");
        let target = temp.path().join("target");
        fs::create_dir_all(&data).expect("data");
        fs::create_dir_all(&target).expect("target");
        fs::create_dir_all(&origin).expect("origin");
        write_linked_instruction(&origin, &home);
        let projects = vec![
            registered(&origin, &[ProviderId::Codex]),
            registered(&target, &[ProviderId::Codex]),
        ];

        // 보관: 링크를 재귀로 따라가 같은 상대 경로로 담고, 위치에 매인 링크는 뺀다.
        import_codex_with_links(&root, &home, &projects, "linked-set", &origin);
        let archived = root.join("linked-set");
        assert_eq!(
            fs::read_to_string(archived.join("context/agent/source-map.md")).expect("map"),
            "# 소스 맵\n"
        );
        assert!(archived.join("context/agent/rules.md").is_file());
        assert!(!archived.join(".codex").exists());

        // 게시: 연결 문서도 같은 상대 경로로 함께 간다.
        publish_codex(&root, &projects, "linked-set", &target);
        assert_eq!(
            fs::read_to_string(target.join("context/agent/source-map.md")).expect("published map"),
            "# 소스 맵\n"
        );

        // 연결 문서만 달라져도 세트로는 다른 상태다. 위치에 매인 링크는 이유로 남는다.
        fs::write(target.join("context/agent/rules.md"), "# 규칙(수정)\n").expect("edit");
        let library = load_project_instruction_library_from_paths(
            &root,
            &app_data_of(&root),
            Some(&home),
            &projects,
        )
        .expect("library");
        let target_path = fs::canonicalize(&target).expect("canonical target");
        let deployment = library
            .entries
            .iter()
            .find(|entry| entry.key == "linked-set")
            .expect("entry")
            .deployments
            .iter()
            .find(|deployment| {
                deployment.provider == ProviderId::Codex
                    && Path::new(&deployment.project_path) == target_path
            })
            .expect("target deployment")
            .clone();
        assert_eq!(deployment.content_digest, deployment.source_digest);
        assert!(deployment.divergent);
        assert_eq!(deployment.linked_changed, vec!["context/agent/rules.md"]);
        assert!(deployment.linked_missing.is_empty());
        assert!(deployment
            .link_issues
            .iter()
            .any(|issue| issue.href == "~/.codex/shared.md"));
        // 지침 파일이 같아도 연결 문서가 다르면 세트 지문이 갈린다. 자동 동기화가
        // 어느 위치를 채택할지 판단할 때 이 지문이 기준이다.
        let origin_path = fs::canonicalize(&origin).expect("canonical origin");
        let origin_deployment = library
            .entries
            .iter()
            .find(|entry| entry.key == "linked-set")
            .expect("entry")
            .deployments
            .iter()
            .find(|deployment| {
                deployment.provider == ProviderId::Codex
                    && Path::new(&deployment.project_path) == origin_path
            })
            .expect("origin deployment");
        assert_eq!(origin_deployment.content_digest, deployment.content_digest);
        assert_ne!(origin_deployment.set_digest, deployment.set_digest);
        assert!(!origin_deployment.divergent);

        // 동기화: 배포본이 참조하는 세트를 그대로 채택한다. 새 문서가 들어오고 더는
        // 참조하지 않는 문서는 빠진다.
        fs::write(
            target.join("AGENTS.md"),
            "# 지침(수정)\n\n@context/agent/rules.md\n",
        )
        .expect("edit instruction");
        fs::write(
            target.join("context/agent/rules.md"),
            "# 규칙(수정)\n\n[추가](extra.md)\n",
        )
        .expect("edit rules");
        fs::write(target.join("context/agent/extra.md"), "# 추가\n").expect("extra");
        sync_project_instruction_from_deployment_from_paths(
            &root,
            Some(&home),
            &projects,
            &data,
            &SyncProjectInstructionRequest {
                key: "linked-set".to_owned(),
                scope: None,
                project_path: Some(target.to_string_lossy().into_owned()),
                provider: ProviderId::Codex,
                deleted_by: Some("aia".to_owned()),
            },
        )
        .expect("sync");
        assert!(archived.join("context/agent/extra.md").is_file());
        assert!(!archived.join("context/agent/source-map.md").exists());
        // 재배포는 다른 위치에도 세트로 간다.
        assert!(origin.join("context/agent/extra.md").is_file());
    }

    #[test]
    fn publish_keeps_existing_linked_documents_without_replace() {
        let temp = tempfile::tempdir().expect("temp");
        let home = temp.path().join("home");
        let root = temp.path().join("instructions");
        let origin = temp.path().join("origin");
        let target = temp.path().join("target");
        fs::create_dir_all(&origin).expect("origin");
        fs::create_dir_all(target.join("context/agent")).expect("target context");
        write_linked_instruction(&origin, &home);
        let projects = vec![
            registered(&origin, &[ProviderId::Codex]),
            registered(&target, &[ProviderId::Codex]),
        ];
        import_codex_with_links(&root, &home, &projects, "keep-existing", &origin);
        fs::write(target.join("context/agent/rules.md"), "# 이미 있는 규칙\n").expect("existing");

        let receipt = publish_project_instruction_from_paths(
            &root,
            &app_data_of(&root),
            Some(&home),
            &projects,
            &PublishProjectInstructionRequest {
                key: "keep-existing".to_owned(),
                scope: None,
                project_path: Some(target.to_string_lossy().into_owned()),
                providers: vec![ProviderId::Codex],
                overwrite: SkillOverwritePolicy::Fail,
            },
        )
        .expect("publish");
        let deployment = &receipt.results[0];
        // 지침 파일은 새로 갔지만 기존 연결 문서는 덮지 않고, 건너뛴 사실을 알린다.
        assert_eq!(
            deployment.outcome,
            Some(InstructionPublishOutcome::Published)
        );
        assert_eq!(
            fs::read_to_string(target.join("context/agent/rules.md")).expect("kept"),
            "# 이미 있는 규칙\n"
        );
        assert!(deployment
            .linked_results
            .iter()
            .any(|result| result.relative == "context/agent/rules.md"
                && result.outcome == InstructionPublishOutcome::Skipped));
        assert!(deployment
            .message
            .as_deref()
            .is_some_and(|message| message.contains("연결 문서 1개")));
    }

    #[test]
    fn shared_delete_moves_linked_documents_and_keeps_edited_sets() {
        let temp = tempfile::tempdir().expect("temp");
        let data = temp.path().join("app-data");
        let home = temp.path().join("home");
        let root = temp.path().join("instructions");
        let origin = temp.path().join("origin");
        let clean = temp.path().join("clean");
        let edited = temp.path().join("edited");
        fs::create_dir_all(&data).expect("data");
        fs::create_dir_all(&origin).expect("origin");
        fs::create_dir_all(&clean).expect("clean");
        fs::create_dir_all(&edited).expect("edited");
        write_linked_instruction(&origin, &home);
        let projects = vec![
            registered(&clean, &[ProviderId::Codex]),
            registered(&edited, &[ProviderId::Codex]),
        ];
        // 원본은 origin에서 가져오지만 삭제 대상은 등록된 두 위치다.
        let import_projects = vec![
            registered(&origin, &[ProviderId::Codex]),
            registered(&clean, &[ProviderId::Codex]),
            registered(&edited, &[ProviderId::Codex]),
        ];
        import_codex_with_links(&root, &home, &import_projects, "delete-set", &origin);
        publish_codex(&root, &projects, "delete-set", &clean);
        publish_codex(&root, &projects, "delete-set", &edited);
        fs::write(
            edited.join("context/agent/source-map.md"),
            "# 사람이 고친 맵\n",
        )
        .expect("edit doc");

        // 삭제 영향: 지침 파일과 함께 그 위치의 연결 문서까지 보여준다.
        let impact = check_project_instruction_delete_from_paths(
            &root,
            &app_data_of(&root),
            None,
            &projects,
            &InstructionDeleteCheckRequest {
                key: Some("delete-set".to_owned()),
                scope: None,
                project_path: None,
                provider: None,
            },
        )
        .expect("impact");
        let clean_map = fs::canonicalize(&clean)
            .expect("canonical clean")
            .join("context/agent/source-map.md");
        assert!(impact
            .items
            .iter()
            .any(|item| Path::new(&item.path) == clean_map));
        // 연결 문서가 달라진 위치는 세트째 남긴다.
        assert!(impact
            .warnings
            .iter()
            .any(|warning| warning.contains("연결 문서가 원본과 다른 지침")));

        let receipt = delete_shared_project_instruction_from_paths(
            &root,
            None,
            &projects,
            &data,
            &DeleteSharedProjectInstructionRequest {
                key: "delete-set".to_owned(),
                deleted_by: Some("aia".to_owned()),
                confirm: true,
            },
        )
        .expect("shared delete");
        assert!(!clean.join("AGENTS.md").exists());
        assert!(!clean_map.exists());
        assert!(edited.join("AGENTS.md").is_file());
        assert_eq!(
            fs::read_to_string(edited.join("context/agent/source-map.md")).expect("kept"),
            "# 사람이 고친 맵\n"
        );

        // 복구는 그룹 단위라 지침과 연결 문서가 함께 돌아온다.
        restore_instruction_trash(&data, &receipt.items[0].id).expect("restore");
        assert!(clean.join("AGENTS.md").is_file());
        assert!(clean_map.is_file());
        assert!(root
            .join("delete-set/context/agent/source-map.md")
            .is_file());
    }

    /// InstructionPublishOutcome의 문자열 포맷팅, 파싱, 직렬화, 역직렬화 및 상태 판별 헬퍼를 검증한다.
    #[test]
    fn instruction_publish_outcome_contract_and_serde() {
        for outcome in InstructionPublishOutcome::ALL {
            let s = outcome.as_str();
            assert_eq!(outcome.to_string(), s);
            assert_eq!(
                s.parse::<InstructionPublishOutcome>().expect("parse"),
                outcome
            );

            let json = serde_json::to_string(&outcome).expect("serialize");
            assert_eq!(json, format!("\"{s}\""));
            let back: InstructionPublishOutcome = serde_json::from_str(&json).expect("deserialize");
            assert_eq!(back, outcome);
        }

        // 상태 판별 헬퍼 검증
        assert!(InstructionPublishOutcome::Published.is_published());
        assert!(!InstructionPublishOutcome::Published.is_replaced());
        assert!(InstructionPublishOutcome::Published.is_successful());

        assert!(InstructionPublishOutcome::Replaced.is_replaced());
        assert!(!InstructionPublishOutcome::Replaced.is_unchanged());
        assert!(InstructionPublishOutcome::Replaced.is_successful());

        assert!(InstructionPublishOutcome::Unchanged.is_unchanged());
        assert!(!InstructionPublishOutcome::Unchanged.is_skipped());
        assert!(InstructionPublishOutcome::Unchanged.is_successful());

        assert!(InstructionPublishOutcome::Skipped.is_skipped());
        assert!(!InstructionPublishOutcome::Skipped.is_failed());
        assert!(!InstructionPublishOutcome::Skipped.is_successful());

        assert!(InstructionPublishOutcome::Failed.is_failed());
        assert!(!InstructionPublishOutcome::Failed.is_published());
        assert!(!InstructionPublishOutcome::Failed.is_successful());

        // 잘못된 문자열 파싱 실패 검증
        assert!("unknown".parse::<InstructionPublishOutcome>().is_err());
        assert!("".parse::<InstructionPublishOutcome>().is_err());
    }
}
