//! Cypress 자동화 작업공간.
//!
//! 앱이 관리하는 Cypress 프로젝트 폴더(`cypress.config.*`·`cypress.env.json`·`support/`·`e2e/`)를
//! 등록하고 파일을 편집한다. 실행은 `cypress_runs`가 맡는다. 웹 테스트뿐 아니라 정보 조회·
//! 크롤링·매크로처럼 브라우저로 하는 일을 스크립트로 적어 두는 자리다.
//!
//! 비밀은 `cypress.env.json` 하나에만 있다(0600). 이 파일의 원문은 호스트 UI 전용 명령
//! (`read_cypress_env_file`·`write_cypress_env_file`)으로만 오가고, 일반 파일 읽기·AIA·원격은
//! 문자열 값이 가려진 사본만 받는다(AGENTS.md C7). 백엔드는 실행 때도 이 값을 만지지 않는다 —
//! Cypress가 프로젝트 루트의 파일을 직접 읽는다.

use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;
use walkdir::WalkDir;

use crate::app_data_file::{read_private_json, write_private_bytes, write_private_json};
use crate::clock::now_ms;
use crate::path_guard::{self, CurDirPolicy, RelativePathIssue, RootLabels};
use crate::store_lock;
use crate::CoreError;

const REGISTRY_FILE: &str = "cypress-workspaces-v1.json";
const REGISTRY_LOCK: &str = "cypress-workspaces-v1.lock";
const SCHEMA_VERSION: u32 = 1;
/// 비밀을 담는 유일한 파일. 원문은 전용 명령으로만 오간다.
pub(crate) const ENV_FILE: &str = "cypress.env.json";
/// "그 파일이 없다"는 실패의 접두사. 화면이 이 문구로 "새 파일을 여는 것"과 "읽기에 실패한 것"을
/// 가른다 — 가르지 못하면 있는 파일을 빈 내용으로 열어 저장 순간 원본을 지운다.
/// 문구를 바꾸면 같은 상수를 들고 있는 `src/lib/cypressWorkspace.ts`도 함께 바꿔야 한다.
pub(crate) const MISSING_FILE_PREFIX: &str = "파일이 없습니다: ";
/// v1 저장본에서 앱이 자동으로 만들던 작업공간 ID. 새 버전은 암묵적인 작업공간을 만들지
/// 않고, 이 레코드를 마이그레이션 때 등록부에서 제거한다.
const LEGACY_DEFAULT_WORKSPACE_ID: &str = "default";
const LEGACY_WORKSPACE_TRASH_DIR: &str = "cypress-workspace-trash";
const MAX_FILES: usize = 2_000;
const MAX_TEXT_BYTES: u64 = 512 * 1024;
const CONFIG_CANDIDATES: [&str; 4] = [
    "cypress.config.js",
    "cypress.config.cjs",
    "cypress.config.mjs",
    "cypress.config.ts",
];
/// 편집을 막는 최상위 폴더. 모듈·실행 산출물·VCS 내부는 앱이 관리하는 자리라 사람이 고치면
/// 다음 설치·실행·체크아웃에 덮이거나 저장소를 망가뜨린다.
/// 목록을 바꾸면 같은 목록을 들고 있는 `src/lib/cypressWorkspace.ts`도 함께 바꿔야 한다.
const DENIED_TOP_DIRS: [&str; 3] = ["node_modules", "artifacts", ".git"];
/// 목록에서만 빼는 빌드 산출물 폴더. 막지는 않는다 — 고쳐도 다시 만들어질 뿐이라 편집 금지까지
/// 걸 이유는 없고, 목록에 있으면 진짜 편집 대상을 덮어 버린다. 저장소를 그대로 작업공간으로
/// 등록하면 `target/` 한 곳만 70만 개라 목록이 상한에 걸려 통째로 죽었다.
const BUILD_OUTPUT_DIRS: [&str; 5] = ["target", "dist", "build", "out", "coverage"];
const MASK: &str = "•••";
/// 스크럽 대상 비밀값의 최소 길이. 더 짧은 값은 흔한 문자열과 겹쳐 출력을 망가뜨린다.
const MIN_SECRET_CHARS: usize = 4;
const MAX_WORKSPACE_NAME_CHARS: usize = 60;

