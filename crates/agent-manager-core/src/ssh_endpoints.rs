//! C9-9~C9-12: SSH 연결 서버 목록과 에이전트 사용 여부.
//!
//! # 서버가 키에 매달리지 않는 이유
//!
//! 처음에는 접속 지점을 키 지문 하나에 하나씩 붙였다. 그러면 서버를 추가하려면 키부터
//! 있어야 하고, 개인키 하나로 여러 서버에 붙는 흔한 쓰임을 표현할 수 없다. 그래서 서버를
//! 독립된 목록으로 두고 서버마다 접속에 쓸 키 지문을 하나 가리키게 했다(2026-10-19 사용자
//! 결정). 실행·승인·터미널·스킬은 모두 서버 ID로 서버를 고른다. 예전 저장본
//! (`ssh-key-endpoints-v1.json`)은 처음 읽을 때 지문에서 파생한 ID로 옮기고 원본은 남긴다.
//!
//! # 왜 별도 저장소인가
//!
//! 연결 서버는 공개키에서 파생되지 않는 기기 단위 메타데이터다. 메모(C9-8)와 같은 이유로
//! `~/.ssh`가 아니라 앱 데이터에만 둔다(G7). `~/.ssh/config`를 고쳐 넣지 않는 것도 같은
//! 이유다 — 그 파일은 사용자와 다른 도구가 함께 쓰는 사용자 소유 설정이고, 여기서 필요한
//! 것은 "이 키로 어디에 붙고, 에이전트에게 열어 줄 것인가"라는 앱 쪽 결정뿐이다.
//!
//! # 에이전트에게 열어 주는 방법
//!
//! 두 경로가 있고 토글은 하나다. 자기 셸이 있는 에이전트(Claude·Codex)는 켜 둔 엔드포인트
//! 목록을 실행 파일 하나(`<CLI> ssh list`)로 받아 그 `ssh` 인자 그대로 접속한다 — 그 경로에서
//! 명령 목록은 지켜야 할 지시문이다. 셸이 없는 AIA는 `ssh_exec.rs`의 실행 작업으로 앱에게
//! 실행을 맡기고, 그 경로에서는 같은 목록이 실제 집행 지점이 된다(C9-14).
//!
//! 터미널 표시(C9-18)를 켠 서버는 셸이 있는 에이전트도 `<CLI> ssh exec`로 떠 있는 백엔드에
//! 실행을 맡긴다. 그러면 출력이 그 대화의 도구 카드에 실시간으로 흐르고, 스킬 경로에서
//! 지시문에 그쳤던 명령 목록이 C9-14와 같은 집행 지점을 지난다.
//!
//! 개인키는 어느 경로에서도 열지 않는다 — `ssh`에 경로만 넘긴다(G4). 목록에는 사용자가 켠
//! 키만 나오므로, 토글이 곧 접근 허용 결정이다.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::clock::now_ms;
use crate::json_store::{JsonStore, SchemaVersioned};
use crate::ssh_keys::{
    private_key_present, validate_fingerprint, SshKeyIssue, SshKeyView, SshKeysSnapshot,
};
use crate::user_home::home_dir;
use crate::CoreError;

const ENDPOINTS_VERSION: u32 = 1;
/// 키 지문마다 접속 지점 하나를 두던 예전 저장본. 서버 목록으로 옮길 때 한 번 읽는다.
const ENDPOINTS_STORE: JsonStore = JsonStore {
    file: "ssh-key-endpoints-v1.json",
    lock_file: "ssh-key-endpoints-v1.lock",
    label: "SSH 엔드포인트 저장소",
    version: ENDPOINTS_VERSION,
};

const SERVERS_VERSION: u32 = 1;
/// 연결 서버도 메모와 같은 기기 단위 메타데이터라 앱 데이터에만 둔다(G7).
const SERVERS_STORE: JsonStore = JsonStore {
    file: "ssh-servers-v1.json",
    lock_file: "ssh-servers-v1.lock",
    label: "SSH 연결 서버 저장소",
    version: SERVERS_VERSION,
};

/// `<CLI> ssh list` 응답 모양의 버전. 2: 항목이 서버 ID·이름·암호 키 여부를 싣는다.
const AGENT_LISTING_VERSION: u32 = 2;

const MAX_ENDPOINTS: usize = 512;
const MAX_SERVER_NAME_CHARS: usize = 80;
const SERVER_ID_PREFIX: &str = "srv-";
const MAX_SERVER_ID_CHARS: usize = 40;
const MAX_HOST_CHARS: usize = 253;
const MAX_USER_CHARS: usize = 64;
const DEFAULT_SSH_PORT: u16 = 22;
/// 확인 연결이 매달리지 않게 하는 상한. `ConnectTimeout`이 먼저 끊고, 그래도 살아 있으면
/// 실행 자체를 끊는다.
const CHECK_CONNECT_TIMEOUT_SECONDS: u32 = 10;
const CHECK_TIMEOUT: Duration = Duration::from_secs(20);
/// 확인은 원격에서 아무것도 바꾸지 않는 고정 명령 하나만 돌린다. 사용자·에이전트가 준
/// 문자열을 원격에서 실행하는 경로는 이 어댑터에 없다(G9).
///
/// `true` 는 POSIX 셸 전제라 **원격이 Windows면 인증에 성공하고도 확인이 실패한다** —
/// `cmd.exe` 에 `true` 가 없어 종료 코드 1과 "내부 또는 외부 명령이 아닙니다"가 돌아오고,
/// 그 문구는 CP949 라 깨져 보이기까지 한다. `exit` 는 `cmd.exe`·PowerShell·POSIX 셸 모두의
/// 내장 명령이라 어느 쪽에서도 출력 없이 0으로 끝난다. 이 확인이 보려는 것은 셸의 종류가
/// 아니라 접속·인증이 되는지뿐이다.
const CHECK_REMOTE_COMMAND: &str = "exit";
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
    // C9-15. 권한 상승과 광범위 파괴·내려받기 앞머리는 기본으로 열어 두지 않는다. 원격
    // 설치를 아예 못 하게 되지는 않도록 금지가 아니라 기본 차단이며, 그 서버에 대해
    // 사용자가 이 줄을 지우면 열린다.
    "sudo",
    "doas",
    "su",
    "rm",
    "chmod 777",
    "chown -R",
    "truncate",
];

/// 연결 서버 하나. 저장본과 화면 표시가 같은 모양이라 한 타입을 함께 쓴다.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SshEndpointView {
    /// 서버 ID. 실행·승인·터미널이 이 값으로 서버를 고른다. 키 하나를 여러 서버가 함께 쓰므로
    /// 지문은 서버를 가리킬 수 없다.
    #[serde(default)]
    pub id: String,
    /// 사람이 붙인 이름. 비어 있으면 화면은 접속 대상을 이름 대신 보여 준다.
    #[serde(default)]
    pub name: String,
    /// 이 서버에 접속할 키의 지문.
    #[serde(default)]
    pub fingerprint: String,
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
    /// 이 서버로 파일을 올리고 받아도 되는지. 명령 허용 목록과 **별개의 권한**이다(C9-15) —
    /// 전송은 명령 실행이 아니고, 명령을 하나도 허용하지 않은 서버에 산출물만 주고받는
    /// 것도 반대의 경우도 사용자의 정당한 선택이다. 기본은 꺼짐이라 예전 저장본은
    /// 그대로 꺼진 상태로 읽힌다.
    #[serde(default)]
    pub file_transfer_enabled: bool,
    /// 전송이 닿을 수 있는 원격 폴더. 올리고 받는 경로 모두 이 아래 상대 경로로만
    /// 정해진다 — 권한 하나가 두 방향을 열고, 그 범위는 이 폴더 하나로 묶인다.
    #[serde(default)]
    pub transfer_root: String,
    /// 이 서버에서 실행되는 명령의 출력을 대화 화면에 실시간으로 흘릴지(C9-18). 켜면 AIA
    /// 경로는 줄 단위로 채팅 도구 카드에 이어 붙이고, 자기 셸이 있는 에이전트도 `<CLI> ssh
    /// exec` 경유로 실행해 같은 화면에 나오며 그 경로에서는 명령 목록이 실제로 집행된다.
    /// 기본은 꺼짐이라 예전 저장본은 그대로 꺼진 상태로 읽힌다.
    #[serde(default)]
    pub terminal_enabled: bool,
    /// 이 서버에서 **명령을 제한 없이** 실행할지. 켜면 허용 목록 대조와 1회 승인 자리가
    /// 통째로 빠진다 — 사용자가 그 서버에 대해 "무엇이든 해도 된다"고 미리 답해 둔 것이다.
    /// 차단 목록과 셸·인터프리터·네트워크 페치 앞머리 거부는 그대로 남는다. 켜는 자리에서
    /// 화면이 한 번 더 확인하며, 기본은 꺼짐이라 예전 저장본은 그대로 꺼진 상태로 읽힌다.
    #[serde(default)]
    pub unrestricted_commands: bool,
    /// 프로젝트 git의 **네트워크 작업에만** 이 키를 신원으로 넘길지(C16-10). 앞의 네 토글과
    /// 달리 이것은 에이전트 권한이 아니라 사용자 자신의 git이 쓰는 키라, C9-19의 대화형
    /// 터미널과 같은 이유로 `agent_enabled`에 묶지 않는다 — 에이전트에게 서버를 열어 주지
    /// 않은 사람도 자기 저장소에는 push할 수 있어야 한다. 개인키가 있어야 한다는 조건만
    /// 공유한다. 기기 전체에서 한 키만 켤 수 있다(여러 키가 켜져 있으면 어느 신원이 쓰였는지
    /// 영수증만으로 되짚을 수 없다). 기본은 꺼짐이라 예전 저장본은 그대로 꺼진 상태로 읽힌다.
    #[serde(default)]
    pub project_git_enabled: bool,
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
    /// 사용자가 무제한 명령 허용을 켰다. 허용 목록을 보지 않고, 차단 목록과 하드 거부만 남는다.
    Unrestricted,
}

impl SshCommandPolicyMode {
    pub const ALL: [Self; 3] = [Self::Allowlist, Self::DenylistOnly, Self::Unrestricted];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Allowlist => "allowlist",
            Self::DenylistOnly => "denylistOnly",
            Self::Unrestricted => "unrestricted",
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

