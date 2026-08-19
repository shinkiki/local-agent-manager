use std::collections::HashMap;
use std::convert::Infallible;
use std::env;
use std::fs::{self, OpenOptions};
use std::future::Future;
use std::io::{Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpListener as StdTcpListener};
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread::{self, JoinHandle};
use std::time::Duration;

#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;

use crate::system_mcp::SystemMcpServer;
use crate::{
    add_doc_root, create_session_folder, delete_session_folder, inspect_local_environment,
    list_doc_roots, list_doc_tree, list_session_folders, load_agent_detail, load_artifact_detail,
    load_session_detail_with_limit, load_session_transcript_before, load_skill_detail,
    load_storage_overview, migrate_legacy_macos_credential_vault,
    prepare_account_management_storage, read_doc, read_doc_linked_file,
    read_doc_linked_file_download, remove_doc_root, save_doc, update_session_folder,
    update_session_meta, AccountSupervisor, ChatApprovalDecision, ChatEvent, ChatInputFileDownload,
    ChatProfile, ChatSettingField, ChatStartRequest, ChatSupervisor, CoreError, LinkedFileDownload,
    ProviderId, ScheduleRunListRequest, ScheduledRequestInput, ScheduledRequestListRequest,
    SchedulerSupervisor, SendChatMessageRequest, SessionCatalog, SessionListRequest,
    SessionMetaPatch, SessionStatisticsRequest, SessionTranscriptLimit,
    SessionTranscriptPageRequest, StartChatRequest, SystemAuditListRequest,
    SystemAutomationSettingsInput, SystemLanguageRequest, TerminalAccountLoginRequest,
    TerminalEvent, TerminalOpenRequest, TerminalSetupRequest, TerminalSupervisor, TranslationMenu,
    TranslationSupervisor,
};
use bytes::Bytes;
use flate2::write::GzEncoder;
use flate2::Compression;
use futures_util::{SinkExt, StreamExt};
use http_body_util::{BodyExt, Full};
use hyper::body::Incoming;
use hyper::header::{
    HeaderMap, HeaderValue, ACCEPT_ENCODING, ACCESS_CONTROL_ALLOW_HEADERS,
    ACCESS_CONTROL_ALLOW_METHODS, ACCESS_CONTROL_ALLOW_ORIGIN, ACCESS_CONTROL_EXPOSE_HEADERS,
    ACCESS_CONTROL_MAX_AGE, ACCESS_CONTROL_REQUEST_HEADERS, ACCESS_CONTROL_REQUEST_METHOD,
    CACHE_CONTROL, CONTENT_DISPOSITION, CONTENT_ENCODING, CONTENT_LENGTH, CONTENT_SECURITY_POLICY,
    CONTENT_TYPE, HOST, ORIGIN, REFERRER_POLICY, VARY, X_CONTENT_TYPE_OPTIONS,
};
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Method, Request, Response, StatusCode};
use hyper_tungstenite::{is_upgrade_request, tungstenite::Message, HyperWebsocket};
use hyper_util::rt::TokioIo;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::net::TcpListener;
use tokio::sync::oneshot;
use uuid::Uuid;

const MAX_REQUEST_BODY: usize = 20 * 1024 * 1024;
pub const DEFAULT_REMOTE_ACCESS_PORT: u16 = crate::DEFAULT_BACKEND_SERVICE_PORT;
pub const REMOTE_API_PROTOCOL_VERSION: u32 = 3;
const MIN_REMOTE_ACCESS_PORT: u16 = crate::MIN_BACKEND_SERVICE_PORT;
/// 재시작 시 이전 백엔드가 저장소 잠금을 놓을 때까지 기다리는 최대 시간.
const BACKEND_OWNERSHIP_HANDOVER_WAIT: Duration = Duration::from_secs(15);
const SETTINGS_SCHEMA_VERSION: u32 = 1;
const SETTINGS_FILE_NAME: &str = "remote-access.json";
const TAILSCALE_BACKEND_SCHEMA_VERSION: u32 = 1;
const TAILSCALE_BACKEND_FILE_NAME: &str = "tailscale-backend.json";
const LOCAL_UI_CORS_ORIGINS: &[&str] = &[
    "http://localhost:1420",
    "http://127.0.0.1:1420",
    "tauri://localhost",
    "http://tauri.localhost",
];
const LOCAL_UI_CORS_REQUEST_HEADERS: &[&str] = &[
    "accept",
    "cache-control",
    "content-type",
    "pragma",
    "x-chat-id",
    "x-file-name",
    "x-file-type",
];

type HttpResponse = Response<Full<Bytes>>;

#[derive(Clone)]
struct Config {
    port: u16,
    store_id: String,
    static_dir: PathBuf,
    app_data_dir: PathBuf,
    tailscale_host: Option<String>,
    tailscale_user: Option<String>,
    remote_write: bool,
    session_catalog: SessionCatalog,
    terminals: TerminalSupervisor,
    chats: ChatSupervisor,
    scheduler: SchedulerSupervisor,
    translations: TranslationSupervisor,
    _system_mcp: Option<Arc<SystemMcpServer>>,
}

#[derive(Debug, Clone, Copy)]
struct RequestAccess {
    remote: bool,
    writable: bool,
}

#[derive(Debug)]
struct ApiError {
    status: StatusCode,
    message: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AccessStatus<'a> {
    protocol_version: u32,
    store_id: &'a str,
    backend_port: u16,
    mode: &'a str,
    remote: bool,
    writable: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RemoteAccessPhase {
    Disabled,
    Starting,
    Running,
    TailscaleUnavailable,
    Conflict,
    Error,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteAccessStatus {
    pub phase: RemoteAccessPhase,
    pub enabled: bool,
    pub configured_port: u16,
    pub active_port: Option<u16>,
    pub url: Option<String>,
    pub login: Option<String>,
    pub listener_active: bool,
    pub serve_configured: bool,
    pub serve_target: Option<String>,
    pub conflict_target: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteAccessSettingsInput {
    pub enabled: bool,
    pub port: u16,
    #[serde(default)]
    pub full_access_acknowledged: bool,
    #[serde(default)]
    pub replace_existing_serve: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredRemoteAccessSettings {
    schema_version: u32,
    enabled: bool,
    port: u16,
    managed_serve: bool,
}

impl Default for StoredRemoteAccessSettings {
    fn default() -> Self {
        Self {
            schema_version: SETTINGS_SCHEMA_VERSION,
            enabled: false,
            port: DEFAULT_REMOTE_ACCESS_PORT,
            managed_serve: false,
        }
    }
}

#[derive(Clone)]
pub struct RemoteAccessSupervisor {
    inner: Arc<RemoteAccessInner>,
}

struct RemoteAccessInner {
    app_data_dir: PathBuf,
    store_id: String,
    static_dir: PathBuf,
    session_catalog: SessionCatalog,
    terminals: TerminalSupervisor,
    chats: ChatSupervisor,
    scheduler: SchedulerSupervisor,
    translations: TranslationSupervisor,
    state: Mutex<RemoteAccessState>,
}

struct RemoteAccessState {
    settings: StoredRemoteAccessSettings,
    status: RemoteAccessStatus,
    running: Option<RunningServer>,
}

struct RunningServer {
    port: u16,
    host: String,
    login: String,
    shutdown: Option<oneshot::Sender<()>>,
    thread: Option<JoinHandle<()>>,
}

#[derive(Debug)]
struct TailscaleIdentity {
    executable: PathBuf,
    host: String,
    login: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "PascalCase")]
struct TailscaleStatusDocument {
    backend_state: String,
    #[serde(rename = "Self")]
    self_node: TailscaleSelfNode,
    user: HashMap<String, TailscaleUser>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "PascalCase")]
struct TailscaleSelfNode {
    #[serde(rename = "DNSName")]
    dns_name: String,
    #[serde(rename = "UserID")]
    user_id: u64,
    online: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "PascalCase")]
struct TailscaleUser {
    login_name: String,
}

impl RemoteAccessSupervisor {
    pub fn new(
        app_data_dir: PathBuf,
        static_dir: PathBuf,
        session_catalog: SessionCatalog,
        terminals: TerminalSupervisor,
        chats: ChatSupervisor,
        scheduler: SchedulerSupervisor,
        translations: TranslationSupervisor,
    ) -> Result<Self, CoreError> {
        fs::create_dir_all(&app_data_dir)?;
        let store_id = crate::load_backend_service_settings(&app_data_dir)?.store_id;
        let settings = load_remote_settings(&app_data_dir)?;
        let status = RemoteAccessStatus {
            phase: if settings.enabled {
                RemoteAccessPhase::Starting
            } else {
                RemoteAccessPhase::Disabled
            },
            enabled: settings.enabled,
            configured_port: settings.port,
            active_port: None,
            url: None,
            login: None,
            listener_active: false,
            serve_configured: false,
            serve_target: None,
            conflict_target: None,
            error: None,
        };
        Ok(Self {
            inner: Arc::new(RemoteAccessInner {
                app_data_dir,
                store_id,
                static_dir,
                session_catalog,
                terminals,
                chats,
                scheduler,
                translations,
                state: Mutex::new(RemoteAccessState {
                    settings,
                    status,
                    running: None,
                }),
            }),
        })
    }

    pub fn status(&self) -> Result<RemoteAccessStatus, CoreError> {
        Ok(self.lock_state()?.status.clone())
    }

    pub fn start_saved(&self) -> Result<RemoteAccessStatus, CoreError> {
        let (enabled, port) = {
            let state = self.lock_state()?;
            (state.settings.enabled, state.settings.port)
        };
        if !enabled {
            return self.status();
        }
        self.enable(port, false, true)
    }

    pub fn set_settings(
        &self,
        input: RemoteAccessSettingsInput,
    ) -> Result<RemoteAccessStatus, CoreError> {
        validate_remote_port(input.port)?;
        if !input.enabled {
            return self.disable(input.port);
        }
        if !input.full_access_acknowledged {
            return Err(CoreError::InvalidInput(
                "원격 채팅·터미널·변경 기능 사용 확인이 필요합니다".to_owned(),
            ));
        }
        self.enable(input.port, input.replace_existing_serve, false)
    }

    fn enable(
        &self,
        port: u16,
        replace_existing_serve: bool,
        startup: bool,
    ) -> Result<RemoteAccessStatus, CoreError> {
        validate_remote_port(port)?;
        self.update_status(|status| {
            status.phase = RemoteAccessPhase::Starting;
            status.enabled = true;
            status.configured_port = port;
            status.error = None;
            status.conflict_target = None;
        })?;

        let identity = match detect_tailscale_identity() {
            Ok(identity) => identity,
            Err(error) => {
                return self.operational_failure(
                    RemoteAccessPhase::TailscaleUnavailable,
                    port,
                    error.to_string(),
                    None,
                    None,
                )
            }
        };
        let static_dir = match validate_static_dir(&self.inner.static_dir) {
            Ok(path) => path,
            Err(error) => {
                return self.operational_failure(
                    RemoteAccessPhase::Error,
                    port,
                    error.to_string(),
                    Some(&identity),
                    None,
                )
            }
        };
        let target = serve_target(port);
        let existing_target = match read_serve_target(&identity) {
            Ok(target) => target,
            Err(error) => {
                return self.operational_failure(
                    RemoteAccessPhase::TailscaleUnavailable,
                    port,
                    error.to_string(),
                    Some(&identity),
                    None,
                )
            }
        };

        let (old_target, old_managed, reuse_running) = {
            let state = self.lock_state()?;
            let old_target = state
                .running
                .as_ref()
                .map(|running| serve_target(running.port));
            let reuse_running = state.running.as_ref().is_some_and(|running| {
                running.port == port
                    && running.host == identity.host
                    && running.login == identity.login
            });
            (old_target, state.settings.managed_serve, reuse_running)
        };

        if let Some(existing) = existing_target.as_deref() {
            let replacing_managed_old = old_managed && old_target.as_deref() == Some(existing);
            if existing != target && !replacing_managed_old && !replace_existing_serve {
                return self.operational_failure(
                    RemoteAccessPhase::Conflict,
                    port,
                    "다른 서비스가 Tailscale Serve 루트 경로를 사용하고 있습니다".to_owned(),
                    Some(&identity),
                    Some(existing.to_owned()),
                );
            }
        }

        let mut candidate = if reuse_running {
            None
        } else {
            match spawn_remote_server(Config {
                port,
                store_id: self.inner.store_id.clone(),
                static_dir,
                app_data_dir: self.inner.app_data_dir.clone(),
                tailscale_host: Some(identity.host.clone()),
                tailscale_user: Some(identity.login.clone()),
                remote_write: true,
                session_catalog: self.inner.session_catalog.clone(),
                terminals: self.inner.terminals.clone(),
                chats: self.inner.chats.clone(),
                scheduler: self.inner.scheduler.clone(),
                translations: self.inner.translations.clone(),
                _system_mcp: None,
            }) {
                Ok(server) => Some(server),
                Err(error) => {
                    return self.operational_failure(
                        RemoteAccessPhase::Conflict,
                        port,
                        error.to_string(),
                        Some(&identity),
                        None,
                    )
                }
            }
        };

        if let Err(error) = verify_local_access(port, &self.inner.store_id) {
            stop_running_server(&mut candidate);
            return self.operational_failure(
                RemoteAccessPhase::Error,
                port,
                error.to_string(),
                Some(&identity),
                None,
            );
        }

        let changed_serve = existing_target.as_deref() != Some(target.as_str());
        if changed_serve {
            let configure_result = configure_serve(&identity, &target, !startup);
            if let Err(error) = configure_result {
                stop_running_server(&mut candidate);
                return self.operational_failure(
                    RemoteAccessPhase::Error,
                    port,
                    error.to_string(),
                    Some(&identity),
                    None,
                );
            }
            match read_serve_target(&identity) {
                Ok(Some(verified)) if verified == target => {}
                Ok(other) => {
                    rollback_serve(&identity, existing_target.as_deref());
                    stop_running_server(&mut candidate);
                    return self.operational_failure(
                        RemoteAccessPhase::Error,
                        port,
                        format!(
                            "Tailscale Serve 대상 검증에 실패했습니다: {}",
                            other.as_deref().unwrap_or("설정 없음")
                        ),
                        Some(&identity),
                        None,
                    );
                }
                Err(error) => {
                    rollback_serve(&identity, existing_target.as_deref());
                    stop_running_server(&mut candidate);
                    return self.operational_failure(
                        RemoteAccessPhase::Error,
                        port,
                        error.to_string(),
                        Some(&identity),
                        None,
                    );
                }
            }
        }

        let mut state = self.lock_state()?;
        let previous_settings = state.settings.clone();
        state.settings.enabled = true;
        state.settings.port = port;
        state.settings.managed_serve = if changed_serve {
            true
        } else {
            state.settings.managed_serve
        };
        if let Err(error) = save_remote_settings(&self.inner.app_data_dir, &state.settings) {
            state.settings = previous_settings;
            drop(state);
            if changed_serve {
                rollback_serve(&identity, existing_target.as_deref());
            }
            stop_running_server(&mut candidate);
            return self.operational_failure(
                RemoteAccessPhase::Error,
                port,
                error.to_string(),
                Some(&identity),
                None,
            );
        }
        if let Some(server) = candidate {
            let mut old = state.running.replace(server);
            stop_running_server(&mut old);
        }
        state.status = running_status(&state.settings, &identity, &target);
        Ok(state.status.clone())
    }

    fn disable(&self, port: u16) -> Result<RemoteAccessStatus, CoreError> {
        let (managed_serve, managed_target) = {
            let state = self.lock_state()?;
            (
                state.settings.managed_serve,
                state
                    .running
                    .as_ref()
                    .map(|running| serve_target(running.port))
                    .unwrap_or_else(|| serve_target(state.settings.port)),
            )
        };
        let mut cleanup_error = None;
        let mut keep_managed = managed_serve;
        if managed_serve {
            match detect_tailscale_identity().and_then(|identity| {
                let existing = read_serve_target(&identity)?;
                if existing.as_deref() == Some(managed_target.as_str()) {
                    disable_serve(&identity)?;
                }
                Ok(())
            }) {
                Ok(()) => keep_managed = false,
                Err(error) => cleanup_error = Some(error.to_string()),
            }
        }

        let mut state = self.lock_state()?;
        stop_running_server(&mut state.running);
        state.settings.enabled = false;
        state.settings.port = port;
        state.settings.managed_serve = keep_managed;
        save_remote_settings(&self.inner.app_data_dir, &state.settings)?;
        state.status = RemoteAccessStatus {
            phase: RemoteAccessPhase::Disabled,
            enabled: false,
            configured_port: port,
            active_port: None,
            url: None,
            login: None,
            listener_active: false,
            serve_configured: keep_managed,
            serve_target: keep_managed.then_some(managed_target),
            conflict_target: None,
            error: cleanup_error,
        };
        Ok(state.status.clone())
    }

    fn operational_failure(
        &self,
        phase: RemoteAccessPhase,
        port: u16,
        error: String,
        identity: Option<&TailscaleIdentity>,
        conflict_target: Option<String>,
    ) -> Result<RemoteAccessStatus, CoreError> {
        self.update_status(|status| {
            status.phase = phase;
            status.enabled = true;
            status.configured_port = port;
            status.url = identity.map(|value| format!("https://{}", value.host));
            status.login = identity.map(|value| value.login.clone());
            status.conflict_target = conflict_target;
            status.error = Some(error);
        })
    }

    fn update_status(
        &self,
        update: impl FnOnce(&mut RemoteAccessStatus),
    ) -> Result<RemoteAccessStatus, CoreError> {
        let mut state = self.lock_state()?;
        update(&mut state.status);
        Ok(state.status.clone())
    }

    fn lock_state(&self) -> Result<MutexGuard<'_, RemoteAccessState>, CoreError> {
        self.inner
            .state
            .lock()
            .map_err(|_| CoreError::Runtime("원격 접속 상태 잠금이 손상되었습니다".to_owned()))
    }
}

impl Drop for RemoteAccessInner {
    fn drop(&mut self) {
        if let Ok(state) = self.state.get_mut() {
            stop_running_server(&mut state.running);
        }
    }
}

fn validate_remote_port(port: u16) -> Result<(), CoreError> {
    if port < MIN_REMOTE_ACCESS_PORT {
        return Err(CoreError::InvalidInput(format!(
            "원격 접속 포트는 {MIN_REMOTE_ACCESS_PORT}~65535 범위여야 합니다"
        )));
    }
    Ok(())
}

