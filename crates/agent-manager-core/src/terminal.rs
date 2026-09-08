use std::collections::{HashMap, VecDeque};
#[cfg(windows)]
use std::env;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, SyncSender, TrySendError};
use std::sync::{Arc, Mutex, MutexGuard, Weak};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use fs4::FileExt;
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::catalog::{load_session_summary, SessionCatalog};
use crate::chat::resolve_executable;
use crate::credential_profiles::CLAUDE_SECURESTORAGE_CONFIG_DIR;
use crate::domain::ProviderId;
#[cfg(unix)]
use crate::process_signal;
use crate::user_home;
use crate::{
    AccountRuntimeLease, AccountSupervisor, CoreError, ResumeAccountPolicy, UnscopedRuntimeKind,
};

const RECONNECT_GRACE: Duration = Duration::from_secs(120);
const REAPER_INTERVAL: Duration = Duration::from_secs(1);
const MAX_REPLAY_BYTES: usize = 8 * 1024 * 1024;
const REPLAY_CHUNK_BYTES: usize = 32 * 1024;
const EVENT_QUEUE_CAPACITY: usize = 512;
const MIN_COLS: u16 = 20;
const MAX_COLS: u16 = 500;
const MIN_ROWS: u16 = 5;
const MAX_ROWS: u16 = 300;
const GRACEFUL_STOP_TIMEOUT: Duration = Duration::from_millis(750);
const FORCED_STOP_TIMEOUT: Duration = Duration::from_secs(2);
const STOP_POLL_INTERVAL: Duration = Duration::from_millis(25);

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalOpenRequest {
    pub source: ProviderId,
    pub session_id: String,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSetupRequest {
    pub source: ProviderId,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalAccountLoginRequest {
    pub login_id: String,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TerminalPhase {
    Running,
    Detached,
    Stopping,
    Exited,
    Failed,
}

impl TerminalPhase {
    pub const ALL: &'static [Self] = &[
        Self::Running,
        Self::Detached,
        Self::Stopping,
        Self::Exited,
        Self::Failed,
    ];

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Detached => "detached",
            Self::Stopping => "stopping",
            Self::Exited => "exited",
            Self::Failed => "failed",
        }
    }

    fn can_attach(self) -> bool {
        matches!(self, Self::Running | Self::Detached)
    }

    fn can_restart(self) -> bool {
        self == Self::Exited
    }
}