    /// 무제한 모드인지 여부. 허용 목록 대조와 승인 자리가 빠지는 유일한 모드다.
    pub fn is_unrestricted(self) -> bool {
        matches!(self, Self::Unrestricted)
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
            "unrestricted" => Ok(Self::Unrestricted),
            _ => Err(CoreError::InvalidInput(format!(
                "알 수 없는 SSH 명령 정책 모드입니다: {s}. allowlist|denylistOnly|unrestricted 중 하나를 쓰세요"
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

/// 명령 목록 모드는 저장본에서 파생된다. 화면·스킬·집행이 같은 판정을 쓰도록 한 곳에 둔다.
impl SshEndpointView {
    pub(crate) fn command_policy_mode(&self) -> SshCommandPolicyMode {
        if self.unrestricted_commands {
            SshCommandPolicyMode::Unrestricted
        } else if self.allowed_commands.is_empty() {
            SshCommandPolicyMode::DenylistOnly
        } else {
            SshCommandPolicyMode::Allowlist
        }
    }
}

/// 연결 서버 저장 요청. `id`가 없으면 새 서버를 만들고, 있으면 그 서버를 고친다.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveSshServerRequest {
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub name: String,
    pub fingerprint: String,
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
    #[serde(default)]
    pub file_transfer_enabled: bool,
    #[serde(default)]
    pub transfer_root: String,
    #[serde(default)]
    pub terminal_enabled: bool,
    #[serde(default)]
    pub unrestricted_commands: bool,
    #[serde(default)]
    pub project_git_enabled: bool,
}

/// 서버 하나를 가리키는 요청.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshServerRef {
    pub server_id: String,
}

/// 연결 확인 결과. 원격에서 무엇도 바꾸지 않았고, 개인키 내용은 어느 필드에도 없다.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SshEndpointCheckReceipt {
    pub server_id: String,
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
    /// 서버 ID. 실행 작업과 `relayArgs`가 이 값으로 서버를 고른다.
    pub server_id: String,
    pub name: String,
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
    /// 이 서버로 파일을 올리고 받아도 되는지와 그 폴더(C9-15). 명령 목록과 별개 권한이다.
    pub file_transfer_enabled: bool,
    pub transfer_root: String,
    /// 터미널 표시(C9-18). true면 `ssh`를 직접 부르지 않고 `relayArgs`로 앱을 거쳐 실행한다.
    pub terminal_enabled: bool,
    /// C9-21. 키에 암호가 걸려 있어 앱만 열 수 있다. true면 `sshArgs`가 비어 있고, 언제나
    /// `relayArgs`로 앱을 거쳐 실행한다 — 암호는 에이전트 셸에 들어가지 않는다.
    pub passphrase_protected: bool,
    /// 무제한 명령 허용. true면 허용 목록 대조와 1회 승인이 빠지고 차단 목록만 남는다.
    pub unrestricted_commands: bool,
    /// `<CLI>`와 접두사 뒤에 붙여 이 서버에서 명령을 실행하는 인자. 마지막 `--` 뒤에
    /// 원격 명령 단어들을 그대로 이어 붙인다.
    pub relay_args: Vec<String>,
}

/// 켜 두었지만 지금은 쓸 수 없는 항목. 조용히 빼지 않고 이유를 함께 알린다.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentSshEndpointSkip {
    pub server_id: String,
    pub name: String,
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

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SshServerStore {
    schema_version: u32,
    #[serde(default)]
    servers: Vec<SshEndpointView>,
}

impl SchemaVersioned for SshServerStore {
    fn schema_version(&self) -> u32 {
        self.schema_version
    }
}

impl Default for SshServerStore {
    fn default() -> Self {
        Self {
            schema_version: SERVERS_VERSION,
            servers: Vec::new(),
        }
    }
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

/// C9-9. 연결 서버 하나를 만들거나 고친다.
pub fn save_ssh_server(
    app_data_dir: &Path,
    request: SaveSshServerRequest,
) -> Result<SshKeysSnapshot, CoreError> {
    save_ssh_server_with(&home_dir()?, app_data_dir, &request)
}

/// C9-9. 연결 서버 하나를 지운다. 키 파일과 다른 서버는 그대로다.
pub fn delete_ssh_server(
    app_data_dir: &Path,
    request: SshServerRef,
) -> Result<SshKeysSnapshot, CoreError> {
    delete_ssh_server_with(&home_dir()?, app_data_dir, &request)
}

/// C9-11. 저장된 서버로 한 번 붙어 보고 끊는다. 원격에서는 앱이 정한 고정 명령만 돌린다.
pub fn check_ssh_endpoint(
    app_data_dir: &Path,
    request: SshServerRef,
) -> Result<SshEndpointCheckReceipt, CoreError> {
    let executable = crate::providers::resolve_named_executable(&["ssh"])?;
    check_ssh_endpoint_with(&home_dir()?, app_data_dir, &executable, &request)
}

/// C9-12. 스킬이 부르는 목록. 에이전트 사용을 켠 서버만 나온다.
pub fn list_agent_ssh_endpoints(app_data_dir: &Path) -> Result<AgentSshEndpointsView, CoreError> {
    list_agent_ssh_endpoints_with(&home_dir()?, app_data_dir)
}

/// 실행 경로 테스트가 홈과 앱 데이터를 직접 지정해 서버를 심을 때 쓰는 입구.
/// 지금은 이 입구를 부르는 시험이 없다 — 서버를 심는 시험이 다시 생길 때 쓴다.
#[cfg(test)]
#[allow(dead_code)]
pub(crate) fn save_ssh_server_for_test(
    home: &Path,
    app_data_dir: &Path,
    request: &SaveSshServerRequest,
) -> Result<SshKeysSnapshot, CoreError> {
    save_ssh_server_with(home, app_data_dir, request)
}

fn save_ssh_server_with(
    home: &Path,
    app_data_dir: &Path,
    request: &SaveSshServerRequest,
) -> Result<SshKeysSnapshot, CoreError> {
    let fingerprint = validate_fingerprint(&request.fingerprint)?.to_owned();
    let existing_id = request
        .id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(validate_server_id)
        .transpose()?
        .map(str::to_owned);
    let snapshot = crate::ssh_keys::snapshot_with_metadata(home, app_data_dir)?;
    let key = snapshot
        .keys
        .iter()
        .find(|key| key.fingerprint == fingerprint)
        .ok_or_else(|| {
            CoreError::NotFound("이 서버에 쓸 공개키를 ~/.ssh에서 찾지 못했습니다".to_owned())
        })?;
    let host = request.host.trim();
    if host.is_empty() {
        return Err(CoreError::InvalidInput(
            "서버 주소(IP 또는 호스트 이름)가 필요합니다".to_owned(),
        ));
    }
    let transfer_root = validate_endpoint_options(request, key.has_private_key)?;
    // C16-10. 감쌀 수 없는 경로는 **켜는 자리에서** 거절한다. 쓰는 자리에서만 거절하면
    // 토글은 저장된 채로 켜져 보이고 git은 말없이 신원 없이 붙는다 — 사용자가 읽을 수
    // 있는 실패가 어디에도 남지 않는다.
    if request.project_git_enabled {
        let identity = PathBuf::from(&key.path).with_extension("");
        ssh_command_line("ssh", &identity.to_string_lossy(), false)?;
    }
    let mut server = SshEndpointView {
        id: existing_id.clone().unwrap_or_else(new_server_id),
        name: validate_server_name(&request.name)?.to_owned(),
        fingerprint: fingerprint.clone(),
        host: validate_host(host)?.to_owned(),
        port: validate_port(request.port)?,
        user: validate_user(&request.user)?.to_owned(),
        agent_enabled: request.agent_enabled,
        allowed_commands: validate_command_rules(&request.allowed_commands, "허용")?,
        denied_commands: validate_command_rules(&request.denied_commands, "차단")?,
        file_transfer_enabled: request.file_transfer_enabled,
        transfer_root,
        terminal_enabled: request.terminal_enabled,
        unrestricted_commands: request.unrestricted_commands,
        project_git_enabled: request.project_git_enabled,
        updated_at: now_ms(),
    };

    edit_servers(app_data_dir, |servers| {
        // C16-10. git 원격용은 기기 전체에서 한 서버(한 키)다. 조용히 다른 서버를 꺼 버리면
        // 사용자가 끈 적 없는 설정이 사라지므로, 켜져 있는 서버를 알려 주고 거절한다.
        if server.project_git_enabled {
            if let Some(other) = servers
                .iter()
                .find(|saved| saved.id != server.id && saved.project_git_enabled)
            {
                return Err(CoreError::Conflict(format!(
                    "git 원격용으로 이미 다른 서버({})가 켜져 있습니다. 그 서버를 먼저 끄세요",
                    display_name(other)
                )));
            }
        }
        match &existing_id {
            Some(id) => {
                let slot = servers
                    .iter_mut()
                    .find(|saved| &saved.id == id)
                    .ok_or_else(|| CoreError::NotFound(server_not_found(id)))?;
                *slot = server.clone();
            }
            None => {
                if servers.len() >= MAX_ENDPOINTS {
                    return Err(CoreError::TooLarge(MAX_ENDPOINTS as u64));
                }
                // 무작위 ID가 겹칠 일은 사실상 없지만, 겹치면 다른 서버를 덮게 되므로 다시 뽑는다.
                while servers.iter().any(|saved| saved.id == server.id) {
                    server.id = new_server_id();
                }
                servers.push(server.clone());
            }
        }
        Ok(true)
    })?;
    crate::ssh_keys::snapshot_with_metadata(home, app_data_dir)
}

fn delete_ssh_server_with(
    home: &Path,
    app_data_dir: &Path,
    request: &SshServerRef,
) -> Result<SshKeysSnapshot, CoreError> {
    let id = validate_server_id(&request.server_id)?.to_owned();
    edit_servers(app_data_dir, |servers| {
        let before = servers.len();
        servers.retain(|saved| saved.id != id);
        if servers.len() == before {
            return Err(CoreError::NotFound(server_not_found(&id)));
        }
        Ok(true)
    })?;
    crate::ssh_keys::snapshot_with_metadata(home, app_data_dir)
}

/// 실행 경로가 고른 서버와 그 서버가 가리키는 키. 화면이 보낸 값이 아니라 저장본과
/// `~/.ssh`를 다시 읽어 만든다.
pub(crate) struct ResolvedServer {
    pub(crate) server: SshEndpointView,
    pub(crate) key: SshKeyView,
}

/// 서버를 고른다. `server_id`가 있으면 그 서버이고, 없으면 예전 호출처럼 지문으로 고르되
/// 그 키를 쓰는 서버가 정확히 하나일 때만 받는다 — 여럿이면 어느 서버인지 추측하지 않는다.
/// 둘 다 주어졌는데 서로 다른 키를 가리키면 거절한다.
pub(crate) fn resolve_server(
    home: &Path,
    app_data_dir: &Path,
    server_id: Option<&str>,
    fingerprint: &str,
) -> Result<ResolvedServer, CoreError> {
    let snapshot = crate::ssh_keys::snapshot_with_metadata(home, app_data_dir)?;
    let fingerprint = fingerprint.trim();
    let server = match server_id.map(str::trim).filter(|value| !value.is_empty()) {
        Some(id) => {
            let id = validate_server_id(id)?;
            let server = snapshot
                .servers
                .iter()
                .find(|saved| saved.id == id)
                .cloned()
                .ok_or_else(|| CoreError::NotFound(server_not_found(id)))?;
            if !fingerprint.is_empty() && validate_fingerprint(fingerprint)? != server.fingerprint {
                return Err(CoreError::Conflict(
                    "serverId와 fingerprint가 서로 다른 서버를 가리킵니다".to_owned(),
                ));
            }
            server
        }
        None => {
            let fingerprint = validate_fingerprint(fingerprint)?;
            let mut matches = snapshot
                .servers
                .iter()
                .filter(|saved| saved.fingerprint == fingerprint);
            let first = matches.next().cloned().ok_or_else(|| {
                CoreError::NotFound("이 키에 저장된 연결 서버가 없습니다".to_owned())
            })?;
            if matches.next().is_some() {
                return Err(CoreError::Conflict(
                    "이 키를 쓰는 연결 서버가 여러 개입니다. serverId로 서버를 고르세요".to_owned(),
                ));
            }
            first
        }
    };
    let key = snapshot
        .keys
        .iter()
        .find(|key| key.fingerprint == server.fingerprint)
        .cloned()
        .ok_or_else(|| {
            CoreError::NotFound(format!(
                "연결 서버 {}가 쓰는 키(지문 {})를 ~/.ssh에서 찾지 못했습니다. 키를 되돌리거나 서버에 다른 키를 고르세요",
                display_name(&server),
                server.fingerprint
            ))
        })?;
    Ok(ResolvedServer { server, key })
}

/// 키 삭제 영수증에 싣는 "이 키를 쓰던 서버" 이름들. 읽지 못하면 비운다.
pub(crate) fn servers_using_key(app_data_dir: &Path, fingerprint: &str) -> Vec<String> {
    load_servers(app_data_dir)
        .map(|servers| {
            servers
                .iter()
                .filter(|server| server.fingerprint == fingerprint)
                .map(display_name)
                .collect()
        })
        .unwrap_or_default()
}

/// 화면·영수증에 쓰는 서버 표기. 이름이 없으면 접속 대상이다.
pub(crate) fn display_name(server: &SshEndpointView) -> String {
    if server.name.is_empty() {
        destination(server)
    } else {
        server.name.clone()
    }
}

fn server_not_found(id: &str) -> String {
    format!("연결 서버 {id}를 찾지 못했습니다. 목록을 새로 고친 뒤 다시 고르세요")
}

fn new_server_id() -> String {
    format!(
        "{SERVER_ID_PREFIX}{}",
        &uuid::Uuid::new_v4().simple().to_string()[..12]
    )
}

/// 예전 저장본을 옮길 때의 ID. 같은 지문은 언제나 같은 ID가 되어, 옮기기가 두 번 돌아도
/// 승인·터미널이 가리키던 자리가 흔들리지 않는다.
fn migrated_server_id(fingerprint: &str) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(fingerprint.as_bytes());
    let hex = digest
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    format!("{SERVER_ID_PREFIX}{}", &hex[..12])
}

pub(crate) fn validate_server_id(value: &str) -> Result<&str, CoreError> {
    let value = value.trim();
    let valid = value.starts_with(SERVER_ID_PREFIX)
        && value.len() > SERVER_ID_PREFIX.len()
        && value.len() <= MAX_SERVER_ID_CHARS
        && value.chars().all(|character| {
            character.is_ascii_lowercase() || character.is_ascii_digit() || character == '-'
        });
    if !valid {
        return Err(CoreError::InvalidInput(format!(
            "서버 ID 형식이 아닙니다: {value}"
        )));
    }
    Ok(value)
}

fn validate_server_name(value: &str) -> Result<&str, CoreError> {
    let value = value.trim();
    if value.chars().count() > MAX_SERVER_NAME_CHARS
        || value.chars().any(|character| character.is_control())
    {
        return Err(CoreError::InvalidInput(format!(
            "서버 이름은 제어문자 없이 {MAX_SERVER_NAME_CHARS}자 이하여야 합니다"
        )));
    }
    Ok(value)
}

/// 에이전트 실행에 딸린 선택지는 서로 독립된 토글이 아니다. 저장 배선과 분리해
/// 개인키·에이전트 사용·파일 전송·출력 표시 사이의 의존성을 한 자리에서 검증한다.
fn validate_endpoint_options(
    request: &SaveSshServerRequest,
    has_private_key: bool,
) -> Result<String, CoreError> {
    // 개인키가 없으면 이 키로는 접속 자체가 되지 않는다. 에이전트에게 켜 주는 순간
    // 실패만 하는 항목이 되므로 저장 시점에 막는다.
    if request.agent_enabled && !has_private_key {
        return Err(CoreError::Conflict(
            "개인키가 없는 공개키는 에이전트 사용을 켤 수 없습니다".to_owned(),
        ));
    }
    // C16-10. git 원격용은 에이전트 권한이 아니라 사용자의 git이 쓸 신원이므로
    // `require_agent_use`를 거치지 않는다. 개인키 조건만 같다.
    if request.project_git_enabled && !has_private_key {
        return Err(CoreError::Conflict(
            "개인키가 없는 공개키는 git 원격용으로 켤 수 없습니다".to_owned(),
        ));
    }
    // 세 기능 모두 에이전트가 실행할 때만 의미가 있다. 꺼진 서버에 종속 기능만 켜 두면
    // 화면의 사용 상태와 실제 권한 또는 경유 실행 안내가 어긋난다.
    require_agent_use(
        request.agent_enabled,
        request.file_transfer_enabled,
        "파일 전송을",
    )?;
    require_agent_use(
        request.agent_enabled,
        request.terminal_enabled,
        "출력 표시를",
    )?;
    require_agent_use(
        request.agent_enabled,
        request.unrestricted_commands,
        "무제한 명령 허용을",
    )?;
    if request.file_transfer_enabled {
        crate::ssh_exec::validate_transfer_root(&request.transfer_root)
    } else {
        Ok(String::new())
    }
}

fn require_agent_use(
    agent_enabled: bool,
    feature_enabled: bool,
    feature_phrase: &str,
) -> Result<(), CoreError> {
    if feature_enabled && !agent_enabled {
        return Err(CoreError::Conflict(format!(
            "에이전트 사용이 꺼진 연결 서버에는 {feature_phrase} 켤 수 없습니다"
        )));
    }
    Ok(())
}

/// C9-17. 사용자가 승인한 명령 한 줄을 그 서버의 허용 명령 목록 끝에 적는다.
///
/// 화면 편집(`save_ssh_server`)이 목록을 통째로 교체하는 것과 달리 여기서는 **한 줄만
/// 덧붙인다**. 통째로 받으면 이미 적혀 있던 규칙을 이 경로가 지울 수 있고, 그것은 사용자가
/// 승인 카드에서 읽은 결정("이 명령을 추가한다")보다 넓다. 같은 줄이 이미 있으면 아무것도
/// 바꾸지 않고 `false`를 돌려준다.
pub(crate) fn append_allowed_command(
    app_data_dir: &Path,
    server_id: &str,
    command: &str,
) -> Result<bool, CoreError> {
    let rule = command.trim();
    if rule.is_empty() {
        return Err(CoreError::InvalidInput(
            "허용 목록에 적을 명령이 비어 있습니다".to_owned(),
        ));
    }
    edit_servers(app_data_dir, |servers| {
        let endpoint = servers
            .iter_mut()
            .find(|saved| saved.id == server_id)
            .ok_or_else(|| CoreError::NotFound(server_not_found(server_id)))?;
        if endpoint.allowed_commands.iter().any(|value| value == rule) {
            return Ok(false);
        }
        let mut allowed = endpoint.allowed_commands.clone();
        allowed.push(rule.to_owned());
        endpoint.allowed_commands = validate_command_rules(&allowed, "허용")?;
        endpoint.updated_at = now_ms();
        Ok(true)
    })
}

fn check_ssh_endpoint_with(
    home: &Path,
    app_data_dir: &Path,
    executable: &Path,
    request: &SshServerRef,
) -> Result<SshEndpointCheckReceipt, CoreError> {
    let ResolvedServer { server, key } =
        resolve_server(home, app_data_dir, Some(&request.server_id), "")?;
    let identity = Path::new(&key.path).with_extension("");
    if !private_key_present(&identity)? {
        return Err(CoreError::Conflict(
            "같은 이름의 개인키가 없어 접속을 확인할 수 없습니다".to_owned(),
        ));
    }
    let askpass = askpass_for(app_data_dir, &key)?;

    let destination = destination(&server);
    let identity = identity.to_string_lossy().into_owned();
    let port = server.port.to_string();
    let mut args = connect_args(&identity, &port, askpass.is_some());
    args.extend([
        "-o".to_owned(),
        format!("ConnectTimeout={CHECK_CONNECT_TIMEOUT_SECONDS}"),
        target(&server),
        CHECK_REMOTE_COMMAND.to_owned(),
    ]);
    let borrowed = args.iter().map(String::as_str).collect::<Vec<_>>();
    let env = crate::ssh_askpass::env_of(askpass.as_ref());
    let outcome =
        crate::cli_interface::run_capped_with_env(executable, &borrowed, CHECK_TIMEOUT, &env)?;
    drop(askpass);

    Ok(SshEndpointCheckReceipt {
        server_id: server.id,
        fingerprint: server.fingerprint,
        destination,
        reachable: outcome.success,
        timed_out: outcome.timed_out,
        message: check_message(outcome.success, outcome.timed_out, &outcome.stderr),
    })
}

/// C9-21. 이 키의 저장된 암호. 암호가 없는 키(보통)는 `None`이고 보안 저장소를 두드리지 않는다.
pub(crate) fn key_passphrase(
    app_data_dir: &Path,
    key: &SshKeyView,
) -> Result<Option<zeroize::Zeroizing<String>>, CoreError> {
    if !key.passphrase_saved {
        return Ok(None);
    }
    crate::ssh_askpass::load_passphrase(
        &crate::ssh_askpass::OsPassphraseVault,
        app_data_dir,
        &key.fingerprint,
    )
}

/// C9-21. 접속 한 번 동안 열려 있을 askpass 세션. 한 번만 답한다.
pub(crate) fn askpass_session(
    passphrase: Option<zeroize::Zeroizing<String>>,
) -> Result<Option<crate::ssh_askpass::AskpassSession>, CoreError> {
    passphrase
        .map(|secret| {
            crate::ssh_askpass::AskpassSession::start(secret, crate::ssh_askpass::CONNECT_ANSWERS)
        })
        .transpose()
}

/// 키의 암호를 꺼내 바로 세션을 연다. 접속을 한 번만 하는 자리(연결 확인·git)가 쓴다.
pub(crate) fn askpass_for(
    app_data_dir: &Path,
    key: &SshKeyView,
) -> Result<Option<crate::ssh_askpass::AskpassSession>, CoreError> {
    askpass_session(key_passphrase(app_data_dir, key)?)
}

/// C9-19. 사용자가 직접 타이핑하는 대화형 터미널의 실행 사양. `ssh` 실행 파일과 인자만
/// 담고, 개인키는 경로로만 넘어간다(G4).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SshTerminalLaunch {
    pub server_id: String,
    pub destination: String,
    pub executable: std::path::PathBuf,
    pub args: Vec<String>,
}

/// C9-19. 저장된 연결 서버로 사용자가 직접 붙는 대화형 세션의 실행 사양을 만든다.
///
/// 에이전트 사용 토글은 보지 않는다 — 그 토글은 에이전트에게 열어 줄지에 대한 결정이고,
/// 사용자가 자기 키로 자기 서버에 붙는 것은 그 결정과 무관하다. 개인키는 있어야 한다.
/// `BatchMode`를 빼는 것이 이 경로의 요점이다. 패스프레이즈·암호·호스트 키 확인 프롬프트를
/// 사용자가 그 창에서 직접 답하는 것이 이 터미널이 있는 이유이기 때문이다.
pub fn ssh_terminal_launch(
    app_data_dir: &Path,
    server_id: &str,
) -> Result<SshTerminalLaunch, CoreError> {
    let executable = crate::providers::resolve_named_executable(&["ssh"])?;
    ssh_terminal_launch_with(&home_dir()?, app_data_dir, &executable, server_id)
}

fn ssh_terminal_launch_with(
    home: &Path,
    app_data_dir: &Path,
    executable: &Path,
    server_id: &str,
) -> Result<SshTerminalLaunch, CoreError> {
    let resolved = resolve_interactive_target(home, app_data_dir, server_id)?;
    let mut args = resolved.interactive_args();
    args.push(target(&resolved.endpoint));
    Ok(resolved.launch(executable, args))
}

/// C9-20. 이 키의 공개키를 원격 `authorized_keys`에 등록하는 대화형 실행 사양을 만든다.
///
/// Windows에는 `ssh-copy-id`가 없고, 키를 서버에 올리려면 사용자가 손으로 옮겨야 한다.
/// 그 한 번을 대신하는 경로다. 앱은 비밀번호를 받지도 저장하지도 않는다 — `BatchMode`가
/// 없는 이 터미널에서 사용자가 직접 답하고, 그 뒤부터는 지금까지처럼 키로만 붙는다.
///
/// 저장된 키를 그대로 내밀므로(`-i`·`IdentitiesOnly`) 이미 등록된 서버에서는 비밀번호를
/// 묻지 않고, 원격 명령도 같은 줄이 있으면 덧붙이지 않는다. 즉 몇 번을 눌러도 결과가
/// 같다.
pub fn ssh_key_install_launch(
    app_data_dir: &Path,
    server_id: &str,
) -> Result<SshTerminalLaunch, CoreError> {
    let executable = crate::providers::resolve_named_executable(&["ssh"])?;
    ssh_key_install_launch_with(&home_dir()?, app_data_dir, &executable, server_id)
}

fn ssh_key_install_launch_with(
    home: &Path,
    app_data_dir: &Path,
    executable: &Path,
    server_id: &str,
) -> Result<SshTerminalLaunch, CoreError> {
    let resolved = resolve_interactive_target(home, app_data_dir, server_id)?;
    let public_key = crate::ssh_keys::authorized_key_line(
        home,
        &crate::ssh_keys::SshKeyRef {
            file_name: resolved.file_name.clone(),
            fingerprint: resolved.fingerprint.clone(),
        },
    )?;
    let mut args = resolved.interactive_args();
    // 비밀번호 프롬프트가 이 창에 닿아야 하므로 원격 명령을 붙여도 tty를 강제한다.
    args.push("-t".to_owned());
    args.push(target(&resolved.endpoint));
    args.push(authorized_keys_command(&public_key));
    Ok(resolved.launch(executable, args))
}

/// 원격에서 한 번만 효과가 있는 `authorized_keys` 등록 명령.
///
/// 폴더와 파일 권한을 OpenSSH가 요구하는 값으로 맞추고, 같은 줄이 이미 있으면 아무것도
/// 하지 않는다. 공개키는 [`crate::ssh_keys::authorized_key_line`]이 작은따옴표를 깨뜨릴 수
/// 있는 글자를 지운 뒤 돌려준 값이라 그대로 묶어 넘긴다.
fn authorized_keys_command(public_key: &str) -> String {
    format!(
        "set -e; \
         umask 077; \
         mkdir -p ~/.ssh; \
         touch ~/.ssh/authorized_keys; \
         chmod 700 ~/.ssh; \
         chmod 600 ~/.ssh/authorized_keys; \
         if grep -qxF '{public_key}' ~/.ssh/authorized_keys; then \
         echo '이미 등록되어 있습니다.'; \
         else \
         printf '%s\\n' '{public_key}' >> ~/.ssh/authorized_keys; \
         echo '공개키를 등록했습니다.'; \
         fi"
    )
}

/// 대화형 실행 두 갈래가 공통으로 요구하는 것: 목록에 있는 키, 저장된 연결 서버, 그리고
/// 같은 이름의 개인키.
struct InteractiveTarget {
    server_id: String,
    fingerprint: String,
    file_name: String,
    endpoint: SshEndpointView,
    identity: PathBuf,
}

impl InteractiveTarget {
    /// 두 갈래가 함께 쓰는 인자. `BatchMode`가 없는 것이 요점이다 — 패스프레이즈·비밀번호·
    /// 호스트 키 확인 프롬프트가 사용자에게 닿아야 한다.
    fn interactive_args(&self) -> Vec<String> {
        vec![
            "-i".to_owned(),
            self.identity.to_string_lossy().into_owned(),
            "-p".to_owned(),
            self.endpoint.port.to_string(),
            "-o".to_owned(),
            "IdentitiesOnly=yes".to_owned(),
            "-o".to_owned(),
            format!("ConnectTimeout={CHECK_CONNECT_TIMEOUT_SECONDS}"),
        ]
    }