fn running_status(
    settings: &StoredRemoteAccessSettings,
    identity: &TailscaleIdentity,
    target: &str,
) -> RemoteAccessStatus {
    RemoteAccessStatus {
        phase: RemoteAccessPhase::Running,
        enabled: true,
        configured_port: settings.port,
        active_port: Some(settings.port),
        url: Some(format!("https://{}", identity.host)),
        login: Some(identity.login.clone()),
        listener_active: true,
        serve_configured: true,
        serve_target: Some(target.to_owned()),
        conflict_target: None,
        error: None,
    }
}

fn load_remote_settings(app_data_dir: &Path) -> Result<StoredRemoteAccessSettings, CoreError> {
    let path = app_data_dir.join(SETTINGS_FILE_NAME);
    if !path.is_file() {
        return Ok(StoredRemoteAccessSettings::default());
    }
    let settings: StoredRemoteAccessSettings = serde_json::from_slice(&fs::read(path)?)?;
    validate_remote_port(settings.port)?;
    Ok(settings)
}

fn save_remote_settings(
    app_data_dir: &Path,
    settings: &StoredRemoteAccessSettings,
) -> Result<(), CoreError> {
    fs::create_dir_all(app_data_dir)?;
    let path = app_data_dir.join(SETTINGS_FILE_NAME);
    let temporary = app_data_dir.join(format!(".{SETTINGS_FILE_NAME}.{}.tmp", Uuid::new_v4()));
    fs::write(&temporary, serde_json::to_vec_pretty(settings)?)?;
    if let Err(error) = fs::rename(&temporary, &path) {
        let _ = fs::remove_file(&temporary);
        return Err(error.into());
    }
    Ok(())
}

fn validate_static_dir(static_dir: &Path) -> Result<PathBuf, CoreError> {
    let path = fs::canonicalize(static_dir).map_err(|error| {
        CoreError::NotFound(format!("원격 화면 리소스를 열 수 없습니다: {error}"))
    })?;
    if !path.join("index.html").is_file() {
        return Err(CoreError::NotFound(
            "원격 화면 리소스에 index.html이 없습니다".to_owned(),
        ));
    }
    Ok(path)
}

fn serve_target(port: u16) -> String {
    format!("http://127.0.0.1:{port}")
}

fn detect_tailscale_identity() -> Result<TailscaleIdentity, CoreError> {
    let executable = crate::providers::resolve_named_executable(&["tailscale"])?;
    let output = command_output(&executable, &["status", "--json"])?;
    parse_tailscale_identity(executable, &output.stdout)
}

fn parse_tailscale_identity(
    executable: PathBuf,
    json: &[u8],
) -> Result<TailscaleIdentity, CoreError> {
    let document: TailscaleStatusDocument = serde_json::from_slice(json)?;
    if document.backend_state != "Running" || !document.self_node.online {
        return Err(CoreError::Runtime(
            "Tailscale이 로그인된 온라인 상태가 아닙니다".to_owned(),
        ));
    }
    let host = document.self_node.dns_name.trim_end_matches('.').to_owned();
    validate_tailscale_host(&host).map_err(CoreError::InvalidInput)?;
    let login = document
        .user
        .get(&document.self_node.user_id.to_string())
        .map(|user| user.login_name.trim())
        .filter(|login| !login.is_empty())
        .ok_or_else(|| CoreError::Runtime("현재 Tailscale 로그인을 확인할 수 없습니다".to_owned()))?
        .to_owned();
    Ok(TailscaleIdentity {
        executable,
        host,
        login,
    })
}

fn read_serve_target(identity: &TailscaleIdentity) -> Result<Option<String>, CoreError> {
    let output = command_output(&identity.executable, &["serve", "status", "--json"])?;
    parse_serve_target(&identity.host, &output.stdout)
}

fn parse_serve_target(host: &str, json: &[u8]) -> Result<Option<String>, CoreError> {
    let value: Value = serde_json::from_slice(json)?;
    Ok(value
        .get("Web")
        .and_then(|web| web.get(format!("{host}:443")))
        .and_then(|entry| entry.get("Handlers"))
        .and_then(|handlers| handlers.get("/"))
        .and_then(|handler| handler.get("Proxy"))
        .and_then(Value::as_str)
        .map(ToOwned::to_owned))
}

fn configure_serve(
    identity: &TailscaleIdentity,
    target: &str,
    allow_elevation: bool,
) -> Result<(), CoreError> {
    let args = [
        "serve",
        "--bg",
        "--yes",
        "--https=443",
        "--set-path=/",
        target,
    ];
    run_serve_command(&identity.executable, &args, allow_elevation)
}

fn disable_serve(identity: &TailscaleIdentity) -> Result<(), CoreError> {
    let args = ["serve", "--https=443", "--set-path=/", "off"];
    run_serve_command(&identity.executable, &args, true)
}

fn rollback_serve(identity: &TailscaleIdentity, previous_target: Option<&str>) {
    let result = match previous_target {
        Some(target) => configure_serve(identity, target, true),
        None => disable_serve(identity),
    };
    if let Err(error) = result {
        eprintln!("Tailscale Serve rollback failed: {error}");
    }
}

/// Tailscale Serve 루트 경로가 이 백엔드 서비스 포트를 가리키는지로 원격
/// 서비스의 on/off 상태를 판정한다. 별도 서버를 띄우지 않고 단일 백엔드를
/// 그대로 노출하므로 상태는 항상 `tailscale serve status`에서 다시 읽는다.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TailscaleServiceStatus {
    pub available: bool,
    pub enabled: bool,
    pub host: Option<String>,
    pub login: Option<String>,
    pub url: Option<String>,
    pub service_port: u16,
    pub serve_target: Option<String>,
    pub conflict_target: Option<String>,
    /// 이 백엔드가 Tailscale 프록시 요청을 수락하도록 실행됐는지. 꺼져 있으면
    /// Serve를 켜도 원격 요청은 403으로 거부된다.
    pub remote_accepted: bool,
    pub remote_write: bool,
    pub error: Option<String>,
}

/// 실행 중인 백엔드가 노출하는 서비스 종단점. Tailscale Serve 대상과 원격
/// 수락 여부를 저장된 설정이 아닌 현재 프로세스 인자에서 읽기 위해 쓴다.
#[derive(Debug, Clone)]
pub struct ServiceEndpoint {
    pub port: u16,
    pub tailscale_host: Option<String>,
    pub remote_write: bool,
}

/// Verified non-secret Tailscale identity used by the desktop shell when it
/// relaunches the single backend after enabling Tailscale Serve.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TailscaleBackendLaunch {
    pub host: String,
    pub login: String,
    pub remote_write: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredTailscaleBackendLaunch {
    schema_version: u32,
    port: u16,
    host: String,
    login: String,
    remote_write: bool,
}

/// Loads only an exact-port, validated launch record. Corrupt or stale records
/// are reported to the native adapter, which can safely fall back to local-only
/// startup without trusting frontend input.
pub fn load_tailscale_backend_launch(
    app_data_dir: impl AsRef<Path>,
    port: u16,
) -> Result<Option<TailscaleBackendLaunch>, CoreError> {
    validate_remote_port(port)?;
    let path = app_data_dir.as_ref().join(TAILSCALE_BACKEND_FILE_NAME);
    if !path.is_file() {
        return Ok(None);
    }
    let stored: StoredTailscaleBackendLaunch = serde_json::from_slice(&fs::read(path)?)?;
    if stored.schema_version != TAILSCALE_BACKEND_SCHEMA_VERSION {
        return Err(CoreError::InvalidInput(
            "지원하지 않는 Tailscale 백엔드 설정 버전입니다".to_owned(),
        ));
    }
    if stored.port != port {
        return Ok(None);
    }
    validate_tailscale_host(&stored.host).map_err(CoreError::InvalidInput)?;
    validate_tailscale_login(&stored.login)?;
    Ok(Some(TailscaleBackendLaunch {
        host: stored.host,
        login: stored.login,
        remote_write: stored.remote_write,
    }))
}

fn validate_tailscale_login(login: &str) -> Result<(), CoreError> {
    if login.trim().is_empty() || login.len() > 320 {
        return Err(CoreError::InvalidInput(
            "잘못된 Tailscale 사용자 로그인입니다".to_owned(),
        ));
    }
    Ok(())
}

fn save_tailscale_backend_launch(
    app_data_dir: &Path,
    port: u16,
    identity: &TailscaleIdentity,
) -> Result<(), CoreError> {
    validate_remote_port(port)?;
    validate_tailscale_host(&identity.host).map_err(CoreError::InvalidInput)?;
    validate_tailscale_login(&identity.login)?;
    fs::create_dir_all(app_data_dir)?;
    let path = app_data_dir.join(TAILSCALE_BACKEND_FILE_NAME);
    let temporary = app_data_dir.join(format!(
        ".{TAILSCALE_BACKEND_FILE_NAME}.{}.tmp",
        Uuid::new_v4()
    ));
    let stored = StoredTailscaleBackendLaunch {
        schema_version: TAILSCALE_BACKEND_SCHEMA_VERSION,
        port,
        host: identity.host.clone(),
        login: identity.login.clone(),
        remote_write: true,
    };
    let mut bytes = serde_json::to_vec_pretty(&stored)?;
    bytes.push(b'\n');
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o600);
    let mut file = options.open(&temporary)?;
    if let Err(error) = file.write_all(&bytes).and_then(|()| file.sync_all()) {
        let _ = fs::remove_file(&temporary);
        return Err(error.into());
    }
    drop(file);
    if let Err(error) = replace_tailscale_backend_file(&temporary, &path) {
        let _ = fs::remove_file(&temporary);
        return Err(error);
    }
    Ok(())
}

#[cfg(not(windows))]
fn replace_tailscale_backend_file(temporary: &Path, destination: &Path) -> Result<(), CoreError> {
    fs::rename(temporary, destination)?;
    Ok(())
}

#[cfg(windows)]
fn replace_tailscale_backend_file(temporary: &Path, destination: &Path) -> Result<(), CoreError> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let source = temporary
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let target = destination
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let result = unsafe {
        MoveFileExW(
            source.as_ptr(),
            target.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if result == 0 {
        Err(CoreError::Io(std::io::Error::last_os_error()))
    } else {
        Ok(())
    }
}

fn clear_tailscale_backend_launch(app_data_dir: &Path) -> Result<(), CoreError> {
    let path = app_data_dir.join(TAILSCALE_BACKEND_FILE_NAME);
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

fn unavailable_tailscale_service(
    service: &ServiceEndpoint,
    error: String,
) -> TailscaleServiceStatus {
    TailscaleServiceStatus {
        available: false,
        enabled: false,
        host: None,
        login: None,
        url: None,
        service_port: service.port,
        serve_target: None,
        conflict_target: None,
        remote_accepted: service.tailscale_host.is_some(),
        remote_write: service.remote_write,
        error: Some(error),
    }
}

pub(crate) fn tailscale_service_status(service: &ServiceEndpoint) -> TailscaleServiceStatus {
    let identity = match detect_tailscale_identity() {
        Ok(identity) => identity,
        Err(error) => return unavailable_tailscale_service(service, error.to_string()),
    };
    let target = serve_target(service.port);
    let existing = match read_serve_target(&identity) {
        Ok(existing) => existing,
        Err(error) => {
            let mut status = unavailable_tailscale_service(service, error.to_string());
            status.available = true;
            status.host = Some(identity.host.clone());
            status.login = Some(identity.login);
            return status;
        }
    };
    let enabled = existing.as_deref() == Some(target.as_str());
    TailscaleServiceStatus {
        available: true,
        enabled,
        host: Some(identity.host.clone()),
        login: Some(identity.login),
        url: enabled.then(|| format!("https://{}", identity.host)),
        service_port: service.port,
        serve_target: existing.clone(),
        conflict_target: if enabled { None } else { existing },
        remote_accepted: service.tailscale_host.is_some(),
        remote_write: service.remote_write,
        error: None,
    }
}

pub(crate) fn set_tailscale_service(
    app_data_dir: &Path,
    service: &ServiceEndpoint,
    enabled: bool,
    replace_existing: bool,
) -> Result<TailscaleServiceStatus, CoreError> {
    let identity = detect_tailscale_identity()?;
    let target = serve_target(service.port);
    let existing = read_serve_target(&identity)?;
    if enabled {
        if existing.as_deref() == Some(target.as_str()) {
            save_tailscale_backend_launch(app_data_dir, service.port, &identity)?;
            return Ok(tailscale_service_status(service));
        }
        if existing.is_some() && !replace_existing {
            return Err(CoreError::Conflict(
                "다른 서비스가 Tailscale Serve 루트 경로를 사용하고 있습니다".to_owned(),
            ));
        }
        configure_serve(&identity, &target, true)?;
        // Serve 설정은 실패해도 종료 코드가 0인 경우가 있어 대상을 다시 읽어 확인한다.
        match read_serve_target(&identity)? {
            Some(verified) if verified == target => {}
            other => {
                rollback_serve(&identity, existing.as_deref());
                return Err(CoreError::Runtime(format!(
                    "Tailscale Serve 대상 검증에 실패했습니다: {}",
                    other.as_deref().unwrap_or("설정 없음")
                )));
            }
        }
        if let Err(error) = save_tailscale_backend_launch(app_data_dir, service.port, &identity) {
            rollback_serve(&identity, existing.as_deref());
            return Err(error);
        }
    } else {
        match existing.as_deref() {
            None => {
                clear_tailscale_backend_launch(app_data_dir)?;
                return Ok(tailscale_service_status(service));
            }
            Some(current) if current == target => {
                disable_serve(&identity)?;
                if let Err(error) = clear_tailscale_backend_launch(app_data_dir) {
                    let _ = configure_serve(&identity, &target, true);
                    return Err(error);
                }
            }
            Some(_) => {
                clear_tailscale_backend_launch(app_data_dir)?;
                return Err(CoreError::Conflict(
                    "Agent Manager가 설정하지 않은 Tailscale Serve 경로여서 끄지 않았습니다"
                        .to_owned(),
                ));
            }
        }
    }
    Ok(tailscale_service_status(service))
}

fn command_output(executable: &Path, args: &[&str]) -> Result<Output, CoreError> {
    let output = Command::new(executable).args(args).output()?;
    if output.status.success() {
        return Ok(output);
    }
    Err(CoreError::Runtime(command_failure_message(&output)))
}

fn command_failure_message(output: &Output) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    let detail = if !stderr.is_empty() { stderr } else { stdout };
    if detail.is_empty() {
        format!(
            "Tailscale 명령이 종료 코드 {:?}로 실패했습니다",
            output.status.code()
        )
    } else {
        let detail = detail.chars().take(2_000).collect::<String>();
        format!("Tailscale 명령이 실패했습니다: {detail}")
    }
}

#[cfg(not(windows))]
fn run_serve_command(
    executable: &Path,
    args: &[&str],
    _allow_elevation: bool,
) -> Result<(), CoreError> {
    command_output(executable, args).map(|_| ())
}

#[cfg(windows)]
fn run_serve_command(
    executable: &Path,
    args: &[&str],
    allow_elevation: bool,
) -> Result<(), CoreError> {
    match command_output(executable, args) {
        Ok(_) => Ok(()),
        Err(error) if allow_elevation => run_elevated_windows(executable, args),
        Err(error) => Err(error),
    }
}

#[cfg(windows)]
fn run_elevated_windows(executable: &Path, args: &[&str]) -> Result<(), CoreError> {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::{CloseHandle, WAIT_OBJECT_0};
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, WaitForSingleObject, INFINITE,
    };
    use windows_sys::Win32::UI::Shell::{
        ShellExecuteExW, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW,
    };

    if args.iter().any(|arg| arg.chars().any(char::is_whitespace)) {
        return Err(CoreError::InvalidInput(
            "관리자 권한 Tailscale 인자에는 공백을 사용할 수 없습니다".to_owned(),
        ));
    }
    let verb = wide_string(OsStr::new("runas"));
    let file = wide_string(executable.as_os_str());
    let parameters = wide_string(OsStr::new(&args.join(" ")));
    let mut info = SHELLEXECUTEINFOW {
        cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
        fMask: SEE_MASK_NOCLOSEPROCESS,
        lpVerb: verb.as_ptr(),
        lpFile: file.as_ptr(),
        lpParameters: parameters.as_ptr(),
        nShow: 0,
        ..Default::default()
    };
    if unsafe { ShellExecuteExW(&mut info) } == 0 || info.hProcess.is_null() {
        return Err(CoreError::Runtime(
            "Windows 관리자 권한 요청이 취소되었거나 시작되지 않았습니다".to_owned(),
        ));
    }
    let wait = unsafe { WaitForSingleObject(info.hProcess, INFINITE) };
    if wait != WAIT_OBJECT_0 {
        unsafe { CloseHandle(info.hProcess) };
        return Err(CoreError::Runtime(
            "관리자 권한 Tailscale 명령 대기에 실패했습니다".to_owned(),
        ));
    }
    let mut exit_code = 1u32;
    let result = unsafe { GetExitCodeProcess(info.hProcess, &mut exit_code) };
    unsafe { CloseHandle(info.hProcess) };
    if result == 0 || exit_code != 0 {
        return Err(CoreError::Runtime(format!(
            "관리자 권한 Tailscale 명령이 종료 코드 {exit_code}로 실패했습니다"
        )));
    }
    Ok(())
}

#[cfg(windows)]
fn wide_string(value: &std::ffi::OsStr) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    value.encode_wide().chain(std::iter::once(0)).collect()
}

