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
const DEFAULT_WORKSPACE_ID: &str = "default";
const DEFAULT_WORKSPACE_NAME: &str = "기본 작업공간";
const MAX_FILES: usize = 2_000;
const MAX_TEXT_BYTES: u64 = 512 * 1024;
const CONFIG_CANDIDATES: [&str; 4] = [
    "cypress.config.js",
    "cypress.config.cjs",
    "cypress.config.mjs",
    "cypress.config.ts",
];
/// 편집기 목록과 파일 수 계산에서 빼는 폴더. 모듈·산출물·VCS 내부는 편집 대상이 아니다.
const SKIPPED_DIRS: [&str; 3] = ["node_modules", "artifacts", ".git"];
const MASK: &str = "•••";
/// 스크럽 대상 비밀값의 최소 길이. 더 짧은 값은 흔한 문자열과 겹쳐 출력을 망가뜨린다.
const MIN_SECRET_CHARS: usize = 4;

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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CypressWorkspace {
    pub id: String,
    pub name: String,
    /// Cypress 프로젝트 루트(정규 절대경로). `cypress.config.*`가 있는 폴더.
    pub path: String,
    /// `node_modules/cypress`가 있는 폴더. 없으면 `path` 자신.
    #[serde(default)]
    pub module_dir: Option<String>,
    /// 앱이 만든 기본 작업공간. 제거할 수 없다.
    #[serde(default)]
    pub builtin: bool,
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

fn default_workspace_dir(app_data_dir: &Path) -> PathBuf {
    app_data_dir
        .join("aia-workspace")
        .join("cypress")
        .join(DEFAULT_WORKSPACE_ID)
}

/// 기본 작업공간의 템플릿 파일을 채운다. 이미 있는 파일은 건드리지 않는다 — 사용자·AIA가
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
    let mut changed = false;
    if !registry
        .workspaces
        .iter()
        .any(|workspace| workspace.builtin)
    {
        let directory = default_workspace_dir(app_data_dir);
        fs::create_dir_all(&directory)?;
        registry.workspaces.insert(
            0,
            CypressWorkspace {
                id: DEFAULT_WORKSPACE_ID.to_owned(),
                name: DEFAULT_WORKSPACE_NAME.to_owned(),
                path: fs::canonicalize(&directory)?.to_string_lossy().into_owned(),
                module_dir: None,
                builtin: true,
                created_at: now_ms(),
            },
        );
        changed = true;
    }
    for workspace in registry
        .workspaces
        .iter()
        .filter(|workspace| workspace.builtin)
    {
        ensure_template_files(&workspace.project_dir())?;
    }
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

pub fn registry(app_data_dir: &Path) -> Result<CypressRegistryView, CoreError> {
    with_lock(app_data_dir, |dir| Ok(registry_view(&load_unlocked(dir)?)))
}

pub fn is_enabled(app_data_dir: &Path) -> Result<bool, CoreError> {
    with_lock(app_data_dir, |dir| Ok(load_unlocked(dir)?.enabled))
}

pub fn set_enabled(app_data_dir: &Path, enabled: bool) -> Result<CypressRegistryView, CoreError> {
    with_lock(app_data_dir, |dir| {
        let mut registry = load_unlocked(dir)?;
        registry.enabled = enabled;
        save_unlocked(dir, &registry)?;
        Ok(registry_view(&registry))
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

/// 외부 폴더를 작업공간으로 등록할 때의 검증. 공급자 홈과 Agent Manager 데이터 안은 등록할 수
/// 없고(기본 작업공간은 앱이 직접 만든다), 폴더에 Cypress 설정이 있어야 한다.
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
    if name.is_empty() || name.chars().count() > 60 {
        return Err(CoreError::InvalidInput(
            "작업공간 이름은 1~60자여야 합니다".to_owned(),
        ));
    }
    let project = validate_external_dir(app_data_dir, path, "작업공간 폴더")?;
    if !has_config(&project) {
        return Err(CoreError::InvalidInput(format!(
            "cypress.config.js(.cjs/.mjs/.ts)가 없는 폴더입니다: {}",
            project.display()
        )));
    }
    let module_dir = match module_dir.map(str::trim).filter(|value| !value.is_empty()) {
        Some(raw) => Some(validate_external_dir(
            app_data_dir,
            raw,
            "Cypress 모듈 위치",
        )?),
        None => None,
    };
    with_lock(app_data_dir, |dir| {
        let mut registry = load_unlocked(dir)?;
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
            builtin: false,
            created_at: now_ms(),
        });
        save_unlocked(dir, &registry)?;
        Ok(registry_view(&registry))
    })
}

/// 등록만 지운다. 폴더와 파일은 사용자 소유라 건드리지 않는다.
pub fn remove_workspace(app_data_dir: &Path, id: &str) -> Result<CypressRegistryView, CoreError> {
    with_lock(app_data_dir, |dir| {
        let mut registry = load_unlocked(dir)?;
        let Some(index) = registry
            .workspaces
            .iter()
            .position(|workspace| workspace.id == id)
        else {
            return Err(CoreError::NotFound(format!(
                "Cypress 작업공간을 찾을 수 없습니다: {id}"
            )));
        };
        if registry.workspaces[index].builtin {
            return Err(CoreError::InvalidInput(
                "기본 작업공간은 제거할 수 없습니다".to_owned(),
            ));
        }
        registry.workspaces.remove(index);
        save_unlocked(dir, &registry)?;
        Ok(registry_view(&registry))
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
    if relative
        .components()
        .next()
        .is_some_and(|first| SKIPPED_DIRS.contains(&first.as_os_str().to_string_lossy().as_ref()))
    {
        return Err(CoreError::InvalidInput(format!(
            "node_modules·artifacts·.git 아래는 편집할 수 없습니다: {raw}"
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

fn relative_text(path: &Path) -> String {
    path.components()
        .map(|component| component.as_os_str().to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join("/")
}

fn is_sensitive(relative: &Path) -> bool {
    relative_text(relative) == ENV_FILE
}

fn resolve_file(workspace: &CypressWorkspace, raw: &str) -> Result<(PathBuf, PathBuf), CoreError> {
    let relative = validate_relative_path(raw)?;
    let root = workspace.project_dir();
    let target = root.join(&relative);
    assert_within_root(&root, &target)?;
    Ok((relative, target))
}

pub fn list_files(workspace: &CypressWorkspace) -> Result<Vec<CypressWorkspaceFile>, CoreError> {
    let root = workspace.project_dir();
    if !root.is_dir() {
        return Err(CoreError::NotFound(format!(
            "작업공간 폴더가 없습니다: {}",
            root.display()
        )));
    }
    let mut files = Vec::new();
    let walker = WalkDir::new(&root)
        .follow_links(false)
        .sort_by_file_name()
        .into_iter()
        .filter_entry(|entry| {
            let name = entry.file_name().to_string_lossy();
            entry.depth() == 0 || (!SKIPPED_DIRS.contains(&name.as_ref()) && !name.starts_with('.'))
        });
    for entry in walker {
        let entry = entry.map_err(|error| {
            CoreError::Runtime(format!("작업공간 파일 목록을 읽지 못했습니다: {error}"))
        })?;
        if !entry.file_type().is_file() {
            continue;
        }
        if files.len() >= MAX_FILES {
            return Err(CoreError::InvalidInput(format!(
                "작업공간 파일이 {MAX_FILES}개를 넘습니다"
            )));
        }
        let relative = entry
            .path()
            .strip_prefix(&root)
            .map_err(|_| CoreError::Runtime("작업공간 경로 계산 실패".to_owned()))?;
        files.push(CypressWorkspaceFile {
            path: relative_text(relative),
            size_bytes: entry.metadata().map(|meta| meta.len()).unwrap_or(0),
            sensitive: is_sensitive(relative),
        });
    }
    Ok(files)
}

fn read_text_limited(path: &Path) -> Result<String, CoreError> {
    let metadata = fs::metadata(path)
        .map_err(|_| CoreError::NotFound(format!("파일이 없습니다: {}", path.display())))?;
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

/// 문자열 값을 모두 가린 JSON. 구조와 키는 남겨 AIA가 어떤 키를 `Cypress.env`로 읽을지 알 수 있게 한다.
pub(crate) fn mask_env_json(text: &str) -> String {
    fn mask(value: &mut Value) {
        match value {
            Value::String(text) => *text = MASK.to_owned(),
            Value::Array(items) => items.iter_mut().for_each(mask),
            Value::Object(map) => map.values_mut().for_each(mask),
            _ => {}
        }
    }
    match serde_json::from_str::<Value>(text) {
        Ok(mut value) => {
            mask(&mut value);
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
        path: relative_text(&relative),
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
    if content.len() as u64 > MAX_TEXT_BYTES {
        return Err(CoreError::TooLarge(MAX_TEXT_BYTES));
    }
    if target.is_dir() {
        return Err(CoreError::InvalidInput(format!(
            "폴더에는 쓸 수 없습니다: {raw}"
        )));
    }
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(&target, content)?;
    Ok(CypressWorkspaceFile {
        path: relative_text(&relative),
        size_bytes: content.len() as u64,
        sensitive: false,
    })
}

/// env 파일 저장. JSON 객체여야 하고 0600으로 쓴다.
pub fn write_env_file(
    workspace: &CypressWorkspace,
    content: &str,
) -> Result<CypressWorkspaceFile, CoreError> {
    if content.len() as u64 > MAX_TEXT_BYTES {
        return Err(CoreError::TooLarge(MAX_TEXT_BYTES));
    }
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
    Ok(CypressWorkspaceFile {
        path: ENV_FILE.to_owned(),
        size_bytes: content.len() as u64,
        sensitive: true,
    })
}

pub fn delete_file(workspace: &CypressWorkspace, raw: &str) -> Result<(), CoreError> {
    let (relative, target) = resolve_file(workspace, raw)?;
    let text = relative_text(&relative);
    if is_sensitive(&relative) || CONFIG_CANDIDATES.contains(&text.as_str()) {
        return Err(CoreError::InvalidInput(format!(
            "{text}은(는) 작업공간의 필수 파일이라 지울 수 없습니다"
        )));
    }
    if !target.is_file() {
        return Err(CoreError::NotFound(format!("파일이 없습니다: {text}")));
    }
    fs::remove_file(&target)?;
    Ok(())
}

/// 실행 출력에서 지울 비밀값. env 파일의 문자열 값 중 스크럽할 만큼 긴 것만.
pub fn env_secret_values(workspace: &CypressWorkspace) -> Vec<String> {
    fn collect(value: &Value, into: &mut BTreeSet<String>) {
        match value {
            Value::String(text) => {
                if text.chars().count() >= MIN_SECRET_CHARS {
                    into.insert(text.clone());
                }
            }
            Value::Array(items) => items.iter().for_each(|item| collect(item, into)),
            Value::Object(map) => map.values().for_each(|item| collect(item, into)),
            _ => {}
        }
    }
    let mut values = BTreeSet::new();
    if let Ok(text) = fs::read_to_string(workspace.project_dir().join(ENV_FILE)) {
        if let Ok(value) = serde_json::from_str::<Value>(&text) {
            collect(&value, &mut values);
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

    fn fixture() -> (TempDir, CypressWorkspace) {
        let data = TempDir::new().expect("temp app data");
        let registry = registry(data.path()).expect("registry");
        assert!(!registry.enabled, "기본은 꺼짐");
        let workspace = workspace(data.path(), DEFAULT_WORKSPACE_ID).expect("default workspace");
        (data, workspace)
    }

    #[test]
    fn default_workspace_is_created_from_the_template_with_a_private_env_file() {
        let (data, workspace) = fixture();
        assert!(workspace.builtin);
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
        let files = list_files(&workspace).unwrap();
        let env = files
            .iter()
            .find(|file| file.path == ENV_FILE)
            .expect("env listed");
        assert!(env.sensitive);
        assert!(files
            .iter()
            .all(|file| !file.path.starts_with("node_modules")));
    }

    #[test]
    fn env_file_is_masked_on_normal_reads_and_written_only_through_the_dedicated_path() {
        let (_data, workspace) = fixture();
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
        let (_data, workspace) = fixture();
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

    #[test]
    fn external_workspaces_need_a_config_and_stay_out_of_protected_roots() {
        let (data, _workspace) = fixture();
        let external = TempDir::new().unwrap();
        assert!(matches!(
            add_workspace(data.path(), "kb", external.path().to_str().unwrap(), None),
            Err(CoreError::InvalidInput(_))
        ));
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
            .find(|w| !w.workspace.builtin)
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
        assert!(matches!(
            remove_workspace(data.path(), DEFAULT_WORKSPACE_ID),
            Err(CoreError::InvalidInput(_))
        ));
        let after = remove_workspace(data.path(), &added.workspace.id).unwrap();
        assert_eq!(after.workspaces.len(), 1);
        assert!(set_enabled(data.path(), true).unwrap().enabled);
        assert!(is_enabled(data.path()).unwrap());
    }
}