    fn launch(self, executable: &Path, args: Vec<String>) -> SshTerminalLaunch {
        SshTerminalLaunch {
            destination: destination(&self.endpoint),
            server_id: self.server_id,
            executable: executable.to_path_buf(),
            args,
        }
    }
}

fn resolve_interactive_target(
    home: &Path,
    app_data_dir: &Path,
    server_id: &str,
) -> Result<InteractiveTarget, CoreError> {
    let ResolvedServer { server, key } = resolve_server(home, app_data_dir, Some(server_id), "")?;
    let identity = Path::new(&key.path).with_extension("");
    if !private_key_present(&identity)? {
        return Err(CoreError::Conflict(
            "같은 이름의 개인키가 없어 이 키로는 접속할 수 없습니다".to_owned(),
        ));
    }
    Ok(InteractiveTarget {
        server_id: server.id.clone(),
        fingerprint: key.fingerprint.clone(),
        file_name: key.file_name.clone(),
        endpoint: server,
        identity,
    })
}

fn list_agent_ssh_endpoints_with(
    home: &Path,
    app_data_dir: &Path,
) -> Result<AgentSshEndpointsView, CoreError> {
    let snapshot = crate::ssh_keys::snapshot_with_metadata(home, app_data_dir)?;
    let mut endpoints = Vec::new();
    let mut skipped = Vec::new();
    for server in snapshot
        .servers
        .iter()
        .filter(|server| server.agent_enabled)
    {
        let skip = |reason: &str| AgentSshEndpointSkip {
            server_id: server.id.clone(),
            name: server.name.clone(),
            fingerprint: server.fingerprint.clone(),
            reason: reason.to_owned(),
        };
        // 키가 지워졌는데 서버만 남은 항목도 조용히 빼지 않는다. 사용자는 켜 두었다고
        // 알고 있으므로, 왜 안 보이는지 함께 말해야 설정 화면을 다시 열 수 있다.
        let Some(key) = snapshot
            .keys
            .iter()
            .find(|key| key.fingerprint == server.fingerprint)
        else {
            skipped.push(skip("이 서버가 쓰는 키의 공개키가 ~/.ssh에 없습니다"));
            continue;
        };
        if !key.has_private_key {
            skipped.push(skip(
                "같은 이름의 개인키가 없어 이 키로는 접속할 수 없습니다",
            ));
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
        // C9-21. 암호가 걸린 키는 에이전트 셸에서 직접 열 수 없다. 접속 인자를 내주지 않고
        // 앱 경유 실행만 남긴다 — 암호가 에이전트 환경에 들어갈 길을 만들지 않는다.
        let passphrase_protected = key.passphrase_saved;
        let ssh_args = if passphrase_protected {
            Vec::new()
        } else {
            let mut args = connect_args(&identity_path, &server.port.to_string(), false);
            args.push(target(server));
            args
        };
        endpoints.push(AgentSshEndpointView {
            server_id: server.id.clone(),
            name: server.name.clone(),
            fingerprint: key.fingerprint.clone(),
            key_file_name,
            identity_path,
            host: server.host.clone(),
            port: server.port,
            user: server.user.clone(),
            note: key.note.clone(),
            destination: destination(server),
            ssh_command: if ssh_args.is_empty() {
                String::new()
            } else {
                ssh_command(&ssh_args)
            },
            ssh_args,
            command_policy_mode: server.command_policy_mode(),
            allowed_commands: server.allowed_commands.clone(),
            denied_commands: server.denied_commands.clone(),
            file_transfer_enabled: server.file_transfer_enabled,
            transfer_root: server.transfer_root.clone(),
            terminal_enabled: server.terminal_enabled,
            passphrase_protected,
            unrestricted_commands: server.unrestricted_commands,
            relay_args: relay_args(&server.id),
        });
    }

    Ok(AgentSshEndpointsView {
        schema_version: AGENT_LISTING_VERSION,
        endpoints,
        skipped,
        issues: snapshot.issues,
    })
}

/// 저장된 서버 전체를 키 목록 스냅샷에 붙인다. 읽지 못해도 키 목록은 보여 줘야 하므로
/// 실패는 issues로만 알린다.
pub(crate) fn attach_servers(snapshot: &mut SshKeysSnapshot, app_data_dir: &Path) {
    match load_servers(app_data_dir) {
        Ok(servers) => snapshot.servers = servers,
        Err(error) => snapshot.issues.push(SshKeyIssue {
            path: SERVERS_STORE
                .path(app_data_dir)
                .to_string_lossy()
                .into_owned(),
            message: format!("SSH 연결 서버 설정을 읽지 못해 서버 없이 표시합니다: {error}"),
        }),
    }
}

/// 서버 저장본을 잠근 채 읽는다. 아직 없고 예전 지문별 저장본이 있으면 이 자리에서 한 번
/// 옮겨 적는다. 예전 파일은 지우지 않는다 — 옮긴 결과가 이상하면 그대로 되돌아갈 수 있다.
fn load_servers_unlocked(app_data_dir: &Path) -> Result<SshServerStore, CoreError> {
    if SERVERS_STORE.path(app_data_dir).exists() || !ENDPOINTS_STORE.path(app_data_dir).exists() {
        return SERVERS_STORE.load_unlocked(app_data_dir);
    }
    let legacy: SshEndpointStore = ENDPOINTS_STORE.read(app_data_dir)?;
    let servers = legacy
        .endpoints
        .into_iter()
        .map(|(fingerprint, mut endpoint)| {
            endpoint.id = migrated_server_id(&fingerprint);
            endpoint.name = String::new();
            endpoint.fingerprint = fingerprint;
            endpoint
        })
        .collect();
    let store = SshServerStore {
        schema_version: SERVERS_VERSION,
        servers,
    };
    SERVERS_STORE.save_unlocked(app_data_dir, &store)?;
    Ok(store)
}

fn edit_servers(
    app_data_dir: &Path,
    edit: impl FnOnce(&mut Vec<SshEndpointView>) -> Result<bool, CoreError>,
) -> Result<bool, CoreError> {
    SERVERS_STORE.with_lock(app_data_dir, || {
        let mut store = load_servers_unlocked(app_data_dir)?;
        let changed = edit(&mut store.servers)?;
        if changed {
            SERVERS_STORE.save_unlocked(app_data_dir, &store)?;
        }
        Ok(changed)
    })
}

fn load_servers(app_data_dir: &Path) -> Result<Vec<SshEndpointView>, CoreError> {
    SERVERS_STORE.with_lock(app_data_dir, || {
        Ok(load_servers_unlocked(app_data_dir)?.servers)
    })
}

/// C16-10. 프로젝트 git의 네트워크 작업이 쓸 신원 하나.
#[derive(Clone)]
pub(crate) struct ProjectGitIdentity {
    /// `ssh`에 `-i`로 넘길 개인키 경로. 영수증에서 가릴 때도 이 문자열을 그대로 쓴다.
    pub(crate) identity_path: String,
    /// `GIT_SSH_COMMAND`에 넣을 값. git이 셸 없이 자기 분해기로 나누므로 경로를 따옴표로 감싼다.
    pub(crate) ssh_command: String,
    /// C9-21. 키에 암호가 걸려 있으면 이 호출 동안 열려 있는 askpass 세션. git이 띄우는 `ssh`가
    /// 환경을 물려받아 암호를 받는다.
    pub(crate) askpass: Option<std::sync::Arc<crate::ssh_askpass::AskpassSession>>,
}

impl ProjectGitIdentity {
    /// git 호출 하나에 얹을 환경.
    pub(crate) fn env(&self) -> Vec<(String, String)> {
        let mut env = vec![("GIT_SSH_COMMAND".to_owned(), self.ssh_command.clone())];
        if let Some(session) = &self.askpass {
            env.extend(session.env());
        }
        env
    }
}

/// C16-11. "git 원격용"을 켜 둔 서버가 있는가. 키를 열지도, 암호를 꺼내지도 않는다 — 형상관리
/// 개요가 원격마다 인증 수단을 매길 때 화면을 새로 고칠 때마다 부르는 자리다. 읽지 못하면 없는
/// 것으로 본다.
pub(crate) fn project_git_key_enabled(app_data_dir: &Path) -> bool {
    load_servers(app_data_dir)
        .map(|servers| servers.iter().any(|server| server.project_git_enabled))
        .unwrap_or(false)
}

/// C16-10. "git 원격용"을 켜 둔 키가 있으면 그 신원을 만들어 준다.
///
/// 켜 둔 키가 없거나 개인키가 사라졌으면 `None`이고, 그때 git은 지금까지처럼 자기 기본값으로
/// 붙는다 — 이 자리는 인증을 **더해 줄** 뿐 빼앗지 않는다. 개인키는 열지 않고 존재만 본다(G4).
pub(crate) fn project_git_identity(
    app_data_dir: &Path,
) -> Result<Option<ProjectGitIdentity>, CoreError> {
    project_git_identity_with(&home_dir()?, app_data_dir)
}

fn project_git_identity_with(
    home: &Path,
    app_data_dir: &Path,
) -> Result<Option<ProjectGitIdentity>, CoreError> {
    // 켜 둔 서버가 없는 것이 보통이므로 앱 데이터 한 번만 읽고 끝낸다. `~/.ssh` 훑기는
    // 실제로 켜 둔 서버가 있을 때만 치른다.
    let servers = load_servers(app_data_dir)?;
    let Some(server) = servers.iter().find(|server| server.project_git_enabled) else {
        return Ok(None);
    };
    let snapshot = crate::ssh_keys::snapshot_with_metadata(home, app_data_dir)?;
    let Some(key) = snapshot
        .keys
        .iter()
        .find(|key| key.fingerprint == server.fingerprint)
    else {
        return Ok(None);
    };
    if !key.has_private_key {
        return Ok(None);
    }
    let identity = PathBuf::from(&key.path).with_extension("");
    if !private_key_present(&identity)? {
        return Ok(None);
    }
    let identity_path = identity.to_string_lossy().into_owned();
    let executable = crate::providers::resolve_named_executable(&["ssh"])?;
    // 암호를 꺼내지 못한 것은 "신원 없음"과 다르다. 조용히 git 기본 신원으로 붙으면 사용자는
    // 엉뚱한 인증 실패만 본다 — 읽을 수 있는 이유를 그대로 올린다(git 경로는 Conflict를
    // 삼키지 않는다).
    let askpass = askpass_for(app_data_dir, key)
        .map_err(|error| {
            CoreError::Conflict(format!(
                "git 원격용 키의 암호를 꺼내지 못했습니다. 애드온 → SSH에서 암호를 다시 저장하세요: {error}"
            ))
        })?
        .map(std::sync::Arc::new);
    let ssh_command = ssh_command_line(
        &executable.to_string_lossy(),
        &identity_path,
        askpass.is_some(),
    )?;
    Ok(Some(ProjectGitIdentity {
        identity_path,
        ssh_command,
        askpass,
    }))
}

/// `GIT_SSH_COMMAND` 한 줄. git은 이 값을 **셸에 넘긴다** — `GIT_SSH`와 달리 추가 인자를
/// 적을 수 있는 것이 그 때문이다. 그래서 공백·`$`·`;` 같은 글자가 든 경로가 그대로 명령이
/// 되지 않도록 작은따옴표로 감싼다. 그 안에서 무력해지지 않는 것은 작은따옴표 자신뿐이라
/// 그것과 제어문자만 거절하면 된다 — 조용히 잘린 인자를 넘기는 것보다 켜는 자리에서
/// 실패하는 편이 낫다(G9).
fn ssh_command_line(
    executable: &str,
    identity_path: &str,
    locked: bool,
) -> Result<String, CoreError> {
    for value in [executable, identity_path] {
        if value.contains('\'') || value.chars().any(char::is_control) {
            return Err(CoreError::InvalidInput(
                "SSH 실행 파일이나 개인키 경로에 따옴표·제어문자가 있어 git 신원으로 쓸 수 없습니다"
                    .to_owned(),
            ));
        }
    }
    let mut line = format!("'{executable}' -i '{identity_path}'");
    for option in auth_options(locked) {
        line.push_str(" -o ");
        line.push_str(&option);
    }
    Ok(line)
}

/// 모든 접속에 공통으로 붙는 인자. 저장한 키만 쓰게 하고(`IdentitiesOnly`), 어떤 경로에서도
/// 사람에게 묻는 프롬프트로 멈추지 않게 한다. `locked`는 C9-21 암호 키다.
pub(crate) fn connect_args(identity: &str, port: &str, locked: bool) -> Vec<String> {
    transport_args(identity, "-p", port, locked)
}

/// `scp`에 붙는 공통 인자. `ssh`와 같은 뜻이지만 포트 플래그가 `-P`로 다르다.
pub(crate) fn scp_args(identity: &str, port: &str, locked: bool) -> Vec<String> {
    transport_args(identity, "-P", port, locked)
}

/// 두 인자 벌의 실체. 포트 플래그만 다르므로 그것만 받는다.
fn transport_args(identity: &str, port_flag: &str, port: &str, locked: bool) -> Vec<String> {
    let mut args = vec![
        "-i".to_owned(),
        identity.to_owned(),
        port_flag.to_owned(),
        port.to_owned(),
    ];
    for option in auth_options(locked) {
        args.push("-o".to_owned());
        args.push(option);
    }
    args
}

/// 인증 옵션. 암호 없는 키는 `BatchMode`로 어떤 질문도 받지 않는다.
///
/// C9-21. 암호 키는 `BatchMode`를 켜면 askpass까지 막히므로 끄되, 질문이 키 암호 하나만 남게
/// 좁힌다 — 공개키 인증만 쓰고(비밀번호·키보드 대화형 인증 끔) 암호 질문은 한 번이다. 이
/// 옵션들은 다른 옵션보다 **앞에** 놓인다. `ssh`는 같은 옵션의 첫 값을 쓰므로, 뒤에 붙는
/// `NumberOfPasswordPrompts=0`이 암호 질문을 다시 막지 못한다. 호스트 키 확인 질문은
/// askpass가 답하지 않으므로(키 암호 질문이 아니다) 예전처럼 실패로 끝난다.
fn auth_options(locked: bool) -> Vec<String> {
    let options: &[&str] = if locked {
        &[
            "IdentitiesOnly=yes",
            "BatchMode=no",
            "PreferredAuthentications=publickey",
            "PasswordAuthentication=no",
            "KbdInteractiveAuthentication=no",
            "NumberOfPasswordPrompts=1",
        ]
    } else {
        &["IdentitiesOnly=yes", "BatchMode=yes"]
    };
    options.iter().map(|value| (*value).to_owned()).collect()
}

/// `ssh`가 받는 목적지. IPv6 리터럴은 대괄호로 감싸야 사용자 이름과 구분된다.
pub(crate) fn target(endpoint: &SshEndpointView) -> String {
    if endpoint.host.contains(':') {
        format!("{}@[{}]", endpoint.user, endpoint.host)
    } else {
        format!("{}@{}", endpoint.user, endpoint.host)
    }
}

/// 사람이 읽는 표기. 포트까지 붙여 화면과 결과에서 같은 문자열을 쓴다.
pub(crate) fn destination(endpoint: &SshEndpointView) -> String {
    format!("{}:{}", target(endpoint), endpoint.port)
}

/// 스킬이 그대로 붙여 넣을 수 있는 한 줄. 홈 경로에 공백이 있어도 깨지지 않게 인용한다.
/// C9-18. 터미널 표시가 켜진 서버에서 스킬이 `ssh` 대신 쓰는 경유 실행 인자. `<CLI>`와
/// 접두사 뒤에 붙이고, 마지막 `--` 뒤에 원격 명령 단어를 그대로 이어 붙인다.
pub(crate) fn relay_args(server_id: &str) -> Vec<String> {
    vec![
        "ssh".to_owned(),
        "exec".to_owned(),
        "--server".to_owned(),
        server_id.to_owned(),
        "--".to_owned(),
    ]
}

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
    validate_bounded_token(
        value,
        MAX_HOST_CHARS,
        |first| first.is_ascii_alphanumeric(),
        |character| character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '_' | ':'),
        "호스트는 영문·숫자로 시작하는 253자 이하의 영문·숫자·점·하이픈·밑줄·콜론이어야 합니다",
    )
}

