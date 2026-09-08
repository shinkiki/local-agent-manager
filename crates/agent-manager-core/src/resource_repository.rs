//! 스킬과 프로젝트 지침의 공통 원본을 보관하는 사용자 선택 저장소.
//!
//! 기본 저장소는 Agent Manager 앱 데이터 안 `resource-repository`이고, 사용자가
//! OneDrive 같은 클라우드 드라이브의 특정 폴더를 선택하면 그 폴더 아래의
//! `skills`와 `instructions`만 앱 관리 대상으로 삼는다. 설정 파일은 장치별 앱 데이터에
//! 남겨, 클라우드 저장소 자체에 로컬 절대 경로가 섞이지 않게 한다.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::app_data_file::write_private_json;
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
const MIGRATION_MARKER: &str = ".legacy-skills-imported-v1";

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HostPlatform {
    Macos,
    Windows,
    Linux,
}

impl HostPlatform {
    pub const ALL: [Self; 3] = [Self::Macos, Self::Windows, Self::Linux];

    pub fn current() -> Self {
        #[cfg(target_os = "macos")]
        return Self::Macos;
        #[cfg(target_os = "windows")]
        return Self::Windows;
        #[cfg(target_os = "linux")]
        return Self::Linux;
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Macos => "macos",
            Self::Windows => "windows",
            Self::Linux => "linux",
        }
    }
}