fn spawn_remote_server(config: Config) -> Result<RunningServer, CoreError> {
    let port = config.port;
    let host = config.tailscale_host.clone().ok_or_else(|| {
        CoreError::InvalidInput("원격 서버 Tailscale 호스트가 없습니다".to_owned())
    })?;
    let login = config.tailscale_user.clone().ok_or_else(|| {
        CoreError::InvalidInput("원격 서버 Tailscale 로그인이 없습니다".to_owned())
    })?;
    let address = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    let listener = StdTcpListener::bind(address).map_err(|error| {
        CoreError::Conflict(format!("127.0.0.1:{port} 포트를 열 수 없습니다: {error}"))
    })?;
    listener.set_nonblocking(true)?;
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(|error| {
            CoreError::Runtime(format!("원격 서버 런타임을 만들 수 없습니다: {error}"))
        })?;
    let config = Arc::new(config);
    let (shutdown_sender, shutdown_receiver) = oneshot::channel();
    let thread = thread::Builder::new()
        .name(format!("agent-manager-remote-{port}"))
        .spawn(move || {
            runtime.block_on(async move {
                match TcpListener::from_std(listener) {
                    Ok(listener) => {
                        let shutdown = async move {
                            let _ = shutdown_receiver.await;
                        };
                        if let Err(error) = serve_loop(listener, config, shutdown).await {
                            eprintln!("Agent Manager remote server stopped: {error}");
                        }
                    }
                    Err(error) => eprintln!("Agent Manager remote listener failed: {error}"),
                }
            });
        })
        .map_err(|error| {
            CoreError::Runtime(format!("원격 서버 스레드를 시작할 수 없습니다: {error}"))
        })?;
    Ok(RunningServer {
        port,
        host,
        login,
        shutdown: Some(shutdown_sender),
        thread: Some(thread),
    })
}

fn verify_local_access(port: u16, expected_store_id: &str) -> Result<(), CoreError> {
    let address = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    let mut last_error = None;
    for _ in 0..20 {
        match std::net::TcpStream::connect_timeout(&address, Duration::from_millis(150)) {
            Ok(mut stream) => {
                stream.set_read_timeout(Some(Duration::from_secs(1)))?;
                stream.set_write_timeout(Some(Duration::from_secs(1)))?;
                stream.write_all(
                    b"GET /api/access HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n",
                )?;
                let mut response = Vec::new();
                stream.read_to_end(&mut response)?;
                let text = String::from_utf8_lossy(&response);
                let protocol_marker = format!("\"protocolVersion\":{REMOTE_API_PROTOCOL_VERSION}");
                let store_marker = format!("\"storeId\":\"{expected_store_id}\"");
                if text.starts_with("HTTP/1.1 200")
                    && text.contains(&protocol_marker)
                    && text.contains(&store_marker)
                    && text.contains("\"writable\":true")
                {
                    return Ok(());
                }
                last_error = Some("원격 서버 상태 응답이 올바르지 않습니다".to_owned());
            }
            Err(error) => last_error = Some(error.to_string()),
        }
        thread::sleep(Duration::from_millis(25));
    }
    Err(CoreError::Runtime(format!(
        "127.0.0.1:{port} 원격 서버 검증에 실패했습니다: {}",
        last_error.unwrap_or_else(|| "응답 없음".to_owned())
    )))
}

fn stop_running_server(server: &mut Option<RunningServer>) {
    if let Some(mut server) = server.take() {
        if let Some(shutdown) = server.shutdown.take() {
            let _ = shutdown.send(());
        }
        if let Some(thread) = server.thread.take() {
            let _ = thread.join();
        }
    }
}

async fn serve_loop<F>(
    listener: TcpListener,
    config: Arc<Config>,
    shutdown: F,
) -> Result<(), std::io::Error>
where
    F: Future<Output = ()> + Send,
{
    tokio::pin!(shutdown);
    loop {
        tokio::select! {
            _ = &mut shutdown => return Ok(()),
            accepted = listener.accept() => {
                let (stream, _) = accepted?;
                let io = TokioIo::new(stream);
                let config = Arc::clone(&config);
                tokio::spawn(async move {
                    let service = service_fn(move |request| handle_request(request, Arc::clone(&config)));
                    if let Err(error) = http1::Builder::new()
                        .serve_connection(io, service)
                        .with_upgrades()
                        .await
                    {
                        eprintln!("HTTP connection error: {error}");
                    }
                });
            }
        }
    }
}

pub fn run_remote_server_from_args(
    args: impl Iterator<Item = String>,
) -> Result<(), Box<dyn std::error::Error>> {
    let args = args.collect::<Vec<_>>();
    if args.first().map(String::as_str) == Some("migrate-keychain-v2") {
        let app_data_dir = migration_app_data_dir(args.into_iter().skip(1))?;
        let ownership = crate::BackendOwnershipLease::acquire(&app_data_dir)?;
        let migrated = migrate_legacy_macos_credential_vault(&app_data_dir)?;
        drop(ownership);
        println!("v2 Keychain Vault에서 계정 {migrated}개를 v3로 마이그레이션했습니다.");
        return Ok(());
    }
    let options = StandaloneServerOptions::from_args(args.into_iter())?;
    let shutdown_on_stdin_eof = options.shutdown_on_stdin_eof;
    let address = SocketAddr::from((Ipv4Addr::LOCALHOST, options.port));
    let listener = StdTcpListener::bind(address).map_err(|error| {
        CoreError::Conflict(format!(
            "127.0.0.1:{} 포트를 열 수 없습니다: {error}",
            options.port
        ))
    })?;
    listener.set_nonblocking(true)?;
    // 데스크톱 재시작은 이전 백엔드가 종료되기 전에 새 백엔드를 띄우므로, 셸이
    // 인계를 요청한 경우에만 소유권을 잠시 기다렸다가 넘겨받는다. 외부에서 직접
    // 띄운 백엔드는 그대로 즉시 거부된다.
    let ownership = crate::BackendOwnershipLease::acquire_with_retry(
        &options.app_data_dir,
        if options.await_store_handover {
            BACKEND_OWNERSHIP_HANDOVER_WAIT
        } else {
            Duration::ZERO
        },
    )?;
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;
    let config = Arc::new(Config::open_standalone(options, &ownership)?);
    let result = runtime.block_on(async move {
        let listener = TcpListener::from_std(listener)?;

        println!(
            "Agent Manager remote adapter: http://{} (static={}, remote={}, writable={})",
            address,
            config.static_dir.display(),
            config.tailscale_host.as_deref().unwrap_or("disabled"),
            config.remote_write,
        );

        let shutdown = standalone_shutdown(shutdown_on_stdin_eof);
        serve_loop(listener, config, shutdown).await
    });
    // 연결 task와 그 Config clone을 먼저 내린 뒤 ownership을 해제해 새 백엔드가
    // 이전 task의 종료와 겹쳐 같은 저장소를 열 수 있는 틈을 만들지 않는다.
    drop(runtime);
    drop(ownership);
    Ok(result?)
}

async fn standalone_shutdown(shutdown_on_stdin_eof: bool) {
    if !shutdown_on_stdin_eof {
        std::future::pending::<()>().await;
        return;
    }
    // Tauri 부모가 보유한 piped stdin이 닫히면 child 백엔드도 정상 종료한다.
    // 독립 std thread를 사용해 Tokio runtime 종료가 블로킹 stdin task를 기다리며
    // 멈추지 않게 하고, EOF 결과만 oneshot으로 shutdown future에 전달한다.
    let (eof_sender, eof_receiver) = oneshot::channel();
    let watcher = thread::Builder::new()
        .name("agent-manager-parent-stdin".to_owned())
        .spawn(move || {
            let stdin = std::io::stdin();
            let _ = wait_for_reader_eof(stdin.lock());
            let _ = eof_sender.send(());
        });
    if let Err(error) = watcher {
        eprintln!("부모 프로세스 stdin 감시를 시작하지 못했습니다: {error}");
        return;
    }
    let _ = eof_receiver.await;
}

fn wait_for_reader_eof(mut reader: impl Read) -> std::io::Result<()> {
    let mut buffer = [0_u8; 256];
    loop {
        match reader.read(&mut buffer)? {
            0 => return Ok(()),
            _ => continue,
        }
    }
}

fn migration_app_data_dir(mut args: impl Iterator<Item = String>) -> Result<PathBuf, String> {
    let mut app_data_dir = default_app_data_dir()?;
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--app-data-dir" => {
                app_data_dir = PathBuf::from(required_value(&mut args, "--app-data-dir")?);
            }
            "-h" | "--help" => {
                println!("Usage: agent-manager-server migrate-keychain-v2 [--app-data-dir PATH]");
                std::process::exit(0);
            }
            _ => return Err(format!("알 수 없는 마이그레이션 인자입니다: {arg}")),
        }
    }
    Ok(app_data_dir)
}

struct StandaloneServerOptions {
    port: u16,
    static_dir: PathBuf,
    app_data_dir: PathBuf,
    tailscale_host: Option<String>,
    tailscale_user: Option<String>,
    remote_write: bool,
    shutdown_on_stdin_eof: bool,
    await_store_handover: bool,
}

impl StandaloneServerOptions {
    fn from_args(mut args: impl Iterator<Item = String>) -> Result<Self, String> {
        let mut port = DEFAULT_REMOTE_ACCESS_PORT;
        let mut static_dir = PathBuf::from("dist");
        let mut app_data_dir = default_app_data_dir()?;
        let mut tailscale_host = None;
        let mut tailscale_user = None;
        let mut remote_write = false;
        let mut shutdown_on_stdin_eof = false;
        let mut await_store_handover = false;
        while let Some(arg) = args.next() {
            match arg.as_str() {
                "--port" => {
                    let value = required_value(&mut args, "--port")?;
                    port = value
                        .parse::<u16>()
                        .ok()
                        .filter(|value| {
                            (crate::MIN_BACKEND_SERVICE_PORT..=crate::MAX_BACKEND_SERVICE_PORT)
                                .contains(value)
                        })
                        .ok_or_else(|| {
                            format!(
                                "--port는 {}~{} 범위여야 합니다",
                                crate::MIN_BACKEND_SERVICE_PORT,
                                crate::MAX_BACKEND_SERVICE_PORT
                            )
                        })?;
                }
                "--static-dir" => {
                    static_dir = PathBuf::from(required_value(&mut args, "--static-dir")?);
                }
                "--app-data-dir" => {
                    app_data_dir = PathBuf::from(required_value(&mut args, "--app-data-dir")?);
                }
                "--tailscale-host" => {
                    tailscale_host = Some(required_value(&mut args, "--tailscale-host")?);
                }
                "--tailscale-user" => {
                    tailscale_user = Some(required_value(&mut args, "--tailscale-user")?);
                }
                "--remote-write" => remote_write = true,
                "--shutdown-on-stdin-eof" => shutdown_on_stdin_eof = true,
                "--await-store-handover" => await_store_handover = true,
                "-h" | "--help" => {
                    println!(
                        "Usage: agent-manager-server [--port {DEFAULT_REMOTE_ACCESS_PORT}] [--static-dir dist] \
                         [--app-data-dir PATH] [--tailscale-host HOST --tailscale-user LOGIN] \
                         [--remote-write] [--shutdown-on-stdin-eof]"
                    );
                    std::process::exit(0);
                }
                _ => return Err(format!("알 수 없는 인자입니다: {arg}")),
            }
        }

        static_dir = fs::canonicalize(&static_dir)
            .map_err(|error| format!("정적 파일 경로를 열 수 없습니다: {error}"))?;
        if !static_dir.join("index.html").is_file() {
            return Err("정적 파일 경로에 index.html이 없습니다".to_owned());
        }
        if tailscale_host.is_some() != tailscale_user.is_some() {
            return Err(
                "원격 접속에는 --tailscale-host와 --tailscale-user가 모두 필요합니다".to_owned(),
            );
        }
        if let Some(host) = &tailscale_host {
            validate_tailscale_host(host)?;
        }
        if let Some(user) = &tailscale_user {
            if user.trim().is_empty() || user.len() > 320 {
                return Err("잘못된 Tailscale 사용자 로그인입니다".to_owned());
            }
        }

        Ok(Self {
            port,
            static_dir,
            app_data_dir,
            tailscale_host,
            tailscale_user,
            remote_write,
            shutdown_on_stdin_eof,
            await_store_handover,
        })
    }
}

impl Config {
    fn open_standalone(
        options: StandaloneServerOptions,
        ownership: &crate::BackendOwnershipLease,
    ) -> Result<Self, String> {
        let StandaloneServerOptions {
            port,
            static_dir,
            app_data_dir: _,
            tailscale_host,
            tailscale_user,
            remote_write,
            shutdown_on_stdin_eof: _,
            await_store_handover: _,
        } = options;
        let app_data_dir = ownership.app_data_dir().to_path_buf();
        let store_id = crate::load_backend_service_settings(&app_data_dir)
            .map_err(|error| error.to_string())?
            .store_id;

        prepare_account_management_storage(&app_data_dir).map_err(|error| error.to_string())?;
        let accounts = AccountSupervisor::open(&app_data_dir).map_err(|error| error.to_string())?;
        let (auto_switch_tx, auto_switch_rx) = std::sync::mpsc::channel();
        accounts.set_auto_switch_signal_sender(auto_switch_tx);
        let session_catalog =
            SessionCatalog::open(app_data_dir.clone()).map_err(|error| error.to_string())?;
        let terminals = TerminalSupervisor::with_accounts(
            &app_data_dir,
            session_catalog.clone(),
            accounts.clone(),
        )
        .map_err(|error| error.to_string())?;
        let chats = ChatSupervisor::with_accounts(app_data_dir.clone(), accounts)
            .map_err(|error| error.to_string())?;
        chats
            .set_session_catalog(session_catalog.clone())
            .map_err(|error| error.to_string())?;
        // 사용량 100% 도달·에이전트 제한 응답 트리거를 받아 자동전환이 켜진
        // 계정끼리 활성 계정을 순환시키는 백그라운드 실행기.
        crate::session_management::spawn_auto_switch_loop(
            chats.clone(),
            terminals.clone(),
            auto_switch_rx,
        );
        let scheduler = SchedulerSupervisor::new(app_data_dir.clone(), chats.clone())
            .map_err(|error| error.to_string())?;
        let translations =
            TranslationSupervisor::new(app_data_dir.clone(), session_catalog.clone())
                .map_err(|error| error.to_string())?;
        let system_mcp = Arc::new(
            SystemMcpServer::start(
                ServiceEndpoint {
                    port,
                    tailscale_host: tailscale_host.clone(),
                    remote_write,
                },
                app_data_dir.clone(),
                session_catalog.clone(),
                chats.clone(),
                terminals.clone(),
                scheduler.clone(),
                translations.clone(),
            )
            .map_err(|error| error.to_string())?,
        );
        chats
            .set_system_mcp_url(system_mcp.url().to_owned())
            .map_err(|error| error.to_string())?;

        Ok(Self {
            port,
            store_id,
            static_dir,
            app_data_dir,
            tailscale_host,
            tailscale_user,
            remote_write,
            session_catalog,
            terminals,
            chats,
            scheduler,
            translations,
            _system_mcp: Some(system_mcp),
        })
    }
}

fn required_value(args: &mut impl Iterator<Item = String>, flag: &str) -> Result<String, String> {
    args.next()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("{flag} 값이 필요합니다"))
}

fn default_app_data_dir() -> Result<PathBuf, String> {
    if cfg!(target_os = "macos") {
        return env::var_os("HOME")
            .map(PathBuf::from)
            .map(|home| home.join("Library/Application Support/com.shinc.agentmanager"))
            .ok_or_else(|| "HOME을 확인할 수 없습니다".to_owned());
    }
    if cfg!(windows) {
        return env::var_os("APPDATA")
            .map(PathBuf::from)
            .map(|root| root.join("com.shinc.agentmanager"))
            .ok_or_else(|| "APPDATA를 확인할 수 없습니다".to_owned());
    }
    linux_app_data_dir(env::var_os("XDG_DATA_HOME"), env::var_os("HOME"))
}

fn linux_app_data_dir(
    xdg_data_home: Option<std::ffi::OsString>,
    home: Option<std::ffi::OsString>,
) -> Result<PathBuf, String> {
    if let Some(root) = xdg_data_home
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
    {
        return Ok(root.join("com.shinc.agentmanager"));
    }
    home.map(PathBuf::from)
        .map(|home| home.join(".local/share/com.shinc.agentmanager"))
        .ok_or_else(|| "HOME을 확인할 수 없습니다".to_owned())
}

fn validate_tailscale_host(host: &str) -> Result<(), String> {
    if host.ends_with(".ts.net")
        && host.len() <= 253
        && host
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.'))
    {
        Ok(())
    } else {
        Err("--tailscale-host는 스킴과 경로가 없는 정확한 *.ts.net 호스트여야 합니다".to_owned())
    }
}

async fn handle_request(
    request: Request<Incoming>,
    config: Arc<Config>,
) -> Result<HttpResponse, Infallible> {
    let compress = request.method() != Method::HEAD && accepts_gzip(request.headers());
    let response = match authorize(&request, &config) {
        Ok(access) => {
            match authorize_local_api_origin(
                request.headers(),
                request.uri().path(),
                config.port,
                access,
            ) {
                Ok(()) => {
                    let cors_origin = local_ui_cors_origin(request.headers(), access, config.port)
                        .map(str::to_owned);
                    let response = route(request, config, access).await;
                    apply_local_ui_cors(response, cors_origin.as_deref())
                }
                Err(error) => error_response(error),
            }
        }
        Err(error) => error_response(error),
    };
    Ok(maybe_gzip_response(response, compress).await)
}

fn accepts_gzip(headers: &HeaderMap) -> bool {
    let Some(value) = header_text(headers, ACCEPT_ENCODING.as_str()) else {
        return false;
    };
    let mut wildcard = false;
    for item in value.split(',') {
        let mut parts = item.trim().split(';');
        let encoding = parts.next().unwrap_or_default().trim();
        let allowed = !parts.any(|parameter| {
            parameter
                .trim()
                .strip_prefix("q=")
                .and_then(|quality| quality.parse::<f32>().ok())
                .is_some_and(|quality| quality <= 0.0)
        });
        if encoding.eq_ignore_ascii_case("gzip") {
            return allowed;
        }
        if encoding == "*" {
            wildcard = allowed;
        }
    }
    wildcard
}

