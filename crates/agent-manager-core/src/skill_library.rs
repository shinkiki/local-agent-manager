//! 공통 스킬 원본 하나를 여러 공급자에 게시하는 통합 스킬 라이브러리.
//!
//! # 경계
//!
//! 공통 원본 루트는 사용자별 리소스 저장소의 `skills` 디렉터리다. 기본값은 앱
//! 데이터 내부이고, 클라우드 드라이브의 특정 폴더로 바꿀 수 있다. 예전
//! `~/.agents/skills`는 초기화 시 읽기 전용으로 한 번 복사할 뿐 수정하지 않는다.
//!
//! 게시 대상은 공급자의 **사용자 스킬 루트**로 한정한다. 공급자·플러그인이 소유한
//! `.system`, `builtin/skills`, 설치된 플러그인 스킬은 읽기 전용으로만 읽고
//! 절대 쓰지 않는다.
//!
//! 게시는 심볼릭 링크가 아니라 원자적 복사로 한다. 링크는 대상 OS·공급자에 따라
//! 해석이 갈리고 백업·이식에서 끊기기 때문이다. 다만 다른 도구가 이미 만들어 둔
//! 링크는 `linked` 상태로 **인식**해 공존한다.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use unicode_normalization::UnicodeNormalization;

#[cfg(test)]
use crate::catalog::claude_project_paths;
use crate::catalog::{
    build_file_tree, claude_installed_plugin_skill_dirs, frontmatter_value, read_text_limited,
    split_frontmatter, stable_id, ACTIVE_AG_ROOTS,
};

use crate::domain::{
    CommonSkillDetail, CommonSkillDigest, CommonSkillSource, ProviderId, SessionSummary,
    SkillAdapterRootView, SkillAdapterView, SkillInstallView, SkillLibrary, SkillLibraryEntry,
    SkillLibraryIssue, SkillOriginKind, SkillOriginView, SkillProjectView, SkillProviderState,
    SkillProviderStatus,
};
use crate::file_kind::regular_file_metadata;
use crate::path_guard::{self, CurDirPolicy, RelativePathIssue, RootLabels};
use crate::resource_repository::{
    load_resource_manifest, repository_skills_root, resource_manifest_path,
    validate_platform_variant_path, validate_variant_relative_path, HostPlatform,
    ResourcePlatformManifest,
};
use crate::skill_meta::{
    load_skill_meta, record_skill_origin, remove_skill_meta, SkillMetaEntry, SkillMetaStore,
    SkillOriginMeta,
};
use crate::skill_trash::{
    store_trash_item, SkillTrashItem, SkillTrashItemDraft, SkillTrashItemKind,
};
use crate::staged_replace::{StagedKind, StagedReplace};
use crate::trash_store::new_trash_group_id;
use crate::user_home::home_dir;
use crate::CoreError;

const LIBRARY_SCHEMA_VERSION: u32 = 1;

/// 공통 스킬 원본 루트. 홈 기준 상대 경로.
#[cfg(test)]
const LEGACY_COMMON_ROOT_RELATIVE: &str = ".agents/skills";

const MAX_SKILL_MD_BYTES: u64 = 5 * 1024 * 1024;
const MAX_SKILL_FILES: usize = 2_000;
const MAX_SKILL_TOTAL_BYTES: u64 = 64 * 1024 * 1024;
const MAX_SKILL_KEY_CHARS: usize = 64;
/// Claude 스킬 규격이 요구하는 설명 상한. 초과하면 발견 단계에서 잘릴 수 있다.
const MAX_DESCRIPTION_CHARS: usize = 1_024;

/// Agent Manager가 만든 임시·백업 디렉터리 접두사. 게시 중 중단되어 남더라도
/// 공급자 스킬 목록에 섞이지 않도록 숨김 이름을 쓴다.
const STAGE_PREFIX: &str = ".agent-manager-stage-";
const BACKUP_PREFIX: &str = ".agent-manager-backup-";

/// 파일시스템에서 읽은 이름을 표시용 문자열로 만든다. macOS(APFS/HFS+)는 이름을
/// NFD로 저장해 한글 자소가 분리돼 보이므로 NFC로 정규화한다. 경로 비교·저장에는
/// 원형을 그대로 쓰고, 사용자에게 보여줄 이름에만 이 함수를 거친다.
pub(crate) fn display_file_name(path: &Path) -> Option<String> {
    path.file_name()
        .map(|value| value.to_string_lossy().nfc().collect())
}

/// 내용 지문과 복사에서 제외하는 OS 부산물.
const IGNORED_FILE_NAMES: &[&str] = &[".DS_Store", "Thumbs.db", "desktop.ini"];

// ---------------------------------------------------------------------------
// 공급자 어댑터
// ---------------------------------------------------------------------------

/// 공급자 스킬 루트 한 곳. `installable`은 Agent Manager가 게시 대상으로 쓸 수 있는
/// 사용자 스킬 루트라는 뜻이고, 공급자·플러그인 소유 루트는 항상 읽기 전용이다.
#[derive(Debug, Clone)]
struct AdapterRoot {
    scope: &'static str,
    path: PathBuf,
    origin: Option<String>,
    /// 프로젝트 루트 경로. scope가 project일 때만 있다.
    project_path: Option<PathBuf>,
    read_only: bool,
    installable: bool,
    /// 숨김(`.`) 디렉터리도 스킬로 읽는 루트인지. `~/.codex/skills`는 `.system`을
    /// 하위에 두기 때문에 숨김 항목을 따로 걸러야 한다.
    include_hidden: bool,
}

/// 스킬 노출에 관한 공급자별 계약. 경로와 프런트매터 취급 차이를 여기로 모아
/// 게시 로직 본문에서는 공급자를 구분하지 않는다.
#[derive(Debug, Clone, Copy)]
pub(crate) struct SkillAdapter {
    provider: ProviderId,
    display_name: &'static str,
    /// 개인 스킬 루트의 홈 기준 상대 경로. 게시 대상이 되는 유일한 사용자 루트다.
    personal_root_relative: &'static str,
    /// 등록 프로젝트 스킬 루트의 프로젝트 기준 상대 경로. 공급자마다 이름이 다르다.
    project_root_relative: &'static str,
    /// 사용자 스킬 루트가 없어 공통 원본을 게시할 수 없는 공급자에 남기는 설명.
    unsupported_note: Option<&'static str>,
}

const ADAPTERS: &[SkillAdapter] = &[
    SkillAdapter {
        provider: ProviderId::Claude,
        display_name: "Claude Code",
        personal_root_relative: ".claude/skills",
        project_root_relative: ".claude/skills",
        unsupported_note: None,
    },
    SkillAdapter {
        provider: ProviderId::Codex,
        display_name: "OpenAI Codex",
        personal_root_relative: ".codex/skills",
        project_root_relative: ".codex/skills",
        unsupported_note: None,
    },
    SkillAdapter {
        provider: ProviderId::Antigravity,
        display_name: "Google Antigravity",
        // 공식 CLI가 읽는 개인 `.gemini/config/skills`와 프로젝트 `.agents/skills`를 쓴다.
        personal_root_relative: ".gemini/config/skills",
        project_root_relative: ".agents/skills",
        unsupported_note: None,
    },
];

/// 다른 공급자만 해석하는 프런트매터 키. 게시할 때 대상 공급자가 쓰지 않는 키만
/// 정확히 걷어내고, 모르는 키는 손대지 않는다. 알 수 없는 키를 지우는 쪽이 원본
/// 정보를 잃게 만들기 때문이다.
fn provider_only_frontmatter_keys(provider: ProviderId) -> &'static [&'static str] {
    match provider {
        // Claude 전용 실행 제어 키. Codex·Antigravity는 해석하지 않는다.
        ProviderId::Claude => &[],
        ProviderId::Codex | ProviderId::Antigravity => {
            &["allowed-tools", "allowed_tools", "disable-model-invocation"]
        }
    }
}

impl SkillAdapter {
    /// 게시 대상인 개인 스킬 루트 경로.
    fn personal_root(&self, home: &Path) -> PathBuf {
        home.join(self.personal_root_relative)
    }

    /// 등록 프로젝트 안의 스킬 루트 경로. `resolve_install_root`가 등록 여부를
    /// 재검증한 뒤 위치 지정 게시 대상으로도 쓴다.
    fn project_root(&self, project: &Path) -> PathBuf {
        project.join(self.project_root_relative)
    }

    /// 개인 루트 항목. 공급자별로 경로 이름만 다르고 취급은 모두 같다.
    fn personal_root_entry(&self, home: &Path) -> AdapterRoot {
        AdapterRoot {
            scope: "personal",
            path: self.personal_root(home),
            origin: None,
            project_path: None,
            read_only: false,
            installable: true,
            // Codex는 `.system`을 하위에 두므로 숨김 항목을 스킬로 오인하면 안 된다.
            include_hidden: false,
        }
    }

    /// 등록 프로젝트 루트 항목. 프로젝트 루트는 기본 게시 대상이 아니라, 스킬의
    /// 출처 프로젝트가 정해진 경우에만 위치 지정 게시로 쓴다. 일반 스캔에서는
    /// 공급자 원본처럼 읽기 전용으로 노출한다.
    fn project_root_entries(&self, projects: &[PathBuf]) -> Vec<AdapterRoot> {
        projects
            .iter()
            .map(|project| AdapterRoot {
                scope: "project",
                path: self.project_root(project),
                origin: display_file_name(project),
                project_path: Some(project.clone()),
                read_only: true,
                installable: false,
                include_hidden: false,
            })
            .collect()
    }

    /// 공급자가 읽는 스킬 루트 전부. 개인 루트가 항상 먼저 오고, 뒤이어 공급자
    /// 고유의 읽기 전용 루트와 프로젝트 루트가 공급자별 노출 순서대로 붙는다.
    fn roots(&self, home: &Path, projects: &[PathBuf]) -> Vec<AdapterRoot> {
        let mut roots = vec![self.personal_root_entry(home)];
        match self.provider {
            ProviderId::Claude => {
                roots.extend(self.project_root_entries(projects));
                roots.extend(claude_plugin_skill_roots(home));
            }
            ProviderId::Codex => {
                roots.push(AdapterRoot {
                    scope: "system",
                    path: home.join(".codex/skills/.system"),
                    origin: Some("Codex built-in".to_owned()),
                    project_path: None,
                    read_only: true,
                    installable: false,
                    include_hidden: false,
                });
                roots.extend(self.project_root_entries(projects));
            }
            ProviderId::Antigravity => {
                roots.extend(ACTIVE_AG_ROOTS.iter().map(|root_name| AdapterRoot {
                    scope: "builtin",
                    path: home.join(".gemini").join(root_name).join("builtin/skills"),
                    origin: Some((*root_name).to_owned()),
                    project_path: None,
                    read_only: true,
                    installable: false,
                    include_hidden: false,
                }));
                roots.extend(self.project_root_entries(projects));
            }
        }
        roots
    }

    /// 게시 대상 루트. 설치 가능한 루트는 개인 루트 하나뿐이므로 전체 목록을
    /// 만들지 않는다. 목록을 만들면 Claude는 플러그인 레지스트리까지 읽는다.
    /// `adapter_installable_root_is_the_only_installable_root`가 이 전제를 지킨다.
    fn installable_root(&self, home: &Path) -> Option<PathBuf> {
        let personal = self.personal_root_entry(home);
        personal.installable.then_some(personal.path)
    }

    /// 공통 원본 SKILL.md를 대상 공급자용으로 투영한다. 공통 콘텐츠는 그대로 두고
    /// 다른 공급자 전용 키만 제거한다.
    fn project_skill_md(&self, text: &str) -> String {
        let keys = provider_only_frontmatter_keys(self.provider);
        if keys.is_empty() {
            return text.to_owned();
        }
        strip_frontmatter_keys(text, keys)
    }
}

fn adapter(provider: ProviderId) -> &'static SkillAdapter {
    ADAPTERS
        .iter()
        .find(|item| item.provider == provider)
        .expect("모든 ProviderId는 스킬 어댑터를 가진다")
}

/// 설치된 Claude 플러그인의 스킬 루트. 설치 레지스트리를 읽는 이유는
/// `claude_installed_plugin_skill_dirs` 문서에 있다.
fn claude_plugin_skill_roots(home: &Path) -> Vec<AdapterRoot> {
    claude_installed_plugin_skill_dirs(home)
        .into_iter()
        .map(|(name, path)| AdapterRoot {
            scope: "plugin",
            path,
            origin: Some(name),
            project_path: None,
            read_only: true,
            installable: false,
            include_hidden: false,
        })
        .collect()
}

/// 프런트매터 블록에서 지정한 최상위 키와 그 들여쓰기 하위 줄을 제거한다.
/// 여러 줄 값(`>-`, `|`)과 중첩 매핑을 모두 한 블록으로 본다.
fn strip_frontmatter_keys(text: &str, keys: &[&str]) -> String {
    let Some(rest) = text.strip_prefix("---") else {
        return text.to_owned();
    };
    let Some(body_start) = rest.find('\n') else {
        return text.to_owned();
    };
    let after_open = &rest[body_start + 1..];
    let Some(close) = find_frontmatter_close(after_open) else {
        return text.to_owned();
    };
    let frontmatter = &after_open[..close.start];
    let trailer = &after_open[close.start..];

    let mut output = String::with_capacity(frontmatter.len());
    let mut skipping = false;
    for line in frontmatter.split_inclusive('\n') {
        let trimmed = line.trim_end_matches(['\r', '\n']);
        let indented = trimmed.starts_with(' ') || trimmed.starts_with('\t');
        if skipping && (indented || trimmed.trim().is_empty()) {
            continue;
        }
        skipping = false;
        if !indented {
            if let Some((key, _)) = trimmed.split_once(':') {
                if keys.contains(&key.trim()) {
                    skipping = true;
                    continue;
                }
            }
        }
        output.push_str(line);
    }
    format!("---{}\n{output}{trailer}", &rest[..body_start])
}

struct FrontmatterClose {
    start: usize,
}

fn find_frontmatter_close(text: &str) -> Option<FrontmatterClose> {
    let mut offset = 0;
    for line in text.split_inclusive('\n') {
        let trimmed = line.trim_end_matches(['\r', '\n']);
        if trimmed == "---" || trimmed == "..." {
            return Some(FrontmatterClose { start: offset });
        }
        offset += line.len();
    }
    None
}

// ---------------------------------------------------------------------------
// 경로 검증
// ---------------------------------------------------------------------------

/// 스킬 키(디렉터리 이름) 검증. 디렉터리 탈출과 숨김·예약 이름을 모두 막는다.
/// 통과한 값은 단일 경로 구성요소임이 보장된다.
pub(crate) fn validate_skill_key(key: &str) -> Result<String, CoreError> {
    let trimmed = key.trim();
    if trimmed.is_empty() {
        return Err(CoreError::InvalidInput(
            "스킬 이름이 비어 있습니다".to_owned(),
        ));
    }
    if trimmed.chars().count() > MAX_SKILL_KEY_CHARS {
        return Err(CoreError::InvalidInput(format!(
            "스킬 이름은 {MAX_SKILL_KEY_CHARS}자까지 허용됩니다"
        )));
    }
    if !trimmed
        .chars()
        .all(|value| value.is_ascii_lowercase() || value.is_ascii_digit() || matches!(value, '-'))
    {
        return Err(CoreError::InvalidInput(
            "스킬 이름은 영소문자·숫자·하이픈만 쓸 수 있습니다".to_owned(),
        ));
    }
    if !trimmed.starts_with(|value: char| value.is_ascii_lowercase() || value.is_ascii_digit()) {
        return Err(CoreError::InvalidInput(
            "스킬 이름은 영소문자나 숫자로 시작해야 합니다".to_owned(),
        ));
    }
    if trimmed.ends_with('-') {
        return Err(CoreError::InvalidInput(
            "스킬 이름은 하이픈으로 끝날 수 없습니다".to_owned(),
        ));
    }
    if is_windows_reserved_stem(trimmed) {
        return Err(CoreError::InvalidInput(format!(
            "'{trimmed}'은 Windows 예약 이름이라 스킬 이름으로 쓸 수 없습니다"
        )));
    }
    Ok(trimmed.to_owned())
}

fn is_windows_reserved_stem(value: &str) -> bool {
    let stem = value
        .split('.')
        .next()
        .unwrap_or(value)
        .to_ascii_uppercase();
    const RESERVED: &[&str] = &[
        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
        "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    ];
    RESERVED.contains(&stem.as_str())
}

/// 스킬 디렉터리 안의 상대 경로가 루트를 벗어나지 않는지 확인한다. `..`, 절대
/// 경로, 루트·접두사 구성요소를 모두 거부한다.
fn validate_relative_path(relative: &Path) -> Result<(), CoreError> {
    let Some(issue) = path_guard::classify_relative_path(relative, CurDirPolicy::Reject) else {
        return Ok(());
    };
    Err(CoreError::InvalidInput(match issue {
        RelativePathIssue::Empty => "스킬 구성 파일 경로가 비어 있습니다".to_owned(),
        RelativePathIssue::CurDir | RelativePathIssue::EmptyComponent => format!(
            "스킬 구성 파일 경로는 정규 상대 경로여야 합니다: {}",
            relative.display()
        ),
        RelativePathIssue::ParentDir => format!(
            "스킬 구성 파일 경로가 디렉터리를 벗어납니다: {}",
            relative.display()
        ),
        RelativePathIssue::Absolute => format!(
            "스킬 구성 파일 경로는 상대 경로여야 합니다: {}",
            relative.display()
        ),
    }))
}

fn validate_variant_delete_path(relative: &Path) -> Result<(), CoreError> {
    validate_relative_path(relative)?;
    if relative == Path::new("SKILL.md") || relative.starts_with(".agent-manager") {
        return Err(CoreError::InvalidInput(
            "OS 변형에서 SKILL.md 또는 .agent-manager 경로를 제외할 수 없습니다".to_owned(),
        ));
    }
    Ok(())
}

const SKILL_PATH_LABELS: RootLabels = RootLabels {
    subject: "스킬 경로",
    escaped: "스킬 경로가 허용된 루트를 벗어납니다",
};

fn assert_within_root(root: &Path, candidate: &Path) -> Result<(), CoreError> {
    path_guard::assert_within_root(root, candidate, SKILL_PATH_LABELS)
}

// ---------------------------------------------------------------------------
// 내용 지문
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
struct SkillContent {
    digest: String,
    file_count: usize,
    total_bytes: u64,
    /// 상대 경로 목록. 호환성 검사와 복사가 같은 목록을 쓴다.
    files: Vec<SkillFileEntry>,
    /// 디렉터리 안에서 발견한 심볼릭 링크. 안전하게 복사할 수 없어 그대로 보고한다.
    symlinks: Vec<String>,
    truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct SkillFileEntry {
    relative: PathBuf,
    size_bytes: u64,
    executable: bool,
}

/// 스킬 디렉터리 내용을 순회해 지문을 계산한다. 링크는 따라가지 않고 목록에만
/// 남긴다. 정렬된 상대 경로·실행 권한·내용을 모두 지문에 넣어 권한만 바뀐 경우도
/// 갈라짐으로 잡는다.
fn read_skill_content(directory: &Path) -> Result<SkillContent, CoreError> {
    let mut files: Vec<SkillFileEntry> = Vec::new();
    let mut symlinks = Vec::new();
    let mut total_bytes = 0_u64;
    let mut truncated = false;
    let mut pending = vec![PathBuf::new()];

    while let Some(relative_dir) = pending.pop() {
        let absolute_dir = directory.join(&relative_dir);
        let entries = match fs::read_dir(&absolute_dir) {
            Ok(entries) => entries,
            Err(error) => return Err(CoreError::Io(error)),
        };
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name_text = name.to_string_lossy().into_owned();
            if IGNORED_FILE_NAMES.contains(&name_text.as_str()) {
                continue;
            }
            let relative = relative_dir.join(&name);
            let metadata = match fs::symlink_metadata(entry.path()) {
                Ok(value) => value,
                Err(_) => continue,
            };
            if metadata.file_type().is_symlink() {
                symlinks.push(relative.to_string_lossy().into_owned());
                continue;
            }
            if metadata.is_dir() {
                pending.push(relative);
                continue;
            }
            if !metadata.is_file() {
                continue;
            }
            if files.len() >= MAX_SKILL_FILES {
                truncated = true;
                continue;
            }
            total_bytes = total_bytes.saturating_add(metadata.len());
            files.push(SkillFileEntry {
                relative,
                size_bytes: metadata.len(),
                executable: is_executable(&metadata),
            });
        }
    }

    files.sort_by(|left, right| left.relative.cmp(&right.relative));
    symlinks.sort();

    let mut hasher = Sha256::new();
    for file in &files {
        hasher.update(file.relative.to_string_lossy().as_bytes());
        hasher.update([0]);
        hasher.update([u8::from(file.executable)]);
        let bytes = fs::read(directory.join(&file.relative))?;
        hasher.update(bytes.len().to_le_bytes());
        hasher.update(&bytes);
    }
    let digest = format!("{:x}", hasher.finalize());

    Ok(SkillContent {
        digest,
        file_count: files.len(),
        total_bytes,
        files,
        symlinks,
        truncated,
    })
}

#[cfg(unix)]
fn is_executable(metadata: &fs::Metadata) -> bool {
    use std::os::unix::fs::PermissionsExt;
    metadata.permissions().mode() & 0o111 != 0
}

#[cfg(not(unix))]
fn is_executable(_metadata: &fs::Metadata) -> bool {
    false
}

// ---------------------------------------------------------------------------
// 라이브러리 조회
// ---------------------------------------------------------------------------

#[cfg(test)]
fn common_root(home: &Path) -> PathBuf {
    home.join(LEGACY_COMMON_ROOT_RELATIVE)
}

/// 스킬을 훑을 때마다 함께 다니는 세 경로(사용자 홈, 공통 원본 루트, 설치본을 찾을
/// 프로젝트 목록)를 한 묶음으로 옮긴다. 운영(앱 데이터 기준)과 시험(가짜 홈 기준)에서
/// 이 세 값을 어떻게 얻는지는 생성자 두 개에만 남는다.
struct SkillRoots {
    home: PathBuf,
    root: PathBuf,
    projects: Vec<PathBuf>,
}

impl SkillRoots {
    fn from_app_data(app_data_dir: &Path, sessions: &[SessionSummary]) -> Result<Self, CoreError> {
        Ok(Self {
            home: home_dir()?,
            root: repository_skills_root(app_data_dir),
            projects: project_paths_from_sessions(sessions),
        })
    }

    #[cfg(test)]
    fn from_home(home: &Path) -> Self {
        Self {
            home: home.to_path_buf(),
            root: common_root(home),
            projects: claude_project_paths(home),
        }
    }

    fn home(&self) -> &Path {
        &self.home
    }

    fn root(&self) -> &Path {
        &self.root
    }

    fn projects(&self) -> &[PathBuf] {
        &self.projects
    }
}

/// 공용 보관 루트에 원본이 있는 스킬 키. 설치본이 보관 관리 대상인지 가르는 데 쓴다.
pub(crate) fn archived_repository_skill_keys(app_data_dir: &Path) -> BTreeSet<String> {
    archived_skill_keys_in(&repository_skills_root(app_data_dir))
}

fn archived_skill_keys_in(root: &Path) -> BTreeSet<String> {
    skill_directories(root)
        .into_iter()
        .filter(|directory| directory.join("SKILL.md").is_file())
        .filter_map(|directory| {
            directory
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
        })
        .collect()
}

/// 스킬 루트의 하위 스킬 디렉터리를 나열한다. `DirEntry::file_type`은 링크를
/// 따라가지 않아 링크로 노출된 스킬을 놓치므로, 링크를 해석하는 `fs::metadata`로
/// 판정한다. 여러 도구가 공통 원본을 링크로 노출하기 때문에 이 구분이 필요하다.
pub(crate) fn skill_directories(parent: &Path) -> Vec<PathBuf> {
    let Ok(entries) = fs::read_dir(parent) else {
        return Vec::new();
    };
    let mut directories: Vec<PathBuf> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| fs::metadata(path).is_ok_and(|metadata| metadata.is_dir()))
        .collect();
    directories.sort();
    directories
}