const TEMPLATE_FILES: &[(&str, &str)] = &[
    (
        "package.json",
        include_str!("../assets/cypress-workspace-template/package.json"),
    ),
    (
        "cypress.config.js",
        include_str!("../assets/cypress-workspace-template/cypress.config.js"),
    ),
    (
        "support/e2e.js",
        include_str!("../assets/cypress-workspace-template/support/e2e.js"),
    ),
    (
        "support/commands.js",
        include_str!("../assets/cypress-workspace-template/support/commands.js"),
    ),
    (
        "e2e/example.cy.js",
        include_str!("../assets/cypress-workspace-template/e2e/example.cy.js"),
    ),
    (
        "README.md",
        include_str!("../assets/cypress-workspace-template/README.md"),
    ),
];
const TEMPLATE_ENV: &str = "{}\n";

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CypressExecutionType {
    /// 등록한 Cypress 프로젝트를 그대로 실행한다. 외부 사이트와 자체 개발 서버 QA에 쓴다.
    #[default]
    Standard,
    /// Agent Manager 저장소의 `scripts/e2e.mjs` 생명주기로 임시 백엔드와 앱 데이터를 만든다.
    AgentManagerIsolated,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CypressWorkspace {
    pub id: String,
    pub name: String,
    /// Cypress 프로젝트 루트(정규 절대경로). `cypress.config.*`가 있는 폴더. 등록할 때 없었으면
    /// 템플릿을 깔아 만든다.
    pub path: String,
    /// `node_modules/cypress`가 있는 폴더. 없으면 `path` 자신.
    #[serde(default)]
    pub module_dir: Option<String>,
    /// 실행 생명주기. 옛 저장본은 일반 Cypress 실행으로 읽는다.
    #[serde(default)]
    pub execution_type: CypressExecutionType,
    /// 실행 장면을 영상으로 남긴다. 산출물이 커지고 실행도 느려져 기본은 꺼 둔다.
    #[serde(default)]
    pub record_video: bool,
    /// 브라우저 창을 띄운 채 실행한다. 사람이 지켜볼 수 있는 대신 화면이 있는 호스트에서만
    /// 뜨고, 무인 회차에서는 창이 튀어나오므로 기본은 꺼 둔다.
    #[serde(default)]
    pub headed: bool,
    pub created_at: i64,
}

impl CypressWorkspace {
    pub fn project_dir(&self) -> PathBuf {
        PathBuf::from(&self.path)
    }

    pub fn module_dir(&self) -> PathBuf {
        self.module_dir
            .as_deref()
            .map(PathBuf::from)
            .unwrap_or_else(|| self.project_dir())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredRegistry {
    schema_version: u32,
    #[serde(default)]
    enabled: bool,
    #[serde(default)]
    workspaces: Vec<CypressWorkspace>,
}

/// 화면·AIA에 보내는 작업공간 요약. 모듈 설치 상태는 조회 시점에 파일로 판정한다.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CypressWorkspaceView {
    #[serde(flatten)]
    pub workspace: CypressWorkspace,
    pub module_ready: bool,
    pub cypress_version: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CypressRegistryView {
    pub enabled: bool,
    pub workspaces: Vec<CypressWorkspaceView>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CypressWorkspaceFile {
    pub path: String,
    pub size_bytes: u64,
    /// `cypress.env.json`. 원문은 호스트 전용 명령으로만.
    pub sensitive: bool,
}

/// 파일 목록과 그것이 온전한지 여부. 상한에 걸리면 목록을 거기서 끊고 `truncated`로 알린다 —
/// 예전에는 오류를 돌려줘 목록 전체가 사라졌고, 그러면 화면은 편집할 파일을 하나도 고를 수
/// 없었다(실행 탭의 스펙 목록까지 같이 비었다). 끊긴 뒤에도 경로를 직접 대는 읽기·쓰기·실행은
/// 그대로 된다.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CypressWorkspaceFileList {
    pub files: Vec<CypressWorkspaceFile>,
    pub truncated: bool,
    pub limit: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CypressWorkspaceFileContent {
    pub path: String,
    pub content: String,
    pub sensitive: bool,
    /// 문자열 값이 가려진 사본이면 true. 편집·저장할 수 없다.
    pub masked: bool,
}

fn with_lock<T>(
    app_data_dir: &Path,
    action: impl FnOnce(&Path) -> Result<T, CoreError>,
) -> Result<T, CoreError> {
    fs::create_dir_all(app_data_dir)?;
    let canonical = fs::canonicalize(app_data_dir)?;
    let _lock = store_lock::acquire(&canonical, REGISTRY_LOCK, "Cypress 작업공간")?;
    action(&canonical)
}

/// 새 작업공간의 템플릿 파일을 채운다. 이미 있는 파일은 건드리지 않는다 — 사용자·AIA가
/// 고친 내용을 앱 업데이트가 덮어쓰면 안 된다.
fn ensure_template_files(directory: &Path) -> Result<(), CoreError> {
    fs::create_dir_all(directory)?;
    for (relative, content) in TEMPLATE_FILES {
        let target = directory.join(relative);
        if target.exists() {
            continue;
        }
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(&target, content)?;
    }
    let env = directory.join(ENV_FILE);
    if !env.exists() {
        write_private_bytes(&env, TEMPLATE_ENV.as_bytes())?;
    }
    Ok(())
}

/// 예전 기본 작업공간은 활성 경로에서 없애되, 그 안의 사용자 작성 스펙은 복구할 수 있게 앱
/// 데이터의 전용 보관 폴더로 한 번 옮긴다. 저장본이 조작돼 다른 경로를 `default`라 부르는
/// 경우에는 등록만 제거하고 그 폴더는 건드리지 않는다.
fn archive_legacy_default_workspace(
    app_data_dir: &Path,
    workspace: &CypressWorkspace,
) -> Result<(), CoreError> {
    let expected = app_data_dir.join("aia-workspace/cypress/default");
    let metadata = match fs::symlink_metadata(&expected) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    };
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Ok(());
    }
    let expected = fs::canonicalize(expected)?;
    let registered = fs::canonicalize(workspace.project_dir()).ok();
    if registered.as_deref() != Some(expected.as_path()) {
        return Ok(());
    }
    let trash = app_data_dir.join(LEGACY_WORKSPACE_TRASH_DIR);
    fs::create_dir_all(&trash)?;
    let destination = trash.join(format!("default-{}-{}", now_ms(), Uuid::new_v4().simple()));
    fs::rename(expected, destination)?;
    Ok(())
}

fn load_unlocked(app_data_dir: &Path) -> Result<StoredRegistry, CoreError> {
    let path = app_data_dir.join(REGISTRY_FILE);
    let mut registry = match read_private_json::<StoredRegistry>(&path)? {
        Some(stored) if stored.schema_version != SCHEMA_VERSION => {
            return Err(CoreError::Runtime(format!(
                "Cypress 작업공간 저장본 버전({})을 읽을 수 없습니다",
                stored.schema_version
            )))
        }
        Some(stored) => stored,
        None => StoredRegistry {
            schema_version: SCHEMA_VERSION,
            enabled: false,
            workspaces: Vec::new(),
        },
    };
    for workspace in registry
        .workspaces
        .iter()
        .filter(|workspace| workspace.id == LEGACY_DEFAULT_WORKSPACE_ID)
    {
        archive_legacy_default_workspace(app_data_dir, workspace)?;
    }
    let before = registry.workspaces.len();
    registry
        .workspaces
        .retain(|workspace| workspace.id != LEGACY_DEFAULT_WORKSPACE_ID);
    let changed = registry.workspaces.len() != before;
    if changed || !path.is_file() {
        save_unlocked(app_data_dir, &registry)?;
    }
    Ok(registry)
}

fn save_unlocked(app_data_dir: &Path, registry: &StoredRegistry) -> Result<(), CoreError> {
    write_private_json(&app_data_dir.join(REGISTRY_FILE), registry)
}

fn module_version(workspace: &CypressWorkspace) -> Option<String> {
    let package = workspace
        .module_dir()
        .join("node_modules")
        .join("cypress")
        .join("package.json");
    let bytes = fs::read(package).ok()?;
    let value: Value = serde_json::from_slice(&bytes).ok()?;
    value
        .get("version")
        .and_then(Value::as_str)
        .map(str::to_owned)
}

pub(crate) fn workspace_view(workspace: &CypressWorkspace) -> CypressWorkspaceView {
    let cypress_version = module_version(workspace);
    CypressWorkspaceView {
        workspace: workspace.clone(),
        module_ready: cypress_version.is_some(),
        cypress_version,
    }
}

fn registry_view(registry: &StoredRegistry) -> CypressRegistryView {
    CypressRegistryView {
        enabled: registry.enabled,
        workspaces: registry.workspaces.iter().map(workspace_view).collect(),
    }
}

fn mutate_registry(
    app_data_dir: &Path,
    mutate: impl FnOnce(&mut StoredRegistry) -> Result<(), CoreError>,
) -> Result<CypressRegistryView, CoreError> {
    with_lock(app_data_dir, |dir| {
        let mut registry = load_unlocked(dir)?;
        mutate(&mut registry)?;
        save_unlocked(dir, &registry)?;
        Ok(registry_view(&registry))
    })
}

pub fn registry(app_data_dir: &Path) -> Result<CypressRegistryView, CoreError> {
    with_lock(app_data_dir, |dir| Ok(registry_view(&load_unlocked(dir)?)))
}

pub fn is_enabled(app_data_dir: &Path) -> Result<bool, CoreError> {
    with_lock(app_data_dir, |dir| Ok(load_unlocked(dir)?.enabled))
}

pub fn set_enabled(app_data_dir: &Path, enabled: bool) -> Result<CypressRegistryView, CoreError> {
    mutate_registry(app_data_dir, |registry| {
        registry.enabled = enabled;
        Ok(())
    })
}

pub fn workspace(app_data_dir: &Path, id: &str) -> Result<CypressWorkspace, CoreError> {
    with_lock(app_data_dir, |dir| {
        load_unlocked(dir)?
            .workspaces
            .into_iter()
            .find(|workspace| workspace.id == id)
            .ok_or_else(|| {
                CoreError::NotFound(format!("Cypress 작업공간을 찾을 수 없습니다: {id}"))
            })
    })
}

fn has_config(directory: &Path) -> bool {
    CONFIG_CANDIDATES
        .iter()
        .any(|name| directory.join(name).is_file())
}

/// 템플릿 파일 목록에서 지정한 상대 경로의 파일 내용을 찾는다.
fn template_file_content(target_relative: &str) -> Option<&'static str> {
    TEMPLATE_FILES
        .iter()
        .find(|(relative, _)| *relative == target_relative)
        .map(|(_, content)| *content)
}

/// 모듈 위치에 `package.json`이 없으면 템플릿의 것을 둔다. `npm install --save-dev`는
/// package.json이 없는 폴더에서 상위 폴더의 것을 찾아 올라가므로, 비워 두면 엉뚱한 프로젝트에
/// cypress가 들어간다. 이미 있으면 사용자 프로젝트의 것이라 건드리지 않는다.
pub(crate) fn ensure_module_package_json(module_dir: &Path) -> Result<bool, CoreError> {
    let target = module_dir.join("package.json");
    if target.is_file() {
        return Ok(false);
    }
    let content = template_file_content("package.json").unwrap_or("{\n  \"private\": true\n}\n");
    fs::create_dir_all(module_dir)?;
    fs::write(&target, content)?;
    Ok(true)
}

/// 폴더를 작업공간으로 등록할 때의 검증. 공급자 홈과 Agent Manager 데이터 안은 등록할 수 없다.
fn validate_external_dir(
    app_data_dir: &Path,
    raw: &str,
    label: &str,
) -> Result<PathBuf, CoreError> {
    let directory = crate::user_path::resolve_existing_directory(raw)?;
    if crate::store::is_restricted_doc_root(app_data_dir, &directory) {
        return Err(CoreError::InvalidInput(format!(
            "{label}은(는) 공급자 홈이나 Agent Manager 데이터 안의 폴더를 쓸 수 없습니다: {}",
            directory.display()
        )));
    }
    Ok(directory)
}

pub fn add_workspace(
    app_data_dir: &Path,
    name: &str,
    path: &str,
    module_dir: Option<&str>,
) -> Result<CypressRegistryView, CoreError> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > MAX_WORKSPACE_NAME_CHARS {
        return Err(CoreError::InvalidInput(format!(
            "작업공간 이름은 1~{MAX_WORKSPACE_NAME_CHARS}자여야 합니다"
        )));
    }
    let project = validate_external_dir(app_data_dir, path, "작업공간 폴더")?;
    // Cypress 설정이 없는 폴더는 빈 프로젝트로 보고 작업공간 템플릿을 깐다.
    // 이미 있는 파일은 건드리지 않으므로 기존 프로젝트의 package.json은 그대로 남는다.
    // 예전에는 여기서 거절했는데, 사용자는 새 폴더를 골라 "등록하면 설치까지 되는" 흐름을
    // 기대했고 빈 폴더에 cypress.config.js를 손으로 만들어 오라는 요구가 됐다.
    let scaffolded = !has_config(&project);
    if scaffolded {
        ensure_template_files(&project)?;
    }
    let module_dir = match module_dir.map(str::trim).filter(|value| !value.is_empty()) {
        // 모듈 위치는 없으면 만든다(있는 상위 아래 한 칸). 새 프로젝트에서 모듈만 따로 두려는
        // 입력이 흔하고, 설치가 그 폴더에서 돌아야 하므로 등록 시점에 실재하게 한다.
        Some(raw) => Some(crate::user_path::create_user_directory(app_data_dir, raw)?),
        None => None,
    };
    mutate_registry(app_data_dir, |registry| {
        let project_text = project.to_string_lossy().into_owned();
        if registry
            .workspaces
            .iter()
            .any(|workspace| workspace.path == project_text)
        {
            return Err(CoreError::Conflict(
                "이미 등록된 작업공간 폴더입니다".to_owned(),
            ));
        }
        registry.workspaces.push(CypressWorkspace {
            id: Uuid::new_v4().simple().to_string(),
            name: name.to_owned(),
            path: project_text,
            module_dir: module_dir.map(|value| value.to_string_lossy().into_owned()),
            execution_type: CypressExecutionType::Standard,
            record_video: false,
            headed: false,
            created_at: now_ms(),
        });
        Ok(())
    })
}