async fn maybe_gzip_response(response: HttpResponse, enabled: bool) -> HttpResponse {
    const MIN_GZIP_BYTES: usize = 1024;
    if !enabled || !response.status().is_success() {
        return response;
    }
    let compressible = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|content_type| {
            content_type.starts_with("text/")
                || content_type.starts_with("application/json")
                || content_type.starts_with("application/manifest+json")
                || content_type.starts_with("image/svg+xml")
        });
    if !compressible || response.headers().contains_key(CONTENT_ENCODING) {
        return response;
    }

    let (mut parts, body) = response.into_parts();
    let body = match body.collect().await {
        Ok(collected) => collected.to_bytes(),
        Err(error) => match error {},
    };
    if body.len() < MIN_GZIP_BYTES {
        return Response::from_parts(parts, Full::new(body));
    }
    let mut encoder = GzEncoder::new(Vec::new(), Compression::fast());
    if encoder.write_all(&body).is_err() {
        return Response::from_parts(parts, Full::new(body));
    }
    let Ok(compressed) = encoder.finish() else {
        return Response::from_parts(parts, Full::new(body));
    };
    if compressed.len() >= body.len() {
        return Response::from_parts(parts, Full::new(body));
    }

    parts
        .headers
        .insert(CONTENT_ENCODING, HeaderValue::from_static("gzip"));
    parts.headers.remove(CONTENT_LENGTH);
    let vary = parts
        .headers
        .get(VARY)
        .and_then(|value| value.to_str().ok())
        .map(|value| format!("{value}, Accept-Encoding"))
        .unwrap_or_else(|| "Accept-Encoding".to_owned());
    if let Ok(vary) = HeaderValue::from_str(&vary) {
        parts.headers.insert(VARY, vary);
    }
    Response::from_parts(parts, Full::new(Bytes::from(compressed)))
}

fn local_ui_cors_origin(headers: &HeaderMap, access: RequestAccess, port: u16) -> Option<&str> {
    if access.remote {
        return None;
    }
    header_text(headers, ORIGIN.as_str()).filter(|origin| is_allowed_loopback_origin(origin, port))
}

fn is_allowed_local_ui_origin(origin: &str) -> bool {
    LOCAL_UI_CORS_ORIGINS.contains(&origin)
}

fn is_allowed_loopback_origin(origin: &str, port: u16) -> bool {
    is_allowed_local_ui_origin(origin)
        || origin == format!("http://127.0.0.1:{port}")
        || origin == format!("http://localhost:{port}")
}

/// 브라우저의 same-origin 정책은 응답 읽기만 제한하므로, 상태 변경 요청 자체를
/// 막기 위해 로컬 `/api/*` 요청의 Origin을 서버 요청 경계에서도 검증한다.
/// Origin이 없는 native/CLI 클라이언트는 계속 허용한다.
fn authorize_local_api_origin(
    headers: &HeaderMap,
    path: &str,
    port: u16,
    access: RequestAccess,
) -> Result<(), ApiError> {
    if access.remote || !path.starts_with("/api/") {
        return Ok(());
    }
    let Some(origin) = headers.get(ORIGIN) else {
        return Ok(());
    };
    let origin = origin.to_str().map_err(|_| ApiError {
        status: StatusCode::FORBIDDEN,
        message: "허용되지 않은 로컬 API Origin입니다".to_owned(),
    })?;
    if is_allowed_loopback_origin(origin, port) {
        Ok(())
    } else {
        Err(ApiError {
            status: StatusCode::FORBIDDEN,
            message: "허용되지 않은 로컬 API Origin입니다".to_owned(),
        })
    }
}

fn apply_local_ui_cors(mut response: HttpResponse, origin: Option<&str>) -> HttpResponse {
    let Some(origin) = origin else {
        return response;
    };
    let Ok(origin) = HeaderValue::from_str(origin) else {
        return response;
    };
    let headers = response.headers_mut();
    headers.insert(ACCESS_CONTROL_ALLOW_ORIGIN, origin);
    headers.insert(VARY, HeaderValue::from_static("Origin"));
    headers.insert(
        ACCESS_CONTROL_EXPOSE_HEADERS,
        HeaderValue::from_static("Content-Disposition"),
    );
    response
}

fn authorize(request: &Request<Incoming>, config: &Config) -> Result<RequestAccess, ApiError> {
    let headers = request.headers();
    if let Some(login) = header_text(headers, "tailscale-user-login") {
        let expected = config.tailscale_user.as_deref().ok_or_else(|| ApiError {
            status: StatusCode::FORBIDDEN,
            message: "Tailscale 원격 접속이 활성화되지 않았습니다".to_owned(),
        })?;
        if login != expected {
            return Err(ApiError {
                status: StatusCode::FORBIDDEN,
                message: "허용되지 않은 Tailscale 사용자입니다".to_owned(),
            });
        }
        if let Some(origin) = header_text(headers, "origin") {
            let expected_origin = format!(
                "https://{}",
                config.tailscale_host.as_deref().unwrap_or_default()
            );
            if origin != expected_origin {
                return Err(ApiError {
                    status: StatusCode::FORBIDDEN,
                    message: "허용되지 않은 원격 Origin입니다".to_owned(),
                });
            }
        }
        return Ok(RequestAccess {
            remote: true,
            writable: config.remote_write,
        });
    }

    let host = header_text(headers, HOST.as_str()).unwrap_or_default();
    if is_loopback_host(host) {
        return Ok(RequestAccess {
            remote: false,
            writable: true,
        });
    }

    Err(ApiError {
        status: StatusCode::FORBIDDEN,
        message: "검증된 로컬 또는 Tailscale 요청만 허용됩니다".to_owned(),
    })
}

fn header_text<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name).and_then(|value| value.to_str().ok())
}

fn has_json_content_type(headers: &HeaderMap) -> bool {
    header_text(headers, CONTENT_TYPE.as_str())
        .and_then(|value| value.split(';').next())
        .is_some_and(|media_type| media_type.trim().eq_ignore_ascii_case("application/json"))
}

fn unsupported_json_content_type_response() -> HttpResponse {
    error_response(ApiError {
        status: StatusCode::UNSUPPORTED_MEDIA_TYPE,
        message: "이 API 요청은 Content-Type: application/json이 필요합니다".to_owned(),
    })
}

fn required_encoded_header(headers: &HeaderMap, name: &str) -> Result<String, ApiError> {
    let value = header_text(headers, name).ok_or_else(|| ApiError {
        status: StatusCode::BAD_REQUEST,
        message: format!("{name} 헤더가 없습니다"),
    })?;
    decode_header_component(value).map_err(|message| ApiError {
        status: StatusCode::BAD_REQUEST,
        message,
    })
}

fn local_ui_cors_preflight(headers: &HeaderMap, access: RequestAccess, port: u16) -> HttpResponse {
    if local_ui_cors_origin(headers, access, port).is_none() {
        return error_response(ApiError {
            status: StatusCode::FORBIDDEN,
            message: "허용되지 않은 로컬 UI Origin입니다".to_owned(),
        });
    }
    let requested_method = header_text(headers, ACCESS_CONTROL_REQUEST_METHOD.as_str());
    if !matches!(requested_method, Some("GET" | "POST")) {
        return error_response(ApiError {
            status: StatusCode::METHOD_NOT_ALLOWED,
            message: "허용되지 않은 CORS 요청 메서드입니다".to_owned(),
        });
    }
    if let Some(requested_headers) = header_text(headers, ACCESS_CONTROL_REQUEST_HEADERS.as_str()) {
        let allowed = requested_headers.split(',').all(|header| {
            let header = header.trim();
            !header.is_empty()
                && LOCAL_UI_CORS_REQUEST_HEADERS
                    .iter()
                    .any(|allowed| header.eq_ignore_ascii_case(allowed))
        });
        if !allowed {
            return error_response(ApiError {
                status: StatusCode::FORBIDDEN,
                message: "허용되지 않은 CORS 요청 헤더입니다".to_owned(),
            });
        }
    }

    let mut response = response(
        StatusCode::NO_CONTENT,
        "text/plain; charset=utf-8",
        Vec::new(),
    );
    let response_headers = response.headers_mut();
    response_headers.insert(
        ACCESS_CONTROL_ALLOW_METHODS,
        HeaderValue::from_static("GET, POST, OPTIONS"),
    );
    response_headers.insert(
        ACCESS_CONTROL_ALLOW_HEADERS,
        HeaderValue::from_static(
            "Accept, Cache-Control, Content-Type, Pragma, X-Chat-Id, X-File-Name, X-File-Type",
        ),
    );
    response_headers.insert(ACCESS_CONTROL_MAX_AGE, HeaderValue::from_static("600"));
    response
}

fn decode_header_component(value: &str) -> Result<String, String> {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            if index + 2 >= bytes.len() {
                return Err("첨부 파일 헤더 인코딩이 올바르지 않습니다".to_owned());
            }
            let high = decode_hex(bytes[index + 1])?;
            let low = decode_hex(bytes[index + 2])?;
            decoded.push((high << 4) | low);
            index += 3;
        } else {
            decoded.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(decoded).map_err(|_| "첨부 파일 헤더가 UTF-8이 아닙니다".to_owned())
}

fn decode_hex(byte: u8) -> Result<u8, String> {
    match byte {
        b'0'..=b'9' => Ok(byte - b'0'),
        b'a'..=b'f' => Ok(byte - b'a' + 10),
        b'A'..=b'F' => Ok(byte - b'A' + 10),
        _ => Err("첨부 파일 헤더 인코딩이 올바르지 않습니다".to_owned()),
    }
}

fn is_loopback_host(host: &str) -> bool {
    let host = host.rsplit_once(':').map_or(host, |(name, _)| name);
    matches!(host, "127.0.0.1" | "localhost" | "[::1]")
}

async fn route(
    mut request: Request<Incoming>,
    config: Arc<Config>,
    access: RequestAccess,
) -> HttpResponse {
    let method = request.method().clone();
    let path = request.uri().path().to_owned();

    if method == Method::OPTIONS && path.starts_with("/api/") {
        return local_ui_cors_preflight(request.headers(), access, config.port);
    }

    if method == Method::GET && path == "/api/access" {
        let status = AccessStatus {
            protocol_version: REMOTE_API_PROTOCOL_VERSION,
            store_id: &config.store_id,
            backend_port: config.port,
            mode: if access.remote { "tailscale" } else { "local" },
            remote: access.remote,
            writable: access.writable,
        };
        return json_response(StatusCode::OK, &status);
    }

    if method == Method::GET && path == "/api/terminal" && is_upgrade_request(&request) {
        if let Err(error) = authorize_terminal(request.headers(), &config, access) {
            return error_response(error);
        }
        return match hyper_tungstenite::upgrade(&mut request, None) {
            Ok((response, websocket)) => {
                let terminals = config.terminals.clone();
                tokio::spawn(async move {
                    if let Err(error) = handle_terminal_socket(websocket, terminals, access).await {
                        eprintln!("Terminal WebSocket error: {error}");
                    }
                });
                response
            }
            Err(error) => error_response(ApiError {
                status: StatusCode::BAD_REQUEST,
                message: format!("WebSocket 연결을 열지 못했습니다: {error}"),
            }),
        };
    }

    if method == Method::GET && path == "/api/chat" && is_upgrade_request(&request) {
        if let Err(error) = authorize_terminal(request.headers(), &config, access) {
            return error_response(error);
        }
        return match hyper_tungstenite::upgrade(&mut request, None) {
            Ok((response, websocket)) => {
                let chats = config.chats.clone();
                let translations = config.translations.clone();
                tokio::spawn(async move {
                    if let Err(error) = handle_chat_socket(websocket, chats, translations).await {
                        eprintln!("Chat WebSocket error: {error}");
                    }
                });
                response
            }
            Err(error) => error_response(ApiError {
                status: StatusCode::BAD_REQUEST,
                message: format!("WebSocket 연결을 열지 못했습니다: {error}"),
            }),
        };
    }

    if method == Method::GET {
        if let Some(ids) = path.strip_prefix("/api/chat-attachment/") {
            let mut parts = ids.split('/');
            let (Some(chat_id), Some(attachment_id), None) =
                (parts.next(), parts.next(), parts.next())
            else {
                return error_response(ApiError {
                    status: StatusCode::BAD_REQUEST,
                    message: "첨부 파일 경로가 올바르지 않습니다".to_owned(),
                });
            };
            return match config.chats.input_file_download(chat_id, attachment_id) {
                Ok(download) => chat_input_file_response(download),
                Err(error) => error_response(ApiError::from(error)),
            };
        }
    }

    if method == Method::POST {
        if path == "/api/chat-attachment" {
            if !access.writable {
                return error_response(ApiError {
                    status: StatusCode::FORBIDDEN,
                    message: "원격 변경이 비활성화되어 있습니다".to_owned(),
                });
            }
            let chat_id = match required_encoded_header(request.headers(), "x-chat-id") {
                Ok(value) => value,
                Err(error) => return error_response(error),
            };
            let name = match required_encoded_header(request.headers(), "x-file-name") {
                Ok(value) => value,
                Err(error) => return error_response(error),
            };
            let media_type = match required_encoded_header(request.headers(), "x-file-type") {
                Ok(value) => value,
                Err(error) => return error_response(error),
            };
            let body = match read_body(request.into_body()).await {
                Ok(body) => body,
                Err(error) => return error_response(error),
            };
            return match config
                .chats
                .upload_input_file(&chat_id, &name, &media_type, body)
            {
                Ok(file) => json_response(StatusCode::OK, &file),
                Err(error) => error_response(ApiError::from(error)),
            };
        }
        if let Some(kind) = path.strip_prefix("/api/download/linked-file/") {
            if !has_json_content_type(request.headers()) {
                return unsupported_json_content_type_response();
            }
            let body = match read_body(request.into_body()).await {
                Ok(body) => body,
                Err(error) => return error_response(error),
            };
            let params = match serde_json::from_slice::<Value>(&body) {
                Ok(params) => params,
                Err(error) => {
                    return error_response(ApiError {
                        status: StatusCode::BAD_REQUEST,
                        message: format!("JSON 요청을 읽지 못했습니다: {error}"),
                    });
                }
            };
            let app_data_dir = config.app_data_dir.clone();
            let session_catalog = config.session_catalog.clone();
            let chats = config.chats.clone();
            let kind = kind.to_owned();
            return match tokio::task::spawn_blocking(move || {
                dispatch_linked_file_download(
                    &app_data_dir,
                    &session_catalog,
                    &chats,
                    &kind,
                    params,
                )
            })
            .await
            {
                Ok(Ok(file)) => linked_file_download_response(file),
                Ok(Err(error)) => error_response(error),
                Err(error) => error_response(ApiError {
                    status: StatusCode::INTERNAL_SERVER_ERROR,
                    message: format!("다운로드 처리 작업이 중단되었습니다: {error}"),
                }),
            };
        }
        if let Some(command) = path.strip_prefix("/api/invoke/") {
            if !has_json_content_type(request.headers()) {
                return unsupported_json_content_type_response();
            }
            if is_write_command(command) && !access.writable {
                return error_response(ApiError {
                    status: StatusCode::FORBIDDEN,
                    message: "원격 변경이 비활성화되어 있습니다".to_owned(),
                });
            }
            let body = match read_body(request.into_body()).await {
                Ok(body) => body,
                Err(error) => return error_response(error),
            };
            let params = match serde_json::from_slice::<Value>(&body) {
                Ok(params) => params,
                Err(error) => {
                    return error_response(ApiError {
                        status: StatusCode::BAD_REQUEST,
                        message: format!("JSON 요청을 읽지 못했습니다: {error}"),
                    });
                }
            };
            let app_data_dir = config.app_data_dir.clone();
            let service = ServiceEndpoint {
                port: config.port,
                tailscale_host: config.tailscale_host.clone(),
                remote_write: config.remote_write,
            };
            let scheduler = config.scheduler.clone();
            let session_catalog = config.session_catalog.clone();
            let chats = config.chats.clone();
            let terminals = config.terminals.clone();
            let translations = config.translations.clone();
            let command = command.to_owned();
            return match tokio::task::spawn_blocking(move || {
                let context = SystemCommandContext {
                    app_data_dir: &app_data_dir,
                    service: &service,
                    session_catalog: &session_catalog,
                    chats: &chats,
                    terminals: &terminals,
                    scheduler: &scheduler,
                    translations: &translations,
                };
                dispatch_command(&context, &command, params)
            })
            .await
            {
                Ok(Ok(value)) => json_value_response(StatusCode::OK, value),
                Ok(Err(error)) => error_response(error),
                Err(error) => error_response(ApiError {
                    status: StatusCode::INTERNAL_SERVER_ERROR,
                    message: format!("요청 처리 작업이 중단되었습니다: {error}"),
                }),
            };
        }
    }

    if matches!(method, Method::GET | Method::HEAD) {
        return static_response(&config.static_dir, &path, method == Method::HEAD);
    }

    error_response(ApiError {
        status: StatusCode::NOT_FOUND,
        message: "요청 경로를 찾을 수 없습니다".to_owned(),
    })
}

fn dispatch_linked_file_download(
    app_data_dir: &Path,
    session_catalog: &SessionCatalog,
    chats: &ChatSupervisor,
    kind: &str,
    params: Value,
) -> Result<LinkedFileDownload, ApiError> {
    match kind {
        "session" => {
            let args: RequestEnvelope<SessionLinkedFileRequest> = parse_params(params)?;
            session_catalog
                .linked_file_download(args.request.source, &args.request.id, &args.request.href)
                .map_err(ApiError::from)
        }
        "chat" => {
            let args: RequestEnvelope<ChatLinkedFileRequest> = parse_params(params)?;
            chats
                .linked_file_download(&args.request.chat_id, &args.request.href)
                .map_err(ApiError::from)
        }
        "doc" => {
            let args: RequestEnvelope<DocLinkedFileRequest> = parse_params(params)?;
            read_doc_linked_file_download(
                app_data_dir,
                &args.request.root_id,
                &args.request.current_path,
                &args.request.href,
            )
            .map_err(ApiError::from)
        }
        _ => Err(ApiError {
            status: StatusCode::NOT_FOUND,
            message: "다운로드 요청 경로를 찾을 수 없습니다".to_owned(),
        }),
    }
}

