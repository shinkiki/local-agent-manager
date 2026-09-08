//! Cypress 실행 잡.
//!
//! 러너(`assets/cypress-runner/run.mjs`)를 node 자식 프로세스로 띄워 작업공간의 스펙을 돌리고,
//! 요약과 산출물(`artifacts/runs/<jobId>/`)을 모아 상태로 보관한다. AIA의 MCP 도구 호출은
//! 동기라 몇 분짜리 실행을 기다릴 수 없으므로, 시작은 즉시 jobId를 돌려주고 완료는 상태
//! 조회로 확인한다.
//!
//! 잡 내용은 stdin JSON으로만 넘긴다(argv·env 금지). 비밀은 여기에도 없다 — Cypress가
//! 프로젝트 루트의 `cypress.env.json`을 직접 읽는다. 그래도 스크립트가 값을 출력에 남길 수
//! 있으니 회수한 출력과 산출물 본문에서 env 파일의 값을 지운다.

use std::collections::{BTreeMap, VecDeque};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use uuid::Uuid;
use walkdir::WalkDir;

use crate::app_data_file::write_private_bytes;
use crate::clock::now_ms;
use crate::credential_profiles;
use crate::cypress_workspaces::{self, CypressWorkspace, CypressWorkspaceView};
use crate::process_output::CappedOutputReaders;
#[cfg(unix)]
use crate::process_signal;
use crate::CoreError;

const RUNNER_SCRIPT: &str = include_str!("../assets/cypress-runner/run.mjs");
const RUNNER_DIR: &str = "cypress-runner";
const RUNNER_FILE: &str = "run.mjs";
/// 기본 작업공간에 설치하는 Cypress. 머신 캐시에 있는 버전이면 바이너리 재다운로드가 없다.
pub(crate) const DEFAULT_CYPRESS_VERSION: &str = "15.21.1";
const RUN_TIMEOUT: Duration = Duration::from_secs(20 * 60);
const INSTALL_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const MAX_RUNS: usize = 20;
const MAX_ARTIFACT_INLINE_BYTES: u64 = 64 * 1024;
const OUTPUT_TAIL_CHARS: usize = 1_500;
const REDACTED: &str = "[제거된 비밀값]";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CypressRunState {
    Running,
    Passed,
    Failed,
    TimedOut,
    Error,
}

impl CypressRunState {
    #[cfg(test)]
    pub const ALL: [Self; 5] = [
        Self::Running,
        Self::Passed,
        Self::Failed,
        Self::TimedOut,
        Self::Error,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Passed => "passed",
            Self::Failed => "failed",
            Self::TimedOut => "timedOut",
            Self::Error => "error",
        }
    }

    /// 현재 진행 중인 상태인지 여부.
    #[cfg(test)]
    pub fn is_running(self) -> bool {
        matches!(self, Self::Running)
    }

    /// 테스트를 모두 통과한 성공 상태인지 여부.
    #[cfg(test)]
    pub fn is_passed(self) -> bool {
        matches!(self, Self::Passed)
    }

    /// 테스트 실패가 발생한 상태인지 여부.
    #[cfg(test)]
    pub fn is_failed(self) -> bool {
        matches!(self, Self::Failed)
    }

    /// 제한 시간 초과로 중단된 상태인지 여부.
    #[cfg(test)]
    pub fn is_timed_out(self) -> bool {
        matches!(self, Self::TimedOut)
    }

    /// 러너 기동 오류 또는 비정상 종료 상태인지 여부.
    #[cfg(test)]
    pub fn is_error(self) -> bool {
        matches!(self, Self::Error)
    }

    /// 실행이 종료된 종결 상태(Passed, Failed, TimedOut, Error)인지 여부.
    #[cfg(test)]
    pub fn is_terminal(self) -> bool {
        !self.is_running()
    }

    /// 테스트 성공 여부(Passed).
    #[cfg(test)]
    pub fn is_successful(self) -> bool {
        matches!(self, Self::Passed)
    }
}

impl std::fmt::Display for CypressRunState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