fn validate_user(value: &str) -> Result<&str, CoreError> {
    validate_bounded_token(
        value,
        MAX_USER_CHARS,
        |first| first.is_ascii_alphanumeric() || first == '_',
        |character| character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '_'),
        "사용자 이름은 영문·숫자·밑줄로 시작하는 64자 이하의 영문·숫자·점·하이픈·밑줄이어야 합니다",
    )
}

/// 선두 한 글자와 나머지 본문에 각각 허용 문자를 두고 전체 길이 상한을 보는 검사. 호스트와
/// 사용자 이름이 허용 문자와 안내 문구만 달리하고 같은 모양을 쓴다.
fn validate_bounded_token<'a>(
    value: &'a str,
    max_chars: usize,
    leading: impl Fn(char) -> bool,
    body: impl Fn(char) -> bool,
    message: &str,
) -> Result<&'a str, CoreError> {
    let value = value.trim();
    let mut characters = value.chars();
    let valid = characters.next().is_some_and(leading)
        && value.chars().count() <= max_chars
        && characters.all(body);
    if !valid {
        return Err(CoreError::InvalidInput(message.to_owned()));
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

/// 스킬이 부르는 진입점. `<CLI> ssh list`는 켜 둔 엔드포인트를 JSON으로 내려 주고,
/// `<CLI> ssh exec`(C9-18)는 명령 하나를 떠 있는 백엔드에 맡겨 실행한 영수증을 내려 준다.
pub fn run_ssh_endpoint_cli(args: impl Iterator<Item = String>) -> Result<(), CoreError> {
    let mut args = args;
    let operation = args.next().ok_or_else(|| {
        CoreError::InvalidInput("ssh 다음에 작업이 필요합니다: list | exec".to_owned())
    })?;
    match operation.as_str() {
        "list" => {
            let app_data_dir = parse_list_args(args)?;
            let view = list_agent_ssh_endpoints(&app_data_dir)?;
            println!("{}", serde_json::to_string_pretty(&view)?);
            Ok(())
        }
        "exec" => {
            let options = SshExecCliOptions::from_args(args)?;
            let receipt = relay_ssh_command(&options)?;
            let succeeded = receipt
                .get("succeeded")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false);
            println!("{}", serde_json::to_string_pretty(&receipt)?);
            if !succeeded {
                // 영수증은 이미 stdout에 있다. 실패를 종료 코드로도 알려, 출력을 읽지 않는
                // 호출자도 성공으로 오해하지 않게 한다.
                std::process::exit(1);
            }
            Ok(())
        }
        other => Err(CoreError::InvalidInput(format!(
            "알 수 없는 작업입니다: {other}. list | exec 중 하나를 쓰세요"
        ))),
    }
}