fn authorize_terminal(
    headers: &HeaderMap,
    config: &Config,
    access: RequestAccess,
) -> Result<(), ApiError> {
    if !access.remote {
        let Some(origin) = header_text(headers, ORIGIN.as_str()) else {
            return Ok(());
        };
        if is_allowed_loopback_origin(origin, config.port) {
            return Ok(());
        }
        return Err(ApiError {
            status: StatusCode::FORBIDDEN,
            message: "허용되지 않은 로컬 WebSocket Origin입니다".to_owned(),
        });
    }
    if !access.writable {
        return Err(ApiError {
            status: StatusCode::FORBIDDEN,
            message: "원격 터미널이 비활성화되어 있습니다".to_owned(),
        });
    }
    let expected_origin = format!(
        "https://{}",
        config.tailscale_host.as_deref().unwrap_or_default()
    );
    if header_text(headers, "origin") != Some(expected_origin.as_str()) {
        return Err(ApiError {
            status: StatusCode::FORBIDDEN,
            message: "허용되지 않은 원격 Origin입니다".to_owned(),
        });
    }
    Ok(())
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum TerminalClientMessage {
    Open { request: RemoteTerminalOpenRequest },
    Input { data: String },
    Resize { cols: u16, rows: u16 },
    Stop,
    Detach,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum RemoteTerminalOpenRequest {
    Session(TerminalOpenRequest),
    AccountLogin(TerminalAccountLoginRequest),
    Setup(TerminalSetupRequest),
}

async fn handle_terminal_socket(
    websocket: HyperWebsocket,
    terminals: TerminalSupervisor,
    access: RequestAccess,
) -> Result<(), String> {
    let mut socket = websocket
        .await
        .map_err(|error| format!("WebSocket 업그레이드 실패: {error}"))?;
    let first = tokio::time::timeout(Duration::from_secs(10), socket.next())
        .await
        .map_err(|_| "터미널 시작 요청 시간이 초과되었습니다".to_owned())?
        .ok_or_else(|| "터미널 시작 전에 연결이 종료되었습니다".to_owned())?
        .map_err(|error| format!("터미널 시작 요청을 읽지 못했습니다: {error}"))?;
    let request = match parse_terminal_message(first)? {
        TerminalClientMessage::Open { request } => request,
        _ => return Err("첫 터미널 메시지는 open이어야 합니다".to_owned()),
    };
    if let Err(error) = authorize_terminal_open_request(&request, access) {
        let _ = send_terminal_event(&mut socket, TerminalEvent::Error { message: error }).await;
        let _ = socket.close(None).await;
        return Ok(());
    }
    let attachment = match request {
        RemoteTerminalOpenRequest::Session(request) => terminals.open_or_attach(request),
        RemoteTerminalOpenRequest::AccountLogin(request) => terminals.open_account_login(request),
        RemoteTerminalOpenRequest::Setup(request) => terminals.open_setup(request),
    };
    let attachment = match attachment {
        Ok(attachment) => attachment,
        Err(error) => {
            let _ = send_terminal_event(
                &mut socket,
                TerminalEvent::Error {
                    message: error.to_string(),
                },
            )
            .await;
            let _ = socket.close(None).await;
            return Ok(());
        }
    };
    let terminal_id = attachment.info.terminal_id.clone();
    let (event_sender, mut event_receiver) = tokio::sync::mpsc::channel(256);
    std::thread::spawn(move || {
        for event in attachment.events {
            if event_sender.blocking_send(event).is_err() {
                break;
            }
        }
    });

    loop {
        tokio::select! {
            event = event_receiver.recv() => {
                let Some(event) = event else { break; };
                if send_terminal_event(&mut socket, event).await.is_err() {
                    break;
                }
            }
            incoming = socket.next() => {
                let Some(incoming) = incoming else { break; };
                let incoming = match incoming {
                    Ok(message) => message,
                    Err(_) => break,
                };
                match incoming {
                    Message::Ping(data) => {
                        if socket.send(Message::Pong(data)).await.is_err() { break; }
                    }
                    Message::Close(_) => break,
                    message => match parse_terminal_message(message) {
                        Ok(TerminalClientMessage::Input { data }) => {
                            if let Err(error) = terminals.write(&terminal_id, data.as_bytes()) {
                                send_terminal_event(&mut socket, TerminalEvent::Error { message: error.to_string() }).await?;
                            }
                        }
                        Ok(TerminalClientMessage::Resize { cols, rows }) => {
                            if let Err(error) = terminals.resize(&terminal_id, cols, rows) {
                                send_terminal_event(&mut socket, TerminalEvent::Error { message: error.to_string() }).await?;
                            }
                        }
                        Ok(TerminalClientMessage::Stop) => {
                            if let Err(error) = terminals.stop(&terminal_id) {
                                send_terminal_event(&mut socket, TerminalEvent::Error { message: error.to_string() }).await?;
                            }
                        }
                        Ok(TerminalClientMessage::Detach) => break,
                        Ok(TerminalClientMessage::Open { .. }) => {
                            send_terminal_event(&mut socket, TerminalEvent::Error { message: "이미 열린 연결에서는 open을 다시 보낼 수 없습니다".to_owned() }).await?;
                        }
                        Err(error) => {
                            send_terminal_event(&mut socket, TerminalEvent::Error { message: error }).await?;
                        }
                    }
                }
            }
        }
    }
    let _ = terminals.detach(&terminal_id);
    Ok(())
}

fn authorize_terminal_open_request(
    request: &RemoteTerminalOpenRequest,
    access: RequestAccess,
) -> Result<(), String> {
    if matches!(request, RemoteTerminalOpenRequest::Setup(_)) && access.remote {
        return Err(
            "CLI 설정 터미널은 Agent Manager 호스트의 로컬 UI에서만 열 수 있습니다".to_owned(),
        );
    }
    Ok(())
}

fn parse_terminal_message(message: Message) -> Result<TerminalClientMessage, String> {
    let text = match message {
        Message::Text(text) => text,
        _ => return Err("터미널 제어 메시지는 JSON 텍스트여야 합니다".to_owned()),
    };
    if text.len() > 64 * 1024 {
        return Err("터미널 제어 메시지가 너무 큽니다".to_owned());
    }
    serde_json::from_str(text.as_ref())
        .map_err(|error| format!("터미널 제어 메시지가 올바르지 않습니다: {error}"))
}

async fn send_terminal_event(
    socket: &mut hyper_tungstenite::WebSocketStream<
        hyper_util::rt::TokioIo<hyper::upgrade::Upgraded>,
    >,
    event: TerminalEvent,
) -> Result<(), String> {
    let message = match event {
        TerminalEvent::Output { data } => Message::binary(data),
        event => Message::text(
            serde_json::to_string(&event)
                .map_err(|error| format!("터미널 이벤트를 직렬화하지 못했습니다: {error}"))?,
        ),
    };
    socket
        .send(message)
        .await
        .map_err(|error| format!("터미널 이벤트를 보내지 못했습니다: {error}"))
}

#[derive(Debug, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
enum ChatClientMessage {
    Start {
        request: ChatStartRequest,
    },
    Attach {
        chat_id: String,
    },
    Send {
        text: String,
        #[serde(default)]
        steer: bool,
        #[serde(default)]
        attachment_ids: Vec<String>,
    },
    RemoveQueued {
        message_id: String,
    },
    Approve {
        approval_id: String,
        decision: ChatApprovalDecision,
    },
    Interrupt,
    Stop,
    Detach,
}

/// AIA 런타임은 시스템 설정에서 고른 시스템 에이전트에서만 시작한다. 선택을 비우면
/// AIA 기능 전체가 꺼지므로, 설정 변경을 아직 못 본 클라이언트가 시작을 요청해도
/// 여기서 막는다.
fn ensure_aia_runtime_allowed(
    translations: &TranslationSupervisor,
    request: &ChatStartRequest,
) -> Result<(), CoreError> {
    if request.profile != ChatProfile::Aia {
        return Ok(());
    }
    match translations.snapshot()?.settings.aia_provider() {
        Some(provider) if provider == request.source => Ok(()),
        Some(_) => Err(CoreError::InvalidInput(
            "AIA는 시스템 설정에서 고른 시스템 에이전트에서만 실행할 수 있습니다".to_owned(),
        )),
        None => Err(CoreError::InvalidInput(
            "시스템 설정에서 시스템 에이전트를 선택하면 AIA를 사용할 수 있습니다".to_owned(),
        )),
    }
}

async fn handle_chat_socket(
    websocket: HyperWebsocket,
    chats: ChatSupervisor,
    translations: TranslationSupervisor,
) -> Result<(), String> {
    let mut socket = websocket
        .await
        .map_err(|error| format!("WebSocket 업그레이드 실패: {error}"))?;
    let first = tokio::time::timeout(Duration::from_secs(15), socket.next())
        .await
        .map_err(|_| "채팅 시작 요청 시간이 초과되었습니다".to_owned())?
        .ok_or_else(|| "채팅 시작 전에 연결이 종료되었습니다".to_owned())?
        .map_err(|error| format!("채팅 시작 요청을 읽지 못했습니다: {error}"))?;
    let attachment = match parse_chat_message(first)? {
        ChatClientMessage::Start { request } => {
            ensure_aia_runtime_allowed(&translations, &request).and_then(|()| chats.start(request))
        }
        ChatClientMessage::Attach { chat_id } => chats.attach(&chat_id),
        _ => return Err("첫 채팅 메시지는 start 또는 attach여야 합니다".to_owned()),
    };
    let attachment = match attachment {
        Ok(attachment) => attachment,
        Err(error) => {
            let _ = send_chat_event(
                &mut socket,
                ChatEvent::Error {
                    message: error.to_string(),
                },
            )
            .await;
            let _ = socket.close(None).await;
            return Ok(());
        }
    };
    let chat_id = attachment.info.chat_id.clone();
    let attachment_generation = attachment.generation;
    let (event_sender, mut event_receiver) = tokio::sync::mpsc::channel(256);
    std::thread::spawn(move || {
        for event in attachment.events {
            if event_sender.blocking_send(event).is_err() {
                break;
            }
        }
    });
    let mut heartbeat = tokio::time::interval(Duration::from_secs(20));
    heartbeat.tick().await;

    loop {
        tokio::select! {
            _ = heartbeat.tick() => {
                if socket.send(Message::Ping(Bytes::new())).await.is_err() { break; }
            }
            event = event_receiver.recv() => {
                let Some(event) = event else { break; };
                if send_chat_event(&mut socket, event).await.is_err() { break; }
            }
            incoming = socket.next() => {
                let Some(incoming) = incoming else { break; };
                let incoming = match incoming { Ok(message) => message, Err(_) => break };
                match incoming {
                    Message::Ping(data) => {
                        if socket.send(Message::Pong(data)).await.is_err() { break; }
                    }
                    Message::Pong(_) => {}
                    Message::Close(_) => break,
                    message => match parse_chat_message(message) {
                        Ok(ChatClientMessage::Send { text, steer, attachment_ids }) => {
                            let result = chats.send_with_attachments(&chat_id, &text, &attachment_ids, steer);
                            if let Err(error) = result {
                                send_chat_event(&mut socket, ChatEvent::Error { message: error.to_string() }).await?;
                            }
                        }
                        Ok(ChatClientMessage::RemoveQueued { message_id }) => {
                            if let Err(error) = chats.remove_queued(&chat_id, &message_id) {
                                send_chat_event(&mut socket, ChatEvent::Error { message: error.to_string() }).await?;
                            }
                        }
                        Ok(ChatClientMessage::Approve { approval_id, decision }) => {
                            if let Err(error) = chats.approve(&chat_id, &approval_id, decision) {
                                send_chat_event(&mut socket, ChatEvent::Error { message: error.to_string() }).await?;
                            }
                        }
                        Ok(ChatClientMessage::Interrupt) => {
                            if let Err(error) = chats.interrupt(&chat_id) {
                                send_chat_event(&mut socket, ChatEvent::Error { message: error.to_string() }).await?;
                            }
                        }
                        Ok(ChatClientMessage::Stop) => {
                            if let Err(error) = chats.stop(&chat_id) {
                                send_chat_event(&mut socket, ChatEvent::Error { message: error.to_string() }).await?;
                            }
                        }
                        Ok(ChatClientMessage::Detach) => break,
                        Ok(ChatClientMessage::Start { .. } | ChatClientMessage::Attach { .. }) => {
                            send_chat_event(&mut socket, ChatEvent::Error { message: "이미 열린 연결에서는 start 또는 attach를 다시 보낼 수 없습니다".to_owned() }).await?;
                        }
                        Err(error) => send_chat_event(&mut socket, ChatEvent::Error { message: error }).await?,
                    }
                }
            }
        }
    }
    let _ = chats.detach_attachment(&chat_id, attachment_generation);
    Ok(())
}

fn parse_chat_message(message: Message) -> Result<ChatClientMessage, String> {
    let text = match message {
        Message::Text(text) => text,
        _ => return Err("채팅 제어 메시지는 JSON 텍스트여야 합니다".to_owned()),
    };
    if text.len() > 128 * 1024 {
        return Err("채팅 제어 메시지가 너무 큽니다".to_owned());
    }
    serde_json::from_str(text.as_ref())
        .map_err(|error| format!("채팅 제어 메시지가 올바르지 않습니다: {error}"))
}

async fn send_chat_event(
    socket: &mut hyper_tungstenite::WebSocketStream<
        hyper_util::rt::TokioIo<hyper::upgrade::Upgraded>,
    >,
    event: ChatEvent,
) -> Result<(), String> {
    socket
        .send(Message::text(serde_json::to_string(&event).map_err(
            |error| format!("채팅 이벤트를 직렬화하지 못했습니다: {error}"),
        )?))
        .await
        .map_err(|error| format!("채팅 이벤트를 보내지 못했습니다: {error}"))
}

async fn read_body(mut body: Incoming) -> Result<Vec<u8>, ApiError> {
    let mut result = Vec::new();
    while let Some(frame) = body.frame().await {
        let frame = frame.map_err(|error| ApiError {
            status: StatusCode::BAD_REQUEST,
            message: format!("요청 본문을 읽지 못했습니다: {error}"),
        })?;
        if let Some(data) = frame.data_ref() {
            if result.len().saturating_add(data.len()) > MAX_REQUEST_BODY {
                return Err(ApiError {
                    status: StatusCode::PAYLOAD_TOO_LARGE,
                    message: "요청 본문이 너무 큽니다".to_owned(),
                });
            }
            result.extend_from_slice(data);
        }
    }
    Ok(result)
}

pub(crate) fn is_write_command(command: &str) -> bool {
    matches!(
        command,
        "patch_session_meta"
            | "create_session_folder"
            | "update_session_folder"
            | "delete_session_folder"
            | "create_doc_root"
            | "delete_doc_root"
            | "put_doc"
            | "create_scheduled_request"
            | "update_scheduled_request"
            | "delete_scheduled_request"
            | "set_schedule_enabled"
            | "run_scheduled_request_now"
            | "cancel_scheduled_run"
            | "recover_provider_transition"
            | "cancel_and_recover_scheduled_run"
            | "set_schedules_paused"
            | "set_system_automation_settings"
            | "request_system_language"
            | "retry_ui_translation"
            | "cancel_ui_translation"
            | "retry_menu_translation"
            | "reset_menu_translation"
            | "mark_chat_attention_read"
            | "mark_all_chat_attention_read"
            | "clear_read_chat_attention"
            | "dismiss_chat_attention"
            | "remove_chat_input_file"
            | "register_current_provider_account"
            | "begin_provider_account_login"
            | "finish_provider_account_login"
            | "cancel_provider_account_login"
            | "revalidate_provider_account_credential"
            | "set_default_provider_account"
            | "set_active_provider_account"
            | "set_provider_account_disabled"
            | "set_provider_account_auto_switch"
            | "set_auto_switch_resume"
            | "set_tailscale_service_enabled"
            | "delete_provider_account"
            | "propose_chat_settings_schema"
            | "send_chat_message"
            | "start_chat"
            | "detach_chat"
            | "stop_chat"
            | "stop_provider_chats"
            | "stop_provider_terminals"
            | "terminate_external_provider_processes"
            | "switch_active_provider_account"
            | "register_system_workflow"
            | "execute_system_workflow"
            | "delete_system_workflow"
    )
}

pub(crate) struct SystemCommandContext<'a> {
    pub(crate) app_data_dir: &'a Path,
    /// 실행 중인 백엔드의 서비스 종단점. Tailscale Serve 대상을 저장된 설정이
    /// 아닌 현재 수신 포트로 맞추기 위해 함께 전달한다.
    pub(crate) service: &'a ServiceEndpoint,
    pub(crate) session_catalog: &'a SessionCatalog,
    pub(crate) chats: &'a ChatSupervisor,
    pub(crate) terminals: &'a TerminalSupervisor,
    pub(crate) scheduler: &'a SchedulerSupervisor,
    pub(crate) translations: &'a TranslationSupervisor,
}

fn dispatch_command(
    context: &SystemCommandContext<'_>,
    command: &str,
    params: Value,
) -> Result<Value, ApiError> {
    let app_data_dir = context.app_data_dir;
    let session_catalog = context.session_catalog;
    let chats = context.chats;
    let terminals = context.terminals;
    let scheduler = context.scheduler;
    let translations = context.translations;
    let service = context.service;
    match command {
        "get_app_status" => to_value(inspect_local_environment()?),
        "get_tailscale_service_status" => to_value(tailscale_service_status(service)),
        "set_tailscale_service_enabled" => {
            let args: TailscaleServiceArg = parse_params(params)?;
            to_value(set_tailscale_service(
                context.app_data_dir,
                service,
                args.enabled,
                args.replace_existing,
            )?)
        }
        "get_provider_accounts" => to_value(
            chats
                .accounts()
                .ok_or_else(|| CoreError::Conflict("계정 관리가 준비되지 않았습니다".to_owned()))?
                .reconciled_snapshot()?,
        ),
        "refresh_provider_account_usage" => {
            let args: AccountIdArg = parse_params(params)?;
            to_value(
                chats
                    .accounts()
                    .ok_or_else(|| {
                        CoreError::Conflict("계정 관리가 준비되지 않았습니다".to_owned())
                    })?
                    .refresh_usage(&args.account_id)?,
            )
        }
        "revalidate_provider_account_credential" => {
            let args: AccountIdArg = parse_params(params)?;
            to_value(
                chats
                    .accounts()
                    .ok_or_else(|| {
                        CoreError::Conflict("계정 관리가 준비되지 않았습니다".to_owned())
                    })?
                    .revalidate_saved_credential(&args.account_id)?,
            )
        }
        "register_current_provider_account" => {
            let args: RegisterCurrentProviderAccountArg = parse_params(params)?;
            to_value(
                chats
                    .accounts()
                    .ok_or_else(|| {
                        CoreError::Conflict("계정 관리가 준비되지 않았습니다".to_owned())
                    })?
                    .register_current(args.source, args.display_name)?,
            )
        }
        "begin_provider_account_login" => {
            let args: BeginProviderAccountLoginArg = parse_params(params)?;
            to_value(
                chats
                    .accounts()
                    .ok_or_else(|| {
                        CoreError::Conflict("계정 관리가 준비되지 않았습니다".to_owned())
                    })?
                    .begin_login(args.source, args.account_id.as_deref())?,
            )
        }
        "finish_provider_account_login" => {
            let args: FinishProviderAccountLoginArg = parse_params(params)?;
            to_value(
                chats
                    .accounts()
                    .ok_or_else(|| {
                        CoreError::Conflict("계정 관리가 준비되지 않았습니다".to_owned())
                    })?
                    .finish_login(&args.login_id, args.display_name)?,
            )
        }
        "cancel_provider_account_login" => {
            let args: LoginIdArg = parse_params(params)?;
            chats
                .accounts()
                .ok_or_else(|| CoreError::Conflict("계정 관리가 준비되지 않았습니다".to_owned()))?
                .cancel_login(&args.login_id)?;
            Ok(Value::Null)
        }
        "set_default_provider_account" => {
            let args: AccountIdArg = parse_params(params)?;
            to_value(
                chats
                    .accounts()
                    .ok_or_else(|| {
                        CoreError::Conflict("계정 관리가 준비되지 않았습니다".to_owned())
                    })?
                    .set_default(&args.account_id)?,
            )
        }
        "set_active_provider_account" => {
            let args: AccountIdArg = parse_params(params)?;
            let receipt = crate::switch_active_provider_account(
                chats,
                terminals,
                crate::SwitchActiveProviderAccountRequest {
                    account_id: args.account_id,
                    stop_running_chats: true,
                    stop_external_processes: true,
                },
            )?;
            to_value(receipt.snapshot)
        }
        "set_provider_account_disabled" => {
            let args: SetProviderAccountDisabledArg = parse_params(params)?;
            to_value(
                chats
                    .accounts()
                    .ok_or_else(|| {
                        CoreError::Conflict("계정 관리가 준비되지 않았습니다".to_owned())
                    })?
                    .set_disabled(&args.account_id, args.disabled)?,
            )
        }
        "set_provider_account_auto_switch" => {
            let args: SetProviderAccountAutoSwitchArg = parse_params(params)?;
            to_value(
                chats
                    .accounts()
                    .ok_or_else(|| {
                        CoreError::Conflict("계정 관리가 준비되지 않았습니다".to_owned())
                    })?
                    .set_auto_switch(&args.account_id, args.auto_switch)?,
            )
        }
        "set_auto_switch_resume" => {
            let args: SetAutoSwitchResumeArg = parse_params(params)?;
            to_value(
                chats
                    .accounts()
                    .ok_or_else(|| {
                        CoreError::Conflict("계정 관리가 준비되지 않았습니다".to_owned())
                    })?
                    .set_auto_switch_resume(args.enabled)?,
            )
        }
        "delete_provider_account" => {
            let args: AccountIdArg = parse_params(params)?;
            let referenced = scheduler.account_reference_count(&args.account_id)? > 0;
            to_value(
                chats
                    .accounts()
                    .ok_or_else(|| {
                        CoreError::Conflict("계정 관리가 준비되지 않았습니다".to_owned())
                    })?
                    .delete_account(&args.account_id, referenced)?,
            )
        }
        "get_chat_provider_options" => {
            let args: ProviderOptionsRequest = parse_params(params)?;
            to_value(chats.chat_provider_options(args.source))
        }
        "propose_chat_settings_schema" => {
            let args: ProposeChatSettingsSchemaRequest = parse_params(params)?;
            to_value(chats.propose_chat_settings_schema(args.source, args.fields)?)
        }
        "get_detached_chat_for_session" => {
            let args: RequestEnvelope<SessionRequest> = parse_params(params)?;
            to_value(chats.detached_chat_for_session(args.request.source, &args.request.id)?)
        }
        "get_live_chats" => {
            let args: ProfileArg = parse_params(params)?;
            to_value(chats.live_chats(args.profile)?)
        }
        "get_chat_attention_snapshot" => to_value(chats.attention_snapshot()?),
        "mark_chat_attention_read" => {
            let args: IdArg = parse_params(params)?;
            to_value(chats.mark_attention_read(&args.id)?)
        }
        "mark_all_chat_attention_read" => to_value(chats.mark_all_attention_read()?),
        "clear_read_chat_attention" => to_value(chats.clear_read_attention()?),
        "dismiss_chat_attention" => {
            let args: IdArg = parse_params(params)?;
            to_value(chats.dismiss_attention(&args.id)?)
        }
        "remove_chat_input_file" => {
            let args: RequestEnvelope<ChatInputFileArg> = parse_params(params)?;
            chats.remove_input_file(&args.request.chat_id, &args.request.attachment_id)?;
            to_value(())
        }
        "get_manager_snapshot" => to_value(session_catalog.manager_snapshot()?),
        "list_sessions" => {
            let args: RequestEnvelope<SessionListRequest> = parse_params(params)?;
            to_value(crate::list_sessions(session_catalog, chats, args.request)?)
        }
        "get_session_statistics" => {
            let args: RequestEnvelope<SessionStatisticsRequest> = parse_params(params)?;
            to_value(crate::get_session_statistics(
                session_catalog,
                chats,
                args.request,
            )?)
        }
        "get_chat_delivery_status" => {
            let args: IdempotencyKeyArg = parse_params(params)?;
            to_value(crate::get_chat_delivery_status(
                app_data_dir,
                &args.idempotency_key,
            )?)
        }
        "get_system_automation_snapshot" => to_value(translations.snapshot()?),
        "set_system_automation_settings" => {
            let args: RequestEnvelope<SystemAutomationSettingsInput> = parse_params(params)?;
            let snapshot = translations.set_settings(args.request)?;
            // 시스템 에이전트를 바꾸면 이전 공급자에서 돌던 AIA 런타임을 정리해,
            // 다음 AIA 열기가 새 공급자에서 다시 시작되도록 한다.
            chats.stop_aia_chats_other_than(snapshot.settings.aia_provider())?;
            to_value(snapshot)
        }
        "request_system_language" => {
            let args: RequestEnvelope<SystemLanguageRequest> = parse_params(params)?;
            to_value(translations.request_language(args.request)?)
        }
        "retry_ui_translation" => to_value(translations.retry_ui_translation()?),
        "cancel_ui_translation" => to_value(translations.cancel_ui_translation()?),
        "get_menu_translations" => {
            let args: MenuArg = parse_params(params)?;
            to_value(translations.menu_translations(args.menu)?)
        }
        "get_translated_detail" => {
            let args: TranslationDetailArg = parse_params(params)?;
            to_value(translations.translated_detail(args.menu, &args.resource_id)?)
        }
        "retry_menu_translation" => {
            let args: MenuArg = parse_params(params)?;
            to_value(translations.retry_menu(args.menu)?)
        }
        "reset_menu_translation" => {
            let args: MenuArg = parse_params(params)?;
            to_value(translations.reset_menu(args.menu)?)
        }
        "reconcile_session_catalog" => to_value(session_catalog.reconcile()?),
        "refresh_session_catalog" => {
            let args: RequestEnvelope<SessionRequest> = parse_params(params)?;
            to_value(session_catalog.refresh_session(args.request.source, &args.request.id)?)
        }
        "get_storage_overview" => to_value(load_storage_overview(app_data_dir)?),
        "get_session_detail" => {
            let args: RequestEnvelope<SessionDetailRequest> = parse_params(params)?;
            if let Some(before_index) = args.request.transcript_before_index {
                to_value(load_session_transcript_before(
                    app_data_dir,
                    args.request.source,
                    &args.request.id,
                    args.request.transcript_limit,
                    before_index,
                )?)
            } else if args.request.requests_page() {
                to_value(crate::get_session_transcript_page(
                    app_data_dir,
                    chats,
                    args.request.into_page_request(),
                )?)
            } else {
                to_value(load_session_detail_with_limit(
                    app_data_dir,
                    args.request.source,
                    &args.request.id,
                    args.request.transcript_limit,
                )?)
            }
        }
        "get_session_linked_file" => {
            let args: RequestEnvelope<SessionLinkedFileRequest> = parse_params(params)?;
            to_value(session_catalog.linked_file(
                args.request.source,
                &args.request.id,
                &args.request.href,
            )?)
        }
        "get_chat_linked_file" => {
            let args: RequestEnvelope<ChatLinkedFileRequest> = parse_params(params)?;
            to_value(chats.linked_file(&args.request.chat_id, &args.request.href)?)
        }
        "patch_session_meta" => {
            let args: RequestEnvelope<UpdateSessionMetaRequest> = parse_params(params)?;
            let meta = update_session_meta(
                app_data_dir,
                args.request.source,
                &args.request.id,
                args.request.patch,
            )?;
            session_catalog.refresh_metadata()?;
            to_value(meta)
        }
        "get_session_folders" => to_value(list_session_folders(app_data_dir)?),
        "create_session_folder" => {
            let args: RequestEnvelope<CreateSessionFolderRequest> = parse_params(params)?;
            let folder =
                create_session_folder(app_data_dir, &args.request.name, &args.request.color)?;
            session_catalog.refresh_metadata()?;
            to_value(folder)
        }
        "update_session_folder" => {
            let args: RequestEnvelope<UpdateSessionFolderRequest> = parse_params(params)?;
            let folder = update_session_folder(
                app_data_dir,
                &args.request.id,
                args.request.name.as_deref(),
                args.request.color.as_deref(),
            )?;
            session_catalog.refresh_metadata()?;
            to_value(folder)
        }
        "delete_session_folder" => {
            let args: IdArg = parse_params(params)?;
            delete_session_folder(app_data_dir, &args.id)?;
            session_catalog.refresh_metadata()?;
            Ok(Value::Null)
        }
        "get_skill_detail" => {
            let args: IdArg = parse_params(params)?;
            to_value(load_skill_detail(&args.id)?)
        }
        "get_agent_detail" => {
            let args: NameArg = parse_params(params)?;
            to_value(load_agent_detail(&args.name)?)
        }
        "get_artifact_detail" => {
            let args: RequestEnvelope<ArtifactRequest> = parse_params(params)?;
            to_value(load_artifact_detail(
                &args.request.conversation_id,
                &args.request.root_name,
                &args.request.name,
            )?)
        }
        "get_doc_roots" => to_value(list_doc_roots(app_data_dir)?),
        "create_doc_root" => {
            let args: RequestEnvelope<AddDocRootRequest> = parse_params(params)?;
            to_value(add_doc_root(
                app_data_dir,
                &args.request.name,
                &args.request.path,
            )?)
        }
        "delete_doc_root" => {
            let args: IdArg = parse_params(params)?;
            remove_doc_root(app_data_dir, &args.id)?;
            Ok(Value::Null)
        }
        "get_doc_tree" => {
            let args: RootIdArg = parse_params(params)?;
            to_value(list_doc_tree(app_data_dir, &args.root_id)?)
        }
        "get_doc" => {
            let args: RequestEnvelope<DocRequest> = parse_params(params)?;
            to_value(read_doc(
                app_data_dir,
                &args.request.root_id,
                &args.request.relative_path,
            )?)
        }
        "get_doc_linked_file" => {
            let args: RequestEnvelope<DocLinkedFileRequest> = parse_params(params)?;
            to_value(read_doc_linked_file(
                app_data_dir,
                &args.request.root_id,
                &args.request.current_path,
                &args.request.href,
            )?)
        }
        "put_doc" => {
            let args: RequestEnvelope<SaveDocRequest> = parse_params(params)?;
            to_value(save_doc(
                app_data_dir,
                &args.request.root_id,
                &args.request.relative_path,
                &args.request.content,
                args.request.expected_modified_at,
            )?)
        }
        "get_scheduler_snapshot" => to_value(scheduler.snapshot()?),
        "list_scheduled_requests" => {
            let args: RequestEnvelope<ScheduledRequestListRequest> = parse_params(params)?;
            to_value(crate::list_scheduled_requests(scheduler, args.request)?)
        }
        "get_scheduled_request_detail" => {
            let args: IdArg = parse_params(params)?;
            to_value(crate::get_scheduled_request_detail(scheduler, &args.id)?)
        }
        "list_scheduled_runs" => {
            let args: RequestEnvelope<ScheduleRunListRequest> = parse_params(params)?;
            to_value(crate::list_scheduled_runs(scheduler, args.request)?)
        }
        "get_scheduled_run_detail" => {
            let args: IdArg = parse_params(params)?;
            to_value(crate::get_scheduled_run_detail(scheduler, &args.id)?)
        }
        "list_system_audit" => {
            let args: RequestEnvelope<SystemAuditListRequest> = parse_params(params)?;
            to_value(crate::list_system_audit(app_data_dir, args.request)?)
        }
        "send_chat_message" => {
            let args: RequestEnvelope<SendChatMessageRequest> = parse_params(params)?;
            to_value(crate::send_chat_message(app_data_dir, chats, args.request)?)
        }
        "start_chat" => {
            let args: RequestEnvelope<StartChatRequest> = parse_params(params)?;
            to_value(crate::start_chat(app_data_dir, chats, args.request)?)
        }
        "detach_chat" => {
            let args: ChatIdArg = parse_params(params)?;
            chats.detach(&args.chat_id)?;
            to_value(())
        }
        "stop_chat" => {
            let args: ChatIdArg = parse_params(params)?;
            to_value(chats.stop_managed(&args.chat_id)?)
        }
        "stop_provider_chats" => {
            let args: StopProviderChatsArg = parse_params(params)?;
            to_value(chats.stop_provider_chats(args.provider)?)
        }
        "stop_provider_terminals" => {
            let args: StopProviderChatsArg = parse_params(params)?;
            to_value(terminals.stop_provider_terminals(args.provider)?)
        }
        "list_external_provider_processes" => {
            let args: ProviderArg = parse_params(params)?;
            to_value(crate::list_external_provider_processes(args.provider)?)
        }
        "terminate_external_provider_processes" => {
            let args: StopProviderChatsArg = parse_params(params)?;
            to_value(crate::terminate_external_provider_processes(args.provider)?)
        }
        "list_provider_chats" => {
            let args: ProviderArg = parse_params(params)?;
            to_value(chats.provider_chats(args.provider)?)
        }
        "switch_active_provider_account" => {
            let args: crate::SwitchActiveProviderAccountRequest = parse_params(params)?;
            to_value(crate::switch_active_provider_account(
                chats, terminals, args,
            )?)
        }
        "propose_system_workflow_schema" => {
            let args: WorkflowContractEnvelope = parse_params(params)?;
            to_value(workflow_registry(app_data_dir).propose(args.request)?)
        }
        "register_system_workflow" => {
            let args: WorkflowContractEnvelope = parse_params(params)?;
            to_value(workflow_registry(app_data_dir).register(args.request)?)
        }
        "delete_system_workflow" => {
            let args: WorkflowIdArg = parse_params(params)?;
            to_value(workflow_registry(app_data_dir).delete(&args.workflow_id)?)
        }
        "get_system_workflows" => to_value(workflow_registry(app_data_dir).list()?),
        "get_system_workflow" => {
            let args: WorkflowIdArg = parse_params(params)?;
            to_value(workflow_registry(app_data_dir).get(&args.workflow_id)?)
        }
        "execute_system_workflow" => {
            let args: crate::system_workflows::WorkflowExecuteRequest = parse_params(params)?;
            // 워크플로 단계는 system_catalog 검증을 통과한 작업만 이 invoker로
            // 호출한다. 워크플로 관리 작업 자체는 검증 단계에서 금지된다.
            let invoker = |operation: &str, arguments: Value| -> Result<Value, CoreError> {
                if crate::system_mcp::system_operation_kind(operation).is_none() {
                    return Err(CoreError::InvalidInput(format!(
                        "system_catalog에 없는 작업입니다: {operation}"
                    )));
                }
                invoke_system_command(context, operation, arguments)
            };
            to_value(workflow_registry(app_data_dir).execute(args, &invoker)?)
        }
        "create_scheduled_request" => {
            let args: RequestEnvelope<ScheduledRequestInput> = parse_params(params)?;
            to_value(scheduler.create(args.request)?)
        }
        "update_scheduled_request" => {
            let args: RequestEnvelope<UpdateScheduledRequest> = parse_params(params)?;
            to_value(scheduler.update(&args.request.id, args.request.input)?)
        }
        "delete_scheduled_request" => {
            let args: IdArg = parse_params(params)?;
            scheduler.delete(&args.id)?;
            Ok(Value::Null)
        }
        "set_schedule_enabled" => {
            let args: RequestEnvelope<SetScheduleEnabledRequest> = parse_params(params)?;
            to_value(scheduler.set_enabled(&args.request.id, args.request.enabled)?)
        }
        "run_scheduled_request_now" => {
            let args: IdArg = parse_params(params)?;
            to_value(scheduler.run_now(&args.id)?)
        }
        "cancel_scheduled_run" => {
            audited_recovery_command(app_data_dir, "cancel_scheduled_run", params, |params| {
                let args: CancelScheduledRunArg = parse_params(params)?;
                to_value(scheduler.cancel_run(&args.run_id, args.reason.as_deref())?)
            })
        }
        "recover_provider_transition" => audited_recovery_command(
            app_data_dir,
            "recover_provider_transition",
            params,
            |params| {
                let args: crate::ProviderTransitionRecoveryRequest = parse_params(params)?;
                to_value(scheduler.recover_provider_transition(args)?)
            },
        ),
        "cancel_and_recover_scheduled_run" => audited_recovery_command(
            app_data_dir,
            "cancel_and_recover_scheduled_run",
            params,
            |params| {
                let args: CancelAndRecoverScheduledRunArg = parse_params(params)?;
                to_value(scheduler.cancel_and_recover_run(args.request, args.reason.as_deref())?)
            },
        ),
        "set_schedules_paused" => {
            let args: PausedArg = parse_params(params)?;
            to_value(scheduler.set_paused(args.paused)?)
        }
        _ => Err(ApiError {
            status: StatusCode::NOT_FOUND,
            message: "지원하지 않는 명령입니다".to_owned(),
        }),
    }
}

fn audited_recovery_command(
    app_data_dir: &Path,
    operation: &str,
    arguments: Value,
    action: impl FnOnce(Value) -> Result<Value, ApiError>,
) -> Result<Value, ApiError> {
    crate::append_system_audit(
        app_data_dir,
        operation,
        &arguments,
        crate::SystemAuditPhase::Attempted,
        None,
    )?;
    let result = action(arguments.clone());
    crate::append_system_audit(
        app_data_dir,
        operation,
        &arguments,
        crate::SystemAuditPhase::Completed,
        Some(result.is_ok()),
    )?;
    result
}

pub(crate) fn invoke_system_command(
    context: &SystemCommandContext<'_>,
    command: &str,
    params: Value,
) -> Result<Value, CoreError> {
    dispatch_command(context, command, params).map_err(|error| match error.status {
        StatusCode::BAD_REQUEST => CoreError::InvalidInput(error.message),
        StatusCode::NOT_FOUND => CoreError::NotFound(error.message),
        StatusCode::CONFLICT => CoreError::Conflict(error.message),
        StatusCode::PAYLOAD_TOO_LARGE => CoreError::TooLarge(MAX_REQUEST_BODY as u64),
        _ => CoreError::Runtime(error.message),
    })
}

fn parse_params<T: for<'de> Deserialize<'de>>(params: Value) -> Result<T, ApiError> {
    serde_json::from_value(params).map_err(|error| ApiError {
        status: StatusCode::BAD_REQUEST,
        message: format!("요청 인자가 올바르지 않습니다: {error}"),
    })
}

fn to_value<T: Serialize>(value: T) -> Result<Value, ApiError> {
    serde_json::to_value(value).map_err(|error| ApiError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        message: format!("응답을 직렬화하지 못했습니다: {error}"),
    })
}

