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
use portable_pty::{
    native_pty_system, Child as PtyChild, ChildKiller, CommandBuilder, MasterPty, PtySize,
};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::catalog::{load_session_summary, SessionCatalog};
use crate::chat::{chat_string_enum, resolve_executable};
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
#[cfg(unix)]
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

/// C9-19. 저장된 SSH 연결 서버로 사용자가 직접 붙는 대화형 터미널.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSshRequest {
    pub fingerprint: String,
    pub cols: u16,
    pub rows: u16,
    /// 이 창으로 무엇을 할지. 적지 않으면 지금까지처럼 원격 셸이다.
    #[serde(default)]
    pub mode: TerminalSshMode,
}

/// C9-20. 같은 서버로 여는 대화형 창의 두 갈래.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TerminalSshMode {
    /// 사용자가 직접 명령을 치는 원격 셸.
    #[default]
    Shell,
    /// 이 키의 공개키를 원격 `authorized_keys`에 한 번 등록하고 끝나는 창.
    InstallKey,
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

// `ALL`·`as_str`·`Display`·`FromStr` 네 덩어리를 손으로 적던 자리다. 채팅 열거형이 쓰는
// 대응표 매크로와 글자 하나까지 같은 모양이었고, 상태를 하나 늘리면 네 곳을 맞춰 고쳐야
// 했다. 이제 표만 적으면 `FromStr`가 그 표를 뒤집어 쓰므로 양방향이 어긋날 수 없다.
chat_string_enum!(TerminalPhase, "알 수 없는 터미널 상태입니다", {
    Running => "running",
    Detached => "detached",
    Stopping => "stopping",
    Exited => "exited",
    Failed => "failed",
});

impl TerminalPhase {
    /// 클라이언트가 화면을 붙이거나 입력을 보낼 수 있는 활성 상태인지.
    fn is_active(self) -> bool {
        matches!(self, Self::Running | Self::Detached)
    }

    fn can_attach(self) -> bool {
        self.is_active()
    }

    fn can_restart(self) -> bool {
        self == Self::Exited
    }

    /// 프로세스가 이미 종료되었거나 실패해 추가 종료 처리가 필요 없는 종단 상태인지.
    fn is_terminated(self) -> bool {
        matches!(self, Self::Exited | Self::Failed)
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSessionInfo {
    pub terminal_id: String,
    /// 공급자 CLI 터미널의 공급자. SSH 대화형 터미널(C9-19)은 공급자가 없어 `None`이다.
    pub source: Option<ProviderId>,
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
    /// `None`은 공급자에 묶이지 않은 터미널(SSH 대화형)이다. 공급자별 일괄 종료에서
    /// 제외되고 잠금 파일 이름은 `ssh-`로 시작한다.
    source: Option<ProviderId>,
    session_id: String,
}

impl SessionKey {
    fn provider(source: ProviderId, session_id: impl Into<String>) -> Self {
        Self {
            source: Some(source),
            session_id: session_id.into(),
        }
    }

    fn setup(source: ProviderId) -> Self {
        Self::provider(source, "cli-setup")
    }

    fn account_login(source: ProviderId, login_id: &str) -> Self {
        Self::provider(source, format!("account-login-{login_id}"))
    }

    fn ssh(fingerprint: &str, mode: TerminalSshMode) -> Self {
        Self {
            source: None,
            session_id: ssh_terminal_session_id(fingerprint, mode),
        }
    }

    fn source_label(&self) -> &'static str {
        self.source.map_or("ssh", ProviderId::as_str)
    }

    fn lock_path(&self, lock_dir: &Path) -> PathBuf {
        lock_dir.join(format!("{}-{}.lock", self.source_label(), self.session_id))
    }
}

struct SupervisorInner {
    app_data_dir: PathBuf,
    lock_dir: PathBuf,
    session_catalog: Option<SessionCatalog>,
    sessions: Mutex<HashMap<SessionKey, Arc<TerminalRuntime>>>,
    accounts: Option<AccountSupervisor>,
}

impl SupervisorInner {
    /// 같은 Arc 인스턴스가 등록되어 있을 때만 세션 맵에서 지운다.
    fn remove_matching_session(
        &self,
        key: &SessionKey,
        expected: &Arc<TerminalRuntime>,
    ) -> Result<Option<Arc<TerminalRuntime>>, CoreError> {
        let mut sessions = lock(&self.sessions)?;
        Ok(remove_matching_session(&mut sessions, key, expected))
    }
}

struct TerminalRuntime {
    terminal_id: String,
    key: SessionKey,
    #[cfg_attr(not(unix), allow(dead_code))]
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

    /// 연결이 끊긴 터미널을 재연결 유예 동안 남기고 화면에도 마감 시각을 알린다.
    fn begin_detached_grace(&mut self) {
        self.phase = TerminalPhase::Detached;
        self.begin_reconnect_grace(Some(unix_millis_after(RECONNECT_GRACE)));
    }