fn read_common_source(
    directory: &Path,
    key: &str,
) -> Result<(CommonSkillSource, SkillContent), CoreError> {
    let path = directory.join("SKILL.md");
    let text = read_text_limited(&path, MAX_SKILL_MD_BYTES)?;
    let (frontmatter, _) = split_frontmatter(&text);
    let name = frontmatter_value(frontmatter, "name").unwrap_or_else(|| key.to_owned());
    let description = frontmatter_value(frontmatter, "description").unwrap_or_default();
    let content = read_skill_content(directory)?;
    Ok((
        CommonSkillSource {
            id: stable_id(&path.to_string_lossy()),
            key: key.to_owned(),
            name,
            description,
            path: path.to_string_lossy().into_owned(),
            directory: directory.to_string_lossy().into_owned(),
            content_digest: content.digest.clone(),
            file_count: content.file_count,
            total_bytes: content.total_bytes,
        },
        content,
    ))
}

/// 한 공급자 루트에서 발견한 설치본.
#[derive(Debug, Clone)]
struct ProviderInstall {
    provider: ProviderId,
    scope: &'static str,
    origin: Option<String>,
    /// 프로젝트 설치본이면 그 프로젝트 루트 경로.
    project_path: Option<PathBuf>,
    read_only: bool,
    skill_id: String,
    path: PathBuf,
    directory: PathBuf,
    digest: Option<String>,
    /// 정규화한 디렉터리. 공통 원본과 같은 실체를 보는지 판정할 때 쓴다.
    canonical: Option<PathBuf>,
}

/// 스코프 우선순위. 한 공급자에 같은 키가 여러 루트에 있으면 사용자가 관리할 수
/// 있는 쪽을 대표로 보여준다.
fn scope_rank(scope: &str) -> u8 {
    match scope {
        "personal" => 0,
        "project" => 1,
        "plugin" => 2,
        "system" => 3,
        "builtin" => 4,
        _ => 5,
    }
}

fn scan_provider_installs(
    home: &Path,
    projects: &[PathBuf],
    issues: &mut Vec<SkillLibraryIssue>,
) -> Vec<ProviderInstall> {
    let mut installs = Vec::new();
    for adapter in ADAPTERS {
        for root in adapter.roots(home, projects) {
            if !root.path.is_dir() {
                continue;
            }
            for directory in skill_directories(&root.path) {
                let Some(name) = directory
                    .file_name()
                    .map(|value| value.to_string_lossy().into_owned())
                else {
                    continue;
                };
                if !root.include_hidden && name.starts_with('.') {
                    continue;
                }
                let path = directory.join("SKILL.md");
                if !path.is_file() {
                    continue;
                }
                let (digest, canonical) = match read_skill_content(&directory) {
                    Ok(content) => (Some(content.digest), fs::canonicalize(&directory).ok()),
                    Err(error) => {
                        issues.push(SkillLibraryIssue {
                            provider: Some(adapter.provider),
                            path: directory.to_string_lossy().into_owned(),
                            message: format!("스킬 내용을 읽지 못했습니다: {error}"),
                        });
                        (None, fs::canonicalize(&directory).ok())
                    }
                };
                installs.push(ProviderInstall {
                    provider: adapter.provider,
                    scope: root.scope,
                    origin: root.origin.clone(),
                    project_path: root.project_path.clone(),
                    read_only: root.read_only,
                    skill_id: stable_id(&path.to_string_lossy()),
                    path,
                    directory,
                    digest,
                    canonical,
                });
            }
        }
    }
    installs
}

/// 통합 스킬 라이브러리를 읽는다. 파일시스템에서 매번 새로 계산하고 어디에도
/// 캐시하지 않아, 다른 도구가 바꾼 상태와 어긋나지 않는다.
pub fn load_skill_library(app_data_dir: &Path) -> Result<SkillLibrary, CoreError> {
    let roots = SkillRoots::from_app_data(app_data_dir, &[])?;
    let meta = load_skill_meta(app_data_dir);
    load_skill_library_from_paths(&roots, &meta)
}

pub fn load_skill_library_for_projects(
    app_data_dir: &Path,
    sessions: &[SessionSummary],
) -> Result<SkillLibrary, CoreError> {
    let roots = SkillRoots::from_app_data(app_data_dir, sessions)?;
    let meta = load_skill_meta(app_data_dir);
    load_skill_library_from_paths(&roots, &meta)
}

#[cfg(test)]
pub(crate) fn load_skill_library_from_home(
    home: &Path,
    meta: &SkillMetaStore,
) -> Result<SkillLibrary, CoreError> {
    let roots = SkillRoots::from_home(home);
    load_skill_library_from_paths(&roots, meta)
}

fn load_skill_library_from_paths(
    roots: &SkillRoots,
    meta: &SkillMetaStore,
) -> Result<SkillLibrary, CoreError> {
    let (home, root, registered_projects) = (roots.home(), roots.root(), roots.projects());
    let mut issues = Vec::new();

    let mut sources: BTreeMap<String, (CommonSkillSource, SkillContent)> = BTreeMap::new();
    if root.is_dir() {
        for directory in skill_directories(root) {
            let Some(key) = directory
                .file_name()
                .map(|value| value.to_string_lossy().into_owned())
            else {
                continue;
            };
            if key.starts_with('.') {
                continue;
            }
            if !directory.join("SKILL.md").is_file() {
                continue;
            }
            match read_common_source(&directory, &key) {
                Ok(value) => {
                    sources.insert(key, value);
                }
                Err(error) => issues.push(SkillLibraryIssue {
                    provider: None,
                    path: directory.to_string_lossy().into_owned(),
                    message: format!("공통 스킬 원본을 읽지 못했습니다: {error}"),
                }),
            }
        }
    }

    let installs = scan_provider_installs(home, registered_projects, &mut issues);
    let mut by_key: HashMap<String, Vec<ProviderInstall>> = HashMap::new();
    for install in installs {
        let key = install
            .directory
            .file_name()
            .map(|value| value.to_string_lossy().into_owned())
            .unwrap_or_default();
        by_key.entry(key).or_default().push(install);
    }

    let mut keys: BTreeSet<String> = sources.keys().cloned().collect();
    keys.extend(by_key.keys().cloned());

    let mut entries = Vec::new();
    for key in keys {
        let source = sources.get(&key);
        let installs = by_key.get(&key).map(Vec::as_slice).unwrap_or_default();
        entries.push(build_entry(
            home,
            &key,
            source,
            installs,
            meta.skills.get(&key),
        ));
    }

    let adapters = ADAPTERS
        .iter()
        .map(|adapter| SkillAdapterView {
            provider: adapter.provider,
            display_name: adapter.display_name.to_owned(),
            installable_root: adapter
                .installable_root(home)
                .map(|path| path.to_string_lossy().into_owned()),
            roots: adapter
                .roots(home, registered_projects)
                .into_iter()
                .map(|root| SkillAdapterRootView {
                    scope: root.scope.to_owned(),
                    present: root.path.is_dir(),
                    path: root.path.to_string_lossy().into_owned(),
                    read_only: root.read_only,
                    installable: root.installable,
                })
                .collect(),
            supports_common_source: adapter.unsupported_note.is_none(),
            note: adapter.unsupported_note.map(str::to_owned).or_else(|| {
                (adapter.provider == ProviderId::Antigravity).then(|| {
                    "Antigravity는 개인 .gemini/config/skills와 등록 프로젝트의 .agents/skills를 지원합니다"
                        .to_owned()
                })
            }),
        })
        .collect();

    let projects = registered_projects
        .iter()
        .map(|path| SkillProjectView {
            name: display_file_name(path).unwrap_or_else(|| path.to_string_lossy().into_owned()),
            path: path.to_string_lossy().into_owned(),
        })
        .collect();

    Ok(SkillLibrary {
        schema_version: LIBRARY_SCHEMA_VERSION,
        common_root: root.to_string_lossy().into_owned(),
        common_root_present: root.is_dir(),
        current_platform: HostPlatform::current(),
        entries,
        adapters,
        projects,
        issues,
    })
}

pub(crate) fn project_paths_from_sessions(sessions: &[SessionSummary]) -> Vec<PathBuf> {
    let mut paths = BTreeSet::new();
    for session in sessions {
        let Some(path) = session.cwd.as_deref() else {
            continue;
        };
        if session.meta.hidden || session.aia_workspace {
            continue;
        }
        let Ok(path) = fs::canonicalize(path) else {
            continue;
        };
        if path.is_dir() {
            paths.insert(path);
        }
    }
    paths.into_iter().collect()
}

/// 디렉터리 생성 시각(밀리초). 생성순 정렬에 쓴다.
fn directory_created_ms(path: &Path) -> Option<i64> {
    fs::metadata(path)
        .ok()?
        .created()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .map(|duration| duration.as_millis() as i64)
}

/// 설치본이 공통 원본을 그대로 보는지(`linked`)와 내용이 갈라졌는지(`divergent`)를 함께
/// 판정한다. 링크·동일 경로로 같은 실체를 보고 있으면 갈라짐은 성립하지 않으므로 두 값을
/// 따로 계산하면 안 된다.
fn install_link_state(
    common_canonical: Option<&Path>,
    install: &ProviderInstall,
    projected_digest: &dyn Fn(ProviderId) -> Option<String>,
) -> (bool, bool) {
    let linked = match (common_canonical, install.canonical.as_deref()) {
        (Some(left), Some(right)) => left == right,
        _ => false,
    };
    let divergent = !linked
        && match (
            projected_digest(install.provider),
            install.digest.as_deref(),
        ) {
            (Some(left), Some(right)) => left != right,
            _ => false,
        };
    (linked, divergent)
}

/// 한 공급자의 설치 현황을 화면용 상태 하나로 접는다. 같은 키가 여러 루트에 있으면
/// 스코프 우선순위가 높은 쪽을 대표로 삼고 나머지는 목록으로만 남긴다.
fn build_provider_state(
    adapter: &'static SkillAdapter,
    home: &Path,
    key: &str,
    installs: &[ProviderInstall],
    common_canonical: Option<&Path>,
    projected_digest: &dyn Fn(ProviderId) -> Option<String>,
) -> SkillProviderState {
    let mut candidates: Vec<&ProviderInstall> = installs
        .iter()
        .filter(|install| install.provider == adapter.provider)
        .collect();
    candidates.sort_by_key(|install| scope_rank(install.scope));

    let extra_note = (candidates.len() > 1).then(|| {
        format!(
            "같은 이름의 스킬이 이 공급자에 {}곳 있습니다",
            candidates.len()
        )
    });

    let install_views: Vec<SkillInstallView> = candidates
        .iter()
        .map(|install| {
            let (_, divergent) = install_link_state(common_canonical, install, projected_digest);
            SkillInstallView {
                scope: install.scope.to_owned(),
                project_path: install
                    .project_path
                    .as_ref()
                    .map(|path| path.to_string_lossy().into_owned()),
                project_name: install.project_path.as_deref().and_then(display_file_name),
                skill_id: install.skill_id.clone(),
                directory: install.directory.to_string_lossy().into_owned(),
                content_digest: install.digest.clone(),
                divergent,
                read_only: install.read_only,
            }
        })
        .collect();

    let Some(install) = candidates.first().copied() else {
        let installable = adapter.installable_root(home);
        let supported = installable.is_some();
        return SkillProviderState {
            provider: adapter.provider,
            status: if supported {
                SkillProviderStatus::Missing
            } else {
                SkillProviderStatus::Unsupported
            },
            scope: None,
            origin: None,
            skill_id: None,
            path: None,
            directory: None,
            target_directory: installable.map(|root| root.join(key).to_string_lossy().into_owned()),
            read_only: !supported,
            content_digest: None,
            divergent: false,
            note: adapter.unsupported_note.map(str::to_owned).or_else(|| {
                (adapter.provider == ProviderId::Antigravity).then(|| {
                    "등록 프로젝트의 .agents/skills에 위치 지정 게시할 수 있습니다".to_owned()
                })
            }),
            installs: install_views,
        };
    };

    let (linked, divergent) = install_link_state(common_canonical, install, projected_digest);
    SkillProviderState {
        provider: adapter.provider,
        status: if linked {
            SkillProviderStatus::Linked
        } else {
            SkillProviderStatus::Copy
        },
        scope: Some(install.scope.to_owned()),
        origin: install.origin.clone(),
        skill_id: Some(install.skill_id.clone()),
        path: Some(install.path.to_string_lossy().into_owned()),
        directory: Some(install.directory.to_string_lossy().into_owned()),
        target_directory: adapter
            .installable_root(home)
            .map(|root| root.join(key).to_string_lossy().into_owned()),
        read_only: install.read_only,
        content_digest: install.digest.clone(),
        divergent,
        note: extra_note,
        installs: install_views,
    }
}

/// 목록에 보일 이름·설명. 공통 원본이 없으면 사용자가 관리할 수 있는 설치본의
/// 프런트매터에서 가져오고, 그마저 없으면 키를 이름으로 쓴다.
fn entry_name_and_description(
    key: &str,
    source: Option<&(CommonSkillSource, SkillContent)>,
    installs: &[ProviderInstall],
) -> (String, String) {
    if let Some((value, _)) = source {
        return (value.name.clone(), value.description.clone());
    }
    installs
        .iter()
        .min_by_key(|install| scope_rank(install.scope))
        .and_then(|install| {
            let text = read_text_limited(&install.path, MAX_SKILL_MD_BYTES).ok()?;
            let (frontmatter, _) = split_frontmatter(&text);
            Some((
                frontmatter_value(frontmatter, "name").unwrap_or_else(|| key.to_owned()),
                frontmatter_value(frontmatter, "description").unwrap_or_default(),
            ))
        })
        .unwrap_or_else(|| (key.to_owned(), String::new()))
}

/// 메타에 기록된 가져오기 출처를 화면용으로 옮긴다.
fn entry_origin_view(meta: Option<&SkillMetaEntry>) -> Option<SkillOriginView> {
    let origin = meta?.origin.as_ref()?;
    Some(SkillOriginView {
        provider: origin.provider,
        scope: origin.scope.clone(),
        project_path: origin.project_path.clone(),
        project_name: origin
            .project_path
            .as_deref()
            .and_then(|path| display_file_name(Path::new(path))),
        archived_at_ms: origin.archived_at_ms,
    })
}

fn build_entry(
    home: &Path,
    key: &str,
    source: Option<&(CommonSkillSource, SkillContent)>,
    installs: &[ProviderInstall],
    meta: Option<&SkillMetaEntry>,
) -> SkillLibraryEntry {
    let platform = HostPlatform::current();
    let manifest = source
        .map(|(value, _)| load_resource_manifest(Path::new(&value.directory)))
        .unwrap_or_default();
    let common_canonical = source.and_then(|(value, _)| fs::canonicalize(&value.directory).ok());
    let projected_digest = |provider: ProviderId| {
        source.and_then(|(value, content)| {
            projected_skill_digest(
                adapter(provider),
                Path::new(&value.directory),
                content,
                platform,
            )
            .ok()
        })
    };

    let mut providers = Vec::new();
    for adapter in ADAPTERS {
        providers.push(build_provider_state(
            adapter,
            home,
            key,
            installs,
            common_canonical.as_deref(),
            &projected_digest,
        ));
    }

    let (name, description) = entry_name_and_description(key, source, installs);

    // 공통 원본이 있거나, 공통 원본으로 가져올 수 있는 쓰기 가능한 설치본이 있으면
    // Agent Manager가 관리할 수 있다. 읽기 전용 루트에만 있는 스킬은 정보용이다.
    let managed = source.is_some()
        || installs
            .iter()
            .any(|install| matches!(install.scope, "personal" | "project"));

    let linked_count = providers
        .iter()
        .filter(|state| state.status == SkillProviderStatus::Linked)
        .count();
    let installed_count = providers
        .iter()
        .filter(|state| {
            matches!(
                state.status,
                SkillProviderStatus::Linked | SkillProviderStatus::Copy
            )
        })
        .count();
    let missing_count = providers
        .iter()
        .filter(|state| state.status == SkillProviderStatus::Missing)
        .count();

    let created_at_ms = source
        .and_then(|(value, _)| directory_created_ms(Path::new(&value.directory)))
        .or_else(|| {
            installs
                .iter()
                .filter_map(|install| directory_created_ms(&install.directory))
                .min()
        });

    let origin = entry_origin_view(meta);

    SkillLibraryEntry {
        key: key.to_owned(),
        created_at_ms,
        origin,
        auto_sync: meta.map(|entry| entry.auto_sync).unwrap_or(false),
        platforms: manifest.platforms.clone(),
        active: manifest.supports(platform),
        migration_required: manifest.migration_required(platform),
        active_variant: manifest.active_variant(platform).map(str::to_owned),
        name,
        description,
        origin_kind: if source.is_some() {
            SkillOriginKind::Common
        } else {
            SkillOriginKind::Provider
        },
        common: source.map(|(value, _)| value.clone()),
        managed,
        directory_name: key.to_owned(),
        providers,
        linked_count,
        installed_count,
        missing_count,
    }
}

/// 공통 원본 상세. SKILL.md 본문과 구성 파일 트리를 함께 돌려준다.
pub fn load_common_skill_detail(
    app_data_dir: &Path,
    key: &str,
) -> Result<CommonSkillDetail, CoreError> {
    let key = validate_skill_key(key)?;
    let root = repository_skills_root(app_data_dir);
    load_common_skill_detail_from_root(&root, &key)
}

fn load_common_skill_detail_from_root(
    root: &Path,
    key: &str,
) -> Result<CommonSkillDetail, CoreError> {
    let directory = root.join(key);
    assert_within_root(root, &directory)?;
    if !directory.join("SKILL.md").is_file() {
        return Err(CoreError::NotFound(format!(
            "공통 스킬 원본을 찾지 못했습니다: {key}"
        )));
    }
    let (source, _) = read_common_source(&directory, key)?;
    let body = read_text_limited(Path::new(&source.path), MAX_SKILL_MD_BYTES)?;
    let mut files = build_file_tree(&directory, MAX_SKILL_FILES)?;
    files.retain(|node| node.name != ".agent-manager");
    Ok(CommonSkillDetail {
        source,
        body,
        files,
    })
}

/// AIA 즉시 트리거용 공통 원본 지문 목록. 공급자 설치본 스캔 없이 공통 루트만
/// 읽어 짧은 주기 폴링 비용을 낮춘다. 읽지 못한 디렉터리는 조용히 건너뛴다 —
/// 변경 감지는 읽을 수 있는 원본만 기준으로 판단한다.
pub fn load_common_skill_digests(app_data_dir: &Path) -> Result<Vec<CommonSkillDigest>, CoreError> {
    Ok(common_skill_digests_from_root(&repository_skills_root(
        app_data_dir,
    )))
}

#[cfg(test)]
pub(crate) fn common_skill_digests_from_home(home: &Path) -> Vec<CommonSkillDigest> {
    common_skill_digests_from_root(&common_root(home))
}

fn common_skill_digests_from_root(root: &Path) -> Vec<CommonSkillDigest> {
    if !root.is_dir() {
        return Vec::new();
    }
    skill_directories(root)
        .into_iter()
        .filter_map(|directory| {
            let key = directory.file_name()?.to_string_lossy().into_owned();
            if key.starts_with('.') || !directory.join("SKILL.md").is_file() {
                return None;
            }
            let (source, _) = read_common_source(&directory, &key).ok()?;
            Some(CommonSkillDigest {
                key,
                name: source.name,
                content_digest: source.content_digest,
            })
        })
        .collect()
}

/// 번역 수집용 공유 원본 요약. 배포본이 없는 공유 스킬도 번역 대상에 포함하기
/// 위해 쓴다. 파일 지문 계산 없이 SKILL.md frontmatter와 본문만 읽는다.
#[derive(Debug, Clone)]
pub(crate) struct CommonSkillTranslationSource {
    /// 공유 원본 SKILL.md 경로의 안정 ID. `CommonSkillSource.id`와 같은 규칙이라
    /// 화면이 이 ID로 번역 레코드를 찾을 수 있다.
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) description: String,
    pub(crate) body: String,
}

#[cfg(test)]
pub(crate) fn list_common_translation_sources(home: &Path) -> Vec<CommonSkillTranslationSource> {
    list_common_translation_sources_from_root(&common_root(home))
}

pub(crate) fn list_repository_translation_sources(
    app_data_dir: &Path,
) -> Vec<CommonSkillTranslationSource> {
    list_common_translation_sources_from_root(&repository_skills_root(app_data_dir))
}

fn list_common_translation_sources_from_root(root: &Path) -> Vec<CommonSkillTranslationSource> {
    let mut sources = Vec::new();
    if !root.is_dir() {
        return sources;
    }
    for directory in skill_directories(root) {
        let Some(key) = directory
            .file_name()
            .map(|value| value.to_string_lossy().into_owned())
        else {
            continue;
        };
        if key.starts_with('.') {
            continue;
        }
        let path = directory.join("SKILL.md");
        if !path.is_file() {
            continue;
        }
        let Ok(text) = read_text_limited(&path, MAX_SKILL_MD_BYTES) else {
            continue;
        };
        let (frontmatter, _) = split_frontmatter(&text);
        sources.push(CommonSkillTranslationSource {
            id: stable_id(&path.to_string_lossy()),
            name: frontmatter_value(frontmatter, "name").unwrap_or_else(|| key.clone()),
            description: frontmatter_value(frontmatter, "description").unwrap_or_default(),
            body: text,
        });
    }
    sources
}

// ---------------------------------------------------------------------------
// 호환성 검사
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SkillIssueSeverity {
    /// 게시를 막는 문제.
    Blocking,
    /// 게시는 되지만 대상 환경에서 문제가 될 수 있는 사항.
    Warning,
}

impl SkillIssueSeverity {
    pub const ALL: [Self; 2] = [Self::Blocking, Self::Warning];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Blocking => "blocking",
            Self::Warning => "warning",
        }
    }

    /// 차단 수준인지 여부.
    pub fn is_blocking(self) -> bool {
        matches!(self, Self::Blocking)
    }

    /// 경고 수준인지 여부.
    pub fn is_warning(self) -> bool {
        matches!(self, Self::Warning)
    }
}

