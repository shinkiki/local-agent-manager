//! C9-9~C9-12: SSH 인증키별 접속 엔드포인트와 에이전트 사용 여부.
//!
//! # 왜 별도 저장소인가
//!
//! 엔드포인트는 공개키에서 파생되지 않는 기기 단위 메타데이터다. 메모(C9-8)와 같은 이유로
//! `~/.ssh`가 아니라 앱 데이터에만 둔다(G7). `~/.ssh/config`를 고쳐 넣지 않는 것도 같은
//! 이유다 — 그 파일은 사용자와 다른 도구가 함께 쓰는 사용자 소유 설정이고, 여기서 필요한
//! 것은 "이 키로 어디에 붙고, 에이전트에게 열어 줄 것인가"라는 앱 쪽 결정뿐이다.
//!
//! # 에이전트에게 열어 주는 방법
//!
//! 앱은 에이전트를 대신해 원격 명령을 실행하지 않는다. 켜 둔 엔드포인트 목록을 실행 파일
//! 하나(`<CLI> ssh list`)로 내려 주고, 에이전트는 자기 셸에서 그 `ssh` 인자 그대로 접속한다.
//! 개인키는 앱도 에이전트도 열지 않는다 — `ssh`에 경로만 넘긴다(G4). 목록에는 사용자가 켠
//! 키만 나오므로, 토글이 곧 접근 허용 결정이다.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::clock::now_ms;
use crate::json_store::{JsonStore, SchemaVersioned};
use crate::ssh_keys::{
    private_key_present, resolve_public_key, validate_fingerprint, SshKeyIssue, SshKeyRef,
    SshKeysSnapshot,
};
use crate::user_home::home_dir;
use crate::CoreError;

const ENDPOINTS_VERSION: u32 = 1;
/// 엔드포인트도 메모와 같은 기기 단위 메타데이터라 앱 데이터에만 둔다(G7).
const ENDPOINTS_STORE: JsonStore = JsonStore {
    file: "ssh-key-endpoints-v1.json",
    lock_file: "ssh-key-endpoints-v1.lock",
    label: "SSH 엔드포인트 저장소",
    version: ENDPOINTS_VERSION,
};

const MAX_ENDPOINTS: usize = 512;
const MAX_HOST_CHARS: usize = 253;
const MAX_USER_CHARS: usize = 64;
const DEFAULT_SSH_PORT: u16 = 22;
/// 확인 연결이 매달리지 않게 하는 상한. `ConnectTimeout`이 먼저 끊고, 그래도 살아 있으면
/// 실행 자체를 끊는다.
const CHECK_CONNECT_TIMEOUT_SECONDS: u32 = 10;
const CHECK_TIMEOUT: Duration = Duration::from_secs(20);
/// 확인은 원격에서 아무것도 바꾸지 않는 고정 명령 하나만 돌린다. 사용자·에이전트가 준
/// 문자열을 원격에서 실행하는 경로는 이 어댑터에 없다(G9).
const CHECK_REMOTE_COMMAND: &str = "true";
const MAX_CHECK_MESSAGE_CHARS: usize = 400;
const MAX_COMMAND_RULES: usize = 64;
const MAX_COMMAND_RULE_CHARS: usize = 120;

/// 새 연결 서버를 만들 때 화면이 채워 넣는 기본 허용 명령. 상태를 읽는 점검 명령만 담아,
/// 사용자가 지우거나 늘리기 전에는 에이전트가 서버를 바꾸지 못하게 한다.
const DEFAULT_ALLOWED_COMMANDS: &[&str] = &[
    "ls",
    "cat",
    "tail",
    "head",
    "grep",
    "find",
    "df",
    "du",
    "free",
    "uptime",
    "ps",
    "whoami",
    "hostname",
    "uname",
    "date",
    "systemctl status",
    "journalctl",
    "docker ps",
    "docker logs",
    "git status",
    "git log",
    "git pull",
];

/// 기본 차단 명령. 되돌리기 어려운 조작과 자격증명 읽기를 앞머리로 잡는다. 허용 목록보다
/// 우선하므로 `cat`이 허용돼 있어도 `cat /etc/shadow`는 걸린다.
const DEFAULT_DENIED_COMMANDS: &[&str] = &[
    "rm -rf",
    "shutdown",
    "reboot",
    "poweroff",
    "halt",
    "mkfs",
    "dd",
    "fdisk",
    "parted",
    "passwd",
    "useradd",
    "userdel",
    "visudo",
    "iptables -F",
    "systemctl mask",
    "docker system prune",
    "history -c",
    "cat /etc/shadow",
    "cat ~/.ssh/id_",
];

/// 지문 하나에 묶인 접속 지점. 저장본과 화면 표시가 같은 모양이라 한 타입을 함께 쓴다.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SshEndpointView {
    pub host: String,
    pub port: u16,
    pub user: String,
    /// 에이전트에게 이 키를 열어 줄지. 꺼져 있으면 `<CLI> ssh list`에 나오지 않는다.
    pub agent_enabled: bool,
    /// 에이전트가 이 서버에서 써도 되는 명령. 비어 있으면 차단 목록에 걸리지 않는 한 전부다.
    #[serde(default)]
    pub allowed_commands: Vec<String>,
    /// 어떤 경우에도 쓰지 않을 명령. 허용 목록보다 우선한다.
    #[serde(default)]
    pub denied_commands: Vec<String>,
    pub updated_at: i64,
}