impl std::str::FromStr for CypressRunState {
    type Err = CoreError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.trim() {
            "running" => Ok(Self::Running),
            "passed" => Ok(Self::Passed),
            "failed" => Ok(Self::Failed),
            "timedOut" | "timed_out" => Ok(Self::TimedOut),
            "error" => Ok(Self::Error),
            _ => Err(CoreError::InvalidInput(format!(
                "알 수 없는 Cypress 실행 상태입니다: {s}. running|passed|failed|timedOut|error 중 하나를 쓰세요"
            ))),
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CypressRunTest {
    pub title: String,
    pub state: String,
    #[serde(default)]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CypressRunSpec {
    pub spec: String,
    #[serde(default)]
    pub tests: Vec<CypressRunTest>,
}

/// 러너가 `summary.json`에 남기는 형식 그대로.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CypressRunSummary {
    #[serde(default)]
    pub passed: u64,
    #[serde(default)]
    pub failed: u64,
    #[serde(default)]
    pub pending: u64,
    #[serde(default)]
    pub duration_ms: u64,
    #[serde(default)]
    pub specs: Vec<CypressRunSpec>,
    #[serde(default)]
    pub screenshots: Vec<String>,
    /// Cypress가 뜨지 못했을 때 러너가 남기는 사유.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CypressRunArtifact {
    /// 프로젝트 루트 기준 상대 경로(`artifacts/runs/<jobId>/…`).
    pub path: String,
    pub size_bytes: u64,
    /// json · text · image · other
    pub kind: String,
    /// json·text이고 64 KB 이하면 본문. 비밀값은 지워져 있다.
    pub content: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CypressRunStatus {
    pub job_id: String,
    pub workspace_id: String,
    pub spec: Option<String>,
    pub state: CypressRunState,
    pub started_at: i64,
    pub finished_at: Option<i64>,
    pub summary: Option<CypressRunSummary>,
    pub artifacts: Vec<CypressRunArtifact>,
    pub output_tail: String,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CypressInstallReceipt {
    pub workspace: CypressWorkspaceView,
    pub output: String,
}

#[derive(Default)]
pub struct CypressRuns {
    runs: Mutex<VecDeque<Arc<Mutex<CypressRunStatus>>>>,
}

static RUNS: OnceLock<CypressRuns> = OnceLock::new();

/// 백엔드 프로세스 하나가 잡 목록 하나를 가진다. HTTP·MCP 경로가 같은 목록을 본다.
pub fn runs() -> &'static CypressRuns {
    RUNS.get_or_init(CypressRuns::default)
}

fn lock<T>(mutex: &Mutex<T>) -> Result<std::sync::MutexGuard<'_, T>, CoreError> {
    mutex
        .lock()
        .map_err(|_| CoreError::Runtime("Cypress 실행 상태 잠금이 깨졌습니다".to_owned()))
}

/// 회수한 텍스트에서 비밀값을 지우고 끝부분만 남긴다.
pub(crate) fn scrub(text: &str, secrets: &[String]) -> String {
    let mut scrubbed = text.to_owned();
    for secret in secrets {
        if !secret.is_empty() {
            scrubbed = scrubbed.replace(secret, REDACTED);
        }
    }
    scrubbed
}

fn tail(text: &str, chars: usize) -> String {
    let count = text.chars().count();
    if count <= chars {
        return text.to_owned();
    }
    text.chars().skip(count - chars).collect()
}

fn artifact_kind(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("json") => "json",
        Some("txt" | "md" | "csv" | "log" | "html" | "xml" | "yaml" | "yml") => "text",
        Some("png" | "jpg" | "jpeg" | "gif" | "webp") => "image",
        _ => "other",
    }
}