impl From<CoreError> for ApiError {
    fn from(error: CoreError) -> Self {
        let status = match error {
            CoreError::InvalidInput(_) => StatusCode::BAD_REQUEST,
            CoreError::NotFound(_) => StatusCode::NOT_FOUND,
            CoreError::Conflict(_) => StatusCode::CONFLICT,
            CoreError::TooLarge(_) => StatusCode::PAYLOAD_TOO_LARGE,
            _ => StatusCode::INTERNAL_SERVER_ERROR,
        };
        Self {
            status,
            message: error.to_string(),
        }
    }
}

fn static_response(static_dir: &Path, request_path: &str, head: bool) -> HttpResponse {
    let relative = request_path.trim_start_matches('/');
    if relative.split('/').any(|part| part == "..") || relative.contains('\\') {
        return error_response(ApiError {
            status: StatusCode::BAD_REQUEST,
            message: "잘못된 정적 파일 경로입니다".to_owned(),
        });
    }

    let requested = if relative.is_empty() {
        static_dir.join("index.html")
    } else {
        static_dir.join(relative)
    };
    let path = fs::canonicalize(&requested)
        .ok()
        .filter(|path| path.starts_with(static_dir) && path.is_file())
        .unwrap_or_else(|| static_dir.join("index.html"));
    let body = match fs::read(&path) {
        Ok(body) => body,
        Err(error) => {
            return error_response(ApiError {
                status: StatusCode::INTERNAL_SERVER_ERROR,
                message: format!("정적 파일을 읽지 못했습니다: {error}"),
            });
        }
    };
    let content_type = content_type(&path);
    let mut response = response(
        StatusCode::OK,
        content_type,
        if head { Vec::new() } else { body },
    );
    // 서비스워커와 manifest는 갱신이 즉시 반영돼야 하므로 index.html처럼 캐시하지 않는다.
    let uncached = matches!(
        path.file_name().and_then(|name| name.to_str()),
        Some("index.html" | "sw.js" | "manifest.webmanifest")
    );
    response.headers_mut().insert(
        CACHE_CONTROL,
        if uncached {
            HeaderValue::from_static("no-store")
        } else {
            HeaderValue::from_static("public, max-age=31536000, immutable")
        },
    );
    response
}