/// 명령 목록을 읽는 방식. 허용 목록이 비면 차단 목록만 적용된다.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SshCommandPolicyMode {
    /// 허용 목록에 있는 명령만 쓴다.
    Allowlist,
    /// 차단 목록에 걸리지 않으면 쓴다.
    DenylistOnly,
}

impl SshCommandPolicyMode {
    pub const ALL: [Self; 2] = [Self::Allowlist, Self::DenylistOnly];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Allowlist => "allowlist",
            Self::DenylistOnly => "denylistOnly",
        }
    }

    /// 허용 목록 모드인지 여부.
    pub fn is_allowlist(self) -> bool {
        matches!(self, Self::Allowlist)
    }

    /// 차단 전용 모드인지 여부.
    pub fn is_denylist_only(self) -> bool {
        matches!(self, Self::DenylistOnly)
    }
}

impl std::fmt::Display for SshCommandPolicyMode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

impl std::str::FromStr for SshCommandPolicyMode {
    type Err = CoreError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.trim() {
            "allowlist" => Ok(Self::Allowlist),
            "denylistOnly" | "denylist_only" => Ok(Self::DenylistOnly),
            _ => Err(CoreError::InvalidInput(format!(
                "알 수 없는 SSH 명령 정책 모드입니다: {s}. allowlist|denylistOnly 중 하나를 쓰세요"
            ))),
        }
    }
}

/// 화면이 새 연결 서버에 미리 채워 넣는 기본값. 앱과 스킬이 같은 목록을 보도록 백엔드가
/// 소유하고, 화면은 이 값을 그대로 편집한다.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SshCommandPolicyDefaults {
    pub allowed: Vec<String>,
    pub denied: Vec<String>,
}

pub fn command_policy_defaults() -> SshCommandPolicyDefaults {
    SshCommandPolicyDefaults {
        allowed: DEFAULT_ALLOWED_COMMANDS
            .iter()
            .map(|value| (*value).to_owned())
            .collect(),
        denied: DEFAULT_DENIED_COMMANDS
            .iter()
            .map(|value| (*value).to_owned())
            .collect(),
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetSshKeyEndpointRequest {
    pub fingerprint: String,
    /// 빈 값이면 저장된 엔드포인트를 지운다.
    #[serde(default)]
    pub host: String,
    #[serde(default)]
    pub port: Option<u16>,
    #[serde(default)]
    pub user: String,
    #[serde(default)]
    pub agent_enabled: bool,
    #[serde(default)]
    pub allowed_commands: Vec<String>,
    #[serde(default)]
    pub denied_commands: Vec<String>,
}

/// 연결 확인 결과. 원격에서 무엇도 바꾸지 않았고, 개인키 내용은 어느 필드에도 없다.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SshEndpointCheckReceipt {
    pub fingerprint: String,
    pub destination: String,
    pub reachable: bool,
    pub timed_out: bool,
    pub message: String,
}

/// 스킬이 읽는 목록의 한 줄. 에이전트는 이 `sshArgs`를 그대로 써서 접속한다.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentSshEndpointView {
    pub fingerprint: String,
    /// 개인키 파일 이름. 공개키는 여기에 `.pub`이 붙는다.
    pub key_file_name: String,
    pub identity_path: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub note: Option<String>,
    pub destination: String,
    pub ssh_args: Vec<String>,
    pub ssh_command: String,
    /// 명령 정책. 사용자가 이 서버에 대해 정한 규칙이므로 에이전트는 그대로 지킨다.
    pub command_policy_mode: SshCommandPolicyMode,
    pub allowed_commands: Vec<String>,
    pub denied_commands: Vec<String>,
}