    /// 프로세스가 끝난 터미널을 재연결 유예 동안만 남겨 둔다. 유예 시각은 내부 청소용이라
    /// 화면에 노출하는 재연결 마감(`reconnect_deadline`)과 달리 비워 둔다.
    fn begin_exit_grace(&mut self) {
        self.begin_reconnect_grace(None);
    }

    /// 재연결 유예의 내부 만료와 화면용 마감 시각을 함께 갱신한다.
    fn begin_reconnect_grace(&mut self, reconnect_deadline: Option<i64>) {
        self.expires_at = Some(Instant::now() + RECONNECT_GRACE);
        self.reconnect_deadline = reconnect_deadline;
    }
}

struct LaunchSpec {
    executable: PathBuf,
    cwd: PathBuf,
    args: Vec<String>,
    env: Vec<(String, String)>,
}

impl LaunchSpec {
    /// PTY는 경로를 손대지 않고 그대로 `CreateProcessW`에 넘긴다. `std::process::Command`와
    /// 달리 프로그램 경로를 정규화해 주지 않으므로, 확장 경로가 들어오면 `cmd.exe`가 작업
    /// 경로를 거부하고 배치 셈(`codex.cmd`)을 열지 못한다. 네 곳의 생성자가 각자 조심하는
    /// 대신 여기서 한 번 벗겨, 어떤 실행 경로도 접두어를 달고 나갈 수 없게 한다 —
    /// `resolve_ssh_launch_spec`은 실제로 `canonical_path`를 거치지 않는다.
    fn new(executable: PathBuf, cwd: PathBuf, args: Vec<String>) -> Self {
        Self {
            executable: crate::path_guard::child_facing(&executable),
            cwd: crate::path_guard::child_facing(&cwd),
            args,
            env: Vec::new(),
        }
    }