impl std::fmt::Display for HostPlatform {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

impl std::str::FromStr for HostPlatform {
    type Err = CoreError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value.trim() {
            "macos" => Ok(Self::Macos),
            "windows" => Ok(Self::Windows),
            "linux" => Ok(Self::Linux),
            other => Err(CoreError::InvalidInput(format!(
                "지원하지 않는 OS 플랫폼입니다: {other}"
            ))),
        }
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

fn stored_settings(app_data_dir: &Path) -> StoredRepositorySettings {
    fs::read(settings_path(app_data_dir))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
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
    copy_missing_directory_children(&legacy, &root.join(SKILLS_DIRECTORY))?;
    fs::write(marker, b"1\n")?;
    Ok(())
}

pub fn set_resource_repository(
    app_data_dir: &Path,
    request: &SetResourceRepositoryRequest,
) -> Result<ResourceRepositorySettings, CoreError> {
    let previous = repository_root(app_data_dir);
    let requested = request.root_path.as_deref().map(str::trim).unwrap_or("");
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
    let target = prepare_repository_root(&target)?;
    let previous = fs::canonicalize(&previous).unwrap_or(previous);

    if request.migrate_existing && previous != target {
        validate_merge_directory_children(
            &previous.join(SKILLS_DIRECTORY),
            &target.join(SKILLS_DIRECTORY),
        )?;
        validate_merge_directory_children(
            &previous.join(INSTRUCTIONS_DIRECTORY),
            &target.join(INSTRUCTIONS_DIRECTORY),
        )?;
        merge_directory_children(
            &previous.join(SKILLS_DIRECTORY),
            &target.join(SKILLS_DIRECTORY),
        )?;
        merge_directory_children(
            &previous.join(INSTRUCTIONS_DIRECTORY),
            &target.join(INSTRUCTIONS_DIRECTORY),
        )?;
    }

    let default = fs::canonicalize(default_repository_root(app_data_dir))
        .unwrap_or_else(|_| default_repository_root(app_data_dir));
    let stored = StoredRepositorySettings {
        root_path: (target != default).then(|| target.to_string_lossy().into_owned()),
    };
    write_private_json(&settings_path(app_data_dir), &stored)?;
    load_resource_repository_settings(app_data_dir)
}

fn validate_merge_directory_children(source: &Path, destination: &Path) -> Result<(), CoreError> {
    if !source.is_dir() {
        return Ok(());
    }
    for entry in fs::read_dir(source)?.flatten() {
        let name = entry.file_name();
        if name.to_string_lossy().starts_with('.') {
            continue;
        }
        let source_path = entry.path();
        if !fs::symlink_metadata(&source_path).is_ok_and(|metadata| metadata.is_dir()) {
            continue;
        }
        validate_merge_directory(&source_path, &destination.join(name))?;
    }
    Ok(())
}

/// 마이그레이션이 심볼릭 링크를 거부할 때 쓰는 문구. 네 군데가 같은 문장에 경로만
/// 바꿔 넣었다.
fn migration_symlink_rejection(path: &Path) -> String {
    format!(
        "심볼릭 링크는 저장소로 마이그레이션할 수 없습니다: {}",
        path.display()
    )
}

fn validate_merge_directory(source: &Path, destination: &Path) -> Result<(), CoreError> {
    let source_metadata = fs::symlink_metadata(source)?;
    ensure_directory(&source_metadata, &migration_symlink_rejection(source))?;
    if !destination.exists() {
        return Ok(());
    }
    if !fs::symlink_metadata(destination).is_ok_and(|metadata| metadata.is_dir()) {
        return Err(CoreError::Conflict(format!(
            "새 저장소 경로 유형이 다릅니다: {}",
            destination.display()
        )));
    }
    for entry in fs::read_dir(source)?.flatten() {
        let source_path = entry.path();
        let target = destination.join(entry.file_name());
        let metadata = fs::symlink_metadata(&source_path)?;
        ensure_not_symlink(&metadata, &migration_symlink_rejection(&source_path))?;
        if metadata.is_dir() {
            validate_merge_directory(&source_path, &target)?;
        } else if metadata.is_file() && target.exists() {
            if !fs::symlink_metadata(&target).is_ok_and(|metadata| metadata.is_file()) {
                return Err(CoreError::Conflict(format!(
                    "새 저장소 경로 유형이 다릅니다: {}",
                    target.display()
                )));
            }
            if fs::read(&source_path)? != fs::read(&target)? {
                return Err(CoreError::Conflict(format!(
                    "새 저장소에 내용이 다른 파일이 있습니다: {}",
                    target.display()
                )));
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
    fs::create_dir_all(resolved.join(SKILLS_DIRECTORY))?;
    fs::create_dir_all(resolved.join(INSTRUCTIONS_DIRECTORY))?;
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

fn merge_directory_children(source: &Path, destination: &Path) -> Result<(), CoreError> {
    if !source.is_dir() {
        return Ok(());
    }
    fs::create_dir_all(destination)?;
    for entry in fs::read_dir(source)?.flatten() {
        let name = entry.file_name();
        let name_text = name.to_string_lossy();
        if name_text.starts_with('.') {
            continue;
        }
        let source_path = entry.path();
        if !fs::symlink_metadata(&source_path).is_ok_and(|metadata| metadata.is_dir()) {
            continue;
        }
        let target = destination.join(name);
        merge_directory_atomically(&source_path, &target)?;
    }
    Ok(())
}

fn copy_missing_directory_children(source: &Path, destination: &Path) -> Result<(), CoreError> {
    if !source.is_dir() {
        return Ok(());
    }
    fs::create_dir_all(destination)?;
    for entry in fs::read_dir(source)?.flatten() {
        let name = entry.file_name();
        if name.to_string_lossy().starts_with('.') {
            continue;
        }
        let source_path = entry.path();
        if !fs::symlink_metadata(&source_path).is_ok_and(|metadata| metadata.is_dir()) {
            continue;
        }
        let target = destination.join(name);
        // 다른 PC가 이미 공유 저장소에 만든 원본은 authoritative하다. 초기 가져오기는
        // 기존 항목을 비교·병합하지 않고 비어 있는 키만 복사한다.
        if fs::symlink_metadata(&target).is_ok() {
            continue;
        }
        merge_directory_atomically(&source_path, &target)?;
    }
    Ok(())
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
    let nonce = uuid::Uuid::new_v4().simple().to_string();
    let stage = parent.join(format!(".agent-manager-repository-stage-{name}-{nonce}"));
    let backup = parent.join(format!(".agent-manager-repository-backup-{name}-{nonce}"));
    let existed = fs::symlink_metadata(destination).is_ok();
    let result = (|| -> Result<(), CoreError> {
        if existed {
            merge_directory(destination, &stage)?;
        }
        merge_directory(source, &stage)?;
        StagedReplace {
            kind: StagedKind::Directory,
            stage: &stage,
            target: destination,
            backup: existed.then_some(backup.as_path()),
        }
        .commit()?;
        if existed {
            let _ = fs::remove_dir_all(&backup);
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(&stage);
        if !destination.exists() && backup.exists() {
            let _ = fs::rename(&backup, destination);
        }
    }
    result
}

fn merge_directory(source: &Path, destination: &Path) -> Result<(), CoreError> {
    ensure_not_symlink(
        &fs::symlink_metadata(source)?,
        &migration_symlink_rejection(source),
    )?;
    fs::create_dir_all(destination)?;
    for entry in fs::read_dir(source)?.flatten() {
        let source_path = entry.path();
        let target = destination.join(entry.file_name());
        let metadata = fs::symlink_metadata(&source_path)?;
        ensure_not_symlink(&metadata, &migration_symlink_rejection(&source_path))?;
        if metadata.is_dir() {
            merge_directory(&source_path, &target)?;
        } else if metadata.is_file() {
            if target.is_file() {
                if fs::read(&source_path)? != fs::read(&target)? {
                    return Err(CoreError::Conflict(format!(
                        "새 저장소에 내용이 다른 파일이 있습니다: {}",
                        target.display()
                    )));
                }
            } else if target.exists() {
                return Err(CoreError::Conflict(format!(
                    "새 저장소 경로 유형이 다릅니다: {}",
                    target.display()
                )));
            } else {
                fs::copy(&source_path, &target)?;
            }
        }
    }
    Ok(())
}

pub(crate) fn resource_manifest_path(directory: &Path) -> PathBuf {
    directory.join(".agent-manager/resource.json")
}

pub(crate) fn load_resource_manifest(directory: &Path) -> ResourcePlatformManifest {
    fs::read(resource_manifest_path(directory))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
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
}