/// 켜 두었지만 지금은 쓸 수 없는 항목. 조용히 빼지 않고 이유를 함께 알린다.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentSshEndpointSkip {
    pub fingerprint: String,
    pub reason: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentSshEndpointsView {
    pub schema_version: u32,
    pub endpoints: Vec<AgentSshEndpointView>,
    pub skipped: Vec<AgentSshEndpointSkip>,
    pub issues: Vec<SshKeyIssue>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SshEndpointStore {
    schema_version: u32,
    endpoints: BTreeMap<String, SshEndpointView>,
}

impl SchemaVersioned for SshEndpointStore {
    fn schema_version(&self) -> u32 {
        self.schema_version
    }
}

impl Default for SshEndpointStore {
    fn default() -> Self {
        Self {
            schema_version: ENDPOINTS_VERSION,
            endpoints: BTreeMap::new(),
        }
    }
}

/// C9-9. 지문에 묶인 접속 지점과 에이전트 사용 여부를 저장한다. 호스트가 비면 삭제다.
pub fn set_ssh_key_endpoint(
    app_data_dir: &Path,
    request: SetSshKeyEndpointRequest,
) -> Result<SshKeysSnapshot, CoreError> {
    set_ssh_key_endpoint_with(&home_dir()?, app_data_dir, &request)
}

/// C9-11. 저장된 엔드포인트로 한 번 붙어 보고 끊는다. 원격에서는 `true`만 돌린다.
pub fn check_ssh_endpoint(
    app_data_dir: &Path,
    request: SshKeyRef,
) -> Result<SshEndpointCheckReceipt, CoreError> {
    let executable = crate::providers::resolve_named_executable(&["ssh"])?;
    check_ssh_endpoint_with(&home_dir()?, app_data_dir, &executable, &request)
}

/// C9-12. 스킬이 부르는 목록. 에이전트 사용을 켠 키만 나온다.
pub fn list_agent_ssh_endpoints(app_data_dir: &Path) -> Result<AgentSshEndpointsView, CoreError> {
    list_agent_ssh_endpoints_with(&home_dir()?, app_data_dir)
}

fn set_ssh_key_endpoint_with(
    home: &Path,
    app_data_dir: &Path,
    request: &SetSshKeyEndpointRequest,
) -> Result<SshKeysSnapshot, CoreError> {
    let fingerprint = validate_fingerprint(&request.fingerprint)?.to_owned();
    let mut snapshot = crate::ssh_keys::snapshot_with_metadata(home, app_data_dir)?;
    let key = snapshot
        .keys
        .iter()
        .find(|key| key.fingerprint == fingerprint)
        .ok_or_else(|| {
            CoreError::NotFound("엔드포인트를 붙일 공개키를 ~/.ssh에서 찾지 못했습니다".to_owned())
        })?;

    let host = request.host.trim();
    let endpoint = if host.is_empty() {
        None
    } else {
        // 개인키가 없으면 이 키로는 접속 자체가 되지 않는다. 에이전트에게 켜 주는 순간
        // 실패만 하는 항목이 되므로 저장 시점에 막는다.
        if request.agent_enabled && !key.has_private_key {
            return Err(CoreError::Conflict(
                "개인키가 없는 공개키는 에이전트 사용을 켤 수 없습니다".to_owned(),
            ));
        }
        Some(SshEndpointView {
            host: validate_host(host)?.to_owned(),
            port: validate_port(request.port)?,
            user: validate_user(&request.user)?.to_owned(),
            agent_enabled: request.agent_enabled,
            allowed_commands: validate_command_rules(&request.allowed_commands, "허용")?,
            denied_commands: validate_command_rules(&request.denied_commands, "차단")?,
            updated_at: now_ms(),
        })
    };

    ENDPOINTS_STORE.with_lock(app_data_dir, || {
        let mut store: SshEndpointStore = ENDPOINTS_STORE.load_unlocked(app_data_dir)?;
        match endpoint {
            None => {
                store.endpoints.remove(&fingerprint);
            }
            Some(endpoint) => {
                if !store.endpoints.contains_key(&fingerprint)
                    && store.endpoints.len() >= MAX_ENDPOINTS
                {
                    return Err(CoreError::TooLarge(MAX_ENDPOINTS as u64));
                }
                store.endpoints.insert(fingerprint.clone(), endpoint);
            }
        }
        ENDPOINTS_STORE.save_unlocked(app_data_dir, &store)
    })?;
    attach_endpoints(&mut snapshot, app_data_dir);
    Ok(snapshot)
}

fn check_ssh_endpoint_with(
    home: &Path,
    app_data_dir: &Path,
    executable: &Path,
    request: &SshKeyRef,
) -> Result<SshEndpointCheckReceipt, CoreError> {
    let (_, public_path, view) = resolve_public_key(home, request)?;
    let endpoint = load_endpoints(app_data_dir)?
        .remove(&view.fingerprint)
        .ok_or_else(|| CoreError::NotFound("이 키에 저장된 접속 지점이 없습니다".to_owned()))?;
    let identity = public_path.with_extension("");
    if !private_key_present(&identity)? {
        return Err(CoreError::Conflict(
            "같은 이름의 개인키가 없어 접속을 확인할 수 없습니다".to_owned(),
        ));
    }

    let destination = destination(&endpoint);
    let identity = identity.to_string_lossy().into_owned();
    let port = endpoint.port.to_string();
    let connect_timeout = format!("ConnectTimeout={CHECK_CONNECT_TIMEOUT_SECONDS}");
    let mut args = connect_args(&identity, &port);
    args.extend([
        "-o".to_owned(),
        connect_timeout,
        "-o".to_owned(),
        "NumberOfPasswordPrompts=0".to_owned(),
        target(&endpoint),
        CHECK_REMOTE_COMMAND.to_owned(),
    ]);
    let borrowed = args.iter().map(String::as_str).collect::<Vec<_>>();
    let outcome = crate::cli_interface::run_capped(executable, &borrowed, CHECK_TIMEOUT)?;

    Ok(SshEndpointCheckReceipt {
        fingerprint: view.fingerprint,
        destination,
        reachable: outcome.success,
        timed_out: outcome.timed_out,
        message: check_message(outcome.success, outcome.timed_out, &outcome.stderr),
    })
}

fn list_agent_ssh_endpoints_with(
    home: &Path,
    app_data_dir: &Path,
) -> Result<AgentSshEndpointsView, CoreError> {
    let snapshot = crate::ssh_keys::snapshot_with_metadata(home, app_data_dir)?;
    let mut endpoints = Vec::new();
    let mut skipped = Vec::new();
    let mut listed = BTreeSet::new();
    for key in &snapshot.keys {
        let Some(endpoint) = key.endpoint.as_ref().filter(|value| value.agent_enabled) else {
            continue;
        };
        listed.insert(key.fingerprint.clone());
        if !key.has_private_key {
            skipped.push(AgentSshEndpointSkip {
                fingerprint: key.fingerprint.clone(),
                reason: "같은 이름의 개인키가 없어 이 키로는 접속할 수 없습니다".to_owned(),
            });
            continue;
        }
        let identity_path = Path::new(&key.path)
            .with_extension("")
            .to_string_lossy()
            .into_owned();
        let key_file_name = key
            .file_name
            .strip_suffix(".pub")
            .unwrap_or(&key.file_name)
            .to_owned();
        let mut ssh_args = connect_args(&identity_path, &endpoint.port.to_string());
        ssh_args.push(target(endpoint));
        endpoints.push(AgentSshEndpointView {
            fingerprint: key.fingerprint.clone(),
            key_file_name,
            identity_path,
            host: endpoint.host.clone(),
            port: endpoint.port,
            user: endpoint.user.clone(),
            note: key.note.clone(),
            destination: destination(endpoint),
            ssh_command: ssh_command(&ssh_args),
            ssh_args,
            command_policy_mode: if endpoint.allowed_commands.is_empty() {
                SshCommandPolicyMode::DenylistOnly
            } else {
                SshCommandPolicyMode::Allowlist
            },
            allowed_commands: endpoint.allowed_commands.clone(),
            denied_commands: endpoint.denied_commands.clone(),
        });
    }

    // 키가 지워졌는데 저장본만 남은 항목도 조용히 빼지 않는다. 사용자는 켜 두었다고
    // 알고 있으므로, 왜 안 보이는지 함께 말해야 설정 화면을 다시 열 수 있다.
    for (fingerprint, endpoint) in load_endpoints(app_data_dir)? {
        if endpoint.agent_enabled && !listed.contains(&fingerprint) {
            skipped.push(AgentSshEndpointSkip {
                fingerprint,
                reason: "이 지문의 공개키가 ~/.ssh에 없습니다".to_owned(),
            });
        }
    }

    Ok(AgentSshEndpointsView {
        schema_version: ENDPOINTS_VERSION,
        endpoints,
        skipped,
        issues: snapshot.issues,
    })
}

/// 앱 데이터의 엔드포인트를 지문으로 이어 붙인다. 메모와 같은 이유로, 읽지 못해도 키
/// 목록 자체는 보여 주고 실패는 issues로만 알린다.
pub(crate) fn attach_endpoints(snapshot: &mut SshKeysSnapshot, app_data_dir: &Path) {
    match load_endpoints(app_data_dir) {
        Ok(mut endpoints) => {
            for key in &mut snapshot.keys {
                key.endpoint = endpoints.remove(&key.fingerprint);
            }
        }
        Err(error) => snapshot.issues.push(SshKeyIssue {
            path: ENDPOINTS_STORE
                .path(app_data_dir)
                .to_string_lossy()
                .into_owned(),
            message: format!("SSH 엔드포인트 설정을 읽지 못해 접속 지점 없이 표시합니다: {error}"),
        }),
    }
}

/// 키가 사라지면 그 접속 지점도 가리킬 대상이 없다. 메모와 같은 시점에 함께 지운다.
pub(crate) fn remove_endpoint(app_data_dir: &Path, fingerprint: &str) -> Result<bool, CoreError> {
    ENDPOINTS_STORE.with_lock(app_data_dir, || {
        let mut store: SshEndpointStore = ENDPOINTS_STORE.load_unlocked(app_data_dir)?;
        if store.endpoints.remove(fingerprint).is_none() {
            return Ok(false);
        }
        ENDPOINTS_STORE.save_unlocked(app_data_dir, &store)?;
        Ok(true)
    })
}

fn load_endpoints(app_data_dir: &Path) -> Result<BTreeMap<String, SshEndpointView>, CoreError> {
    ENDPOINTS_STORE.with_lock(app_data_dir, || {
        let store: SshEndpointStore = ENDPOINTS_STORE.load_unlocked(app_data_dir)?;
        Ok(store.endpoints)
    })
}

/// 모든 접속에 공통으로 붙는 인자. 저장한 키만 쓰게 하고(`IdentitiesOnly`), 어떤 경로에서도
/// 암호 프롬프트로 멈추지 않게 한다(`BatchMode`).
fn connect_args(identity: &str, port: &str) -> Vec<String> {
    vec![
        "-i".to_owned(),
        identity.to_owned(),
        "-p".to_owned(),
        port.to_owned(),
        "-o".to_owned(),
        "IdentitiesOnly=yes".to_owned(),
        "-o".to_owned(),
        "BatchMode=yes".to_owned(),
    ]
}

/// `ssh`가 받는 목적지. IPv6 리터럴은 대괄호로 감싸야 사용자 이름과 구분된다.
fn target(endpoint: &SshEndpointView) -> String {
    if endpoint.host.contains(':') {
        format!("{}@[{}]", endpoint.user, endpoint.host)
    } else {
        format!("{}@{}", endpoint.user, endpoint.host)
    }
}

/// 사람이 읽는 표기. 포트까지 붙여 화면과 결과에서 같은 문자열을 쓴다.
fn destination(endpoint: &SshEndpointView) -> String {
    format!("{}:{}", target(endpoint), endpoint.port)
}

/// 스킬이 그대로 붙여 넣을 수 있는 한 줄. 홈 경로에 공백이 있어도 깨지지 않게 인용한다.
fn ssh_command(args: &[String]) -> String {
    let mut command = String::from("ssh");
    for argument in args {
        command.push(' ');
        command.push_str(&shell_quote(argument));
    }
    command
}

fn shell_quote(value: &str) -> String {
    if !value.is_empty()
        && value.chars().all(|character| {
            character.is_ascii_alphanumeric()
                || matches!(character, '_' | '-' | '.' | '/' | '@' | '=' | ':')
        })
    {
        return value.to_owned();
    }
    format!("'{}'", value.replace('\'', r"'\''"))
}

/// `ssh`가 남긴 문구를 그대로 옮기되 길이를 자른다. 실패 이유(호스트 키 미등록, 인증 거절,
/// 이름 해석 실패)는 사용자가 다음에 무엇을 할지 정하는 근거라 지우지 않는다.
fn check_message(success: bool, timed_out: bool, stderr: &str) -> String {
    if success {
        return "접속에 성공했습니다".to_owned();
    }
    if timed_out {
        return "정해진 시간 안에 접속하지 못했습니다".to_owned();
    }
    let detail = stderr
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join(" / ");
    if detail.is_empty() {
        return "접속하지 못했습니다".to_owned();
    }
    let detail: String = detail.chars().take(MAX_CHECK_MESSAGE_CHARS).collect();
    if detail.contains("Host key verification failed") {
        return format!(
            "{detail} — 이 호스트의 키가 known_hosts에 없습니다. 터미널에서 한 번 접속해 호스트 키를 확인한 뒤 다시 시도하세요"
        );
    }
    detail
}

/// 호스트는 그대로 `ssh` 인자가 되므로, 옵션으로 읽힐 수 있는 값과 공백을 막는다.
fn validate_host(value: &str) -> Result<&str, CoreError> {
    let value = value.trim();
    let mut characters = value.chars();
    let valid = characters
        .next()
        .is_some_and(|first| first.is_ascii_alphanumeric())
        && value.chars().count() <= MAX_HOST_CHARS
        && characters.all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '_' | ':')
        });
    if !valid {
        return Err(CoreError::InvalidInput(
            "호스트는 영문·숫자로 시작하는 253자 이하의 영문·숫자·점·하이픈·밑줄·콜론이어야 합니다"
                .to_owned(),
        ));
    }
    Ok(value)
}

