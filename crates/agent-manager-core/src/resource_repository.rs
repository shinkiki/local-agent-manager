//! 스킬과 프로젝트 지침의 공통 원본을 보관하는 사용자 선택 저장소.
//!
//! 기본 저장소는 Agent Manager 앱 데이터 안 `resource-repository`이고, 사용자가
//! OneDrive 같은 클라우드 드라이브의 특정 폴더를 선택하면 그 폴더 아래의
//! `skills`와 `instructions`만 앱 관리 대상으로 삼는다. 설정 파일은 장치별 앱 데이터에
//! 남겨, 클라우드 저장소 자체에 로컬 절대 경로가 섞이지 않게 한다.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Component, Path, PathBuf};

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

use crate::app_data_file::write_private_json;
use crate::domain::wire_enum;
use crate::file_kind::{ensure_directory, ensure_not_symlink};
use crate::path_guard::{self, CurDirPolicy, MissingTail};
use crate::staged_replace::{StagedKind, StagedReplace};
use crate::user_home::home_dir;
use crate::CoreError;

const SETTINGS_FILE: &str = "resource-repository-settings.json";
const DEFAULT_DIRECTORY: &str = "resource-repository";
const LEGACY_SKILLS_RELATIVE: &str = ".agents/skills";
const SKILLS_DIRECTORY: &str = "skills";
const INSTRUCTIONS_DIRECTORY: &str = "instructions";
const WORKFLOWS_DIRECTORY: &str = "workflows";
const MIGRATION_MARKER: &str = ".legacy-skills-imported-v1";
const MIGRATED_DIRECTORIES: [&str; 2] = [SKILLS_DIRECTORY, INSTRUCTIONS_DIRECTORY];
const REPOSITORY_STAGE_PREFIX: &str = ".agent-manager-repository-stage-";
const REPOSITORY_BACKUP_PREFIX: &str = ".agent-manager-repository-backup-";
const REPOSITORY_SUBDIRECTORIES: [&str; 3] = [
    SKILLS_DIRECTORY,
    INSTRUCTIONS_DIRECTORY,
    WORKFLOWS_DIRECTORY,
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HostPlatform {
    Macos,
    Windows,
    Linux,
}

wire_enum!(trimmed HostPlatform, "지원하지 않는 OS 플랫폼입니다", {
    Macos => "macos",
    Windows => "windows",
    Linux => "linux",
});

impl HostPlatform {
    #[cfg(test)]
    pub(crate) const ALL: [Self; 3] = [Self::Macos, Self::Windows, Self::Linux];

    pub fn current() -> Self {
        #[cfg(target_os = "macos")]
        return Self::Macos;
        #[cfg(target_os = "windows")]
        return Self::Windows;
        #[cfg(target_os = "linux")]
        return Self::Linux;
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredRepositorySettings {
    #[serde(default)]
    root_path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceRepositorySettings {
    pub root_path: String,
    pub default_root_path: String,
    pub custom: bool,
    pub skills_path: String,
    pub instructions_path: String,
    pub current_platform: HostPlatform,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetResourceRepositoryRequest {
    /// null 또는 빈 문자열이면 앱 데이터의 기본 저장소로 되돌린다.
    #[serde(default)]
    pub root_path: Option<String>,
    /// 기존 저장소 내용을 새 저장소로 병합한다. 충돌 파일이 하나라도 다르면 중단한다.
    #[serde(default = "default_true")]
    pub migrate_existing: bool,
}

fn default_true() -> bool {
    true
}

/// 스킬·지침 공통 메타. 각 리소스 디렉터리의 `.agent-manager/resource.json`에 둔다.
/// 메타가 없으면 모든 OS에서 base가 활성인 기존 리소스로 해석한다.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourcePlatformManifest {
    #[serde(default = "manifest_version")]
    pub schema_version: u32,
    #[serde(default)]
    pub platforms: Vec<HostPlatform>,
    /// OS별 overlay 디렉터리. 리소스 디렉터리 기준 상대 경로다.
    #[serde(default)]
    pub variants: BTreeMap<HostPlatform, String>,
    /// OS overlay를 적용하기 전에 base에서 제외할 파일·디렉터리 상대 경로.
    #[serde(default)]
    pub variant_deletes: BTreeMap<HostPlatform, Vec<String>>,
}

fn manifest_version() -> u32 {
    1
}

impl Default for ResourcePlatformManifest {
    fn default() -> Self {
        Self {
            schema_version: manifest_version(),
            platforms: Vec::new(),
            variants: BTreeMap::new(),
            variant_deletes: BTreeMap::new(),
        }
    }
}

impl ResourcePlatformManifest {
    pub fn supports(&self, platform: HostPlatform) -> bool {
        (self.platforms.is_empty() || self.platforms.contains(&platform))
            || self.variants.contains_key(&platform)
    }

    pub fn migration_required(&self, platform: HostPlatform) -> bool {
        !self.supports(platform)
    }

    pub fn active_variant(&self, platform: HostPlatform) -> Option<&str> {
        self.variants.get(&platform).map(String::as_str)
    }
}

pub(crate) fn default_repository_root(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join(DEFAULT_DIRECTORY)
}

fn settings_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join(SETTINGS_FILE)
}

fn read_json_or_default<T>(path: &Path) -> T
where
    T: DeserializeOwned + Default,
{
    fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

fn stored_settings(app_data_dir: &Path) -> StoredRepositorySettings {
    read_json_or_default(&settings_path(app_data_dir))
}

pub(crate) fn repository_root(app_data_dir: &Path) -> PathBuf {
    stored_settings(app_data_dir)
        .root_path
        .filter(|path| !path.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| default_repository_root(app_data_dir))
}

pub(crate) fn repository_skills_root(app_data_dir: &Path) -> PathBuf {
    repository_root(app_data_dir).join(SKILLS_DIRECTORY)
}

pub(crate) fn repository_instructions_root(app_data_dir: &Path) -> PathBuf {
    repository_root(app_data_dir).join(INSTRUCTIONS_DIRECTORY)
}

pub(crate) fn repository_workflows_root(app_data_dir: &Path) -> PathBuf {
    repository_root(app_data_dir).join(WORKFLOWS_DIRECTORY)
}

pub fn load_resource_repository_settings(
    app_data_dir: &Path,
) -> Result<ResourceRepositorySettings, CoreError> {
    let root = repository_root(app_data_dir);
    let default = default_repository_root(app_data_dir);
    Ok(ResourceRepositorySettings {
        custom: root != default,
        skills_path: root.join(SKILLS_DIRECTORY).to_string_lossy().into_owned(),
        instructions_path: root
            .join(INSTRUCTIONS_DIRECTORY)
            .to_string_lossy()
            .into_owned(),
        root_path: root.to_string_lossy().into_owned(),
        default_root_path: default.to_string_lossy().into_owned(),
        current_platform: HostPlatform::current(),
    })
}

/// 백엔드 시작 시 기본 폴더를 준비하고 기존 공통 스킬을 한 번 복사한다.
/// 원본 `~/.agents/skills`와 타 도구의 lock 파일은 수정하거나 읽지 않는다.
pub(crate) fn initialize_resource_repository(app_data_dir: &Path) -> Result<(), CoreError> {
    let root = prepare_repository_root(&repository_root(app_data_dir))?;
    let default = resolve_without_creating(&default_repository_root(app_data_dir))?;
    if root != default {
        // 사용자 지정 저장소는 이미 존재하는 클라우드 원본이 권위 있다. 경로 전환 때
        // migrateExisting=false를 선택한 의사도 보존해야 하므로 레거시를 넣지 않는다.
        return Ok(());
    }
    let marker = root.join(MIGRATION_MARKER);
    if marker.is_file() {
        return Ok(());
    }
    let legacy = home_dir()?.join(LEGACY_SKILLS_RELATIVE);
    adopt_child_directories(&legacy, &root.join(SKILLS_DIRECTORY), ExistingChild::Keep)?;
    fs::write(marker, b"1\n")?;
    Ok(())
}

pub fn set_resource_repository(
    app_data_dir: &Path,
    request: &SetResourceRepositoryRequest,
) -> Result<ResourceRepositorySettings, CoreError> {
    let previous = repository_root(app_data_dir);
    let target = requested_repository_root(app_data_dir, request.root_path.as_deref())?;
    let previous = fs::canonicalize(&previous).unwrap_or(previous);

    if request.migrate_existing && previous != target {
        migrate_repository_contents(&previous, &target)?;
    }

    let default = fs::canonicalize(default_repository_root(app_data_dir))
        .unwrap_or_else(|_| default_repository_root(app_data_dir));
    let stored = StoredRepositorySettings {
        root_path: (target != default).then(|| target.to_string_lossy().into_owned()),
    };
    write_private_json(&settings_path(app_data_dir), &stored)?;
    load_resource_repository_settings(app_data_dir)
}

/// 비어 있는 요청은 기본 저장소로 되돌리고, 사용자 지정 요청은 절대 경로만 허용한 뒤
/// 공통 저장소 루트의 안전성 검사와 준비를 한곳에서 수행한다.
fn requested_repository_root(
    app_data_dir: &Path,
    requested: Option<&str>,
) -> Result<PathBuf, CoreError> {
    let requested = requested.map(str::trim).unwrap_or("");
    let target = if requested.is_empty() {
        default_repository_root(app_data_dir)
    } else {
        let path = PathBuf::from(requested);
        if !path.is_absolute() {
            return Err(CoreError::InvalidInput(
                "저장소 경로는 절대 경로여야 합니다".to_owned(),
            ));
        }
        path
    };
    prepare_repository_root(&target)
}

/// 모든 충돌 검증을 끝낸 뒤에만 스킬·지침 원본을 복사한다. 두 순회를 합치면 뒤쪽
/// 디렉터리의 충돌을 발견하기 전에 앞쪽 디렉터리가 일부 복사될 수 있다.
fn migrate_repository_contents(previous: &Path, target: &Path) -> Result<(), CoreError> {
    for dir in MIGRATED_DIRECTORIES {
        validate_merge_directory_children(&previous.join(dir), &target.join(dir))?;
    }
    for dir in MIGRATED_DIRECTORIES {
        adopt_child_directories(&previous.join(dir), &target.join(dir), ExistingChild::Merge)?;
    }
    Ok(())
}

/// 마이그레이션 대상이 되는 자식 디렉터리(숨김 디렉터리·비디렉터리 제외) 목록을 수집한다.
fn visible_child_directories(
    source: &Path,
) -> Result<Vec<(std::ffi::OsString, PathBuf)>, CoreError> {
    if !source.is_dir() {
        return Ok(Vec::new());
    }
    let mut dirs = Vec::new();
    for entry in fs::read_dir(source)?.flatten() {
        let name = entry.file_name();
        if name.to_string_lossy().starts_with('.') {
            continue;
        }
        let source_path = entry.path();
        if !fs::symlink_metadata(&source_path).is_ok_and(|metadata| metadata.is_dir()) {
            continue;
        }
        dirs.push((name, source_path));
    }
    Ok(dirs)
}

fn validate_merge_directory_children(source: &Path, destination: &Path) -> Result<(), CoreError> {
    for (name, source_path) in visible_child_directories(source)? {
        walk_merge(&source_path, &destination.join(name), MergeWalk::Validate)?;
    }
    Ok(())
}

/// 마이그레이션 대상 파일이 대상 위치에 이미 존재할 때 유형과 내용 호환성을 검증한다.
/// 대상 파일이 존재하면 Ok(true), 존재하지 않으면 Ok(false)를 반환한다.
fn ensure_compatible_file_target(source: &Path, target: &Path) -> Result<bool, CoreError> {
    if !target.exists() {
        return Ok(false);
    }
    if !fs::symlink_metadata(target).is_ok_and(|metadata| metadata.is_file()) {
        return Err(CoreError::Conflict(format!(
            "새 저장소 경로 유형이 다릅니다: {}",
            target.display()
        )));
    }
    if fs::read(source)? != fs::read(target)? {
        return Err(CoreError::Conflict(format!(
            "새 저장소에 내용이 다른 파일이 있습니다: {}",
            target.display()
        )));
    }
    Ok(true)
}

/// 마이그레이션이 심볼릭 링크를 거부할 때 쓰는 문구. 네 군데가 같은 문장에 경로만
/// 바꿔 넣었다.
fn migration_symlink_rejection(path: &Path) -> String {
    format!(
        "심볼릭 링크는 저장소로 마이그레이션할 수 없습니다: {}",
        path.display()
    )
}

/// 저장소 병합 순회가 지켜야 할 규칙(심볼릭 링크 거부·대상 유형 일치·같은 이름 파일의 내용
/// 일치)은 한 벌인데, 검사만 하는 사전 통과와 실제로 복사하는 본 통과가 따로 적어 두고 있었다.
/// 한쪽만 고치면 사전 통과가 허용한 것을 본 통과가 거부하는 어긋남이 생긴다.
#[derive(Clone, Copy, PartialEq, Eq)]
enum MergeWalk {
    /// 대상과 충돌하는지만 본다. 아무것도 쓰지 않는다.
    Validate,
    /// 검사를 통과한 항목을 대상으로 복사한다.
    Apply,
}

fn walk_merge(source: &Path, destination: &Path, walk: MergeWalk) -> Result<(), CoreError> {
    let source_metadata = fs::symlink_metadata(source)?;
    let source_rejection = migration_symlink_rejection(source);
    match walk {
        MergeWalk::Validate => {
            ensure_directory(&source_metadata, &source_rejection)?;
            if !destination.exists() {
                // 대상이 없으면 충돌할 상대도 없다. 아래 항목의 심볼릭 링크는 Apply가 거른다.
                return Ok(());
            }
            if !fs::symlink_metadata(destination).is_ok_and(|metadata| metadata.is_dir()) {
                return Err(CoreError::Conflict(format!(
                    "새 저장소 경로 유형이 다릅니다: {}",
                    destination.display()
                )));
            }
        }
        MergeWalk::Apply => {
            ensure_not_symlink(&source_metadata, &source_rejection)?;
            fs::create_dir_all(destination)?;
        }
    }
    for entry in fs::read_dir(source)?.flatten() {
        let source_path = entry.path();
        let target = destination.join(entry.file_name());
        let metadata = fs::symlink_metadata(&source_path)?;
        ensure_not_symlink(&metadata, &migration_symlink_rejection(&source_path))?;
        if metadata.is_dir() {
            walk_merge(&source_path, &target, walk)?;
        } else if metadata.is_file() {
            let already_present = ensure_compatible_file_target(&source_path, &target)?;
            if walk == MergeWalk::Apply && !already_present {
                fs::copy(&source_path, &target)?;
            }
        }
    }
    Ok(())
}

fn reject_unsafe_root(path: &Path) -> Result<(), CoreError> {
    if !path.is_absolute() || path.parent().is_none() {
        return Err(CoreError::InvalidInput(
            "파일시스템 루트는 저장소로 사용할 수 없습니다".to_owned(),
        ));
    }
    if path_guard::has_parent_dir(path) {
        return Err(CoreError::InvalidInput(
            "저장소 경로에 상위 경로(..)를 사용할 수 없습니다".to_owned(),
        ));
    }
    Ok(())
}

fn prepare_repository_root(root: &Path) -> Result<PathBuf, CoreError> {
    reject_unsafe_root(root)?;
    let resolved = resolve_without_creating(root)?;
    reject_unsafe_root(&resolved)?;
    reject_provider_owned_ancestor(&resolved)?;
    fs::create_dir_all(&resolved)?;
    let resolved = fs::canonicalize(&resolved)?;
    reject_unsafe_root(&resolved)?;
    for dir in REPOSITORY_SUBDIRECTORIES {
        fs::create_dir_all(resolved.join(dir))?;
    }
    Ok(resolved)
}

fn reject_provider_owned_ancestor(path: &Path) -> Result<(), CoreError> {
    if path.components().any(|component| {
        let Component::Normal(value) = component else {
            return false;
        };
        let value = value.to_string_lossy();
        [".claude", ".codex", ".gemini", ".agents"]
            .iter()
            .any(|reserved| value.eq_ignore_ascii_case(reserved))
    }) {
        return Err(CoreError::InvalidInput(
            "공급자 또는 기존 .agents 소유 경로 안에는 공통 저장소를 만들 수 없습니다".to_owned(),
        ));
    }
    Ok(())
}

/// 아직 존재하지 않는 끝부분은 가장 가까운 기존 조상을 정규화한 뒤 다시 붙인다.
/// 이 순서를 지켜야 `/safe/link -> /` 같은 경로 아래에 쓰기 전에 실제 대상을 알 수 있다.
fn resolve_without_creating(path: &Path) -> Result<PathBuf, CoreError> {
    path_guard::resolve_existing_ancestor(path, MissingTail::SkipNotFound, "저장소 경로")
}

/// 대상에 같은 이름의 자식이 이미 있을 때 어떻게 할지.
#[derive(Clone, Copy, PartialEq, Eq)]
enum ExistingChild {
    /// 기존 항목과 병합한다(경로 이전).
    Merge,
    /// 기존 항목을 그대로 두고 건너뛴다(초기 가져오기).
    Keep,
}

fn adopt_child_directories(
    source: &Path,
    destination: &Path,
    existing: ExistingChild,
) -> Result<(), CoreError> {
    let children = visible_child_directories(source)?;
    if children.is_empty() {
        return Ok(());
    }
    fs::create_dir_all(destination)?;
    for (name, source_path) in children {
        let target = destination.join(name);
        // 다른 PC가 이미 공유 저장소에 만든 원본은 authoritative하다. 초기 가져오기는
        // 기존 항목을 비교·병합하지 않고 비어 있는 키만 복사한다.
        if existing == ExistingChild::Keep && fs::symlink_metadata(&target).is_ok() {
            continue;
        }
        merge_directory_atomically(&source_path, &target)?;
    }
    Ok(())
}

/// 저장소 디렉터리 원자적 병합에 쓰는 임시 스테이징·백업 경로를 묶는다.
struct RepositoryStagePaths {
    stage: PathBuf,
    backup: PathBuf,
}

impl RepositoryStagePaths {
    fn new(parent: &Path, name: &str) -> Self {
        let nonce = publish_nonce();
        Self {
            stage: parent.join(format!("{REPOSITORY_STAGE_PREFIX}{name}-{nonce}")),
            backup: parent.join(format!("{REPOSITORY_BACKUP_PREFIX}{name}-{nonce}")),
        }
    }

    fn cleanup_stage(&self) {
        let _ = fs::remove_dir_all(&self.stage);
    }

    fn cleanup_backup(&self) {
        let _ = fs::remove_dir_all(&self.backup);
    }

    fn restore_backup(&self, destination: &Path) {
        if !destination.exists() && self.backup.exists() {
            let _ = fs::rename(&self.backup, destination);
        }
    }
}

fn merge_directory_atomically(source: &Path, destination: &Path) -> Result<(), CoreError> {
    let parent = destination.parent().ok_or_else(|| {
        CoreError::InvalidInput("저장소 리소스의 상위 경로를 확인할 수 없습니다".to_owned())
    })?;
    fs::create_dir_all(parent)?;
    let name = destination
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .ok_or_else(|| CoreError::InvalidInput("저장소 리소스 이름이 없습니다".to_owned()))?;
    let paths = RepositoryStagePaths::new(parent, &name);
    let existed = fs::symlink_metadata(destination).is_ok();
    let result = (|| -> Result<(), CoreError> {
        if existed {
            walk_merge(destination, &paths.stage, MergeWalk::Apply)?;
        }
        walk_merge(source, &paths.stage, MergeWalk::Apply)?;
        StagedReplace {
            kind: StagedKind::Directory,
            stage: &paths.stage,
            target: destination,
            backup: existed.then_some(paths.backup.as_path()),
        }
        .commit()?;
        if existed {
            paths.cleanup_backup();
        }
        Ok(())
    })();
    if result.is_err() {
        paths.cleanup_stage();
        paths.restore_backup(destination);
    }
    result
}

/// 스킬·지침 키가 Windows 예약 장치 이름과 겹치는지 본다. 확장자를 뗀 첫
/// 구성요소만 보는 것은 Windows가 `con.md`도 `CON`으로 다루기 때문이다. 공통
/// 원본은 세 플랫폼이 함께 쓰므로 macOS에서 만든 이름도 여기서 막는다.
pub(crate) fn is_windows_reserved_stem(value: &str) -> bool {
    const RESERVED: &[&str] = &[
        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
        "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    ];
    let stem = value
        .split('.')
        .next()
        .unwrap_or(value)
        .to_ascii_uppercase();
    RESERVED.contains(&stem.as_str())
}

/// 스테이징·백업 이름에 쓰는 충돌 방지 값. 같은 프로세스 안에서 동시에 두 번
/// 게시해도 이름이 겹치지 않는다.
pub(crate) fn publish_nonce() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

pub(crate) fn resource_manifest_path(directory: &Path) -> PathBuf {
    directory.join(".agent-manager/resource.json")
}

pub(crate) fn load_resource_manifest(directory: &Path) -> ResourcePlatformManifest {
    read_json_or_default(&resource_manifest_path(directory))
}

pub(crate) fn validate_variant_relative_path(path: &str) -> Result<PathBuf, CoreError> {
    let path = PathBuf::from(path);
    if path_guard::classify_relative_path(&path, CurDirPolicy::Reject).is_some() {
        return Err(CoreError::InvalidInput(
            "OS 변형 경로는 리소스 안의 상대 경로여야 합니다".to_owned(),
        ));
    }
    Ok(path)
}

pub(crate) fn validate_platform_variant_path(
    platform: HostPlatform,
    path: &str,
) -> Result<PathBuf, CoreError> {
    let path = validate_variant_relative_path(path)?;
    let expected = PathBuf::from(".agent-manager")
        .join("variants")
        .join(platform.as_str());
    if path != expected {
        return Err(CoreError::InvalidInput(format!(
            "{platform} OS 변형 경로는 {}여야 합니다",
            expected.display()
        )));
    }
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_repository_is_inside_app_data() {
        let app_data = Path::new("/tmp/agent-manager-data");
        assert_eq!(
            repository_skills_root(app_data),
            app_data.join("resource-repository/skills")
        );
        assert_eq!(
            repository_instructions_root(app_data),
            app_data.join("resource-repository/instructions")
        );
    }

    #[test]
    fn manifest_without_platforms_is_portable() {
        let manifest = ResourcePlatformManifest::default();
        assert!(manifest.supports(HostPlatform::Macos));
        assert!(!manifest.migration_required(HostPlatform::Windows));
    }

    #[test]
    fn variant_activates_an_otherwise_unsupported_platform() {
        let mut manifest = ResourcePlatformManifest {
            schema_version: 1,
            platforms: vec![HostPlatform::Macos],
            variants: BTreeMap::new(),
            variant_deletes: BTreeMap::new(),
        };
        assert!(manifest.migration_required(HostPlatform::Windows));
        manifest
            .variants
            .insert(HostPlatform::Windows, "variants/windows".to_owned());
        assert!(manifest.supports(HostPlatform::Windows));
        assert_eq!(
            manifest.active_variant(HostPlatform::Windows),
            Some("variants/windows")
        );
    }

    #[test]
    fn platform_variant_path_is_exact_and_cannot_alias_the_resource_root() {
        assert!(validate_platform_variant_path(
            HostPlatform::Windows,
            ".agent-manager/variants/windows"
        )
        .is_ok());
        assert!(validate_platform_variant_path(HostPlatform::Windows, ".").is_err());
        assert!(validate_platform_variant_path(
            HostPlatform::Windows,
            ".agent-manager/variants/linux"
        )
        .is_err());
    }

    #[test]
    fn provider_owned_ancestors_cannot_be_selected_as_repository() {
        assert!(reject_provider_owned_ancestor(Path::new("/tmp/.codex/shared")).is_err());
        assert!(reject_provider_owned_ancestor(Path::new("/tmp/.agents")).is_err());
        assert!(reject_provider_owned_ancestor(Path::new("/tmp/OneDrive/AgentManager")).is_ok());
    }

    #[test]
    fn custom_repository_does_not_run_the_legacy_default_import() {
        let temp = tempfile::tempdir().expect("temp");
        let app_data = temp.path().join("app-data");
        let custom = temp.path().join("OneDrive/AgentManager");
        fs::create_dir_all(&app_data).expect("app data");
        write_private_json(
            &settings_path(&app_data),
            &StoredRepositorySettings {
                root_path: Some(custom.to_string_lossy().into_owned()),
            },
        )
        .expect("settings");

        initialize_resource_repository(&app_data).expect("initialize");

        assert!(custom.join(SKILLS_DIRECTORY).is_dir());
        assert!(!custom.join(MIGRATION_MARKER).exists());
    }

    #[test]
    fn selecting_a_custom_repository_copies_existing_sources_and_keeps_the_original() {
        let temp = tempfile::tempdir().expect("temp");
        let app_data = temp.path().join("app-data");
        let source = default_repository_root(&app_data).join("skills/review");
        fs::create_dir_all(&source).expect("source");
        fs::create_dir_all(default_repository_root(&app_data).join("instructions"))
            .expect("instructions");
        fs::write(source.join("SKILL.md"), "# review\n").expect("skill");
        let custom = temp.path().join("OneDrive/AgentManager");

        let settings = set_resource_repository(
            &app_data,
            &SetResourceRepositoryRequest {
                root_path: Some(custom.to_string_lossy().into_owned()),
                migrate_existing: true,
            },
        )
        .expect("select repository");

        assert!(settings.custom);
        assert_eq!(
            fs::read_to_string(custom.join("skills/review/SKILL.md")).unwrap(),
            "# review\n"
        );
        assert!(
            source.join("SKILL.md").is_file(),
            "복사는 기존 원본을 남긴다"
        );
        assert!(fs::read_dir(custom.join("skills"))
            .unwrap()
            .flatten()
            .all(|entry| !entry.file_name().to_string_lossy().starts_with('.')));
    }

    #[test]
    fn repository_migration_conflict_keeps_the_previous_setting_and_target() {
        let temp = tempfile::tempdir().expect("temp");
        let app_data = temp.path().join("app-data");
        let source = default_repository_root(&app_data).join("skills/review");
        let custom = temp.path().join("OneDrive/AgentManager");
        let target = custom.join("skills/review");
        fs::create_dir_all(&source).expect("source");
        fs::create_dir_all(default_repository_root(&app_data).join("instructions"))
            .expect("instructions");
        fs::create_dir_all(&target).expect("target");
        fs::write(source.join("SKILL.md"), "source\n").expect("source file");
        fs::write(target.join("SKILL.md"), "cloud\n").expect("target file");

        assert!(matches!(
            set_resource_repository(
                &app_data,
                &SetResourceRepositoryRequest {
                    root_path: Some(custom.to_string_lossy().into_owned()),
                    migrate_existing: true,
                },
            ),
            Err(CoreError::Conflict(_))
        ));
        assert_eq!(
            repository_root(&app_data),
            default_repository_root(&app_data)
        );
        assert_eq!(
            fs::read_to_string(target.join("SKILL.md")).unwrap(),
            "cloud\n"
        );
    }

    #[cfg(unix)]
    #[test]
    fn repository_symlink_to_filesystem_root_is_rejected_before_managed_writes() {
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().expect("temp");
        let link = temp.path().join("root-link");
        symlink("/", &link).expect("symlink");

        assert!(matches!(
            prepare_repository_root(&link),
            Err(CoreError::InvalidInput(_))
        ));
    }

    #[test]
    fn host_platform_all_and_display() {
        assert_eq!(
            HostPlatform::ALL,
            [
                HostPlatform::Macos,
                HostPlatform::Windows,
                HostPlatform::Linux
            ]
        );
        for platform in HostPlatform::ALL {
            assert_eq!(platform.to_string(), platform.as_str());
            assert_eq!(platform.as_str().parse::<HostPlatform>().unwrap(), platform);
        }
        assert!(HostPlatform::ALL.contains(&HostPlatform::current()));
        assert!(matches!(
            "unknown".parse::<HostPlatform>(),
            Err(CoreError::InvalidInput(_))
        ));
    }

    #[test]
    fn repository_stage_paths_naming_and_cleanup() {
        let temp = tempfile::tempdir().expect("temp");
        let parent = temp.path();
        let paths = RepositoryStagePaths::new(parent, "my-skill");
        let stage_name = paths.stage.file_name().unwrap().to_string_lossy();
        let backup_name = paths.backup.file_name().unwrap().to_string_lossy();
        assert!(stage_name.starts_with(".agent-manager-repository-stage-my-skill-"));
        assert!(backup_name.starts_with(".agent-manager-repository-backup-my-skill-"));

        fs::create_dir_all(&paths.stage).expect("create stage");
        fs::create_dir_all(&paths.backup).expect("create backup");
        assert!(paths.stage.exists());
        assert!(paths.backup.exists());

        paths.cleanup_stage();
        assert!(!paths.stage.exists());

        paths.cleanup_backup();
        assert!(!paths.backup.exists());

        // 백업 복구 검증: 목적지 파일이 없고 백업이 있으면 이동 복구
        let destination = parent.join("my-skill");
        fs::create_dir_all(&paths.backup).expect("create backup again");
        paths.restore_backup(&destination);
        assert!(destination.exists());
        assert!(!paths.backup.exists());
    }
}