/// 등록만 지운다. 폴더와 파일은 사용자 소유라 건드리지 않는다.
pub fn remove_workspace(app_data_dir: &Path, id: &str) -> Result<CypressRegistryView, CoreError> {
    mutate_registry(app_data_dir, |registry| {
        let Some(index) = registry
            .workspaces
            .iter()
            .position(|workspace| workspace.id == id)
        else {
            return Err(CoreError::NotFound(format!(
                "Cypress 작업공간을 찾을 수 없습니다: {id}"
            )));
        };
        registry.workspaces.remove(index);
        Ok(())
    })
}

/// 작업공간마다 저장하는 실행 옵션(영상 저장·창 표시). 실행 요청이 아니라 작업공간에 두는
/// 것은, 같은 작업공간을 사람이 눌러 돌리든 에이전트가 돌리든 같은 방식으로 보이길 바라는
/// 설정이기 때문이다 — 에이전트가 실행할 때만 창이 안 뜨면 "왜 아무것도 안 보이나"가 된다.
pub fn set_workspace_options(
    app_data_dir: &Path,
    id: &str,
    record_video: bool,
    headed: bool,
    execution_type: Option<CypressExecutionType>,
) -> Result<CypressRegistryView, CoreError> {
    mutate_registry(app_data_dir, |registry| {
        let Some(workspace) = registry
            .workspaces
            .iter_mut()
            .find(|workspace| workspace.id == id)
        else {
            return Err(CoreError::NotFound(format!(
                "Cypress 작업공간을 찾을 수 없습니다: {id}"
            )));
        };
        workspace.record_video = record_video;
        workspace.headed = headed;
        if let Some(execution_type) = execution_type {
            workspace.execution_type = execution_type;
        }
        Ok(())
    })
}