fn validate_user(value: &str) -> Result<&str, CoreError> {
    let value = value.trim();
    let mut characters = value.chars();
    let valid = characters
        .next()
        .is_some_and(|first| first.is_ascii_alphanumeric() || first == '_')
        && value.chars().count() <= MAX_USER_CHARS
        && characters.all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '_')
        });
    if !valid {
        return Err(CoreError::InvalidInput(
            "사용자 이름은 영문·숫자·밑줄로 시작하는 64자 이하의 영문·숫자·점·하이픈·밑줄이어야 합니다".to_owned(),
        ));
    }
    Ok(value)
}

/// 명령 목록 한 벌을 다듬는다. 규칙은 원격에서 실행되는 명령의 앞머리와 맞춰 보는 값이라
/// 줄바꿈·제어문자를 허용하지 않고, 개수와 길이에 상한을 둔다. 빈 줄과 중복은 조용히 접는다.
fn validate_command_rules(values: &[String], label: &str) -> Result<Vec<String>, CoreError> {
    let mut rules: Vec<String> = Vec::new();
    for value in values {
        let rule = value.trim();
        if rule.is_empty() {
            continue;
        }
        if rule.chars().count() > MAX_COMMAND_RULE_CHARS
            || rule.chars().any(|character| character.is_control())
        {
            return Err(CoreError::InvalidInput(format!(
                "{label} 명령은 제어문자 없이 {MAX_COMMAND_RULE_CHARS}자 이하여야 합니다"
            )));
        }
        if !rules.iter().any(|existing| existing == rule) {
            rules.push(rule.to_owned());
        }
    }
    if rules.len() > MAX_COMMAND_RULES {
        return Err(CoreError::InvalidInput(format!(
            "{label} 명령은 {MAX_COMMAND_RULES}개까지 넣을 수 있습니다"
        )));
    }
    Ok(rules)
}