/// `--플래그 값` 꼴 인자를 읽는 한 벌의 규칙. 값이 빠졌을 때의 문구와 모르는 플래그를
/// 거절하는 문구를 `list`·`exec` 두 파서가 플래그마다 따로 적고 있었다 — 플래그가 하나
/// 늘 때마다 같은 문장을 또 적게 되고, 한쪽만 손보면 두 하위 명령의 안내가 갈라진다.
struct FlagArgs<I> {
    inner: I,
}

impl<I: Iterator<Item = String>> FlagArgs<I> {
    fn new(inner: I) -> Self {
        Self { inner }
    }

    fn next_flag(&mut self) -> Option<String> {
        self.inner.next()
    }

    fn value(&mut self, flag: &str) -> Result<String, CoreError> {
        self.inner
            .next()
            .ok_or_else(|| CoreError::InvalidInput(format!("{flag} 값이 필요합니다")))
    }

    fn path_value(&mut self, flag: &str) -> Result<std::path::PathBuf, CoreError> {
        self.value(flag).map(std::path::PathBuf::from)
    }

    /// `--` 뒤에 남은 단어 전부. 경계는 셸이 이미 갈라 두었으므로 그대로 넘긴다.
    fn rest(&mut self) -> Vec<String> {
        self.inner.by_ref().collect()
    }
}

/// 모르는 플래그를 만났을 때의 거절. `hint`는 하위 명령마다 다른 뒷말이다.
fn unknown_argument(flag: &str, hint: &str) -> CoreError {
    CoreError::InvalidInput(format!("알 수 없는 인자입니다: {flag}{hint}"))
}

fn parse_list_args(args: impl Iterator<Item = String>) -> Result<std::path::PathBuf, CoreError> {
    let mut args = FlagArgs::new(args);
    let mut app_data_dir = None;
    while let Some(flag) = args.next_flag() {
        match flag.as_str() {
            "--app-data-dir" => app_data_dir = Some(args.path_value("--app-data-dir")?),
            other => return Err(unknown_argument(other, "")),
        }
    }
    crate::remote::cli_app_data_dir(app_data_dir)
}

/// C9-18. 에이전트가 자기 셸에서 `AGENT_MANAGER_CHAT_ID`를 물려받아 부르는 환경 변수.
/// 관리 채팅이 띄운 CLI 자식에게 백엔드가 심어 두므로, 그 셸에서 실행한 경유 명령은 자기가
/// 어느 대화에서 왔는지 안다. 없으면 출력은 흐르지 않고 실행만 된다.
pub const RELAY_CHAT_ID_ENV: &str = "AGENT_MANAGER_CHAT_ID";

/// `<CLI> ssh exec --server <서버 ID> [--timeout <초>] [--app-data-dir <경로>] -- <명령…>`
///
/// 예전 스킬이 쓰던 `--fingerprint <지문>`도 받는다. 그 키를 쓰는 서버가 하나일 때만 실행된다.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SshExecCliOptions {
    pub(crate) server_id: Option<String>,
    pub(crate) fingerprint: String,
    pub(crate) command: String,
    pub(crate) timeout_seconds: Option<u64>,
    pub(crate) app_data_dir: std::path::PathBuf,
    pub(crate) chat_id: Option<String>,
}

impl SshExecCliOptions {
    fn from_args(args: impl Iterator<Item = String>) -> Result<Self, CoreError> {
        Self::parse(args, std::env::var(RELAY_CHAT_ID_ENV).ok())
    }

    /// 명령은 `--` 뒤 단어를 한 칸씩 띄워 이어 붙인다. 셸이 이미 단어를 갈라 두었으므로
    /// 앱은 그 경계를 그대로 존중하고, 글자 집합 검사는 실행 경로가 한 번 더 한다.
    pub(crate) fn parse(
        args: impl Iterator<Item = String>,
        chat_id: Option<String>,
    ) -> Result<Self, CoreError> {
        let mut args = FlagArgs::new(args);
        let mut server_id = None;
        let mut fingerprint = None;
        let mut timeout_seconds = None;
        let mut app_data_dir = None;
        let mut command_words: Option<Vec<String>> = None;
        while let Some(flag) = args.next_flag() {
            match flag.as_str() {
                "--server" => server_id = Some(args.value("--server")?),
                "--fingerprint" => fingerprint = Some(args.value("--fingerprint")?),
                "--timeout" => {
                    let raw = args.value("--timeout")?;
                    timeout_seconds = Some(raw.parse::<u64>().map_err(|_| {
                        CoreError::InvalidInput(format!(
                            "--timeout 값은 초 단위 정수여야 합니다: {raw}"
                        ))
                    })?);
                }
                "--app-data-dir" => app_data_dir = Some(args.path_value("--app-data-dir")?),
                "--" => {
                    command_words = Some(args.rest());
                    break;
                }
                other => {
                    return Err(unknown_argument(other, ". 원격 명령은 -- 뒤에 적으세요"));
                }
            }
        }
        if server_id.is_none() && fingerprint.is_none() {
            return Err(CoreError::InvalidInput(
                "--server <서버 ID>가 필요합니다".to_owned(),
            ));
        }
        let fingerprint = fingerprint.unwrap_or_default();
        let command = command_words
            .filter(|words| !words.is_empty())
            .map(|words| words.join(" "))
            .ok_or_else(|| {
                CoreError::InvalidInput(
                    "실행할 원격 명령이 필요합니다. -- 뒤에 명령을 적으세요".to_owned(),
                )
            })?;
        Ok(Self {
            server_id,
            fingerprint,
            command,
            timeout_seconds,
            app_data_dir: crate::remote::cli_app_data_dir(app_data_dir)?,
            chat_id: chat_id.filter(|value| !value.trim().is_empty()),
        })
    }
}