fn content_type(path: &Path) -> &'static str {
    match path.extension().and_then(|value| value.to_str()) {
        Some("html") => "text/html; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("js") => "text/javascript; charset=utf-8",
        Some("json") => "application/json; charset=utf-8",
        Some("webmanifest") => "application/manifest+json; charset=utf-8",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("ico") => "image/x-icon",
        Some("pdf") => "application/pdf",
        Some("xlsx") => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        Some("xls") => "application/vnd.ms-excel",
        Some("docx") => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        Some("zip") => "application/zip",
        _ => "application/octet-stream",
    }
}

fn linked_file_download_response(file: LinkedFileDownload) -> HttpResponse {
    let content_type = content_type(Path::new(&file.relative_path));
    let disposition = content_disposition(&file.relative_path);
    let mut response = response(StatusCode::OK, content_type, file.bytes);
    response
        .headers_mut()
        .insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
        .headers_mut()
        .insert(CONTENT_DISPOSITION, disposition);
    response
}

fn chat_input_file_response(download: ChatInputFileDownload) -> HttpResponse {
    let disposition = content_disposition(&download.file.name);
    let content_type = HeaderValue::from_str(&download.file.media_type)
        .unwrap_or_else(|_| HeaderValue::from_static("application/octet-stream"));
    let mut response = Response::new(Full::new(Bytes::from(download.bytes)));
    *response.status_mut() = StatusCode::OK;
    response.headers_mut().insert(CONTENT_TYPE, content_type);
    response
        .headers_mut()
        .insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
        .headers_mut()
        .insert(CONTENT_DISPOSITION, disposition);
    response
}

fn content_disposition(relative_path: &str) -> HeaderValue {
    let file_name = Path::new(relative_path)
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or("download");
    let fallback = file_name
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '_') {
                character
            } else {
                '_'
            }
        })
        .collect::<String>();
    let encoded = file_name
        .as_bytes()
        .iter()
        .map(|byte| {
            if byte.is_ascii_alphanumeric() || matches!(*byte, b'.' | b'-' | b'_') {
                char::from(*byte).to_string()
            } else {
                format!("%{byte:02X}")
            }
        })
        .collect::<String>();
    HeaderValue::from_str(&format!(
        "attachment; filename=\"{fallback}\"; filename*=UTF-8''{encoded}"
    ))
    .unwrap_or_else(|_| HeaderValue::from_static("attachment; filename=\"download\""))
}

fn json_response<T: Serialize>(status: StatusCode, value: &T) -> HttpResponse {
    match serde_json::to_vec(value) {
        Ok(body) => response(status, "application/json; charset=utf-8", body),
        Err(error) => error_response(ApiError {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            message: format!("응답을 직렬화하지 못했습니다: {error}"),
        }),
    }
}

fn json_value_response(status: StatusCode, value: Value) -> HttpResponse {
    json_response(status, &value)
}

fn error_response(error: ApiError) -> HttpResponse {
    json_response(error.status, &json!({ "error": error.message }))
}

fn response(status: StatusCode, content_type: &'static str, body: Vec<u8>) -> HttpResponse {
    let mut response = Response::new(Full::new(Bytes::from(body)));
    *response.status_mut() = status;
    let headers = response.headers_mut();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static(content_type));
    headers.insert(X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    headers.insert(REFERRER_POLICY, HeaderValue::from_static("no-referrer"));
    headers.insert(
        CONTENT_SECURITY_POLICY,
        HeaderValue::from_static(
            "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'",
        ),
    );
    response
}

#[derive(Debug, Deserialize)]
struct RequestEnvelope<T> {
    request: T,
}