fn validate_port(value: Option<u16>) -> Result<u16, CoreError> {
    match value {
        None => Ok(DEFAULT_SSH_PORT),
        Some(0) => Err(CoreError::InvalidInput(
            "포트는 1에서 65535 사이여야 합니다".to_owned(),
        )),
        Some(port) => Ok(port),
    }
}

/// 스킬이 부르는 진입점. `<CLI> ssh list`가 켜 둔 엔드포인트를 JSON으로 내려 준다.
pub fn run_ssh_endpoint_cli(args: impl Iterator<Item = String>) -> Result<(), CoreError> {
    let mut args = args;
    let operation = args
        .next()
        .ok_or_else(|| CoreError::InvalidInput("ssh 다음에 작업이 필요합니다: list".to_owned()))?;
    if operation != "list" {
        return Err(CoreError::InvalidInput(format!(
            "알 수 없는 작업입니다: {operation}. 지금은 list만 있습니다"
        )));
    }
    let mut app_data_dir = None;
    while let Some(flag) = args.next() {
        match flag.as_str() {
            "--app-data-dir" => {
                app_data_dir = Some(std::path::PathBuf::from(args.next().ok_or_else(|| {
                    CoreError::InvalidInput("--app-data-dir 값이 필요합니다".to_owned())
                })?));
            }
            other => {
                return Err(CoreError::InvalidInput(format!(
                    "알 수 없는 인자입니다: {other}"
                )));
            }
        }
    }
    let app_data_dir = match app_data_dir {
        Some(path) => path,
        None => crate::remote::default_app_data_dir().map_err(CoreError::InvalidInput)?,
    };
    let view = list_agent_ssh_endpoints(&app_data_dir)?;
    println!("{}", serde_json::to_string_pretty(&view)?);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    use base64::engine::general_purpose::STANDARD;
    use base64::Engine as _;

    fn public_key_line(comment: &str) -> String {
        let key_type = "ssh-ed25519";
        let mut blob = Vec::new();
        blob.extend_from_slice(&(key_type.len() as u32).to_be_bytes());
        blob.extend_from_slice(key_type.as_bytes());
        blob.extend_from_slice(&32u32.to_be_bytes());
        blob.extend_from_slice(&[7; 32]);
        format!("{key_type} {} {comment}\n", STANDARD.encode(blob))
    }

    /// 공개키 하나와 개인키 자리를 갖춘 홈을 만들고 그 지문을 돌려준다.
    fn fixture(home: &Path, with_private_key: bool) -> String {
        let root = home.join(".ssh");
        fs::create_dir(&root).expect("ssh root");
        fs::write(root.join("id_example.pub"), public_key_line("dev@example")).expect("public");
        if with_private_key {
            fs::write(root.join("id_example"), b"private material").expect("private");
        }
        crate::ssh_keys::get_ssh_keys_with_home(home)
            .expect("inventory")
            .keys[0]
            .fingerprint
            .clone()
    }

    fn request(fingerprint: &str, agent_enabled: bool) -> SetSshKeyEndpointRequest {
        SetSshKeyEndpointRequest {
            fingerprint: fingerprint.to_owned(),
            host: "build.example.com".to_owned(),
            port: Some(2222),
            user: "deploy".to_owned(),
            agent_enabled,
            allowed_commands: vec!["git pull".to_owned(), "systemctl status".to_owned()],
            denied_commands: vec!["rm -rf".to_owned()],
        }
    }

    /// C9-9. 엔드포인트는 앱 데이터에만 남고 `~/.ssh` 파일은 그대로다.
    #[test]
    fn c9_endpoints_live_in_app_data_and_never_touch_the_key_files() {
        let home = tempfile::tempdir().expect("home");
        let app_data = tempfile::tempdir().expect("app data");
        let fingerprint = fixture(home.path(), true);
        let before = fs::read_to_string(home.path().join(".ssh/id_example.pub")).expect("read");

        let snapshot =
            set_ssh_key_endpoint_with(home.path(), app_data.path(), &request(&fingerprint, true))
                .expect("save");
        let endpoint = snapshot.keys[0].endpoint.as_ref().expect("endpoint");
        assert_eq!(endpoint.host, "build.example.com");
        assert_eq!(endpoint.port, 2222);
        assert_eq!(endpoint.user, "deploy");
        assert!(endpoint.agent_enabled);
        assert_eq!(
            fs::read_to_string(home.path().join(".ssh/id_example.pub")).expect("read"),
            before
        );
        assert!(app_data.path().join(ENDPOINTS_STORE.file).is_file());

        // 호스트를 비우면 저장본에서 사라진다.
        let cleared = set_ssh_key_endpoint_with(
            home.path(),
            app_data.path(),
            &SetSshKeyEndpointRequest {
                fingerprint: fingerprint.clone(),
                host: "   ".to_owned(),
                port: None,
                user: String::new(),
                agent_enabled: false,
                allowed_commands: Vec::new(),
                denied_commands: Vec::new(),
            },
        )
        .expect("clear");
        assert!(cleared.keys[0].endpoint.is_none());
        assert!(load_endpoints(app_data.path()).expect("load").is_empty());
    }

    /// C9-9. 목록에 없는 지문, 옵션처럼 읽히는 호스트, 개인키 없는 키의 에이전트 사용은
    /// 모두 저장되지 않는다.
    #[test]
    fn c9_endpoint_input_is_bounded_and_agent_use_needs_a_private_key() {
        let home = tempfile::tempdir().expect("home");
        let app_data = tempfile::tempdir().expect("app data");
        let fingerprint = fixture(home.path(), false);

        assert!(set_ssh_key_endpoint_with(
            home.path(),
            app_data.path(),
            &request("SHA256:ZZZZ", false),
        )
        .is_err());
        for host in ["-oProxyCommand=touch /tmp/x", "build example.com", "", "-h"] {
            assert!(validate_host(host).is_err(), "{host} 는 거절돼야 합니다");
        }
        for user in ["-l root", "root;whoami", ""] {
            assert!(validate_user(user).is_err(), "{user} 는 거절돼야 합니다");
        }
        assert!(validate_port(Some(0)).is_err());
        assert_eq!(validate_port(None).expect("default"), DEFAULT_SSH_PORT);

        // 개인키가 없으면 에이전트 사용은 켤 수 없지만, 접속 지점 저장 자체는 된다.
        assert!(set_ssh_key_endpoint_with(
            home.path(),
            app_data.path(),
            &request(&fingerprint, true),
        )
        .is_err());
        let snapshot =
            set_ssh_key_endpoint_with(home.path(), app_data.path(), &request(&fingerprint, false))
                .expect("save");
        assert!(
            !snapshot.keys[0]
                .endpoint
                .as_ref()
                .expect("endpoint")
                .agent_enabled
        );
    }

    /// C9-12. 스킬 목록에는 켜 둔 키만 나오고, 인자는 저장한 키만 쓰도록 조립된다.
    #[test]
    fn c9_agent_listing_shows_only_enabled_keys_with_ready_to_run_arguments() {
        let home = tempfile::tempdir().expect("home");
        let app_data = tempfile::tempdir().expect("app data");
        let fingerprint = fixture(home.path(), true);

        let off = list_agent_ssh_endpoints_with(home.path(), app_data.path()).expect("list");
        assert!(off.endpoints.is_empty() && off.skipped.is_empty());

        set_ssh_key_endpoint_with(home.path(), app_data.path(), &request(&fingerprint, false))
            .expect("save");
        assert!(list_agent_ssh_endpoints_with(home.path(), app_data.path())
            .expect("list")
            .endpoints
            .is_empty());

        set_ssh_key_endpoint_with(home.path(), app_data.path(), &request(&fingerprint, true))
            .expect("save");
        let view = list_agent_ssh_endpoints_with(home.path(), app_data.path()).expect("list");
        assert_eq!(view.endpoints.len(), 1);
        let entry = &view.endpoints[0];
        assert_eq!(entry.key_file_name, "id_example");
        assert_eq!(entry.destination, "deploy@build.example.com:2222");
        assert!(entry.identity_path.ends_with(".ssh/id_example"));
        assert!(entry.ssh_args.contains(&"IdentitiesOnly=yes".to_owned()));
        assert!(entry.ssh_args.contains(&"BatchMode=yes".to_owned()));
        assert_eq!(
            entry.ssh_args.last().expect("target"),
            "deploy@build.example.com"
        );
        assert!(entry.ssh_command.starts_with("ssh -i "));

        // 공개키가 사라져도 켜 둔 항목은 이유와 함께 보고된다.
        fs::remove_file(home.path().join(".ssh/id_example.pub")).expect("remove");
        let view = list_agent_ssh_endpoints_with(home.path(), app_data.path()).expect("list");
        assert!(view.endpoints.is_empty());
        assert_eq!(view.skipped.len(), 1);
        assert_eq!(view.skipped[0].fingerprint, fingerprint);
    }

    /// C9-11. 확인은 저장된 지점으로만 붙고, 실패 문구는 사용자가 읽을 수 있게 남는다.
    #[test]
    fn c9_check_requires_a_saved_endpoint_and_reports_the_reason() {
        let home = tempfile::tempdir().expect("home");
        let app_data = tempfile::tempdir().expect("app data");
        let fingerprint = fixture(home.path(), true);
        let reference = SshKeyRef {
            file_name: "id_example.pub".to_owned(),
            fingerprint: fingerprint.clone(),
        };

        // 저장된 지점이 없으면 ssh를 부르지 않는다. 실행 파일 자리에 없는 경로를 줘도
        // 여기까지 오지 않는다.
        assert!(check_ssh_endpoint_with(
            home.path(),
            app_data.path(),
            Path::new("/nonexistent/ssh"),
            &reference,
        )
        .is_err());

        set_ssh_key_endpoint_with(home.path(), app_data.path(), &request(&fingerprint, true))
            .expect("save");
        assert!(
            check_message(false, false, "ssh: Host key verification failed.\n")
                .contains("known_hosts에 없습니다")
        );
        assert_eq!(check_message(true, false, ""), "접속에 성공했습니다");
        assert_eq!(
            check_message(false, true, ""),
            "정해진 시간 안에 접속하지 못했습니다"
        );
    }

    /// C9-13. 명령 정책은 저장본에 그대로 남고, 스킬 목록에 규칙과 방식이 함께 실린다.
    #[test]
    fn c9_command_policy_is_stored_and_published_to_the_agent_listing() {
        let home = tempfile::tempdir().expect("home");
        let app_data = tempfile::tempdir().expect("app data");
        let fingerprint = fixture(home.path(), true);

        let snapshot =
            set_ssh_key_endpoint_with(home.path(), app_data.path(), &request(&fingerprint, true))
                .expect("save");
        let endpoint = snapshot.keys[0].endpoint.as_ref().expect("endpoint");
        assert_eq!(endpoint.allowed_commands, ["git pull", "systemctl status"]);
        assert_eq!(endpoint.denied_commands, ["rm -rf"]);

        let entry = &list_agent_ssh_endpoints_with(home.path(), app_data.path())
            .expect("list")
            .endpoints[0];
        assert_eq!(entry.command_policy_mode, SshCommandPolicyMode::Allowlist);
        assert_eq!(entry.allowed_commands, ["git pull", "systemctl status"]);
        assert_eq!(entry.denied_commands, ["rm -rf"]);

        // 허용 목록을 비우면 차단 목록만 적용된다.
        let mut open_policy = request(&fingerprint, true);
        open_policy.allowed_commands = Vec::new();
        set_ssh_key_endpoint_with(home.path(), app_data.path(), &open_policy).expect("save");
        let entry = &list_agent_ssh_endpoints_with(home.path(), app_data.path())
            .expect("list")
            .endpoints[0];
        assert_eq!(
            entry.command_policy_mode,
            SshCommandPolicyMode::DenylistOnly
        );
    }

    /// C9-13. 빈 줄과 중복은 접고, 제어문자와 상한 초과는 거절한다.
    #[test]
    fn c9_command_rules_are_trimmed_deduplicated_and_bounded() {
        let rules = validate_command_rules(
            &[
                "  git pull  ".to_owned(),
                String::new(),
                "git pull".to_owned(),
                "ls".to_owned(),
            ],
            "허용",
        )
        .expect("rules");
        assert_eq!(rules, ["git pull", "ls"]);
        assert!(validate_command_rules(&["rm\n-rf".to_owned()], "차단").is_err());
        assert!(validate_command_rules(&["x".repeat(MAX_COMMAND_RULE_CHARS + 1)], "허용").is_err());
        let many = (0..=MAX_COMMAND_RULES)
            .map(|index| format!("command{index}"))
            .collect::<Vec<_>>();
        assert!(validate_command_rules(&many, "허용").is_err());
        // 기본값은 상한 안에 있고, 차단이 허용보다 좁은 앞머리를 잡는다.
        let defaults = command_policy_defaults();
        assert!(defaults.allowed.len() <= MAX_COMMAND_RULES);
        assert!(defaults.allowed.contains(&"cat".to_owned()));
        assert!(defaults.denied.contains(&"cat /etc/shadow".to_owned()));
    }

    #[test]
    fn ipv6_hosts_are_bracketed_and_paths_with_spaces_stay_quoted() {
        let endpoint = SshEndpointView {
            host: "fd7a:1234::5".to_owned(),
            port: 22,
            user: "deploy".to_owned(),
            agent_enabled: true,
            allowed_commands: Vec::new(),
            denied_commands: Vec::new(),
            updated_at: 0,
        };
        assert_eq!(target(&endpoint), "deploy@[fd7a:1234::5]");
        assert_eq!(
            ssh_command(&["-i".to_owned(), "/Users/a b/.ssh/key".to_owned()]),
            "ssh -i '/Users/a b/.ssh/key'"
        );
    }

    /// SshCommandPolicyMode의 문자열 포맷팅, 파싱, 직렬화, 역직렬화 및 상태 판별 헬퍼를 검증한다.
    #[test]
    fn ssh_command_policy_mode_contract_and_serde() {
        assert_eq!(SshCommandPolicyMode::ALL.len(), 2);
        for mode in SshCommandPolicyMode::ALL {
            let s = mode.as_str();
            assert_eq!(mode.to_string(), s);
            assert_eq!(s.parse::<SshCommandPolicyMode>().expect("parse"), mode);

            let json = serde_json::to_string(&mode).expect("serialize");
            assert_eq!(json, format!("\"{s}\""));
            let back: SshCommandPolicyMode = serde_json::from_str(&json).expect("deserialize");
            assert_eq!(back, mode);
        }

        // 스네이크 표기(denylist_only) 파싱 호환성 검증
        assert_eq!(
            "denylist_only"
                .parse::<SshCommandPolicyMode>()
                .expect("snake parse"),
            SshCommandPolicyMode::DenylistOnly
        );

        // 상태 판별 헬퍼 검증
        assert!(SshCommandPolicyMode::Allowlist.is_allowlist());
        assert!(!SshCommandPolicyMode::Allowlist.is_denylist_only());

        assert!(SshCommandPolicyMode::DenylistOnly.is_denylist_only());
        assert!(!SshCommandPolicyMode::DenylistOnly.is_allowlist());

        // 알 수 없는 값에 대한 파싱 거절 검증
        let error = "unknown"
            .parse::<SshCommandPolicyMode>()
            .expect_err("unknown");
        assert!(matches!(error, CoreError::InvalidInput(_)));
    }
}