/// 떠 있는 백엔드에 실행을 맡긴다. 이 프로세스는 `ssh`를 직접 부르지 않는다 — 집행 지점과
/// 실시간 출력이 모두 백엔드에 있고, 백엔드가 없으면 실행하지 않는다(그때는 스킬이 `ssh`를
/// 직접 쓰는 경로로 돌아가는 대신 사용자에게 앱 실행을 요청한다).
fn relay_ssh_command(options: &SshExecCliOptions) -> Result<serde_json::Value, CoreError> {
    let timeout_seconds = options
        .timeout_seconds
        .unwrap_or(crate::ssh_exec::DEFAULT_COMMAND_TIMEOUT_SECONDS)
        .min(crate::ssh_exec::MAX_COMMAND_TIMEOUT_SECONDS);
    let body = serde_json::json!({
        "request": {
            "serverId": options.server_id,
            "fingerprint": options.fingerprint,
            "command": options.command,
            "timeoutSeconds": options.timeout_seconds,
        },
        "chatId": options.chat_id,
    });
    crate::chat_secret_cli::relay_to_backend(
        &options.app_data_dir,
        "relay_ssh_command",
        &body,
        Duration::from_secs(timeout_seconds.saturating_add(30)),
    )
}

/// 예전 "키 하나에 접속 지점 하나" 모양으로 쓰인 시험을 그대로 돌리는 심. 같은 지문의
/// 서버가 있으면 그 서버를 고치고, 호스트가 비면 그 서버를 지운다.
#[cfg(test)]
pub(crate) type SetSshKeyEndpointRequest = SaveSshServerRequest;

#[cfg(test)]
pub(crate) fn set_ssh_key_endpoint_for_test(
    home: &Path,
    app_data_dir: &Path,
    request: &SaveSshServerRequest,
) -> Result<SshKeysSnapshot, CoreError> {
    let existing = load_servers(app_data_dir)?
        .into_iter()
        .find(|server| server.fingerprint == request.fingerprint)
        .map(|server| server.id);
    if request.host.trim().is_empty() {
        if let Some(server_id) = existing {
            return delete_ssh_server_with(home, app_data_dir, &SshServerRef { server_id });
        }
        return crate::ssh_keys::snapshot_with_metadata(home, app_data_dir);
    }
    let mut request = request.clone();
    request.id = existing;
    save_ssh_server_with(home, app_data_dir, &request)
}

/// 시험이 "이 키의 서버"를 꺼내는 자리. 키 하나에 서버 하나인 시험에서만 쓴다.
#[cfg(test)]
pub(crate) fn endpoint_for_key<'a>(
    snapshot: &'a SshKeysSnapshot,
    fingerprint: &str,
) -> Option<&'a SshEndpointView> {
    snapshot
        .servers
        .iter()
        .find(|server| server.fingerprint == fingerprint)
}