/// 작업공간 안의 상대 경로만 허용한다. `..`·절대경로·`.`·빈 경로는 거절.
pub(crate) fn validate_relative_path(raw: &str) -> Result<PathBuf, CoreError> {
    let relative = Path::new(raw.trim());
    if let Some(issue) = path_guard::classify_relative_path(relative, CurDirPolicy::Reject) {
        return Err(CoreError::InvalidInput(match issue {
            RelativePathIssue::Empty => "파일 경로가 비어 있습니다".to_owned(),
            RelativePathIssue::EmptyComponent => {
                format!("파일 경로가 올바르지 않습니다: {raw}")
            }
            RelativePathIssue::ParentDir => {
                format!("파일 경로가 작업공간을 벗어납니다: {raw}")
            }
            RelativePathIssue::CurDir | RelativePathIssue::Absolute => {
                format!("파일 경로는 작업공간 기준 상대 경로여야 합니다: {raw}")
            }
        }));
    }
    if relative.components().next().is_some_and(|first| {
        DENIED_TOP_DIRS.contains(&first.as_os_str().to_string_lossy().as_ref())
    }) {
        return Err(CoreError::InvalidInput(format!(
            "{} 아래는 편집할 수 없습니다: {raw}",
            DENIED_TOP_DIRS.join("·")
        )));
    }
    Ok(relative.to_path_buf())
}

const WORKSPACE_PATH_LABELS: RootLabels = RootLabels {
    subject: "파일 경로",
    escaped: "파일 경로가 작업공간을 벗어납니다",
};

/// 아직 없는 파일도 존재하는 상위까지 정규화해 루트 안인지 확인한다(심링크 탈출 방지).
fn assert_within_root(root: &Path, candidate: &Path) -> Result<(), CoreError> {
    path_guard::assert_within_root(root, candidate, WORKSPACE_PATH_LABELS)
}