/// `artifacts/runs/<jobId>/` 아래 파일을 모은다. JSON·텍스트는 본문까지(비밀 제거), 나머지는 경로만.
pub(crate) fn collect_artifacts(
    project: &Path,
    run_dir: &Path,
    secrets: &[String],
) -> Vec<CypressRunArtifact> {
    let mut artifacts = Vec::new();
    if !run_dir.is_dir() {
        return artifacts;
    }
    for entry in WalkDir::new(run_dir)
        .follow_links(false)
        .sort_by_file_name()
        .into_iter()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_file())
    {
        if entry.file_name() == "summary.json" {
            continue;
        }
        let path = entry.path();
        let size = entry.metadata().map(|meta| meta.len()).unwrap_or(0);
        let kind = artifact_kind(path);
        let content = if (kind == "json" || kind == "text") && size <= MAX_ARTIFACT_INLINE_BYTES {
            fs::read(path)
                .ok()
                .map(|bytes| scrub(&String::from_utf8_lossy(&bytes), secrets))
        } else {
            None
        };
        let relative = path
            .strip_prefix(project)
            .unwrap_or(path)
            .components()
            .map(|component| component.as_os_str().to_string_lossy().into_owned())
            .collect::<Vec<_>>()
            .join("/");
        artifacts.push(CypressRunArtifact {
            path: relative,
            size_bytes: size,
            kind: kind.to_owned(),
            content,
        });
    }
    artifacts
}

fn ensure_runner(app_data_dir: &Path) -> Result<PathBuf, CoreError> {
    let directory = app_data_dir.join(RUNNER_DIR);
    fs::create_dir_all(&directory)?;
    let path = directory.join(RUNNER_FILE);
    let current = fs::read_to_string(&path).ok();
    if current.as_deref() != Some(RUNNER_SCRIPT) {
        write_private_bytes(&path, RUNNER_SCRIPT.as_bytes())?;
    }
    Ok(path)
}

fn module_ready(workspace: &CypressWorkspace) -> bool {
    workspace
        .module_dir()
        .join("node_modules")
        .join("cypress")
        .join("package.json")
        .is_file()
}

struct CappedOutcome {
    success: bool,
    timed_out: bool,
    exit_code: Option<i32>,
    stdout: String,
    stderr: String,
}

/// 자식을 프로세스 그룹으로 띄우고 stdin 본문을 준 뒤 상한 시간까지 기다린다. 초과하면 그룹 전체를
/// 죽여 Cypress가 띄운 브라우저까지 정리한다.
fn spawn_capped(
    mut command: Command,
    stdin_payload: Option<Vec<u8>>,
    timeout: Duration,
) -> Result<CappedOutcome, CoreError> {
    command
        .stdin(if stdin_payload.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("NO_COLOR", "1")
        .env("CI", "1");
    credential_profiles::strip_inherited_credential_env(&mut command);
    crate::chat::configure_no_window_command(&mut command);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = command.spawn().map_err(|error| {
        CoreError::Runtime(format!("Cypress 러너를 시작하지 못했습니다: {error}"))
    })?;
    if let (Some(payload), Some(mut stdin)) = (stdin_payload, child.stdin.take()) {
        // 자식이 다 읽기 전에 죽어도 쓰기 오류로 우리가 죽으면 안 된다.
        let _ = stdin.write_all(&payload);
        drop(stdin);
    }
    let output_readers = CappedOutputReaders::spawn(child.stdout.take(), child.stderr.take());
    let started = Instant::now();
    let mut timed_out = false;
    let status = loop {
        match child.try_wait()? {
            Some(status) => break Some(status),
            None if started.elapsed() >= timeout => {
                kill_group(child.id());
                let _ = child.kill();
                let _ = child.wait();
                timed_out = true;
                break None;
            }
            None => thread::sleep(Duration::from_millis(200)),
        }
    };
    let (stdout, stderr) = output_readers.finish();
    Ok(CappedOutcome {
        success: status.map(|status| status.success()).unwrap_or(false),
        timed_out,
        exit_code: status.and_then(|status| status.code()),
        stdout: String::from_utf8_lossy(&stdout).into_owned(),
        stderr: String::from_utf8_lossy(&stderr).into_owned(),
    })
}

#[cfg(unix)]
fn kill_group(pid: u32) {
    // 실행 시간을 넘긴 자식을 정리하는 마지막 수단이라, 이미 사라졌거나 신호를 보내지
    // 못해도 더 할 일이 없다.
    let _ = process_signal::signal_process_group(pid, libc::SIGKILL);
}

#[cfg(not(unix))]
fn kill_group(_pid: u32) {}

fn validate_spec(project: &Path, spec: Option<&str>) -> Result<Option<PathBuf>, CoreError> {
    let Some(spec) = spec.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    let relative = cypress_workspaces::validate_relative_path(spec)?;
    let target = project.join(&relative);
    if !target.is_file() {
        return Err(CoreError::NotFound(format!("스펙 파일이 없습니다: {spec}")));
    }
    Ok(Some(target))
}

fn validate_env(env: &BTreeMap<String, String>) -> Result<(), CoreError> {
    if env.len() > 50 {
        return Err(CoreError::InvalidInput(
            "추가 env는 50개를 넘을 수 없습니다".to_owned(),
        ));
    }
    for (key, value) in env {
        if key.is_empty()
            || key.len() > 64
            || !key
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '.' || ch == '-')
        {
            return Err(CoreError::InvalidInput(format!(
                "env 키가 올바르지 않습니다: {key}"
            )));
        }
        if value.len() > 4_096 {
            return Err(CoreError::InvalidInput(format!(
                "env 값이 너무 깁니다: {key}"
            )));
        }
    }
    Ok(())
}