#[cfg(test)]
fn load_endpoints_for_test(
    app_data_dir: &Path,
) -> Result<BTreeMap<String, SshEndpointView>, CoreError> {
    Ok(load_servers(app_data_dir)?
        .into_iter()
        .map(|server| (server.fingerprint.clone(), server))
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 시험이 "이 키의 서버 ID"를 얻는 자리. 서버가 아직 없으면 없는 ID를 돌려준다.
    fn sid(app_data_dir: &Path, fingerprint: &str) -> String {
        load_servers(app_data_dir)
            .ok()
            .and_then(|servers| {
                servers
                    .into_iter()
                    .find(|server| server.fingerprint == fingerprint)
            })
            .map(|server| server.id)
            .unwrap_or_else(|| "srv-missing".to_owned())
    }
    use std::fs;

    use base64::engine::general_purpose::STANDARD;
    use base64::Engine as _;

    fn public_key_line(comment: &str) -> String {
        public_key_line_with_body(comment, 7)
    }

    /// 지문은 키 본문에서 나오고 주석에서 나오지 않는다. 키 둘이 필요한 시험은 본문을
    /// 달리 해야 서로 다른 지문을 얻는다.
    fn public_key_line_with_body(comment: &str, body: u8) -> String {
        let key_type = "ssh-ed25519";
        let mut blob = Vec::new();
        blob.extend_from_slice(&(key_type.len() as u32).to_be_bytes());
        blob.extend_from_slice(key_type.as_bytes());
        blob.extend_from_slice(&32u32.to_be_bytes());
        blob.extend_from_slice(&[body; 32]);
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
            id: None,
            name: String::new(),
            fingerprint: fingerprint.to_owned(),
            host: "build.example.com".to_owned(),
            port: Some(2222),
            user: "deploy".to_owned(),
            agent_enabled,
            allowed_commands: vec!["git pull".to_owned(), "systemctl status".to_owned()],
            denied_commands: vec!["rm -rf".to_owned()],
            file_transfer_enabled: false,
            transfer_root: String::new(),
            terminal_enabled: false,
            unrestricted_commands: false,
            project_git_enabled: false,
        }
    }

    /// C9-9. 엔드포인트는 앱 데이터에만 남고 `~/.ssh` 파일은 그대로다.
    #[test]
    fn c9_endpoints_live_in_app_data_and_never_touch_the_key_files() {
        let home = tempfile::tempdir().expect("home");
        let app_data = tempfile::tempdir().expect("app data");
        let fingerprint = fixture(home.path(), true);
        let before = fs::read_to_string(home.path().join(".ssh/id_example.pub")).expect("read");

        let snapshot = set_ssh_key_endpoint_for_test(
            home.path(),
            app_data.path(),
            &request(&fingerprint, true),
        )
        .expect("save");
        let endpoint =
            endpoint_for_key(&snapshot, &snapshot.keys[0].fingerprint).expect("endpoint");
        assert_eq!(endpoint.host, "build.example.com");
        assert_eq!(endpoint.port, 2222);
        assert_eq!(endpoint.user, "deploy");
        assert!(endpoint.agent_enabled);
        assert_eq!(
            fs::read_to_string(home.path().join(".ssh/id_example.pub")).expect("read"),
            before
        );
        assert!(app_data.path().join(SERVERS_STORE.file).is_file());

        // 호스트를 비우면 저장본에서 사라진다.
        let cleared = set_ssh_key_endpoint_for_test(
            home.path(),
            app_data.path(),
            &SetSshKeyEndpointRequest {
                id: None,
                name: String::new(),
                fingerprint: fingerprint.clone(),
                host: "   ".to_owned(),
                port: None,
                user: String::new(),
                agent_enabled: false,
                allowed_commands: Vec::new(),
                denied_commands: Vec::new(),
                file_transfer_enabled: false,
                transfer_root: String::new(),
                terminal_enabled: false,
                unrestricted_commands: false,
                project_git_enabled: false,
            },
        )
        .expect("clear");
        assert!(endpoint_for_key(&cleared, &cleared.keys[0].fingerprint).is_none());
        assert!(load_endpoints_for_test(app_data.path())
            .expect("load")
            .is_empty());
    }

    /// C9-9. 목록에 없는 지문, 옵션처럼 읽히는 호스트, 개인키 없는 키의 에이전트 사용은
    /// 모두 저장되지 않는다.
    #[test]
    fn c9_endpoint_input_is_bounded_and_agent_use_needs_a_private_key() {
        let home = tempfile::tempdir().expect("home");
        let app_data = tempfile::tempdir().expect("app data");
        let fingerprint = fixture(home.path(), false);

        assert!(set_ssh_key_endpoint_for_test(
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
        assert!(set_ssh_key_endpoint_for_test(
            home.path(),
            app_data.path(),
            &request(&fingerprint, true),
        )
        .is_err());
        let snapshot = set_ssh_key_endpoint_for_test(
            home.path(),
            app_data.path(),
            &request(&fingerprint, false),
        )
        .expect("save");
        assert!(
            !endpoint_for_key(&snapshot, &snapshot.keys[0].fingerprint)
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

        set_ssh_key_endpoint_for_test(home.path(), app_data.path(), &request(&fingerprint, false))
            .expect("save");
        assert!(list_agent_ssh_endpoints_with(home.path(), app_data.path())
            .expect("list")
            .endpoints
            .is_empty());

        set_ssh_key_endpoint_for_test(home.path(), app_data.path(), &request(&fingerprint, true))
            .expect("save");
        let view = list_agent_ssh_endpoints_with(home.path(), app_data.path()).expect("list");
        assert_eq!(view.endpoints.len(), 1);
        let entry = &view.endpoints[0];
        assert_eq!(entry.key_file_name, "id_example");
        assert_eq!(entry.destination, "deploy@build.example.com:2222");
        // 경로는 문자열이 아니라 조각으로 견준다. Windows에서 구분자는 `\`라
        // 문자열 비교는 같은 경로를 두고도 어긋난다.
        assert!(Path::new(&entry.identity_path).ends_with(".ssh/id_example"));
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

    /// C9-18. 터미널 표시는 에이전트 사용이 켜진 서버에만 저장되고, 스킬 목록에는 그 값과
    /// 경유 실행 인자가 함께 실린다. 예전 저장본은 꺼진 상태로 읽힌다.
    #[test]
    fn c9_18_terminal_flag_needs_agent_use_and_reaches_the_listing_with_relay_args() {
        let home = tempfile::tempdir().expect("home");
        let app_data = tempfile::tempdir().expect("app data");
        let fingerprint = fixture(home.path(), true);

        let mut off = request(&fingerprint, false);
        off.terminal_enabled = true;
        assert!(set_ssh_key_endpoint_for_test(home.path(), app_data.path(), &off).is_err());

        let mut on = request(&fingerprint, true);
        on.terminal_enabled = true;
        let snapshot =
            set_ssh_key_endpoint_for_test(home.path(), app_data.path(), &on).expect("save");
        assert!(
            endpoint_for_key(&snapshot, &snapshot.keys[0].fingerprint)
                .expect("endpoint")
                .terminal_enabled
        );

        let view = list_agent_ssh_endpoints_with(home.path(), app_data.path()).expect("list");
        let entry = &view.endpoints[0];
        assert!(entry.terminal_enabled);
        assert_eq!(
            entry.relay_args,
            vec!["ssh", "exec", "--server", entry.server_id.as_str(), "--"]
        );

        // 필드가 없는 예전 저장본은 꺼진 것으로 읽힌다.
        let legacy: SshEndpointView = serde_json::from_str(
            r#"{"host":"h","port":22,"user":"u","agentEnabled":true,"updatedAt":0}"#,
        )
        .expect("legacy");
        assert!(!legacy.terminal_enabled);
    }

    /// 무제한 명령 허용도 에이전트 사용이 켜진 서버에만 저장되고, 켜 두면 정책 모드가
    /// 허용 목록이 적혀 있어도 `unrestricted`가 된다. 예전 저장본은 꺼진 상태로 읽힌다.
    #[test]
    fn unrestricted_flag_needs_agent_use_and_overrides_the_policy_mode() {
        let home = tempfile::tempdir().expect("home");
        let app_data = tempfile::tempdir().expect("app data");
        let fingerprint = fixture(home.path(), true);

        let mut off = request(&fingerprint, false);
        off.unrestricted_commands = true;
        assert!(set_ssh_key_endpoint_for_test(home.path(), app_data.path(), &off).is_err());

        let mut on = request(&fingerprint, true);
        on.unrestricted_commands = true;
        let snapshot =
            set_ssh_key_endpoint_for_test(home.path(), app_data.path(), &on).expect("save");
        let endpoint =
            endpoint_for_key(&snapshot, &snapshot.keys[0].fingerprint).expect("endpoint");
        assert!(endpoint.unrestricted_commands);
        // 허용 목록이 그대로 남아 있어도 모드는 무제한이다 — 토글을 끄면 그 목록으로 돌아온다.
        assert!(!endpoint.allowed_commands.is_empty());
        assert_eq!(
            endpoint.command_policy_mode(),
            SshCommandPolicyMode::Unrestricted
        );

        let view = list_agent_ssh_endpoints_with(home.path(), app_data.path()).expect("list");
        let entry = &view.endpoints[0];
        assert!(entry.unrestricted_commands);
        assert_eq!(
            entry.command_policy_mode,
            SshCommandPolicyMode::Unrestricted
        );
        // 차단 목록은 무제한에서도 그대로 실린다.
        assert_eq!(entry.denied_commands, vec!["rm -rf".to_owned()]);

        let legacy: SshEndpointView = serde_json::from_str(
            r#"{"host":"h","port":22,"user":"u","agentEnabled":true,"updatedAt":0}"#,
        )
        .expect("legacy");
        assert!(!legacy.unrestricted_commands);
    }

    /// C16-10. "git 원격용"은 에이전트 권한이 아니다 — 에이전트 사용이 꺼져 있어도 켤 수
    /// 있어야 하고(개인키만 요구한다), 기기 전체에서 한 키만 켤 수 있으며, 켜도 에이전트
    /// 목록에는 나오지 않는다. 예전 저장본은 꺼진 상태로 읽힌다.
    #[test]
    fn c16_10_project_git_flag_is_a_user_path_bounded_to_one_key() {
        let home = tempfile::tempdir().expect("home");
        let app_data = tempfile::tempdir().expect("app data");
        let first = fixture(home.path(), true);

        // 개인키 없는 공개키는 거절한다 — 신원으로 넘길 파일이 없다.
        let bare_home = tempfile::tempdir().expect("home");
        let bare_app = tempfile::tempdir().expect("app data");
        let bare = fixture(bare_home.path(), false);
        let mut bare_request = request(&bare, false);
        bare_request.project_git_enabled = true;
        assert!(
            set_ssh_key_endpoint_for_test(bare_home.path(), bare_app.path(), &bare_request)
                .is_err()
        );

        // 에이전트 사용이 꺼진 채로 켜진다. 다른 세 토글과 갈리는 지점이다.
        let mut on = request(&first, false);
        on.project_git_enabled = true;
        let snapshot =
            set_ssh_key_endpoint_for_test(home.path(), app_data.path(), &on).expect("save");
        let endpoint =
            endpoint_for_key(&snapshot, &snapshot.keys[0].fingerprint).expect("endpoint");
        assert!(endpoint.project_git_enabled && !endpoint.agent_enabled);
        // 에이전트 목록에는 그대로 나오지 않는다 — 이 토글은 에이전트에게 아무것도 열지 않는다.
        assert!(list_agent_ssh_endpoints_with(home.path(), app_data.path())
            .expect("list")
            .endpoints
            .is_empty());

        // 켜 둔 키가 git 신원으로 뽑히고, 경로는 공개키 이름에서 `.pub`을 뗀 개인키다.
        let identity = project_git_identity_with(home.path(), app_data.path())
            .expect("identity")
            .expect("some");
        assert_eq!(
            identity.identity_path,
            std::fs::canonicalize(home.path())
                .expect("home")
                .join(".ssh/id_example")
                .to_string_lossy()
        );
        assert!(identity.ssh_command.contains(&format!(
            "-i '{}' -o IdentitiesOnly=yes",
            identity.identity_path
        )));

        // 두 번째 키를 같은 용도로 켜면 거절한다. 먼저 켜 둔 키를 조용히 끄지 않는다.
        fs::write(
            home.path().join(".ssh/id_second.pub"),
            public_key_line_with_body("second@example", 9),
        )
        .expect("public");
        fs::write(home.path().join(".ssh/id_second"), b"private material").expect("private");
        let second = crate::ssh_keys::get_ssh_keys_with_home(home.path())
            .expect("inventory")
            .keys
            .iter()
            .find(|key| key.file_name == "id_second.pub")
            .expect("second key")
            .fingerprint
            .clone();
        let mut both = request(&second, false);
        both.project_git_enabled = true;
        let error = set_ssh_key_endpoint_for_test(home.path(), app_data.path(), &both)
            .expect_err("두 번째 키는 거절한다");
        assert!(matches!(error, CoreError::Conflict(_)));
        assert!(
            load_endpoints_for_test(app_data.path())
                .expect("store")
                .get(&first)
                .expect("first")
                .project_git_enabled
        );

        // 끄면 신원이 사라지고, 그때 git은 자기 기본값으로 붙는다.
        let off = request(&first, false);
        set_ssh_key_endpoint_for_test(home.path(), app_data.path(), &off).expect("save");
        assert!(project_git_identity_with(home.path(), app_data.path())
            .expect("identity")
            .is_none());

        let legacy: SshEndpointView = serde_json::from_str(
            r#"{"host":"h","port":22,"user":"u","agentEnabled":true,"updatedAt":0}"#,
        )
        .expect("legacy");
        assert!(!legacy.project_git_enabled);
    }

    /// C16-10. git은 `GIT_SSH_COMMAND`를 **셸에 넘긴다**(`GIT_SSH`와 다른 점이고, 그래서
    /// 추가 인자를 적을 수 있다). 그러므로 경로는 작은따옴표로 감싸고, 그 안에서 무력해지지
    /// 않는 작은따옴표 자체와 제어문자가 들어 있으면 거절한다(G9).
    #[test]
    fn c16_10_ssh_command_line_quotes_paths_and_refuses_unquotable_ones() {
        let line =
            ssh_command_line("/usr/bin/ssh", "/Users/a b/.ssh/id_ed25519", false).expect("line");
        assert_eq!(
            line,
            "'/usr/bin/ssh' -i '/Users/a b/.ssh/id_ed25519' -o IdentitiesOnly=yes -o BatchMode=yes"
        );
        assert!(ssh_command_line("/usr/bin/ssh", "/home/it's/id", false).is_err());
        assert!(ssh_command_line("/usr/bin/ssh", "/home/a\nb/id", false).is_err());
    }

    /// C9-18. `ssh exec`는 지문과 `--` 뒤의 명령을 요구하고, 명령 단어는 한 칸씩 띄워
    /// 잇는다. 대화 id는 환경 변수에서 오며 비어 있으면 없는 것으로 본다.
    #[test]
    fn c9_18_exec_cli_parses_fingerprint_timeout_and_command_after_double_dash() {
        let words = |list: &[&str]| {
            list.iter()
                .map(|value| (*value).to_owned())
                .collect::<Vec<_>>()
                .into_iter()
        };
        let options = SshExecCliOptions::parse(
            words(&[
                "--fingerprint",
                "SHA256:abc",
                "--timeout",
                "20",
                "--app-data-dir",
                "/tmp/app-data",
                "--",
                "systemctl",
                "status",
                "app",
                "--no-pager",
            ]),
            Some("chat-1".to_owned()),
        )
        .expect("parse");
        assert_eq!(options.fingerprint, "SHA256:abc");
        assert_eq!(options.command, "systemctl status app --no-pager");
        assert_eq!(options.timeout_seconds, Some(20));
        assert_eq!(
            options.app_data_dir,
            std::path::PathBuf::from("/tmp/app-data")
        );
        assert_eq!(options.chat_id.as_deref(), Some("chat-1"));

        let blank_chat = SshExecCliOptions::parse(
            words(&[
                "--fingerprint",
                "SHA256:abc",
                "--app-data-dir",
                "/tmp/a",
                "--",
                "ls",
            ]),
            Some("  ".to_owned()),
        )
        .expect("parse");
        assert!(blank_chat.chat_id.is_none());

        // 지문 없음, 명령 없음, `--` 없이 온 단어, 정수가 아닌 제한 시간은 모두 거절된다.
        assert!(
            SshExecCliOptions::parse(words(&["--app-data-dir", "/tmp/a", "--", "ls"]), None)
                .is_err()
        );
        assert!(SshExecCliOptions::parse(
            words(&[
                "--fingerprint",
                "SHA256:abc",
                "--app-data-dir",
                "/tmp/a",
                "--"
            ]),
            None
        )
        .is_err());
        assert!(SshExecCliOptions::parse(
            words(&[
                "--fingerprint",
                "SHA256:abc",
                "--app-data-dir",
                "/tmp/a",
                "ls"
            ]),
            None
        )
        .is_err());
        assert!(SshExecCliOptions::parse(
            words(&[
                "--fingerprint",
                "SHA256:abc",
                "--timeout",
                "soon",
                "--app-data-dir",
                "/tmp/a",
                "--",
                "ls"
            ]),
            None
        )
        .is_err());
    }

    /// C9-19. 대화형 터미널 사양은 저장된 서버와 개인키만 요구하고 에이전트 사용 토글은
    /// 보지 않는다. BatchMode가 빠져 프롬프트가 사용자에게 도달한다.
    #[test]
    fn c9_19_terminal_launch_ignores_agent_toggle_and_drops_batch_mode() {
        let home = tempfile::tempdir().expect("home");
        let app_data = tempfile::tempdir().expect("app data");
        let ssh = Path::new("/usr/bin/ssh");
        let fingerprint = fixture(home.path(), true);

        assert!(matches!(
            ssh_terminal_launch_with(
                home.path(),
                app_data.path(),
                ssh,
                &sid(app_data.path(), &fingerprint)
            ),
            Err(CoreError::NotFound(_))
        ));
        set_ssh_key_endpoint_for_test(home.path(), app_data.path(), &request(&fingerprint, false))
            .expect("save");
        let launch = ssh_terminal_launch_with(
            home.path(),
            app_data.path(),
            ssh,
            &sid(app_data.path(), &fingerprint),
        )
        .expect("launch");
        assert_eq!(launch.destination, "deploy@build.example.com:2222");
        assert_eq!(launch.executable, ssh);
        assert!(launch.args.contains(&"IdentitiesOnly=yes".to_owned()));
        assert!(!launch.args.iter().any(|arg| arg.contains("BatchMode")));
        assert_eq!(
            launch.args.last().expect("target"),
            "deploy@build.example.com"
        );
        assert!(launch
            .args
            .iter()
            .any(|arg| Path::new(arg).ends_with(".ssh/id_example")));

        // 개인키가 없으면 대화형이라도 붙을 수 없다.
        fs::remove_file(home.path().join(".ssh/id_example")).expect("remove private");
        assert!(matches!(
            ssh_terminal_launch_with(
                home.path(),
                app_data.path(),
                ssh,
                &sid(app_data.path(), &fingerprint)
            ),
            Err(CoreError::Conflict(_))
        ));
    }

    /// C9-20. 공개키 등록도 저장된 서버와 개인키만 요구하고, 원격 셸과 같은 대화형 인자를
    /// 쓴다. 비밀번호 프롬프트가 사용자에게 닿아야 하므로 `BatchMode`가 없고 tty를 강제한다.
    /// 원격 명령은 같은 줄이 이미 있으면 덧붙이지 않아 몇 번을 눌러도 결과가 같다.
    #[test]
    fn c9_20_key_install_launch_carries_an_idempotent_authorized_keys_command() {
        let home = tempfile::tempdir().expect("home");
        let app_data = tempfile::tempdir().expect("app data");
        let ssh = Path::new("/usr/bin/ssh");
        let fingerprint = fixture(home.path(), true);

        // 연결 서버가 없으면 등록할 곳도 없다.
        assert!(matches!(
            ssh_key_install_launch_with(
                home.path(),
                app_data.path(),
                ssh,
                &sid(app_data.path(), &fingerprint)
            ),
            Err(CoreError::NotFound(_))
        ));
        set_ssh_key_endpoint_for_test(home.path(), app_data.path(), &request(&fingerprint, false))
            .expect("save");

        let launch = ssh_key_install_launch_with(
            home.path(),
            app_data.path(),
            ssh,
            &sid(app_data.path(), &fingerprint),
        )
        .expect("launch");
        assert_eq!(launch.destination, "deploy@build.example.com:2222");
        assert!(launch.args.contains(&"IdentitiesOnly=yes".to_owned()));
        // 비밀번호·호스트 키 프롬프트가 사용자에게 닿아야 한다.
        assert!(!launch.args.iter().any(|arg| arg.contains("BatchMode")));
        assert!(launch.args.contains(&"-t".to_owned()));

        let command = launch.args.last().expect("remote command");
        assert!(command.contains("mkdir -p ~/.ssh"));
        assert!(command.contains("chmod 700 ~/.ssh"));
        assert!(command.contains("chmod 600 ~/.ssh/authorized_keys"));
        // 같은 줄이 있으면 덧붙이지 않는다.
        assert!(command.contains("grep -qxF"));
        assert!(command.contains("ssh-ed25519 "));
        // 목적지는 원격 명령 바로 앞에 온다.
        assert_eq!(
            launch.args[launch.args.len() - 2],
            "deploy@build.example.com"
        );

        // 개인키가 없으면 등록도 할 수 없다.
        fs::remove_file(home.path().join(".ssh/id_example")).expect("remove private");
        assert!(matches!(
            ssh_key_install_launch_with(
                home.path(),
                app_data.path(),
                ssh,
                &sid(app_data.path(), &fingerprint)
            ),
            Err(CoreError::Conflict(_))
        ));
    }

    /// C9-20. 공개키는 원격 셸이 해석하는 명령 안에 작은따옴표로 들어간다. 주석은 자유
    /// 입력이라 따옴표를 깨뜨릴 수 있는 글자가 명령에 실려서는 안 된다.
    #[test]
    fn c9_20_key_install_command_never_carries_a_quote_from_the_key_comment() {
        let home = tempfile::tempdir().expect("home");
        let app_data = tempfile::tempdir().expect("app data");
        let ssh = Path::new("/usr/bin/ssh");
        let root = home.path().join(".ssh");
        fs::create_dir(&root).expect("ssh root");
        fs::write(
            root.join("id_example.pub"),
            public_key_line("dev'; rm -rf / #@example"),
        )
        .expect("public");
        fs::write(root.join("id_example"), b"private material").expect("private");
        let fingerprint = crate::ssh_keys::get_ssh_keys_with_home(home.path())
            .expect("inventory")
            .keys[0]
            .fingerprint
            .clone();
        set_ssh_key_endpoint_for_test(home.path(), app_data.path(), &request(&fingerprint, false))
            .expect("save");

        let launch = ssh_key_install_launch_with(
            home.path(),
            app_data.path(),
            ssh,
            &sid(app_data.path(), &fingerprint),
        )
        .expect("launch");
        let command = launch.args.last().expect("remote command");

        // 명령에 실리는 공개키 한 줄에는 따옴표가 없어야 한다. 있으면 우리가 감싼 인용이
        // 끊기고 그 뒤가 원격 셸의 명령이 된다.
        let line = crate::ssh_keys::authorized_key_line(
            home.path(),
            &crate::ssh_keys::SshKeyRef {
                file_name: "id_example.pub".to_owned(),
                fingerprint,
            },
        )
        .expect("authorized key line");
        assert!(!line.contains('\''), "{line}");
        assert!(line.starts_with("ssh-ed25519 "), "{line}");
        // 주석에 섞인 셸 글자는 지워지고, 남은 안전한 글자만 그대로 붙는다.
        assert!(line.ends_with(" dev rm -rf @example"), "{line}");

        // 그 줄이 작은따옴표로 묶인 채 두 번(검사·추가) 들어간다.
        assert_eq!(
            command.matches(&format!("'{line}'")).count(),
            2,
            "{command}"
        );
        assert!(!command.contains("rm -rf /"), "{command}");
    }

    /// C9-9. 키 하나를 여러 서버가 함께 쓴다. 지문만으로는 어느 서버인지 고를 수 없으므로
    /// 실행 경로는 서버 ID를 요구하고, 지문만 온 예전 호출은 서버가 하나일 때만 받는다.
    #[test]
    fn c9_9_one_key_serves_many_servers_and_ids_pick_between_them() {
        let home = tempfile::tempdir().expect("home");
        let app_data = tempfile::tempdir().expect("app data");
        let fingerprint = fixture(home.path(), true);

        let mut first = request(&fingerprint, true);
        first.name = "빌드 서버".to_owned();
        save_ssh_server_with(home.path(), app_data.path(), &first).expect("first");
        assert!(resolve_server(home.path(), app_data.path(), None, &fingerprint).is_ok());

        let mut second = request(&fingerprint, true);
        second.host = "10.0.0.7".to_owned();
        second.port = Some(22);
        let snapshot = save_ssh_server_with(home.path(), app_data.path(), &second).expect("second");
        assert_eq!(snapshot.servers.len(), 2);
        assert_ne!(snapshot.servers[0].id, snapshot.servers[1].id);
        assert!(snapshot
            .servers
            .iter()
            .all(|server| server.fingerprint == fingerprint));

        let error = resolve_server(home.path(), app_data.path(), None, &fingerprint)
            .err()
            .expect("둘 중 하나를 추측하지 않는다");
        assert!(matches!(error, CoreError::Conflict(_)));
        let picked = resolve_server(
            home.path(),
            app_data.path(),
            Some(&snapshot.servers[1].id),
            "",
        )
        .expect("ID로 고른다");
        assert_eq!(picked.server.host, "10.0.0.7");
        assert!(resolve_server(
            home.path(),
            app_data.path(),
            Some(&snapshot.servers[1].id),
            "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        )
        .is_err());

        let listing = list_agent_ssh_endpoints_with(home.path(), app_data.path()).expect("list");
        assert_eq!(listing.endpoints.len(), 2);
        assert_eq!(listing.endpoints[0].name, "빌드 서버");
        assert_eq!(listing.endpoints[1].relay_args[3], snapshot.servers[1].id);

        // 고치기는 ID로 그 서버만 바꾸고, 지우기도 그 서버만 지운다.
        let mut edit = second.clone();
        edit.id = Some(snapshot.servers[1].id.clone());
        edit.user = "ops".to_owned();
        let edited = save_ssh_server_with(home.path(), app_data.path(), &edit).expect("edit");
        assert_eq!(edited.servers.len(), 2);
        assert_eq!(edited.servers[1].user, "ops");
        let deleted = delete_ssh_server_with(
            home.path(),
            app_data.path(),
            &SshServerRef {
                server_id: snapshot.servers[0].id.clone(),
            },
        )
        .expect("delete");
        assert_eq!(deleted.servers.len(), 1);
        assert_eq!(deleted.servers[0].host, "10.0.0.7");
        assert!(home.path().join(".ssh/id_example").is_file());
        // 없는 ID는 고치지도 지우지도 않는다.
        assert!(delete_ssh_server_with(
            home.path(),
            app_data.path(),
            &SshServerRef {
                server_id: snapshot.servers[0].id.clone(),
            },
        )
        .is_err());
        let mut ghost = second.clone();
        ghost.id = Some("srv-000000000000".to_owned());
        assert!(save_ssh_server_with(home.path(), app_data.path(), &ghost).is_err());
        // 주소 없는 서버는 저장하지 않는다(삭제는 별도 작업이다).
        let mut blank = second;
        blank.host = " ".to_owned();
        assert!(save_ssh_server_with(home.path(), app_data.path(), &blank).is_err());
    }

    /// C9-9. 키별 접속 지점 저장본은 처음 읽을 때 지문에서 파생한 ID로 옮겨지고 원본은 남는다.
    #[test]
    fn c9_9_legacy_endpoint_store_migrates_once_with_stable_ids() {
        let home = tempfile::tempdir().expect("home");
        let app_data = tempfile::tempdir().expect("app data");
        let fingerprint = fixture(home.path(), true);
        let legacy = serde_json::json!({
            "schemaVersion": 1,
            "endpoints": {
                fingerprint.clone(): {
                    "host": "legacy.example.com",
                    "port": 2200,
                    "user": "deploy",
                    "agentEnabled": true,
                    "allowedCommands": ["ls"],
                    "updatedAt": 1
                }
            }
        });
        fs::write(
            app_data.path().join(ENDPOINTS_STORE.file),
            serde_json::to_vec(&legacy).expect("json"),
        )
        .expect("legacy store");

        let snapshot =
            crate::ssh_keys::snapshot_with_metadata(home.path(), app_data.path()).expect("load");
        assert_eq!(snapshot.servers.len(), 1);
        let server = &snapshot.servers[0];
        assert_eq!(server.id, migrated_server_id(&fingerprint));
        assert_eq!(server.fingerprint, fingerprint);
        assert_eq!(server.host, "legacy.example.com");
        assert_eq!(server.allowed_commands, ["ls"]);
        assert!(app_data.path().join(SERVERS_STORE.file).is_file());
        assert!(app_data.path().join(ENDPOINTS_STORE.file).is_file());

        // 옮긴 뒤에는 새 저장본이 기준이다. 예전 파일이 남아 있어도 다시 옮기지 않는다.
        delete_ssh_server_with(
            home.path(),
            app_data.path(),
            &SshServerRef {
                server_id: server.id.clone(),
            },
        )
        .expect("delete");
        assert!(load_servers(app_data.path()).expect("reload").is_empty());
    }

    /// C9-21. 암호가 저장된 키의 서버는 에이전트에게 접속 인자를 내주지 않는다. 언제나 앱
    /// 경유 실행이라 암호가 에이전트 셸에 들어가지 않는다.
    #[test]
    fn c9_21_passphrase_servers_are_relay_only_in_the_agent_listing() {
        let home = tempfile::tempdir().expect("home");
        let app_data = tempfile::tempdir().expect("app data");
        let fingerprint = fixture(home.path(), true);
        save_ssh_server_with(home.path(), app_data.path(), &request(&fingerprint, true))
            .expect("save");
        let vault = crate::ssh_askpass::tests::MemoryVault::default();
        crate::ssh_askpass::store_passphrase(&vault, app_data.path(), &fingerprint, "s3cret")
            .expect("store");

        let listing = list_agent_ssh_endpoints_with(home.path(), app_data.path()).expect("list");
        let entry = &listing.endpoints[0];
        assert!(entry.passphrase_protected);
        assert!(entry.ssh_args.is_empty());
        assert!(entry.ssh_command.is_empty());
        assert_eq!(entry.relay_args[2], "--server");
        let serialized = serde_json::to_string(&listing).expect("json");
        assert!(!serialized.contains("s3cret"));
    }

    /// C9-21. 암호 키의 인증 옵션은 질문을 키 암호 하나로 좁히고, 뒤에 붙는 옵션보다 앞에 온다.
    #[test]
    fn c9_21_locked_auth_options_allow_only_one_passphrase_prompt() {
        let open = connect_args("/k", "22", false);
        assert!(open.contains(&"BatchMode=yes".to_owned()));
        let locked = connect_args("/k", "22", true);
        for option in [
            "BatchMode=no",
            "PasswordAuthentication=no",
            "KbdInteractiveAuthentication=no",
            "PreferredAuthentications=publickey",
            "NumberOfPasswordPrompts=1",
        ] {
            assert!(locked.contains(&option.to_owned()), "{option}");
        }
        assert!(!locked.contains(&"BatchMode=yes".to_owned()));
        let line = ssh_command_line("/usr/bin/ssh", "/k", true).expect("line");
        assert!(line.contains("-o BatchMode=no"), "{line}");
        assert!(line.contains("-o PasswordAuthentication=no"), "{line}");
    }

    /// C9-9. 키를 지워도 서버는 남고, 에이전트 목록에는 이유와 함께 빠진다.
    #[test]
    fn c9_9_servers_outlive_their_key_and_explain_why_they_are_skipped() {
        let home = tempfile::tempdir().expect("home");
        let app_data = tempfile::tempdir().expect("app data");
        let fingerprint = fixture(home.path(), true);
        save_ssh_server_with(home.path(), app_data.path(), &request(&fingerprint, true))
            .expect("save");
        assert_eq!(
            servers_using_key(app_data.path(), &fingerprint),
            ["deploy@build.example.com:2222"]
        );
        fs::remove_file(home.path().join(".ssh/id_example.pub")).expect("remove public");
        let listing = list_agent_ssh_endpoints_with(home.path(), app_data.path()).expect("list");
        assert!(listing.endpoints.is_empty());
        assert_eq!(listing.skipped.len(), 1);
        assert!(listing.skipped[0].reason.contains("~/.ssh에 없습니다"));
    }

    /// C9-11. 확인은 저장된 지점으로만 붙고, 실패 문구는 사용자가 읽을 수 있게 남는다.
    #[test]
    fn c9_check_requires_a_saved_endpoint_and_reports_the_reason() {
        let home = tempfile::tempdir().expect("home");
        let app_data = tempfile::tempdir().expect("app data");
        let fingerprint = fixture(home.path(), true);
        let reference = SshServerRef {
            server_id: sid(app_data.path(), &fingerprint),
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

        set_ssh_key_endpoint_for_test(home.path(), app_data.path(), &request(&fingerprint, true))
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

        let snapshot = set_ssh_key_endpoint_for_test(
            home.path(),
            app_data.path(),
            &request(&fingerprint, true),
        )
        .expect("save");
        let endpoint =
            endpoint_for_key(&snapshot, &snapshot.keys[0].fingerprint).expect("endpoint");
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
        set_ssh_key_endpoint_for_test(home.path(), app_data.path(), &open_policy).expect("save");
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
            id: "srv-test".to_owned(),
            name: String::new(),
            fingerprint: "SHA256:test".to_owned(),
            host: "fd7a:1234::5".to_owned(),
            port: 22,
            user: "deploy".to_owned(),
            agent_enabled: true,
            allowed_commands: Vec::new(),
            denied_commands: Vec::new(),
            file_transfer_enabled: false,
            transfer_root: String::new(),
            terminal_enabled: false,
            unrestricted_commands: false,
            updated_at: 0,
            project_git_enabled: false,
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
        assert_eq!(SshCommandPolicyMode::ALL.len(), 3);
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
        assert!(SshCommandPolicyMode::Unrestricted.is_unrestricted());
        assert!(!SshCommandPolicyMode::Unrestricted.is_allowlist());
        assert!(!SshCommandPolicyMode::Unrestricted.is_denylist_only());

        // 알 수 없는 값에 대한 파싱 거절 검증
        let error = "unknown"
            .parse::<SshCommandPolicyMode>()
            .expect_err("unknown");
        assert!(matches!(error, CoreError::InvalidInput(_)));
    }
}