impl std::fmt::Display for TerminalPhase {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

impl std::str::FromStr for TerminalPhase {
    type Err = CoreError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "running" => Ok(Self::Running),
            "detached" => Ok(Self::Detached),
            "stopping" => Ok(Self::Stopping),
            "exited" => Ok(Self::Exited),
            "failed" => Ok(Self::Failed),
            _ => Err(CoreError::InvalidInput(format!(
                "알 수 없는 터미널 상태입니다: {}",
                s
            ))),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSessionInfo {
    pub terminal_id: String,
    pub source: ProviderId,
    pub session_id: String,
    pub state: TerminalPhase,
    pub reconnect_deadline: Option<i64>,
    pub exit_code: Option<u32>,
    pub replay_truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StopTerminalFailure {
    pub terminal_id: String,
    pub session_id: String,
    pub error: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StopProviderTerminalsReport {
    pub provider: ProviderId,
    pub requested_count: usize,
    pub stopped_count: usize,
    /// 정상 종료 유예 시간 안에 끝나지 않아 PID 기반 SIGKILL로 승격된 터미널 수.
    pub forced_count: usize,
    pub failed: Vec<StopTerminalFailure>,
    pub remaining_terminal_count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum TerminalEvent {
    Output { data: Vec<u8> },
    State { session: TerminalSessionInfo },
    Exit { code: Option<u32> },
    Error { message: String },
}

pub struct TerminalAttachment {
    pub info: TerminalSessionInfo,
    pub events: Receiver<TerminalEvent>,
}

#[derive(Clone)]
pub struct TerminalSupervisor {
    inner: Arc<SupervisorInner>,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct SessionKey {
    source: ProviderId,
    session_id: String,
}

struct SupervisorInner {
    app_data_dir: PathBuf,
    lock_dir: PathBuf,
    session_catalog: Option<SessionCatalog>,
    sessions: Mutex<HashMap<SessionKey, Arc<TerminalRuntime>>>,
    accounts: Option<AccountSupervisor>,
}

struct TerminalRuntime {
    terminal_id: String,
    key: SessionKey,
    process_id: Option<u32>,
    state: Mutex<RuntimeState>,
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    session_lock: Mutex<Option<File>>,
    account_runtime_lease: Mutex<Option<AccountRuntimeLease>>,
}

struct RuntimeState {
    phase: TerminalPhase,
    subscriber: Option<SyncSender<TerminalEvent>>,
    replay: VecDeque<u8>,
    replay_truncated: bool,
    reconnect_deadline: Option<i64>,
    expires_at: Option<Instant>,
    exit_code: Option<u32>,
}

impl RuntimeState {
    /// 재연결 시 돌려줄 최근 출력만 보관하고, 한 번이라도 앞부분을 버렸는지 기록한다.
    fn append_replay(&mut self, data: &[u8]) {
        self.replay.extend(data.iter().copied());
        if self.replay.len() > MAX_REPLAY_BYTES {
            let overflow = self.replay.len() - MAX_REPLAY_BYTES;
            self.replay.drain(..overflow);
            self.replay_truncated = true;
        }
    }

    /// 재연결 대기를 끝낸다. 지금 붙어 있거나 곧 정리될 터미널은 만료 시각을 갖지 않는다.
    fn clear_deadlines(&mut self) {
        self.reconnect_deadline = None;
        self.expires_at = None;
    }

    /// 프로세스가 끝난 터미널을 재연결 유예 동안만 남겨 둔다. 유예 시각은 내부 청소용이라
    /// 화면에 노출하는 재연결 마감(`reconnect_deadline`)과 달리 비워 둔다.
    fn begin_exit_grace(&mut self) {
        self.expires_at = Some(Instant::now() + RECONNECT_GRACE);
        self.reconnect_deadline = None;
    }
}

struct LaunchSpec {
    executable: PathBuf,
    cwd: PathBuf,
    args: Vec<String>,
    env: Vec<(String, String)>,
}

impl TerminalSupervisor {
    pub fn new(app_data_dir: impl AsRef<Path>) -> Result<Self, CoreError> {
        Self::create(app_data_dir.as_ref(), None, None)
    }

    pub fn with_session_catalog(
        app_data_dir: impl AsRef<Path>,
        session_catalog: SessionCatalog,
    ) -> Result<Self, CoreError> {
        Self::create(app_data_dir.as_ref(), Some(session_catalog), None)
    }

    pub fn with_accounts(
        app_data_dir: impl AsRef<Path>,
        session_catalog: SessionCatalog,
        accounts: AccountSupervisor,
    ) -> Result<Self, CoreError> {
        Self::create(app_data_dir.as_ref(), Some(session_catalog), Some(accounts))
    }

    fn create(
        app_data_dir: &Path,
        session_catalog: Option<SessionCatalog>,
        accounts: Option<AccountSupervisor>,
    ) -> Result<Self, CoreError> {
        fs::create_dir_all(app_data_dir)?;
        let app_data_dir = fs::canonicalize(app_data_dir)?;
        let lock_dir = app_data_dir.join("terminal-locks");
        fs::create_dir_all(&lock_dir)?;
        let lock_dir = fs::canonicalize(lock_dir)?;
        let inner = Arc::new(SupervisorInner {
            app_data_dir,
            lock_dir,
            session_catalog,
            sessions: Mutex::new(HashMap::new()),
            accounts,
        });
        spawn_reaper(Arc::downgrade(&inner));
        Ok(Self { inner })
    }

    pub fn open_or_attach(
        &self,
        request: TerminalOpenRequest,
    ) -> Result<TerminalAttachment, CoreError> {
        validate_identifier(&request.session_id)?;
        validate_size(request.cols, request.rows)?;
        let key = SessionKey {
            source: request.source,
            session_id: request.session_id.clone(),
        };

        // 세션에 묶인 계정으로 재개한다. 자격증명이 계정별로 갈려 있어 다른 계정으로
        // 붙으면 그 계정의 한도를 쓰고 사용량 집계도 세션과 어긋난다.
        let account_id = self.session_account_id(request.source, &request.session_id);
        let profile_env = self.account_credential_env(request.source, account_id.as_deref())?;
        self.open_with(
            key,
            request.cols,
            request.rows,
            || {
                let mut spec = resolve_launch_spec(
                    &self.inner.app_data_dir,
                    self.inner.session_catalog.as_ref(),
                    &request,
                )?;
                spec.env.extend(profile_env);
                Ok(spec)
            },
            || {
                self.inner
                    .accounts
                    .as_ref()
                    .map(|accounts| accounts.acquire_runtime(request.source, account_id.as_deref()))
                    .transpose()
            },
        )
    }

    /// 이 세션을 재개할 계정. 채팅 이어가기와 같은 규칙이다 — 세션에 고정된 계정이
    /// 있으면 그 계정, 없으면 이어가기 정책에 따라 마지막 실행 계정 또는 현재 활성
    /// 계정을 쓴다.
    fn session_account_id(&self, source: ProviderId, session_id: &str) -> Option<String> {
        let accounts = self.inner.accounts.as_ref()?;
        let app_data_dir = &self.inner.app_data_dir;
        crate::store::session_pinned_account_id(app_data_dir, source, session_id)
            .or_else(|| match accounts.resume_account_policy() {
                Ok(ResumeAccountPolicy::ActiveAccount) => None,
                Ok(ResumeAccountPolicy::LastUsedAccount) => {
                    crate::store::session_last_used_account_id(app_data_dir, source, session_id)
                }
                Err(error) => {
                    eprintln!(
                        "[terminal] 이어가기 계정 정책을 읽지 못해 활성 계정으로 재개합니다: {error}"
                    );
                    None
                }
            })
            .filter(|account_id| accounts.account_is_usable(source, account_id))
            .or_else(|| accounts.active_account_id(source).ok().flatten())
    }

    /// 계정별 자격증명 프로필 환경변수. 계정에 귀속된 터미널은 그 계정의 격리 프로필로만
    /// 뜬다 — 공유 CLI 홈에는 다른 로그인이 들어 있을 수 있어 폴백하지 않는다. 계정이
    /// 없는 터미널(설정·로그인)은 환경변수 없이 뜬다.
    fn account_credential_env(
        &self,
        source: ProviderId,
        account_id: Option<&str>,
    ) -> Result<Vec<(String, String)>, CoreError> {
        let (Some(accounts), Some(account_id)) = (self.inner.accounts.as_ref(), account_id) else {
            return Ok(Vec::new());
        };
        match accounts.runtime_credential_profile(source, account_id) {
            Ok(Some(profile)) => Ok(profile.env),
            Ok(None) => Err(CoreError::Conflict(format!(
                "{source} 계정의 자격증명 격리를 준비하지 못해 터미널을 열 수 없습니다"
            ))),
            Err(error) => Err(CoreError::Conflict(format!(
                "{source} 계정 터미널 프로필을 준비하지 못했습니다: {error}"
            ))),
        }
    }

    /// 계정에 묶이지 않는 터미널(설정·로그인)의 실행 임차. 계정 감독자가 없는
    /// 원격 구성에서는 임차 없이 뜬다.
    fn unscoped_lease(
        &self,
        provider: ProviderId,
        kind: UnscopedRuntimeKind,
    ) -> Result<Option<AccountRuntimeLease>, CoreError> {
        self.inner
            .accounts
            .as_ref()
            .map(|accounts| accounts.acquire_unscoped_runtime(provider, kind))
            .transpose()
    }

    pub fn open_setup(
        &self,
        request: TerminalSetupRequest,
    ) -> Result<TerminalAttachment, CoreError> {
        validate_size(request.cols, request.rows)?;
        let key = SessionKey {
            source: request.source,
            session_id: "cli-setup".to_owned(),
        };
        self.open_with(
            key,
            request.cols,
            request.rows,
            resolve_setup_launch_spec,
            || self.unscoped_lease(request.source, UnscopedRuntimeKind::SharedHome),
        )
    }

    /// `remote`는 이 요청이 Tailscale 원격 UI에서 왔는지다. 로그인 CLI의 인증 방식을
    /// 여기서 갈라야 하므로 클라이언트가 보낸 값이 아니라 서버가 판정한 접근 종류를 받는다.
    pub fn open_account_login(
        &self,
        request: TerminalAccountLoginRequest,
        remote: bool,
    ) -> Result<TerminalAttachment, CoreError> {
        validate_identifier(&request.login_id)?;
        validate_size(request.cols, request.rows)?;
        let accounts = self.inner.accounts.as_ref().ok_or_else(|| {
            CoreError::Conflict("계정 로그인은 로컬 데스크톱에서만 사용할 수 있습니다".to_owned())
        })?;
        let login = accounts.login_session(&request.login_id)?;
        let key = SessionKey {
            source: login.provider,
            session_id: format!("account-login-{}", request.login_id),
        };
        let provider = login.provider;
        let accounts = accounts.clone();
        self.open_with(
            key,
            request.cols,
            request.rows,
            || resolve_account_login_launch_spec(login, remote),
            || {
                accounts
                    .acquire_unscoped_runtime(provider, UnscopedRuntimeKind::IsolatedLogin)
                    .map(Some)
            },
        )
    }

    fn open_with(
        &self,
        key: SessionKey,
        cols: u16,
        rows: u16,
        resolve_spec: impl FnOnce() -> Result<LaunchSpec, CoreError>,
        resolve_account_lease: impl FnOnce() -> Result<Option<AccountRuntimeLease>, CoreError>,
    ) -> Result<TerminalAttachment, CoreError> {
        let existing = {
            let sessions = lock(&self.inner.sessions)?;
            sessions.get(&key).cloned()
        };
        if let Some(runtime) = existing {
            let phase = runtime.phase()?;
            if phase.can_attach() {
                runtime.resize(cols, rows)?;
                return runtime.attach();
            }
            if phase.can_restart() {
                let removed = {
                    let mut sessions = lock(&self.inner.sessions)?;
                    if sessions
                        .get(&key)
                        .is_some_and(|current| Arc::ptr_eq(current, &runtime))
                    {
                        sessions.remove(&key)
                    } else {
                        None
                    }
                };
                drop(runtime);
                drop(removed);
            } else {
                return Err(CoreError::Conflict(
                    "터미널 프로세스를 정리하고 있습니다. 잠시 후 다시 연결하세요".to_owned(),
                ));
            }
        }

        let spec = resolve_spec()?;
        let account_lease = resolve_account_lease()?;
        let session_lock = acquire_session_lock(&self.inner.lock_dir, &key)?;
        let runtime =
            TerminalRuntime::spawn(key.clone(), cols, rows, spec, session_lock, account_lease)?;

        let mut sessions = lock(&self.inner.sessions)?;
        if sessions.contains_key(&key) {
            runtime.terminate();
            return Err(CoreError::Conflict(
                "이 세션의 터미널이 이미 실행 중입니다".to_owned(),
            ));
        }
        sessions.insert(key, Arc::clone(&runtime));
        drop(sessions);
        runtime.attach()
    }

    pub fn write(&self, terminal_id: &str, data: &[u8]) -> Result<(), CoreError> {
        if data.len() > 64 * 1024 {
            return Err(CoreError::TooLarge(64 * 1024));
        }
        self.runtime(terminal_id)?.write(data)
    }

    pub fn resize(&self, terminal_id: &str, cols: u16, rows: u16) -> Result<(), CoreError> {
        validate_size(cols, rows)?;
        self.runtime(terminal_id)?.resize(cols, rows)
    }

    pub fn detach(&self, terminal_id: &str) -> Result<(), CoreError> {
        self.runtime(terminal_id)?.detach()
    }

    pub fn stop(&self, terminal_id: &str) -> Result<(), CoreError> {
        self.runtime(terminal_id)?.terminate();
        Ok(())
    }

    /// Agent Manager가 관리하는 해당 공급자의 터미널을 모두 종료한다.
    /// 일반 세션, CLI 설정, 격리 계정 로그인 터미널을 모두 포함한다. 먼저
    /// SIGTERM으로 정상 종료를 요청하고 유예 시간 안에 종료되지 않으면 해당
    /// PID에 SIGKILL을 보내며, 종료 상태까지 확인된 항목만 성공으로 센다.
    pub fn stop_provider_terminals(
        &self,
        provider: ProviderId,
    ) -> Result<StopProviderTerminalsReport, CoreError> {
        let targets: Vec<Arc<TerminalRuntime>> = {
            let sessions = lock(&self.inner.sessions)?;
            let mut targets = Vec::new();
            for runtime in sessions.values() {
                if runtime.key.source != provider || runtime.phase()? == TerminalPhase::Exited {
                    continue;
                }
                targets.push(Arc::clone(runtime));
            }
            targets
        };
        let requested_count = targets.len();
        let mut forced_count = 0usize;
        let mut failed = Vec::new();
        for runtime in targets {
            match runtime.stop_with_escalation() {
                Ok(forced) => {
                    if forced {
                        forced_count += 1;
                    }
                }
                Err(error) => failed.push(StopTerminalFailure {
                    terminal_id: runtime.terminal_id.clone(),
                    session_id: runtime.key.session_id.clone(),
                    error: error.to_string(),
                }),
            }
        }
        let remaining_terminal_count = self.provider_terminal_count(provider)?;
        Ok(StopProviderTerminalsReport {
            provider,
            requested_count,
            stopped_count: requested_count.saturating_sub(failed.len()),
            forced_count,
            failed,
            remaining_terminal_count,
        })
    }

    /// 종료 확인이 끝나지 않은 해당 공급자의 관리 터미널 수를 반환한다.
    pub fn provider_terminal_count(&self, provider: ProviderId) -> Result<usize, CoreError> {
        let sessions = lock(&self.inner.sessions)?;
        let mut remaining = 0usize;
        for runtime in sessions.values() {
            if runtime.key.source == provider && runtime.phase()? != TerminalPhase::Exited {
                remaining += 1;
            }
        }
        Ok(remaining)
    }

    fn runtime(&self, terminal_id: &str) -> Result<Arc<TerminalRuntime>, CoreError> {
        lock(&self.inner.sessions)?
            .values()
            .find(|runtime| runtime.terminal_id == terminal_id)
            .cloned()
            .ok_or_else(|| CoreError::NotFound("터미널 세션을 찾을 수 없습니다".to_owned()))
    }
}

impl Drop for SupervisorInner {
    fn drop(&mut self) {
        if let Ok(sessions) = self.sessions.lock() {
            for runtime in sessions.values() {
                runtime.terminate();
            }
        }
    }
}

impl TerminalRuntime {
    fn spawn(
        key: SessionKey,
        cols: u16,
        rows: u16,
        spec: LaunchSpec,
        session_lock: File,
        account_runtime_lease: Option<AccountRuntimeLease>,
    ) -> Result<Arc<Self>, CoreError> {
        let pair = native_pty_system()
            .openpty(pty_size(cols, rows))
            .map_err(|error| CoreError::Runtime(format!("PTY를 열지 못했습니다: {error}")))?;
        let mut command = CommandBuilder::new(spec.executable.as_os_str());
        command.args(spec.args);
        command.cwd(spec.cwd.as_os_str());
        command.env("TERM", "xterm-256color");
        command.env("COLORTERM", "truecolor");
        // PTY로 셸이 아니라 CLI를 직접 띄우므로 프로필이 PATH를 보정해 주지 않는다.
        // GUI 실행 시 빠지는 공통 디렉터리만 상속 PATH 뒤에 덧붙인다.
        if let Some(path) = crate::providers::appended_search_path() {
            command.env("PATH", path);
        }
        for (key, value) in spec.env {
            command.env(key, value);
        }

        let mut child = pair
            .slave
            .spawn_command(command)
            .map_err(|error| CoreError::Runtime(format!("CLI를 시작하지 못했습니다: {error}")))?;
        let process_id = child.process_id();
        let killer = child.clone_killer();
        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|error| CoreError::Runtime(format!("PTY 출력을 열지 못했습니다: {error}")))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|error| CoreError::Runtime(format!("PTY 입력을 열지 못했습니다: {error}")))?;
        drop(pair.slave);

        let runtime = Arc::new(Self {
            terminal_id: Uuid::new_v4().to_string(),
            key,
            process_id,
            state: Mutex::new(RuntimeState {
                phase: TerminalPhase::Running,
                subscriber: None,
                replay: VecDeque::new(),
                replay_truncated: false,
                reconnect_deadline: None,
                expires_at: None,
                exit_code: None,
            }),
            master: Mutex::new(pair.master),
            writer: Mutex::new(writer),
            killer: Mutex::new(killer),
            session_lock: Mutex::new(Some(session_lock)),
            account_runtime_lease: Mutex::new(account_runtime_lease),
        });

        let reader_runtime = Arc::clone(&runtime);
        thread::Builder::new()
            .name(format!("terminal-reader-{}", runtime.terminal_id))
            .spawn(move || read_terminal(reader_runtime, reader))
            .map_err(CoreError::Io)?;

        let wait_runtime = Arc::clone(&runtime);
        thread::Builder::new()
            .name(format!("terminal-wait-{}", runtime.terminal_id))
            .spawn(move || match child.wait() {
                Ok(status) => wait_runtime.mark_exited(Some(status.exit_code())),
                Err(error) => {
                    wait_runtime.mark_failed(format!("CLI 종료 상태를 읽지 못했습니다: {error}"))
                }
            })
            .map_err(CoreError::Io)?;

        Ok(runtime)
    }

    fn attach(&self) -> Result<TerminalAttachment, CoreError> {
        let (sender, receiver) = mpsc::sync_channel(EVENT_QUEUE_CAPACITY);
        let mut state = lock(&self.state)?;
        if state.subscriber.is_some() {
            return Err(CoreError::Conflict(
                "이 터미널은 다른 화면에 연결되어 있습니다".to_owned(),
            ));
        }
        if state.phase == TerminalPhase::Detached {
            state.phase = TerminalPhase::Running;
            state.clear_deadlines();
        }
        let info = self.info(&state);
        sender
            .try_send(TerminalEvent::State {
                session: info.clone(),
            })
            .map_err(|_| CoreError::Runtime("터미널 이벤트 채널을 열지 못했습니다".to_owned()))?;
        let replay = state.replay.iter().copied().collect::<Vec<_>>();
        for chunk in replay.chunks(REPLAY_CHUNK_BYTES) {
            sender
                .try_send(TerminalEvent::Output {
                    data: chunk.to_vec(),
                })
                .map_err(|_| CoreError::Runtime("터미널 출력을 재생하지 못했습니다".to_owned()))?;
        }
        if state.phase == TerminalPhase::Exited {
            sender
                .try_send(TerminalEvent::Exit {
                    code: state.exit_code,
                })
                .map_err(|_| {
                    CoreError::Runtime("터미널 종료 상태를 전달하지 못했습니다".to_owned())
                })?;
        }
        state.subscriber = Some(sender);
        Ok(TerminalAttachment {
            info,
            events: receiver,
        })
    }

    fn phase(&self) -> Result<TerminalPhase, CoreError> {
        Ok(lock(&self.state)?.phase)
    }

    fn write(&self, data: &[u8]) -> Result<(), CoreError> {
        let phase = lock(&self.state)?.phase;
        if !matches!(phase, TerminalPhase::Running | TerminalPhase::Detached) {
            return Err(CoreError::Conflict(
                "종료된 터미널에는 입력할 수 없습니다".to_owned(),
            ));
        }
        let mut writer = lock(&self.writer)?;
        writer.write_all(data)?;
        writer.flush()?;
        Ok(())
    }

    fn resize(&self, cols: u16, rows: u16) -> Result<(), CoreError> {
        lock(&self.master)?
            .resize(pty_size(cols, rows))
            .map_err(|error| {
                CoreError::Runtime(format!("터미널 크기를 바꾸지 못했습니다: {error}"))
            })
    }

    fn detach(&self) -> Result<(), CoreError> {
        let mut state = lock(&self.state)?;
        state.subscriber = None;
        if matches!(
            state.phase,
            TerminalPhase::Running | TerminalPhase::Detached
        ) {
            set_detached_deadline(&mut state);
        }
        Ok(())
    }

    fn terminate(&self) {
        if let Ok(mut state) = self.state.lock() {
            if matches!(state.phase, TerminalPhase::Exited | TerminalPhase::Failed) {
                return;
            }
            state.phase = TerminalPhase::Stopping;
            self.emit_state(&mut state);
        }
        if let Ok(mut killer) = self.killer.lock() {
            let _ = killer.kill();
        }
    }

    /// SIGTERM 정상 종료 후 PID 기반 SIGKILL 승격을 수행한다. 반환값이 true면
    /// 강제 종료 단계가 필요했음을 뜻한다. 종료를 확인하지 못하면 account lease를
    /// 보존한 채 오류를 반환해 자격증명 교체가 진행되지 않게 한다.
    fn stop_with_escalation(&self) -> Result<bool, CoreError> {
        if self.phase()? == TerminalPhase::Exited {
            return Ok(false);
        }
        self.mark_stopping();

        #[cfg(unix)]
        {
            let pid = self.process_id.ok_or_else(|| {
                CoreError::Runtime(format!(
                    "터미널 {}의 프로세스 PID를 확인할 수 없습니다",
                    self.terminal_id
                ))
            })?;
            if let Ok(false) = send_terminal_signal(pid, libc::SIGTERM) {
                self.mark_exited(None);
                return Ok(false);
            }
            if self.wait_for_exit(GRACEFUL_STOP_TIMEOUT)? {
                return Ok(false);
            }

            send_terminal_signal(pid, libc::SIGKILL).map_err(|error| {
                CoreError::Runtime(format!(
                    "터미널 {}의 PID {pid} 강제 종료 신호를 보내지 못했습니다: {error}",
                    self.terminal_id
                ))
            })?;
            if self.wait_for_exit(FORCED_STOP_TIMEOUT)? {
                return Ok(true);
            }
            Err(CoreError::Runtime(format!(
                "터미널 {}의 PID {pid}가 SIGKILL 이후에도 종료되지 않았습니다",
                self.terminal_id
            )))
        }

        #[cfg(not(unix))]
        {
            if let Ok(mut killer) = self.killer.lock() {
                killer.kill().map_err(|error| {
                    CoreError::Runtime(format!(
                        "터미널 {}의 종료 신호를 보내지 못했습니다: {error}",
                        self.terminal_id
                    ))
                })?;
            }
            if self.wait_for_exit(FORCED_STOP_TIMEOUT)? {
                return Ok(false);
            }
            Err(CoreError::Runtime(format!(
                "터미널 {}의 종료를 확인하지 못했습니다",
                self.terminal_id
            )))
        }
    }

    fn mark_stopping(&self) {
        if let Ok(mut state) = self.state.lock() {
            if state.phase == TerminalPhase::Exited {
                return;
            }
            state.phase = TerminalPhase::Stopping;
            state.clear_deadlines();
            self.emit_state(&mut state);
        }
    }

    fn wait_for_exit(&self, timeout: Duration) -> Result<bool, CoreError> {
        let deadline = Instant::now() + timeout;
        loop {
            if self.phase()? == TerminalPhase::Exited {
                return Ok(true);
            }
            #[cfg(unix)]
            if let Some(pid) = self.process_id {
                if !terminal_pid_exists(pid)? {
                    self.mark_exited(None);
                    return Ok(true);
                }
            }
            if Instant::now() >= deadline {
                return Ok(false);
            }
            thread::sleep(STOP_POLL_INTERVAL);
        }
    }

    fn append_output(&self, data: &[u8]) {
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        state.append_replay(data);
        try_send(
            &mut state,
            TerminalEvent::Output {
                data: data.to_vec(),
            },
        );
    }

    fn mark_exited(&self, code: Option<u32>) {
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        if state.phase == TerminalPhase::Exited {
            if state.exit_code.is_none() {
                state.exit_code = code;
            }
            return;
        }
        state.phase = TerminalPhase::Exited;
        state.exit_code = code;
        state.begin_exit_grace();
        if let Ok(mut session_lock) = self.session_lock.lock() {
            *session_lock = None;
        }
        if let Ok(mut lease) = self.account_runtime_lease.lock() {
            if let Some(mut lease) = lease.take() {
                lease.release();
            }
        }
        try_send(&mut state, TerminalEvent::Exit { code });
        self.emit_state(&mut state);
    }

    fn mark_failed(&self, message: String) {
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        state.phase = TerminalPhase::Failed;
        state.begin_exit_grace();
        try_send(&mut state, TerminalEvent::Error { message });
        self.emit_state(&mut state);
        drop(state);
        if let Ok(mut killer) = self.killer.lock() {
            let _ = killer.kill();
        }
    }

    fn is_expired(&self, now: Instant) -> bool {
        self.state
            .lock()
            .ok()
            .and_then(|state| state.expires_at)
            .is_some_and(|expires_at| expires_at <= now)
    }

    /// 지금 상태를 구독자에게 알린다. 상태를 바꾼 자리는 모두 이 한 줄로 닫는다.
    fn emit_state(&self, state: &mut RuntimeState) {
        let info = self.info(state);
        try_send(state, TerminalEvent::State { session: info });
    }

    fn info(&self, state: &RuntimeState) -> TerminalSessionInfo {
        TerminalSessionInfo {
            terminal_id: self.terminal_id.clone(),
            source: self.key.source,
            session_id: self.key.session_id.clone(),
            state: state.phase,
            reconnect_deadline: state.reconnect_deadline,
            exit_code: state.exit_code,
            replay_truncated: state.replay_truncated,
        }
    }
}

fn read_terminal(runtime: Arc<TerminalRuntime>, mut reader: Box<dyn Read + Send>) {
    let mut buffer = [0_u8; 8192];
    loop {
        match reader.read(&mut buffer) {
            Ok(0) => break,
            Ok(read) => runtime.append_output(&buffer[..read]),
            Err(error) => {
                runtime.mark_failed(format!("PTY 출력을 읽지 못했습니다: {error}"));
                break;
            }
        }
    }
}

fn try_send(state: &mut RuntimeState, event: TerminalEvent) {
    let Some(sender) = state.subscriber.as_ref() else {
        return;
    };
    match sender.try_send(event) {
        Ok(()) => {}
        Err(TrySendError::Full(_)) | Err(TrySendError::Disconnected(_)) => {
            state.subscriber = None;
            if state.phase == TerminalPhase::Running {
                set_detached_deadline(state);
            }
        }
    }
}

fn set_detached_deadline(state: &mut RuntimeState) {
    state.phase = TerminalPhase::Detached;
    state.expires_at = Some(Instant::now() + RECONNECT_GRACE);
    state.reconnect_deadline = Some(unix_millis_after(RECONNECT_GRACE));
}

fn spawn_reaper(inner: Weak<SupervisorInner>) {
    thread::spawn(move || loop {
        thread::sleep(REAPER_INTERVAL);
        let Some(inner) = inner.upgrade() else {
            break;
        };
        let now = Instant::now();
        let expired = match inner.sessions.lock() {
            Ok(sessions) => sessions
                .iter()
                .filter(|(_, runtime)| runtime.is_expired(now))
                .map(|(key, runtime)| (key.clone(), Arc::clone(runtime)))
                .collect::<Vec<_>>(),
            Err(_) => break,
        };
        if expired.is_empty() {
            continue;
        }
        if let Ok(mut sessions) = inner.sessions.lock() {
            for (key, runtime) in expired {
                runtime.terminate();
                if sessions
                    .get(&key)
                    .is_some_and(|current| Arc::ptr_eq(current, &runtime))
                {
                    sessions.remove(&key);
                }
            }
        };
    });
}

fn resolve_launch_spec(
    app_data_dir: &Path,
    session_catalog: Option<&SessionCatalog>,
    request: &TerminalOpenRequest,
) -> Result<LaunchSpec, CoreError> {
    let session = if let Some(catalog) = session_catalog {
        catalog.session_summary(request.source, &request.session_id)?
    } else {
        load_session_summary(app_data_dir, request.source, &request.session_id)?
    };
    if session.is_subagent {
        return Err(CoreError::InvalidInput(
            "서브에이전트 세션은 터미널에서 재개할 수 없습니다".to_owned(),
        ));
    }
    let cwd = session
        .cwd
        .as_deref()
        .ok_or_else(|| CoreError::InvalidInput("세션 작업 경로가 없습니다".to_owned()))?;
    let cwd = canonical_dir(cwd, "세션 작업 경로가 디렉터리가 아닙니다")?;
    Ok(LaunchSpec {
        executable: resolve_executable(request.source)?,
        cwd,
        args: resume_args(request.source, &request.session_id),
        env: Vec::new(),
    })
}

fn resolve_setup_launch_spec() -> Result<LaunchSpec, CoreError> {
    let cwd = canonical_dir(
        user_home::home_dir()?,
        "사용자 홈 경로가 디렉터리가 아닙니다",
    )?;

    #[cfg(windows)]
    let (executable, args) = (
        env::var_os("COMSPEC")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(r"C:\Windows\System32\cmd.exe")),
        Vec::new(),
    );
    #[cfg(target_os = "macos")]
    let (executable, args) = (PathBuf::from("/bin/zsh"), vec!["-l".to_owned()]);
    #[cfg(all(unix, not(target_os = "macos")))]
    let (executable, args) = (PathBuf::from("/bin/sh"), vec!["-l".to_owned()]);

    let executable = canonical_file(executable, "설정 터미널 셸이 실행 파일이 아닙니다")?;
    Ok(LaunchSpec {
        executable,
        cwd,
        args,
        env: Vec::new(),
    })
}

fn resolve_account_login_launch_spec(
    login: crate::AccountLoginSessionView,
    remote: bool,
) -> Result<LaunchSpec, CoreError> {
    let executable = resolve_executable(login.provider)?;
    let cwd = canonical_dir(
        &login.profile_path,
        "계정 로그인 실행 경로가 올바르지 않습니다",
    )?;
    let args = account_login_args(login.provider, remote)?;
    Ok(LaunchSpec {
        executable,
        cwd,
        args,
        env: account_login_env(&login),
    })
}

/// 로그인 CLI 인자.
///
/// Codex는 원격 요청일 때만 `--device-auth`를 쓴다. 기본 `codex login`은 loopback PKCE라
/// `redirect_uri`가 `http://localhost:1455/auth/callback`으로 고정되고 로그인 서버도
/// 그 머신의 localhost에만 뜬다. 브라우저가 호스트에 있는 로컬 UI에서는 이 콜백이 그대로
/// 닿아 브라우저가 알아서 끝내주므로 기본 방식이 손이 덜 간다. 반대로 Tailscale 경유 웹 UI는
/// 브라우저가 다른 기기에 있어 콜백이 CLI에 절대 도달하지 못하고, CLI가 stdin의 코드
/// 붙여넣기를 읽지 않으므로 터미널 입력으로도 우회할 수 없다. 그래서 원격에서만 로컬 콜백이
/// 필요 없는 device 코드 방식으로 바꾼다.
fn account_login_args(provider: ProviderId, remote: bool) -> Result<Vec<String>, CoreError> {
    Ok(match provider {
        ProviderId::Codex if remote => vec!["login".to_owned(), "--device-auth".to_owned()],
        ProviderId::Codex => vec!["login".to_owned()],
        ProviderId::Claude => vec![
            "auth".to_owned(),
            "login".to_owned(),
            "--claudeai".to_owned(),
        ],
        ProviderId::Antigravity => {
            return Err(CoreError::InvalidInput(
                "Antigravity 계정 로그인은 지원하지 않습니다".to_owned(),
            ))
        }
    })
}

/// 로그인 CLI를 임시 프로필에 가두는 환경변수.
///
/// Claude 자격증명 저장소는 `CLAUDE_SECURESTORAGE_CONFIG_DIR`이 파일 경로와 Keychain
/// 서비스명을 단독으로 정한다. `CLAUDE_CONFIG_DIR`만 넘기면 로그인 CLI가 이 프로세스가
/// 물려받은 값을 그대로 써서 다른 계정의 격리 프로필에 토큰을 쓰고, 로그인 완료 저장은
/// 임시 프로필에서 자격증명을 찾지 못해 실패한다. 두 값을 함께 임시 프로필로 고정해
/// 설정과 자격증명이 같은 자리에 남게 한다.
fn account_login_env(login: &crate::AccountLoginSessionView) -> Vec<(String, String)> {
    let mut env = vec![(
        login.environment_variable.clone(),
        login.profile_path.clone(),
    )];
    if login.provider == ProviderId::Claude {
        env.push((
            CLAUDE_SECURESTORAGE_CONFIG_DIR.to_owned(),
            login.profile_path.clone(),
        ));
    }
    env
}

/// 실행 스펙의 작업 경로를 확정한다. 세 실행 스펙이 각자 canonicalize 후 디렉터리인지
/// 확인하고 있어 한 자리로 모았다. 경로마다 어긋났을 때 보여줄 문구가 달라 문구는 받는다.
fn canonical_dir(path: impl AsRef<Path>, mismatch: &str) -> Result<PathBuf, CoreError> {
    let path = fs::canonicalize(path)?;
    if !path.is_dir() {
        return Err(CoreError::InvalidInput(mismatch.to_owned()));
    }
    Ok(path)
}

/// 실행 파일 쪽의 같은 확인. 공급자 CLI는 `resolve_executable`이 같은 검사를 품고 있어
/// 여기 남는 것은 설정 터미널의 셸뿐이다.
fn canonical_file(path: impl AsRef<Path>, mismatch: &str) -> Result<PathBuf, CoreError> {
    let path = fs::canonicalize(path)?;
    if !path.is_file() {
        return Err(CoreError::InvalidInput(mismatch.to_owned()));
    }
    Ok(path)
}

fn resume_args(source: ProviderId, session_id: &str) -> Vec<String> {
    match source {
        ProviderId::Claude => vec!["--resume".to_owned(), session_id.to_owned()],
        ProviderId::Codex => vec!["resume".to_owned(), session_id.to_owned()],
        ProviderId::Antigravity => vec!["--conversation".to_owned(), session_id.to_owned()],
    }
}

fn acquire_session_lock(lock_dir: &Path, key: &SessionKey) -> Result<File, CoreError> {
    let path = lock_dir.join(format!("{}-{}.lock", key.source, key.session_id));
    let file = OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .truncate(false)
        .open(path)?;
    FileExt::try_lock(&file).map_err(|error| {
        if matches!(error, fs4::TryLockError::WouldBlock) {
            CoreError::Conflict("이 세션의 터미널이 다른 프로세스에서 실행 중입니다".to_owned())
        } else {
            CoreError::Runtime(format!("터미널 잠금을 만들지 못했습니다: {error}"))
        }
    })?;
    Ok(file)
}

fn validate_identifier(id: &str) -> Result<(), CoreError> {
    if !crate::identifier::is_slug(id, 200) {
        return Err(CoreError::InvalidInput("잘못된 세션 ID입니다".to_owned()));
    }
    Ok(())
}

fn validate_size(cols: u16, rows: u16) -> Result<(), CoreError> {
    if !(MIN_COLS..=MAX_COLS).contains(&cols) || !(MIN_ROWS..=MAX_ROWS).contains(&rows) {
        return Err(CoreError::InvalidInput(
            "터미널 크기가 허용 범위를 벗어났습니다".to_owned(),
        ));
    }
    Ok(())
}

fn pty_size(cols: u16, rows: u16) -> PtySize {
    PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    }
}

fn unix_millis_after(duration: Duration) -> i64 {
    SystemTime::now()
        .checked_add(duration)
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or(i64::MAX)
}

/// 지정 PID에 신호를 보내고, 프로세스가 이미 사라졌으면 `Ok(false)`를 반환한다.
/// 그 밖의 권한·플랫폼 오류는 계정 전환을 중단할 수 있도록 숨기지 않는다.
#[cfg(unix)]
fn send_terminal_signal(pid: u32, signal: libc::c_int) -> Result<bool, String> {
    match process_signal::signal_pid(pid, signal) {
        Ok(process_signal::SignalDelivery::Delivered) => Ok(true),
        Ok(process_signal::SignalDelivery::Gone) => Ok(false),
        Err(error) => Err(error.to_string()),
    }
}

#[cfg(unix)]
fn terminal_pid_exists(pid: u32) -> Result<bool, CoreError> {
    process_signal::pid_exists(pid).map_err(|error| {
        CoreError::Runtime(format!(
            "터미널 프로세스 {pid} 상태를 확인하지 못했습니다: {error}"
        ))
    })
}

fn lock<T>(mutex: &Mutex<T>) -> Result<MutexGuard<'_, T>, CoreError> {
    mutex
        .lock()
        .map_err(|_| CoreError::Runtime("터미널 상태 잠금이 손상되었습니다".to_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn login_view(
        provider: ProviderId,
        environment_variable: &str,
    ) -> crate::AccountLoginSessionView {
        crate::AccountLoginSessionView {
            id: "login-1".to_owned(),
            provider,
            account_id: None,
            environment_variable: environment_variable.to_owned(),
            profile_path: "/tmp/login-profile".to_owned(),
            command: String::new(),
        }
    }

    /// Claude 자격증명 저장소는 `CLAUDE_SECURESTORAGE_CONFIG_DIR`이 정한다. 이 값을 함께
    /// 넘기지 않으면 로그인 CLI가 물려받은 다른 계정의 격리 프로필에 토큰을 쓴다.
    #[test]
    fn claude_login_pins_both_the_config_and_the_credential_store() {
        assert_eq!(
            account_login_env(&login_view(ProviderId::Claude, "CLAUDE_CONFIG_DIR")),
            [
                (
                    "CLAUDE_CONFIG_DIR".to_owned(),
                    "/tmp/login-profile".to_owned()
                ),
                (
                    "CLAUDE_SECURESTORAGE_CONFIG_DIR".to_owned(),
                    "/tmp/login-profile".to_owned()
                ),
            ]
        );
    }

    /// Codex는 `CODEX_HOME` 하나가 홈 전체를 옮기므로 그대로 둔다.
    #[test]
    fn codex_login_keeps_a_single_home_variable() {
        assert_eq!(
            account_login_env(&login_view(ProviderId::Codex, "CODEX_HOME")),
            [("CODEX_HOME".to_owned(), "/tmp/login-profile".to_owned())]
        );
    }

    /// Codex 계정 로그인은 원격 웹 UI에서도 완주해야 하므로 그때만 loopback 콜백이 필요한
    /// 기본 `codex login`을 버리고 device 코드로 간다. 로컬 UI는 콜백이 닿으므로 그대로 둔다.
    #[test]
    fn codex_account_login_uses_device_code_flow_only_when_remote() {
        assert_eq!(
            account_login_args(ProviderId::Codex, true).expect("codex remote args"),
            ["login", "--device-auth"]
        );
        assert_eq!(
            account_login_args(ProviderId::Codex, false).expect("codex local args"),
            ["login"]
        );
        for remote in [true, false] {
            assert_eq!(
                account_login_args(ProviderId::Claude, remote).expect("claude args"),
                ["auth", "login", "--claudeai"]
            );
            assert!(account_login_args(ProviderId::Antigravity, remote).is_err());
        }
    }

    #[test]
    fn provider_resume_arguments_are_fixed() {
        assert_eq!(
            resume_args(ProviderId::Claude, "abc-123"),
            ["--resume", "abc-123"]
        );
        assert_eq!(
            resume_args(ProviderId::Codex, "abc-123"),
            ["resume", "abc-123"]
        );
        assert_eq!(
            resume_args(ProviderId::Antigravity, "abc-123"),
            ["--conversation", "abc-123"]
        );
    }

    #[test]
    fn setup_terminal_uses_a_fixed_platform_shell() {
        let spec = resolve_setup_launch_spec().expect("setup shell");
        assert!(spec.executable.is_absolute());
        assert!(spec.executable.is_file());
        assert!(spec.cwd.is_dir());
    }

    #[test]
    fn identifier_rejects_shell_and_path_characters() {
        assert!(validate_identifier("019fb787-9c1e-7782-8128-2aecfba9af0c").is_ok());
        assert!(validate_identifier("../../session").is_err());
        assert!(validate_identifier("session;whoami").is_err());
        assert!(validate_identifier("").is_err());
    }

    #[test]
    fn terminal_geometry_is_bounded() {
        assert!(validate_size(80, 24).is_ok());
        assert!(validate_size(10, 24).is_err());
        assert!(validate_size(80, 500).is_err());
    }

    #[test]
    fn only_live_terminals_are_attached_and_exited_terminals_restart() {
        assert!(TerminalPhase::Running.can_attach());
        assert!(TerminalPhase::Detached.can_attach());
        assert!(!TerminalPhase::Stopping.can_attach());
        assert!(!TerminalPhase::Exited.can_attach());
        assert!(TerminalPhase::Exited.can_restart());
        assert!(!TerminalPhase::Failed.can_restart());
    }

    #[test]
    fn replay_buffer_keeps_the_most_recent_bytes() {
        let mut state = RuntimeState {
            phase: TerminalPhase::Running,
            subscriber: None,
            replay: VecDeque::from(vec![1_u8; MAX_REPLAY_BYTES]),
            replay_truncated: false,
            reconnect_deadline: None,
            expires_at: None,
            exit_code: None,
        };

        state.append_replay(&[2_u8; 10]);

        assert_eq!(state.replay.len(), MAX_REPLAY_BYTES);
        assert_eq!(state.replay.front(), Some(&1));
        assert_eq!(state.replay.back(), Some(&2));
        assert!(state.replay_truncated);
    }

    #[test]
    fn session_lock_blocks_a_second_manager_process() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let key = SessionKey {
            source: ProviderId::Codex,
            session_id: "abc-123".to_owned(),
        };
        let first = acquire_session_lock(directory.path(), &key).expect("first lock");
        assert!(matches!(
            acquire_session_lock(directory.path(), &key),
            Err(CoreError::Conflict(_))
        ));
        drop(first);
        assert!(acquire_session_lock(directory.path(), &key).is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn provider_terminal_stop_escalates_and_does_not_touch_other_providers() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let supervisor = TerminalSupervisor::new(directory.path()).expect("terminal supervisor");

        let ignored_term_key = SessionKey {
            source: ProviderId::Codex,
            session_id: "ignore-term".to_owned(),
        };
        let ignored_term = TerminalRuntime::spawn(
            ignored_term_key.clone(),
            80,
            24,
            LaunchSpec {
                executable: PathBuf::from("/bin/sh"),
                cwd: directory.path().to_path_buf(),
                args: vec![
                    "-c".to_owned(),
                    "trap '' TERM; while :; do :; done".to_owned(),
                ],
                env: Vec::new(),
            },
            acquire_session_lock(&supervisor.inner.lock_dir, &ignored_term_key)
                .expect("codex terminal lock"),
            None,
        )
        .expect("codex terminal runtime");

        let other_key = SessionKey {
            source: ProviderId::Claude,
            session_id: "other-provider".to_owned(),
        };
        let other = TerminalRuntime::spawn(
            other_key.clone(),
            80,
            24,
            LaunchSpec {
                executable: PathBuf::from("/bin/sleep"),
                cwd: directory.path().to_path_buf(),
                args: vec!["30".to_owned()],
                env: Vec::new(),
            },
            acquire_session_lock(&supervisor.inner.lock_dir, &other_key)
                .expect("claude terminal lock"),
            None,
        )
        .expect("claude terminal runtime");

        {
            let mut sessions = lock(&supervisor.inner.sessions).expect("terminal registry");
            sessions.insert(ignored_term_key, Arc::clone(&ignored_term));
            sessions.insert(other_key, Arc::clone(&other));
        }
        // 셸이 SIGTERM 무시 trap을 설치한 뒤 종료 경로를 시험한다.
        thread::sleep(Duration::from_millis(100));

        let report = supervisor
            .stop_provider_terminals(ProviderId::Codex)
            .expect("stop codex terminals");
        assert_eq!(report.requested_count, 1);
        assert_eq!(report.stopped_count, 1);
        assert_eq!(report.forced_count, 1);
        assert!(report.failed.is_empty());
        assert_eq!(report.remaining_terminal_count, 0);
        assert_eq!(
            ignored_term.phase().expect("codex phase"),
            TerminalPhase::Exited
        );
        assert_ne!(other.phase().expect("claude phase"), TerminalPhase::Exited);

        let cleanup = supervisor
            .stop_provider_terminals(ProviderId::Claude)
            .expect("stop claude terminal");
        assert_eq!(cleanup.requested_count, 1);
        assert_eq!(cleanup.stopped_count, 1);
        assert!(cleanup.failed.is_empty());
    }

    #[test]
    fn test_terminal_phase_enum() {
        use std::str::FromStr;

        for &phase in TerminalPhase::ALL {
            let s = phase.to_string();
            assert_eq!(phase.as_str(), s);
            assert_eq!(TerminalPhase::from_str(&s).unwrap(), phase);

            // serde_json 직렬화 및 역직렬화 라운드트립 검증
            let json = serde_json::to_string(&phase).unwrap();
            assert_eq!(json, format!("\"{}\"", s));
            let deserialized: TerminalPhase = serde_json::from_str(&json).unwrap();
            assert_eq!(deserialized, phase);
        }
        assert!(TerminalPhase::from_str("unknown").is_err());
    }
}