impl CypressRuns {
    pub fn status(&self, job_id: &str) -> Result<Option<CypressRunStatus>, CoreError> {
        let runs = lock(&self.runs)?;
        for run in runs.iter() {
            let status = lock(run)?;
            if status.job_id == job_id {
                return Ok(Some(status.clone()));
            }
        }
        Ok(None)
    }

    pub fn list(&self) -> Result<Vec<CypressRunStatus>, CoreError> {
        let runs = lock(&self.runs)?;
        let mut list = Vec::with_capacity(runs.len());
        for run in runs.iter().rev() {
            list.push(lock(run)?.clone());
        }
        Ok(list)
    }

    fn push(&self, status: CypressRunStatus) -> Result<Arc<Mutex<CypressRunStatus>>, CoreError> {
        let record = Arc::new(Mutex::new(status));
        let mut runs = lock(&self.runs)?;
        runs.push_back(Arc::clone(&record));
        while runs.len() > MAX_RUNS {
            runs.pop_front();
        }
        Ok(record)
    }

    /// 실행을 시작하고 즉시 상태를 돌려준다. 완료는 `status`로 확인한다.
    pub fn start(
        &self,
        app_data_dir: &Path,
        workspace: &CypressWorkspace,
        spec: Option<&str>,
        extra_env: BTreeMap<String, String>,
    ) -> Result<CypressRunStatus, CoreError> {
        let project = fs::canonicalize(workspace.project_dir()).map_err(|_| {
            CoreError::NotFound(format!("작업공간 폴더가 없습니다: {}", workspace.path))
        })?;
        if !module_ready(workspace) {
            return Err(CoreError::InvalidInput(
                "이 작업공간에 Cypress 모듈이 없습니다. 설정 → 자동화 탭에서 '설치'를 누르거나 모듈 위치를 지정하세요"
                    .to_owned(),
            ));
        }
        let spec_path = validate_spec(&project, spec)?;
        validate_env(&extra_env)?;
        let node = crate::providers::resolve_named_executable(&["node"])?;
        let runner = ensure_runner(app_data_dir)?;
        let job_id = Uuid::new_v4().simple().to_string();
        let run_relative = format!("artifacts/runs/{job_id}");
        let run_dir = project.join(&run_relative);
        fs::create_dir_all(&run_dir)?;
        let secrets = cypress_workspaces::env_secret_values(workspace);

        let mut env: BTreeMap<String, Value> = extra_env
            .into_iter()
            .map(|(key, value)| (key, Value::String(value)))
            .collect();
        env.insert("amRunDir".to_owned(), Value::String(run_relative.clone()));
        let payload = json!({
            "moduleDir": workspace.module_dir(),
            "project": project,
            "spec": spec_path,
            "env": env,
            "config": {
                "screenshotsFolder": run_dir.join("screenshots"),
                "downloadsFolder": run_dir.join("downloads"),
                "video": false,
                "trashAssetsBeforeRuns": false,
            },
            "summaryPath": run_dir.join("summary.json"),
        });

        let record = self.push(CypressRunStatus {
            job_id: job_id.clone(),
            workspace_id: workspace.id.clone(),
            spec: spec.map(str::to_owned),
            state: CypressRunState::Running,
            started_at: now_ms(),
            finished_at: None,
            summary: None,
            artifacts: Vec::new(),
            output_tail: String::new(),
            message: None,
        })?;
        let initial = lock(&record)?.clone();

        let worker_record = Arc::clone(&record);
        let worker_project = project.clone();
        thread::Builder::new()
            .name(format!("cypress-run-{job_id}"))
            .spawn(move || {
                let mut command = Command::new(&node);
                command.arg(&runner).current_dir(&worker_project);
                if let Some(path) = crate::providers::command_search_path(&node) {
                    command.env("PATH", path);
                }
                let outcome = spawn_capped(
                    command,
                    Some(serde_json::to_vec(&payload).unwrap_or_default()),
                    RUN_TIMEOUT,
                );
                let summary_path = run_dir.join("summary.json");
                let summary = fs::read(&summary_path)
                    .ok()
                    .and_then(|bytes| serde_json::from_slice::<CypressRunSummary>(&bytes).ok());
                let artifacts = collect_artifacts(&worker_project, &run_dir, &secrets);
                if let Ok(mut status) = worker_record.lock() {
                    status.finished_at = Some(now_ms());
                    status.artifacts = artifacts;
                    match outcome {
                        Err(error) => {
                            status.state = CypressRunState::Error;
                            status.message = Some(error.to_string());
                        }
                        Ok(outcome) => {
                            let combined = format!("{}\n{}", outcome.stdout, outcome.stderr);
                            status.output_tail =
                                tail(&scrub(&combined, &secrets), OUTPUT_TAIL_CHARS);
                            if outcome.timed_out {
                                status.state = CypressRunState::TimedOut;
                                status.message = Some(format!(
                                    "{}분 안에 끝나지 않아 중단했습니다",
                                    RUN_TIMEOUT.as_secs() / 60
                                ));
                            } else {
                                match summary {
                                    Some(summary) if summary.error.is_none() => {
                                        status.state = if summary.failed == 0 && outcome.success {
                                            CypressRunState::Passed
                                        } else {
                                            CypressRunState::Failed
                                        };
                                        status.summary = Some(summary);
                                    }
                                    Some(summary) => {
                                        status.message = summary.error.clone();
                                        status.state = CypressRunState::Error;
                                        status.summary = Some(summary);
                                    }
                                    None => {
                                        status.state = CypressRunState::Error;
                                        status.message = Some(format!(
                                            "러너가 요약을 남기지 않았습니다(exit {})",
                                            outcome
                                                .exit_code
                                                .map(|code| code.to_string())
                                                .unwrap_or_else(|| "?".to_owned())
                                        ));
                                    }
                                }
                            }
                        }
                    }
                }
            })
            .map_err(|error| {
                CoreError::Runtime(format!("Cypress 실행 스레드를 만들지 못했습니다: {error}"))
            })?;
        Ok(initial)
    }
}