/// 파일 경로의 구성 요소를 슬래시('/')로 연결한 상대 경로 문자열을 반환한다.
pub(crate) fn relative_slash_path(path: &Path) -> String {
    path.components()
        .map(|component| component.as_os_str().to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join("/")
}

fn is_sensitive(relative: &Path) -> bool {
    relative == Path::new(ENV_FILE)
}

/// 작업공간에서 삭제가 금지된 필수 파일인지 검사한다(환경 파일 또는 Cypress 설정 파일).
fn is_protected_workspace_file(relative: &Path, slash_path: &str) -> bool {
    is_sensitive(relative) || CONFIG_CANDIDATES.contains(&slash_path)
}

fn resolve_file(workspace: &CypressWorkspace, raw: &str) -> Result<(PathBuf, PathBuf), CoreError> {
    let relative = validate_relative_path(raw)?;
    let root = workspace.project_dir();
    let target = root.join(&relative);
    assert_within_root(&root, &target)?;
    Ok((relative, target))
}

/// 편집기 목록에서 뺄 폴더 이름인지. 편집 금지 폴더와 빌드 산출물을 함께 거른다. 이름만 보므로
/// 어느 깊이에 있든 걸린다.
fn is_skipped_dir(name: &str) -> bool {
    DENIED_TOP_DIRS.contains(&name) || BUILD_OUTPUT_DIRS.contains(&name)
}

pub fn list_files(workspace: &CypressWorkspace) -> Result<CypressWorkspaceFileList, CoreError> {
    let root = workspace.project_dir();
    if !root.is_dir() {
        return Err(CoreError::NotFound(format!(
            "작업공간 폴더가 없습니다: {}",
            root.display()
        )));
    }
    let mut files = Vec::new();
    let mut truncated = false;
    let walker = WalkDir::new(&root)
        .follow_links(false)
        .sort_by_file_name()
        .into_iter()
        .filter_entry(|entry| {
            let name = entry.file_name().to_string_lossy();
            entry.depth() == 0 || (!is_skipped_dir(name.as_ref()) && !name.starts_with('.'))
        });
    for entry in walker {
        let entry = match entry {
            Ok(entry) => entry,
            // 순회 도중 사라지거나 막힌 항목 하나 때문에 목록 전체를 버리지 않는다. 작업공간은
            // 사람과 다른 도구가 같이 쓰는 폴더라 읽는 사이에 파일이 바뀐다.
            Err(error)
                if error.io_error().is_some_and(|io| {
                    matches!(
                        io.kind(),
                        std::io::ErrorKind::NotFound | std::io::ErrorKind::PermissionDenied
                    )
                }) =>
            {
                continue
            }
            Err(error) => {
                return Err(CoreError::Runtime(format!(
                    "작업공간 파일 목록을 읽지 못했습니다: {error}"
                )))
            }
        };
        if !entry.file_type().is_file() {
            continue;
        }
        if files.len() >= MAX_FILES {
            truncated = true;
            break;
        }
        let relative = entry
            .path()
            .strip_prefix(&root)
            .map_err(|_| CoreError::Runtime("작업공간 경로 계산 실패".to_owned()))?;
        files.push(CypressWorkspaceFile {
            path: relative_slash_path(relative),
            size_bytes: entry.metadata().map(|meta| meta.len()).unwrap_or(0),
            sensitive: is_sensitive(relative),
        });
    }
    Ok(CypressWorkspaceFileList {
        files,
        truncated,
        limit: MAX_FILES,
    })
}

fn read_text_limited(path: &Path) -> Result<String, CoreError> {
    let metadata = fs::metadata(path)
        .map_err(|_| CoreError::NotFound(format!("{MISSING_FILE_PREFIX}{}", path.display())))?;
    if !metadata.is_file() {
        return Err(CoreError::InvalidInput(format!(
            "파일이 아닙니다: {}",
            path.display()
        )));
    }
    if metadata.len() > MAX_TEXT_BYTES {
        return Err(CoreError::TooLarge(MAX_TEXT_BYTES));
    }
    Ok(String::from_utf8_lossy(&fs::read(path)?).into_owned())
}

/// JSON 값 트리를 순회하며 모든 문자열 노드를 가변 참조로 방문한다.
fn walk_json_strings_mut(value: &mut Value, visitor: &mut impl FnMut(&mut String)) {
    match value {
        Value::String(text) => visitor(text),
        Value::Array(items) => items
            .iter_mut()
            .for_each(|item| walk_json_strings_mut(item, visitor)),
        Value::Object(map) => map
            .values_mut()
            .for_each(|item| walk_json_strings_mut(item, visitor)),
        _ => {}
    }
}

/// JSON 값 트리를 순회하며 모든 문자열 노드를 읽기 전용으로 방문한다.
fn walk_json_strings(value: &Value, visitor: &mut impl FnMut(&str)) {
    match value {
        Value::String(text) => visitor(text),
        Value::Array(items) => items
            .iter()
            .for_each(|item| walk_json_strings(item, visitor)),
        Value::Object(map) => map
            .values()
            .for_each(|item| walk_json_strings(item, visitor)),
        _ => {}
    }
}

/// 문자열 값을 모두 가린 JSON. 구조와 키는 남겨 AIA가 어떤 키를 `Cypress.env`로 읽을지 알 수 있게 한다.
pub(crate) fn mask_env_json(text: &str) -> String {
    match serde_json::from_str::<Value>(text) {
        Ok(mut value) => {
            walk_json_strings_mut(&mut value, &mut |text| *text = MASK.to_owned());
            serde_json::to_string_pretty(&value).unwrap_or_else(|_| MASK.to_owned())
        }
        Err(_) => MASK.to_owned(),
    }
}

/// 일반 파일 읽기. env 파일은 항상 가려진 사본이다.
pub fn read_file(
    workspace: &CypressWorkspace,
    raw: &str,
) -> Result<CypressWorkspaceFileContent, CoreError> {
    let (relative, target) = resolve_file(workspace, raw)?;
    let sensitive = is_sensitive(&relative);
    let content = read_text_limited(&target)?;
    Ok(CypressWorkspaceFileContent {
        path: relative_slash_path(&relative),
        content: if sensitive {
            mask_env_json(&content)
        } else {
            content
        },
        sensitive,
        masked: sensitive,
    })
}

/// env 파일 원문. 호스트 UI 전용 명령에서만 부른다.
pub fn read_env_file(
    workspace: &CypressWorkspace,
) -> Result<CypressWorkspaceFileContent, CoreError> {
    let target = workspace.project_dir().join(ENV_FILE);
    let content = if target.exists() {
        read_text_limited(&target)?
    } else {
        TEMPLATE_ENV.to_owned()
    };
    Ok(CypressWorkspaceFileContent {
        path: ENV_FILE.to_owned(),
        content,
        sensitive: true,
        masked: false,
    })
}

fn validate_text_payload_size(content: &str) -> Result<(), CoreError> {
    if content.len() as u64 > MAX_TEXT_BYTES {
        return Err(CoreError::TooLarge(MAX_TEXT_BYTES));
    }
    Ok(())
}

fn workspace_file_receipt(
    path: String,
    content_len: usize,
    sensitive: bool,
) -> CypressWorkspaceFile {
    CypressWorkspaceFile {
        path,
        size_bytes: content_len as u64,
        sensitive,
    }
}

pub fn write_file(
    workspace: &CypressWorkspace,
    raw: &str,
    content: &str,
) -> Result<CypressWorkspaceFile, CoreError> {
    let (relative, target) = resolve_file(workspace, raw)?;
    if is_sensitive(&relative) {
        return Err(CoreError::InvalidInput(
            "cypress.env.json은 설정 화면의 전용 편집기(write_cypress_env_file)로만 고칠 수 있습니다"
                .to_owned(),
        ));
    }
    validate_text_payload_size(content)?;
    if target.is_dir() {
        return Err(CoreError::InvalidInput(format!(
            "폴더에는 쓸 수 없습니다: {raw}"
        )));
    }
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(&target, content)?;
    Ok(workspace_file_receipt(
        relative_slash_path(&relative),
        content.len(),
        false,
    ))
}

/// env 파일 저장. JSON 객체여야 하고 0600으로 쓴다.
pub fn write_env_file(
    workspace: &CypressWorkspace,
    content: &str,
) -> Result<CypressWorkspaceFile, CoreError> {
    validate_text_payload_size(content)?;
    match serde_json::from_str::<Value>(content) {
        Ok(Value::Object(_)) => {}
        Ok(_) => {
            return Err(CoreError::InvalidInput(
                "cypress.env.json은 JSON 객체여야 합니다".to_owned(),
            ))
        }
        Err(error) => {
            return Err(CoreError::InvalidInput(format!(
                "cypress.env.json이 올바른 JSON이 아닙니다: {error}"
            )))
        }
    }
    let target = workspace.project_dir().join(ENV_FILE);
    write_private_bytes(&target, content.as_bytes())?;
    Ok(workspace_file_receipt(
        ENV_FILE.to_owned(),
        content.len(),
        true,
    ))
}

pub fn delete_file(workspace: &CypressWorkspace, raw: &str) -> Result<(), CoreError> {
    let (relative, target) = resolve_file(workspace, raw)?;
    let text = relative_slash_path(&relative);
    if is_protected_workspace_file(&relative, &text) {
        return Err(CoreError::InvalidInput(format!(
            "{text}은(는) 작업공간의 필수 파일이라 지울 수 없습니다"
        )));
    }
    if !target.is_file() {
        return Err(CoreError::NotFound(format!("{MISSING_FILE_PREFIX}{text}")));
    }
    fs::remove_file(&target)?;
    Ok(())
}

/// 실행 출력에서 지울 비밀값. env 파일의 문자열 값 중 스크럽할 만큼 긴 것만.
pub fn env_secret_values(workspace: &CypressWorkspace) -> Vec<String> {
    let mut values = BTreeSet::new();
    if let Ok(text) = fs::read_to_string(workspace.project_dir().join(ENV_FILE)) {
        if let Ok(value) = serde_json::from_str::<Value>(&text) {
            walk_json_strings(&value, &mut |text| {
                if text.chars().count() >= MIN_SECRET_CHARS {
                    values.insert(text.to_owned());
                }
            });
        }
    }
    let mut result: Vec<String> = values.into_iter().collect();
    result.sort_by_key(|value| std::cmp::Reverse(value.len()));
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn fixture() -> (TempDir, TempDir, CypressWorkspace) {
        let data = TempDir::new().expect("temp app data");
        let registry = registry(data.path()).expect("registry");
        assert!(!registry.enabled, "기본은 꺼짐");
        assert!(
            registry.workspaces.is_empty(),
            "기본 작업공간을 만들지 않음"
        );
        let project = TempDir::new().expect("temp Cypress project");
        let view = add_workspace(data.path(), "test", project.path().to_str().unwrap(), None)
            .expect("add workspace");
        let id = &view.workspaces[0].workspace.id;
        let workspace = workspace(data.path(), id).expect("registered workspace");
        (data, project, workspace)
    }

    #[test]
    fn added_empty_workspace_uses_the_template_with_a_private_env_file() {
        let (data, _project, workspace) = fixture();
        let root = workspace.project_dir();
        assert!(root.join("cypress.config.js").is_file());
        assert!(root.join("support/commands.js").is_file());
        assert!(root.join("e2e/example.cy.js").is_file());
        assert!(root.join(ENV_FILE).is_file());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(root.join(ENV_FILE))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600, "env 파일은 0600");
            let registry_mode = fs::metadata(data.path().join(REGISTRY_FILE))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(registry_mode & 0o777, 0o600);
        }
        // 이미 있는 파일은 다시 채우지 않는다.
        fs::write(root.join("e2e/example.cy.js"), "// edited").unwrap();
        registry(data.path()).unwrap();
        assert_eq!(
            fs::read_to_string(root.join("e2e/example.cy.js")).unwrap(),
            "// edited"
        );
        let listed = list_files(&workspace).unwrap();
        assert!(!listed.truncated);
        let files = listed.files;
        let env = files
            .iter()
            .find(|file| file.path == ENV_FILE)
            .expect("env listed");
        assert!(env.sensitive);
        assert!(files
            .iter()
            .all(|file| !file.path.starts_with("node_modules")));
    }

    /// 실행 옵션은 작업공간에 저장돼 다시 읽어도 남는다. 없던 필드라 옛 저장본에서는 꺼진
    /// 상태로 읽혀야 한다(serde 기본값).
    #[test]
    fn run_options_and_execution_type_are_stored_per_workspace_and_default_to_standard() {
        let (data, _project, workspace) = fixture();
        assert!(!workspace.record_video && !workspace.headed);
        assert_eq!(workspace.execution_type, CypressExecutionType::Standard);

        let view = set_workspace_options(
            data.path(),
            &workspace.id,
            true,
            true,
            Some(CypressExecutionType::AgentManagerIsolated),
        )
        .unwrap();
        let stored = view
            .workspaces
            .iter()
            .find(|item| item.workspace.id == workspace.id)
            .expect("workspace");
        assert!(stored.workspace.record_video && stored.workspace.headed);
        assert_eq!(
            stored.workspace.execution_type,
            CypressExecutionType::AgentManagerIsolated
        );

        let reloaded = super::workspace(data.path(), &workspace.id).unwrap();
        assert!(reloaded.record_video && reloaded.headed);

        set_workspace_options(
            data.path(),
            &workspace.id,
            false,
            false,
            Some(CypressExecutionType::Standard),
        )
        .unwrap();
        let off = super::workspace(data.path(), &workspace.id).unwrap();
        assert!(!off.record_video && !off.headed);
        assert!(matches!(
            set_workspace_options(
                data.path(),
                "없는-작업공간",
                true,
                false,
                Some(CypressExecutionType::Standard)
            ),
            Err(CoreError::NotFound(_))
        ));
    }

    /// 상한을 넘으면 오류 대신 거기서 끊는다. 예전에는 오류였고, 그 바람에 상한을 넘긴
    /// 작업공간은 편집기와 스펙 목록이 통째로 비어 아무 파일도 고를 수 없었다.
    #[test]
    fn a_workspace_over_the_cap_is_truncated_instead_of_failing() {
        let (_data, _project, workspace) = fixture();
        let root = workspace.project_dir();
        let bulk = root.join("e2e/bulk");
        fs::create_dir_all(&bulk).unwrap();
        for index in 0..MAX_FILES {
            fs::write(bulk.join(format!("{index:05}.cy.js")), "//").unwrap();
        }
        let listed = list_files(&workspace).unwrap();
        assert!(listed.truncated);
        assert_eq!(listed.files.len(), MAX_FILES);
        assert_eq!(listed.limit, MAX_FILES);
        // 끊겼어도 경로를 직접 댄 읽기·쓰기는 그대로 된다.
        assert!(read_file(&workspace, "cypress.config.js").is_ok());
    }

    /// 작업공간은 사람과 다른 도구가 같이 쓰는 폴더다. 순회 중 막힌 항목 하나로 목록 전체를
    /// 버리면, 실행이 산출물을 쓰는 동안에는 편집기를 열 수 없다.
    #[cfg(unix)]
    #[test]
    fn an_unreadable_subdirectory_does_not_sink_the_whole_listing() {
        use std::os::unix::fs::PermissionsExt;
        let (_data, _project, workspace) = fixture();
        let blocked = workspace.project_dir().join("e2e/blocked");
        fs::create_dir_all(&blocked).unwrap();
        fs::write(blocked.join("inside.cy.js"), "//").unwrap();
        fs::set_permissions(&blocked, fs::Permissions::from_mode(0o000)).unwrap();
        let listed = list_files(&workspace);
        // 임시 폴더를 지울 수 있게 되돌린 뒤에 판정한다.
        fs::set_permissions(&blocked, fs::Permissions::from_mode(0o755)).unwrap();
        let listed = listed.expect("막힌 폴더가 있어도 목록은 나와야 한다");
        assert!(listed
            .files
            .iter()
            .any(|file| file.path == "e2e/example.cy.js"));
        assert!(!listed
            .files
            .iter()
            .any(|file| file.path == "e2e/blocked/inside.cy.js"));
    }

    /// 화면이 통과시킨 경로를 백엔드가 거절하면 사용자는 다 적고 나서야 못 쓴다는 걸 안다.
    #[test]
    fn denied_top_dirs_match_the_frontend_helper() {
        let source = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../src/lib/cypressWorkspace.ts")
            .canonicalize()
            .expect("frontend helper must exist");
        let text = fs::read_to_string(source).expect("frontend helper must be readable");
        let listed = DENIED_TOP_DIRS
            .iter()
            .map(|name| format!("\"{name}\""))
            .collect::<Vec<_>>()
            .join(", ");
        assert!(
            text.contains(&format!("export const RESERVED_TOP_DIRS = [{listed}];")),
            "src/lib/cypressWorkspace.ts의 편집 금지 폴더 목록이 Rust와 다릅니다"
        );
    }

    /// 화면은 이 접두사로 "새 파일"과 "읽기 실패"를 가른다. 한쪽만 바꾸면 있는 파일을 빈
    /// 내용으로 열어 저장 순간 원본이 지워진다.
    #[test]
    fn missing_file_prefix_matches_the_frontend_helper() {
        let source = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../src/lib/cypressWorkspace.ts")
            .canonicalize()
            .expect("frontend helper must exist");
        let text = fs::read_to_string(source).expect("frontend helper must be readable");
        assert!(
            text.contains(&format!(
                "export const MISSING_FILE_PREFIX = \"{MISSING_FILE_PREFIX}\";"
            )),
            "src/lib/cypressWorkspace.ts의 접두사가 Rust와 다릅니다"
        );
    }

    /// 저장소를 그대로 작업공간으로 등록하면 빌드 산출물이 목록을 뒤덮어 상한에 걸렸다.
    /// 목록에서는 빠지되 편집까지 막지는 않는다 — 두 규칙은 서로 다른 목적이다.
    #[test]
    fn build_output_dirs_are_hidden_from_the_list_but_not_blocked_from_editing() {
        let (_data, _project, workspace) = fixture();
        let root = workspace.project_dir();
        for relative in ["target/debug/a.js", "dist/b.js", "e2e/deep/build/c.js"] {
            let path = root.join(relative);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, "x").unwrap();
        }
        let files = list_files(&workspace).unwrap().files;
        for hidden in ["target/debug/a.js", "dist/b.js", "e2e/deep/build/c.js"] {
            assert!(
                !files.iter().any(|file| file.path == hidden),
                "{hidden} 는 목록에서 빠져야 한다"
            );
        }
        assert!(files.iter().any(|file| file.path == "e2e/example.cy.js"));
        // 막는 것은 모듈·산출물·VCS 뿐이고, 빌드 출력은 경로를 직접 대면 고칠 수 있다.
        assert!(write_file(&workspace, "target/debug/a.js", "y").is_ok());
        assert!(matches!(
            write_file(&workspace, "node_modules/a.js", "y"),
            Err(CoreError::InvalidInput(_))
        ));
    }

    #[test]
    fn env_file_is_masked_on_normal_reads_and_written_only_through_the_dedicated_path() {
        let (_data, _project, workspace) = fixture();
        write_env_file(
            &workspace,
            r#"{"accounts":{"drafter":{"HR_USER":"u@x.com","HR_PASS":"s3cret!"}},"n":1}"#,
        )
        .expect("write env");
        let masked = read_file(&workspace, ENV_FILE).unwrap();
        assert!(masked.masked && masked.sensitive);
        assert!(!masked.content.contains("s3cret!"));
        assert!(masked.content.contains("HR_PASS"), "키는 남긴다");
        assert!(
            masked.content.contains("\"n\": 1"),
            "문자열이 아닌 값은 그대로"
        );
        let raw = read_env_file(&workspace).unwrap();
        assert!(!raw.masked && raw.content.contains("s3cret!"));
        assert!(matches!(
            write_file(&workspace, ENV_FILE, "{}"),
            Err(CoreError::InvalidInput(_))
        ));
        assert!(matches!(
            write_env_file(&workspace, "[1,2]"),
            Err(CoreError::InvalidInput(_))
        ));
        let mut secrets = env_secret_values(&workspace);
        secrets.sort();
        assert_eq!(secrets, vec!["s3cret!".to_owned(), "u@x.com".to_owned()]);
        // 같은 길이의 중복 비밀값도 누락 없이 1번만 남고 긴 순서대로 정렬된다.
        write_env_file(
            &workspace,
            r#"{"a":"alpha","b":"bravo","c":"alpha","long":"longest_secret"}"#,
        )
        .expect("write env with duplicate same-length secrets");
        assert_eq!(
            env_secret_values(&workspace),
            vec![
                "longest_secret".to_owned(),
                "alpha".to_owned(),
                "bravo".to_owned()
            ]
        );
        assert_eq!(mask_env_json("not json"), MASK);
    }

    #[test]
    fn workspace_files_stay_inside_the_project_root() {
        let (_data, _project, workspace) = fixture();
        for bad in [
            "../x.js",
            "/etc/passwd",
            "node_modules/x.js",
            "artifacts/a.json",
            "",
            "./a.js",
        ] {
            assert!(
                matches!(
                    write_file(&workspace, bad, "x"),
                    Err(CoreError::InvalidInput(_))
                ),
                "{bad} 는 거절해야 한다"
            );
        }
        let written = write_file(&workspace, "e2e/new.cy.js", "describe('x', () => {});").unwrap();
        assert_eq!(written.path, "e2e/new.cy.js");
        assert_eq!(
            read_file(&workspace, "e2e/new.cy.js").unwrap().content,
            "describe('x', () => {});"
        );
        delete_file(&workspace, "e2e/new.cy.js").unwrap();
        assert!(matches!(
            delete_file(&workspace, "cypress.config.js"),
            Err(CoreError::InvalidInput(_))
        ));
        assert!(matches!(
            delete_file(&workspace, "e2e/missing.cy.js"),
            Err(CoreError::NotFound(_))
        ));
    }

    /// 설정이 없는 폴더는 거절하지 않고 템플릿을 깐다. 설정이 이미 있으면 그 프로젝트의 파일을
    /// 덮지 않는다.
    #[test]
    fn a_folder_without_a_config_is_scaffolded_and_an_existing_project_is_left_alone() {
        let (data, _project, _workspace) = fixture();
        let empty = TempDir::new().unwrap();
        let view = add_workspace(data.path(), "new", empty.path().to_str().unwrap(), None).unwrap();
        assert!(empty.path().join("cypress.config.js").is_file());
        let config = fs::read_to_string(empty.path().join("cypress.config.js")).unwrap();
        assert!(config.contains("module.exports = {"));
        assert!(!config.contains("require(\"cypress\")"));
        assert!(!config.contains("defineConfig"));
        assert!(empty.path().join("package.json").is_file());
        assert!(empty.path().join("e2e/example.cy.js").is_file());
        assert!(empty.path().join(ENV_FILE).is_file());
        assert!(!view
            .workspaces
            .iter()
            .any(|w| w.workspace.name == "new" && w.module_ready));

        let existing = TempDir::new().unwrap();
        fs::write(
            existing.path().join("cypress.config.ts"),
            "export default {};",
        )
        .unwrap();
        fs::write(existing.path().join("package.json"), "{\"name\":\"mine\"}").unwrap();
        add_workspace(data.path(), "mine", existing.path().to_str().unwrap(), None).unwrap();
        assert!(!existing.path().join("cypress.config.js").exists());
        assert_eq!(
            fs::read_to_string(existing.path().join("package.json")).unwrap(),
            "{\"name\":\"mine\"}"
        );

        // 모듈 위치는 없으면 한 칸 만들고, package.json이 없으면 템플릿 것을 둔다.
        let with_module = TempDir::new().unwrap();
        let module_dir = with_module.path().join("cypress-module");
        add_workspace(
            data.path(),
            "mod",
            with_module.path().to_str().unwrap(),
            Some(module_dir.to_str().unwrap()),
        )
        .unwrap();
        assert!(module_dir.is_dir());
        assert!(ensure_module_package_json(&module_dir).unwrap());
        assert!(!ensure_module_package_json(&module_dir).unwrap());
        assert!(module_dir.join("package.json").is_file());
    }

    #[test]
    fn external_workspaces_stay_out_of_protected_roots() {
        let (data, _project, _workspace) = fixture();
        let external = TempDir::new().unwrap();
        fs::write(
            external.path().join("cypress.config.js"),
            "module.exports = {};",
        )
        .unwrap();
        let view =
            add_workspace(data.path(), "kb", external.path().to_str().unwrap(), None).unwrap();
        assert_eq!(view.workspaces.len(), 2);
        let added = view
            .workspaces
            .iter()
            .find(|w| w.workspace.name == "kb")
            .unwrap();
        assert!(!added.module_ready);
        assert!(matches!(
            add_workspace(data.path(), "dup", external.path().to_str().unwrap(), None),
            Err(CoreError::Conflict(_))
        ));
        // 앱 데이터 안은 외부 등록 불가.
        let inside = data.path().join("somewhere");
        fs::create_dir_all(&inside).unwrap();
        fs::write(inside.join("cypress.config.js"), "").unwrap();
        assert!(matches!(
            add_workspace(data.path(), "in", inside.to_str().unwrap(), None),
            Err(CoreError::InvalidInput(_))
        ));
        let after = remove_workspace(data.path(), &added.workspace.id).unwrap();
        assert_eq!(after.workspaces.len(), 1);
        assert!(set_enabled(data.path(), true).unwrap().enabled);
        assert!(is_enabled(data.path()).unwrap());
    }

    #[test]
    fn legacy_default_registration_is_removed_and_its_files_are_archived() {
        let data = TempDir::new().unwrap();
        let legacy = data.path().join("aia-workspace/cypress/default");
        fs::create_dir_all(&legacy).unwrap();
        fs::write(legacy.join("user-spec.cy.js"), "// keep").unwrap();
        write_private_json(
            &data.path().join(REGISTRY_FILE),
            &serde_json::json!({
                "schemaVersion": SCHEMA_VERSION,
                "enabled": true,
                "workspaces": [{
                    "id": "default",
                    "name": "기본 작업공간",
                    "path": legacy,
                    "builtin": true,
                    "recordVideo": false,
                    "headed": false,
                    "createdAt": 1
                }]
            }),
        )
        .unwrap();

        let view = registry(data.path()).unwrap();
        assert!(view.enabled);
        assert!(view.workspaces.is_empty());
        assert!(!legacy.exists());
        let archived = fs::read_dir(data.path().join(LEGACY_WORKSPACE_TRASH_DIR))
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        assert!(archived.join("user-spec.cy.js").is_file());
    }
}