#[derive(Debug, Deserialize)]
struct IdArg {
    id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChatInputFileArg {
    chat_id: String,
    attachment_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChatIdArg {
    chat_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct IdempotencyKeyArg {
    idempotency_key: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StopProviderChatsArg {
    provider: ProviderId,
    /// 감사 기록에는 전체 인자 해시가 남으므로 별도로 사용하지 않는다.
    #[serde(default)]
    #[allow(dead_code)]
    reason: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProviderArg {
    provider: ProviderId,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkflowIdArg {
    workflow_id: String,
}

#[derive(Debug, Deserialize)]
struct WorkflowContractEnvelope {
    request: crate::system_workflows::SystemWorkflowContract,
}

fn workflow_registry(app_data_dir: &Path) -> crate::system_workflows::SystemWorkflowRegistry {
    crate::system_workflows::SystemWorkflowRegistry::new(app_data_dir.to_path_buf())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AccountIdArg {
    account_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TailscaleServiceArg {
    enabled: bool,
    #[serde(default)]
    replace_existing: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RegisterCurrentProviderAccountArg {
    source: ProviderId,
    display_name: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BeginProviderAccountLoginArg {
    source: ProviderId,
    account_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FinishProviderAccountLoginArg {
    login_id: String,
    display_name: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LoginIdArg {
    login_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetProviderAccountDisabledArg {
    account_id: String,
    disabled: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetProviderAccountAutoSwitchArg {
    account_id: String,
    auto_switch: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetAutoSwitchResumeArg {
    enabled: bool,
}

#[derive(Debug, Deserialize)]
struct NameArg {
    name: String,
}

#[derive(Debug, Deserialize)]
struct MenuArg {
    menu: TranslationMenu,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TranslationDetailArg {
    menu: TranslationMenu,
    resource_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RootIdArg {
    root_id: String,
}

#[derive(Debug, Deserialize)]
struct SessionRequest {
    source: ProviderId,
    id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionDetailRequest {
    source: ProviderId,
    id: String,
    #[serde(default)]
    transcript_limit: SessionTranscriptLimit,
    #[serde(default)]
    transcript_before_index: Option<usize>,
    #[serde(default)]
    cursor: Option<String>,
    #[serde(default)]
    page_size: Option<usize>,
    #[serde(default)]
    from: Option<i64>,
    #[serde(default)]
    to: Option<i64>,
    #[serde(default)]
    turn_start: Option<usize>,
    #[serde(default)]
    turn_end: Option<usize>,
}

impl SessionDetailRequest {
    fn requests_page(&self) -> bool {
        self.cursor.is_some()
            || self.page_size.is_some()
            || self.from.is_some()
            || self.to.is_some()
            || self.turn_start.is_some()
            || self.turn_end.is_some()
    }

    fn into_page_request(self) -> SessionTranscriptPageRequest {
        SessionTranscriptPageRequest {
            source: self.source,
            id: self.id,
            cursor: self.cursor,
            page_size: self.page_size,
            from: self.from,
            to: self.to,
            turn_start: self.turn_start,
            turn_end: self.turn_end,
        }
    }
}

#[derive(Debug, Deserialize)]
struct SessionLinkedFileRequest {
    source: ProviderId,
    id: String,
    href: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChatLinkedFileRequest {
    chat_id: String,
    href: String,
}

#[derive(Debug, Deserialize)]
struct ProviderOptionsRequest {
    source: ProviderId,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProposeChatSettingsSchemaRequest {
    source: ProviderId,
    #[serde(default)]
    fields: Vec<ChatSettingField>,
}

#[derive(Debug, Deserialize)]
struct ProfileArg {
    profile: ChatProfile,
}

#[derive(Debug, Deserialize)]
struct UpdateSessionMetaRequest {
    source: ProviderId,
    id: String,
    patch: SessionMetaPatch,
}

#[derive(Debug, Deserialize)]
struct CreateSessionFolderRequest {
    name: String,
    color: String,
}

#[derive(Debug, Deserialize)]
struct UpdateSessionFolderRequest {
    id: String,
    name: Option<String>,
    color: Option<String>,
}

#[derive(Debug, Deserialize)]
struct UpdateScheduledRequest {
    id: String,
    input: ScheduledRequestInput,
}

#[derive(Debug, Deserialize)]
struct SetScheduleEnabledRequest {
    id: String,
    enabled: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CancelScheduledRunArg {
    run_id: String,
    reason: Option<String>,
}

#[derive(Debug, Deserialize)]
struct CancelAndRecoverScheduledRunArg {
    request: crate::ProviderTransitionRecoveryRequest,
    reason: Option<String>,
}

#[derive(Debug, Deserialize)]
struct PausedArg {
    paused: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ArtifactRequest {
    conversation_id: String,
    root_name: String,
    name: String,
}

#[derive(Debug, Deserialize)]
struct AddDocRootRequest {
    name: String,
    path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DocRequest {
    root_id: String,
    relative_path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DocLinkedFileRequest {
    root_id: String,
    current_path: String,
    href: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveDocRequest {
    root_id: String,
    relative_path: String,
    content: String,
    expected_modified_at: Option<i64>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn test_session_catalog(data: &Path, home: &Path) -> SessionCatalog {
        SessionCatalog::open_with_home(data.to_path_buf(), home.to_path_buf())
            .expect("session catalog")
    }

    fn test_translations(data: &Path, home: &Path) -> TranslationSupervisor {
        TranslationSupervisor::new(data.to_path_buf(), test_session_catalog(data, home))
            .expect("translation supervisor")
    }

    #[test]
    fn validates_exact_tailnet_host() {
        assert!(validate_tailscale_host("device.example.ts.net").is_ok());
        assert!(validate_tailscale_host("https://device.example.ts.net").is_err());
        assert!(validate_tailscale_host("example.com").is_err());
    }

    #[test]
    fn gzip_acceptance_honors_explicit_quality() {
        let mut headers = HeaderMap::new();
        headers.insert(ACCEPT_ENCODING, HeaderValue::from_static("br, gzip;q=1.0"));
        assert!(accepts_gzip(&headers));
        headers.insert(ACCEPT_ENCODING, HeaderValue::from_static("*;q=1, gzip;q=0"));
        assert!(!accepts_gzip(&headers));
    }

    #[tokio::test]
    async fn large_text_response_is_gzipped_without_changing_content() {
        let original =
            serde_json::to_vec(&json!({ "items": vec!["반복 내용"; 1_000] })).expect("json body");
        let compressed = maybe_gzip_response(
            response(StatusCode::OK, "application/json", original.clone()),
            true,
        )
        .await;
        assert_eq!(
            compressed.headers().get(CONTENT_ENCODING),
            Some(&HeaderValue::from_static("gzip"))
        );
        assert_eq!(
            compressed.headers().get(VARY),
            Some(&HeaderValue::from_static("Accept-Encoding"))
        );
        let bytes = compressed
            .into_body()
            .collect()
            .await
            .expect("compressed body")
            .to_bytes();
        let mut decoder = flate2::read::GzDecoder::new(bytes.as_ref());
        let mut decoded = Vec::new();
        decoder.read_to_end(&mut decoded).expect("gzip body");
        assert_eq!(decoded, original);
    }

    #[test]
    fn linked_file_download_uses_attachment_headers_and_unicode_filename() {
        let response = linked_file_download_response(LinkedFileDownload {
            relative_path: "context/db/암호화대상_DB컬럼_20260807.xlsx".to_owned(),
            bytes: vec![0x50, 0x4b, 0x03, 0x04],
            size_bytes: 4,
        });

        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers().get(CONTENT_TYPE),
            Some(&HeaderValue::from_static(
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            ))
        );
        assert_eq!(
            response.headers().get(CACHE_CONTROL),
            Some(&HeaderValue::from_static("no-store"))
        );
        let disposition = response
            .headers()
            .get(CONTENT_DISPOSITION)
            .and_then(|value| value.to_str().ok())
            .expect("content disposition");
        assert!(disposition.starts_with("attachment;"));
        assert!(disposition.contains("filename*=UTF-8''%EC%95%94%ED%98%B8%ED%99%94"));
    }

    #[test]
    fn page_security_policy_allows_local_blob_image_previews() {
        let response = response(StatusCode::OK, "text/html", Vec::new());
        let policy = response
            .headers()
            .get(CONTENT_SECURITY_POLICY)
            .and_then(|value| value.to_str().ok())
            .expect("content security policy");
        assert!(policy.contains("img-src 'self' data: blob:"));
    }

    #[test]
    fn access_handshake_exposes_remote_api_protocol_version() {
        let store_id = "7cb5018a-4a90-438a-a2c4-d1fd5c660cec";
        let value = serde_json::to_value(AccessStatus {
            protocol_version: REMOTE_API_PROTOCOL_VERSION,
            store_id,
            backend_port: 4178,
            mode: "local",
            remote: false,
            writable: true,
        })
        .expect("access status");
        assert_eq!(
            value.get("protocolVersion").and_then(Value::as_u64),
            Some(u64::from(REMOTE_API_PROTOCOL_VERSION))
        );
        assert_eq!(value.get("storeId").and_then(Value::as_str), Some(store_id));
        assert_eq!(value.get("backendPort").and_then(Value::as_u64), Some(4178));
    }

    #[test]
    fn local_ui_cors_preflight_uses_an_exact_origin_and_header_allowlist() {
        let access = RequestAccess {
            remote: false,
            writable: true,
        };
        let mut headers = HeaderMap::new();
        headers.insert(ORIGIN, HeaderValue::from_static("http://localhost:1420"));
        headers.insert(
            ACCESS_CONTROL_REQUEST_METHOD,
            HeaderValue::from_static("POST"),
        );
        headers.insert(
            ACCESS_CONTROL_REQUEST_HEADERS,
            HeaderValue::from_static("content-type, x-chat-id, x-file-name, x-file-type"),
        );
        let origin = local_ui_cors_origin(&headers, access, 4178);
        let response = apply_local_ui_cors(local_ui_cors_preflight(&headers, access, 4178), origin);
        assert_eq!(response.status(), StatusCode::NO_CONTENT);
        assert_eq!(
            response.headers().get(ACCESS_CONTROL_ALLOW_ORIGIN),
            Some(&HeaderValue::from_static("http://localhost:1420"))
        );
        assert_eq!(
            response.headers().get(ACCESS_CONTROL_ALLOW_METHODS),
            Some(&HeaderValue::from_static("GET, POST, OPTIONS"))
        );
        assert_eq!(
            response.headers().get(ACCESS_CONTROL_EXPOSE_HEADERS),
            Some(&HeaderValue::from_static("Content-Disposition"))
        );

        headers.insert(ORIGIN, HeaderValue::from_static("http://localhost:1421"));
        assert_eq!(
            local_ui_cors_preflight(&headers, access, 4178).status(),
            StatusCode::FORBIDDEN
        );

        headers.insert(ORIGIN, HeaderValue::from_static("http://localhost:1420"));
        headers.insert(
            ACCESS_CONTROL_REQUEST_HEADERS,
            HeaderValue::from_static("authorization"),
        );
        assert_eq!(
            local_ui_cors_preflight(&headers, access, 4178).status(),
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            local_ui_cors_preflight(
                &headers,
                RequestAccess {
                    remote: true,
                    writable: true,
                },
                4178,
            )
            .status(),
            StatusCode::FORBIDDEN
        );

        headers.insert(
            ORIGIN,
            HeaderValue::from_static("https://malicious.example"),
        );
        assert!(authorize_local_api_origin(&headers, "/api/invoke/put_doc", 4178, access).is_err());
        headers.insert(ORIGIN, HeaderValue::from_static("http://127.0.0.1:4178"));
        assert!(authorize_local_api_origin(&headers, "/api/invoke/put_doc", 4178, access).is_ok());
        headers.remove(ORIGIN);
        assert!(authorize_local_api_origin(&headers, "/api/invoke/put_doc", 4178, access).is_ok());

        headers.insert(CONTENT_TYPE, HeaderValue::from_static("text/plain"));
        assert!(!has_json_content_type(&headers));
        headers.insert(
            CONTENT_TYPE,
            HeaderValue::from_static("application/json; charset=utf-8"),
        );
        assert!(has_json_content_type(&headers));
    }

    #[test]
    fn classifies_write_commands() {
        assert!(is_write_command("put_doc"));
        assert!(is_write_command("patch_session_meta"));
        assert!(is_write_command("create_session_folder"));
        assert!(is_write_command("delete_session_folder"));
        assert!(is_write_command("set_system_automation_settings"));
        assert!(is_write_command("request_system_language"));
        assert!(is_write_command("retry_ui_translation"));
        assert!(is_write_command("cancel_ui_translation"));
        assert!(is_write_command("retry_menu_translation"));
        assert!(is_write_command("reset_menu_translation"));
        assert!(is_write_command("cancel_scheduled_run"));
        assert!(is_write_command("recover_provider_transition"));
        assert!(is_write_command("cancel_and_recover_scheduled_run"));
        assert!(is_write_command("mark_chat_attention_read"));
        assert!(is_write_command("mark_all_chat_attention_read"));
        assert!(is_write_command("clear_read_chat_attention"));
        assert!(is_write_command("dismiss_chat_attention"));
        assert!(is_write_command("remove_chat_input_file"));
        assert!(is_write_command("register_current_provider_account"));
        assert!(is_write_command("begin_provider_account_login"));
        assert!(is_write_command("finish_provider_account_login"));
        assert!(is_write_command("cancel_provider_account_login"));
        assert!(is_write_command("revalidate_provider_account_credential"));
        assert!(is_write_command("set_default_provider_account"));
        assert!(is_write_command("set_active_provider_account"));
        assert!(is_write_command("set_provider_account_disabled"));
        assert!(is_write_command("set_provider_account_auto_switch"));
        assert!(is_write_command("set_auto_switch_resume"));
        // Tailscale Serve 대상 변경은 원격 write 모드에서만 허용되어야 한다.
        assert!(is_write_command("set_tailscale_service_enabled"));
        assert!(!is_write_command("get_tailscale_service_status"));
        assert!(is_write_command("delete_provider_account"));
        assert!(!is_write_command("get_manager_snapshot"));
        assert!(!is_write_command("get_live_chats"));
        assert!(!is_write_command("get_menu_translations"));
    }

    #[test]
    fn parses_chat_reattach_message() {
        let message = Message::text(r#"{"type":"attach","chatId":"chat-123"}"#);
        let parsed = parse_chat_message(message).expect("attach message");
        assert!(matches!(
            parsed,
            ChatClientMessage::Attach { chat_id } if chat_id == "chat-123"
        ));
    }

    #[test]
    fn parses_chat_send_with_attachment_ids() {
        let message = Message::text(
            r#"{"type":"send","text":"검토해줘","steer":false,"attachmentIds":["file-1"]}"#,
        );
        let parsed = parse_chat_message(message).expect("send message");
        assert!(matches!(
            parsed,
            ChatClientMessage::Send { text, steer: false, attachment_ids }
                if text == "검토해줘" && attachment_ids == ["file-1"]
        ));
    }

    #[test]
    fn parses_account_login_terminal_open_message() {
        let message = Message::text(
            r#"{"type":"open","request":{"loginId":"login-123","cols":120,"rows":30}}"#,
        );
        let parsed = parse_terminal_message(message).expect("account login terminal open");
        assert!(matches!(
            parsed,
            TerminalClientMessage::Open {
                request: RemoteTerminalOpenRequest::AccountLogin(TerminalAccountLoginRequest {
                    login_id,
                    cols: 120,
                    rows: 30,
                })
            } if login_id == "login-123"
        ));
    }

    #[test]
    fn setup_terminal_open_is_parsed_and_restricted_to_loopback_access() {
        let message =
            Message::text(r#"{"type":"open","request":{"source":"codex","cols":120,"rows":30}}"#);
        let parsed = parse_terminal_message(message).expect("setup terminal open");
        let TerminalClientMessage::Open { request } = parsed else {
            panic!("expected terminal open request");
        };
        assert!(matches!(
            &request,
            RemoteTerminalOpenRequest::Setup(TerminalSetupRequest {
                source: ProviderId::Codex,
                cols: 120,
                rows: 30,
            })
        ));
        assert!(authorize_terminal_open_request(
            &request,
            RequestAccess {
                remote: false,
                writable: true,
            },
        )
        .is_ok());
        assert!(authorize_terminal_open_request(
            &request,
            RequestAccess {
                remote: true,
                writable: true,
            },
        )
        .is_err());
    }

    #[test]
    fn remote_terminal_requires_write_mode_and_exact_origin() {
        let directory = tempdir().expect("temporary directory");
        fs::write(directory.path().join("index.html"), "ok").expect("index file");
        let chats = ChatSupervisor::new();
        let data = directory.path().join("data");
        let scheduler =
            SchedulerSupervisor::new(data.clone(), chats.clone()).expect("scheduler supervisor");
        let config = Config {
            port: 4178,
            store_id: "7cb5018a-4a90-438a-a2c4-d1fd5c660cec".to_owned(),
            static_dir: directory.path().to_path_buf(),
            app_data_dir: data.clone(),
            tailscale_host: Some("device.example.ts.net".to_owned()),
            tailscale_user: Some("user@example.com".to_owned()),
            remote_write: true,
            session_catalog: test_session_catalog(&data, &directory.path().join("home")),
            terminals: TerminalSupervisor::new(&data).expect("terminal supervisor"),
            chats,
            scheduler,
            translations: test_translations(&data, &directory.path().join("home")),
            _system_mcp: None,
        };
        let mut headers = HeaderMap::new();
        headers.insert(ORIGIN, HeaderValue::from_static("http://localhost:1420"));
        assert!(authorize_terminal(
            &headers,
            &config,
            RequestAccess {
                remote: false,
                writable: true,
            },
        )
        .is_ok());
        headers.insert(
            ORIGIN,
            HeaderValue::from_static("https://untrusted.example.com"),
        );
        assert!(authorize_terminal(
            &headers,
            &config,
            RequestAccess {
                remote: false,
                writable: true,
            },
        )
        .is_err());
        headers.insert(
            ORIGIN,
            HeaderValue::from_static("https://device.example.ts.net"),
        );
        assert!(authorize_terminal(
            &headers,
            &config,
            RequestAccess {
                remote: true,
                writable: true,
            },
        )
        .is_ok());

        headers.insert(
            ORIGIN,
            HeaderValue::from_static("https://other.example.ts.net"),
        );
        assert!(authorize_terminal(
            &headers,
            &config,
            RequestAccess {
                remote: true,
                writable: true,
            },
        )
        .is_err());
        assert!(authorize_terminal(
            &HeaderMap::new(),
            &config,
            RequestAccess {
                remote: true,
                writable: false,
            },
        )
        .is_err());
    }

    #[test]
    fn validates_configurable_remote_port_range() {
        assert!(validate_remote_port(1024).is_ok());
        assert!(validate_remote_port(65535).is_ok());
        assert!(validate_remote_port(1023).is_err());
        assert_eq!(
            StoredRemoteAccessSettings::default().port,
            DEFAULT_REMOTE_ACCESS_PORT
        );
    }

    #[test]
    fn standalone_shutdown_flag_is_opt_in_and_eof_reader_drains_input() {
        let directory = tempdir().expect("temporary directory");
        fs::write(directory.path().join("index.html"), "ok").expect("index file");
        let base_args = vec![
            "--static-dir".to_owned(),
            directory.path().to_string_lossy().into_owned(),
            "--app-data-dir".to_owned(),
            directory.path().join("data").to_string_lossy().into_owned(),
        ];
        let default = StandaloneServerOptions::from_args(base_args.clone().into_iter())
            .expect("standalone defaults");
        assert!(!default.shutdown_on_stdin_eof);
        // 저장소 인계 대기는 데스크톱 셸이 명시할 때만 켜진다.
        assert!(!default.await_store_handover);
        assert!(
            StandaloneServerOptions::from_args(
                base_args
                    .iter()
                    .cloned()
                    .chain(["--await-store-handover".to_owned()])
            )
            .expect("handover option")
            .await_store_handover
        );

        let mut invalid_port_args = base_args.clone();
        invalid_port_args.extend(["--port".to_owned(), "1023".to_owned()]);
        assert!(StandaloneServerOptions::from_args(invalid_port_args.into_iter()).is_err());

        let mut child_args = base_args;
        child_args.push("--shutdown-on-stdin-eof".to_owned());
        let child = StandaloneServerOptions::from_args(child_args.into_iter())
            .expect("child standalone options");
        assert!(child.shutdown_on_stdin_eof);
        wait_for_reader_eof(std::io::Cursor::new(b"parent-control-data"))
            .expect("reader reaches EOF");
    }

    #[cfg(unix)]
    #[test]
    fn linux_app_data_prefers_an_absolute_xdg_data_home() {
        assert_eq!(
            linux_app_data_dir(Some("/var/lib/example".into()), Some("/home/user".into()))
                .expect("XDG app data"),
            PathBuf::from("/var/lib/example/com.shinc.agentmanager")
        );
        assert_eq!(
            linux_app_data_dir(Some("relative/path".into()), Some("/home/user".into()))
                .expect("HOME fallback"),
            PathBuf::from("/home/user/.local/share/com.shinc.agentmanager")
        );
    }

    #[test]
    fn remote_settings_round_trip_preserves_port_and_ownership() {
        let directory = tempdir().expect("temporary directory");
        let settings = StoredRemoteAccessSettings {
            schema_version: SETTINGS_SCHEMA_VERSION,
            enabled: true,
            port: 5217,
            managed_serve: true,
        };
        save_remote_settings(directory.path(), &settings).expect("save settings");
        let loaded = load_remote_settings(directory.path()).expect("load settings");
        assert!(loaded.enabled);
        assert_eq!(loaded.port, 5217);
        assert!(loaded.managed_serve);
    }

    #[test]
    fn tailscale_backend_launch_round_trip_requires_matching_port() {
        let directory = tempdir().expect("temporary directory");
        let identity = TailscaleIdentity {
            executable: PathBuf::from("tailscale"),
            host: "device.example.ts.net".to_owned(),
            login: "user@example.com".to_owned(),
        };
        save_tailscale_backend_launch(directory.path(), 5217, &identity)
            .expect("save Tailscale backend launch");

        assert_eq!(
            load_tailscale_backend_launch(directory.path(), 5217).expect("load matching launch"),
            Some(TailscaleBackendLaunch {
                host: "device.example.ts.net".to_owned(),
                login: "user@example.com".to_owned(),
                remote_write: true,
            })
        );
        assert_eq!(
            load_tailscale_backend_launch(directory.path(), 54178)
                .expect("ignore a launch for another port"),
            None
        );

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(directory.path().join(TAILSCALE_BACKEND_FILE_NAME))
                .expect("launch metadata")
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(mode, 0o600);
        }

        clear_tailscale_backend_launch(directory.path()).expect("clear launch");
        assert_eq!(
            load_tailscale_backend_launch(directory.path(), 5217).expect("load cleared launch"),
            None
        );
    }

    #[test]
    fn parses_current_tailscale_identity_and_trims_dns_dot() {
        let json = br#"{
            "BackendState":"Running",
            "Self":{"DNSName":"device.example.ts.net.","UserID":42,"Online":true},
            "User":{"42":{"LoginName":"user@example.com"}}
        }"#;
        let identity =
            parse_tailscale_identity(PathBuf::from("tailscale"), json).expect("tailscale identity");
        assert_eq!(identity.host, "device.example.ts.net");
        assert_eq!(identity.login, "user@example.com");
    }

    #[test]
    fn parses_matching_serve_proxy_without_touching_other_paths() {
        let json = br#"{
            "Web":{"device.example.ts.net:443":{"Handlers":{
                "/":{"Proxy":"http://127.0.0.1:5217"},
                "/other":{"Proxy":"http://127.0.0.1:9000"}
            }}}
        }"#;
        assert_eq!(
            parse_serve_target("device.example.ts.net", json).expect("serve target"),
            Some("http://127.0.0.1:5217".to_owned())
        );
    }

    #[test]
    fn starts_and_stops_loopback_remote_server() {
        let directory = tempdir().expect("temporary directory");
        fs::write(directory.path().join("index.html"), "ok").expect("index file");
        let reservation = StdTcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("free port");
        let port = reservation.local_addr().expect("local address").port();
        drop(reservation);
        let data = directory.path().join("data");
        let terminals = TerminalSupervisor::new(&data).expect("terminal supervisor");
        let chats = ChatSupervisor::with_app_data_dir(data.clone()).expect("chat supervisor");
        let scheduler =
            SchedulerSupervisor::new(data.clone(), chats.clone()).expect("scheduler supervisor");
        let server = spawn_remote_server(Config {
            port,
            store_id: "7cb5018a-4a90-438a-a2c4-d1fd5c660cec".to_owned(),
            static_dir: directory.path().to_path_buf(),
            app_data_dir: data.clone(),
            tailscale_host: Some("device.example.ts.net".to_owned()),
            tailscale_user: Some("user@example.com".to_owned()),
            remote_write: true,
            session_catalog: test_session_catalog(&data, &directory.path().join("home")),
            terminals,
            chats,
            scheduler,
            translations: test_translations(&data, &directory.path().join("home")),
            _system_mcp: None,
        })
        .expect("remote server");
        let mut server = Some(server);
        verify_local_access(port, "7cb5018a-4a90-438a-a2c4-d1fd5c660cec")
            .expect("local access verification");
        assert!(verify_local_access(port, "0c77e0b5-85ee-4477-97e7-83e617adad5b").is_err());
        stop_running_server(&mut server);
    }

    #[test]
    fn occupied_remote_port_is_reported_without_killing_listener() {
        let directory = tempdir().expect("temporary directory");
        fs::write(directory.path().join("index.html"), "ok").expect("index file");
        let occupied = StdTcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("occupied port");
        let port = occupied.local_addr().expect("local address").port();
        let data = directory.path().join("data");
        let terminals = TerminalSupervisor::new(&data).expect("terminal supervisor");
        let chats = ChatSupervisor::with_app_data_dir(data.clone()).expect("chat supervisor");
        let scheduler =
            SchedulerSupervisor::new(data.clone(), chats.clone()).expect("scheduler supervisor");
        let result = spawn_remote_server(Config {
            port,
            store_id: "7cb5018a-4a90-438a-a2c4-d1fd5c660cec".to_owned(),
            static_dir: directory.path().to_path_buf(),
            app_data_dir: data.clone(),
            tailscale_host: Some("device.example.ts.net".to_owned()),
            tailscale_user: Some("user@example.com".to_owned()),
            remote_write: true,
            session_catalog: test_session_catalog(&data, &directory.path().join("home")),
            terminals,
            chats,
            scheduler,
            translations: test_translations(&data, &directory.path().join("home")),
            _system_mcp: None,
        });
        assert!(matches!(result, Err(CoreError::Conflict(_))));
        assert_eq!(
            occupied.local_addr().expect("listener remains").port(),
            port
        );
    }

    #[test]
    fn standalone_server_binds_before_creating_backend_state() {
        let directory = tempdir().expect("temporary directory");
        let static_dir = directory.path().join("static");
        fs::create_dir(&static_dir).expect("static directory");
        fs::write(static_dir.join("index.html"), "ok").expect("index file");
        let app_data_dir = directory.path().join("app-data");
        let occupied = StdTcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("occupied port");
        let port = occupied.local_addr().expect("local address").port();

        let result = run_remote_server_from_args(
            vec![
                "--port".to_owned(),
                port.to_string(),
                "--static-dir".to_owned(),
                static_dir.to_string_lossy().into_owned(),
                "--app-data-dir".to_owned(),
                app_data_dir.to_string_lossy().into_owned(),
            ]
            .into_iter(),
        );

        assert!(result.is_err());
        assert!(!app_data_dir.exists());
        assert_eq!(
            occupied.local_addr().expect("listener remains").port(),
            port
        );
    }

    #[test]
    fn standalone_server_rejects_an_owned_store_before_opening_state() {
        let directory = tempdir().expect("temporary directory");
        let static_dir = directory.path().join("static");
        fs::create_dir(&static_dir).expect("static directory");
        fs::write(static_dir.join("index.html"), "ok").expect("index file");
        let app_data_dir = directory.path().join("app-data");
        let _owner = crate::BackendOwnershipLease::acquire(&app_data_dir).expect("first owner");
        let reservation = StdTcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("free port");
        let port = reservation.local_addr().expect("local address").port();
        drop(reservation);

        let error = run_remote_server_from_args(
            vec![
                "--port".to_owned(),
                port.to_string(),
                "--static-dir".to_owned(),
                static_dir.to_string_lossy().into_owned(),
                "--app-data-dir".to_owned(),
                app_data_dir.to_string_lossy().into_owned(),
            ]
            .into_iter(),
        )
        .expect_err("second backend must be rejected")
        .to_string();

        assert!(error.contains("백엔드가 이미 실행 중입니다"));
        assert!(!error.contains(&app_data_dir.to_string_lossy().into_owned()));
        assert!(!app_data_dir.join("account-storage-reset-v1.json").exists());
        assert!(!app_data_dir.join("provider-accounts-v1.json").exists());
    }
}