fn validate_version(version: &str) -> Result<(), CoreError> {
    let ok = !version.is_empty()
        && version.len() <= 32
        && version
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | '^' | '~'));
    if ok {
        Ok(())
    } else {
        Err(CoreError::InvalidInput(format!(
            "Cypress 버전 표기가 올바르지 않습니다: {version}"
        )))
    }
}

/// 작업공간(모듈 위치)에 `npm install --save-dev cypress@<버전>`을 실행한다. 호스트 전용.
pub fn install_module(
    workspace: &CypressWorkspace,
    version: Option<&str>,
) -> Result<CypressInstallReceipt, CoreError> {
    let version = version
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(DEFAULT_CYPRESS_VERSION);
    validate_version(version)?;
    let module_dir = workspace.module_dir();
    if !module_dir.join("package.json").is_file() {
        return Err(CoreError::InvalidInput(format!(
            "package.json이 없는 폴더에는 설치할 수 없습니다: {}",
            module_dir.display()
        )));
    }
    let npm = crate::providers::resolve_named_executable(&["npm"])?;
    let mut command = Command::new(&npm);
    command
        .args([
            "install",
            "--save-dev",
            "--no-audit",
            "--no-fund",
            &format!("cypress@{version}"),
        ])
        .current_dir(&module_dir);
    if let Some(path) = crate::providers::command_search_path(&npm) {
        command.env("PATH", path);
    }
    let outcome = spawn_capped(command, None, INSTALL_TIMEOUT)?;
    let output = tail(
        &format!("{}\n{}", outcome.stdout, outcome.stderr),
        OUTPUT_TAIL_CHARS,
    );
    if outcome.timed_out {
        return Err(CoreError::Runtime(format!(
            "Cypress 설치가 {}분 안에 끝나지 않았습니다\n{output}",
            INSTALL_TIMEOUT.as_secs() / 60
        )));
    }
    if !outcome.success {
        return Err(CoreError::Runtime(format!(
            "Cypress 설치에 실패했습니다\n{output}"
        )));
    }
    Ok(CypressInstallReceipt {
        workspace: cypress_workspaces::workspace_view(workspace),
        output,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn summary_json_from_the_runner_parses_and_tolerates_missing_fields() {
        let summary: CypressRunSummary = serde_json::from_str(
            r#"{"passed":2,"failed":1,"durationMs":1234,"specs":[{"spec":"e2e/a.cy.js","tests":[{"title":"a › b","state":"failed","error":"boom"}]}],"screenshots":["/tmp/x.png"]}"#,
        )
        .unwrap();
        assert_eq!(summary.passed, 2);
        assert_eq!(summary.pending, 0);
        assert_eq!(summary.specs[0].tests[0].error.as_deref(), Some("boom"));
        let failed: CypressRunSummary =
            serde_json::from_str(r#"{"error":"Cypress를 실행하지 못했습니다"}"#).unwrap();
        assert!(failed.error.is_some());
    }

    #[test]
    fn artifacts_are_collected_with_inline_text_and_scrubbed_secrets() {
        let project = TempDir::new().unwrap();
        let run_dir = project.path().join("artifacts/runs/job1");
        fs::create_dir_all(run_dir.join("screenshots")).unwrap();
        fs::write(run_dir.join("result.json"), r#"{"token":"s3cret!","n":1}"#).unwrap();
        fs::write(run_dir.join("notes.txt"), "password s3cret! done").unwrap();
        fs::write(run_dir.join("screenshots/a.png"), [0u8; 10]).unwrap();
        fs::write(run_dir.join("summary.json"), "{}").unwrap();
        let artifacts = collect_artifacts(project.path(), &run_dir, &["s3cret!".to_owned()]);
        let paths: Vec<&str> = artifacts.iter().map(|item| item.path.as_str()).collect();
        assert_eq!(
            paths,
            vec![
                "artifacts/runs/job1/notes.txt",
                "artifacts/runs/job1/result.json",
                "artifacts/runs/job1/screenshots/a.png"
            ]
        );
        assert_eq!(artifacts[0].kind, "text");
        assert_eq!(
            artifacts[0].content.as_deref(),
            Some("password [제거된 비밀값] done")
        );
        assert_eq!(artifacts[1].kind, "json");
        assert!(artifacts[1].content.as_deref().unwrap().contains(REDACTED));
        assert_eq!(artifacts[2].kind, "image");
        assert!(artifacts[2].content.is_none());
    }

    #[test]
    fn spec_and_env_arguments_are_validated_before_anything_runs() {
        let project = TempDir::new().unwrap();
        fs::create_dir_all(project.path().join("e2e")).unwrap();
        fs::write(project.path().join("e2e/a.cy.js"), "").unwrap();
        assert!(validate_spec(project.path(), None).unwrap().is_none());
        assert!(validate_spec(project.path(), Some("e2e/a.cy.js"))
            .unwrap()
            .is_some());
        assert!(matches!(
            validate_spec(project.path(), Some("../a.cy.js")),
            Err(CoreError::InvalidInput(_))
        ));
        assert!(matches!(
            validate_spec(project.path(), Some("e2e/missing.cy.js")),
            Err(CoreError::NotFound(_))
        ));
        let mut env = BTreeMap::new();
        env.insert("exampleUrl".to_owned(), "https://example.com".to_owned());
        validate_env(&env).unwrap();
        env.insert("bad key".to_owned(), "x".to_owned());
        assert!(matches!(
            validate_env(&env),
            Err(CoreError::InvalidInput(_))
        ));
        assert!(validate_version("15.21.1").is_ok());
        assert!(validate_version("15.21.1; rm -rf /").is_err());
        assert_eq!(tail("abcdef", 3), "def");
    }

    #[test]
    fn starting_without_a_cypress_module_is_refused_and_the_runner_is_materialized() {
        let data = TempDir::new().unwrap();
        let registry = cypress_workspaces::registry(data.path()).unwrap();
        let workspace =
            cypress_workspaces::workspace(data.path(), &registry.workspaces[0].workspace.id)
                .unwrap();
        let error = runs()
            .start(data.path(), &workspace, None, BTreeMap::new())
            .expect_err("no module installed");
        assert!(matches!(error, CoreError::InvalidInput(_)));
        let runner = ensure_runner(data.path()).unwrap();
        assert_eq!(fs::read_to_string(runner).unwrap(), RUNNER_SCRIPT);
        assert!(runs().status("missing").unwrap().is_none());
    }

    /// CypressRunState의 문자열 포맷팅, 파싱, 직렬화, 역직렬화 및 상태 판별 헬퍼를 검증한다.
    #[test]
    fn cypress_run_state_contract_and_serde() {
        assert_eq!(CypressRunState::ALL.len(), 5);
        for state in CypressRunState::ALL {
            let s = state.as_str();
            assert_eq!(state.to_string(), s);
            assert_eq!(s.parse::<CypressRunState>().expect("parse"), state);

            let json = serde_json::to_string(&state).expect("serialize");
            assert_eq!(json, format!("\"{s}\""));
            let back: CypressRunState = serde_json::from_str(&json).expect("deserialize");
            assert_eq!(back, state);
        }

        // 스네이크 표기(timed_out) 파싱 호환성 검증
        assert_eq!(
            "timed_out".parse::<CypressRunState>().expect("snake parse"),
            CypressRunState::TimedOut
        );

        // 상태 판별 헬퍼 검증
        assert!(CypressRunState::Running.is_running());
        assert!(!CypressRunState::Running.is_terminal());
        assert!(!CypressRunState::Running.is_successful());

        assert!(CypressRunState::Passed.is_passed());
        assert!(CypressRunState::Passed.is_terminal());
        assert!(CypressRunState::Passed.is_successful());

        assert!(CypressRunState::Failed.is_failed());
        assert!(CypressRunState::Failed.is_terminal());
        assert!(!CypressRunState::Failed.is_successful());

        assert!(CypressRunState::TimedOut.is_timed_out());
        assert!(CypressRunState::TimedOut.is_terminal());
        assert!(!CypressRunState::TimedOut.is_successful());

        assert!(CypressRunState::Error.is_error());
        assert!(CypressRunState::Error.is_terminal());
        assert!(!CypressRunState::Error.is_successful());

        // 알 수 없는 값에 대한 파싱 거절 검증
        let error = "unknown".parse::<CypressRunState>().expect_err("unknown");
        assert!(matches!(error, CoreError::InvalidInput(_)));
    }
}
