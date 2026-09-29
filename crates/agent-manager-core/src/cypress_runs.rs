//! Cypress 실행 잡.
//!
//! 러너(`assets/cypress-runner/run.mjs`)를 node 자식 프로세스로 띄워 작업공간의 스펙을 돌리고,
//! 요약과 산출물(`artifacts/runs/<jobId>/`)을 모아 상태로 보관한다. AIA의 MCP 도구 호출은
//! 동기라 몇 분짜리 실행을 기다릴 수 없으므로, 시작은 즉시 jobId를 돌려주고 완료는 상태
//! 조회로 확인한다.
//!
//! 수동 실행에는 갈래가 하나 더 있다. `open`은 같은 러너를 `cypress.open()` 모드로 띄워
//! Cypress 런처를 열고, 사람이 스펙을 고르고 `cy.pause()`로 한 커맨드씩 끊어 보며 진행한다.
//! 창을 사람이 닫을 때까지 끝나지 않으므로 실행 상한이 따로이고(`OPEN_TIMEOUT`), 통과·실패
//! 대신 `closed`로 끝난다. 호스트 화면에만 뜨는 창이라 이 갈래는 AIA에 열지 않는다.
//!
//! 잡 내용은 stdin JSON으로만 넘긴다(argv·env 금지). 비밀은 여기에도 없다 — Cypress가
//! 프로젝트 루트의 `cypress.env.json`을 직접 읽는다. 그래도 스크립트가 값을 출력에 남길 수
//! 있으니 회수한 출력과 산출물 본문에서 env 파일의 값을 지운다.

use std::collections::{BTreeMap, VecDeque};
use std::fs;
use std::io::Write;
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
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
use crate::cypress_workspaces::{
    self, CypressExecutionType, CypressWorkspace, CypressWorkspaceView,
};
use crate::path_guard::child_facing;
use crate::process_output::CappedOutputReaders;
use crate::CoreError;

const RUNNER_SCRIPT: &str = include_str!("../assets/cypress-runner/run.mjs");
const RUNNER_DIR: &str = "cypress-runner";
const RUNNER_FILE: &str = "run.mjs";
/// 작업공간에 설치하는 기본 Cypress 버전. 머신 캐시에 있으면 바이너리 재다운로드가 없다.
pub(crate) const DEFAULT_CYPRESS_VERSION: &str = "15.21.1";
const RUN_TIMEOUT: Duration = Duration::from_secs(20 * 60);
/// 런처를 띄운 채 사람이 들여다보는 시간의 상한. 닫는 것을 잊고 잠든 창을 언젠가는 정리해야
/// 하지만, 한나절 걸리는 수동 점검을 앱이 먼저 끊어서는 안 된다.
const OPEN_TIMEOUT: Duration = Duration::from_secs(8 * 60 * 60);
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
    /// 런처를 띄운 수동 실행이 사람 손으로 닫혀 끝난 상태. 통과·실패를 판정할 요약이 없다.
    Closed,
}