impl std::fmt::Display for SkillIssueSeverity {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

impl std::str::FromStr for SkillIssueSeverity {
    type Err = CoreError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.trim() {
            "blocking" => Ok(Self::Blocking),
            "warning" => Ok(Self::Warning),
            _ => Err(CoreError::InvalidInput(format!(
                "알 수 없는 스킬 호환성 문제 심각도입니다: {s}. blocking|warning 중 하나를 쓰세요"
            ))),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillCompatibilityIssue {
    pub severity: SkillIssueSeverity,
    /// 문제가 걸린 공급자. 공통 원본 자체 문제면 비어 있다.
    pub provider: Option<ProviderId>,
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillProviderCompatibility {
    pub provider: ProviderId,
    pub publishable: bool,
    /// 게시하면 기존 디렉터리를 덮어써야 하는 상태.
    pub requires_overwrite: bool,
    /// 덮어쓸 내용이 공통 원본과 이미 같아 실제 변경이 없는 상태.
    pub already_current: bool,
    pub target_directory: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillCompatibilityReport {
    pub key: String,
    pub source_digest: String,
    pub file_count: usize,
    pub total_bytes: u64,
    pub providers: Vec<SkillProviderCompatibility>,
    pub issues: Vec<SkillCompatibilityIssue>,
}

impl SkillCompatibilityReport {
    pub fn blocked(&self) -> bool {
        self.issues
            .iter()
            .any(|issue| issue.severity == SkillIssueSeverity::Blocking)
    }
}

fn check_source_content(
    key: &str,
    source: &CommonSkillSource,
    content: &SkillContent,
    issues: &mut Vec<SkillCompatibilityIssue>,
) {
    let manifest = match checked_resource_manifest(Path::new(&source.directory)) {
        Ok(manifest) => manifest,
        Err(error) => {
            issues.push(SkillCompatibilityIssue {
                severity: SkillIssueSeverity::Blocking,
                provider: None,
                code: "platform-metadata".to_owned(),
                message: error.to_string(),
            });
            ResourcePlatformManifest::default()
        }
    };
    let platform = HostPlatform::current();
    if manifest.migration_required(platform) {
        issues.push(SkillCompatibilityIssue {
            severity: SkillIssueSeverity::Blocking,
            provider: None,
            code: "platform-unsupported".to_owned(),
            message: format!(
                "현재 OS({platform})용 스킬이 없습니다. AIA 마이그레이션으로 OS 변형을 먼저 만드세요"
            ),
        });
    }
    if content.truncated {
        issues.push(SkillCompatibilityIssue {
            severity: SkillIssueSeverity::Blocking,
            provider: None,
            code: "file-count".to_owned(),
            message: format!("스킬 구성 파일이 {MAX_SKILL_FILES}개를 넘습니다"),
        });
    }
    if content.total_bytes > MAX_SKILL_TOTAL_BYTES {
        issues.push(SkillCompatibilityIssue {
            severity: SkillIssueSeverity::Blocking,
            provider: None,
            code: "total-bytes".to_owned(),
            message: format!(
                "스킬 전체 크기가 허용 한도({}MB)를 넘습니다",
                MAX_SKILL_TOTAL_BYTES / (1024 * 1024)
            ),
        });
    }
    for link in &content.symlinks {
        issues.push(SkillCompatibilityIssue {
            severity: SkillIssueSeverity::Blocking,
            provider: None,
            code: "symlink".to_owned(),
            message: format!(
                "심볼릭 링크는 안전하게 게시할 수 없습니다. 실제 파일로 바꾸세요: {link}"
            ),
        });
    }
    if source.description.trim().is_empty() {
        issues.push(SkillCompatibilityIssue {
            severity: SkillIssueSeverity::Blocking,
            provider: None,
            code: "description-empty".to_owned(),
            message: "description이 비어 있어 공급자가 스킬을 발견하지 못합니다".to_owned(),
        });
    } else if source.description.chars().count() > MAX_DESCRIPTION_CHARS {
        issues.push(SkillCompatibilityIssue {
            severity: SkillIssueSeverity::Warning,
            provider: None,
            code: "description-long".to_owned(),
            message: format!(
                "description이 {MAX_DESCRIPTION_CHARS}자를 넘어 일부 공급자에서 잘릴 수 있습니다"
            ),
        });
    }
    if source.name != key {
        issues.push(SkillCompatibilityIssue {
            severity: SkillIssueSeverity::Warning,
            provider: None,
            code: "name-mismatch".to_owned(),
            message: format!(
                "프런트매터 name('{}')과 디렉터리 이름('{key}')이 달라 공급자에 따라 다르게 노출될 수 있습니다",
                source.name
            ),
        });
    }

    // 대소문자만 다른 파일 이름은 대소문자를 구분하지 않는 파일시스템에서 충돌한다.
    let mut lowered: BTreeMap<String, String> = BTreeMap::new();
    for file in &content.files {
        let text = file.relative.to_string_lossy().into_owned();
        if let Some(previous) = lowered.insert(text.to_lowercase(), text.clone()) {
            if previous != text {
                issues.push(SkillCompatibilityIssue {
                    severity: SkillIssueSeverity::Warning,
                    provider: None,
                    code: "case-collision".to_owned(),
                    message: format!(
                        "대소문자만 다른 파일이 있어 Windows·macOS에서 충돌합니다: {previous}, {text}"
                    ),
                });
            }
        }
        for component in file.relative.components() {
            let name = component.as_os_str().to_string_lossy();
            if is_windows_reserved_stem(&name)
                || name.ends_with('.')
                || name.ends_with(' ')
                || name.contains(['<', '>', ':', '"', '|', '?', '*'])
            {
                issues.push(SkillCompatibilityIssue {
                    severity: SkillIssueSeverity::Warning,
                    provider: None,
                    code: "windows-name".to_owned(),
                    message: format!("Windows에서 쓸 수 없는 파일 이름입니다: {name}"),
                });
            }
        }
    }
}

/// 게시 전 호환성을 검사한다. 파일을 쓰지 않는 읽기 작업이다.
pub fn check_skill_publish(
    app_data_dir: &Path,
    sessions: &[SessionSummary],
    key: &str,
    providers: &[ProviderId],
) -> Result<SkillCompatibilityReport, CoreError> {
    let roots = SkillRoots::from_app_data(app_data_dir, sessions)?;
    check_skill_publish_from_paths(&roots, key, providers, &SkillLocation::default())
}

#[cfg(test)]
pub(crate) fn check_skill_publish_from_home(
    home: &Path,
    key: &str,
    providers: &[ProviderId],
    location: &SkillLocation,
) -> Result<SkillCompatibilityReport, CoreError> {
    let roots = SkillRoots::from_home(home);
    check_skill_publish_from_paths(&roots, key, providers, location)
}

fn check_skill_publish_from_paths(
    roots: &SkillRoots,
    key: &str,
    providers: &[ProviderId],
    location: &SkillLocation,
) -> Result<SkillCompatibilityReport, CoreError> {
    let (home, root, projects) = (roots.home(), roots.root(), roots.projects());
    let key = validate_skill_key(key)?;
    let directory = root.join(&key);
    assert_within_root(root, &directory)?;
    if !directory.join("SKILL.md").is_file() {
        return Err(CoreError::NotFound(format!(
            "공통 스킬 원본을 찾지 못했습니다: {key}"
        )));
    }
    let (source, content) = read_common_source(&directory, &key)?;

    let mut issues = Vec::new();
    check_source_content(&key, &source, &content, &mut issues);

    let requested: BTreeSet<ProviderId> = providers.iter().copied().collect();
    if requested.is_empty() {
        issues.push(SkillCompatibilityIssue {
            severity: SkillIssueSeverity::Blocking,
            provider: None,
            code: "no-provider".to_owned(),
            message: "게시할 공급자를 하나 이상 선택하세요".to_owned(),
        });
    }

    let mut provider_reports = Vec::new();
    for provider in requested {
        let adapter = adapter(provider);
        let Some(install_root) = resolve_install_root(home, projects, provider, location)? else {
            // 게시할 수 없는 공급자는 그 공급자만 건너뛴다. 차단으로 올리면 함께
            // 고른 다른 공급자까지 게시되지 않아, 고칠 수 없는 이유로 전체가 막힌다.
            issues.push(SkillCompatibilityIssue {
                severity: SkillIssueSeverity::Warning,
                provider: Some(provider),
                code: "unsupported".to_owned(),
                message: adapter
                    .unsupported_note
                    .unwrap_or("이 공급자는 사용자 스킬 루트를 제공하지 않습니다")
                    .to_owned(),
            });
            provider_reports.push(SkillProviderCompatibility {
                provider,
                publishable: false,
                requires_overwrite: false,
                already_current: false,
                target_directory: None,
            });
            continue;
        };
        let target = install_root.join(&key);
        let mut publishable = true;
        let mut requires_overwrite = false;
        let mut already_current = false;

        let link_metadata = fs::symlink_metadata(&target);
        if let Ok(metadata) = link_metadata {
            requires_overwrite = true;
            if metadata.file_type().is_symlink() {
                // 다른 도구가 만든 링크를 실제 사본으로 바꾸는 것은 그 도구의 관리
                // 대상을 빼앗는 일이다. 사용자가 알고 결정해야 한다.
                let resolves_to_common = fs::canonicalize(&target)
                    .ok()
                    .zip(fs::canonicalize(&directory).ok())
                    .is_some_and(|(left, right)| left == right);
                issues.push(SkillCompatibilityIssue {
                    severity: SkillIssueSeverity::Warning,
                    provider: Some(provider),
                    code: "existing-symlink".to_owned(),
                    message: if resolves_to_common {
                        "이미 공통 원본을 가리키는 링크가 있습니다. 게시하면 독립 사본으로 바뀝니다"
                            .to_owned()
                    } else {
                        "다른 위치를 가리키는 링크가 있습니다. 게시하면 링크가 사본으로 바뀝니다"
                            .to_owned()
                    },
                });
                if resolves_to_common {
                    already_current = true;
                }
            } else if metadata.is_dir() {
                match read_skill_content(&target) {
                    Ok(existing) => {
                        already_current = projected_skill_digest(
                            adapter,
                            &directory,
                            &content,
                            HostPlatform::current(),
                        )
                        .is_ok_and(|digest| existing.digest == digest)
                    }
                    Err(error) => issues.push(SkillCompatibilityIssue {
                        severity: SkillIssueSeverity::Warning,
                        provider: Some(provider),
                        code: "existing-unreadable".to_owned(),
                        message: format!("기존 설치본을 읽지 못했습니다: {error}"),
                    }),
                }
            } else {
                publishable = false;
                issues.push(SkillCompatibilityIssue {
                    severity: SkillIssueSeverity::Blocking,
                    provider: Some(provider),
                    code: "target-not-directory".to_owned(),
                    message: "대상 경로에 디렉터리가 아닌 파일이 있습니다".to_owned(),
                });
            }
        }

        provider_reports.push(SkillProviderCompatibility {
            provider,
            publishable,
            requires_overwrite,
            already_current,
            target_directory: Some(target.to_string_lossy().into_owned()),
        });
    }

    Ok(SkillCompatibilityReport {
        key,
        source_digest: content.digest,
        file_count: content.file_count,
        total_bytes: content.total_bytes,
        providers: provider_reports,
        issues,
    })
}

// ---------------------------------------------------------------------------
// 게시
// ---------------------------------------------------------------------------

/// 배포 위치. 지정하지 않으면 개인 루트다.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillLocation {
    /// "personal"(기본) | "project"
    #[serde(default)]
    pub scope: Option<String>,
    #[serde(default)]
    pub project_path: Option<String>,
}

impl SkillLocation {
    fn is_project(&self) -> bool {
        self.scope.as_deref() == Some("project")
    }
}

/// 공급자·위치에 맞는 설치 루트를 해석한다. 개인 위치는 어댑터의 사용자 루트,
/// 프로젝트 위치는 등록된 프로젝트 안의 에이전트 스킬 디렉터리다. 게시 미지원
/// 공급자는 None이고, 등록되지 않은 프로젝트 경로는 오류다.
fn resolve_install_root(
    home: &Path,
    projects: &[PathBuf],
    provider: ProviderId,
    location: &SkillLocation,
) -> Result<Option<PathBuf>, CoreError> {
    if !location.is_project() {
        return Ok(adapter(provider).installable_root(home));
    }
    let requested = location.project_path.as_deref().ok_or_else(|| {
        CoreError::InvalidInput("프로젝트 위치에는 projectPath가 필요합니다".to_owned())
    })?;
    let requested_canonical = fs::canonicalize(requested)
        .map_err(|_| CoreError::InvalidInput("프로젝트 경로를 확인할 수 없습니다".to_owned()))?;
    let project = projects
        .iter()
        .find(|path| fs::canonicalize(path).ok().as_deref() == Some(requested_canonical.as_path()))
        .cloned()
        .ok_or_else(|| CoreError::InvalidInput("등록된 프로젝트가 아닙니다".to_owned()))?;
    Ok(Some(adapter(provider).project_root(&project)))
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SkillOverwritePolicy {
    /// 기존 설치본이 있으면 실패한다. 요청에 값이 없을 때의 기본값이다.
    #[default]
    Fail,
    /// 기존 설치본을 원자적으로 교체한다.
    Replace,
}

impl SkillOverwritePolicy {
    pub const ALL: [Self; 2] = [Self::Fail, Self::Replace];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Fail => "fail",
            Self::Replace => "replace",
        }
    }

    /// 실패 정책인지 여부.
    pub fn is_fail(self) -> bool {
        matches!(self, Self::Fail)
    }

    /// 교체 정책인지 여부.
    pub fn is_replace(self) -> bool {
        matches!(self, Self::Replace)
    }
}

impl std::fmt::Display for SkillOverwritePolicy {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

impl std::str::FromStr for SkillOverwritePolicy {
    type Err = CoreError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.trim() {
            "fail" => Ok(Self::Fail),
            "replace" => Ok(Self::Replace),
            _ => Err(CoreError::InvalidInput(format!(
                "알 수 없는 스킬 덮어쓰기 정책입니다: {s}. fail|replace 중 하나를 쓰세요"
            ))),
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillPublishRequest {
    pub key: String,
    pub providers: Vec<ProviderId>,
    #[serde(default)]
    pub overwrite: SkillOverwritePolicy,
    /// 배포 위치. 생략하면 개인 루트.
    #[serde(default)]
    pub location: SkillLocation,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SkillPublishOutcome {
    /// 새로 게시했다.
    Published,
    /// 기존 설치본을 교체했다.
    Replaced,
    /// 이미 같은 내용이라 바꾸지 않았다.
    Unchanged,
    /// 게시하지 않았다. 이유는 message에 있다.
    Skipped,
    Failed,
}

impl SkillPublishOutcome {
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

impl std::fmt::Display for SkillPublishOutcome {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

impl std::str::FromStr for SkillPublishOutcome {
    type Err = CoreError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.trim() {
            "published" => Ok(Self::Published),
            "replaced" => Ok(Self::Replaced),
            "unchanged" => Ok(Self::Unchanged),
            "skipped" => Ok(Self::Skipped),
            "failed" => Ok(Self::Failed),
            _ => Err(CoreError::InvalidInput(format!(
                "알 수 없는 스킬 게시 결과입니다: {s}. published|replaced|unchanged|skipped|failed 중 하나를 쓰세요"
            ))),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillPublishResult {
    pub provider: ProviderId,
    pub outcome: SkillPublishOutcome,
    pub directory: Option<String>,
    pub message: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillPublishReceipt {
    pub key: String,
    pub source_digest: String,
    pub results: Vec<SkillPublishResult>,
    pub report: SkillCompatibilityReport,
}

/// 선택한 공급자에 공통 원본을 게시한다.
///
/// 한 공급자 실패가 다른 공급자 게시를 막지 않는다. 각 공급자 게시는
/// 스테이징 디렉터리에 전부 복사한 뒤 rename으로 자리를 바꾸는 방식이라,
/// 중간에 실패하면 기존 설치본이 그대로 남는다.
pub fn publish_common_skill(
    app_data_dir: &Path,
    sessions: &[SessionSummary],
    request: &SkillPublishRequest,
) -> Result<SkillPublishReceipt, CoreError> {
    let roots = SkillRoots::from_app_data(app_data_dir, sessions)?;
    publish_common_skill_from_paths(&roots, request)
}

#[cfg(test)]
pub(crate) fn publish_common_skill_from_home(
    home: &Path,
    request: &SkillPublishRequest,
) -> Result<SkillPublishReceipt, CoreError> {
    let roots = SkillRoots::from_home(home);
    publish_common_skill_from_paths(&roots, request)
}

fn publish_common_skill_from_paths(
    roots: &SkillRoots,
    request: &SkillPublishRequest,
) -> Result<SkillPublishReceipt, CoreError> {
    let (home, root, projects) = (roots.home(), roots.root(), roots.projects());
    let report =
        check_skill_publish_from_paths(roots, &request.key, &request.providers, &request.location)?;
    if report.blocked() {
        let message = report
            .issues
            .iter()
            .find(|issue| issue.severity == SkillIssueSeverity::Blocking)
            .map(|issue| issue.message.clone())
            .unwrap_or_else(|| "스킬 호환성 검사를 통과하지 못했습니다".to_owned());
        return Err(CoreError::InvalidInput(message));
    }

    let key = report.key.clone();
    let directory = root.join(&key);
    let content = read_skill_content(&directory)?;
    if content.digest != report.source_digest {
        // 검사와 복사 사이에 원본이 바뀌었다. 반쯤 섞인 게시본을 만들지 않는다.
        return Err(CoreError::Conflict(
            "검사 중 공통 원본이 변경되었습니다. 다시 시도하세요".to_owned(),
        ));
    }

    let mut results = Vec::new();
    for provider_report in &report.providers {
        let provider = provider_report.provider;
        let Some(target_text) = provider_report.target_directory.clone() else {
            results.push(SkillPublishResult {
                provider,
                outcome: SkillPublishOutcome::Skipped,
                directory: None,
                message: Some(
                    "이 공급자는 사용자 스킬 루트를 제공하지 않아 게시할 수 없습니다".to_owned(),
                ),
            });
            continue;
        };
        if !provider_report.publishable {
            results.push(SkillPublishResult {
                provider,
                outcome: SkillPublishOutcome::Skipped,
                directory: Some(target_text),
                message: Some("대상 경로 상태 때문에 게시하지 않았습니다".to_owned()),
            });
            continue;
        }
        if provider_report.already_current
            && matches!(request.overwrite, SkillOverwritePolicy::Fail)
        {
            results.push(SkillPublishResult {
                provider,
                outcome: SkillPublishOutcome::Unchanged,
                directory: Some(target_text),
                message: Some("이미 공통 원본과 같은 내용입니다".to_owned()),
            });
            continue;
        }
        if provider_report.requires_overwrite
            && matches!(request.overwrite, SkillOverwritePolicy::Fail)
        {
            results.push(SkillPublishResult {
                provider,
                outcome: SkillPublishOutcome::Skipped,
                directory: Some(target_text),
                message: Some(
                    "같은 이름의 설치본이 이미 있습니다. 덮어쓰기를 선택하세요".to_owned(),
                ),
            });
            continue;
        }

        match publish_to_provider(
            home,
            projects,
            provider,
            &key,
            &directory,
            &content,
            &request.location,
        ) {
            Ok(outcome) => results.push(SkillPublishResult {
                provider,
                outcome,
                directory: Some(target_text),
                message: None,
            }),
            Err(error) => results.push(SkillPublishResult {
                provider,
                outcome: SkillPublishOutcome::Failed,
                directory: Some(target_text),
                message: Some(error.to_string()),
            }),
        }
    }

    Ok(SkillPublishReceipt {
        key,
        source_digest: content.digest,
        results,
        report,
    })
}

fn publish_to_provider(
    home: &Path,
    projects: &[PathBuf],
    provider: ProviderId,
    key: &str,
    source_directory: &Path,
    content: &SkillContent,
    location: &SkillLocation,
) -> Result<SkillPublishOutcome, CoreError> {
    let install_root =
        resolve_install_root(home, projects, provider, location)?.ok_or_else(|| {
            CoreError::InvalidInput("이 공급자는 사용자 스킬 루트를 제공하지 않습니다".to_owned())
        })?;
    publish_to_root(provider, &install_root, key, source_directory, content)
}

/// 해석이 끝난 설치 루트에 게시한다. 동기화·편집 재배포처럼 루트를 이미 아는
/// 호출자가 직접 쓴다.
fn publish_to_root(
    provider: ProviderId,
    install_root: &Path,
    key: &str,
    source_directory: &Path,
    content: &SkillContent,
) -> Result<SkillPublishOutcome, CoreError> {
    let adapter = adapter(provider);
    fs::create_dir_all(install_root)?;
    let target = install_root.join(key);
    assert_within_root(install_root, &target)?;

    let nonce = publish_nonce();
    let stage = install_root.join(format!("{STAGE_PREFIX}{key}-{nonce}"));
    assert_within_root(install_root, &stage)?;
    if stage.exists() {
        return Err(CoreError::Conflict(
            "임시 게시 디렉터리가 이미 있습니다".to_owned(),
        ));
    }

    // 1) 전부 스테이징에 쓴다. 실패하면 대상은 손대지 않은 상태다.
    if let Err(error) = stage_skill_copy(adapter, source_directory, &stage, content) {
        let _ = fs::remove_dir_all(&stage);
        return Err(error);
    }

    // 2) 기존 설치본이 있으면 백업으로 옮긴 뒤 자리를 바꾼다. 실패하면 백업을 원래
    //    자리로 되돌리고 스테이징을 지운다.
    let existed = fs::symlink_metadata(&target).is_ok();
    let backup = install_root.join(format!("{BACKUP_PREFIX}{key}-{nonce}"));
    StagedReplace {
        kind: StagedKind::Directory,
        stage: &stage,
        target: &target,
        backup: existed.then_some(backup.as_path()),
    }
    .commit()?;
    if existed {
        remove_published_backup(&backup);
        Ok(SkillPublishOutcome::Replaced)
    } else {
        Ok(SkillPublishOutcome::Published)
    }
}

/// 백업은 우리가 방금 옮긴 디렉터리이거나 링크다. 링크였다면 대상까지 따라가
/// 지우지 않도록 링크 자체만 제거한다.
fn remove_published_backup(backup: &Path) {
    match fs::symlink_metadata(backup) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            let _ = fs::remove_file(backup);
        }
        Ok(metadata) if metadata.is_dir() => {
            let _ = fs::remove_dir_all(backup);
        }
        Ok(_) => {
            let _ = fs::remove_file(backup);
        }
        Err(_) => {}
    }
}

fn stage_skill_copy(
    adapter: &SkillAdapter,
    source_directory: &Path,
    stage: &Path,
    content: &SkillContent,
) -> Result<(), CoreError> {
    let manifest = checked_resource_manifest(source_directory)?;
    let platform = HostPlatform::current();
    if manifest.migration_required(platform) {
        return Err(CoreError::InvalidInput(format!(
            "현재 OS({platform})용 스킬 변형이 없습니다"
        )));
    }
    fs::create_dir_all(stage)?;
    let files = projected_skill_files(source_directory, content, &manifest, platform)?;
    for file in files.values() {
        validate_relative_path(&file.relative)?;
        let destination = stage.join(&file.relative);
        assert_within_root(stage, &destination)?;
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent)?;
        }
        let source_path = file.source.clone();
        // 링크는 지문 계산에서 이미 제외했고 호환성 검사가 막는다. 그래도 복사
        // 직전에 다시 확인해 경합으로 바뀐 경우를 잡는다.
        if fs::symlink_metadata(&source_path)?.file_type().is_symlink() {
            return Err(CoreError::Conflict(format!(
                "복사 중 심볼릭 링크가 나타났습니다: {}",
                file.relative.display()
            )));
        }
        if file.relative == Path::new("SKILL.md") {
            let text = read_text_limited(&source_path, MAX_SKILL_MD_BYTES)?;
            fs::write(&destination, adapter.project_skill_md(&text))?;
        } else {
            fs::copy(&source_path, &destination)?;
        }
        preserve_executable_bit(&destination, file.executable)?;
    }
    Ok(())
}

/// 공통 원본 자체를 편집 스테이지로 복제한다. 공급자 게시용 projection과 달리
/// 모든 OS 메타·variant를 그대로 보존한다.
fn stage_raw_skill_copy(
    source_directory: &Path,
    stage: &Path,
    content: &SkillContent,
) -> Result<(), CoreError> {
    fs::create_dir_all(stage)?;
    for file in &content.files {
        validate_relative_path(&file.relative)?;
        let destination = stage.join(&file.relative);
        assert_within_root(stage, &destination)?;
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent)?;
        }
        let source = source_directory.join(&file.relative);
        if fs::symlink_metadata(&source)?.file_type().is_symlink() {
            return Err(CoreError::Conflict(format!(
                "복사 중 심볼릭 링크가 나타났습니다: {}",
                file.relative.display()
            )));
        }
        fs::copy(source, &destination)?;
        preserve_executable_bit(&destination, file.executable)?;
    }
    Ok(())
}

#[derive(Debug, Clone)]
struct ProjectedSkillFile {
    relative: PathBuf,
    source: PathBuf,
    executable: bool,
}

fn projected_skill_files(
    source_directory: &Path,
    content: &SkillContent,
    manifest: &ResourcePlatformManifest,
    platform: HostPlatform,
) -> Result<BTreeMap<PathBuf, ProjectedSkillFile>, CoreError> {
    let variant_roots = manifest
        .variants
        .values()
        .map(|value| validate_variant_relative_path(value))
        .collect::<Result<Vec<_>, _>>()?;
    let mut files = BTreeMap::new();
    for file in &content.files {
        if file.relative.starts_with(".agent-manager")
            || variant_roots
                .iter()
                .any(|variant| file.relative.starts_with(variant))
        {
            continue;
        }
        files.insert(
            file.relative.clone(),
            ProjectedSkillFile {
                relative: file.relative.clone(),
                source: source_directory.join(&file.relative),
                executable: file.executable,
            },
        );
    }
    if let Some(deletes) = manifest.variant_deletes.get(&platform) {
        for deleted in deletes {
            let deleted = PathBuf::from(deleted);
            validate_variant_delete_path(&deleted)?;
            files.retain(|relative, _| relative != &deleted && !relative.starts_with(&deleted));
        }
    }
    if let Some(variant) = manifest.active_variant(platform) {
        let variant = validate_variant_relative_path(variant)?;
        let variant_directory = source_directory.join(&variant);
        if !variant_directory.exists() {
            return Ok(files);
        }
        let variant_content = read_skill_content(&variant_directory)?;
        if let Some(link) = variant_content.symlinks.first() {
            return Err(CoreError::InvalidInput(format!(
                "OS 변형에 심볼릭 링크가 있습니다: {link}"
            )));
        }
        for file in variant_content.files {
            files.insert(
                file.relative.clone(),
                ProjectedSkillFile {
                    relative: file.relative.clone(),
                    source: variant_directory.join(&file.relative),
                    executable: file.executable,
                },
            );
        }
    }
    Ok(files)
}

fn projected_skill_digest(
    adapter: &SkillAdapter,
    source_directory: &Path,
    content: &SkillContent,
    platform: HostPlatform,
) -> Result<String, CoreError> {
    let manifest = checked_resource_manifest(source_directory)?;
    if manifest.migration_required(platform) {
        return Err(CoreError::InvalidInput(
            "현재 OS용 스킬이 없습니다".to_owned(),
        ));
    }
    let files = projected_skill_files(source_directory, content, &manifest, platform)?;
    let mut hasher = Sha256::new();
    for file in files.values() {
        hasher.update(file.relative.to_string_lossy().as_bytes());
        hasher.update([0]);
        hasher.update([u8::from(file.executable)]);
        let bytes = if file.relative == Path::new("SKILL.md") {
            adapter
                .project_skill_md(&read_text_limited(&file.source, MAX_SKILL_MD_BYTES)?)
                .into_bytes()
        } else {
            fs::read(&file.source)?
        };
        hasher.update(bytes.len().to_le_bytes());
        hasher.update(bytes);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn checked_resource_manifest(directory: &Path) -> Result<ResourcePlatformManifest, CoreError> {
    let path = resource_manifest_path(directory);
    if !path.exists() {
        return Ok(ResourcePlatformManifest::default());
    }
    regular_file_metadata(
        &path,
        "스킬 OS 메타는 심볼릭 링크가 아닌 일반 파일이어야 합니다",
    )?;
    let manifest: ResourcePlatformManifest = serde_json::from_slice(&fs::read(path)?)?;
    if manifest.schema_version != 1 {
        return Err(CoreError::InvalidInput(format!(
            "지원하지 않는 스킬 OS 메타 버전입니다: {}",
            manifest.schema_version
        )));
    }
    for (platform, variant) in &manifest.variants {
        let relative = validate_platform_variant_path(*platform, variant)?;
        let target = directory.join(relative);
        assert_within_root(directory, &target)?;
        if !target.exists()
            && !manifest
                .variant_deletes
                .get(platform)
                .is_some_and(|deletes| !deletes.is_empty())
        {
            return Err(CoreError::InvalidInput(format!(
                "{platform} OS 변형 디렉터리를 찾지 못했습니다"
            )));
        }
    }
    for deletes in manifest.variant_deletes.values() {
        for deleted in deletes {
            validate_variant_delete_path(Path::new(deleted))?;
        }
    }
    Ok(manifest)
}

#[cfg(unix)]
fn preserve_executable_bit(path: &Path, executable: bool) -> Result<(), CoreError> {
    use std::os::unix::fs::PermissionsExt;
    let metadata = fs::metadata(path)?;
    let mut permissions = metadata.permissions();
    let mode = permissions.mode();
    let next = if executable {
        mode | 0o755 & 0o7777
    } else {
        mode & !0o111
    };
    if next != mode {
        permissions.set_mode(next);
        fs::set_permissions(path, permissions)?;
    }
    Ok(())
}

#[cfg(not(unix))]
fn preserve_executable_bit(_path: &Path, _executable: bool) -> Result<(), CoreError> {
    Ok(())
}

/// 스테이징·백업 이름에 쓰는 충돌 방지 값. 같은 프로세스 안에서 동시에 두 번
/// 게시해도 이름이 겹치지 않는다.
fn publish_nonce() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

// ---------------------------------------------------------------------------
// 공통 원본 생성·가져오기
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateCommonSkillRequest {
    pub key: String,
    pub name: Option<String>,
    pub description: String,
}

/// 공통 원본을 새로 만든다. 이미 있으면 덮어쓰지 않고 실패한다.
pub fn create_common_skill(
    app_data_dir: &Path,
    request: &CreateCommonSkillRequest,
) -> Result<CommonSkillSource, CoreError> {
    create_common_skill_in_root(&repository_skills_root(app_data_dir), request)
}

#[cfg(test)]
pub(crate) fn create_common_skill_from_home(
    home: &Path,
    request: &CreateCommonSkillRequest,
) -> Result<CommonSkillSource, CoreError> {
    create_common_skill_in_root(&common_root(home), request)
}

fn create_common_skill_in_root(
    root: &Path,
    request: &CreateCommonSkillRequest,
) -> Result<CommonSkillSource, CoreError> {
    let key = validate_skill_key(&request.key)?;
    let description = request.description.trim();
    if description.is_empty() {
        return Err(CoreError::InvalidInput(
            "스킬 설명을 입력하세요. 공급자가 설명으로 스킬을 발견합니다".to_owned(),
        ));
    }
    if description.chars().count() > MAX_DESCRIPTION_CHARS {
        return Err(CoreError::InvalidInput(format!(
            "스킬 설명은 {MAX_DESCRIPTION_CHARS}자까지 허용됩니다"
        )));
    }
    let name = request
        .name
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(&key)
        .to_owned();

    fs::create_dir_all(root)?;
    let directory = root.join(&key);
    assert_within_root(root, &directory)?;
    if fs::symlink_metadata(&directory).is_ok() {
        return Err(CoreError::Conflict(format!(
            "'{key}' 공통 스킬이 이미 있습니다"
        )));
    }
    fs::create_dir(&directory)?;
    let body = format!(
        "---\nname: {name}\ndescription: {}\n---\n\n# {name}\n\n여기에 스킬 지침을 작성하세요.\n",
        yaml_scalar(description)
    );
    if let Err(error) = fs::write(directory.join("SKILL.md"), body) {
        let _ = fs::remove_dir_all(&directory);
        return Err(CoreError::Io(error));
    }
    let (source, _) = read_common_source(&directory, &key)?;
    Ok(source)
}

/// YAML 한 줄 스칼라로 안전하게 쓴다. 구조를 깨는 문자가 있으면 따옴표로 감싼다.
fn yaml_scalar(value: &str) -> String {
    let needs_quotes = value.starts_with(['&', '*', '!', '|', '>', '%', '@', '`', '"', '\'', '#'])
        || value.contains(": ")
        || value.contains(" #")
        || value.ends_with(':')
        || value.contains('\n');
    if needs_quotes {
        format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
    } else {
        value.to_owned()
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportCommonSkillRequest {
    /// 가져올 공급자 설치본의 `SkillSummary.id`.
    pub skill_id: String,
}

/// 공급자 설치본을 공통 원본으로 가져온다. 원본 설치본은 그대로 두고 공통 루트에
/// 사본을 만든다. 공통 원본이 이미 있으면 실패한다.
pub fn import_skill_to_common(
    app_data_dir: &Path,
    sessions: &[SessionSummary],
    request: &ImportCommonSkillRequest,
) -> Result<CommonSkillSource, CoreError> {
    let roots = SkillRoots::from_app_data(app_data_dir, sessions)?;
    import_skill_to_common_from_paths(&roots, Some(app_data_dir), request)
}

#[cfg(test)]
pub(crate) fn import_skill_to_common_from_home(
    home: &Path,
    app_data_dir: Option<&Path>,
    request: &ImportCommonSkillRequest,
) -> Result<CommonSkillSource, CoreError> {
    let roots = SkillRoots::from_home(home);
    import_skill_to_common_from_paths(&roots, app_data_dir, request)
}

fn import_skill_to_common_from_paths(
    roots: &SkillRoots,
    app_data_dir: Option<&Path>,
    request: &ImportCommonSkillRequest,
) -> Result<CommonSkillSource, CoreError> {
    let (home, root, projects) = (roots.home(), roots.root(), roots.projects());
    let mut issues = Vec::new();
    let installs = scan_provider_installs(home, projects, &mut issues);
    let install = installs
        .into_iter()
        .find(|install| install.skill_id == request.skill_id)
        .ok_or_else(|| CoreError::NotFound("스킬 설치본을 찾지 못했습니다".to_owned()))?;

    // 읽기 전용 공급자 스킬은 공급자·플러그인 소유 콘텐츠다. 사용자 스킬만 통합
    // 원본으로 승격한다.
    if !matches!(install.scope, "personal" | "project") {
        return Err(CoreError::InvalidInput(
            "공급자·플러그인이 소유한 스킬은 공통 원본으로 가져올 수 없습니다".to_owned(),
        ));
    }

    let key = install
        .directory
        .file_name()
        .map(|value| value.to_string_lossy().into_owned())
        .ok_or_else(|| {
            CoreError::InvalidInput("스킬 디렉터리 이름을 읽지 못했습니다".to_owned())
        })?;
    let key = validate_skill_key(&key)?;

    let content = read_skill_content(&install.directory)?;
    if content.truncated {
        return Err(CoreError::InvalidInput(format!(
            "스킬 구성 파일이 {MAX_SKILL_FILES}개를 넘습니다"
        )));
    }
    if content.total_bytes > MAX_SKILL_TOTAL_BYTES {
        return Err(CoreError::InvalidInput(format!(
            "스킬 전체 크기가 허용 한도({}MB)를 넘습니다",
            MAX_SKILL_TOTAL_BYTES / (1024 * 1024)
        )));
    }
    if let Some(link) = content.symlinks.first() {
        return Err(CoreError::InvalidInput(format!(
            "심볼릭 링크가 있어 공통 원본으로 가져올 수 없습니다: {link}"
        )));
    }

    fs::create_dir_all(root)?;
    let target = root.join(&key);
    assert_within_root(root, &target)?;
    if fs::symlink_metadata(&target).is_ok() {
        return Err(CoreError::Conflict(format!(
            "'{key}' 공통 스킬이 이미 있습니다"
        )));
    }

    let nonce = publish_nonce();
    let stage = root.join(format!("{STAGE_PREFIX}{key}-{nonce}"));
    assert_within_root(root, &stage)?;
    // 가져오기는 공급자 고유 키를 걷어내지 않는다. 공통 원본은 모든 키를 보존하고
    // 게시할 때 대상 공급자에 맞춰 투영한다.
    if let Err(error) = stage_skill_copy(
        adapter(install.provider),
        &install.directory,
        &stage,
        &content,
    ) {
        let _ = fs::remove_dir_all(&stage);
        return Err(error);
    }
    StagedReplace {
        kind: StagedKind::Directory,
        stage: &stage,
        target: &target,
        backup: None,
    }
    .commit()?;
    let (source, _) = read_common_source(&target, &key)?;
    // 보관 출처(에이전트·범위·프로젝트)를 메타에 기록한다. 사용 체크가 출처
    // 위치를 기준으로 배포·회수하는 데 쓴다.
    if let Some(app_data_dir) = app_data_dir {
        let origin = SkillOriginMeta {
            provider: install.provider,
            scope: install.scope.to_owned(),
            project_path: install
                .project_path
                .as_ref()
                .map(|path| path.to_string_lossy().into_owned()),
            archived_at_ms: Some(chrono::Utc::now().timestamp_millis()),
        };
        record_skill_origin(app_data_dir, &key, origin)?;
    }
    Ok(source)
}

// ---------------------------------------------------------------------------
// 삭제 (휴지통 경유)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteInstalledSkillRequest {
    /// 삭제할 설치본의 `SkillSummary.id`.
    pub id: String,
    /// 삭제 주체 표시용 값. `aia`만 별도 인정하고 나머지는 `user`로 기록한다.
    #[serde(default)]
    pub deleted_by: Option<String>,
    /// 확정 삭제 의사 표시. `check_skill_delete`로 영향을 확인한 뒤 true로 보낸다.
    #[serde(default)]
    pub confirm: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteSharedSkillRequest {
    /// 공유 원본 키. 원본과 모든 에이전트 배포본을 한 그룹으로 삭제한다.
    pub key: String,
    #[serde(default)]
    pub deleted_by: Option<String>,
    #[serde(default)]
    pub confirm: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnarchiveSharedSkillRequest {
    /// 보관 원본 키. 원본만 휴지통으로 옮기고 에이전트 사용본은 건드리지 않는다.
    pub key: String,
    #[serde(default)]
    pub deleted_by: Option<String>,
    /// 확정 의사 표시. 사용본이 없는 스킬은 목록에서 사라지므로 UI가 먼저 알린다.
    #[serde(default)]
    pub confirm: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillDeleteCheckRequest {
    /// 설치본 삭제 영향을 볼 때의 `SkillSummary.id`.
    #[serde(default)]
    pub id: Option<String>,
    /// 공유 스킬 전체 삭제 영향을 볼 때의 공유 원본 키.
    #[serde(default)]
    pub key: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillDeleteImpactItem {
    pub path: String,
    pub kind: SkillTrashItemKind,
    /// 공급자 설치본이면 해당 공급자, 공유 원본이면 없음.
    pub provider: Option<ProviderId>,
    pub scope: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillDeleteImpact {
    pub key: String,
    /// 공유 원본에 같은 키가 있는지. 설치본만 지우면 원본과 다른 배포본은 남는다.
    pub shared: bool,
    pub items: Vec<SkillDeleteImpactItem>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillDeleteReceipt {
    pub key: String,
    /// 휴지통 그룹 ID. 복구는 이 그룹 단위로 이루어진다.
    pub group_id: String,
    pub items: Vec<SkillTrashItem>,
    pub warnings: Vec<String>,
}

fn normalized_delete_actor(value: Option<&str>) -> String {
    match value {
        Some("aia") => "aia".to_owned(),
        _ => "user".to_owned(),
    }
}

fn require_delete_confirm(confirm: bool) -> Result<(), CoreError> {
    if confirm {
        Ok(())
    } else {
        Err(CoreError::InvalidInput(
            "삭제는 confirm: true를 함께 보내야 합니다. check_skill_delete로 영향 범위를 먼저 확인하세요"
                .to_owned(),
        ))
    }
}

fn require_unarchive_confirm(confirm: bool) -> Result<(), CoreError> {
    if confirm {
        Ok(())
    } else {
        Err(CoreError::InvalidInput(
            "보관취소는 confirm: true를 함께 보내야 합니다. 사용본이 없으면 목록에서 사라집니다"
                .to_owned(),
        ))
    }
}

/// 사용자가 지울 수 있는 위치인지. 에이전트·플러그인 소유(scope plugin/system/
/// builtin)는 코어에서 거부한다. UI 버튼 숨김만으로는 AIA 경로가 남는다.
fn assert_user_deletable_scope(scope: &str) -> Result<(), CoreError> {
    if matches!(scope, "personal" | "project") {
        Ok(())
    } else {
        Err(CoreError::InvalidInput(
            "에이전트·플러그인이 소유한 내장 스킬은 삭제할 수 없습니다".to_owned(),
        ))
    }
}

/// 설치본 디렉터리의 실체 종류. 링크면 대상 경로를 함께 돌려준다.
fn install_kind(directory: &Path) -> (SkillTrashItemKind, Option<String>) {
    match fs::symlink_metadata(directory) {
        Ok(metadata) if metadata.file_type().is_symlink() => (
            SkillTrashItemKind::Link,
            fs::read_link(directory)
                .ok()
                .map(|target| target.to_string_lossy().into_owned()),
        ),
        _ => (SkillTrashItemKind::Directory, None),
    }
}

fn skill_display_meta(skill_md: &Path, key: &str) -> (String, String) {
    let Ok(text) = read_text_limited(skill_md, MAX_SKILL_MD_BYTES) else {
        return (key.to_owned(), String::new());
    };
    let (frontmatter, _) = split_frontmatter(&text);
    (
        frontmatter_value(frontmatter, "name").unwrap_or_else(|| key.to_owned()),
        frontmatter_value(frontmatter, "description").unwrap_or_default(),
    )
}

fn install_key(install: &ProviderInstall) -> Result<String, CoreError> {
    install
        .directory
        .file_name()
        .map(|value| value.to_string_lossy().into_owned())
        .ok_or_else(|| CoreError::InvalidInput("스킬 디렉터리 이름을 읽지 못했습니다".to_owned()))
}

fn find_install_by_id(
    home: &Path,
    projects: &[PathBuf],
    id: &str,
) -> Result<ProviderInstall, CoreError> {
    let mut issues = Vec::new();
    scan_provider_installs(home, projects, &mut issues)
        .into_iter()
        .find(|install| install.skill_id == id)
        .ok_or_else(|| CoreError::NotFound("스킬 설치본을 찾지 못했습니다".to_owned()))
}

fn is_shared_key(root: &Path, key: &str) -> bool {
    root.join(key).join("SKILL.md").is_file()
}

fn trash_draft_for_install(
    common_root: &Path,
    install: &ProviderInstall,
    key: &str,
    group_id: &str,
    actor: &str,
) -> SkillTrashItemDraft {
    let (kind, link_target) = install_kind(&install.directory);
    let (name, description) = skill_display_meta(&install.path, key);
    let (file_count, total_bytes) = if kind == SkillTrashItemKind::Directory {
        read_skill_content(&install.directory)
            .map(|content| (content.file_count, content.total_bytes))
            .unwrap_or((0, 0))
    } else {
        (0, 0)
    };
    SkillTrashItemDraft {
        group_id: group_id.to_owned(),
        key: key.to_owned(),
        kind,
        link_target,
        provider: Some(install.provider),
        scope: Some(install.scope.to_owned()),
        shared: is_shared_key(common_root, key),
        deleted_by: actor.to_owned(),
        content_digest: install.digest.clone(),
        file_count,
        total_bytes,
        name,
        description,
    }
}

/// 삭제 영향 확인. 파일을 쓰지 않는 읽기 작업이다. `id`는 설치본 하나,
/// `key`는 공유 원본과 모든 배포본을 대상으로 본다.
pub fn check_skill_delete(
    app_data_dir: &Path,
    sessions: &[SessionSummary],
    request: &SkillDeleteCheckRequest,
) -> Result<SkillDeleteImpact, CoreError> {
    let roots = SkillRoots::from_app_data(app_data_dir, sessions)?;
    check_skill_delete_from_paths(&roots, request)
}

#[cfg(test)]
pub(crate) fn check_skill_delete_from_home(
    home: &Path,
    request: &SkillDeleteCheckRequest,
) -> Result<SkillDeleteImpact, CoreError> {
    let roots = SkillRoots::from_home(home);
    check_skill_delete_from_paths(&roots, request)
}

fn check_skill_delete_from_paths(
    roots: &SkillRoots,
    request: &SkillDeleteCheckRequest,
) -> Result<SkillDeleteImpact, CoreError> {
    let (home, root, projects) = (roots.home(), roots.root(), roots.projects());
    match (&request.id, &request.key) {
        (Some(id), None) => {
            let install = find_install_by_id(home, projects, id)?;
            assert_user_deletable_scope(install.scope)?;
            let key = install_key(&install)?;
            let (kind, _) = install_kind(&install.directory);
            Ok(SkillDeleteImpact {
                shared: is_shared_key(root, &key),
                key,
                items: vec![SkillDeleteImpactItem {
                    path: install.directory.to_string_lossy().into_owned(),
                    kind,
                    provider: Some(install.provider),
                    scope: Some(install.scope.to_owned()),
                }],
                warnings: Vec::new(),
            })
        }
        (None, Some(key)) => {
            let (directory, targets, warnings) =
                collect_shared_delete_targets(home, root, projects, key)?;
            let mut items: Vec<SkillDeleteImpactItem> = targets
                .iter()
                .map(|install| {
                    let (kind, _) = install_kind(&install.directory);
                    SkillDeleteImpactItem {
                        path: install.directory.to_string_lossy().into_owned(),
                        kind,
                        provider: Some(install.provider),
                        scope: Some(install.scope.to_owned()),
                    }
                })
                .collect();
            let (kind, _) = install_kind(&directory);
            items.push(SkillDeleteImpactItem {
                path: directory.to_string_lossy().into_owned(),
                kind,
                provider: None,
                scope: None,
            });
            Ok(SkillDeleteImpact {
                key: key.clone(),
                shared: true,
                items,
                warnings,
            })
        }
        _ => Err(CoreError::InvalidInput(
            "id 또는 key 중 하나만 지정하세요".to_owned(),
        )),
    }
}

/// 보관 스킬 전체 삭제 대상 수집. 개인 루트와 프로젝트 저장소의 사용본을 모두
/// 포함한다. 사용 해제(개별 삭제)와 같은 규칙으로, 프로젝트 사용본도 휴지통을
/// 경유하므로 복구할 수 있다. 에이전트·플러그인 소유 내장 스킬만 제외한다.
fn collect_shared_delete_targets(
    home: &Path,
    root: &Path,
    projects: &[PathBuf],
    key: &str,
) -> Result<(PathBuf, Vec<ProviderInstall>, Vec<String>), CoreError> {
    let key = validate_skill_key(key)?;
    let directory = root.join(&key);
    assert_within_root(root, &directory)?;
    if !directory.join("SKILL.md").is_file() {
        return Err(CoreError::NotFound(format!(
            "공통 스킬 원본을 찾지 못했습니다: {key}"
        )));
    }
    let mut issues = Vec::new();
    let installs = scan_provider_installs(home, projects, &mut issues);
    let mut targets = Vec::new();
    let warnings = Vec::new();
    for install in installs {
        let name = install
            .directory
            .file_name()
            .map(|value| value.to_string_lossy().into_owned())
            .unwrap_or_default();
        if name != key {
            continue;
        }
        match install.scope {
            "personal" | "project" => targets.push(install),
            // 에이전트·플러그인 소유 스킬은 애초에 관리 대상이 아니다.
            _ => {}
        }
    }
    Ok((directory, targets, warnings))
}

/// 에이전트 위치의 설치본 하나를 확정 삭제한다. 철회가 아니라 "그 에이전트에서는
/// 필요 없음"이며, 실체는 휴지통으로 이동해 복구할 수 있다. 링크 설치본은 링크만
/// 제거하고 공유 원본은 남긴다.
pub fn delete_installed_skill(
    app_data_dir: &Path,
    sessions: &[SessionSummary],
    request: &DeleteInstalledSkillRequest,
) -> Result<SkillDeleteReceipt, CoreError> {
    let roots = SkillRoots::from_app_data(app_data_dir, sessions)?;
    delete_installed_skill_from_paths(&roots, app_data_dir, request)
}

#[cfg(test)]
pub(crate) fn delete_installed_skill_from_home(
    home: &Path,
    app_data_dir: &Path,
    request: &DeleteInstalledSkillRequest,
) -> Result<SkillDeleteReceipt, CoreError> {
    let roots = SkillRoots::from_home(home);
    delete_installed_skill_from_paths(&roots, app_data_dir, request)
}

fn delete_installed_skill_from_paths(
    roots: &SkillRoots,
    app_data_dir: &Path,
    request: &DeleteInstalledSkillRequest,
) -> Result<SkillDeleteReceipt, CoreError> {
    let (home, root, projects) = (roots.home(), roots.root(), roots.projects());
    require_delete_confirm(request.confirm)?;
    let install = find_install_by_id(home, projects, &request.id)?;
    assert_user_deletable_scope(install.scope)?;
    let key = install_key(&install)?;
    let actor = normalized_delete_actor(request.deleted_by.as_deref());
    let group_id = new_trash_group_id();
    let draft = trash_draft_for_install(root, &install, &key, &group_id, &actor);
    let item = store_trash_item(app_data_dir, &install.directory, draft)?;
    Ok(SkillDeleteReceipt {
        key,
        group_id,
        items: vec![item],
        warnings: Vec::new(),
    })
}

/// 공유 스킬을 통째로 삭제한다. 배포본을 먼저, 원본을 마지막에 옮겨 링크가 깨진
/// 채 남지 않게 하고, 전부 한 휴지통 그룹으로 묶어 그룹 단위로 복구한다.
pub fn delete_shared_skill(
    app_data_dir: &Path,
    sessions: &[SessionSummary],
    request: &DeleteSharedSkillRequest,
) -> Result<SkillDeleteReceipt, CoreError> {
    let roots = SkillRoots::from_app_data(app_data_dir, sessions)?;
    delete_shared_skill_from_paths(&roots, app_data_dir, request)
}

#[cfg(test)]
pub(crate) fn delete_shared_skill_from_home(
    home: &Path,
    app_data_dir: &Path,
    request: &DeleteSharedSkillRequest,
) -> Result<SkillDeleteReceipt, CoreError> {
    let roots = SkillRoots::from_home(home);
    delete_shared_skill_from_paths(&roots, app_data_dir, request)
}

fn delete_shared_skill_from_paths(
    roots: &SkillRoots,
    app_data_dir: &Path,
    request: &DeleteSharedSkillRequest,
) -> Result<SkillDeleteReceipt, CoreError> {
    let (home, root, projects) = (roots.home(), roots.root(), roots.projects());
    require_delete_confirm(request.confirm)?;
    let (directory, targets, warnings) =
        collect_shared_delete_targets(home, root, projects, &request.key)?;
    let key = validate_skill_key(&request.key)?;
    let actor = normalized_delete_actor(request.deleted_by.as_deref());
    let group_id = new_trash_group_id();

    let mut items = Vec::new();
    for install in &targets {
        let draft = trash_draft_for_install(root, install, &key, &group_id, &actor);
        items.push(store_trash_item(app_data_dir, &install.directory, draft)?);
    }

    let (kind, link_target) = install_kind(&directory);
    let (name, description) = skill_display_meta(&directory.join("SKILL.md"), &key);
    let (content_digest, file_count, total_bytes) = read_skill_content(&directory)
        .map(|content| {
            (
                Some(content.digest),
                content.file_count,
                content.total_bytes,
            )
        })
        .unwrap_or((None, 0, 0));
    items.push(store_trash_item(
        app_data_dir,
        &directory,
        SkillTrashItemDraft {
            group_id: group_id.clone(),
            key: key.clone(),
            kind,
            link_target,
            provider: None,
            scope: None,
            shared: true,
            deleted_by: actor,
            content_digest,
            file_count,
            total_bytes,
            name,
            description,
        },
    )?);

    // 스킬 자체를 지웠으므로 출처 메타도 함께 정리한다.
    let _ = remove_skill_meta(app_data_dir, &key);

    Ok(SkillDeleteReceipt {
        key,
        group_id,
        items,
        warnings,
    })
}

/// 보관만 취소한다. 에이전트 사용본은 그 자리에 그대로 두고 보관 원본만
/// 휴지통으로 옮기므로, 스킬은 다시 "미보관 사용본"으로 돌아간다. 원본이 없는
/// 사용본은 스스로 동작하므로 삭제와 달리 아무것도 끊기지 않는다.
pub fn unarchive_shared_skill(
    app_data_dir: &Path,
    request: &UnarchiveSharedSkillRequest,
) -> Result<SkillDeleteReceipt, CoreError> {
    unarchive_shared_skill_in(&repository_skills_root(app_data_dir), app_data_dir, request)
}

fn unarchive_shared_skill_in(
    root: &Path,
    app_data_dir: &Path,
    request: &UnarchiveSharedSkillRequest,
) -> Result<SkillDeleteReceipt, CoreError> {
    require_unarchive_confirm(request.confirm)?;
    let key = validate_skill_key(&request.key)?;
    let directory = root.join(&key);
    assert_within_root(root, &directory)?;
    if !directory.join("SKILL.md").is_file() {
        return Err(CoreError::NotFound(format!(
            "공통 스킬 원본을 찾지 못했습니다: {key}"
        )));
    }
    let actor = normalized_delete_actor(request.deleted_by.as_deref());
    let group_id = new_trash_group_id();
    let (kind, link_target) = install_kind(&directory);
    let (name, description) = skill_display_meta(&directory.join("SKILL.md"), &key);
    let (content_digest, file_count, total_bytes) = read_skill_content(&directory)
        .map(|content| {
            (
                Some(content.digest),
                content.file_count,
                content.total_bytes,
            )
        })
        .unwrap_or((None, 0, 0));
    let item = store_trash_item(
        app_data_dir,
        &directory,
        SkillTrashItemDraft {
            group_id: group_id.clone(),
            key: key.clone(),
            kind,
            link_target,
            provider: None,
            scope: None,
            shared: true,
            deleted_by: actor,
            content_digest,
            file_count,
            total_bytes,
            name,
            description,
        },
    )?;

    // 원본이 사라졌으므로 출처·자동 동기화 같은 원본 전제 메타도 함께 정리한다.
    let _ = remove_skill_meta(app_data_dir, &key);

    Ok(SkillDeleteReceipt {
        key,
        group_id,
        items: vec![item],
        warnings: Vec::new(),
    })
}

// ---------------------------------------------------------------------------
// 동기화·편집
// ---------------------------------------------------------------------------

/// 키의 현재 사용본 전체에 원본을 재배포한다. 원본과 같은 실체(링크)와 skip
/// 목록의 실체는 건너뛴다. 위치(루트)당 한 번만 게시한다.
fn republish_to_installs(
    home: &Path,
    projects: &[PathBuf],
    key: &str,
    source_directory: &Path,
    content: &SkillContent,
    skip_canonicals: &[PathBuf],
) -> Vec<SkillPublishResult> {
    let mut issues = Vec::new();
    let installs = scan_provider_installs(home, projects, &mut issues);
    let mut results = Vec::new();
    let mut seen_roots: BTreeSet<PathBuf> = BTreeSet::new();
    for install in installs {
        let name = install
            .directory
            .file_name()
            .map(|value| value.to_string_lossy().into_owned())
            .unwrap_or_default();
        if name != key || !matches!(install.scope, "personal" | "project") {
            continue;
        }
        if let Some(canonical) = install.canonical.as_ref() {
            if skip_canonicals.iter().any(|skip| skip == canonical) {
                continue;
            }
        }
        let Some(root) = install.directory.parent().map(Path::to_path_buf) else {
            continue;
        };
        if !seen_roots.insert(root.clone()) {
            continue;
        }
        let directory = install.directory.to_string_lossy().into_owned();
        match publish_to_root(install.provider, &root, key, source_directory, content) {
            Ok(outcome) => results.push(SkillPublishResult {
                provider: install.provider,
                outcome,
                directory: Some(directory),
                message: None,
            }),
            Err(error) => results.push(SkillPublishResult {
                provider: install.provider,
                outcome: SkillPublishOutcome::Failed,
                directory: Some(directory),
                message: Some(error.to_string()),
            }),
        }
    }
    results
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncSkillRequest {
    /// 새 원본으로 채택할 설치본의 `SkillSummary.id`.
    pub skill_id: String,
    #[serde(default)]
    pub deleted_by: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillSyncReceipt {
    pub key: String,
    /// 채택한 설치본 디렉터리.
    pub adopted_from: String,
    /// 교체 전 원본이 이동한 휴지통 항목 ID.
    pub previous_source_trash_id: Option<String>,
    /// 나머지 사용 위치 재배포 결과.
    pub results: Vec<SkillPublishResult>,
}

/// 외부에서 수정된 설치본을 새 보관 원본으로 채택하고, 나머지 모든 사용 위치에
/// 재배포한다. 교체되는 이전 원본은 휴지통으로 옮겨 복구할 수 있다.
pub fn sync_skill_from_install(
    app_data_dir: &Path,
    sessions: &[SessionSummary],
    request: &SyncSkillRequest,
) -> Result<SkillSyncReceipt, CoreError> {
    let roots = SkillRoots::from_app_data(app_data_dir, sessions)?;
    sync_skill_from_install_from_paths(&roots, app_data_dir, request)
}

#[cfg(test)]
pub(crate) fn sync_skill_from_install_from_home(
    home: &Path,
    app_data_dir: &Path,
    request: &SyncSkillRequest,
) -> Result<SkillSyncReceipt, CoreError> {
    let roots = SkillRoots::from_home(home);
    sync_skill_from_install_from_paths(&roots, app_data_dir, request)
}

fn sync_skill_from_install_from_paths(
    roots: &SkillRoots,
    app_data_dir: &Path,
    request: &SyncSkillRequest,
) -> Result<SkillSyncReceipt, CoreError> {
    let (home, root, projects) = (roots.home(), roots.root(), roots.projects());
    let install = find_install_by_id(home, projects, &request.skill_id)?;
    assert_user_deletable_scope(install.scope)?;
    let key = install_key(&install)?;
    let source_dir = root.join(&key);
    assert_within_root(root, &source_dir)?;
    if !source_dir.join("SKILL.md").is_file() {
        return Err(CoreError::NotFound(format!("보관 원본이 없습니다: {key}")));
    }

    let content = read_skill_content(&install.directory)?;
    if content.truncated {
        return Err(CoreError::InvalidInput(format!(
            "스킬 구성 파일이 {MAX_SKILL_FILES}개를 넘습니다"
        )));
    }
    if content.total_bytes > MAX_SKILL_TOTAL_BYTES {
        return Err(CoreError::InvalidInput(format!(
            "스킬 전체 크기가 허용 한도({}MB)를 넘습니다",
            MAX_SKILL_TOTAL_BYTES / (1024 * 1024)
        )));
    }
    if let Some(link) = content.symlinks.first() {
        return Err(CoreError::InvalidInput(format!(
            "심볼릭 링크가 있어 원본으로 채택할 수 없습니다: {link}"
        )));
    }

    // 이전 원본을 휴지통으로 옮긴다. 실패해도 복구할 수 있는 안전망이다.
    let actor = normalized_delete_actor(request.deleted_by.as_deref());
    let (kind, link_target) = install_kind(&source_dir);
    let (name, description) = skill_display_meta(&source_dir.join("SKILL.md"), &key);
    let (old_digest, old_count, old_bytes) = read_skill_content(&source_dir)
        .map(|old| (Some(old.digest), old.file_count, old.total_bytes))
        .unwrap_or((None, 0, 0));
    let trash_item = store_trash_item(
        app_data_dir,
        &source_dir,
        SkillTrashItemDraft {
            group_id: new_trash_group_id(),
            key: key.clone(),
            kind,
            link_target,
            provider: None,
            scope: None,
            shared: true,
            deleted_by: actor,
            content_digest: old_digest,
            file_count: old_count,
            total_bytes: old_bytes,
            name,
            description,
        },
    )?;

    // 채택본을 스테이징으로 복사한 뒤 원본 자리에 넣는다. 실패하면 휴지통에서
    // 이전 원본을 되살린다.
    let nonce = publish_nonce();
    let stage = root.join(format!("{STAGE_PREFIX}{key}-{nonce}"));
    assert_within_root(root, &stage)?;
    let staged = stage_skill_copy(
        adapter(install.provider),
        &install.directory,
        &stage,
        &content,
    )
    .and_then(|_| {
        StagedReplace {
            kind: StagedKind::Directory,
            stage: &stage,
            target: &source_dir,
            backup: None,
        }
        .commit()
    });
    if let Err(error) = staged {
        let _ = fs::remove_dir_all(&stage);
        let _ = crate::skill_trash::restore_skill_trash(app_data_dir, &trash_item.id);
        return Err(error);
    }

    // 채택본 자신과 원본(및 원본을 보는 링크)은 건너뛰고 나머지에 재배포한다.
    let mut skip: Vec<PathBuf> = Vec::new();
    if let Ok(canonical) = fs::canonicalize(&source_dir) {
        skip.push(canonical);
    }
    if let Some(canonical) = install.canonical.clone() {
        skip.push(canonical);
    }
    let new_content = read_skill_content(&source_dir)?;
    let results = republish_to_installs(home, projects, &key, &source_dir, &new_content, &skip);

    Ok(SkillSyncReceipt {
        key,
        adopted_from: install.directory.to_string_lossy().into_owned(),
        previous_source_trash_id: Some(trash_item.id),
        results,
    })
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillFileWrite {
    pub path: String,
    pub content: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCommonSkillRequest {
    pub key: String,
    #[serde(default)]
    pub files: Vec<SkillFileWrite>,
    #[serde(default)]
    pub deletes: Vec<String>,
    /// 낙관적 잠금. 현재 원본 내용 지문과 다르면 실패한다.
    pub expected_digest: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillUpdateReceipt {
    pub key: String,
    pub content_digest: String,
    /// 저장 직후 모든 사용 위치 재배포 결과.
    pub results: Vec<SkillPublishResult>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillMigrationPlan {
    pub key: String,
    pub source_platforms: Vec<HostPlatform>,
    pub target_platform: HostPlatform,
    pub source_digest: String,
    pub files: Vec<String>,
    pub variant_directory: String,
    pub automatic_execution: bool,
    pub aia_prompt: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveSkillPlatformVariantRequest {
    pub key: String,
    pub target_platform: HostPlatform,
    #[serde(default)]
    pub source_platform: Option<HostPlatform>,
    pub files: Vec<SkillFileWrite>,
    #[serde(default)]
    pub deletes: Vec<String>,
    pub expected_digest: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetSkillPlatformsRequest {
    pub key: String,
    #[serde(default)]
    pub platforms: Vec<HostPlatform>,
    pub expected_digest: String,
}

pub fn get_skill_migration_plan(
    app_data_dir: &Path,
    key: &str,
    target_platform: HostPlatform,
) -> Result<SkillMigrationPlan, CoreError> {
    let key = validate_skill_key(key)?;
    let root = repository_skills_root(app_data_dir);
    let directory = root.join(&key);
    assert_within_root(&root, &directory)?;
    let (source, content) = read_common_source(&directory, &key)?;
    let manifest = checked_resource_manifest(&directory)?;
    let files = content
        .files
        .iter()
        .filter(|file| !file.relative.starts_with(".agent-manager"))
        .map(|file| file.relative.to_string_lossy().into_owned())
        .collect::<Vec<_>>();
    let variant_directory = format!(".agent-manager/variants/{target_platform}");
    Ok(SkillMigrationPlan {
        key: key.clone(),
        source_platforms: manifest.platforms,
        target_platform,
        source_digest: source.content_digest,
        files: files.clone(),
        variant_directory: variant_directory.clone(),
        automatic_execution: false,
        aia_prompt: format!(
            "'{key}' 스킬을 {target_platform}용으로 마이그레이션하세요. get_skill_migration_plan의 파일 목록({})을 확인하고 필요한 원문은 read_common_skill_file로 읽으세요. 변경 파일은 {variant_directory}/ overlay로, 대상 OS에서 제거할 base 파일·디렉터리는 deletes로 지정해 save_skill_platform_variant를 호출하세요. SKILL.md는 제거할 수 없습니다. 생성한 스크립트는 자동 실행하지 말고 정적 검토 결과를 함께 설명하세요.",
            files.join(", ")
        ),
    })
}

pub fn save_skill_platform_variant(
    app_data_dir: &Path,
    sessions: &[SessionSummary],
    request: &SaveSkillPlatformVariantRequest,
) -> Result<SkillUpdateReceipt, CoreError> {
    if request.files.is_empty() && request.deletes.is_empty() {
        return Err(CoreError::InvalidInput(
            "OS 변형 파일 또는 제외 경로를 하나 이상 제공하세요".to_owned(),
        ));
    }
    let key = validate_skill_key(&request.key)?;
    let roots = SkillRoots::from_app_data(app_data_dir, sessions)?;
    let root = roots.root();
    let directory = root.join(&key);
    assert_within_root(root, &directory)?;
    let mut manifest = checked_resource_manifest(&directory)?;
    if manifest.platforms.is_empty() {
        manifest.platforms.push(
            request
                .source_platform
                .unwrap_or_else(HostPlatform::current),
        );
    }
    let variant_directory = format!(".agent-manager/variants/{}", request.target_platform);
    manifest
        .variants
        .insert(request.target_platform, variant_directory.clone());
    let mut deletes = BTreeSet::new();
    for path in &request.deletes {
        let relative = Path::new(path);
        validate_variant_delete_path(relative)?;
        if !deletes.insert(path.clone()) {
            continue;
        }
    }
    if deletes.is_empty() {
        manifest.variant_deletes.remove(&request.target_platform);
    } else {
        manifest
            .variant_deletes
            .insert(request.target_platform, deletes.into_iter().collect());
    }
    manifest.schema_version = 1;

    let mut files = Vec::with_capacity(request.files.len() + 1);
    for file in &request.files {
        let relative = Path::new(&file.path);
        validate_relative_path(relative)?;
        if relative.starts_with(".agent-manager") {
            return Err(CoreError::InvalidInput(
                "변형 파일 경로에는 .agent-manager를 직접 지정하지 마세요".to_owned(),
            ));
        }
        files.push(SkillFileWrite {
            path: Path::new(&variant_directory)
                .join(relative)
                .to_string_lossy()
                .into_owned(),
            content: file.content.clone(),
        });
    }
    files.push(SkillFileWrite {
        path: ".agent-manager/resource.json".to_owned(),
        content: format!("{}\n", serde_json::to_string_pretty(&manifest)?),
    });
    update_common_skill_from_paths(
        &roots,
        true,
        &UpdateCommonSkillRequest {
            key,
            files,
            deletes: Vec::new(),
            expected_digest: request.expected_digest.clone(),
        },
    )
}

pub fn set_skill_platforms(
    app_data_dir: &Path,
    sessions: &[SessionSummary],
    request: &SetSkillPlatformsRequest,
) -> Result<SkillUpdateReceipt, CoreError> {
    let key = validate_skill_key(&request.key)?;
    let roots = SkillRoots::from_app_data(app_data_dir, sessions)?;
    let root = roots.root();
    let directory = root.join(&key);
    assert_within_root(root, &directory)?;
    let mut manifest = checked_resource_manifest(&directory)?;
    manifest.platforms = request
        .platforms
        .iter()
        .copied()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    manifest.schema_version = 1;
    update_common_skill_from_paths(
        &roots,
        true,
        &UpdateCommonSkillRequest {
            key,
            files: vec![SkillFileWrite {
                path: ".agent-manager/resource.json".to_owned(),
                content: format!("{}\n", serde_json::to_string_pretty(&manifest)?),
            }],
            deletes: Vec::new(),
            expected_digest: request.expected_digest.clone(),
        },
    )
}

/// 보관 원본을 편집한다. 스테이징에 변경을 적용해 검증한 뒤 원자 교체하고,
/// 현재 사용 중인 모든 위치에 즉시 재배포한다.
pub fn update_common_skill(
    app_data_dir: &Path,
    sessions: &[SessionSummary],
    request: &UpdateCommonSkillRequest,
) -> Result<SkillUpdateReceipt, CoreError> {
    let roots = SkillRoots::from_app_data(app_data_dir, sessions)?;
    update_common_skill_from_paths(&roots, false, request)
}

#[cfg(test)]
pub(crate) fn update_common_skill_from_home(
    home: &Path,
    request: &UpdateCommonSkillRequest,
) -> Result<SkillUpdateReceipt, CoreError> {
    let roots = SkillRoots::from_home(home);
    update_common_skill_from_paths(&roots, false, request)
}

fn update_common_skill_from_paths(
    roots: &SkillRoots,
    allow_resource_metadata: bool,
    request: &UpdateCommonSkillRequest,
) -> Result<SkillUpdateReceipt, CoreError> {
    let (home, root, projects) = (roots.home(), roots.root(), roots.projects());
    let key = validate_skill_key(&request.key)?;
    if request.files.is_empty() && request.deletes.is_empty() {
        return Err(CoreError::InvalidInput("변경 내용이 없습니다".to_owned()));
    }
    let source_dir = root.join(&key);
    assert_within_root(root, &source_dir)?;
    if !source_dir.join("SKILL.md").is_file() {
        return Err(CoreError::NotFound(format!(
            "보관 원본을 찾지 못했습니다: {key}"
        )));
    }
    let current = read_skill_content(&source_dir)?;
    if current.digest != request.expected_digest {
        return Err(CoreError::Conflict(
            "원본이 다른 곳에서 수정되었습니다. 새로고침 후 다시 편집하세요".to_owned(),
        ));
    }

    // 스테이징에 현재 원본을 복사하고 변경을 적용한다. 투영 없이 원문 그대로
    // 복사하기 위해 전용 키가 없는 Claude 어댑터를 쓴다.
    let nonce = publish_nonce();
    let stage = root.join(format!("{STAGE_PREFIX}{key}-{nonce}"));
    assert_within_root(root, &stage)?;
    let applied = (|| -> Result<SkillContent, CoreError> {
        stage_raw_skill_copy(&source_dir, &stage, &current)?;
        for path in &request.deletes {
            let relative = Path::new(path);
            validate_relative_path(relative)?;
            if !allow_resource_metadata && relative.starts_with(".agent-manager") {
                return Err(CoreError::InvalidInput(
                    "OS 메타데이터와 변형은 전용 작업으로만 변경할 수 있습니다".to_owned(),
                ));
            }
            if relative == Path::new("SKILL.md") {
                return Err(CoreError::InvalidInput(
                    "SKILL.md는 삭제할 수 없습니다".to_owned(),
                ));
            }
            let target = stage.join(relative);
            assert_within_root(&stage, &target)?;
            match fs::symlink_metadata(&target) {
                Ok(metadata) if metadata.is_dir() => fs::remove_dir_all(&target)?,
                Ok(_) => fs::remove_file(&target)?,
                Err(_) => {}
            }
        }
        for file in &request.files {
            let relative = Path::new(&file.path);
            validate_relative_path(relative)?;
            if !allow_resource_metadata && relative.starts_with(".agent-manager") {
                return Err(CoreError::InvalidInput(
                    "OS 메타데이터와 변형은 전용 작업으로만 변경할 수 있습니다".to_owned(),
                ));
            }
            let target = stage.join(relative);
            assert_within_root(&stage, &target)?;
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::write(&target, &file.content)?;
        }
        let result = read_skill_content(&stage)?;
        checked_resource_manifest(&stage)?;
        if !stage.join("SKILL.md").is_file() {
            return Err(CoreError::InvalidInput(
                "SKILL.md가 없는 스킬은 저장할 수 없습니다".to_owned(),
            ));
        }
        if result.truncated {
            return Err(CoreError::InvalidInput(format!(
                "스킬 구성 파일이 {MAX_SKILL_FILES}개를 넘습니다"
            )));
        }
        if result.total_bytes > MAX_SKILL_TOTAL_BYTES {
            return Err(CoreError::InvalidInput(format!(
                "스킬 전체 크기가 허용 한도({}MB)를 넘습니다",
                MAX_SKILL_TOTAL_BYTES / (1024 * 1024)
            )));
        }
        if let Some(link) = result.symlinks.first() {
            return Err(CoreError::InvalidInput(format!(
                "심볼릭 링크는 저장할 수 없습니다: {link}"
            )));
        }
        Ok(result)
    })();
    let result_content = match applied {
        Ok(value) => value,
        Err(error) => {
            let _ = fs::remove_dir_all(&stage);
            return Err(error);
        }
    };

    // 원자 교체: 기존 원본을 백업으로 옮기고 스테이징을 자리에 넣는다.
    let backup = root.join(format!("{BACKUP_PREFIX}{key}-{nonce}"));
    StagedReplace {
        kind: StagedKind::Directory,
        stage: &stage,
        target: &source_dir,
        backup: Some(&backup),
    }
    .commit()?;
    remove_published_backup(&backup);

    // 저장 즉시 모든 사용 위치에 재배포한다. 원본을 링크로 보는 설치본은 이미
    // 새 내용을 보므로 건너뛴다.
    let mut skip: Vec<PathBuf> = Vec::new();
    if let Ok(canonical) = fs::canonicalize(&source_dir) {
        skip.push(canonical);
    }
    let results = republish_to_installs(home, projects, &key, &source_dir, &result_content, &skip);

    Ok(SkillUpdateReceipt {
        key,
        content_digest: result_content.digest,
        results,
    })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillFileContent {
    pub key: String,
    pub path: String,
    pub content: String,
}

/// 보관 원본의 구성 파일 하나를 읽는다. 편집기 열람용 읽기 작업이다.
pub fn read_common_skill_file(
    app_data_dir: &Path,
    key: &str,
    path: &str,
) -> Result<SkillFileContent, CoreError> {
    let key = validate_skill_key(key)?;
    let root = repository_skills_root(app_data_dir);
    let directory = root.join(&key);
    assert_within_root(&root, &directory)?;
    let relative = Path::new(path);
    validate_relative_path(relative)?;
    let target = directory.join(relative);
    assert_within_root(&directory, &target)?;
    let content = read_text_limited(&target, MAX_SKILL_MD_BYTES)?;
    Ok(SkillFileContent {
        key,
        path: path.to_owned(),
        content,
    })
}

// ---------------------------------------------------------------------------
// 설치본 비교
// ---------------------------------------------------------------------------

/// 파일별 비교 본문 상한. 이보다 크면 본문 없이 `too_large`만 알린다.
const MAX_DIFF_TEXT_BYTES: usize = 512 * 1024;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompareSkillRequest {
    /// 비교할 설치본의 `SkillSummary.id`.
    pub skill_id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SkillFileChangeStatus {
    /// 설치본에만 있다.
    Added,
    /// 보관 원본에만 있다.
    Removed,
    /// 양쪽에 있지만 내용이나 실행 권한이 다르다.
    Modified,
}

impl SkillFileChangeStatus {
    pub const ALL: [Self; 3] = [Self::Added, Self::Removed, Self::Modified];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Added => "added",
            Self::Removed => "removed",
            Self::Modified => "modified",
        }
    }

    /// 추가 상태인지 여부.
    pub fn is_added(self) -> bool {
        matches!(self, Self::Added)
    }

    /// 삭제 상태인지 여부.
    pub fn is_removed(self) -> bool {
        matches!(self, Self::Removed)
    }

    /// 수정 상태인지 여부.
    pub fn is_modified(self) -> bool {
        matches!(self, Self::Modified)
    }
}

impl std::fmt::Display for SkillFileChangeStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

impl std::str::FromStr for SkillFileChangeStatus {
    type Err = CoreError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.trim() {
            "added" => Ok(Self::Added),
            "removed" => Ok(Self::Removed),
            "modified" => Ok(Self::Modified),
            _ => Err(CoreError::InvalidInput(format!(
                "알 수 없는 스킬 파일 변경 상태입니다: {s}. added|removed|modified 중 하나를 쓰세요"
            ))),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillFileChange {
    pub path: String,
    pub status: SkillFileChangeStatus,
    pub executable_changed: bool,
    /// 어느 한쪽이 UTF-8 텍스트가 아니어서 본문을 싣지 않았다.
    pub binary: bool,
    /// 어느 한쪽이 `MAX_DIFF_TEXT_BYTES`를 넘어 본문을 싣지 않았다.
    pub too_large: bool,
    /// 보관 원본 쪽 본문. SKILL.md는 공급자 투영을 거친 형태다.
    pub source: Option<String>,
    /// 설치본 쪽 본문.
    pub install: Option<String>,
}

/// 보관 원본(공급자 투영 적용)과 설치본 하나의 파일별 차이.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillInstallComparison {
    pub key: String,
    pub skill_id: String,
    pub provider: ProviderId,
    pub directory: String,
    pub source_directory: String,
    /// 바뀐 파일만. 같은 파일은 `unchanged_count`로만 센다.
    pub files: Vec<SkillFileChange>,
    pub unchanged_count: usize,
    /// 설치본 안의 심볼릭 링크. 비교에서는 제외되고 동기화 때 거절된다.
    pub symlinks: Vec<String>,
    /// 설치본 파일 수가 상한을 넘어 일부만 비교했다.
    pub truncated: bool,
}

/// 외부 수정이 감지된 설치본이 보관 원본과 어떻게 다른지 파일 단위로 읽는다.
/// 지문 판정(`projected_skill_digest`)과 같은 투영 규칙을 써서 frontmatter 재작성이
/// 차이로 보이지 않게 한다. 읽기 작업이다.
pub fn compare_skill_install(
    app_data_dir: &Path,
    sessions: &[SessionSummary],
    request: &CompareSkillRequest,
) -> Result<SkillInstallComparison, CoreError> {
    let roots = SkillRoots::from_app_data(app_data_dir, sessions)?;
    compare_skill_install_from_paths(&roots, request)
}

#[cfg(test)]
pub(crate) fn compare_skill_install_from_home(
    home: &Path,
    request: &CompareSkillRequest,
) -> Result<SkillInstallComparison, CoreError> {
    let roots = SkillRoots::from_home(home);
    compare_skill_install_from_paths(&roots, request)
}

fn compare_skill_install_from_paths(
    roots: &SkillRoots,
    request: &CompareSkillRequest,
) -> Result<SkillInstallComparison, CoreError> {
    let (home, root, projects) = (roots.home(), roots.root(), roots.projects());
    let install = find_install_by_id(home, projects, &request.skill_id)?;
    let key = install_key(&install)?;
    let source_dir = root.join(&key);
    assert_within_root(root, &source_dir)?;
    if !source_dir.join("SKILL.md").is_file() {
        return Err(CoreError::NotFound(format!("보관 원본이 없습니다: {key}")));
    }
    if let (Ok(left), Some(right)) = (fs::canonicalize(&source_dir), install.canonical.as_ref()) {
        if &left == right {
            return Err(CoreError::InvalidInput(
                "설치본이 보관 원본을 그대로 가리키고 있어 비교할 차이가 없습니다".to_owned(),
            ));
        }
    }

    let platform = HostPlatform::current();
    let source_content = read_skill_content(&source_dir)?;
    let manifest = checked_resource_manifest(&source_dir)?;
    if manifest.migration_required(platform) {
        return Err(CoreError::InvalidInput(
            "현재 OS용 스킬이 없습니다".to_owned(),
        ));
    }
    let projected = projected_skill_files(&source_dir, &source_content, &manifest, platform)?;
    let install_content = read_skill_content(&install.directory)?;
    let skill_adapter = adapter(install.provider);

    let install_files: BTreeMap<&Path, &SkillFileEntry> = install_content
        .files
        .iter()
        .map(|entry| (entry.relative.as_path(), entry))
        .collect();
    let paths: BTreeSet<&Path> = projected
        .keys()
        .map(PathBuf::as_path)
        .chain(install_files.keys().copied())
        .collect();

    let mut files = Vec::new();
    let mut unchanged_count = 0;
    for path in paths {
        let source_side = projected
            .get(path)
            .map(|file| -> Result<(Vec<u8>, bool), CoreError> {
                let bytes = if path == Path::new("SKILL.md") {
                    skill_adapter
                        .project_skill_md(&read_text_limited(&file.source, MAX_SKILL_MD_BYTES)?)
                        .into_bytes()
                } else {
                    fs::read(&file.source)?
                };
                Ok((bytes, file.executable))
            })
            .transpose()?;
        let install_side = install_files
            .get(path)
            .map(|entry| -> Result<(Vec<u8>, bool), CoreError> {
                Ok((fs::read(install.directory.join(path))?, entry.executable))
            })
            .transpose()?;
        let relative = path.to_string_lossy().replace('\\', "/");
        match (source_side, install_side) {
            (Some((source, source_exec)), Some((target, target_exec))) => {
                if source == target && source_exec == target_exec {
                    unchanged_count += 1;
                    continue;
                }
                files.push(file_change(
                    relative,
                    SkillFileChangeStatus::Modified,
                    source_exec != target_exec,
                    Some(source),
                    Some(target),
                ));
            }
            (Some((source, _)), None) => files.push(file_change(
                relative,
                SkillFileChangeStatus::Removed,
                false,
                Some(source),
                None,
            )),
            (None, Some((target, _))) => files.push(file_change(
                relative,
                SkillFileChangeStatus::Added,
                false,
                None,
                Some(target),
            )),
            (None, None) => {}
        }
    }

    Ok(SkillInstallComparison {
        key,
        skill_id: install.skill_id.clone(),
        provider: install.provider,
        directory: install.directory.to_string_lossy().into_owned(),
        source_directory: source_dir.to_string_lossy().into_owned(),
        files,
        unchanged_count,
        symlinks: install_content.symlinks,
        truncated: install_content.truncated,
    })
}

/// 양쪽 바이트를 표시용 텍스트로 바꾼다. 한쪽이라도 상한을 넘거나 UTF-8이 아니면
/// 본문을 모두 비워 반쪽짜리 비교가 되지 않게 한다.
fn file_change(
    path: String,
    status: SkillFileChangeStatus,
    executable_changed: bool,
    source: Option<Vec<u8>>,
    install: Option<Vec<u8>>,
) -> SkillFileChange {
    let too_large = source
        .iter()
        .chain(install.iter())
        .any(|bytes| bytes.len() > MAX_DIFF_TEXT_BYTES);
    let decoded = if too_large {
        None
    } else {
        match (
            source.map(String::from_utf8).transpose(),
            install.map(String::from_utf8).transpose(),
        ) {
            (Ok(source), Ok(install)) => Some((source, install)),
            _ => None,
        }
    };
    let binary = !too_large && decoded.is_none();
    let (source, install) = decoded.unwrap_or((None, None));
    SkillFileChange {
        path,
        status,
        executable_changed,
        binary,
        too_large,
        source,
        install,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn write_skill(directory: &Path, name: &str, description: &str) {
        fs::create_dir_all(directory).expect("create skill dir");
        fs::write(
            directory.join("SKILL.md"),
            format!("---\nname: {name}\ndescription: {description}\n---\nBody\n"),
        )
        .expect("write SKILL.md");
    }

    fn common_dir(home: &Path, key: &str) -> PathBuf {
        home.join(LEGACY_COMMON_ROOT_RELATIVE).join(key)
    }

    /// `installable_root`는 전체 루트 목록을 만들지 않고 개인 루트만 만든다.
    /// 그 지름길이 성립하려면 개인 루트가 유일한 설치 가능 루트여야 한다.
    #[test]
    fn adapter_installable_root_is_the_only_installable_root() {
        let temp = TempDir::new().expect("temp");
        let home = temp.path();
        let project = temp.path().join("project");
        fs::create_dir_all(&project).expect("project dir");
        let projects = vec![project.clone()];

        for adapter in ADAPTERS {
            let installable: Vec<PathBuf> = adapter
                .roots(home, &projects)
                .into_iter()
                .filter(|root| root.installable)
                .map(|root| root.path)
                .collect();
            assert_eq!(
                installable,
                vec![home.join(adapter.personal_root_relative)],
                "{} 설치 가능 루트",
                adapter.provider
            );
            assert_eq!(
                adapter.installable_root(home),
                installable.first().cloned(),
                "{} installable_root",
                adapter.provider
            );
        }
    }

    /// 프로젝트 루트는 등록 프로젝트마다 하나씩, 공급자별 상대 경로로 붙는다.
    /// 위치 지정 게시 대상(`resolve_install_root`)도 같은 경로를 써야 한다.
    #[test]
    fn adapter_project_roots_match_resolved_install_root() {
        let temp = TempDir::new().expect("temp");
        let home = temp.path();
        let project = temp.path().join("project");
        fs::create_dir_all(&project).expect("project dir");
        let projects = vec![project.clone()];
        let location = SkillLocation {
            scope: Some("project".to_owned()),
            project_path: Some(project.to_string_lossy().into_owned()),
        };

        for adapter in ADAPTERS {
            let project_roots: Vec<PathBuf> = adapter
                .roots(home, &projects)
                .into_iter()
                .filter(|root| root.scope == "project")
                .map(|root| root.path)
                .collect();
            let expected = project.join(adapter.project_root_relative);
            assert_eq!(
                project_roots,
                vec![expected.clone()],
                "{} 프로젝트 루트",
                adapter.provider
            );
            let resolved = resolve_install_root(home, &projects, adapter.provider, &location)
                .expect("resolve install root");
            assert_eq!(
                resolved,
                Some(expected),
                "{} 위치 지정 게시 루트",
                adapter.provider
            );
        }
    }

    #[test]
    fn display_file_name_normalizes_decomposed_hangul() {
        // macOS 파일시스템이 저장하는 NFD 이름을 NFC로 되돌려야 한다.
        let decomposed: String = "드림라인".nfd().collect();
        assert_ne!(decomposed, "드림라인");
        assert_eq!(
            display_file_name(Path::new(&decomposed)).as_deref(),
            Some("드림라인")
        );
    }

    /// AIA 즉시 트리거는 이 축약 조회의 지문 변화만 보고 변경을 감지하므로,
    /// 표시 이름과 지문이 내용에 따라 실제로 달라져야 한다.
    #[test]
    fn common_skill_digests_track_content_changes_and_skip_incomplete_directories() {
        let temp = TempDir::new().expect("temp");
        let home = temp.path();
        write_skill(&common_dir(home, "review"), "review", "검토 스킬");
        // SKILL.md가 없는 디렉터리는 스킬 원본이 아니라 목록에 넣지 않는다.
        fs::create_dir_all(common_dir(home, "empty")).expect("empty dir");

        let first = common_skill_digests_from_home(home);
        assert_eq!(first.len(), 1);
        assert_eq!(first[0].key, "review");
        assert_eq!(first[0].name, "review");

        fs::write(
            common_dir(home, "review").join("references.md"),
            "추가 문서",
        )
        .expect("extra file");
        let second = common_skill_digests_from_home(home);
        assert_eq!(second.len(), 1);
        assert_ne!(first[0].content_digest, second[0].content_digest);

        write_skill(&common_dir(home, "review"), "review", "검토 스킬");
        let third = common_skill_digests_from_home(home);
        assert_eq!(third[0].content_digest, second[0].content_digest);
    }

    #[test]
    fn skill_key_validation_blocks_traversal_and_reserved_names() {
        assert_eq!(validate_skill_key(" review ").expect("valid"), "review");
        assert!(validate_skill_key("../escape").is_err());
        assert!(validate_skill_key("a/b").is_err());
        assert!(validate_skill_key(".hidden").is_err());
        assert!(validate_skill_key("Upper").is_err());
        assert!(validate_skill_key("trailing-").is_err());
        assert!(validate_skill_key("con").is_err());
        assert!(validate_skill_key("").is_err());
    }

    #[test]
    fn relative_path_validation_rejects_escapes() {
        assert!(validate_relative_path(Path::new("references/a.md")).is_ok());
        assert!(validate_relative_path(Path::new("../a.md")).is_err());
        assert!(validate_relative_path(Path::new("a/../../b")).is_err());
        assert!(validate_relative_path(Path::new("/etc/passwd")).is_err());
    }

    #[test]
    fn frontmatter_projection_removes_only_target_provider_foreign_keys() {
        let text = concat!(
            "---\n",
            "name: demo\n",
            "allowed-tools: Read, Grep\n",
            "metadata:\n",
            "  author: someone\n",
            "description: >-\n",
            "  multi line\n",
            "  description\n",
            "---\n",
            "Body\n"
        );
        let claude = adapter(ProviderId::Claude).project_skill_md(text);
        assert!(claude.contains("allowed-tools"));

        let codex = adapter(ProviderId::Codex).project_skill_md(text);
        assert!(!codex.contains("allowed-tools"));
        // 공통 키와 중첩 매핑, 여러 줄 값은 모두 그대로 남는다.
        assert!(codex.contains("name: demo"));
        assert!(codex.contains("author: someone"));
        assert!(codex.contains("multi line"));
        assert!(codex.contains("Body"));
    }

    #[test]
    fn library_reports_linked_copy_and_missing_states_for_all_providers() {
        let temp = TempDir::new().expect("temp");
        let home = temp.path();
        write_skill(&common_dir(home, "shared"), "shared", "Shared skill");
        // Codex는 내용이 같은 사본, Claude는 없음.
        write_skill(&home.join(".codex/skills/shared"), "shared", "Shared skill");
        // Antigravity도 공식 개인 스킬 루트가 비어 있어 missing으로 보인다.
        let library =
            load_skill_library_from_home(home, &SkillMetaStore::default()).expect("library");

        let entry = library
            .entries
            .iter()
            .find(|entry| entry.key == "shared")
            .expect("entry");
        assert_eq!(entry.origin_kind, SkillOriginKind::Common);
        assert!(entry.managed);

        let codex = entry
            .providers
            .iter()
            .find(|state| state.provider == ProviderId::Codex)
            .expect("codex state");
        assert_eq!(codex.status, SkillProviderStatus::Copy);
        assert!(!codex.divergent, "같은 내용이면 갈라지지 않는다");

        let claude = entry
            .providers
            .iter()
            .find(|state| state.provider == ProviderId::Claude)
            .expect("claude state");
        assert_eq!(claude.status, SkillProviderStatus::Missing);
        assert!(claude.target_directory.is_some());

        let antigravity = entry
            .providers
            .iter()
            .find(|state| state.provider == ProviderId::Antigravity)
            .expect("antigravity state");
        assert_eq!(antigravity.status, SkillProviderStatus::Missing);
        assert!(!antigravity.read_only);
        assert!(antigravity.target_directory.is_some());
        assert!(antigravity.note.is_some());
    }

    #[test]
    fn divergent_provider_copy_is_detected() {
        let temp = TempDir::new().expect("temp");
        let home = temp.path();
        write_skill(&common_dir(home, "review"), "review", "Original");
        write_skill(&home.join(".codex/skills/review"), "review", "Edited copy");

        let library =
            load_skill_library_from_home(home, &SkillMetaStore::default()).expect("library");
        let entry = library
            .entries
            .iter()
            .find(|entry| entry.key == "review")
            .expect("entry");
        let codex = entry
            .providers
            .iter()
            .find(|state| state.provider == ProviderId::Codex)
            .expect("codex");
        assert_eq!(codex.status, SkillProviderStatus::Copy);
        assert!(codex.divergent);
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_install_is_reported_as_linked() {
        let temp = TempDir::new().expect("temp");
        let home = temp.path();
        let source = common_dir(home, "linked");
        write_skill(&source, "linked", "Linked skill");
        let root = home.join(".claude/skills");
        fs::create_dir_all(&root).expect("claude root");
        std::os::unix::fs::symlink(&source, root.join("linked")).expect("symlink");

        let library =
            load_skill_library_from_home(home, &SkillMetaStore::default()).expect("library");
        let entry = library
            .entries
            .iter()
            .find(|entry| entry.key == "linked")
            .expect("entry");
        let claude = entry
            .providers
            .iter()
            .find(|state| state.provider == ProviderId::Claude)
            .expect("claude");
        assert_eq!(claude.status, SkillProviderStatus::Linked);
        assert!(!claude.divergent, "링크는 항상 원본과 같다");
    }

    #[test]
    fn publish_creates_copy_and_reuses_common_content() {
        let temp = TempDir::new().expect("temp");
        let home = temp.path();
        let source = common_dir(home, "deploy");
        write_skill(&source, "deploy", "Deploy skill");
        fs::create_dir_all(source.join("references")).expect("references");
        fs::write(source.join("references/notes.md"), "notes").expect("notes");

        let receipt = publish_common_skill_from_home(
            home,
            &SkillPublishRequest {
                key: "deploy".to_owned(),
                providers: vec![ProviderId::Claude, ProviderId::Codex],
                overwrite: SkillOverwritePolicy::Fail,
                location: SkillLocation::default(),
            },
        )
        .expect("publish");

        assert!(receipt
            .results
            .iter()
            .all(|result| result.outcome == SkillPublishOutcome::Published));
        // 공통 콘텐츠가 그대로 재사용된다.
        for root in [".claude/skills", ".codex/skills"] {
            let published = home.join(root).join("deploy");
            assert!(published.join("SKILL.md").is_file());
            assert_eq!(
                fs::read_to_string(published.join("references/notes.md")).expect("notes"),
                "notes"
            );
        }

        // 게시 후 라이브러리는 두 공급자를 최신 사본으로 본다.
        let library =
            load_skill_library_from_home(home, &SkillMetaStore::default()).expect("library");
        let entry = library
            .entries
            .iter()
            .find(|entry| entry.key == "deploy")
            .expect("entry");
        assert_eq!(entry.installed_count, 2);
        assert!(entry.providers.iter().all(|state| !state.divergent));
    }

    #[test]
    fn publish_leaves_no_staging_or_backup_directories() {
        let temp = TempDir::new().expect("temp");
        let home = temp.path();
        write_skill(&common_dir(home, "clean"), "clean", "Clean skill");
        publish_common_skill_from_home(
            home,
            &SkillPublishRequest {
                key: "clean".to_owned(),
                providers: vec![ProviderId::Codex],
                overwrite: SkillOverwritePolicy::Fail,
                location: SkillLocation::default(),
            },
        )
        .expect("publish");

        let leftovers: Vec<String> = fs::read_dir(home.join(".codex/skills"))
            .expect("read root")
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.starts_with(STAGE_PREFIX) || name.starts_with(BACKUP_PREFIX))
            .collect();
        assert!(leftovers.is_empty(), "남은 임시 디렉터리: {leftovers:?}");
    }

    #[test]
    fn publish_refuses_existing_install_without_overwrite() {
        let temp = TempDir::new().expect("temp");
        let home = temp.path();
        write_skill(&common_dir(home, "guard"), "guard", "Common version");
        let installed = home.join(".codex/skills/guard");
        write_skill(&installed, "guard", "Provider edited version");

        let receipt = publish_common_skill_from_home(
            home,
            &SkillPublishRequest {
                key: "guard".to_owned(),
                providers: vec![ProviderId::Codex],
                overwrite: SkillOverwritePolicy::Fail,
                location: SkillLocation::default(),
            },
        )
        .expect("publish call succeeds with per-provider outcome");
        assert_eq!(receipt.results[0].outcome, SkillPublishOutcome::Skipped);
        // 기존 설치본은 손대지 않는다.
        assert!(fs::read_to_string(installed.join("SKILL.md"))
            .expect("read")
            .contains("Provider edited version"));
    }

    #[test]
    fn publish_replaces_existing_install_when_requested() {
        let temp = TempDir::new().expect("temp");
        let home = temp.path();
        write_skill(&common_dir(home, "guard"), "guard", "Common version");
        let installed = home.join(".codex/skills/guard");
        write_skill(&installed, "guard", "Provider edited version");
        // 게시본에 남아 있으면 안 되는 예전 파일.
        fs::write(installed.join("stale.md"), "stale").expect("stale");

        let receipt = publish_common_skill_from_home(
            home,
            &SkillPublishRequest {
                key: "guard".to_owned(),
                providers: vec![ProviderId::Codex],
                overwrite: SkillOverwritePolicy::Replace,
                location: SkillLocation::default(),
            },
        )
        .expect("publish");
        assert_eq!(receipt.results[0].outcome, SkillPublishOutcome::Replaced);
        assert!(fs::read_to_string(installed.join("SKILL.md"))
            .expect("read")
            .contains("Common version"));
        assert!(
            !installed.join("stale.md").exists(),
            "교체는 원본에 없는 파일을 남기지 않는다"
        );
    }

    #[test]
    fn publish_reports_unchanged_when_already_current() {
        let temp = TempDir::new().expect("temp");
        let home = temp.path();
        write_skill(&common_dir(home, "same"), "same", "Same skill");
        publish_common_skill_from_home(
            home,
            &SkillPublishRequest {
                key: "same".to_owned(),
                providers: vec![ProviderId::Codex],
                overwrite: SkillOverwritePolicy::Fail,
                location: SkillLocation::default(),
            },
        )
        .expect("first publish");
        let receipt = publish_common_skill_from_home(
            home,
            &SkillPublishRequest {
                key: "same".to_owned(),
                providers: vec![ProviderId::Codex],
                overwrite: SkillOverwritePolicy::Fail,
                location: SkillLocation::default(),
            },
        )
        .expect("second publish");
        assert_eq!(receipt.results[0].outcome, SkillPublishOutcome::Unchanged);
    }

    #[test]
    fn publish_to_antigravity_uses_supported_global_root() {
        let temp = TempDir::new().expect("temp");
        let home = temp.path();
        write_skill(&common_dir(home, "note"), "note", "Note skill");
        let receipt = publish_common_skill_from_home(
            home,
            &SkillPublishRequest {
                key: "note".to_owned(),
                providers: vec![ProviderId::Antigravity],
                overwrite: SkillOverwritePolicy::Fail,
                location: SkillLocation::default(),
            },
        )
        .expect("Antigravity publish");
        assert_eq!(receipt.results.len(), 1);
        assert_eq!(receipt.results[0].outcome, SkillPublishOutcome::Published);
        assert!(home.join(".gemini/config/skills/note/SKILL.md").is_file());
    }

    #[test]
    fn antigravity_and_codex_publish_to_their_personal_roots() {
        let temp = TempDir::new().expect("temp");
        let home = temp.path();
        write_skill(&common_dir(home, "mixed"), "mixed", "Mixed targets");

        let receipt = publish_common_skill_from_home(
            home,
            &SkillPublishRequest {
                key: "mixed".to_owned(),
                providers: vec![ProviderId::Antigravity, ProviderId::Codex],
                overwrite: SkillOverwritePolicy::Fail,
                location: SkillLocation::default(),
            },
        )
        .expect("publish");

        let codex = receipt
            .results
            .iter()
            .find(|result| result.provider == ProviderId::Codex)
            .expect("codex result");
        assert_eq!(codex.outcome, SkillPublishOutcome::Published);
        assert!(home.join(".codex/skills/mixed/SKILL.md").is_file());

        let antigravity = receipt
            .results
            .iter()
            .find(|result| result.provider == ProviderId::Antigravity)
            .expect("antigravity result");
        assert_eq!(antigravity.outcome, SkillPublishOutcome::Published);
        assert!(home.join(".gemini/config/skills/mixed/SKILL.md").is_file());
    }

    #[test]
    fn compatibility_check_flags_blocking_and_warning_issues() {
        let temp = TempDir::new().expect("temp");
        let home = temp.path();
        let source = common_dir(home, "check");
        // 설명이 비어 있고 프런트매터 name이 디렉터리와 다르다.
        fs::create_dir_all(&source).expect("dir");
        fs::write(
            source.join("SKILL.md"),
            "---\nname: other\ndescription:\n---\nBody\n",
        )
        .expect("write");

        let report = check_skill_publish_from_home(
            home,
            "check",
            &[ProviderId::Codex],
            &SkillLocation::default(),
        )
        .expect("report");
        assert!(report.blocked());
        assert!(report
            .issues
            .iter()
            .any(|issue| issue.code == "description-empty"
                && issue.severity == SkillIssueSeverity::Blocking));
        assert!(report
            .issues
            .iter()
            .any(|issue| issue.code == "name-mismatch"
                && issue.severity == SkillIssueSeverity::Warning));
    }

    #[cfg(unix)]
    #[test]
    fn compatibility_check_blocks_symlinked_content() {
        let temp = TempDir::new().expect("temp");
        let home = temp.path();
        let source = common_dir(home, "linky");
        write_skill(&source, "linky", "Has a link");
        let outside = temp.path().join("outside.md");
        fs::write(&outside, "outside").expect("outside");
        std::os::unix::fs::symlink(&outside, source.join("link.md")).expect("symlink");

        let report = check_skill_publish_from_home(
            home,
            "linky",
            &[ProviderId::Codex],
            &SkillLocation::default(),
        )
        .expect("report");
        assert!(report.blocked());
        assert!(report.issues.iter().any(|issue| issue.code == "symlink"));
    }

    #[test]
    fn create_common_skill_refuses_duplicates_and_writes_frontmatter() {
        let temp = TempDir::new().expect("temp");
        let home = temp.path();
        let source = create_common_skill_from_home(
            home,
            &CreateCommonSkillRequest {
                key: "fresh".to_owned(),
                name: None,
                description: "Fresh skill: does things".to_owned(),
            },
        )
        .expect("create");
        assert_eq!(source.key, "fresh");
        let text = fs::read_to_string(common_dir(home, "fresh").join("SKILL.md")).expect("read");
        // 콜론이 든 설명은 따옴표로 감싸 YAML 구조를 깨지 않는다.
        assert!(text.contains("description: \"Fresh skill: does things\""));

        let duplicate = create_common_skill_from_home(
            home,
            &CreateCommonSkillRequest {
                key: "fresh".to_owned(),
                name: None,
                description: "Another".to_owned(),
            },
        );
        assert!(matches!(duplicate, Err(CoreError::Conflict(_))));
    }

    #[test]
    fn create_common_skill_requires_description() {
        let temp = TempDir::new().expect("temp");
        let result = create_common_skill_from_home(
            temp.path(),
            &CreateCommonSkillRequest {
                key: "empty".to_owned(),
                name: None,
                description: "   ".to_owned(),
            },
        );
        assert!(matches!(result, Err(CoreError::InvalidInput(_))));
    }

    #[test]
    fn import_promotes_user_skill_and_refuses_provider_owned() {
        let temp = TempDir::new().expect("temp");
        let home = temp.path();
        let personal = home.join(".codex/skills/adopted");
        write_skill(&personal, "adopted", "Adopted skill");
        fs::create_dir_all(personal.join("scripts")).expect("scripts");
        fs::write(personal.join("scripts/run.sh"), "echo hi").expect("script");

        let library =
            load_skill_library_from_home(home, &SkillMetaStore::default()).expect("library");
        let entry = library
            .entries
            .iter()
            .find(|entry| entry.key == "adopted")
            .expect("entry");
        assert_eq!(entry.origin_kind, SkillOriginKind::Provider);
        let skill_id = entry
            .providers
            .iter()
            .find(|state| state.provider == ProviderId::Codex)
            .and_then(|state| state.skill_id.clone())
            .expect("skill id");

        let source = import_skill_to_common_from_home(
            home,
            None,
            &ImportCommonSkillRequest {
                skill_id: skill_id.clone(),
            },
        )
        .expect("import");
        assert_eq!(source.key, "adopted");
        assert!(common_dir(home, "adopted").join("scripts/run.sh").is_file());
        // 원본 설치본은 그대로 남는다.
        assert!(personal.join("SKILL.md").is_file());

        // 두 번째 가져오기는 기존 공통 원본을 덮어쓰지 않는다.
        let duplicate =
            import_skill_to_common_from_home(home, None, &ImportCommonSkillRequest { skill_id });
        assert!(matches!(duplicate, Err(CoreError::Conflict(_))));
    }

    #[test]
    fn import_refuses_provider_owned_system_skill() {
        let temp = TempDir::new().expect("temp");
        let home = temp.path();
        let system = home.join(".codex/skills/.system/builtin-thing");
        write_skill(&system, "builtin-thing", "Provider owned");

        let mut issues = Vec::new();
        let projects = claude_project_paths(home);
        let installs = scan_provider_installs(home, &projects, &mut issues);
        let install = installs
            .iter()
            .find(|install| install.scope == "system")
            .expect("system install");
        let result = import_skill_to_common_from_home(
            home,
            None,
            &ImportCommonSkillRequest {
                skill_id: install.skill_id.clone(),
            },
        );
        assert!(matches!(result, Err(CoreError::InvalidInput(_))));
    }

    /// 외부 URL 소스 플러그인(superpowers 등)은 마켓플레이스 클론에 실체가 없고
    /// 설치 레지스트리(`installed_plugins.json`)의 installPath에만 스킬이 있다.
    /// 레지스트리를 읽지 않으면 설치된 플러그인 스킬이 통째로 빠지고, 클론만
    /// 훑으면 설치하지 않은 마켓 플러그인까지 설치된 것처럼 보인다.
    #[test]
    fn plugin_skills_come_from_installed_plugin_registry_not_marketplace_clone() {
        let temp = TempDir::new().expect("temp");
        let home = temp.path();
        let install_dir =
            home.join(".claude/plugins/cache/claude-plugins-official/superpowers/6.3.0");
        write_skill(
            &install_dir.join("skills/tdd"),
            "tdd",
            "설치된 플러그인 스킬",
        );
        // 마켓플레이스 클론에만 있는(설치되지 않은) 플러그인.
        write_skill(
            &home.join(
                ".claude/plugins/marketplaces/claude-plugins-official/plugins/vendored/skills/vend",
            ),
            "vend",
            "설치되지 않은 플러그인 스킬",
        );
        fs::write(
            home.join(".claude/plugins/installed_plugins.json"),
            format!(
                r#"{{"version":2,"plugins":{{"superpowers@claude-plugins-official":[{{"scope":"user","installPath":{}}}]}}}}"#,
                serde_json::to_string(&install_dir.to_string_lossy()).expect("path json")
            ),
        )
        .expect("write registry");

        let mut issues = Vec::new();
        let installs = scan_provider_installs(home, &[], &mut issues);
        let superpowers: Vec<_> = installs
            .iter()
            .filter(|install| {
                install.scope == "plugin" && install.origin.as_deref() == Some("superpowers")
            })
            .collect();
        assert_eq!(
            superpowers.len(),
            1,
            "설치 레지스트리의 installPath에서 플러그인 스킬을 읽어야 한다"
        );
        assert!(superpowers[0].read_only);
        assert!(
            !installs
                .iter()
                .any(|install| install.origin.as_deref() == Some("vendored")),
            "설치되지 않은 마켓플레이스 클론 플러그인은 목록에 넣지 않는다"
        );
    }

    #[test]
    fn adapters_expose_personal_and_project_publish_boundaries() {
        let temp = TempDir::new().expect("temp");
        let library =
            load_skill_library_from_home(temp.path(), &SkillMetaStore::default()).expect("library");
        let antigravity = library
            .adapters
            .iter()
            .find(|view| view.provider == ProviderId::Antigravity)
            .expect("antigravity adapter");
        let antigravity_personal = temp
            .path()
            .join(".gemini/config/skills")
            .to_string_lossy()
            .into_owned();
        assert!(antigravity.supports_common_source);
        assert_eq!(
            antigravity.installable_root.as_deref(),
            Some(antigravity_personal.as_str())
        );
        assert!(antigravity.roots.iter().any(|root| !root.read_only));
        assert!(antigravity.note.is_some());

        for provider in [ProviderId::Claude, ProviderId::Codex] {
            let view = library
                .adapters
                .iter()
                .find(|view| view.provider == provider)
                .expect("adapter");
            assert!(view.supports_common_source);
            assert!(view.installable_root.is_some());
            assert_eq!(
                view.roots.iter().filter(|root| root.installable).count(),
                1,
                "게시 대상 루트는 공급자마다 하나여야 한다"
            );
        }
    }

    #[test]
    fn read_only_provider_skill_is_listed_but_not_managed() {
        let temp = TempDir::new().expect("temp");
        let home = temp.path();
        write_skill(
            &home.join(".gemini/antigravity-cli/builtin/skills/guide"),
            "guide",
            "Builtin guide",
        );
        let library =
            load_skill_library_from_home(home, &SkillMetaStore::default()).expect("library");
        let entry = library
            .entries
            .iter()
            .find(|entry| entry.key == "guide")
            .expect("entry");
        assert!(!entry.managed, "공급자 소유 스킬은 관리 대상이 아니다");
        let antigravity = entry
            .providers
            .iter()
            .find(|state| state.provider == ProviderId::Antigravity)
            .expect("antigravity");
        assert!(antigravity.read_only);
    }

    #[test]
    fn hidden_codex_system_directory_is_not_a_personal_skill() {
        let temp = TempDir::new().expect("temp");
        let home = temp.path();
        write_skill(
            &home.join(".codex/skills/.system/imagegen"),
            "imagegen",
            "System skill",
        );
        let library =
            load_skill_library_from_home(home, &SkillMetaStore::default()).expect("library");
        // `.system` 자체가 스킬로 잡히지 않는다.
        assert!(library.entries.iter().all(|entry| entry.key != ".system"));
        let entry = library
            .entries
            .iter()
            .find(|entry| entry.key == "imagegen")
            .expect("entry");
        let codex = entry
            .providers
            .iter()
            .find(|state| state.provider == ProviderId::Codex)
            .expect("codex");
        assert_eq!(codex.scope.as_deref(), Some("system"));
        assert!(codex.read_only);
    }

    #[test]
    fn common_skill_detail_reads_body_and_files() {
        let temp = TempDir::new().expect("temp");
        let home = temp.path();
        let source = common_dir(home, "detail");
        write_skill(&source, "detail", "Detail skill");
        fs::create_dir_all(source.join("references")).expect("references");
        fs::write(source.join("references/extra.md"), "extra").expect("extra");

        // 상세 조회는 홈 의존 함수를 거치므로 내부 구현을 직접 검증한다.
        let (loaded, content) = read_common_source(&source, "detail").expect("source");
        assert_eq!(loaded.name, "detail");
        assert_eq!(loaded.description, "Detail skill");
        assert_eq!(content.file_count, 2);
        assert_eq!(loaded.content_digest, content.digest);
    }

    #[test]
    fn digest_changes_with_content_and_ignores_os_noise() {
        let temp = TempDir::new().expect("temp");
        let directory = temp.path().join("skill");
        write_skill(&directory, "x", "X");
        let first = read_skill_content(&directory).expect("first").digest;

        fs::write(directory.join(".DS_Store"), "junk").expect("junk");
        let second = read_skill_content(&directory).expect("second").digest;
        assert_eq!(first, second, "OS 부산물은 지문에 영향을 주지 않는다");

        fs::write(directory.join("extra.md"), "extra").expect("extra");
        let third = read_skill_content(&directory).expect("third").digest;
        assert_ne!(first, third);
    }

    // -----------------------------------------------------------------------
    // 삭제·휴지통
    // -----------------------------------------------------------------------

    use crate::skill_trash::{
        list_skill_trash, purge_skill_trash, restore_skill_trash, SkillTrashRestoreOutcome,
    };

    fn installed_skill_id(directory: &Path) -> String {
        stable_id(&directory.join("SKILL.md").to_string_lossy())
    }

    #[test]
    fn delete_installed_skill_moves_directory_to_trash_and_restores() {
        let home_dir = TempDir::new().expect("home");
        let data_dir = TempDir::new().expect("data");
        let home = home_dir.path();
        let installed = home.join(".codex/skills/todo");
        write_skill(&installed, "todo", "Todo skill");
        fs::create_dir_all(installed.join("scripts")).expect("scripts");
        fs::write(installed.join("scripts/run.sh"), "echo run").expect("script");

        let receipt = delete_installed_skill_from_home(
            home,
            data_dir.path(),
            &DeleteInstalledSkillRequest {
                id: installed_skill_id(&installed),
                deleted_by: None,
                confirm: true,
            },
        )
        .expect("delete");
        assert!(!installed.exists(), "설치본이 휴지통으로 이동한다");
        assert_eq!(receipt.items.len(), 1);
        assert_eq!(receipt.items[0].kind, SkillTrashItemKind::Directory);
        assert_eq!(receipt.items[0].deleted_by, "user");
        assert_eq!(receipt.items[0].provider, Some(ProviderId::Codex));

        let overview = list_skill_trash(data_dir.path()).expect("list");
        assert_eq!(overview.items.len(), 1);
        assert_eq!(overview.items[0].key, "todo");

        let restore = restore_skill_trash(data_dir.path(), &receipt.items[0].id).expect("restore");
        assert!(restore
            .results
            .iter()
            .all(|result| result.outcome == SkillTrashRestoreOutcome::Restored));
        assert!(installed.join("SKILL.md").is_file());
        assert_eq!(
            fs::read_to_string(installed.join("scripts/run.sh")).expect("script"),
            "echo run"
        );
        assert!(
            list_skill_trash(data_dir.path())
                .expect("list")
                .items
                .is_empty(),
            "복구한 항목은 휴지통에서 사라진다"
        );
    }

    #[test]
    fn delete_requires_explicit_confirm() {
        let home_dir = TempDir::new().expect("home");
        let data_dir = TempDir::new().expect("data");
        let installed = home_dir.path().join(".codex/skills/keep");
        write_skill(&installed, "keep", "Keep skill");

        let error = delete_installed_skill_from_home(
            home_dir.path(),
            data_dir.path(),
            &DeleteInstalledSkillRequest {
                id: installed_skill_id(&installed),
                deleted_by: None,
                confirm: false,
            },
        )
        .expect_err("confirm 없이 삭제되면 안 된다");
        assert!(error.to_string().contains("confirm"));
        assert!(installed.join("SKILL.md").is_file());
    }

    #[test]
    fn delete_rejects_provider_owned_scopes() {
        let home_dir = TempDir::new().expect("home");
        let data_dir = TempDir::new().expect("data");
        let installed = home_dir.path().join(".codex/skills/.system/tool");
        write_skill(&installed, "tool", "Built-in tool");

        let error = delete_installed_skill_from_home(
            home_dir.path(),
            data_dir.path(),
            &DeleteInstalledSkillRequest {
                id: installed_skill_id(&installed),
                deleted_by: None,
                confirm: true,
            },
        )
        .expect_err("내장 스킬은 삭제할 수 없다");
        assert!(error.to_string().contains("내장"));
        assert!(installed.join("SKILL.md").is_file());
    }

    #[cfg(unix)]
    #[test]
    fn delete_symlinked_install_removes_only_link_and_restore_recreates_it() {
        let home_dir = TempDir::new().expect("home");
        let data_dir = TempDir::new().expect("data");
        let home = home_dir.path();
        let source = common_dir(home, "linked");
        write_skill(&source, "linked", "Linked skill");
        let root = home.join(".claude/skills");
        fs::create_dir_all(&root).expect("claude root");
        let link = root.join("linked");
        std::os::unix::fs::symlink(&source, &link).expect("symlink");

        let receipt = delete_installed_skill_from_home(
            home,
            data_dir.path(),
            &DeleteInstalledSkillRequest {
                id: installed_skill_id(&link),
                deleted_by: Some("aia".to_owned()),
                confirm: true,
            },
        )
        .expect("delete");
        assert_eq!(receipt.items[0].kind, SkillTrashItemKind::Link);
        assert_eq!(receipt.items[0].deleted_by, "aia");
        assert!(receipt.items[0].shared, "공유 원본이 있는 키로 기록된다");
        assert!(fs::symlink_metadata(&link).is_err(), "링크 자체만 제거된다");
        assert!(
            source.join("SKILL.md").is_file(),
            "링크 대상인 공유 원본은 남는다"
        );

        let restore = restore_skill_trash(data_dir.path(), &receipt.items[0].id).expect("restore");
        assert!(restore
            .results
            .iter()
            .all(|result| result.outcome == SkillTrashRestoreOutcome::Restored));
        let metadata = fs::symlink_metadata(&link).expect("restored link");
        assert!(metadata.file_type().is_symlink());
        assert!(link.join("SKILL.md").is_file(), "링크가 원본을 다시 본다");
    }

    #[test]
    fn delete_shared_skill_groups_original_and_installs_and_restores_together() {
        let home_dir = TempDir::new().expect("home");
        let data_dir = TempDir::new().expect("data");
        let home = home_dir.path();
        let source = common_dir(home, "bundle");
        write_skill(&source, "bundle", "Bundle skill");
        publish_common_skill_from_home(
            home,
            &SkillPublishRequest {
                key: "bundle".to_owned(),
                providers: vec![ProviderId::Claude, ProviderId::Codex],
                overwrite: SkillOverwritePolicy::Fail,
                location: SkillLocation::default(),
            },
        )
        .expect("publish");

        let receipt = delete_shared_skill_from_home(
            home,
            data_dir.path(),
            &DeleteSharedSkillRequest {
                key: "bundle".to_owned(),
                deleted_by: None,
                confirm: true,
            },
        )
        .expect("delete shared");
        assert_eq!(receipt.items.len(), 3, "배포본 2 + 원본 1");
        assert!(receipt
            .items
            .iter()
            .all(|item| item.group_id == receipt.group_id));
        // 원본은 마지막에 이동한다.
        assert!(receipt.items.last().expect("last").provider.is_none());
        assert!(!source.exists());
        assert!(!home.join(".claude/skills/bundle").exists());
        assert!(!home.join(".codex/skills/bundle").exists());

        // 그룹의 아무 항목으로 복구해도 전체가 돌아온다.
        let restore = restore_skill_trash(data_dir.path(), &receipt.items[0].id).expect("restore");
        assert_eq!(restore.results.len(), 3);
        assert!(restore
            .results
            .iter()
            .all(|result| result.outcome == SkillTrashRestoreOutcome::Restored));
        assert!(source.join("SKILL.md").is_file());
        assert!(home.join(".claude/skills/bundle/SKILL.md").is_file());
        assert!(home.join(".codex/skills/bundle/SKILL.md").is_file());
    }

    #[test]
    fn unarchiving_a_shared_skill_keeps_installs_and_restores_the_source() {
        let home_dir = TempDir::new().expect("home");
        let data_dir = TempDir::new().expect("data");
        let home = home_dir.path();
        let source = common_dir(home, "keeper");
        write_skill(&source, "keeper", "Keeper skill");
        publish_common_skill_from_home(
            home,
            &SkillPublishRequest {
                key: "keeper".to_owned(),
                providers: vec![ProviderId::Claude, ProviderId::Codex],
                overwrite: SkillOverwritePolicy::Fail,
                location: SkillLocation::default(),
            },
        )
        .expect("publish");

        assert!(unarchive_shared_skill_in(
            &common_root(home),
            data_dir.path(),
            &UnarchiveSharedSkillRequest {
                key: "keeper".to_owned(),
                deleted_by: None,
                confirm: false,
            },
        )
        .is_err());

        let receipt = unarchive_shared_skill_in(
            &common_root(home),
            data_dir.path(),
            &UnarchiveSharedSkillRequest {
                key: "keeper".to_owned(),
                deleted_by: None,
                confirm: true,
            },
        )
        .expect("unarchive");
        assert_eq!(receipt.items.len(), 1, "원본 하나만 옮긴다");
        assert!(receipt.items[0].shared);
        assert!(!source.exists());
        // 사용본은 그대로 남아 "미보관"으로 돌아간다.
        assert!(home.join(".claude/skills/keeper/SKILL.md").is_file());
        assert!(home.join(".codex/skills/keeper/SKILL.md").is_file());

        let restore = restore_skill_trash(data_dir.path(), &receipt.items[0].id).expect("restore");
        assert_eq!(restore.results.len(), 1);
        assert!(source.join("SKILL.md").is_file());
    }

    #[test]
    fn restore_skips_when_original_path_is_occupied() {
        let home_dir = TempDir::new().expect("home");
        let data_dir = TempDir::new().expect("data");
        let home = home_dir.path();
        let installed = home.join(".codex/skills/busy");
        write_skill(&installed, "busy", "Busy skill");

        let receipt = delete_installed_skill_from_home(
            home,
            data_dir.path(),
            &DeleteInstalledSkillRequest {
                id: installed_skill_id(&installed),
                deleted_by: None,
                confirm: true,
            },
        )
        .expect("delete");
        // 같은 자리에 새 스킬이 생겼다.
        write_skill(&installed, "busy", "New busy skill");

        let restore =
            restore_skill_trash(data_dir.path(), &receipt.items[0].id).expect("restore call");
        assert_eq!(
            restore.results[0].outcome,
            SkillTrashRestoreOutcome::Skipped
        );
        assert!(
            fs::read_to_string(installed.join("SKILL.md"))
                .expect("read")
                .contains("New busy skill"),
            "기존 항목을 덮어쓰지 않는다"
        );
        assert_eq!(
            list_skill_trash(data_dir.path()).expect("list").items.len(),
            1,
            "복구하지 못한 항목은 휴지통에 남는다"
        );
    }

    #[test]
    fn check_skill_delete_reports_group_impact_without_writing() {
        let home_dir = TempDir::new().expect("home");
        let home = home_dir.path();
        let source = common_dir(home, "scan");
        write_skill(&source, "scan", "Scan skill");
        write_skill(&home.join(".codex/skills/scan"), "scan", "Scan skill");

        let impact = check_skill_delete_from_home(
            home,
            &SkillDeleteCheckRequest {
                id: None,
                key: Some("scan".to_owned()),
            },
        )
        .expect("check");
        assert!(impact.shared);
        assert_eq!(impact.items.len(), 2, "배포본 1 + 원본 1");
        assert!(impact.items.last().expect("last").provider.is_none());
        assert!(
            source.join("SKILL.md").is_file(),
            "확인은 파일을 옮기지 않는다"
        );

        let single = check_skill_delete_from_home(
            home,
            &SkillDeleteCheckRequest {
                id: Some(installed_skill_id(&home.join(".codex/skills/scan"))),
                key: None,
            },
        )
        .expect("check by id");
        assert_eq!(single.items.len(), 1);
        assert!(single.shared);

        assert!(check_skill_delete_from_home(
            home,
            &SkillDeleteCheckRequest {
                id: None,
                key: None
            }
        )
        .is_err());
    }

    #[test]
    fn frontmatter_value_reads_block_scalars() {
        // 여러 줄 설명(`>-`)이 마커 문자 그대로 저장되면 카드 설명과 번역이
        // 전부 ">-"가 된다.
        let folded = "name: demo\ndescription: >-\n  first line\n  second line\nother: x\n";
        assert_eq!(
            frontmatter_value(folded, "description").as_deref(),
            Some("first line second line")
        );
        assert_eq!(frontmatter_value(folded, "name").as_deref(), Some("demo"));
        assert_eq!(frontmatter_value(folded, "other").as_deref(), Some("x"));

        let literal = "notes: |\n  a\n  b\n";
        assert_eq!(frontmatter_value(literal, "notes").as_deref(), Some("a\nb"));

        // 값 없는 블록 마커는 값이 없는 것으로 본다.
        assert_eq!(frontmatter_value("empty: >-\nnext: y\n", "empty"), None);
    }

    #[test]
    fn common_translation_sources_include_undeployed_shared_skills() {
        let temp = TempDir::new().expect("temp");
        let home = temp.path();
        let directory = common_dir(home, "solo");
        fs::create_dir_all(&directory).expect("dir");
        fs::write(
            directory.join("SKILL.md"),
            "---\nname: solo\ndescription: >-\n  only in shared store\n  never deployed\n---\nBody\n",
        )
        .expect("write");

        let sources = list_common_translation_sources(home);
        assert_eq!(sources.len(), 1);
        assert_eq!(sources[0].name, "solo");
        assert_eq!(
            sources[0].description,
            "only in shared store never deployed"
        );
        assert_eq!(
            sources[0].id,
            stable_id(&directory.join("SKILL.md").to_string_lossy())
        );
    }

    #[test]
    fn import_promotes_project_skill_from_registered_project() {
        // 프로젝트 루트는 배포 대상이 아니라 read_only로 표시되지만, 사용자
        // 소유(scope project)이므로 공유 저장소로 가져오기는 가능해야 한다.
        let temp = TempDir::new().expect("temp");
        let home = temp.path();
        let project = home.join("workspace/demo-project");
        fs::create_dir_all(&project).expect("project dir");
        fs::write(
            home.join(".claude.json"),
            serde_json::json!({ "projects": { project.to_string_lossy(): {} } }).to_string(),
        )
        .expect("claude.json");
        let installed = project.join(".claude/skills/db-ops");
        write_skill(&installed, "db-ops", "Project skill");

        let source = import_skill_to_common_from_home(
            home,
            None,
            &ImportCommonSkillRequest {
                skill_id: installed_skill_id(&installed),
            },
        )
        .expect("프로젝트 스킬도 공유 저장소로 가져올 수 있다");
        assert_eq!(source.key, "db-ops");
        assert!(common_dir(home, "db-ops").join("SKILL.md").is_file());
        assert!(installed.join("SKILL.md").is_file(), "원본 설치본은 남는다");
    }

    #[test]
    fn import_records_origin_and_project_publish_targets_registered_project() {
        let home_dir = TempDir::new().expect("home");
        let data_dir = TempDir::new().expect("data");
        let home = home_dir.path();
        let project = home.join("workspace/proj-a");
        fs::create_dir_all(&project).expect("project dir");
        fs::write(
            home.join(".claude.json"),
            serde_json::json!({ "projects": { project.to_string_lossy(): {} } }).to_string(),
        )
        .expect("claude.json");
        let installed = project.join(".claude/skills/proj-skill");
        write_skill(&installed, "proj-skill", "Project skill");

        // 보관: 출처 메타에 프로젝트가 기록된다.
        import_skill_to_common_from_home(
            home,
            Some(data_dir.path()),
            &ImportCommonSkillRequest {
                skill_id: installed_skill_id(&installed),
            },
        )
        .expect("archive");
        let meta = load_skill_meta(data_dir.path());
        let origin = meta
            .skills
            .get("proj-skill")
            .and_then(|entry| entry.origin.as_ref())
            .expect("origin recorded");
        assert_eq!(origin.scope, "project");
        assert_eq!(
            origin.project_path.as_deref(),
            Some(project.to_string_lossy().as_ref())
        );

        // 프로젝트 위치로 Codex와 Antigravity 배포: 각 공급자 프로젝트 루트에 설치된다.
        let receipt = publish_common_skill_from_home(
            home,
            &SkillPublishRequest {
                key: "proj-skill".to_owned(),
                providers: vec![ProviderId::Codex, ProviderId::Antigravity],
                overwrite: SkillOverwritePolicy::Fail,
                location: SkillLocation {
                    scope: Some("project".to_owned()),
                    project_path: Some(project.to_string_lossy().into_owned()),
                },
            },
        )
        .expect("project publish");
        assert!(receipt
            .results
            .iter()
            .all(|result| result.outcome == SkillPublishOutcome::Published));
        assert!(project.join(".codex/skills/proj-skill/SKILL.md").is_file());
        assert!(project.join(".agents/skills/proj-skill/SKILL.md").is_file());

        // 등록되지 않은 프로젝트 경로는 거부한다.
        let outside = home.join("workspace/unregistered");
        fs::create_dir_all(&outside).expect("outside");
        assert!(publish_common_skill_from_home(
            home,
            &SkillPublishRequest {
                key: "proj-skill".to_owned(),
                providers: vec![ProviderId::Claude],
                overwrite: SkillOverwritePolicy::Fail,
                location: SkillLocation {
                    scope: Some("project".to_owned()),
                    project_path: Some(outside.to_string_lossy().into_owned()),
                },
            },
        )
        .is_err());

        // 라이브러리 응답: 출처와 위치별 설치본이 담긴다.
        let meta = load_skill_meta(data_dir.path());
        let library = load_skill_library_from_home(home, &meta).expect("library");
        let entry = library
            .entries
            .iter()
            .find(|entry| entry.key == "proj-skill")
            .expect("entry");
        assert_eq!(entry.origin.as_ref().expect("origin").scope, "project");
        let codex = entry
            .providers
            .iter()
            .find(|state| state.provider == ProviderId::Codex)
            .expect("codex state");
        assert!(codex
            .installs
            .iter()
            .any(|install| install.scope == "project"
                && install.project_path.as_deref() == Some(project.to_string_lossy().as_ref())));
        assert!(library.projects.iter().any(|view| view.name == "proj-a"));
    }

    #[test]
    fn compare_reports_added_removed_and_modified_files_only() {
        let home_dir = TempDir::new().expect("home");
        let home = home_dir.path();
        let source = common_dir(home, "cmp");
        write_skill(&source, "cmp", "Original");
        fs::create_dir_all(source.join("scripts")).expect("scripts");
        fs::write(source.join("scripts/run.sh"), "echo run\n").expect("run.sh");
        fs::write(source.join("notes.md"), "same\n").expect("notes");
        publish_common_skill_from_home(
            home,
            &SkillPublishRequest {
                key: "cmp".to_owned(),
                providers: vec![ProviderId::Codex],
                overwrite: SkillOverwritePolicy::Fail,
                location: SkillLocation::default(),
            },
        )
        .expect("publish");

        let edited = home.join(".codex/skills/cmp");
        // 수정·추가·삭제를 하나씩 만든다. notes.md는 그대로 둔다.
        fs::write(
            edited.join("SKILL.md"),
            "---\nname: cmp\ndescription: Original\n---\nBody\nExtra line\n",
        )
        .expect("edit SKILL.md");
        fs::create_dir_all(edited.join("references")).expect("references");
        fs::write(edited.join("references/new.md"), "new\n").expect("new.md");
        fs::remove_file(edited.join("scripts/run.sh")).expect("remove run.sh");

        let comparison = compare_skill_install_from_home(
            home,
            &CompareSkillRequest {
                skill_id: installed_skill_id(&edited),
            },
        )
        .expect("compare");
        assert_eq!(comparison.key, "cmp");
        assert_eq!(comparison.provider, ProviderId::Codex);
        assert_eq!(comparison.unchanged_count, 1);
        let statuses: Vec<(&str, SkillFileChangeStatus)> = comparison
            .files
            .iter()
            .map(|file| (file.path.as_str(), file.status))
            .collect();
        assert_eq!(
            statuses,
            vec![
                ("SKILL.md", SkillFileChangeStatus::Modified),
                ("references/new.md", SkillFileChangeStatus::Added),
                ("scripts/run.sh", SkillFileChangeStatus::Removed),
            ]
        );
        let skill_md = &comparison.files[0];
        assert!(!skill_md.binary && !skill_md.too_large);
        assert!(skill_md
            .source
            .as_deref()
            .is_some_and(|text| !text.contains("Extra line")));
        assert!(skill_md
            .install
            .as_deref()
            .is_some_and(|text| text.contains("Extra line")));
        let added = &comparison.files[1];
        assert_eq!(added.source, None);
        assert_eq!(added.install.as_deref(), Some("new\n"));
        let removed = &comparison.files[2];
        assert_eq!(removed.source.as_deref(), Some("echo run\n"));
        assert_eq!(removed.install, None);
    }

    /// 공급자 투영으로만 달라지는 frontmatter는 차이로 잡히면 안 된다. 게시 직후
    /// 설치본은 지문상 원본과 같으므로 비교 결과도 비어 있어야 한다.
    #[test]
    fn compare_ignores_provider_projection_and_flags_binary_files() {
        let home_dir = TempDir::new().expect("home");
        let home = home_dir.path();
        let source = common_dir(home, "proj");
        write_skill(&source, "proj", "Original");
        fs::write(source.join("blob.bin"), [0xff, 0xfe, 0x00, 0x01]).expect("blob");
        publish_common_skill_from_home(
            home,
            &SkillPublishRequest {
                key: "proj".to_owned(),
                providers: vec![ProviderId::Claude],
                overwrite: SkillOverwritePolicy::Fail,
                location: SkillLocation::default(),
            },
        )
        .expect("publish");
        let installed = home.join(".claude/skills/proj");

        let comparison = compare_skill_install_from_home(
            home,
            &CompareSkillRequest {
                skill_id: installed_skill_id(&installed),
            },
        )
        .expect("compare");
        assert!(comparison.files.is_empty(), "{:?}", comparison.files);
        assert_eq!(comparison.unchanged_count, 2);

        fs::write(installed.join("blob.bin"), [0xff, 0xfe, 0x00, 0x02]).expect("edit blob");
        let comparison = compare_skill_install_from_home(
            home,
            &CompareSkillRequest {
                skill_id: installed_skill_id(&installed),
            },
        )
        .expect("compare");
        assert_eq!(comparison.files.len(), 1);
        let blob = &comparison.files[0];
        assert_eq!(blob.path, "blob.bin");
        assert_eq!(blob.status, SkillFileChangeStatus::Modified);
        assert!(blob.binary);
        assert_eq!(blob.source, None);
        assert_eq!(blob.install, None);
    }

    #[test]
    fn sync_adopts_edited_install_and_republishes_others() {
        let home_dir = TempDir::new().expect("home");
        let data_dir = TempDir::new().expect("data");
        let home = home_dir.path();
        write_skill(&common_dir(home, "sync-me"), "sync-me", "Original");
        publish_common_skill_from_home(
            home,
            &SkillPublishRequest {
                key: "sync-me".to_owned(),
                providers: vec![ProviderId::Claude, ProviderId::Codex],
                overwrite: SkillOverwritePolicy::Fail,
                location: SkillLocation::default(),
            },
        )
        .expect("publish");

        // Codex 사용본이 외부에서 수정됐다.
        let edited = home.join(".codex/skills/sync-me");
        write_skill(&edited, "sync-me", "Edited by codex");

        let receipt = sync_skill_from_install_from_home(
            home,
            data_dir.path(),
            &SyncSkillRequest {
                skill_id: installed_skill_id(&edited),
                deleted_by: None,
            },
        )
        .expect("sync");
        assert!(receipt.previous_source_trash_id.is_some());
        // 원본과 Claude 사용본 모두 수정본으로 갱신된다.
        assert!(
            fs::read_to_string(common_dir(home, "sync-me").join("SKILL.md"))
                .expect("source")
                .contains("Edited by codex")
        );
        assert!(
            fs::read_to_string(home.join(".claude/skills/sync-me/SKILL.md"))
                .expect("claude")
                .contains("Edited by codex")
        );
        // 이전 원본은 휴지통에서 복구할 수 있다.
        assert_eq!(
            list_skill_trash(data_dir.path())
                .expect("trash")
                .items
                .len(),
            1
        );
    }

    #[test]
    fn update_common_skill_edits_and_republishes_immediately() {
        let home_dir = TempDir::new().expect("home");
        let home = home_dir.path();
        let source = common_dir(home, "editable");
        write_skill(&source, "editable", "Before edit");
        publish_common_skill_from_home(
            home,
            &SkillPublishRequest {
                key: "editable".to_owned(),
                providers: vec![ProviderId::Claude],
                overwrite: SkillOverwritePolicy::Fail,
                location: SkillLocation::default(),
            },
        )
        .expect("publish");
        let digest = read_skill_content(&source).expect("content").digest;

        let receipt = update_common_skill_from_home(
            home,
            &UpdateCommonSkillRequest {
                key: "editable".to_owned(),
                files: vec![
                    SkillFileWrite {
                        path: "SKILL.md".to_owned(),
                        content: "---\nname: editable\ndescription: After edit\n---\nBody\n"
                            .to_owned(),
                    },
                    SkillFileWrite {
                        path: "references/note.md".to_owned(),
                        content: "note".to_owned(),
                    },
                ],
                deletes: Vec::new(),
                expected_digest: digest.clone(),
            },
        )
        .expect("update");
        assert_ne!(receipt.content_digest, digest);
        // 저장 즉시 배포본에도 반영된다.
        assert!(
            fs::read_to_string(home.join(".claude/skills/editable/SKILL.md"))
                .expect("deployed")
                .contains("After edit")
        );
        assert!(home
            .join(".claude/skills/editable/references/note.md")
            .is_file());

        // 낙관적 잠금: 낡은 지문으로는 저장할 수 없다.
        assert!(matches!(
            update_common_skill_from_home(
                home,
                &UpdateCommonSkillRequest {
                    key: "editable".to_owned(),
                    files: vec![SkillFileWrite {
                        path: "x.md".to_owned(),
                        content: "y".to_owned(),
                    }],
                    deletes: Vec::new(),
                    expected_digest: digest,
                },
            ),
            Err(CoreError::Conflict(_))
        ));

        // SKILL.md 삭제는 거부한다.
        assert!(update_common_skill_from_home(
            home,
            &UpdateCommonSkillRequest {
                key: "editable".to_owned(),
                files: Vec::new(),
                deletes: vec!["SKILL.md".to_owned()],
                expected_digest: receipt.content_digest.clone(),
            },
        )
        .is_err());

        assert!(matches!(
            update_common_skill_from_home(
                home,
                &UpdateCommonSkillRequest {
                    key: "editable".to_owned(),
                    files: vec![SkillFileWrite {
                        path: ".agent-manager/resource.json".to_owned(),
                        content: "{}".to_owned(),
                    }],
                    deletes: Vec::new(),
                    expected_digest: receipt.content_digest,
                },
            ),
            Err(CoreError::InvalidInput(_))
        ));
    }

    #[test]
    fn platform_variant_is_stored_without_running_generated_content() {
        let data = TempDir::new().expect("data");
        create_common_skill(
            data.path(),
            &CreateCommonSkillRequest {
                key: "cross-platform".to_owned(),
                name: None,
                description: "OS별 실행 파일 테스트".to_owned(),
            },
        )
        .expect("create");
        let directory = repository_skills_root(data.path()).join("cross-platform");
        fs::create_dir_all(directory.join("scripts")).expect("scripts");
        fs::write(directory.join("scripts/run.sh"), "#!/bin/sh\n").expect("base script");
        let source_digest = read_skill_content(&directory).expect("content").digest;
        let target = match HostPlatform::current() {
            HostPlatform::Windows => HostPlatform::Linux,
            HostPlatform::Macos | HostPlatform::Linux => HostPlatform::Windows,
        };
        let receipt = save_skill_platform_variant(
            data.path(),
            &[],
            &SaveSkillPlatformVariantRequest {
                key: "cross-platform".to_owned(),
                target_platform: target,
                source_platform: Some(HostPlatform::current()),
                files: vec![SkillFileWrite {
                    path: "scripts/run.ps1".to_owned(),
                    content: "generated but not executed\n".to_owned(),
                }],
                deletes: vec!["scripts/run.sh".to_owned()],
                expected_digest: source_digest,
            },
        )
        .expect("save variant");
        assert!(receipt.results.is_empty());
        let manifest = checked_resource_manifest(&directory).expect("manifest");
        assert_eq!(manifest.platforms, vec![HostPlatform::current()]);
        assert_eq!(
            fs::read_to_string(
                directory
                    .join(manifest.active_variant(target).expect("variant"))
                    .join("scripts/run.ps1")
            )
            .expect("variant file"),
            "generated but not executed\n"
        );
        let content = read_skill_content(&directory).expect("content");
        let projected = projected_skill_files(&directory, &content, &manifest, target)
            .expect("projected files");
        assert!(!projected.contains_key(Path::new("scripts/run.sh")));
        assert!(projected.contains_key(Path::new("scripts/run.ps1")));
    }

    #[test]
    fn supported_platform_metadata_uses_expected_digest_and_deduplicates() {
        let data = TempDir::new().expect("data");
        let source = create_common_skill(
            data.path(),
            &CreateCommonSkillRequest {
                key: "platform-meta".to_owned(),
                name: None,
                description: "platform metadata".to_owned(),
            },
        )
        .expect("create");

        let updated = set_skill_platforms(
            data.path(),
            &[],
            &SetSkillPlatformsRequest {
                key: "platform-meta".to_owned(),
                platforms: vec![HostPlatform::Macos, HostPlatform::Macos],
                expected_digest: source.content_digest.clone(),
            },
        )
        .expect("set platforms");
        let directory = repository_skills_root(data.path()).join("platform-meta");
        assert_eq!(
            checked_resource_manifest(&directory).unwrap().platforms,
            vec![HostPlatform::Macos]
        );
        assert!(matches!(
            set_skill_platforms(
                data.path(),
                &[],
                &SetSkillPlatformsRequest {
                    key: "platform-meta".to_owned(),
                    platforms: vec![HostPlatform::Linux],
                    expected_digest: source.content_digest,
                },
            ),
            Err(CoreError::Conflict(_))
        ));
        assert_ne!(updated.content_digest, "");
    }

    #[test]
    fn purge_removes_trash_entries() {
        let home_dir = TempDir::new().expect("home");
        let data_dir = TempDir::new().expect("data");
        let home = home_dir.path();
        for key in ["one", "two"] {
            let installed = home.join(".codex/skills").join(key);
            write_skill(&installed, key, "Purge target");
            delete_installed_skill_from_home(
                home,
                data_dir.path(),
                &DeleteInstalledSkillRequest {
                    id: installed_skill_id(&installed),
                    deleted_by: None,
                    confirm: true,
                },
            )
            .expect("delete");
        }
        let overview = list_skill_trash(data_dir.path()).expect("list");
        assert_eq!(overview.items.len(), 2);

        assert!(purge_skill_trash(data_dir.path(), Some("../escape")).is_err());
        assert_eq!(
            purge_skill_trash(data_dir.path(), Some(&overview.items[0].id)).expect("purge one"),
            1
        );
        assert_eq!(
            purge_skill_trash(data_dir.path(), None).expect("purge all"),
            1
        );
        assert!(list_skill_trash(data_dir.path())
            .expect("list")
            .items
            .is_empty());
    }

    #[test]
    fn skill_issue_severity_contract() {
        assert_eq!(SkillIssueSeverity::ALL.len(), 2);

        for severity in SkillIssueSeverity::ALL {
            assert_eq!(severity.to_string(), severity.as_str());
            let parsed: SkillIssueSeverity = severity
                .as_str()
                .parse()
                .expect("as_str로 직렬화된 문자열은 파싱되어야 함");
            assert_eq!(parsed, severity);

            let json = serde_json::to_string(&severity).expect("직렬화 성공");
            assert_eq!(json, format!("\"{}\"", severity.as_str()));
            let deserialized: SkillIssueSeverity =
                serde_json::from_str(&json).expect("역직렬화 성공");
            assert_eq!(deserialized, severity);
        }

        assert!(SkillIssueSeverity::Blocking.is_blocking());
        assert!(!SkillIssueSeverity::Blocking.is_warning());

        assert!(SkillIssueSeverity::Warning.is_warning());
        assert!(!SkillIssueSeverity::Warning.is_blocking());

        assert!("invalid".parse::<SkillIssueSeverity>().is_err());
    }

    #[test]
    fn skill_overwrite_policy_contract() {
        assert_eq!(SkillOverwritePolicy::ALL.len(), 2);
        assert_eq!(SkillOverwritePolicy::default(), SkillOverwritePolicy::Fail);

        for policy in SkillOverwritePolicy::ALL {
            assert_eq!(policy.to_string(), policy.as_str());
            let parsed: SkillOverwritePolicy = policy
                .as_str()
                .parse()
                .expect("as_str로 직렬화된 문자열은 파싱되어야 함");
            assert_eq!(parsed, policy);

            let json = serde_json::to_string(&policy).expect("직렬화 성공");
            assert_eq!(json, format!("\"{}\"", policy.as_str()));
            let deserialized: SkillOverwritePolicy =
                serde_json::from_str(&json).expect("역직렬화 성공");
            assert_eq!(deserialized, policy);
        }

        assert!(SkillOverwritePolicy::Fail.is_fail());
        assert!(!SkillOverwritePolicy::Fail.is_replace());

        assert!(SkillOverwritePolicy::Replace.is_replace());
        assert!(!SkillOverwritePolicy::Replace.is_fail());

        assert!("unknown".parse::<SkillOverwritePolicy>().is_err());
    }

    #[test]
    fn skill_publish_outcome_contract() {
        assert_eq!(SkillPublishOutcome::ALL.len(), 5);

        for outcome in SkillPublishOutcome::ALL {
            assert_eq!(outcome.to_string(), outcome.as_str());
            let parsed: SkillPublishOutcome = outcome
                .as_str()
                .parse()
                .expect("as_str로 직렬화된 문자열은 파싱되어야 함");
            assert_eq!(parsed, outcome);

            let json = serde_json::to_string(&outcome).expect("직렬화 성공");
            assert_eq!(json, format!("\"{}\"", outcome.as_str()));
            let deserialized: SkillPublishOutcome =
                serde_json::from_str(&json).expect("역직렬화 성공");
            assert_eq!(deserialized, outcome);
        }

        assert!(SkillPublishOutcome::Published.is_published());
        assert!(SkillPublishOutcome::Published.is_successful());
        assert!(!SkillPublishOutcome::Published.is_failed());

        assert!(SkillPublishOutcome::Replaced.is_replaced());
        assert!(SkillPublishOutcome::Replaced.is_successful());

        assert!(SkillPublishOutcome::Unchanged.is_unchanged());
        assert!(SkillPublishOutcome::Unchanged.is_successful());

        assert!(SkillPublishOutcome::Skipped.is_skipped());
        assert!(!SkillPublishOutcome::Skipped.is_successful());

        assert!(SkillPublishOutcome::Failed.is_failed());
        assert!(!SkillPublishOutcome::Failed.is_successful());

        assert!("invalid".parse::<SkillPublishOutcome>().is_err());
    }

    #[test]
    fn skill_file_change_status_contract() {
        assert_eq!(SkillFileChangeStatus::ALL.len(), 3);

        for status in SkillFileChangeStatus::ALL {
            assert_eq!(status.to_string(), status.as_str());
            let parsed: SkillFileChangeStatus = status
                .as_str()
                .parse()
                .expect("as_str로 직렬화된 문자열은 파싱되어야 함");
            assert_eq!(parsed, status);

            let json = serde_json::to_string(&status).expect("직렬화 성공");
            assert_eq!(json, format!("\"{}\"", status.as_str()));
            let deserialized: SkillFileChangeStatus =
                serde_json::from_str(&json).expect("역직렬화 성공");
            assert_eq!(deserialized, status);
        }

        assert!(SkillFileChangeStatus::Added.is_added());
        assert!(!SkillFileChangeStatus::Added.is_removed());
        assert!(!SkillFileChangeStatus::Added.is_modified());

        assert!(SkillFileChangeStatus::Removed.is_removed());
        assert!(!SkillFileChangeStatus::Removed.is_added());
        assert!(!SkillFileChangeStatus::Removed.is_modified());

        assert!(SkillFileChangeStatus::Modified.is_modified());
        assert!(!SkillFileChangeStatus::Modified.is_added());
        assert!(!SkillFileChangeStatus::Modified.is_removed());

        assert!("invalid".parse::<SkillFileChangeStatus>().is_err());
    }
}