    /// 환경변수를 얹는다. 이것을 쓰는 것은 계정 로그인 경로 하나뿐이지만, 생성자를
    /// 비켜 구조체를 손으로 채우면 칸이 하나 늘 때 그 자리만 빠지게 된다.
    fn with_env(mut self, env: Vec<(String, String)>) -> Self {
        self.env = env;
        self
    }
}

impl TerminalSupervisor {
    pub fn new(app_data_dir: impl AsRef<Path>) -> Result<Self, CoreError> {
        Self::create(app_data_dir.as_ref(), None, None)
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
        let key = SessionKey::provider(request.source, request.session_id.clone());

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
    ///
    /// 계정을 두지 않는 공급자(로컬)도 임차 없이 뜬다. 이 임차는 공유 홈 자격증명을
    /// 바꾸는 동안 살아 있는 런타임을 세는 자리(C1-6)이고, 자격증명이 없는 공급자에는
    /// 셀 것도 막을 것도 없다. 그런데도 임차를 요구하면 `credential_switch_guard`가
    /// "계정 관리를 지원하지 않습니다"로 거절해, 하네스를 설치하러 여는 설정 터미널이
    /// 통째로 열리지 않았다.
    fn unscoped_lease(
        &self,
        provider: ProviderId,
        kind: UnscopedRuntimeKind,
    ) -> Result<Option<AccountRuntimeLease>, CoreError> {
        if !provider.manages_accounts() {
            return Ok(None);
        }
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
        let key = SessionKey::setup(request.source);
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
        let accounts = self.inner.accounts.as_ref().ok_or_else(|| {
            CoreError::Conflict("계정 로그인은 로컬 데스크톱에서만 사용할 수 있습니다".to_owned())
        })?;
        let login = accounts.login_session(&request.login_id)?;
        let key = SessionKey::account_login(login.provider, &request.login_id);
        let provider = login.provider;
        self.open_with(
            key,
            request.cols,
            request.rows,
            || resolve_account_login_launch_spec(login, remote),
            || self.unscoped_lease(provider, UnscopedRuntimeKind::IsolatedLogin),
        )
    }

    /// C9-19. 저장된 SSH 연결 서버로 사용자가 직접 붙는 대화형 터미널을 연다. 같은 서버의
    /// 터미널이 살아 있으면 거기에 다시 붙는다. 계정 lease는 없다 — 공급자 자원을 쓰지
    /// 않는다. 명령 목록은 적용하지 않는다: 그 목록은 에이전트를 묶는 규칙이고, 사용자가
    /// 자기 손으로 치는 셸에 앞머리 대조를 걸 방법도 없다.
    pub fn open_ssh(&self, request: TerminalSshRequest) -> Result<TerminalAttachment, CoreError> {
        let launch = match request.mode {
            TerminalSshMode::Shell => crate::ssh_endpoints::ssh_terminal_launch(
                &self.inner.app_data_dir,
                &request.fingerprint,
            ),
            // C9-20. 공개키 등록은 원격 명령 하나를 달고 열려 끝나면 스스로 닫힌다.
            TerminalSshMode::InstallKey => crate::ssh_endpoints::ssh_key_install_launch(
                &self.inner.app_data_dir,
                &request.fingerprint,
            ),
        }?;
        let key = SessionKey::ssh(&launch.fingerprint, request.mode);
        self.open_with(
            key,
            request.cols,
            request.rows,
            move || resolve_ssh_launch_spec(launch),
            || Ok(None),
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
        validate_size(cols, rows)?;
        if let Some(attachment) = self.attach_existing(&key, cols, rows)? {
            return Ok(attachment);
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

    /// 이미 등록된 런타임은 재연결하거나, 종료된 항목이면 새 기동을 위해 맵에서 걷어낸다.
    fn attach_existing(
        &self,
        key: &SessionKey,
        cols: u16,
        rows: u16,
    ) -> Result<Option<TerminalAttachment>, CoreError> {
        let existing = {
            let sessions = lock(&self.inner.sessions)?;
            sessions.get(key).cloned()
        };
        let Some(runtime) = existing else {
            return Ok(None);
        };
        let phase = runtime.phase()?;
        if phase.can_attach() {
            runtime.resize(cols, rows)?;
            return runtime.attach().map(Some);
        }
        if !phase.can_restart() {
            return Err(CoreError::Conflict(
                "터미널 프로세스를 정리하고 있습니다. 잠시 후 다시 연결하세요".to_owned(),
            ));
        }

        let removed = self.inner.remove_matching_session(key, &runtime)?;
        drop(runtime);
        drop(removed);
        Ok(None)
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
        let targets = self.provider_runtimes(provider)?;
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
                Err(error) => failed.push(runtime.to_stop_failure(error)),
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
        Ok(self.provider_runtimes(provider)?.len())
    }

    /// 아직 종료가 확인되지 않은 해당 공급자의 관리 런타임. 일괄 종료와 잔여 수 확인이
    /// 같은 조건으로 각자 순회하고 있어 한 자리로 모았다.
    fn provider_runtimes(
        &self,
        provider: ProviderId,
    ) -> Result<Vec<Arc<TerminalRuntime>>, CoreError> {
        let sessions = lock(&self.inner.sessions)?;
        let mut runtimes = Vec::new();
        for runtime in sessions.values() {
            if runtime.key.source == Some(provider) && runtime.phase()? != TerminalPhase::Exited {
                runtimes.push(Arc::clone(runtime));
            }
        }
        Ok(runtimes)
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
        let pty = open_terminal_pty(cols, rows, spec)?;
        let runtime = Arc::new(Self {
            terminal_id: Uuid::new_v4().to_string(),
            key,
            process_id: pty.process_id,
            state: Mutex::new(RuntimeState {
                phase: TerminalPhase::Running,
                subscriber: None,
                replay: VecDeque::new(),
                replay_truncated: false,
                reconnect_deadline: None,
                expires_at: None,
                exit_code: None,
            }),
            master: Mutex::new(pty.master),
            writer: Mutex::new(pty.writer),
            killer: Mutex::new(pty.killer),
            session_lock: Mutex::new(Some(session_lock)),
            account_runtime_lease: Mutex::new(account_runtime_lease),
        });
        attach_runtime_threads(&runtime, pty.reader, pty.child)?;
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
        // 연결 직후 밀어 넣는 세 이벤트가 모두 '보내고, 막히면 그 자리의 문구로 실패'라
        // 같은 모양이었다. 실패 문구만 다르므로 전송을 한 자리로 모으고 문구를 받는다.
        let send = |event: TerminalEvent, failure: &str| -> Result<(), CoreError> {
            sender
                .try_send(event)
                .map_err(|_| CoreError::Runtime(failure.to_owned()))
        };
        send(
            TerminalEvent::State {
                session: info.clone(),
            },
            "터미널 이벤트 채널을 열지 못했습니다",
        )?;
        let replay = state.replay.iter().copied().collect::<Vec<_>>();
        for chunk in replay.chunks(REPLAY_CHUNK_BYTES) {
            send(
                TerminalEvent::Output {
                    data: chunk.to_vec(),
                },
                "터미널 출력을 재생하지 못했습니다",
            )?;
        }
        if state.phase == TerminalPhase::Exited {
            send(
                TerminalEvent::Exit {
                    code: state.exit_code,
                },
                "터미널 종료 상태를 전달하지 못했습니다",
            )?;
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
        if !phase.is_active() {
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
        if state.phase.is_active() {
            state.begin_detached_grace();
        }
        Ok(())
    }

    fn terminate(&self) {
        let already_terminated = self.with_state(|state| {
            if state.phase.is_terminated() {
                return true;
            }
            state.phase = TerminalPhase::Stopping;
            self.emit_state(state);
            false
        });
        // 상태를 못 읽었으면(잠금 오염) 이미 끝났는지 알 수 없으므로 종료 신호는 보낸다.
        if already_terminated == Some(true) {
            return;
        }
        self.kill_child();
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
            let pid = self
                .process_id
                .ok_or_else(|| self.stop_error("프로세스 PID를 확인할 수 없습니다".to_owned()))?;
            let outcome = process_signal::escalate_stop(
                (
                    // SIGTERM을 보내지 못한 것은 종료 여부를 알 수 없다는 뜻일 뿐이라
                    // 사라졌다고 보지 않고 그대로 기다려 본다.
                    || {
                        Ok(match send_terminal_signal(pid, libc::SIGTERM) {
                            Ok(false) => process_signal::SignalDelivery::Gone,
                            _ => process_signal::SignalDelivery::Delivered,
                        })
                    },
                    GRACEFUL_STOP_TIMEOUT,
                ),
                (
                    || {
                        send_terminal_signal(pid, libc::SIGKILL)
                            .map(|_| process_signal::SignalDelivery::Delivered)
                            .map_err(|error| {
                                self.stop_error(format!(
                                    "PID {pid} 강제 종료 신호를 보내지 못했습니다: {error}"
                                ))
                            })
                    },
                    FORCED_STOP_TIMEOUT,
                ),
                |timeout| self.wait_for_exit(timeout),
            )?;
            match outcome {
                process_signal::StopEscalation::AlreadyGone => {
                    self.mark_exited(None);
                    Ok(false)
                }
                process_signal::StopEscalation::Graceful => Ok(false),
                process_signal::StopEscalation::Forced => Ok(true),
                process_signal::StopEscalation::Stuck => {
                    Err(self
                        .stop_error(format!("PID {pid}가 SIGKILL 이후에도 종료되지 않았습니다")))
                }
            }
        }

        #[cfg(not(unix))]
        {
            if let Ok(mut killer) = self.killer.lock() {
                killer.kill().map_err(|error| {
                    self.stop_error(format!("종료 신호를 보내지 못했습니다: {error}"))
                })?;
            }
            if self.wait_for_exit(FORCED_STOP_TIMEOUT)? {
                return Ok(false);
            }
            Err(self.stop_error("종료를 확인하지 못했습니다".to_owned()))
        }
    }

    /// 종료 단계의 오류 문구. 어느 터미널인지 밝히는 앞머리가 모두 같아 한 자리로 모았다.
    fn stop_error(&self, reason: String) -> CoreError {
        CoreError::Runtime(format!("터미널 {}의 {reason}", self.terminal_id))
    }

    fn to_stop_failure(&self, error: impl ToString) -> StopTerminalFailure {
        StopTerminalFailure {
            terminal_id: self.terminal_id.clone(),
            session_id: self.key.session_id.clone(),
            error: error.to_string(),
        }
    }

    fn mark_stopping(&self) {
        self.with_state(|state| {
            if state.phase == TerminalPhase::Exited {
                return;
            }
            state.phase = TerminalPhase::Stopping;
            state.clear_deadlines();
            self.emit_state(state);
        });
    }

    fn wait_for_exit(&self, timeout: Duration) -> Result<bool, CoreError> {
        crate::chat::poll_until(timeout, STOP_POLL_INTERVAL, || {
            if self.phase()? == TerminalPhase::Exited {
                return Ok(true);
            }
            // 자식이 PTY를 남긴 채 사라지면 종료 이벤트가 오지 않는다. PID가 없어진 것을
            // 보면 그 자리에서 종료로 기록한다.
            #[cfg(unix)]
            if let Some(pid) = self.process_id {
                if !terminal_pid_exists(pid)? {
                    self.mark_exited(None);
                    return Ok(true);
                }
            }
            Ok(false)
        })
    }

    fn append_output(&self, data: &[u8]) {
        self.with_state(|state| {
            state.append_replay(data);
            try_send(
                state,
                TerminalEvent::Output {
                    data: data.to_vec(),
                },
            );
        });
    }

    fn mark_exited(&self, code: Option<u32>) {
        self.with_state(|state| {
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
            try_send(state, TerminalEvent::Exit { code });
            self.emit_state(state);
        });
    }

    fn mark_failed(&self, message: String) {
        let marked = self.with_state(|state| {
            state.phase = TerminalPhase::Failed;
            state.begin_exit_grace();
            try_send(state, TerminalEvent::Error { message });
            self.emit_state(state);
        });
        // 상태 잠금을 놓은 뒤에 죽인다. 자식이 끝나며 도는 보조 스레드가 같은 잠금을 잡는다.
        if marked.is_some() {
            self.kill_child();
        }
    }

    fn is_expired(&self, now: Instant) -> bool {
        self.state
            .lock()
            .ok()
            .and_then(|state| state.expires_at)
            .is_some_and(|expires_at| expires_at <= now)
    }

    /// 상태 잠금을 잡고 전이 하나를 적용한다. 잠금이 오염됐으면(상태를 바꾸던 스레드가
    /// 패닉) 아무것도 하지 않고 `None`을 돌려준다 — 상태를 만지는 다섯 자리가 모두 같은
    /// 판단을 하고 있어 한 벌로 모았다. 뒷정리가 딸린 호출부는 반환값으로 갈라본다.
    fn with_state<T>(&self, body: impl FnOnce(&mut RuntimeState) -> T) -> Option<T> {
        let mut state = self.state.lock().ok()?;
        Some(body(&mut state))
    }

    /// 자식에게 종료 신호를 보낸다. 이미 죽었거나 신호를 못 보내도 할 수 있는 일이 없어
    /// 실패는 삼킨다. 종료 확인이 필요한 경로는 `stop_with_escalation`이 따로 맡는다.
    fn kill_child(&self) {
        if let Ok(mut killer) = self.killer.lock() {
            let _ = killer.kill();
        }
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

/// PTY를 열고 CLI를 띄운 직후에 손에 남는 것들. 런타임 구조체가 들고 갈 손잡이와
/// 보조 스레드로 넘길 손잡이가 섞여 있어 한 묶음으로 돌려준다.
struct SpawnedPty {
    master: Box<dyn MasterPty + Send>,
    reader: Box<dyn Read + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    child: Box<dyn PtyChild + Send + Sync>,
    process_id: Option<u32>,
}

/// 실행 스펙을 PTY 명령으로 옮긴다.
fn terminal_command(spec: LaunchSpec) -> CommandBuilder {
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
    command
}

/// PTY 한 쌍을 열고 그 안에서 CLI를 띄운다. slave는 자식에게 넘겨준 뒤 이쪽에서 닫아야
/// 자식이 끝났을 때 master 쪽 읽기가 EOF로 닫힌다.
fn open_terminal_pty(cols: u16, rows: u16, spec: LaunchSpec) -> Result<SpawnedPty, CoreError> {
    let pair = native_pty_system()
        .openpty(pty_size(cols, rows))
        .map_err(|error| CoreError::Runtime(format!("PTY를 열지 못했습니다: {error}")))?;
    let child = pair
        .slave
        .spawn_command(terminal_command(spec))
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
    Ok(SpawnedPty {
        master: pair.master,
        reader,
        writer,
        killer,
        child,
        process_id,
    })
}

/// 런타임에 딸리는 두 보조 스레드 — PTY 출력 읽기와 자식 종료 대기. 런타임이 만들어진
/// 뒤에만 붙일 수 있어 기동 함수에서 떼어 냈다.
fn attach_runtime_threads(
    runtime: &Arc<TerminalRuntime>,
    reader: Box<dyn Read + Send>,
    mut child: Box<dyn PtyChild + Send + Sync>,
) -> Result<(), CoreError> {
    let reader_runtime = Arc::clone(runtime);
    spawn_named_thread(
        format!("terminal-reader-{}", runtime.terminal_id),
        move || read_terminal(reader_runtime, reader),
    )?;

    let wait_runtime = Arc::clone(runtime);
    spawn_named_thread(
        format!("terminal-wait-{}", runtime.terminal_id),
        move || match child.wait() {
            Ok(status) => wait_runtime.mark_exited(Some(status.exit_code())),
            Err(error) => {
                wait_runtime.mark_failed(format!("CLI 종료 상태를 읽지 못했습니다: {error}"))
            }
        },
    )
}

/// 이름 붙인 스레드 하나를 띄운다. 두 보조 스레드가 같은 모양으로 이름을 짓고 같은
/// 오류로 감싸고 있어 한 자리로 모았다.
fn spawn_named_thread(name: String, body: impl FnOnce() + Send + 'static) -> Result<(), CoreError> {
    thread::Builder::new()
        .name(name)
        .spawn(body)
        .map(|_| ())
        .map_err(CoreError::Io)
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
                state.begin_detached_grace();
            }
        }
    }
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
                remove_matching_session(&mut sessions, &key, &runtime);
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
    Ok(LaunchSpec::new(
        resolve_executable(request.source)?,
        cwd,
        resume_args(request.source, &request.session_id),
    ))
}

/// 붙을 세션 경로가 없는 터미널(설정 셸·SSH)이 쓰는 작업 경로.
fn home_launch_cwd() -> Result<PathBuf, CoreError> {
    canonical_dir(
        user_home::home_dir()?,
        "사용자 홈 경로가 디렉터리가 아닙니다",
    )
}

fn resolve_setup_launch_spec() -> Result<LaunchSpec, CoreError> {
    let cwd = home_launch_cwd()?;

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
    Ok(LaunchSpec::new(executable, cwd, args))
}

fn resolve_ssh_launch_spec(
    launch: crate::ssh_endpoints::SshTerminalLaunch,
) -> Result<LaunchSpec, CoreError> {
    let cwd = home_launch_cwd()?;
    Ok(LaunchSpec::new(launch.executable, cwd, launch.args))
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
    Ok(LaunchSpec::new(executable, cwd, args).with_env(account_login_env(&login)))
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
        // 계정이 없어 로그인 명령 자체가 없다.
        ProviderId::Local => {
            return Err(CoreError::InvalidInput(
                "로컬 공급자는 로그인이 필요하지 않습니다".to_owned(),
            ))
        }
        ProviderId::Codex if remote => vec!["login".to_owned(), "--device-auth".to_owned()],
        ProviderId::Codex => vec!["login".to_owned()],
        ProviderId::Claude => vec![
            "auth".to_owned(),
            "login".to_owned(),
            "--claudeai".to_owned(),
        ],
        // 로그인만 하는 명령이 없다. `/usage`는 토큰으로 서버에 묻는 가장 가벼운 요청이라
        // 로그인 직후 잔량이 찍히는 것으로 성공을 눈으로 확인할 수 있다. 미로그인이면 CLI가
        // 브라우저를 열고 인증 코드를 stdin으로 기다리므로(60초), 사용자가 이 터미널에
        // 코드를 붙여넣어 끝낸다.
        ProviderId::Antigravity => vec![
            "--print".to_owned(),
            "/usage".to_owned(),
            "--output-format".to_owned(),
            "text".to_owned(),
        ],
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
    // Windows의 `agy`는 `USERPROFILE`로 홈을 잡는다. 로그인 터미널이 실행 프로필과 같은
    // 목록을 쓰지 않으면 로그인이 실제 홈에서 돌아 임시 프로필에는 아무것도 남지 않는다.
    if login.provider == ProviderId::Antigravity {
        env = crate::credential_profiles::antigravity_home_env(&login.profile_path);
    }
    env
}

#[derive(Clone, Copy)]
enum CanonicalPathKind {
    Directory,
    File,
}

impl CanonicalPathKind {
    fn matches(self, path: &Path) -> bool {
        match self {
            Self::Directory => path.is_dir(),
            Self::File => path.is_file(),
        }
    }
}

/// 실행 스펙의 경로를 확정하고 기대한 종류인지 확인한다. 경로마다 어긋났을 때 보여줄
/// 문구가 다르므로 종류와 문구만 호출부에서 받는다.
fn canonical_path(
    path: impl AsRef<Path>,
    kind: CanonicalPathKind,
    mismatch: &str,
) -> Result<PathBuf, CoreError> {
    let path = crate::path_guard::canonical_child_facing(path)?;
    if !kind.matches(&path) {
        return Err(CoreError::InvalidInput(mismatch.to_owned()));
    }
    Ok(path)
}

fn canonical_dir(path: impl AsRef<Path>, mismatch: &str) -> Result<PathBuf, CoreError> {
    canonical_path(path, CanonicalPathKind::Directory, mismatch)
}

/// 공급자 CLI는 `resolve_executable`이 같은 검사를 품고 있어 여기 남는 것은 설정
/// 터미널의 셸뿐이다.
fn canonical_file(path: impl AsRef<Path>, mismatch: &str) -> Result<PathBuf, CoreError> {
    canonical_path(path, CanonicalPathKind::File, mismatch)
}

fn resume_args(source: ProviderId, session_id: &str) -> Vec<String> {
    match source {
        ProviderId::Claude => vec!["--resume".to_owned(), session_id.to_owned()],
        ProviderId::Codex => vec!["resume".to_owned(), session_id.to_owned()],
        // ACP 하네스는 `resume` 하위 명령이 없다. 세션을 이어 여는 것은 TUI 인자다.
        ProviderId::Local => vec!["--session".to_owned(), session_id.to_owned()],
        ProviderId::Antigravity => vec!["--conversation".to_owned(), session_id.to_owned()],
    }
}

fn acquire_session_lock(lock_dir: &Path, key: &SessionKey) -> Result<File, CoreError> {
    let path = key.lock_path(lock_dir);
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

/// 지문(`SHA256:base64`)은 잠금 파일 이름에 못 쓰는 글자를 담으므로, 세션 id는 영문·숫자만
/// 남긴 지문으로 만든다. 같은 지문은 같은 id가 되어 재접속이 같은 터미널에 닿는다.
///
/// C9-20. 갈래가 다르면 id도 달라야 한다. 같은 id를 쓰면 열려 있던 원격 셸에 다시 붙어
/// 버려서, 공개키를 등록하려고 누른 버튼이 등록을 하지 않는다.
fn ssh_terminal_session_id(fingerprint: &str, mode: TerminalSshMode) -> String {
    let body = fingerprint
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .collect::<String>();
    match mode {
        TerminalSshMode::Shell => format!("ssh-{body}"),
        TerminalSshMode::InstallKey => format!("ssh-install-{body}"),
    }
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
    process_signal::signal_pid(pid, signal)
        .map(process_signal::SignalDelivery::was_delivered)
        .map_err(|error| error.to_string())
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

/// 등록된 세션이 대상과 같은 Arc 인스턴스일 때만 맵에서 지운다.
/// 재연결 재시작이나 리퍼 정리 시점에 다른 스레드가 이미 새 세션으로 갈아끼웠으면
/// 새 세션을 지우지 않게 보호한다.
fn remove_matching_session(
    sessions: &mut HashMap<SessionKey, Arc<TerminalRuntime>>,
    key: &SessionKey,
    expected: &Arc<TerminalRuntime>,
) -> Option<Arc<TerminalRuntime>> {
    if sessions
        .get(key)
        .is_some_and(|current| Arc::ptr_eq(current, expected))
    {
        sessions.remove(key)
    } else {
        None
    }
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
            // Antigravity에는 로그인 전용 명령이 없어, 토큰으로 서버에 묻는 가장 가벼운
            // 요청을 쓴다. 성공하면 잔량이 찍혀 로그인 완료가 눈으로 확인된다.
            assert_eq!(
                account_login_args(ProviderId::Antigravity, remote).expect("antigravity args"),
                ["--print", "/usage", "--output-format", "text"]
            );
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

    /// 실행 스펙의 경로는 모두 `canonical_path`를 거치므로, 여기서 확장 경로 접두어가
    /// 남지 않는 것이 계정 로그인 터미널까지 함께 지키는 조건이다. `\\?\C:\…`를 작업
    /// 경로로 받은 `cmd.exe`는 `UNC 경로는 지원되지 않습니다`를 찍고 Windows 디렉터리로
    /// 물러나, 그 위에서 도는 배치 셈(`codex.cmd`)이 `지정된 경로를 찾을 수 없습니다`로
    /// 죽었다.
    #[test]
    fn setup_terminal_uses_a_fixed_platform_shell() {
        let spec = resolve_setup_launch_spec().expect("setup shell");
        assert!(spec.executable.is_absolute());
        assert!(spec.executable.is_file());
        assert!(spec.cwd.is_dir());
        for path in [&spec.executable, &spec.cwd] {
            assert!(
                !path.to_string_lossy().starts_with(r"\\?\"),
                "자식에게 넘기는 경로에 확장 경로 접두어가 남았습니다: {}",
                path.display()
            );
        }
    }

    /// 실행 스펙을 만드는 네 자리 중 `resolve_ssh_launch_spec`은 `canonical_path`를
    /// 거치지 않는다. 생성자가 직접 벗기므로, 어느 자리가 무엇을 넘기든 PTY에 확장
    /// 경로가 닿지 않는다.
    #[test]
    fn launch_specs_never_carry_a_verbatim_path() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let canonical = fs::canonicalize(directory.path()).expect("canonical");
        let spec = LaunchSpec::new(
            canonical.join("cli"),
            canonical.clone(),
            vec!["login".to_owned()],
        );
        for path in [&spec.executable, &spec.cwd] {
            assert!(
                !path.to_string_lossy().starts_with(r"\\?\"),
                "실행 스펙이 확장 경로를 들고 있습니다: {}",
                path.display()
            );
        }
        // 접두어만 벗을 뿐 가리키는 자리는 그대로다.
        assert!(spec.cwd.is_dir());
        assert_eq!(spec.args, ["login"]);
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
        assert!(TerminalPhase::Running.is_active());
        assert!(TerminalPhase::Detached.is_active());
        assert!(!TerminalPhase::Stopping.is_active());
        assert!(!TerminalPhase::Exited.is_active());
        assert!(!TerminalPhase::Failed.is_active());
        assert!(TerminalPhase::Running.can_attach());
        assert!(TerminalPhase::Detached.can_attach());
        assert!(!TerminalPhase::Stopping.can_attach());
        assert!(!TerminalPhase::Exited.can_attach());
        assert!(TerminalPhase::Exited.can_restart());
        assert!(!TerminalPhase::Failed.can_restart());
        assert!(TerminalPhase::Exited.is_terminated());
        assert!(TerminalPhase::Failed.is_terminated());
        assert!(!TerminalPhase::Running.is_terminated());
        assert!(!TerminalPhase::Stopping.is_terminated());
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

    /// C9-19. SSH 터미널 키는 공급자가 없고, 지문에서 파일 이름에 못 쓰는 글자를 뺀 id를 쓴다.
    #[test]
    fn c9_19_ssh_terminal_key_has_no_provider_and_a_filesystem_safe_id() {
        let key = SessionKey::ssh("SHA256:ab+/cd=Ef", TerminalSshMode::Shell);
        assert_eq!(key.session_id, "ssh-SHA256abcdEf");
        assert_eq!(key.source_label(), "ssh");
        let directory = tempfile::tempdir().expect("temporary directory");
        let lock = acquire_session_lock(directory.path(), &key).expect("lock");
        assert!(directory.path().join("ssh-ssh-SHA256abcdEf.lock").is_file());
        drop(lock);
    }

    /// C9-20. 공개키 등록 창은 같은 서버의 원격 셸과 다른 세션이다. id가 같으면 열려 있던
    /// 셸에 다시 붙어 버려서 등록 명령이 아예 실행되지 않는다.
    #[test]
    fn c9_20_key_install_terminal_does_not_reattach_to_the_open_shell() {
        let shell = SessionKey::ssh("SHA256:ab+/cd=Ef", TerminalSshMode::Shell);
        let install = SessionKey::ssh("SHA256:ab+/cd=Ef", TerminalSshMode::InstallKey);
        assert_ne!(shell.session_id, install.session_id);
        assert_eq!(install.session_id, "ssh-install-SHA256abcdEf");

        // 두 잠금이 같은 폴더에서 함께 살아 있어야 한 쪽이 다른 쪽을 막지 않는다.
        let directory = tempfile::tempdir().expect("temporary directory");
        let shell_lock = acquire_session_lock(directory.path(), &shell).expect("shell lock");
        let install_lock = acquire_session_lock(directory.path(), &install).expect("install lock");
        drop(install_lock);
        drop(shell_lock);
    }

    #[test]
    fn session_lock_blocks_a_second_manager_process() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let key = SessionKey::provider(ProviderId::Codex, "abc-123");
        let first = acquire_session_lock(directory.path(), &key).expect("first lock");
        assert!(matches!(
            acquire_session_lock(directory.path(), &key),
            Err(CoreError::Conflict(_))
        ));
        drop(first);
        assert!(acquire_session_lock(directory.path(), &key).is_ok());
    }

    #[test]
    fn canonical_launch_paths_keep_file_and_directory_checks_distinct() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let file = directory.path().join("shell");
        fs::write(&file, b"shell").expect("temporary file");

        // 확정한 경로는 자식에게 그대로 넘어가므로 `fs::canonicalize` 원본이 아니라
        // 접두어를 벗긴 모양과 같아야 한다.
        assert_eq!(
            canonical_dir(directory.path(), "directory mismatch").expect("canonical directory"),
            crate::path_guard::canonical_child_facing(directory.path())
                .expect("expected canonical directory")
        );
        assert_eq!(
            canonical_file(&file, "file mismatch").expect("canonical file"),
            crate::path_guard::canonical_child_facing(&file).expect("expected canonical file")
        );
        assert!(matches!(
            canonical_dir(&file, "directory mismatch"),
            Err(CoreError::InvalidInput(message)) if message == "directory mismatch"
        ));
        assert!(matches!(
            canonical_file(directory.path(), "file mismatch"),
            Err(CoreError::InvalidInput(message)) if message == "file mismatch"
        ));
    }

    #[cfg(unix)]
    #[test]
    fn provider_terminal_stop_escalates_and_does_not_touch_other_providers() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let supervisor = TerminalSupervisor::new(directory.path()).expect("terminal supervisor");

        let ignored_term_key = SessionKey::provider(ProviderId::Codex, "ignore-term");
        let ignored_term = TerminalRuntime::spawn(
            ignored_term_key.clone(),
            80,
            24,
            LaunchSpec::new(
                PathBuf::from("/bin/sh"),
                directory.path().to_path_buf(),
                vec![
                    "-c".to_owned(),
                    "trap '' TERM; while :; do :; done".to_owned(),
                ],
            ),
            acquire_session_lock(&supervisor.inner.lock_dir, &ignored_term_key)
                .expect("codex terminal lock"),
            None,
        )
        .expect("codex terminal runtime");

        let other_key = SessionKey::provider(ProviderId::Claude, "other-provider");
        let other = TerminalRuntime::spawn(
            other_key.clone(),
            80,
            24,
            LaunchSpec::new(
                PathBuf::from("/bin/sleep"),
                directory.path().to_path_buf(),
                vec!["30".to_owned()],
            ),
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

        for phase in TerminalPhase::ALL {
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

    /// 시험이 끝날 때까지 살아 있기만 하면 되는 PTY 자식. `sleep`은 Windows에 없어
    /// `ping`의 간격을 쓴다.
    fn long_running_launch(cwd: &Path) -> LaunchSpec {
        #[cfg(unix)]
        {
            LaunchSpec::new(
                PathBuf::from("/bin/sleep"),
                cwd.to_path_buf(),
                vec!["10".to_owned()],
            )
        }
        #[cfg(windows)]
        {
            LaunchSpec::new(
                PathBuf::from("ping"),
                cwd.to_path_buf(),
                vec!["-n".to_owned(), "11".to_owned(), "127.0.0.1".to_owned()],
            )
        }
    }

    #[test]
    fn remove_matching_session_only_removes_identical_instance() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let supervisor = TerminalSupervisor::new(directory.path()).expect("supervisor");
        let key1 = SessionKey::provider(ProviderId::Codex, "s-1");
        let key2 = SessionKey::provider(ProviderId::Codex, "s-2");
        let runtime1 = TerminalRuntime::spawn(
            key1.clone(),
            80,
            24,
            long_running_launch(directory.path()),
            acquire_session_lock(&supervisor.inner.lock_dir, &key1).expect("lock1"),
            None,
        )
        .expect("runtime1");
        let runtime2 = TerminalRuntime::spawn(
            key2.clone(),
            80,
            24,
            long_running_launch(directory.path()),
            acquire_session_lock(&supervisor.inner.lock_dir, &key2).expect("lock2"),
            None,
        )
        .expect("runtime2");

        let mut sessions = HashMap::new();
        sessions.insert(key1.clone(), Arc::clone(&runtime1));

        // 다른 Arc 인스턴스인 runtime2를 넘기면 삭제되지 않는다
        assert!(remove_matching_session(&mut sessions, &key1, &runtime2).is_none());
        assert!(sessions.contains_key(&key1));

        // 키가 다르면 삭제되지 않는다
        assert!(remove_matching_session(&mut sessions, &key2, &runtime1).is_none());

        // 일치하는 runtime1을 넘기면 삭제된다
        let removed = remove_matching_session(&mut sessions, &key1, &runtime1);
        assert!(removed.is_some());
        assert!(!sessions.contains_key(&key1));

        runtime1.terminate();
        runtime2.terminate();
    }
}