impl CypressRunState {
    #[cfg(test)]
    pub const ALL: [Self; 6] = [
        Self::Running,
        Self::Passed,
        Self::Failed,
        Self::TimedOut,
        Self::Error,
        Self::Closed,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Passed => "passed",
            Self::Failed => "failed",
            Self::TimedOut => "timedOut",
            Self::Error => "error",
            Self::Closed => "closed",
        }
    }

    /// 실행이 끝나 더 기다릴 것이 없는 상태인지 여부. Running만 아니면 종결이다.
    #[cfg(test)]
    pub fn is_terminal(self) -> bool {
        !matches!(self, Self::Running)
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
            "closed" => Ok(Self::Closed),
            _ => Err(CoreError::InvalidInput(format!(
                "알 수 없는 Cypress 실행 상태입니다: {s}. running|passed|failed|timedOut|error|closed 중 하나를 쓰세요"
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

/// 격리 하네스(`scripts/e2e.mjs --summary`)가 남기는 형식. Cypress 결과 객체의 키를 그대로
/// 쓰므로 일반 러너 요약과 이름이 달라, MCP가 공개하는 공통 요약으로 변환한다.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct IsolatedE2eSummary {
    #[serde(default)]
    total_passed: u64,
    #[serde(default)]
    total_failed: u64,
    #[serde(default)]
    total_pending: u64,
    #[serde(default)]
    total_duration: u64,
    #[serde(default)]
    runs: Vec<AgentManagerE2eRun>,
    #[serde(default)]
    error: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentManagerE2eRun {
    #[serde(default)]
    spec: String,
    #[serde(default)]
    tests: Vec<CypressRunTest>,
    #[serde(default)]
    screenshots: Vec<String>,
}

impl From<IsolatedE2eSummary> for CypressRunSummary {
    fn from(value: IsolatedE2eSummary) -> Self {
        let screenshots = value
            .runs
            .iter()
            .flat_map(|run| run.screenshots.iter().cloned())
            .collect();
        let specs = value
            .runs
            .into_iter()
            .map(|run| CypressRunSpec {
                spec: run.spec,
                tests: run.tests,
            })
            .collect();
        Self {
            passed: value.total_passed,
            failed: value.total_failed,
            pending: value.total_pending,
            duration_ms: value.total_duration,
            specs,
            screenshots,
            error: value.error,
        }
    }
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
    pub mode: CypressRunMode,
    pub spec: Option<String>,
    pub state: CypressRunState,
    pub started_at: i64,
    pub finished_at: Option<i64>,
    pub summary: Option<CypressRunSummary>,
    pub artifacts: Vec<CypressRunArtifact>,
    pub output_tail: String,
    pub message: Option<String>,
    /// 중지 신호. 러너를 기다리는 쪽이 이 깃발을 보고 프로세스 그룹째 정리한다. pid를
    /// 들고 다니는 대신 깃발을 공유하는 것은 플랫폼마다 다른 신호 경로를 타지 않고 자식
    /// 핸들을 쥔 쪽이 직접 죽이게 하려는 것이다. 화면에 보낼 값이 아니라 직렬화에서 뺀다.
    #[serde(skip)]
    stop_flag: Arc<AtomicBool>,
    /// 사람이 중지를 눌러 끝난 실행인지. 죽인 프로세스는 실패로 돌아오므로, 그 결과를
    /// 오류로 적지 않으려면 누가 끝냈는지를 따로 들고 있어야 한다.
    #[serde(skip)]
    stopped: bool,
}

impl CypressRunStatus {
    fn running(
        job_id: String,
        workspace_id: String,
        mode: CypressRunMode,
        spec: Option<String>,
        stop_flag: Arc<AtomicBool>,
    ) -> Self {
        Self {
            job_id,
            workspace_id,
            mode,
            spec,
            state: CypressRunState::Running,
            started_at: now_ms(),
            finished_at: None,
            summary: None,
            artifacts: Vec::new(),
            output_tail: String::new(),
            message: None,
            stop_flag,
            stopped: false,
        }
    }

    fn finish(&mut self, finished: FinishedRun, artifacts: Vec<CypressRunArtifact>) {
        self.finished_at = Some(now_ms());
        self.artifacts = artifacts;
        // 중지는 사람이 창을 닫은 것과 같은 끝이다 — 실패로 적으면 눌러서 끝낼 때마다
        // 오류가 쌓인다.
        if self.stopped {
            self.state = CypressRunState::Closed;
            self.message = Some("중지했습니다".to_owned());
        } else {
            self.state = finished.state;
            self.message = finished.message;
        }
        self.summary = finished.summary;
        self.output_tail = finished.output_tail;
    }
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

fn status_snapshot(record: &Mutex<CypressRunStatus>) -> Result<CypressRunStatus, CoreError> {
    Ok(lock(record)?.clone())
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ArtifactKind {
    Json,
    Text,
    Image,
    Video,
    Other,
}

impl ArtifactKind {
    fn from_path(path: &Path) -> Self {
        match path
            .extension()
            .and_then(|value| value.to_str())
            .map(str::to_ascii_lowercase)
            .as_deref()
        {
            Some("json") => Self::Json,
            Some("txt" | "md" | "csv" | "log" | "html" | "xml" | "yaml" | "yml") => Self::Text,
            Some("png" | "jpg" | "jpeg" | "gif" | "webp") => Self::Image,
            Some("mp4" | "webm" | "mov") => Self::Video,
            _ => Self::Other,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Json => "json",
            Self::Text => "text",
            Self::Image => "image",
            Self::Video => "video",
            Self::Other => "other",
        }
    }

    /// 파일 크기가 상한 이내일 때 본문을 인라인으로 읽어들일 수 있는 형식인지 여부.
    fn is_inlinable(self) -> bool {
        matches!(self, Self::Json | Self::Text)
    }
}

/// 인라인 적재 대상 산출물 파일의 본문을 읽고 비밀값을 제거한다.
fn read_inlined_artifact_content(
    path: &Path,
    kind: ArtifactKind,
    size: u64,
    secrets: &[String],
) -> Option<String> {
    if !kind.is_inlinable() || size > MAX_ARTIFACT_INLINE_BYTES {
        return None;
    }
    fs::read(path)
        .ok()
        .map(|bytes| scrub(&String::from_utf8_lossy(&bytes), secrets))
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
        let kind = ArtifactKind::from_path(path);
        let content = read_inlined_artifact_content(path, kind, size, secrets);
        let relative =
            cypress_workspaces::relative_slash_path(path.strip_prefix(project).unwrap_or(path));
        artifacts.push(CypressRunArtifact {
            path: relative,
            size_bytes: size,
            kind: kind.as_str().to_owned(),
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

impl CappedOutcome {
    /// stdout·stderr를 합쳐 비밀값을 지운 꼬리. 실행·설치 양쪽이 같은 모양으로 보고한다.
    fn scrubbed_tail(&self, secrets: &[String]) -> String {
        tail(
            &scrub(&format!("{}\n{}", self.stdout, self.stderr), secrets),
            OUTPUT_TAIL_CHARS,
        )
    }

    fn exit_code_text(&self) -> String {
        self.exit_code
            .map(|code| code.to_string())
            .unwrap_or_else(|| "?".to_owned())
    }
}

/// 찾아낸 실행 파일로 명령을 만들고, 그 실행 파일이 있던 PATH를 물려준다.
fn command_on_resolved_path(executable: &Path) -> Command {
    let mut command = Command::new(executable);
    if let Some(path) = crate::providers::command_search_path(executable) {
        command.env("PATH", path);
    }
    command
}

/// 별도 모듈 위치의 Cypress뿐 아니라 설정 로더와 그 자식도 같은 `node_modules`를
/// 찾게 한다. 기존 `NODE_PATH`는 작업과 무관한 호스트 상태이므로 읽거나 합치지 않는다(G8, C7-3).
fn configure_module_search_path(command: &mut Command, module_dir: &Path) {
    command.env("NODE_PATH", module_dir.join("node_modules"));
}

/// 자식을 프로세스 그룹으로 띄우고 stdin 본문을 준 뒤 상한 시간까지 기다린다. 초과하면 그룹 전체를
/// 죽여 Cypress가 띄운 브라우저까지 정리한다.
///
/// `ci`는 자식에게 `CI=1`을 물려줄지다. 읽는 사람이 없는 실행·설치는 켜서 진행 표시와
/// 프롬프트를 걷어내지만, 사람이 조작하는 런처에는 붙이지 않는다 — 대화형으로 쓰라고 띄운
/// 창에 비대화형 표시를 거는 셈이다.
///
/// `stop`이 서면 상한을 기다리지 않고 같은 정리 경로로 끝낸다. 자식 핸들을 쥔 이 자리가
/// 직접 죽이므로 신호를 못 보내는 플랫폼에서도 중지가 듣는다.
fn spawn_capped(
    mut command: Command,
    stdin_payload: Option<Vec<u8>>,
    timeout: Duration,
    ci: bool,
    stop: &AtomicBool,
) -> Result<CappedOutcome, CoreError> {
    command
        .stdin(if stdin_payload.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("NO_COLOR", "1");
    if ci {
        command.env("CI", "1");
    }
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
            None if stop.load(Ordering::Relaxed) => {
                kill_group(child.id());
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
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

/// 실행 시간을 넘긴 자식을 그룹째 정리한다. 같은 마지막 수단을 git 실행기도 쓰므로
/// 본체는 `cli_interface`에 한 벌만 둔다.
fn kill_group(pid: u32) {
    crate::cli_interface::kill_process_group(pid);
}

/// 러너 실행 갈래. 무인·수동을 가리지 않고 결과를 내는 `Run`과, 사람이 런처에서 스펙을
/// 고르고 멈춰 가며 보는 `Open`이다. 상태에 함께 실어 보내 화면이 "스펙 전체 실행"과
/// "런처가 열려 있음"을 같은 `running`으로 읽지 않게 한다.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CypressRunMode {
    Run,
    Open,
}

impl CypressRunMode {
    fn is_open(self) -> bool {
        matches!(self, Self::Open)
    }

    /// 이 갈래의 실행 상한. 런처는 사람이 닫을 때까지 살아 있어야 한다.
    fn timeout(self) -> Duration {
        match self {
            Self::Run => RUN_TIMEOUT,
            Self::Open => OPEN_TIMEOUT,
        }
    }
}

/// 러너에게 넘길 페이로드 조립에 필요한 인자들.
struct RunnerPayloadArgs<'a> {
    mode: CypressRunMode,
    workspace: &'a CypressWorkspace,
    project: &'a Path,
    spec: Option<&'a Path>,
    config_file: Option<&'a Path>,
    run_dir: &'a Path,
    run_relative: &'a str,
    extra_env: BTreeMap<String, String>,
}

/// 러너에게 stdin으로 넘길 잡 내용. 비밀은 담지 않는다(모듈 주석 참고).
fn runner_payload(args: RunnerPayloadArgs<'_>) -> Value {
    let RunnerPayloadArgs {
        mode,
        workspace,
        project,
        spec,
        config_file,
        run_dir,
        run_relative,
        extra_env,
    } = args;
    let mut env: BTreeMap<String, Value> = extra_env
        .into_iter()
        .map(|(key, value)| (key, Value::String(value)))
        .collect();
    env.insert(
        "amRunDir".to_owned(),
        Value::String(run_relative.to_owned()),
    );
    // 실행마다 갈아끼우는 설정. 같은 값을 테스트 종류 블록(`e2e`)에도 넣는다 — 프로젝트
    // 설정 파일이 `e2e: { screenshotsFolder, video, … }`처럼 종류 블록 안에 적어 두면 그쪽이
    // 명령줄 설정을 이기기 때문이다. 작업공간 템플릿도 그렇게 적고 있어,
    // 넣지 않으면 스크린샷·다운로드가 실행 폴더 밖(`artifacts/screenshots`)에 떨어져 산출물
    // 목록에 하나도 잡히지 않고 영상 설정도 무시된다. 종류 블록은 합쳐지므로 specPattern·
    // supportFile 같은 나머지 값은 그대로 남는다.
    let overrides = json!({
        "screenshotsFolder": run_dir.join("screenshots"),
        "downloadsFolder": run_dir.join("downloads"),
        "videosFolder": run_dir.join("videos"),
        "video": workspace.record_video,
        "trashAssetsBeforeRuns": false,
    });
    let mut config = overrides.clone();
    config["e2e"] = overrides;
    json!({
        // 런처 모드는 요약도 종료 판정도 다르다. 값이 없는 옛 잡은 지금까지처럼 실행 모드다.
        "mode": if mode.is_open() { "open" } else { "run" },
        "moduleDir": workspace.module_dir(),
        "project": project,
        "spec": spec,
        // 지정한 설정 파일은 러너가 `cypress.run({ configFile })`로 넘긴다. 위 `config`
        // 덮어쓰기는 그대로 이겨, 레인 설정이 증적 폴더를 다시 흩뜨리지 않는다.
        "configFile": config_file,
        "env": env,
        // 창을 띄우는 실행은 사용자가 작업공간마다 켠다. 기본은 헤드리스다 — 무인 회차에서
        // 창이 떠 버리면 화면을 가리고, 화면 없는 호스트에서는 실행 자체가 못 뜬다.
        // 값을 뒤집어 보내지 않는다: `headless: false`를 받아 러너가 다시 뒤집던 때에
        // 헤드리스로 돌아 버렸다(cypress.run은 headless를 truthy일 때만 본다).
        "headed": workspace.headed,
        "config": config,
        "summaryPath": run_dir.join("summary.json"),
    })
}

/// 격리 실행이 부르는 하네스. 작업공간 루트의 고정 경로 `scripts/e2e.mjs` 하나뿐이며,
/// 심링크나 루트 밖으로 빠진 파일은 실행하지 않는다(G9, G10, C7-4).
///
/// 판정 기준은 어느 저장소인지가 아니라 **그 규약을 구현했는지**다. 격리를 성립시키는 것은
/// 임시 포트·임시 상태로 대상 앱을 띄웠다 확실히 정리하는 일이고, 그 일은 앱마다 달라
/// 프로젝트가 가진 하네스만 할 수 있다. 하네스가 없으면 격리라고 부를 근거도 없으므로
/// 무엇을 만들어야 하는지 적어 거절한다.
fn isolated_e2e_script(project: &Path) -> Result<PathBuf, CoreError> {
    let candidate = project.join("scripts/e2e.mjs");
    let metadata = fs::symlink_metadata(&candidate).map_err(|_| {
        CoreError::NotFound(format!(
            "격리 실행 하네스가 없습니다: {}. --job-stdin으로 잡(JSON)을 받아 임시 포트·상태로 앱을 띄우고 Cypress를 돌린 뒤 정리하는 스크립트를 두거나, 실행 방식을 표준 실행으로 바꾸세요",
            candidate.display()
        ))
    })?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(CoreError::InvalidInput(
            "scripts/e2e.mjs는 심링크가 아닌 일반 파일이어야 합니다".to_owned(),
        ));
    }
    canonical_inside_project(
        project,
        &candidate,
        "scripts/e2e.mjs가 작업공간을 벗어납니다",
    )
}

fn available_loopback_port() -> Result<u16, CoreError> {
    let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|error| {
        CoreError::Runtime(format!("격리 E2E 포트를 예약하지 못했습니다: {error}"))
    })?;
    listener
        .local_addr()
        .map(|address| address.port())
        .map_err(|error| CoreError::Runtime(format!("격리 E2E 포트를 읽지 못했습니다: {error}")))
}

/// 하네스에 stdin으로 넘기는 잡. 인자·환경변수로는 아무것도 넘기지 않는다(C7-3).
fn isolated_e2e_payload(
    mode: CypressRunMode,
    workspace: &CypressWorkspace,
    spec: Option<&Path>,
    run_dir: &Path,
    extra_env: BTreeMap<String, String>,
) -> Result<Value, CoreError> {
    Ok(json!({
        "spec": spec,
        // 런처는 하네스가 임시 백엔드를 띄운 채 열고, 창이 닫히면 같은 정리 경로를 탄다.
        // 스펙은 런처 안에서 고르므로 위 값은 쓰이지 않는다.
        "open": mode.is_open(),
        "summaryPath": run_dir.join("summary.json"),
        "screenshotsDir": run_dir.join("screenshots"),
        "port": available_loopback_port()?,
        // 바깥 러너보다 먼저 정리 경로를 타도록 30초 짧게 둔다.
        "timeoutMs": mode.timeout().saturating_sub(Duration::from_secs(30)).as_millis(),
        "env": extra_env,
        "headed": workspace.headed,
        "video": workspace.record_video,
    }))
}

/// 실행이 끝난 뒤 상태 레코드에 덮어쓸 값. 러너 결과 해석을 스레드 밖 순수 계산으로 뺀 것.
struct FinishedRun {
    state: CypressRunState,
    message: Option<String>,
    summary: Option<CypressRunSummary>,
    output_tail: String,
}

impl FinishedRun {
    fn from_error(message: impl Into<String>) -> Self {
        Self {
            state: CypressRunState::Error,
            message: Some(message.into()),
            summary: None,
            output_tail: String::new(),
        }
    }

    fn from_timeout(timeout: Duration, output_tail: String) -> Self {
        Self {
            state: CypressRunState::TimedOut,
            message: Some(format!(
                "{}분 안에 끝나지 않아 중단했습니다",
                timeout.as_secs() / 60
            )),
            summary: None,
            output_tail,
        }
    }

    /// 런처를 띄운 수동 실행의 끝. 요약이 없으니 통과·실패를 말하지 않고, 사람이 창을 닫은
    /// 것과 런처가 뜨지 못한 것만 가른다. 뜨지 못한 사유는 러너가 요약에 남긴다.
    fn from_closed(
        outcome: &CappedOutcome,
        summary: Option<CypressRunSummary>,
        output_tail: String,
    ) -> Self {
        if outcome.success {
            return Self {
                state: CypressRunState::Closed,
                message: None,
                summary: None,
                output_tail,
            };
        }
        let message = summary
            .and_then(|summary| summary.error)
            .unwrap_or_else(|| {
                format!(
                    "Cypress 런처를 띄우지 못했습니다(exit {})",
                    outcome.exit_code_text()
                )
            });
        Self {
            state: CypressRunState::Error,
            message: Some(message),
            summary: None,
            output_tail,
        }
    }

    /// 정상 종료된 러너 잡의 결과와 요약 파일을 결합해 최종 상태를 결정한다.
    fn from_completed(
        outcome: &CappedOutcome,
        summary: Option<CypressRunSummary>,
        output_tail: String,
    ) -> Self {
        let (state, message, summary) = match summary {
            Some(summary) if summary.error.is_none() => {
                let state = if summary.failed == 0 && outcome.success {
                    CypressRunState::Passed
                } else {
                    CypressRunState::Failed
                };
                (state, None, Some(summary))
            }
            Some(summary) => {
                let error = summary.error.clone();
                (CypressRunState::Error, error, Some(summary))
            }
            None => (
                CypressRunState::Error,
                Some(format!(
                    "러너가 요약을 남기지 않았습니다(exit {})",
                    outcome.exit_code_text()
                )),
                None,
            ),
        };
        Self {
            state,
            message,
            summary,
            output_tail,
        }
    }

    /// 러너의 실행 결과(또는 기동 오류)와 요약 파일을 단일 상태 레코드로 접는다.
    fn from_outcome(
        mode: CypressRunMode,
        outcome: Result<CappedOutcome, CoreError>,
        summary: Option<CypressRunSummary>,
        secrets: &[String],
    ) -> Self {
        let outcome = match outcome {
            Ok(outcome) => outcome,
            Err(error) => return Self::from_error(error.to_string()),
        };
        let output_tail = outcome.scrubbed_tail(secrets);
        if outcome.timed_out {
            Self::from_timeout(mode.timeout(), output_tail)
        } else if mode.is_open() {
            Self::from_closed(&outcome, summary, output_tail).with_startup_cause()
        } else {
            Self::from_completed(&outcome, summary, output_tail).with_startup_cause()
        }
    }

    /// 기동 실패의 진짜 사유를 상태 메시지에 함께 싣는다.
    ///
    /// Cypress는 브라우저를 찾으려 띄운 자식 프로세스가 없어서 죽어도 결과가 없다는 말
    /// (`Could not find Cypress test run results`)만 남기고, 사유(`spawn powershell.exe
    /// ENOENT`)는 수집한 출력 안쪽에만 둔다. 상태만 읽는 사람에게는 어느 단계에서 끝났는지
    /// 알 길이 없어, 실제로 두 번 "설정 로딩 실패"로 오진됐다. 출력은 이미 비밀값이
    /// 지워진 꼬리라 그대로 붙여도 새는 값이 없다(C7-3).
    fn with_startup_cause(mut self) -> Self {
        if !matches!(self.state, CypressRunState::Error) {
            return self;
        }
        let Some(cause) = startup_failure_line(&self.output_tail).map(str::to_owned) else {
            return self;
        };
        self.message = Some(match self.message.take() {
            Some(message) if message.contains(&cause) => message,
            Some(message) => format!("{message} ({cause})"),
            None => cause,
        });
        self
    }
}

/// 출력에서 자식 프로세스를 띄우지 못한 줄을 찾는다. Node가 그대로 흘려보내는
/// `spawn <파일> <오류코드>` 모양만 본다 — 테스트 실패 메시지에 섞인 다른 오류를
/// 기동 사유로 잘못 지목하지 않으려는 것이다. 여러 줄이면 첫 줄만 쓴다.
fn startup_failure_line(output: &str) -> Option<&str> {
    const SPAWN_ERRORS: [&str; 4] = ["ENOENT", "EACCES", "EPERM", "EAGAIN"];
    output
        .lines()
        .map(|line| line.trim().trim_start_matches("Error: ").trim())
        .find(|line| {
            line.starts_with("spawn ") && SPAWN_ERRORS.iter().any(|code| line.ends_with(code))
        })
}

/// 러너의 종료 결과와 요약 파일을 상태 하나로 접는다.
///
/// 시간 초과는 요약이 남아 있어도 신뢰하지 않는다(중단 시점의 조각일 수 있다).
fn finished_run(
    mode: CypressRunMode,
    outcome: Result<CappedOutcome, CoreError>,
    summary: Option<CypressRunSummary>,
    secrets: &[String],
) -> FinishedRun {
    FinishedRun::from_outcome(mode, outcome, summary, secrets)
}

/// 실행 요청이 준 작업공간 상대 경로를 실제 파일로 확정한다. 빈 값은 "고르지 않음"이라
/// 오류가 아니다. 스펙과 설정 파일이 같은 가드(작업공간 기준 상대 경로, `..` 금지, 존재하는
/// 파일)를 쓰므로 판정은 여기 한 벌만 둔다 — 값마다 다른 것은 안내 문구의 주어뿐이다.
fn existing_relative_file<'a>(
    project: &Path,
    raw: Option<&'a str>,
    what: &str,
) -> Result<Option<(&'a str, PathBuf)>, CoreError> {
    let Some(raw) = raw.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    let relative = cypress_workspaces::validate_relative_path(raw)?;
    let target = project.join(&relative);
    if !target.is_file() {
        return Err(CoreError::NotFound(format!(
            "{what} 파일이 없습니다: {raw}"
        )));
    }
    Ok(Some((raw, target)))
}

/// 심링크를 따라 정규화한 경로가 작업공간 루트 안인지 확인하고 그 정규 경로를 돌려준다.
/// Node가 코드로 불러오는 파일은 링크 하나로 루트 밖 코드를 실행시킬 수 있어 설정 파일과
/// 격리 하네스가 같은 검사를 쓴다(G10).
fn canonical_inside_project(
    project: &Path,
    target: &Path,
    escaped: &str,
) -> Result<PathBuf, CoreError> {
    // 양쪽을 같은 모양(접두어 없는 정규 경로)으로 맞춰 비교한다 — 호출자가 어느 모양을 넘겨도
    // 경계 판정이 달라지지 않는다.
    let canonical = child_facing(&fs::canonicalize(target)?);
    if !canonical.starts_with(child_facing(project)) {
        return Err(CoreError::InvalidInput(escaped.to_owned()));
    }
    Ok(canonical)
}

fn validate_spec(project: &Path, spec: Option<&str>) -> Result<Option<PathBuf>, CoreError> {
    Ok(existing_relative_file(project, spec, "스펙")?.map(|(_, target)| target))
}

/// 실행마다 다른 설정 파일을 고르게 한다 — 레인마다 baseUrl·specPattern이 다른 프로젝트가
/// 설정 파일을 복사해 두고 실행 때 지정하는 방식이다. 경로 가드는 스펙과 같되 한 단계 더
/// 좁힌다: 설정 파일은 Cypress가 Node 코드로 불러오므로 정규 경로가 루트 안인지 확인한다.
fn validate_config_file(
    project: &Path,
    config_file: Option<&str>,
) -> Result<Option<PathBuf>, CoreError> {
    let Some((raw, target)) = existing_relative_file(project, config_file, "설정")? else {
        return Ok(None);
    };
    canonical_inside_project(
        project,
        &target,
        &format!("설정 파일이 작업공간을 벗어납니다: {raw}"),
    )
    .map(Some)
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
    /// 목록 잠금 아래에서 항목을 하나씩 열어 보고, `visit`이 값을 돌려주는 첫 항목에서 멈춘다.
    /// 조회·정지·중복 실행 검사가 전부 같은 순회를 쓰므로 순회 자체는 여기 한 벌만 둔다.
    fn find_map<T>(
        &self,
        mut visit: impl FnMut(&mut CypressRunStatus) -> Option<T>,
    ) -> Result<Option<T>, CoreError> {
        let runs = lock(&self.runs)?;
        for run in runs.iter() {
            let mut guard = lock(run)?;
            if let Some(found) = visit(&mut guard) {
                return Ok(Some(found));
            }
        }
        Ok(None)
    }

    pub fn status(&self, job_id: &str) -> Result<Option<CypressRunStatus>, CoreError> {
        self.find_map(|run| (run.job_id == job_id).then(|| run.clone()))
    }

    pub fn list(&self) -> Result<Vec<CypressRunStatus>, CoreError> {
        let runs = lock(&self.runs)?;
        runs.iter().rev().map(|run| status_snapshot(run)).collect()
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
        config_file: Option<&str>,
        extra_env: BTreeMap<String, String>,
    ) -> Result<CypressRunStatus, CoreError> {
        self.launch(
            CypressRunMode::Run,
            app_data_dir,
            workspace,
            spec,
            config_file,
            extra_env,
        )
    }

    /// Cypress 런처를 띄운다. 스펙을 고르고 멈춰 가며 보는 것은 런처 안에서 사람이 하므로
    /// 스펙은 받지 않는다. 창이 뜨는 호스트에서만 의미가 있어 호출 경로가 호스트로 잠겨 있고,
    /// 창을 닫아야 끝나므로 같은 작업공간에 둘째 런처를 띄우지 않는다.
    ///
    /// 격리 실행도 연다 — 하네스가 임시 포트·상태로 앱을 띄운 채 런처를 열고 창이 닫히면
    /// 정리하므로, 앱 자체 QA도 같은 자리에서 단계별로 볼 수 있다.
    pub fn open(
        &self,
        app_data_dir: &Path,
        workspace: &CypressWorkspace,
        config_file: Option<&str>,
        extra_env: BTreeMap<String, String>,
    ) -> Result<CypressRunStatus, CoreError> {
        if self.has_running(&workspace.id)? {
            return Err(CoreError::InvalidInput(
                "이 작업공간에서 이미 실행 중인 작업이 있습니다. 끝나거나 런처 창을 닫은 뒤 다시 여세요"
                    .to_owned(),
            ));
        }
        self.launch(
            CypressRunMode::Open,
            app_data_dir,
            workspace,
            None,
            config_file,
            extra_env,
        )
    }

    /// 도는 실행을 끝낸다. 런처는 창을 닫는 것이 정상 종료지만, 원격 화면에서 연 창은 그
    /// 자리에서 닫을 수 없으므로 여기서 끝낼 길을 둔다. 헤드리스 실행도 같은 길로 끊는다.
    ///
    /// 깃발만 세우고 돌아온다 — 실제 정리는 자식을 기다리는 쪽이 하고, 끝난 상태는 평소처럼
    /// 상태 조회로 따라간다. 이미 끝난 실행은 조용히 그 상태를 돌려준다.
    pub fn stop(&self, job_id: &str) -> Result<CypressRunStatus, CoreError> {
        self.find_map(|run| {
            if run.job_id != job_id {
                return None;
            }
            if run.state == CypressRunState::Running {
                run.stopped = true;
                run.stop_flag.store(true, Ordering::Relaxed);
            }
            Some(run.clone())
        })?
        .ok_or_else(|| CoreError::NotFound(format!("Cypress 실행을 찾을 수 없습니다: {job_id}")))
    }

    /// 이 작업공간에 아직 끝나지 않은 실행이 있는지.
    fn has_running(&self, workspace_id: &str) -> Result<bool, CoreError> {
        Ok(self
            .find_map(|run| {
                (run.workspace_id == workspace_id && run.state == CypressRunState::Running)
                    .then_some(())
            })?
            .is_some())
    }

    fn launch(
        &self,
        mode: CypressRunMode,
        app_data_dir: &Path,
        workspace: &CypressWorkspace,
        spec: Option<&str>,
        config_file: Option<&str>,
        extra_env: BTreeMap<String, String>,
    ) -> Result<CypressRunStatus, CoreError> {
        let plan = prepare_launch(mode, app_data_dir, workspace, spec, config_file, extra_env)?;

        let stop_flag = Arc::new(AtomicBool::new(false));
        let record = self.push(CypressRunStatus::running(
            plan.job_id.clone(),
            workspace.id.clone(),
            mode,
            spec.map(str::to_owned),
            Arc::clone(&stop_flag),
        ))?;
        let initial = status_snapshot(&record)?;

        let worker_record = Arc::clone(&record);
        thread::Builder::new()
            .name(format!("cypress-run-{}", plan.job_id))
            .spawn(move || {
                let (finished, artifacts) = run_plan(plan, mode, &stop_flag);
                if let Ok(mut status) = worker_record.lock() {
                    status.finish(finished, artifacts);
                }
            })
            .map_err(|error| {
                CoreError::Runtime(format!("Cypress 실행 스레드를 만들지 못했습니다: {error}"))
            })?;
        Ok(initial)
    }
}

/// 준비 단계가 확정한 한 벌. 여기까지 왔으면 거절할 자리는 남지 않았고, 뒤에 오는 것은
/// 기록을 만드는 일과 러너를 돌리는 일뿐이다.
struct LaunchPlan {
    job_id: String,
    node: PathBuf,
    entrypoint: PathBuf,
    module_dir: PathBuf,
    project: PathBuf,
    run_dir: PathBuf,
    payload: Value,
    /// 격리 실행은 러너도 요약 형식도 다르다. 두 갈래의 차이는 이 깃발 하나로 모인다.
    isolated: bool,
    secrets: Vec<String>,
}

/// 실행 요청을 검증하고 러너에게 넘길 것들을 확정한다.
///
/// 여기서 돌려주는 오류는 전부 아직 아무것도 시작하지 않은 상태의 거절이다. 잡 기록이
/// 생기기 전에 끝나므로 화면에는 실패한 실행이 아니라 시작 거절로 닿는다.
fn prepare_launch(
    mode: CypressRunMode,
    app_data_dir: &Path,
    workspace: &CypressWorkspace,
    spec: Option<&str>,
    config_file: Option<&str>,
    extra_env: BTreeMap<String, String>,
) -> Result<LaunchPlan, CoreError> {
    // 여기서 접두어를 벗겨 두면 아래 스펙·설정·실행 폴더·요약 경로가 전부 그 모양을 따른다.
    let project = child_facing(&fs::canonicalize(workspace.project_dir()).map_err(|_| {
        CoreError::NotFound(format!("작업공간 폴더가 없습니다: {}", workspace.path))
    })?);
    if !module_ready(workspace) {
        return Err(CoreError::InvalidInput(
            "이 작업공간에 Cypress 모듈이 없습니다. 애드온 → Cypress 탭에서 '설치'를 누르거나 모듈 위치를 지정하세요"
                .to_owned(),
        ));
    }
    let spec_path = validate_spec(&project, spec)?;
    let config_path = validate_config_file(&project, config_file)?;
    // 격리 실행은 `scripts/e2e.mjs`가 설정을 직접 만들어 넘기므로 끼어들 자리가 없다.
    // 조용히 무시하면 다른 설정으로 돈 결과를 그 설정의 결과로 읽게 된다.
    if config_path.is_some()
        && workspace.execution_type == CypressExecutionType::AgentManagerIsolated
    {
        return Err(CoreError::InvalidInput(
            "격리 실행은 설정 파일을 지정할 수 없습니다 — 하네스가 설정을 직접 만듭니다".to_owned(),
        ));
    }
    validate_env(&extra_env)?;
    let node = crate::providers::resolve_named_executable(&["node"])?;
    let job_id = Uuid::new_v4().simple().to_string();
    let run_relative = format!("artifacts/runs/{job_id}");
    let run_dir = project.join(&run_relative);
    fs::create_dir_all(&run_dir)?;
    let secrets = cypress_workspaces::env_secret_values(workspace);
    // 등록 시 저장된 모듈 위치도 정규 경로라 같은 접두어를 달고 있다.
    let module_dir = child_facing(&workspace.module_dir());

    let (entrypoint, payload, isolated) = match workspace.execution_type {
        CypressExecutionType::Standard => (
            ensure_runner(app_data_dir)?,
            runner_payload(RunnerPayloadArgs {
                mode,
                workspace,
                project: &project,
                spec: spec_path.as_deref(),
                config_file: config_path.as_deref(),
                run_dir: &run_dir,
                run_relative: &run_relative,
                extra_env,
            }),
            false,
        ),
        CypressExecutionType::AgentManagerIsolated => (
            isolated_e2e_script(&project)?,
            isolated_e2e_payload(mode, workspace, spec_path.as_deref(), &run_dir, extra_env)?,
            true,
        ),
    };

    Ok(LaunchPlan {
        job_id,
        node,
        entrypoint,
        module_dir,
        project,
        run_dir,
        payload,
        isolated,
        secrets,
    })
}

/// 준비된 계획으로 러너를 끝까지 돌린다. 실행 스레드의 몸통이고, 잡 기록 잠금은 여기까지
/// 내려오지 않는다 — 돌려준 두 값을 부르는 쪽이 자기 기록에 접어 넣는다.
fn run_plan(
    plan: LaunchPlan,
    mode: CypressRunMode,
    stop_flag: &AtomicBool,
) -> (FinishedRun, Vec<CypressRunArtifact>) {
    let mut command = command_on_resolved_path(&plan.node);
    configure_module_search_path(&mut command, &plan.module_dir);
    command.arg(&plan.entrypoint);
    if plan.isolated {
        command.arg("--job-stdin");
    }
    command.current_dir(&plan.project);
    let outcome = spawn_capped(
        command,
        Some(serde_json::to_vec(&plan.payload).unwrap_or_default()),
        mode.timeout(),
        !mode.is_open(),
        stop_flag,
    );
    let summary = read_summary(&plan.run_dir, plan.isolated);
    let artifacts = collect_artifacts(&plan.project, &plan.run_dir, &plan.secrets);
    let finished = finished_run(mode, outcome, summary, &plan.secrets);
    (finished, artifacts)
}

/// 러너가 남긴 요약 파일. 없거나 깨졌으면 종료 결과만으로 상태를 접는다.
fn read_summary(run_dir: &Path, isolated: bool) -> Option<CypressRunSummary> {
    let bytes = fs::read(run_dir.join("summary.json")).ok()?;
    if isolated {
        serde_json::from_slice::<IsolatedE2eSummary>(&bytes)
            .ok()
            .map(CypressRunSummary::from)
    } else {
        serde_json::from_slice::<CypressRunSummary>(&bytes).ok()
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
    // 등록 시 저장된 모듈 위치도 정규 경로라 접두어를 달고 있다. 실행 경로와 같은 손질을 한다.
    let module_dir = child_facing(&workspace.module_dir());
    // package.json이 없으면 만들어 두고 설치한다. 없는 채로 npm을 돌리면 상위 폴더의
    // package.json을 찾아 올라가 엉뚱한 프로젝트에 cypress가 들어간다.
    cypress_workspaces::ensure_module_package_json(&module_dir)?;
    let npm = crate::providers::resolve_named_executable(&["npm"])?;
    let mut command = command_on_resolved_path(&npm);
    command
        .args([
            "install",
            "--save-dev",
            "--no-audit",
            "--no-fund",
            &format!("cypress@{version}"),
        ])
        .current_dir(&module_dir);
    let outcome = spawn_capped(
        command,
        None,
        INSTALL_TIMEOUT,
        true,
        &AtomicBool::new(false),
    )?;
    let output = outcome.scrubbed_tail(&[]);
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

    /// 작업공간에 켠 실행 옵션이 러너 잡에 그대로 실린다. 끈 상태의 기본값(헤드리스·영상 없음)도
    /// 함께 본다 — 무인 회차가 도는 작업공간에서 창이 뜨거나 영상이 쌓이면 안 된다.
    #[test]
    fn workspace_run_options_reach_the_runner_job() {
        let mut workspace = CypressWorkspace {
            id: "w".to_owned(),
            name: "w".to_owned(),
            path: "/tmp/w".to_owned(),
            module_dir: None,
            execution_type: CypressExecutionType::Standard,
            record_video: false,
            headed: false,
            created_at: 0,
        };
        let project = Path::new("/tmp/w");
        let run_dir = project.join("artifacts/runs/job1");
        let payload = |workspace: &CypressWorkspace| {
            runner_payload(RunnerPayloadArgs {
                mode: CypressRunMode::Run,
                workspace,
                project,
                spec: None,
                config_file: None,
                run_dir: &run_dir,
                run_relative: "artifacts/runs/job1",
                extra_env: BTreeMap::new(),
            })
        };
        let off = payload(&workspace);
        assert_eq!(off["headed"], serde_json::json!(false));
        assert_eq!(off["config"]["video"], serde_json::json!(false));
        assert_eq!(off["config"]["e2e"]["video"], serde_json::json!(false));

        workspace.record_video = true;
        workspace.headed = true;
        let on = payload(&workspace);
        assert_eq!(on["headed"], serde_json::json!(true));
        assert_eq!(on["config"]["video"], serde_json::json!(true));
        assert_eq!(
            on["config"]["videosFolder"],
            serde_json::json!(run_dir.join("videos"))
        );
        // 종류 블록에도 같은 값이 실려야 프로젝트 설정 파일의 `e2e:` 값을 이긴다.
        assert_eq!(on["config"]["e2e"]["video"], serde_json::json!(true));
        assert_eq!(
            on["config"]["e2e"]["screenshotsFolder"],
            serde_json::json!(run_dir.join("screenshots"))
        );
        assert_eq!(
            on["config"]["e2e"]["videosFolder"],
            serde_json::json!(run_dir.join("videos"))
        );
    }

    /// 영상 산출물은 본문 없이 종류로만 구분해 화면이 "재생할 파일"로 보일 수 있어야 한다.
    #[test]
    fn video_files_are_their_own_artifact_kind() {
        assert_eq!(
            ArtifactKind::from_path(Path::new("videos/a.mp4")).as_str(),
            "video"
        );
        assert_eq!(
            ArtifactKind::from_path(Path::new("videos/a.webm")).as_str(),
            "video"
        );
        assert_eq!(
            ArtifactKind::from_path(Path::new("screenshots/a.png")).as_str(),
            "image"
        );
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

    /// 레인마다 다른 설정 파일을 지정해도 경로 가드는 스펙과 같고, 검증된 경로는 러너 잡의
    /// `configFile`로 실린다. 지정하지 않은 실행은 기본 설정 그대로라 키가 비어 있다.
    #[test]
    fn a_run_can_pin_its_own_config_file_inside_the_workspace() {
        let project = TempDir::new().unwrap();
        let root = fs::canonicalize(project.path()).unwrap();
        fs::write(root.join("cypress.lane.config.js"), "module.exports = {};").unwrap();
        assert!(validate_config_file(&root, None).unwrap().is_none());
        // 검증된 경로는 자식에게 넘길 모양(Windows 확장 경로 접두어 없음)으로 돌아온다.
        assert_eq!(
            validate_config_file(&root, Some("cypress.lane.config.js")).unwrap(),
            Some(child_facing(&root).join("cypress.lane.config.js"))
        );
        assert!(matches!(
            validate_config_file(&root, Some("../cypress.config.js")),
            Err(CoreError::InvalidInput(_))
        ));
        assert!(matches!(
            validate_config_file(&root, Some("cypress.missing.config.js")),
            Err(CoreError::NotFound(_))
        ));

        let workspace = CypressWorkspace {
            id: "w".to_owned(),
            name: "w".to_owned(),
            path: root.to_string_lossy().into_owned(),
            module_dir: None,
            execution_type: CypressExecutionType::Standard,
            record_video: false,
            headed: false,
            created_at: 0,
        };
        let run_dir = root.join("artifacts/runs/job1");
        let pinned = runner_payload(RunnerPayloadArgs {
            mode: CypressRunMode::Run,
            workspace: &workspace,
            project: &root,
            spec: None,
            config_file: Some(&root.join("cypress.lane.config.js")),
            run_dir: &run_dir,
            run_relative: "artifacts/runs/job1",
            extra_env: BTreeMap::new(),
        });
        assert_eq!(
            pinned["configFile"],
            json!(root.join("cypress.lane.config.js"))
        );
        // 레인 설정이 증적 폴더를 다시 선언해도 실행별 폴더가 이긴다.
        assert_eq!(
            pinned["config"]["e2e"]["screenshotsFolder"],
            json!(run_dir.join("screenshots"))
        );
        let default_config = runner_payload(RunnerPayloadArgs {
            mode: CypressRunMode::Run,
            workspace: &workspace,
            project: &root,
            spec: None,
            config_file: None,
            run_dir: &run_dir,
            run_relative: "artifacts/runs/job1",
            extra_env: BTreeMap::new(),
        });
        assert_eq!(default_config["configFile"], Value::Null);
    }

    #[test]
    fn starting_without_a_cypress_module_is_refused_and_the_runner_is_materialized() {
        let data = TempDir::new().unwrap();
        let project = TempDir::new().unwrap();
        let workspace = CypressWorkspace {
            id: "no-module".to_owned(),
            name: "no-module".to_owned(),
            path: project.path().to_string_lossy().into_owned(),
            module_dir: None,
            execution_type: CypressExecutionType::Standard,
            record_video: false,
            headed: false,
            created_at: 0,
        };
        let error = runs()
            .start(data.path(), &workspace, None, None, BTreeMap::new())
            .expect_err("no module installed");
        assert!(matches!(error, CoreError::InvalidInput(_)));
        let runner = ensure_runner(data.path()).unwrap();
        assert_eq!(fs::read_to_string(runner).unwrap(), RUNNER_SCRIPT);
        assert!(runs().status("missing").unwrap().is_none());
    }

    /// C7: `moduleDir`이 프로젝트 밖에 있어도 설정 로더와 그 자식 Node 프로세스가 같은
    /// 모듈 트리를 찾는다. 이 경로는 호스트의 기존 NODE_PATH를 읽지 않고 명시적으로 정한다(G8).
    #[test]
    fn separate_module_dir_reaches_config_loader_and_child_processes() {
        let data = TempDir::new().unwrap();
        let project = TempDir::new().unwrap();
        let modules = TempDir::new().unwrap();
        let node_modules = modules.path().join("node_modules");
        fs::create_dir_all(node_modules.join("cypress")).unwrap();
        fs::create_dir_all(node_modules.join("config-helper")).unwrap();
        fs::create_dir_all(node_modules.join("child-helper")).unwrap();
        fs::write(
            node_modules.join("cypress/package.json"),
            r#"{"name":"cypress","main":"index.js"}"#,
        )
        .unwrap();
        fs::write(
            node_modules.join("cypress/index.js"),
            r#"
const path = require("node:path");
const { spawnSync } = require("node:child_process");
exports.run = async (options) => {
  require(options.configFile || path.join(options.project, "cypress.config.js"));
  const child = spawnSync(process.execPath, ["-e", "require('child-helper')"], { cwd: options.project });
  if (child.status !== 0) return { status: "failed", message: child.stderr.toString() };
  return { totalPassed: 1, totalFailed: 0, totalPending: 0, totalDuration: 1, runs: [] };
};
"#,
        )
        .unwrap();
        fs::write(
            node_modules.join("config-helper/package.json"),
            r#"{"name":"config-helper","main":"index.js"}"#,
        )
        .unwrap();
        fs::write(
            node_modules.join("config-helper/index.js"),
            "module.exports = true;",
        )
        .unwrap();
        fs::write(
            node_modules.join("child-helper/package.json"),
            r#"{"name":"child-helper","main":"index.js"}"#,
        )
        .unwrap();
        fs::write(
            node_modules.join("child-helper/index.js"),
            "module.exports = true;",
        )
        .unwrap();
        fs::write(
            project.path().join("cypress.config.js"),
            "require('config-helper'); module.exports = {};",
        )
        .unwrap();

        let workspace = CypressWorkspace {
            id: "separate-modules".to_owned(),
            name: "separate-modules".to_owned(),
            path: project.path().to_string_lossy().into_owned(),
            module_dir: Some(modules.path().to_string_lossy().into_owned()),
            execution_type: CypressExecutionType::Standard,
            record_video: false,
            headed: false,
            created_at: 0,
        };
        let started = runs()
            .start(data.path(), &workspace, None, None, BTreeMap::new())
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        let finished = loop {
            let status = runs().status(&started.job_id).unwrap().unwrap();
            if status.state.is_terminal() {
                break status;
            }
            assert!(
                Instant::now() < deadline,
                "별도 moduleDir 실행이 끝나지 않음"
            );
            thread::sleep(Duration::from_millis(20));
        };

        assert_eq!(
            finished.state,
            CypressRunState::Passed,
            "{}",
            finished.output_tail
        );
        assert_eq!(finished.summary.as_ref().unwrap().passed, 1);
    }

    /// 격리 실행은 저장소를 가리지 않는다 — 규약대로 `scripts/e2e.mjs`를 둔 프로젝트면
    /// 고정 진입점과 stdin 잡으로 돈다. 이름이 `agent-manager-tauri`가 아닌 프로젝트로 본다.
    #[test]
    fn an_isolated_run_uses_the_fixed_script_and_stdin_job_in_any_project() {
        let data = TempDir::new().unwrap();
        let project = TempDir::new().unwrap();
        fs::create_dir_all(project.path().join("scripts")).unwrap();
        fs::create_dir_all(project.path().join("node_modules/cypress")).unwrap();
        fs::create_dir_all(project.path().join("cypress/e2e")).unwrap();
        fs::write(
            project.path().join("package.json"),
            r#"{"name":"some-react-app"}"#,
        )
        .unwrap();
        fs::write(
            project.path().join("node_modules/cypress/package.json"),
            r#"{"version":"15.21.1"}"#,
        )
        .unwrap();
        fs::write(project.path().join("cypress/e2e/one.cy.ts"), "// spec").unwrap();
        fs::write(
            project.path().join("scripts/e2e.mjs"),
            r#"
import fs from "node:fs";
import path from "node:path";
if (process.argv[2] !== "--job-stdin") process.exit(9);
const job = JSON.parse(fs.readFileSync(0, "utf8"));
fs.mkdirSync(path.dirname(job.summaryPath), { recursive: true });
fs.writeFileSync(path.join(path.dirname(job.summaryPath), "job.json"), JSON.stringify({ port: job.port, env: job.env, summaryPath: job.summaryPath, cwd: process.cwd() }));
fs.writeFileSync(job.summaryPath, JSON.stringify({
  totalPassed: 1,
  totalFailed: 0,
  totalPending: 0,
  totalDuration: 12,
  runs: [{ spec: "cypress/e2e/one.cy.ts", tests: [{ title: "isolated", state: "passed" }], screenshots: [] }]
}));
"#,
        )
        .unwrap();
        let workspace = CypressWorkspace {
            id: "isolated".to_owned(),
            name: "isolated".to_owned(),
            path: project.path().to_string_lossy().into_owned(),
            module_dir: None,
            execution_type: CypressExecutionType::AgentManagerIsolated,
            record_video: false,
            headed: false,
            created_at: 0,
        };
        let mut env = BTreeMap::new();
        env.insert("case".to_owned(), "isolated".to_owned());
        let started = runs()
            .start(
                data.path(),
                &workspace,
                Some("cypress/e2e/one.cy.ts"),
                None,
                env,
            )
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        let finished = loop {
            let status = runs().status(&started.job_id).unwrap().unwrap();
            if status.state.is_terminal() {
                break status;
            }
            assert!(Instant::now() < deadline, "격리 실행이 끝나지 않음");
            thread::sleep(Duration::from_millis(20));
        };

        assert_eq!(finished.state, CypressRunState::Passed);
        assert_eq!(finished.summary.as_ref().unwrap().passed, 1);
        let job = finished
            .artifacts
            .iter()
            .find(|artifact| artifact.path.ends_with("/job.json"))
            .and_then(|artifact| artifact.content.as_deref())
            .expect("stdin job artifact");
        let job: Value = serde_json::from_str(job).unwrap();
        assert!(job["port"].as_u64().is_some_and(|port| port > 0));
        assert_eq!(job["env"]["case"], "isolated");
        // 하네스가 받은 경로와 작업 폴더에 Windows 확장 경로 접두어가 없어야 한다 — Cypress
        // 설정 로더가 `\\?\`를 풀지 못해 실행이 설정 단계에서 끝났던 결함의 회귀 검사.
        for key in ["summaryPath", "cwd"] {
            let value = job[key].as_str().expect(key);
            assert!(
                !value.starts_with(r"\\?\"),
                "{key}에 확장 경로 접두어가 남아 있음: {value}"
            );
        }
    }

    /// 자식에게 넘기는 경로는 정규화 결과에서 Windows 확장 경로 접두어만 벗긴 것이어야 한다.
    /// 같은 곳을 가리키되(메타데이터 조회 성공) 모양만 달라진다. 다른 플랫폼에서는 그대로다.
    #[test]
    fn child_facing_paths_drop_the_windows_verbatim_prefix_but_stay_valid() {
        let dir = TempDir::new().unwrap();
        let canonical = fs::canonicalize(dir.path()).unwrap();
        let facing = child_facing(&canonical);
        assert!(!facing.to_string_lossy().starts_with(r"\\?\"));
        assert!(fs::metadata(&facing).unwrap().is_dir());
        #[cfg(windows)]
        assert!(canonical.to_string_lossy().starts_with(r"\\?\"));
        #[cfg(not(windows))]
        assert_eq!(facing, canonical);
    }

    fn standard_workspace() -> CypressWorkspace {
        CypressWorkspace {
            id: "w".to_owned(),
            name: "w".to_owned(),
            path: "/tmp/w".to_owned(),
            module_dir: None,
            execution_type: CypressExecutionType::Standard,
            record_video: false,
            headed: false,
            created_at: 0,
        }
    }

    /// 런처 잡은 러너가 `cypress.open()`으로 갈라 읽는 mode만 다르고, 증적 폴더를 실행별로
    /// 가르는 설정은 실행 잡과 같아야 한다 — 런처에서 찍은 스크린샷도 같은 자리에 모인다.
    #[test]
    fn launcher_job_carries_the_open_mode_with_the_same_artifact_folders() {
        let workspace = standard_workspace();
        let project = Path::new("/tmp/w");
        let run_dir = project.join("artifacts/runs/job1");
        let payload = |mode: CypressRunMode| {
            runner_payload(RunnerPayloadArgs {
                mode,
                workspace: &workspace,
                project,
                spec: None,
                config_file: None,
                run_dir: &run_dir,
                run_relative: "artifacts/runs/job1",
                extra_env: BTreeMap::new(),
            })
        };
        let open = payload(CypressRunMode::Open);
        assert_eq!(open["mode"], serde_json::json!("open"));
        assert_eq!(
            payload(CypressRunMode::Run)["mode"],
            serde_json::json!("run")
        );
        assert_eq!(
            open["config"]["e2e"]["screenshotsFolder"],
            serde_json::json!(run_dir.join("screenshots"))
        );
    }

    /// 런처는 사람이 닫을 때까지 살아 있는 갈래라 상한이 헤드리스 실행보다 길다.
    #[test]
    fn launcher_mode_waits_longer_than_a_headless_run() {
        assert_eq!(CypressRunMode::Run.timeout(), RUN_TIMEOUT);
        assert_eq!(CypressRunMode::Open.timeout(), OPEN_TIMEOUT);
        assert!(CypressRunMode::Open.timeout() > CypressRunMode::Run.timeout());
        assert!(CypressRunMode::Open.is_open());
        assert!(!CypressRunMode::Run.is_open());
    }

    /// 격리 실행의 런처 잡. 하네스가 임시 포트·상태로 앱을 띄운 채 런처를 열어야 하므로
    /// `open`이 실려 가고, 하네스 쪽 상한도 런처 상한을 따라간다 — 실행 상한(20분)을 그대로
    /// 두면 사람이 보고 있는 창을 하네스가 먼저 걷어 간다.
    #[test]
    fn isolated_launcher_job_carries_the_open_flag_and_the_launcher_timeout() {
        let mut workspace = standard_workspace();
        workspace.execution_type = CypressExecutionType::AgentManagerIsolated;
        let run_dir = Path::new("/tmp/w/artifacts/runs/job1");
        let payload = |mode: CypressRunMode| {
            isolated_e2e_payload(mode, &workspace, None, run_dir, BTreeMap::new()).expect("payload")
        };
        let open = payload(CypressRunMode::Open);
        assert_eq!(open["open"], serde_json::json!(true));
        let open_timeout = open["timeoutMs"].as_u64().expect("timeoutMs");
        assert!(open_timeout > RUN_TIMEOUT.as_secs() * 1_000);
        assert!(open_timeout < OPEN_TIMEOUT.as_secs() * 1_000);

        let run = payload(CypressRunMode::Run);
        assert_eq!(run["open"], serde_json::json!(false));
        assert!(run["timeoutMs"].as_u64().expect("timeoutMs") < RUN_TIMEOUT.as_secs() * 1_000);
    }

    /// 런처 창은 작업공간마다 하나다. 이미 도는 작업이 있으면 둘째 창을 띄우지 않는다 —
    /// 같은 프로젝트를 두 Cypress가 동시에 잡으면 증적과 포트가 엉킨다.
    #[test]
    fn launcher_refuses_a_second_window_while_a_run_is_live() {
        let app_data = TempDir::new().expect("temp dir");
        let workspace = standard_workspace();
        let runs = CypressRuns::default();
        assert!(!runs.has_running(&workspace.id).expect("empty"));
        runs.push(CypressRunStatus {
            job_id: "j1".to_owned(),
            workspace_id: workspace.id.clone(),
            mode: CypressRunMode::Run,
            spec: None,
            state: CypressRunState::Running,
            started_at: 0,
            finished_at: None,
            summary: None,
            artifacts: Vec::new(),
            output_tail: String::new(),
            message: None,
            stop_flag: Arc::new(AtomicBool::new(false)),
            stopped: false,
        })
        .expect("push");
        assert!(runs.has_running(&workspace.id).expect("running"));
        // 다른 작업공간의 실행은 막지 않는다.
        assert!(!runs.has_running("other").expect("other workspace"));
        let error = runs
            .open(app_data.path(), &workspace, None, BTreeMap::new())
            .expect_err("second launcher");
        assert!(matches!(error, CoreError::InvalidInput(_)));
    }

    /// 중지는 사람이 창을 닫은 것과 같은 끝이다. 죽인 프로세스는 실패로 돌아오지만, 누가
    /// 끝냈는지를 들고 있다가 `closed`로 적는다 — 눌러서 끝낼 때마다 오류가 쌓이면 안 된다.
    #[test]
    fn stopping_a_run_ends_it_as_closed_not_as_an_error() {
        let runs = CypressRuns::default();
        let record = runs
            .push(CypressRunStatus {
                job_id: "j1".to_owned(),
                workspace_id: "w".to_owned(),
                mode: CypressRunMode::Open,
                spec: None,
                state: CypressRunState::Running,
                started_at: 0,
                finished_at: None,
                summary: None,
                artifacts: Vec::new(),
                output_tail: String::new(),
                message: None,
                stop_flag: Arc::new(AtomicBool::new(false)),
                stopped: false,
            })
            .expect("push");

        let stopped = runs.stop("j1").expect("stop");
        // 중지는 요청만 걸고 돌아온다 — 정리는 자식을 기다리는 쪽이 한다.
        assert_eq!(stopped.state, CypressRunState::Running);
        assert!(stopped.stop_flag.load(Ordering::Relaxed));

        // 죽은 자식은 실패로 돌아오지만 화면에는 닫힘으로 적힌다.
        let killed = finished_run(
            CypressRunMode::Open,
            Ok(outcome(false, false, None)),
            None,
            &[],
        );
        lock(&record).expect("lock").finish(killed, Vec::new());
        let after = status_snapshot(&record).expect("snapshot");
        assert_eq!(after.state, CypressRunState::Closed);
        assert_eq!(after.message.as_deref(), Some("중지했습니다"));

        // 없는 잡은 조용히 넘어가지 않는다.
        assert!(matches!(
            runs.stop("nope").expect_err("unknown job"),
            CoreError::NotFound(_)
        ));
    }

    /// 이미 끝난 실행에 중지를 걸어도 상태를 뒤집지 않는다 — 지나간 결과를 닫힘으로 덮으면
    /// 통과·실패 기록이 사라진다.
    #[test]
    fn stopping_a_finished_run_leaves_its_result_alone() {
        let runs = CypressRuns::default();
        runs.push(CypressRunStatus {
            job_id: "done".to_owned(),
            workspace_id: "w".to_owned(),
            mode: CypressRunMode::Run,
            spec: None,
            state: CypressRunState::Passed,
            started_at: 0,
            finished_at: Some(1),
            summary: None,
            artifacts: Vec::new(),
            output_tail: String::new(),
            message: None,
            stop_flag: Arc::new(AtomicBool::new(false)),
            stopped: false,
        })
        .expect("push");
        let status = runs.stop("done").expect("stop");
        assert_eq!(status.state, CypressRunState::Passed);
        assert!(!status.stop_flag.load(Ordering::Relaxed));
    }

    /// 런처는 요약을 남기지 않는다. 사람이 창을 닫은 것을 실패로 적으면 수동 점검마다 오류가
    /// 쌓이므로 `closed`로 끝내고, 런처가 뜨지 못한 것만 오류로 가른다.
    #[test]
    fn closing_the_launcher_is_not_a_failure_but_a_failed_launch_is() {
        let secrets = vec!["secret-value".to_owned()];
        let closed = finished_run(
            CypressRunMode::Open,
            Ok(outcome(true, false, Some(0))),
            None,
            &secrets,
        );
        assert_eq!(closed.state, CypressRunState::Closed);
        assert!(closed.message.is_none());
        assert!(closed.summary.is_none());
        // 출력은 남기되 비밀값은 지운다.
        assert!(closed.output_tail.contains(REDACTED));

        let broken = finished_run(
            CypressRunMode::Open,
            Ok(outcome(false, false, Some(2))),
            Some(summary_with(0, Some("설정 파일을 읽지 못했습니다"))),
            &secrets,
        );
        assert_eq!(broken.state, CypressRunState::Error);
        assert_eq!(
            broken.message.as_deref(),
            Some("설정 파일을 읽지 못했습니다")
        );

        // 사유가 없으면 종료 코드라도 적는다.
        let silent = finished_run(
            CypressRunMode::Open,
            Ok(outcome(false, false, Some(9))),
            None,
            &secrets,
        );
        assert_eq!(silent.state, CypressRunState::Error);
        assert!(silent.message.expect("message").contains("exit 9"));

        // 상한을 넘긴 런처는 실행과 같은 시간 초과로 끝나되, 적히는 시간은 런처 상한이다.
        let stalled = finished_run(
            CypressRunMode::Open,
            Ok(outcome(false, true, None)),
            None,
            &secrets,
        );
        assert_eq!(stalled.state, CypressRunState::TimedOut);
        assert!(stalled
            .message
            .expect("message")
            .contains(&(OPEN_TIMEOUT.as_secs() / 60).to_string()));
    }

    /// 하네스가 없거나 루트 밖을 가리키면 격리 실행을 시작하지 않는다. 저장소 이름이 아니라
    /// 규약 구현 여부가 기준이므로, 거절 문구는 무엇을 만들어야 하는지 알려 줘야 한다.
    #[test]
    fn an_isolated_run_without_the_harness_is_refused_with_what_to_add() {
        let project = TempDir::new().unwrap();
        let root = fs::canonicalize(project.path()).unwrap();
        let error = isolated_e2e_script(&root).expect_err("하네스 없음");
        assert!(matches!(&error, CoreError::NotFound(message)
            if message.contains("e2e.mjs") && message.contains("--job-stdin")));

        fs::create_dir_all(root.join("scripts")).unwrap();
        let outside = TempDir::new().unwrap();
        let outside_script = fs::canonicalize(outside.path()).unwrap().join("e2e.mjs");
        fs::write(&outside_script, "// 바깥").unwrap();
        #[cfg(unix)]
        let linked = {
            std::os::unix::fs::symlink(&outside_script, root.join("scripts/e2e.mjs")).unwrap();
            true
        };
        #[cfg(windows)]
        let linked =
            std::os::windows::fs::symlink_file(&outside_script, root.join("scripts/e2e.mjs"))
                .is_ok();
        if linked {
            assert!(matches!(
                isolated_e2e_script(&root),
                Err(CoreError::InvalidInput(_))
            ));
            fs::remove_file(root.join("scripts/e2e.mjs")).unwrap();
        }
        fs::write(root.join("scripts/e2e.mjs"), "// 하네스").unwrap();
        // 하네스 경로도 자식에게 넘길 모양으로 돌아온다.
        assert_eq!(
            isolated_e2e_script(&root).unwrap(),
            child_facing(&root).join("scripts/e2e.mjs")
        );
    }

    /// CypressRunState의 문자열 포맷팅, 파싱, 직렬화, 역직렬화 및 종결 판정을 검증한다.
    #[test]
    fn cypress_run_state_contract_and_serde() {
        assert_eq!(CypressRunState::ALL.len(), 6);
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

        // 종결 판정은 Running 하나만 열어 둔다. 런처를 사람이 닫은 Closed도 끝난 것이다.
        for state in CypressRunState::ALL {
            assert_eq!(
                state.is_terminal(),
                state != CypressRunState::Running,
                "{state}의 종결 판정"
            );
        }

        // 알 수 없는 값에 대한 파싱 거절 검증
        let error = "unknown".parse::<CypressRunState>().expect_err("unknown");
        assert!(matches!(error, CoreError::InvalidInput(_)));
    }
    fn outcome(success: bool, timed_out: bool, exit_code: Option<i32>) -> CappedOutcome {
        CappedOutcome {
            success,
            timed_out,
            exit_code,
            stdout: "secret-value 출력".to_owned(),
            stderr: String::new(),
        }
    }

    fn summary_with(failed: u64, error: Option<&str>) -> CypressRunSummary {
        CypressRunSummary {
            passed: 1,
            failed,
            pending: 0,
            duration_ms: 10,
            specs: Vec::new(),
            screenshots: Vec::new(),
            error: error.map(str::to_owned),
        }
    }

    #[test]
    fn finished_run_folds_the_runner_outcome_and_summary_into_one_state() {
        let secrets = vec!["secret-value".to_owned()];

        // 러너를 아예 띄우지 못한 경우: 요약도 출력도 없다.
        let failed_spawn = finished_run(
            CypressRunMode::Run,
            Err(CoreError::Runtime("spawn 실패".to_owned())),
            Some(summary_with(0, None)),
            &secrets,
        );
        assert_eq!(failed_spawn.state, CypressRunState::Error);
        assert_eq!(failed_spawn.message.as_deref(), Some("spawn 실패"));
        assert!(failed_spawn.summary.is_none());
        assert!(failed_spawn.output_tail.is_empty());

        // 시간 초과: 중단 시점의 요약은 신뢰하지 않는다. 출력의 비밀값은 지워진다.
        let timed_out = finished_run(
            CypressRunMode::Run,
            Ok(outcome(false, true, None)),
            Some(summary_with(0, None)),
            &secrets,
        );
        assert_eq!(timed_out.state, CypressRunState::TimedOut);
        assert!(timed_out.summary.is_none());
        assert!(timed_out.output_tail.contains(REDACTED));
        assert!(!timed_out.output_tail.contains("secret-value"));

        // 성공은 실패 0과 종료 코드 0을 함께 만족해야 한다.
        assert_eq!(
            finished_run(
                CypressRunMode::Run,
                Ok(outcome(true, false, Some(0))),
                Some(summary_with(0, None)),
                &secrets
            )
            .state,
            CypressRunState::Passed
        );
        assert_eq!(
            finished_run(
                CypressRunMode::Run,
                Ok(outcome(true, false, Some(0))),
                Some(summary_with(2, None)),
                &secrets
            )
            .state,
            CypressRunState::Failed
        );
        assert_eq!(
            finished_run(
                CypressRunMode::Run,
                Ok(outcome(false, false, Some(1))),
                Some(summary_with(0, None)),
                &secrets
            )
            .state,
            CypressRunState::Failed
        );

        // 러너가 사유를 남겼으면 그 사유가 곧 메시지다.
        let runner_error = finished_run(
            CypressRunMode::Run,
            Ok(outcome(false, false, Some(1))),
            Some(summary_with(0, Some("Cypress를 띄우지 못했습니다"))),
            &secrets,
        );
        assert_eq!(runner_error.state, CypressRunState::Error);
        assert_eq!(
            runner_error.message.as_deref(),
            Some("Cypress를 띄우지 못했습니다")
        );
        assert!(runner_error.summary.is_some());

        // 요약이 없으면 종료 코드를 적어 남긴다.
        let no_summary = finished_run(
            CypressRunMode::Run,
            Ok(outcome(false, false, None)),
            None,
            &secrets,
        );
        assert_eq!(no_summary.state, CypressRunState::Error);
        assert!(no_summary.message.expect("message").contains("exit ?"));
    }

    /// Cypress가 결과 없음만 말하고 끝났을 때, 자식 프로세스를 띄우지 못한 진짜 사유가
    /// 상태 메시지에 함께 실려야 한다. 출력 안쪽에만 두면 설정 문제로 오진된다.
    #[test]
    fn a_failed_child_spawn_is_named_in_the_run_message() {
        let secrets = vec!["secret-value".to_owned()];
        let spawn_failure = |stderr: &str| CappedOutcome {
            success: false,
            timed_out: false,
            exit_code: Some(2),
            stdout: String::new(),
            stderr: stderr.to_owned(),
        };

        let started = finished_run(
            CypressRunMode::Run,
            Ok(spawn_failure(
                "Error: spawn powershell.exe ENOENT\n    at ChildProcess._handle.onexit\n",
            )),
            Some(summary_with(
                0,
                Some("Could not find Cypress test run results"),
            )),
            &secrets,
        );
        assert_eq!(started.state, CypressRunState::Error);
        assert_eq!(
            started.message.as_deref(),
            Some("Could not find Cypress test run results (spawn powershell.exe ENOENT)")
        );

        // 런처가 뜨지 못한 경우도 같은 사유를 받는다.
        let launcher = finished_run(
            CypressRunMode::Open,
            Ok(spawn_failure("spawn chrome EACCES\n")),
            None,
            &secrets,
        );
        assert_eq!(launcher.state, CypressRunState::Error);
        assert!(launcher
            .message
            .expect("message")
            .contains("spawn chrome EACCES"));

        // 이미 사유를 담은 메시지는 같은 줄을 두 번 적지 않는다.
        let once = finished_run(
            CypressRunMode::Run,
            Ok(spawn_failure("spawn powershell.exe ENOENT\n")),
            Some(summary_with(0, Some("spawn powershell.exe ENOENT"))),
            &secrets,
        );
        assert_eq!(once.message.as_deref(), Some("spawn powershell.exe ENOENT"));

        // 테스트가 실패했을 뿐인 실행은 건드리지 않는다.
        let failed_test = finished_run(
            CypressRunMode::Run,
            Ok(spawn_failure(
                "AssertionError: spawn ENOENT 라고 적힌 기대값\n",
            )),
            Some(summary_with(1, None)),
            &secrets,
        );
        assert_eq!(failed_test.state, CypressRunState::Failed);
        assert!(failed_test.message.is_none());
    }
}
