//! C21: 분산처리 실행기 — 순수 검증 명령(설치·빌드·시험)을 보낼 원격 기계 목록.
//!
//! # IP·키를 따로 두지 않는 이유
//!
//! 실행기는 SSH 탭에 이미 등록된 연결 서버(`ssh-servers-v1.json`, C9-9)를 **서버 ID로
//! 가리키고**, 실행기에만 필요한 값(동시 자리 수·켜짐·메모)만 더한다(2026-10-26 사용자 결정,
//! 설계안 A). 주소·포트·사용자·키를 여기에 한 벌 더 두면 SSH 탭에서 키를 바꾸거나 서버를
//! 옮겼을 때 두 벌이 어긋나고, 에이전트 사용 토글이라는 한 접근 결정이 두 자리로 갈라진다.
//!
//! # 앱이 하는 일과 하지 않는 일
//!
//! 앱은 설정을 저장하고 읽기 전용 CLI(`<CLI> runners list`)로 내보내기만 한다. 실제로 명령을
//! 보내는 것은 앱 밖의 도구(공용 자리 도구)이며, 그 도구는 실행기가 켜져 있고 **그 SSH 서버의
//! 에이전트 사용이 켜져 있을 때만** 목록에서 그 기계를 받는다. 목록에는 개인키 **경로**와
//! `ssh list`와 같은 접속 인자만 실리고 키 내용은 어느 응답에도 없다(G4). 앱이 원격에서 직접
//! 돌리는 것은 접속 확인의 고정 명령(`check_runner` → C9-11) 하나뿐이다.
//!
//! # 쓸 수 있는지의 판정은 한 벌
//!
//! 화면이 보여 주는 "회차가 쓰지 않는 이유"와 CLI의 `skipped`는 같은 함수([`availability`])가
//! 정한다. 두 벌이면 화면은 쓴다고 하는데 도구는 빼는 일이 생긴다.
//!
//! # 보낼 프로젝트 폴더
//!
//! 외부 도구가 어느 폴더의 검증 명령을 실행기로 보내도 되는지는 여기 적은 프로젝트 폴더가
//! 정한다. 저장할 때 이 기계에 실제로 있는 폴더를 심볼릭 링크까지 풀어 검사하고 그 정규
//! 경로를 저장한다. 앱은 그 폴더를 읽거나 쓰지 않는다(G7).

use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::clock::now_ms;
use crate::json_store::{JsonStore, SchemaVersioned};
use crate::ssh_endpoints::{AgentSshEndpointView, AgentSshEndpointsView, SshEndpointView};
use crate::user_home::home_dir;
use crate::CoreError;

const RUNNERS_VERSION: u32 = 1;
/// 실행기 설정도 SSH 연결 서버와 같은 기기 단위 메타데이터라 앱 데이터에만 둔다(G7).
const RUNNERS_STORE: JsonStore = JsonStore {
    file: "runners-v1.json",
    lock_file: "runners-v1.lock",
    label: "분산처리 실행기 저장소",
    version: RUNNERS_VERSION,
};

/// `<CLI> runners list` 응답 모양의 버전. 외부 도구가 이 값으로 계약을 확인한다.
const CLI_LISTING_VERSION: u32 = 1;

const MAX_RUNNERS: usize = 64;
const MAX_PROJECTS: usize = 64;
const MAX_EXCLUDES: usize = 64;
const MAX_NOTE_CHARS: usize = 200;
const MAX_TOKEN_CHARS: usize = 64;
const MAX_ROOT_CHARS: usize = 4096;
const MIN_SLOTS: u32 = 1;
const MAX_SLOTS: u32 = 8;
const DEFAULT_SLOTS: u32 = 2;
const RUNNER_ID_PREFIX: &str = "run-";
const PROJECT_ID_PREFIX: &str = "prj-";
const MAX_ID_CHARS: usize = 40;
/// 서버 이름과 호스트가 모두 이름 규칙에 맞는 글자를 하나도 남기지 않을 때의 이름.
const FALLBACK_RUNNER_NAME: &str = "runner";

/// 저장된 실행기 한 대. 주소·키는 없고 SSH 연결 서버 ID만 가리킨다.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct RunnerRecord {
    id: String,
    server_id: String,
    name: String,
    slots: u32,
    /// C21-5. 이 칸이 생기기 전 저장본은 0(브라우저 시험 없음)으로 읽는다.
    #[serde(default)]
    browsers: u32,
    enabled: bool,
    #[serde(default)]
    note: String,
    #[serde(default)]
    updated_at: i64,
}

/// 실행기로 검증 명령을 보내도 되는 프로젝트 폴더 하나. 저장본과 화면이 같은 모양이다.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RunnerProject {
    pub id: String,
    /// 외부 도구가 프로젝트를 부르는 짧은 이름. 예: `dead-route-game`
    pub name: String,
    /// 이 기계의 정규 절대 경로(심볼릭 링크를 푼 값). 저장할 때 폴더가 실제로 있어야 한다.
    pub root: String,
    /// `root` 바로 아래에서 보내지 않을 폴더 이름. 예: `_land`
    #[serde(default)]
    pub exclude: Vec<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct RunnerStore {
    schema_version: u32,
    #[serde(default)]
    runners: Vec<RunnerRecord>,
    #[serde(default)]
    projects: Vec<RunnerProject>,
}

impl SchemaVersioned for RunnerStore {
    fn schema_version(&self) -> u32 {
        self.schema_version
    }
}

impl Default for RunnerStore {
    fn default() -> Self {
        Self {
            schema_version: RUNNERS_VERSION,
            runners: Vec::new(),
            projects: Vec::new(),
        }
    }
}

/// 실행기를 회차(외부 도구)가 쓰지 않는 이유의 갈래. 화면은 이 값으로 문구를 고르고,
/// 사람이 읽을 한국어 문장은 `skipReason`에 함께 실린다.
#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum RunnerSkipCode {
    /// 실행기가 꺼져 있다.
    Disabled,
    /// 가리키는 SSH 연결 서버가 지워졌다.
    ServerMissing,
    /// 그 SSH 서버의 에이전트 사용이 꺼져 있다.
    AgentOff,
    /// 키 파일(공개키 또는 개인키)을 쓸 수 없다.
    KeyUnavailable,
    /// 키에 암호가 걸려 있어 앱만 열 수 있다(C9-21).
    PassphraseProtected,
    /// SSH 키 목록을 읽지 못했다.
    InventoryUnavailable,
}

/// 화면에 서는 실행기 한 줄. 가리키는 SSH 서버의 접속 정보를 풀어 싣지만 키 내용은 없다.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RunnerView {
    pub id: String,
    pub server_id: String,
    pub name: String,
    pub slots: u32,
    pub browsers: u32,
    pub enabled: bool,
    pub note: String,
    pub updated_at: i64,
    /// 가리키는 SSH 서버가 아직 있는지. 서버를 지워도 실행기는 남고, 여기서 알린다.
    pub server_found: bool,
    pub server_name: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    /// 그 SSH 서버의 에이전트 사용. 꺼져 있으면 외부 도구 목록에서 빠진다.
    pub agent_enabled: bool,
    pub key_fingerprint: String,
    /// CLI 목록과 같은 판정. 둘 다 `None`이면 외부 도구가 이 실행기를 쓴다.
    pub skip_code: Option<RunnerSkipCode>,
    pub skip_reason: Option<String>,
}

/// 실행기 추가 화면이 고르는 SSH 서버 한 줄.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RunnerSshServerOption {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub agent_enabled: bool,
}

/// 화면(사용자) 응답. 고를 수 있는 SSH 서버 전체가 함께 실린다.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RunnersSnapshot {
    pub runners: Vec<RunnerView>,
    pub projects: Vec<RunnerProject>,
    pub ssh_servers: Vec<RunnerSshServerOption>,
    /// 자리 수 범위. 화면과 백엔드가 같은 값을 보게 여기서 내려 준다.
    pub min_slots: u32,
    pub max_slots: u32,
    pub default_slots: u32,
    /// 브라우저 자리 상한(C21-5). 하한은 0이다. 상한을 두지 않으므로 저장 형식의 끝(`u32::MAX`)을
    /// 싣는다 — 브라우저 시험 하나가 기계 메모리를 얼마나 쓰는지는 기계마다 달라 사용자가 정한다
    /// (2026-10-27 사용자 결정). `null`이 아니라 숫자인 것은 상한 4를 알던 화면(e418d60c)이 이
    /// 백엔드에 붙어도 `browsers <= maxBrowsers` 검증을 통과해 저장할 수 있게 하려는 것이다.
    pub max_browsers: u32,
    /// SSH 서버 저장본을 읽지 못한 것처럼 목록 전체를 막지는 않는 문제.
    pub issues: Vec<String>,
}

/// AIA 응답의 실행기 한 줄. C9 경계를 따른다 — 에이전트 사용이 꺼진 서버는 에이전트가 알
/// 이유가 없으므로 접속 정보(서버 이름·호스트·포트·사용자·지문)를 싣지 않는다.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentRunnerView {
    pub id: String,
    pub name: String,
    pub slots: u32,
    pub browsers: u32,
    pub enabled: bool,
    pub server_found: bool,
    pub agent_enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub server_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub server_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key_fingerprint: Option<String>,
    pub skip_code: Option<RunnerSkipCode>,
    pub skip_reason: Option<String>,
}

/// AIA 응답. 고를 수 있는 SSH 서버 목록(`sshServers`)은 화면 전용이라 싣지 않는다.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentRunnersView {
    pub runners: Vec<AgentRunnerView>,
    pub projects: Vec<RunnerProject>,
    pub issues: Vec<String>,
}

/// 실행기 저장 요청. `id`가 없으면 새 실행기다.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveRunnerRequest {
    #[serde(default)]
    pub id: Option<String>,
    pub server_id: String,
    #[serde(default)]
    pub name: String,
    /// 없으면 고치는 실행기는 저장된 값을 그대로 두고, 새 실행기는 기본 자리 수다.
    #[serde(default)]
    pub slots: Option<u32>,
    /// C21-5. 없으면 고치는 실행기는 저장된 값을 그대로 두고, 새 실행기는 0이다 — 이 칸을
    /// 모르는 화면이 저장해도 사용자가 정한 브라우저 자리가 사라지지 않게. `slots`·`enabled`도
    /// 같은 규칙이다: 빠진 칸은 "모른다"이지 "기본값으로 돌려라"가 아니다.
    #[serde(default)]
    pub browsers: Option<u32>,
    /// 없으면 고치는 실행기는 저장된 켜짐을 그대로 두고, 새 실행기는 켜진다.
    #[serde(default)]
    pub enabled: Option<bool>,
    #[serde(default)]
    pub note: String,
}

/// 실행기·프로젝트 하나를 가리키는 요청.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunnerRef {
    pub id: String,
}

/// 실행기 켜짐만 바꾸는 요청. 다른 칸을 함께 보내지 않으므로, 다른 화면이 그 사이 고친
/// 이름·자리 수를 낡은 값으로 덮지 않는다. 가리키는 서버가 지워졌어도 받는다.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetRunnerEnabledRequest {
    pub id: String,
    pub enabled: bool,
}

/// 프로젝트 폴더 한 줄의 입력. 추가는 `id` 없이, 고치기는 `id`와 함께 보낸다.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunnerProjectInput {
    #[serde(default)]
    pub id: Option<String>,
    pub name: String,
    pub root: String,
    #[serde(default)]
    pub exclude: Vec<String>,
}

/// 실행기 접속 확인 결과. C9-11 확인을 그대로 쓰므로 원격에서는 고정 명령 하나만 돈다.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RunnerCheckReceipt {
    pub runner_id: String,
    pub server_id: String,
    pub destination: String,
    pub reachable: bool,
    pub timed_out: bool,
    pub message: String,
}

/// `<CLI> runners list`의 실행기 한 줄. 소비자는 `sshArgs` 뒤에 원격 명령을 붙여 접속한다 —
/// `ssh list`와 같은 `connect_args`(앱의 호스트 키 정책 그대로)이며, 소비자가 호스트 키
/// 검사를 끄거나 `accept-new`로 바꾸지 않는 것이 C21-4의 조건이다. `host`·`port`·`user`·
/// `identityPath`는 표시와 파일 복사(scp 등)에 쓰라고 함께 싣는다.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RunnerCliEntry {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub identity_path: String,
    pub ssh_args: Vec<String>,
    pub slots: u32,
    /// C21-5. 0이면 이 실행기로 브라우저 시험을 보내지 않는다.
    pub browsers: u32,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RunnerCliProject {
    pub name: String,
    pub root: String,
    pub exclude: Vec<String>,
}

/// 목록에 넣지 못한 실행기와 그 이유. 조용히 빼면 외부 도구 쪽에서 왜 안 쓰는지 알 수 없다.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RunnerCliSkip {
    pub id: String,
    pub name: String,
    pub code: RunnerSkipCode,
    pub reason: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RunnerCliListing {
    pub schema_version: u32,
    pub runners: Vec<RunnerCliEntry>,
    pub projects: Vec<RunnerCliProject>,
    pub skipped: Vec<RunnerCliSkip>,
}

/// 실행기 하나를 외부 도구가 쓸 수 있는지. 쓸 수 있으면 `ssh list`의 그 서버 항목이다.
/// 화면의 `skipReason`과 CLI의 `skipped`가 모두 이 판정 하나를 쓴다.
fn availability<'a>(
    record: &RunnerRecord,
    servers: &[SshEndpointView],
    agent: Option<&'a AgentSshEndpointsView>,
) -> Result<&'a AgentSshEndpointView, (RunnerSkipCode, String)> {
    let skip = |code: RunnerSkipCode, reason: &str| Err((code, reason.to_owned()));
    if !record.enabled {
        return skip(RunnerSkipCode::Disabled, "실행기가 꺼져 있습니다");
    }
    let Some(server) = servers.iter().find(|server| server.id == record.server_id) else {
        return skip(
            RunnerSkipCode::ServerMissing,
            "가리키는 SSH 연결 서버가 지워졌습니다",
        );
    };
    if !server.agent_enabled {
        return skip(
            RunnerSkipCode::AgentOff,
            "SSH 서버의 에이전트 사용이 꺼져 있습니다",
        );
    }
    let Some(agent) = agent else {
        return skip(
            RunnerSkipCode::InventoryUnavailable,
            "SSH 키 목록을 읽지 못했습니다",
        );
    };
    if let Some(endpoint) = agent
        .endpoints
        .iter()
        .find(|endpoint| endpoint.server_id == record.server_id)
    {
        // C9-21. 암호가 걸린 키는 앱만 열 수 있다. 외부 도구에 경로를 넘겨도 `BatchMode`
        // 접속은 실패하고, 암호를 외부 도구에 넘기는 길은 만들지 않는다.
        if endpoint.passphrase_protected {
            return skip(
                RunnerSkipCode::PassphraseProtected,
                "키에 암호가 걸려 있어 외부 도구가 직접 열 수 없습니다",
            );
        }
        return Ok(endpoint);
    }
    let reason = agent
        .skipped
        .iter()
        .find(|entry| entry.server_id == record.server_id)
        .map_or("이 서버의 키를 쓸 수 없습니다", |entry| {
            entry.reason.as_str()
        });
    skip(RunnerSkipCode::KeyUnavailable, reason)
}

/// 화면·AIA 목록이 함께 읽는 재료. 어느 한쪽을 읽지 못해도 목록은 보여 주고 issues로 알린다.
struct Sources {
    store: RunnerStore,
    servers: Vec<SshEndpointView>,
    agent: Option<AgentSshEndpointsView>,
    issues: Vec<String>,
}

fn load_sources(home: Option<&Path>, app_data_dir: &Path) -> Result<Sources, CoreError> {
    let store: RunnerStore = RUNNERS_STORE.read(app_data_dir)?;
    let mut issues = Vec::new();
    let servers = crate::ssh_endpoints::load_servers(app_data_dir).unwrap_or_else(|error| {
        issues.push(format!(
            "SSH 연결 서버 설정을 읽지 못해 접속 정보 없이 표시합니다: {error}"
        ));
        Vec::new()
    });
    let agent = match home {
        Some(home) => {
            match crate::ssh_endpoints::list_agent_ssh_endpoints_with(home, app_data_dir) {
                Ok(agent) => Some(agent),
                Err(error) => {
                    issues.push(format!("SSH 키 목록을 읽지 못했습니다: {error}"));
                    None
                }
            }
        }
        None => {
            issues.push("사용자 홈을 확인할 수 없어 SSH 키 목록을 읽지 못했습니다".to_owned());
            None
        }
    };
    Ok(Sources {
        store,
        servers,
        agent,
        issues,
    })
}

/// C21. 화면용 목록: 실행기·프로젝트 폴더·고를 수 있는 SSH 서버.
pub fn list_runners_with(
    home: Option<&Path>,
    app_data_dir: &Path,
) -> Result<RunnersSnapshot, CoreError> {
    let Sources {
        store,
        servers,
        agent,
        issues,
    } = load_sources(home, app_data_dir)?;
    let runners = store
        .runners
        .iter()
        .map(|record| {
            let server = servers.iter().find(|server| server.id == record.server_id);
            let skip = availability(record, &servers, agent.as_ref()).err();
            RunnerView {
                id: record.id.clone(),
                server_id: record.server_id.clone(),
                name: record.name.clone(),
                slots: record.slots,
                browsers: record.browsers,
                enabled: record.enabled,
                note: record.note.clone(),
                updated_at: record.updated_at,
                server_found: server.is_some(),
                server_name: server.map(|server| server.name.clone()).unwrap_or_default(),
                host: server.map(|server| server.host.clone()).unwrap_or_default(),
                port: server.map(|server| server.port).unwrap_or_default(),
                user: server.map(|server| server.user.clone()).unwrap_or_default(),
                agent_enabled: server.is_some_and(|server| server.agent_enabled),
                key_fingerprint: server
                    .map(|server| server.fingerprint.clone())
                    .unwrap_or_default(),
                skip_code: skip.as_ref().map(|(code, _)| *code),
                skip_reason: skip.map(|(_, reason)| reason),
            }
        })
        .collect();
    let ssh_servers = servers
        .iter()
        .map(|server| RunnerSshServerOption {
            id: server.id.clone(),
            name: server.name.clone(),
            host: server.host.clone(),
            port: server.port,
            user: server.user.clone(),
            agent_enabled: server.agent_enabled,
        })
        .collect();
    Ok(RunnersSnapshot {
        runners,
        projects: store.projects,
        ssh_servers,
        min_slots: MIN_SLOTS,
        max_slots: MAX_SLOTS,
        default_slots: DEFAULT_SLOTS,
        max_browsers: u32::MAX,
        issues,
    })
}

/// C21-3. AIA용 목록. 에이전트 사용이 꺼진 서버를 가리키는 실행기는 이름·자리·켜짐과 "꺼짐"
/// 표시만 싣고, 고를 수 있는 서버 목록은 싣지 않는다(C9 경계).
pub fn list_runners_for_agent_with(
    home: Option<&Path>,
    app_data_dir: &Path,
) -> Result<AgentRunnersView, CoreError> {
    let Sources {
        store,
        servers,
        agent,
        issues,
    } = load_sources(home, app_data_dir)?;
    let runners = store
        .runners
        .iter()
        .map(|record| {
            let server = servers.iter().find(|server| server.id == record.server_id);
            let open = server.filter(|server| server.agent_enabled);
            let skip = availability(record, &servers, agent.as_ref()).err();
            AgentRunnerView {
                id: record.id.clone(),
                name: record.name.clone(),
                slots: record.slots,
                browsers: record.browsers,
                enabled: record.enabled,
                server_found: server.is_some(),
                agent_enabled: open.is_some(),
                server_id: open.map(|server| server.id.clone()),
                server_name: open.map(|server| server.name.clone()),
                host: open.map(|server| server.host.clone()),
                port: open.map(|server| server.port),
                user: open.map(|server| server.user.clone()),
                key_fingerprint: open.map(|server| server.fingerprint.clone()),
                skip_code: skip.as_ref().map(|(code, _)| *code),
                skip_reason: skip.map(|(_, reason)| reason),
            }
        })
        .collect();
    Ok(AgentRunnersView {
        runners,
        projects: store.projects,
        issues,
    })
}

/// C21. 실행기 하나를 만들거나 고친다. 가리키는 SSH 서버가 있어야 하고, 한 서버는 한 번만
/// 실행기가 된다.
pub fn save_runner(app_data_dir: &Path, request: SaveRunnerRequest) -> Result<(), CoreError> {
    let servers = crate::ssh_endpoints::load_servers(app_data_dir)?;
    let server_id = crate::ssh_endpoints::validate_server_id(&request.server_id)?.to_owned();
    let server = servers
        .iter()
        .find(|server| server.id == server_id)
        .ok_or_else(|| {
            CoreError::NotFound(format!(
                "SSH 연결 서버 {server_id}를 찾지 못했습니다. 서버를 다시 고르거나 먼저 SSH 탭에서 서버를 등록하세요"
            ))
        })?;
    let existing_id = request
        .id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| validate_id(value, RUNNER_ID_PREFIX, "실행기"))
        .transpose()?
        .map(str::to_owned);
    let name = match request.name.trim() {
        "" => default_runner_name(server),
        name => validate_runner_name(name)?.to_owned(),
    };
    let mut record = RunnerRecord {
        id: existing_id
            .clone()
            .unwrap_or_else(|| new_id(RUNNER_ID_PREFIX)),
        server_id,
        name,
        slots: validate_slots(request.slots)?,
        browsers: request.browsers.unwrap_or(0),
        enabled: request.enabled.unwrap_or(true),
        note: validate_note(&request.note)?.to_owned(),
        updated_at: now_ms(),
    };
    RUNNERS_STORE.update(app_data_dir, |store: &mut RunnerStore| {
        if let Some(other) = store
            .runners
            .iter()
            .find(|saved| saved.id != record.id && saved.server_id == record.server_id)
        {
            return Err(CoreError::Conflict(format!(
                "이 SSH 서버는 이미 실행기 {}로 등록되어 있습니다",
                other.name
            )));
        }
        if let Some(other) = store
            .runners
            .iter()
            .find(|saved| saved.id != record.id && saved.name == record.name)
        {
            return Err(CoreError::Conflict(format!(
                "같은 이름의 실행기({})가 이미 있습니다. 다른 이름을 붙이세요",
                other.name
            )));
        }
        match &existing_id {
            Some(id) => {
                let slot = store
                    .runners
                    .iter_mut()
                    .find(|saved| &saved.id == id)
                    .ok_or_else(|| CoreError::NotFound(runner_not_found(id)))?;
                // 요청에 없는 칸은 저장값을 지킨다. 새 실행기의 기본값(자리 2·켜짐)으로
                // 덮으면 칸을 모르는 클라이언트의 고치기가 꺼 둔 실행기를 켜 버린다.
                if request.slots.is_none() {
                    record.slots = slot.slots;
                }
                if request.browsers.is_none() {
                    record.browsers = slot.browsers;
                }
                if request.enabled.is_none() {
                    record.enabled = slot.enabled;
                }
                *slot = record.clone();
            }
            None => {
                if store.runners.len() >= MAX_RUNNERS {
                    return Err(CoreError::InvalidInput(format!(
                        "실행기는 {MAX_RUNNERS}대까지 등록할 수 있습니다"
                    )));
                }
                while store.runners.iter().any(|saved| saved.id == record.id) {
                    record.id = new_id(RUNNER_ID_PREFIX);
                }
                store.runners.push(record.clone());
            }
        }
        Ok(true)
    })?;
    Ok(())
}

/// C21. 실행기 켜짐만 바꾼다. 서버 존재는 보지 않는다 — 서버가 지워진 실행기도 끌 수 있어야 한다.
pub fn set_runner_enabled(
    app_data_dir: &Path,
    request: SetRunnerEnabledRequest,
) -> Result<(), CoreError> {
    let id = validate_id(&request.id, RUNNER_ID_PREFIX, "실행기")?.to_owned();
    RUNNERS_STORE.update(app_data_dir, |store: &mut RunnerStore| {
        let record = store
            .runners
            .iter_mut()
            .find(|saved| saved.id == id)
            .ok_or_else(|| CoreError::NotFound(runner_not_found(&id)))?;
        if record.enabled == request.enabled {
            return Ok(false);
        }
        record.enabled = request.enabled;
        record.updated_at = now_ms();
        Ok(true)
    })?;
    Ok(())
}

/// C21. 실행기 하나를 지운다. 가리키던 SSH 서버와 키는 그대로다.
pub fn delete_runner(app_data_dir: &Path, request: RunnerRef) -> Result<(), CoreError> {
    let id = validate_id(&request.id, RUNNER_ID_PREFIX, "실행기")?.to_owned();
    RUNNERS_STORE.update(app_data_dir, |store: &mut RunnerStore| {
        let before = store.runners.len();
        store.runners.retain(|saved| saved.id != id);
        if store.runners.len() == before {
            return Err(CoreError::NotFound(runner_not_found(&id)));
        }
        Ok(true)
    })?;
    Ok(())
}

/// C21. 프로젝트 폴더 한 줄을 더한다. 목록을 통째로 바꾸지 않으므로, 다른 화면이 그 사이
/// 더한 줄을 지우지 않는다.
pub fn add_runner_project(app_data_dir: &Path, input: RunnerProjectInput) -> Result<(), CoreError> {
    let mut project = validate_project(app_data_dir, &input)?;
    project.id = new_id(PROJECT_ID_PREFIX);
    RUNNERS_STORE.update(app_data_dir, |store: &mut RunnerStore| {
        if store.projects.len() >= MAX_PROJECTS {
            return Err(CoreError::InvalidInput(format!(
                "프로젝트 폴더는 {MAX_PROJECTS}개까지 등록할 수 있습니다"
            )));
        }
        ensure_project_unique(&store.projects, &project)?;
        while store.projects.iter().any(|saved| saved.id == project.id) {
            project.id = new_id(PROJECT_ID_PREFIX);
        }
        store.projects.push(project.clone());
        Ok(true)
    })?;
    Ok(())
}

/// C21. 프로젝트 폴더 한 줄을 고친다. 다른 줄은 건드리지 않는다.
pub fn update_runner_project(
    app_data_dir: &Path,
    input: RunnerProjectInput,
) -> Result<(), CoreError> {
    let id = input
        .id
        .as_deref()
        .map(|value| validate_id(value, PROJECT_ID_PREFIX, "프로젝트"))
        .transpose()?
        .ok_or_else(|| CoreError::InvalidInput("고칠 프로젝트 id가 필요합니다".to_owned()))?
        .to_owned();
    let mut project = validate_project(app_data_dir, &input)?;
    project.id = id.clone();
    RUNNERS_STORE.update(app_data_dir, |store: &mut RunnerStore| {
        ensure_project_unique(&store.projects, &project)?;
        let slot = store
            .projects
            .iter_mut()
            .find(|saved| saved.id == id)
            .ok_or_else(|| CoreError::NotFound(project_not_found(&id)))?;
        *slot = project.clone();
        Ok(true)
    })?;
    Ok(())
}

/// C21. 프로젝트 폴더 한 줄을 목록에서 뺀다. 폴더 자체는 그대로다.
pub fn delete_runner_project(app_data_dir: &Path, request: RunnerRef) -> Result<(), CoreError> {
    let id = validate_id(&request.id, PROJECT_ID_PREFIX, "프로젝트")?.to_owned();
    RUNNERS_STORE.update(app_data_dir, |store: &mut RunnerStore| {
        let before = store.projects.len();
        store.projects.retain(|saved| saved.id != id);
        if store.projects.len() == before {
            return Err(CoreError::NotFound(project_not_found(&id)));
        }
        Ok(true)
    })?;
    Ok(())
}

/// C21-3. 실행기가 가리키는 SSH 서버로 C9-11 접속 확인을 한 번 한다. 원격에서는 앱이 정한
/// 고정 명령 하나만 돈다. `for_agent`면 C9 경계대로 그 서버의 에이전트 사용이 켜져 있어야 한다.
pub fn check_runner(
    app_data_dir: &Path,
    request: RunnerRef,
    for_agent: bool,
) -> Result<RunnerCheckReceipt, CoreError> {
    let record = find_runner(app_data_dir, &request.id)?;
    if for_agent {
        ensure_agent_may_check(app_data_dir, &record)?;
    }
    let receipt = crate::check_ssh_endpoint(
        app_data_dir,
        crate::SshServerRef {
            server_id: record.server_id.clone(),
        },
    )?;
    Ok(RunnerCheckReceipt {
        runner_id: record.id,
        server_id: receipt.server_id,
        destination: receipt.destination,
        reachable: receipt.reachable,
        timed_out: receipt.timed_out,
        message: receipt.message,
    })
}

/// AIA는 에이전트 사용을 켠 서버에만 닿는다(C9-12). 꺼진 서버를 가리키는 실행기의 확인은
/// 접속 시도 전에 거절한다.
fn ensure_agent_may_check(app_data_dir: &Path, record: &RunnerRecord) -> Result<(), CoreError> {
    let servers = crate::ssh_endpoints::load_servers(app_data_dir)?;
    match servers.iter().find(|server| server.id == record.server_id) {
        Some(server) if server.agent_enabled => Ok(()),
        Some(_) => Err(CoreError::Conflict(format!(
            "실행기 {}의 SSH 서버는 에이전트 사용이 꺼져 있어 AIA가 접속을 확인할 수 없습니다. 사용자에게 애드온 → SSH에서 켜 달라고 요청하세요",
            record.name
        ))),
        None => Err(CoreError::NotFound(format!(
            "실행기 {}가 가리키던 SSH 연결 서버가 지워졌습니다",
            record.name
        ))),
    }
}

fn find_runner(app_data_dir: &Path, id: &str) -> Result<RunnerRecord, CoreError> {
    let id = validate_id(id, RUNNER_ID_PREFIX, "실행기")?;
    let store: RunnerStore = RUNNERS_STORE.read(app_data_dir)?;
    store
        .runners
        .into_iter()
        .find(|saved| saved.id == id)
        .ok_or_else(|| CoreError::NotFound(runner_not_found(id)))
}

/// C21-4. 외부 도구용 목록. [`availability`]가 쓸 수 있다고 한 실행기만 싣고, 나머지는 이유와
/// 함께 `skipped`로 간다.
pub fn runner_cli_listing(app_data_dir: &Path) -> Result<RunnerCliListing, CoreError> {
    runner_cli_listing_with(&home_dir()?, app_data_dir)
}

fn runner_cli_listing_with(
    home: &Path,
    app_data_dir: &Path,
) -> Result<RunnerCliListing, CoreError> {
    let store: RunnerStore = RUNNERS_STORE.read(app_data_dir)?;
    // `ssh list`와 같은 판정을 그대로 쓴다 — 개인키 경로와 접속 인자를 푸는 규칙이 두 벌이면
    // 한쪽만 고쳐졌을 때 스킬과 외부 도구가 같은 서버를 두고 다른 답을 낸다. CLI는 목록을
    // 일부만 내보내느니 실패를 알리는 편이 낫다.
    let agent = crate::ssh_endpoints::list_agent_ssh_endpoints_with(home, app_data_dir)?;
    let servers = crate::ssh_endpoints::load_servers(app_data_dir)?;
    let mut runners = Vec::new();
    let mut skipped = Vec::new();
    for record in &store.runners {
        match availability(record, &servers, Some(&agent)) {
            Ok(endpoint) => runners.push(RunnerCliEntry {
                id: record.id.clone(),
                name: record.name.clone(),
                host: endpoint.host.clone(),
                port: endpoint.port,
                user: endpoint.user.clone(),
                identity_path: endpoint.identity_path.clone(),
                ssh_args: endpoint.ssh_args.clone(),
                slots: record.slots,
                browsers: record.browsers,
            }),
            Err((code, reason)) => skipped.push(RunnerCliSkip {
                id: record.id.clone(),
                name: record.name.clone(),
                code,
                reason,
            }),
        }
    }
    Ok(RunnerCliListing {
        schema_version: CLI_LISTING_VERSION,
        runners,
        projects: store
            .projects
            .into_iter()
            .map(|project| RunnerCliProject {
                name: project.name,
                root: project.root,
                exclude: project.exclude,
            })
            .collect(),
        skipped,
    })
}

/// 외부 도구가 부르는 진입점. `<CLI> runners list [--app-data-dir DIR]`는 읽기만 하고 백엔드
/// 소유권 lease를 잡지 않는다.
pub fn run_runners_cli(args: impl Iterator<Item = String>) -> Result<(), CoreError> {
    let app_data_dir = parse_runners_cli(args)?;
    let app_data_dir = crate::remote::cli_app_data_dir(app_data_dir)?;
    let listing = runner_cli_listing(&app_data_dir)?;
    println!("{}", serde_json::to_string_pretty(&listing)?);
    Ok(())
}

/// `runners` 뒤의 인자를 읽어 `--app-data-dir` 값을 돌려준다. 작업은 지금 `list` 하나다.
fn parse_runners_cli(mut args: impl Iterator<Item = String>) -> Result<Option<PathBuf>, CoreError> {
    let operation = args.next().ok_or_else(|| {
        CoreError::InvalidInput("runners 다음에 작업이 필요합니다: list".to_owned())
    })?;
    if operation != "list" {
        return Err(CoreError::InvalidInput(format!(
            "알 수 없는 작업입니다: {operation}. list를 쓰세요"
        )));
    }
    let mut app_data_dir = None;
    while let Some(flag) = args.next() {
        match flag.as_str() {
            "--app-data-dir" => {
                let value = args.next().ok_or_else(|| {
                    CoreError::InvalidInput("--app-data-dir 값이 필요합니다".to_owned())
                })?;
                app_data_dir = Some(PathBuf::from(value));
            }
            other => {
                return Err(CoreError::InvalidInput(format!(
                    "알 수 없는 인자입니다: {other}"
                )))
            }
        }
    }
    Ok(app_data_dir)
}

/// 이름을 비워 두면 SSH 서버 이름, 그것이 이름 규칙에 맞는 글자를 남기지 않으면 호스트가
/// 이름이 된다. 규칙 밖의 글자는 `-`로 바꾼다(호스트의 `.`은 그대로 남는다).
fn default_runner_name(server: &SshEndpointView) -> String {
    [server.name.as_str(), server.host.as_str()]
        .into_iter()
        .map(sanitize_runner_name)
        .find(|name| !name.is_empty())
        .unwrap_or_else(|| FALLBACK_RUNNER_NAME.to_owned())
}

fn is_name_char(character: char) -> bool {
    character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-')
}

fn sanitize_runner_name(value: &str) -> String {
    let mut name = String::new();
    for character in value.trim().chars() {
        if is_name_char(character) {
            name.push(character);
        } else if !name.is_empty() && !name.ends_with('-') {
            name.push('-');
        }
    }
    let name: String = name
        .trim_end_matches('-')
        .chars()
        .take(MAX_TOKEN_CHARS)
        .collect();
    if name == "." || name == ".." {
        String::new()
    } else {
        name
    }
}

fn runner_not_found(id: &str) -> String {
    format!("실행기 {id}를 찾지 못했습니다. 목록을 새로 고친 뒤 다시 고르세요")
}

fn project_not_found(id: &str) -> String {
    format!("프로젝트 폴더 {id}를 찾지 못했습니다. 목록을 새로 고친 뒤 다시 고르세요")
}

fn new_id(prefix: &str) -> String {
    format!(
        "{prefix}{}",
        &uuid::Uuid::new_v4().simple().to_string()[..12]
    )
}

fn validate_id<'a>(value: &'a str, prefix: &str, label: &str) -> Result<&'a str, CoreError> {
    let value = value.trim();
    let valid = value.starts_with(prefix)
        && value.len() > prefix.len()
        && value.len() <= MAX_ID_CHARS
        && value.chars().all(|character| {
            character.is_ascii_lowercase() || character.is_ascii_digit() || character == '-'
        });
    if !valid {
        return Err(CoreError::InvalidInput(format!(
            "{label} ID 형식이 아닙니다: {value}"
        )));
    }
    Ok(value)
}

/// 실행기 이름은 외부 도구가 식별자로 쓰므로 짧은 토큰만 받는다.
fn validate_runner_name(value: &str) -> Result<&str, CoreError> {
    if !is_token(value, true) {
        return Err(CoreError::InvalidInput(format!(
            "실행기 이름은 영문·숫자·.·_·-로 {MAX_TOKEN_CHARS}자 이하여야 합니다: {value}"
        )));
    }
    Ok(value)
}

fn validate_note(value: &str) -> Result<&str, CoreError> {
    let value = value.trim();
    if value.chars().count() > MAX_NOTE_CHARS
        || value.chars().any(|character| character.is_control())
    {
        return Err(CoreError::InvalidInput(format!(
            "메모는 제어문자 없이 {MAX_NOTE_CHARS}자 이하여야 합니다"
        )));
    }
    Ok(value)
}

fn validate_slots(value: Option<u32>) -> Result<u32, CoreError> {
    let slots = value.unwrap_or(DEFAULT_SLOTS);
    if !(MIN_SLOTS..=MAX_SLOTS).contains(&slots) {
        return Err(CoreError::InvalidInput(format!(
            "동시 자리 수는 {MIN_SLOTS}에서 {MAX_SLOTS} 사이여야 합니다"
        )));
    }
    Ok(slots)
}

/// 이름·제외 폴더에 쓰는 짧은 토큰. 경로 조각이 될 수 있으므로 `.`·`..`는 받지 않는다.
fn is_token(value: &str, allow_upper: bool) -> bool {
    !value.is_empty()
        && value.len() <= MAX_TOKEN_CHARS
        && value != "."
        && value != ".."
        && value.chars().all(|character| {
            character.is_ascii_lowercase()
                || (allow_upper && character.is_ascii_uppercase())
                || character.is_ascii_digit()
                || matches!(character, '.' | '_' | '-')
        })
}

/// 같은 이름이나 같은 폴더가 다른 줄에 이미 있으면 거절한다.
fn ensure_project_unique(
    projects: &[RunnerProject],
    project: &RunnerProject,
) -> Result<(), CoreError> {
    let others = || projects.iter().filter(|saved| saved.id != project.id);
    if others().any(|saved| saved.name == project.name) {
        return Err(CoreError::Conflict(format!(
            "프로젝트 이름 {}이 이미 있습니다",
            project.name
        )));
    }
    if others().any(|saved| saved.root == project.root) {
        return Err(CoreError::Conflict(format!(
            "같은 폴더({})가 이미 다른 프로젝트로 등록되어 있습니다",
            project.root
        )));
    }
    Ok(())
}

/// 한 줄을 검증해 저장할 모양으로 만든다. `id`는 부르는 쪽이 채운다.
fn validate_project(
    app_data_dir: &Path,
    input: &RunnerProjectInput,
) -> Result<RunnerProject, CoreError> {
    let name = input.name.trim();
    if !is_token(name, false) {
        return Err(CoreError::InvalidInput(format!(
            "프로젝트 이름은 영문 소문자·숫자·.·_·-로 {MAX_TOKEN_CHARS}자 이하여야 합니다: {name}"
        )));
    }
    let root = validate_project_root(app_data_dir, &input.root)?;
    let mut exclude: Vec<String> = Vec::new();
    for value in &input.exclude {
        let value = value.trim();
        if value.is_empty() {
            continue;
        }
        if !is_token(value, true) {
            return Err(CoreError::InvalidInput(format!(
                "제외 폴더는 root 바로 아래 폴더 이름(영문·숫자·.·_·-, {MAX_TOKEN_CHARS}자 이하)이어야 합니다: {value}"
            )));
        }
        if !exclude.iter().any(|saved| saved == value) {
            exclude.push(value.to_owned());
        }
    }
    if exclude.len() > MAX_EXCLUDES {
        return Err(CoreError::InvalidInput(format!(
            "제외 폴더는 프로젝트마다 {MAX_EXCLUDES}개까지입니다"
        )));
    }
    Ok(RunnerProject {
        id: String::new(),
        name: name.to_owned(),
        root,
        exclude,
    })
}

/// C21-2 / G10. 프로젝트 폴더는 절대 경로, `..` 없음, 이 기계에 있는 폴더여야 한다. 검사는
/// 심볼릭 링크를 **푼** 정규 경로로 한다 — 소비자(공용 자리 도구)도 작업 폴더를 realpath로
/// 풀어 견주므로, 저장도 그 정규 경로로 해 두 쪽이 같은 값을 본다. 링크로 금지 경로를
/// 가리키는 길도 여기서 막힌다.
///
/// 금지 경계는 C9-16 업로드 원본과 같은 기준이다: 공급자 홈·옮긴 공급자 홈·앱 데이터
/// (AIA 작업공간 하위만 예외)와 그것들을 품는 상위(홈 자체, `/`), 그리고 `~/.ssh` 같은
/// 자격증명 경로 조각. 이 폴더의 하위 트리가 통째로 다른 기계에 복사되기 때문이다.
fn validate_project_root(app_data_dir: &Path, value: &str) -> Result<String, CoreError> {
    let value = value.trim();
    if value.is_empty() {
        return Err(CoreError::InvalidInput(
            "프로젝트 폴더 경로가 필요합니다".to_owned(),
        ));
    }
    if value.chars().count() > MAX_ROOT_CHARS
        || value.chars().any(|character| character.is_control())
    {
        return Err(CoreError::InvalidInput(
            "프로젝트 폴더 경로가 너무 길거나 제어문자를 담고 있습니다".to_owned(),
        ));
    }
    let path = Path::new(value);
    if !path.is_absolute() {
        return Err(CoreError::InvalidInput(format!(
            "프로젝트 폴더는 절대 경로여야 합니다: {value}"
        )));
    }
    if path
        .components()
        .any(|component| matches!(component, Component::ParentDir))
    {
        return Err(CoreError::InvalidInput(format!(
            "프로젝트 폴더 경로에 ..를 쓸 수 없습니다: {value}"
        )));
    }
    let canonical = std::fs::canonicalize(path)
        .map_err(|_| CoreError::NotFound(format!("이 기계에 그 폴더가 없습니다: {value}")))?;
    if !canonical.is_dir() {
        return Err(CoreError::InvalidInput(format!(
            "폴더가 아니라 파일입니다: {value}"
        )));
    }
    if canonical.parent().is_none() {
        return Err(CoreError::InvalidInput(
            "파일 시스템 루트는 프로젝트 폴더로 쓸 수 없습니다".to_owned(),
        ));
    }
    if crate::store::is_restricted_outside_aia_workspace(app_data_dir, &canonical) {
        return Err(CoreError::InvalidInput(format!(
            "공급자 홈·Agent Manager 데이터 폴더와 그것을 품는 폴더(홈 자체 등)는 프로젝트 폴더로 쓸 수 없습니다: {}",
            canonical.display()
        )));
    }
    if let Some(segment) = canonical.components().find_map(|component| {
        let value = component.as_os_str().to_string_lossy().to_ascii_lowercase();
        crate::ssh_exec::REFUSED_LOCAL_SEGMENTS
            .contains(&value.as_str())
            .then_some(value)
    }) {
        return Err(CoreError::InvalidInput(format!(
            "{segment}은(는) 자격증명이 놓이는 자리라 프로젝트 폴더로 쓸 수 없습니다"
        )));
    }
    Ok(canonical.to_string_lossy().into_owned())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::fs;

    use base64::engine::general_purpose::STANDARD;
    use base64::Engine as _;

    use crate::ssh_endpoints::{save_ssh_server_for_test, SaveSshServerRequest};

    /// `~/.ssh`에 공개키 하나(본문 `body`)와 같은 이름의 개인키 자리를 만들고 지문을 돌려준다.
    pub(crate) fn key_fixture(home: &Path, file: &str, body: u8) -> String {
        let root = home.join(".ssh");
        fs::create_dir_all(&root).expect("ssh root");
        let key_type = "ssh-ed25519";
        let mut blob = Vec::new();
        blob.extend_from_slice(&(key_type.len() as u32).to_be_bytes());
        blob.extend_from_slice(key_type.as_bytes());
        blob.extend_from_slice(&32u32.to_be_bytes());
        blob.extend_from_slice(&[body; 32]);
        fs::write(
            root.join(format!("{file}.pub")),
            format!("{key_type} {} runner@example\n", STANDARD.encode(blob)),
        )
        .expect("public");
        fs::write(root.join(file), b"private material").expect("private");
        crate::ssh_keys::get_ssh_keys_with_home(home)
            .expect("inventory")
            .keys
            .into_iter()
            .find(|key| key.file_name == format!("{file}.pub"))
            .expect("key")
            .fingerprint
    }

    pub(crate) fn server(
        home: &Path,
        app_data: &Path,
        fingerprint: &str,
        name: &str,
        host: &str,
        agent_enabled: bool,
    ) -> String {
        let before: Vec<String> = crate::ssh_endpoints::load_servers(app_data)
            .expect("servers")
            .into_iter()
            .map(|server| server.id)
            .collect();
        save_ssh_server_for_test(
            home,
            app_data,
            &SaveSshServerRequest {
                name: name.to_owned(),
                fingerprint: fingerprint.to_owned(),
                host: host.to_owned(),
                port: Some(22),
                user: "builder".to_owned(),
                agent_enabled,
                ..SaveSshServerRequest::default()
            },
        )
        .expect("save server");
        crate::ssh_endpoints::load_servers(app_data)
            .expect("servers")
            .into_iter()
            .map(|server| server.id)
            .find(|id| !before.contains(id))
            .expect("new server id")
    }

    pub(crate) fn runner(server_id: &str) -> SaveRunnerRequest {
        SaveRunnerRequest {
            server_id: server_id.to_owned(),
            ..SaveRunnerRequest::default()
        }
    }

    fn project(name: &str, root: &Path, exclude: &[&str]) -> RunnerProjectInput {
        RunnerProjectInput {
            id: None,
            name: name.to_owned(),
            root: root.to_string_lossy().into_owned(),
            exclude: exclude.iter().map(|value| (*value).to_owned()).collect(),
        }
    }

    fn list(home: &Path, app_data: &Path) -> RunnersSnapshot {
        list_runners_with(Some(home), app_data).expect("list")
    }

    fn by_name<'a>(snapshot: &'a RunnersSnapshot, name: &str) -> &'a RunnerView {
        snapshot
            .runners
            .iter()
            .find(|entry| entry.name == name)
            .unwrap_or_else(|| panic!("{name} 실행기가 없습니다"))
    }

    /// C21. 실행기는 등록된 SSH 서버만 가리키고, 한 서버는 한 번만 실행기가 되며, 자리 수는
    /// 1~8이다. 이름을 비우면 SSH 서버 이름(규칙에 맞게 다듬은 것, 없으면 호스트)이 된다.
    #[test]
    fn c21_runner_must_point_at_one_registered_server_with_bounded_slots() {
        let home = tempfile::tempdir().expect("home");
        let app_data = tempfile::tempdir().expect("app data");
        let fingerprint = key_fixture(home.path(), "id_runner", 7);
        let named = server(
            home.path(),
            app_data.path(),
            &fingerprint,
            "PC 실행기 #1",
            "10.0.0.5",
            true,
        );
        let unnamed = server(
            home.path(),
            app_data.path(),
            &fingerprint,
            "데스크탑",
            "10.0.0.6",
            true,
        );

        let unknown = save_runner(app_data.path(), runner("srv-000000000000"));
        assert!(
            matches!(unknown, Err(CoreError::NotFound(_))),
            "{unknown:?}"
        );
        assert!(save_runner(app_data.path(), runner("not-a-server-id")).is_err());

        for slots in [0, 9, 100] {
            let request = SaveRunnerRequest {
                slots: Some(slots),
                ..runner(&named)
            };
            assert!(
                save_runner(app_data.path(), request).is_err(),
                "slots {slots} 는 거절돼야 합니다"
            );
        }
        for name in ["PC 실행기", "a/b", "..", &"x".repeat(65)] {
            let request = SaveRunnerRequest {
                name: name.to_owned(),
                ..runner(&named)
            };
            assert!(
                save_runner(app_data.path(), request).is_err(),
                "이름 {name} 는 거절돼야 합니다"
            );
        }

        save_runner(app_data.path(), runner(&named)).expect("save");
        let snapshot = list(home.path(), app_data.path());
        assert_eq!(snapshot.runners.len(), 1);
        let saved = &snapshot.runners[0];
        // 규칙 밖 글자는 -로 바뀌고 끝의 -는 버려진다.
        assert_eq!(saved.name, "PC-1");
        assert_eq!(saved.slots, DEFAULT_SLOTS);
        assert!(saved.enabled);
        assert!(saved.server_found);
        assert_eq!(saved.host, "10.0.0.5");
        assert_eq!(saved.user, "builder");
        assert!(saved.agent_enabled);
        assert_eq!(saved.key_fingerprint, fingerprint);
        assert_eq!(saved.skip_code, None);
        assert!(saved.id.starts_with(RUNNER_ID_PREFIX));

        let duplicate = save_runner(app_data.path(), runner(&named));
        assert!(
            matches!(duplicate, Err(CoreError::Conflict(_))),
            "{duplicate:?}"
        );

        save_runner(
            app_data.path(),
            SaveRunnerRequest {
                slots: Some(8),
                enabled: Some(false),
                ..runner(&unnamed)
            },
        )
        .expect("second");
        let snapshot = list(home.path(), app_data.path());
        // 서버 이름이 규칙에 맞는 글자를 남기지 않으면 호스트가 이름이다(점은 남는다).
        let second = by_name(&snapshot, "10.0.0.6");
        assert_eq!(second.slots, 8);
        assert!(!second.enabled);
        assert_eq!(second.skip_code, Some(RunnerSkipCode::Disabled));

        // 고치기는 같은 id를 유지하고, 다른 실행기의 서버로 옮기는 것은 거절된다.
        let first_id = by_name(&snapshot, "PC-1").id.clone();
        let moved = save_runner(
            app_data.path(),
            SaveRunnerRequest {
                id: Some(first_id.clone()),
                ..runner(&unnamed)
            },
        );
        assert!(matches!(moved, Err(CoreError::Conflict(_))), "{moved:?}");
        save_runner(
            app_data.path(),
            SaveRunnerRequest {
                id: Some(first_id.clone()),
                name: "pc-runner".to_owned(),
                slots: Some(4),
                ..runner(&named)
            },
        )
        .expect("edit");
        let edited = list(home.path(), app_data.path());
        let first = by_name(&edited, "pc-runner");
        assert_eq!(first.id, first_id);
        assert_eq!(first.slots, 4);
        assert_eq!(edited.ssh_servers.len(), 2);

        delete_runner(
            app_data.path(),
            RunnerRef {
                id: first_id.clone(),
            },
        )
        .expect("delete");
        assert_eq!(list(home.path(), app_data.path()).runners.len(), 1);
        assert!(matches!(
            delete_runner(app_data.path(), RunnerRef { id: first_id }),
            Err(CoreError::NotFound(_))
        ));
        assert!(matches!(
            check_runner(
                app_data.path(),
                RunnerRef {
                    id: "run-000000000000".to_owned()
                },
                false
            ),
            Err(CoreError::NotFound(_))
        ));
    }

    /// C21. 서버가 지워진 실행기도 켜짐은 바꿀 수 있고, 저장은 다른 서버를 다시 골라야 된다.
    #[test]
    fn c21_orphaned_runner_can_be_toggled_and_needs_a_new_server_to_save() {
        let home = tempfile::tempdir().expect("home");
        let app_data = tempfile::tempdir().expect("app data");
        let fingerprint = key_fixture(home.path(), "id_runner", 7);
        let gone = server(
            home.path(),
            app_data.path(),
            &fingerprint,
            "gone",
            "10.0.0.8",
            true,
        );
        let spare = server(
            home.path(),
            app_data.path(),
            &fingerprint,
            "spare",
            "10.0.0.9",
            true,
        );
        save_runner(app_data.path(), runner(&gone)).expect("save");
        crate::ssh_endpoints::delete_ssh_server_for_test(home.path(), app_data.path(), &gone)
            .expect("delete server");
        let orphan = by_name(&list(home.path(), app_data.path()), "gone").clone();
        assert!(!orphan.server_found);
        assert_eq!(orphan.skip_code, Some(RunnerSkipCode::ServerMissing));

        set_runner_enabled(
            app_data.path(),
            SetRunnerEnabledRequest {
                id: orphan.id.clone(),
                enabled: false,
            },
        )
        .expect("toggle without server");
        let toggled = by_name(&list(home.path(), app_data.path()), "gone").clone();
        assert!(!toggled.enabled);
        assert_eq!(toggled.skip_code, Some(RunnerSkipCode::Disabled));
        assert!(matches!(
            set_runner_enabled(
                app_data.path(),
                SetRunnerEnabledRequest {
                    id: "run-000000000000".to_owned(),
                    enabled: true,
                }
            ),
            Err(CoreError::NotFound(_))
        ));

        let stale = save_runner(
            app_data.path(),
            SaveRunnerRequest {
                id: Some(orphan.id.clone()),
                name: "gone".to_owned(),
                ..runner(&gone)
            },
        );
        assert!(matches!(stale, Err(CoreError::NotFound(_))), "{stale:?}");
        save_runner(
            app_data.path(),
            SaveRunnerRequest {
                id: Some(orphan.id.clone()),
                name: "gone".to_owned(),
                enabled: Some(true),
                ..runner(&spare)
            },
        )
        .expect("repoint");
        let repointed = by_name(&list(home.path(), app_data.path()), "gone").clone();
        assert!(repointed.server_found);
        assert_eq!(repointed.host, "10.0.0.9");
        assert_eq!(repointed.skip_code, None);
    }

    /// C21-2. 프로젝트 폴더는 이 기계에 있는 절대 경로 폴더이고, `..`를 받지 않으며 정규
    /// 경로로 저장된다. 이름과 제외 폴더는 짧은 토큰만 받고, 한 줄 단위로 더하고 고치고 뺀다.
    #[test]
    fn c21_project_rows_are_validated_and_edited_one_at_a_time() {
        let app_data = tempfile::tempdir().expect("app data");
        let work = tempfile::tempdir().expect("work");
        let repo = work.path().join("dead-route-game");
        let other = work.path().join("other");
        fs::create_dir(&repo).expect("repo");
        fs::create_dir(&other).expect("other");
        fs::write(work.path().join("file.txt"), b"x").expect("file");

        add_runner_project(
            app_data.path(),
            RunnerProjectInput {
                id: None,
                name: "dead-route-game".to_owned(),
                root: format!("{}/./", repo.to_string_lossy()),
                exclude: vec![" _land ".to_owned(), "_land".to_owned(), String::new()],
            },
        )
        .expect("add");
        let projects = list_runners_with(None, app_data.path())
            .expect("list")
            .projects;
        assert_eq!(projects.len(), 1);
        let saved = &projects[0];
        assert_eq!(
            Path::new(&saved.root),
            fs::canonicalize(&repo).expect("canonical")
        );
        assert_eq!(saved.exclude, vec!["_land".to_owned()]);
        assert!(saved.id.starts_with(PROJECT_ID_PREFIX));

        let rejected = [
            project("Upper", &other, &[]),
            project("", &other, &[]),
            project("..", &other, &[]),
            project("has space", &other, &[]),
            project("ok", Path::new("relative/path"), &[]),
            project("ok", &work.path().join("missing"), &[]),
            project("ok", &work.path().join("file.txt"), &[]),
            project("ok", &repo.join("..").join("other"), &[]),
            project("ok", &other, &["a/b"]),
            project("ok", &other, &[".."]),
            project("ok", &other, &["with space"]),
            // 같은 이름, 같은 폴더
            project("dead-route-game", &other, &[]),
            project("second", &repo, &[]),
        ];
        for input in rejected {
            let label = format!("{} {} {:?}", input.name, input.root, input.exclude);
            assert!(
                add_runner_project(app_data.path(), input).is_err(),
                "{label} 는 거절돼야 합니다"
            );
        }

        add_runner_project(app_data.path(), project("other", &other, &[])).expect("second");
        let id = saved.id.clone();
        update_runner_project(
            app_data.path(),
            RunnerProjectInput {
                id: Some(id.clone()),
                ..project("dead-route-game", &repo, &["dist"])
            },
        )
        .expect("update");
        // 다른 줄의 이름으로 고치는 것은 거절된다.
        assert!(update_runner_project(
            app_data.path(),
            RunnerProjectInput {
                id: Some(id.clone()),
                ..project("other", &repo, &[])
            },
        )
        .is_err());
        assert!(update_runner_project(app_data.path(), project("x", &repo, &[])).is_err());
        let projects = list_runners_with(None, app_data.path())
            .expect("list")
            .projects;
        assert_eq!(projects.len(), 2);
        assert_eq!(projects[0].id, id);
        assert_eq!(projects[0].exclude, vec!["dist".to_owned()]);

        delete_runner_project(app_data.path(), RunnerRef { id: id.clone() }).expect("delete");
        let projects = list_runners_with(None, app_data.path())
            .expect("list")
            .projects;
        assert_eq!(projects.len(), 1);
        assert_eq!(projects[0].name, "other");
        assert!(matches!(
            delete_runner_project(app_data.path(), RunnerRef { id }),
            Err(CoreError::NotFound(_))
        ));
    }

    /// C21-2 / C9-16. 프로젝트 폴더의 하위 트리는 다른 기계로 복사되므로, 홈 자체·`~/.ssh`
    /// 같은 자격증명 경로·앱 데이터 내부는 거절하고, 앱 데이터 안이라도 AIA 작업공간 하위는
    /// 받는다. 심볼릭 링크로 금지 경로를 가리켜도 푼 경로로 거절된다.
    #[test]
    fn c21_project_roots_refuse_credential_and_app_data_paths_but_allow_the_aia_workspace() {
        let app_data = tempfile::tempdir().expect("app data");
        let work = tempfile::tempdir().expect("work");
        let settings = app_data.path().join("credential-profiles");
        fs::create_dir(&settings).expect("settings");
        let workspace = app_data.path().join(crate::chat::AIA_WORKSPACE_DIR);
        let game = workspace.join("dead-route-game");
        fs::create_dir_all(&game).expect("workspace project");
        let ssh = work.path().join("nested").join(".ssh");
        fs::create_dir_all(&ssh).expect("ssh dir");

        let mut refused = vec![
            app_data.path().to_path_buf(),
            settings.clone(),
            workspace.clone(),
            ssh,
            PathBuf::from("/"),
        ];
        if let Some(home) = crate::user_home::optional_home_dir() {
            if home.is_dir() {
                refused.push(home);
            }
        }
        #[cfg(unix)]
        {
            let link = work.path().join("link-to-settings");
            std::os::unix::fs::symlink(&settings, &link).expect("symlink");
            refused.push(link);
        }
        for root in refused {
            let result = validate_project_root(app_data.path(), &root.to_string_lossy());
            assert!(result.is_err(), "{} 는 거절돼야 합니다", root.display());
        }

        let accepted =
            validate_project_root(app_data.path(), &game.to_string_lossy()).expect("aia workspace");
        assert_eq!(
            Path::new(&accepted),
            fs::canonicalize(&game).expect("canonical")
        );
        #[cfg(unix)]
        {
            // 작업공간 하위를 가리키는 링크는 푼 경로로 저장된다.
            let link = work.path().join("link-to-game");
            std::os::unix::fs::symlink(&game, &link).expect("symlink");
            let resolved =
                validate_project_root(app_data.path(), &link.to_string_lossy()).expect("link");
            assert_eq!(resolved, accepted);
        }
    }

    /// C21. 저장본은 앱 데이터의 `runners-v1.json` 한 벌이고, 다시 읽어도 같은 값이다.
    #[test]
    fn c21_store_round_trips_in_app_data() {
        let home = tempfile::tempdir().expect("home");
        let app_data = tempfile::tempdir().expect("app data");
        let work = tempfile::tempdir().expect("work");
        let fingerprint = key_fixture(home.path(), "id_runner", 7);
        let id = server(
            home.path(),
            app_data.path(),
            &fingerprint,
            "pc",
            "10.0.0.5",
            true,
        );

        let empty = list(home.path(), app_data.path());
        assert!(empty.runners.is_empty() && empty.projects.is_empty());
        assert_eq!(empty.ssh_servers.len(), 1);
        assert_eq!((empty.min_slots, empty.max_slots), (MIN_SLOTS, MAX_SLOTS));

        save_runner(
            app_data.path(),
            SaveRunnerRequest {
                note: "데스크탑".to_owned(),
                slots: Some(3),
                ..runner(&id)
            },
        )
        .expect("save");
        add_runner_project(app_data.path(), project("game", work.path(), &["_land"]))
            .expect("project");
        assert!(app_data.path().join(RUNNERS_STORE.file).is_file());

        let first = list(home.path(), app_data.path());
        let reread = list(home.path(), app_data.path());
        assert_eq!(reread, first);
        assert_eq!(reread.runners[0].note, "데스크탑");
        assert_eq!(reread.runners[0].slots, 3);
        assert_eq!(reread.projects[0].exclude, vec!["_land".to_owned()]);
    }

    /// C21-5. 브라우저 자리는 0 이상(상한 없음)이고 기본 0(브라우저 시험 없음)이다. 이 칸을 보내지 않은
    /// 고치기는 저장된 값을 지우지 않고, 칸이 없던 옛 저장본은 0으로 읽으며, CLI 목록·AIA
    /// 목록에 같은 값이 실린다.
    #[test]
    fn c21_browser_slots_default_to_zero_are_unbounded_and_survive_edits_without_them() {
        let home = tempfile::tempdir().expect("home");
        let app_data = tempfile::tempdir().expect("app data");
        let fingerprint = key_fixture(home.path(), "id_runner", 7);
        let id = server(
            home.path(),
            app_data.path(),
            &fingerprint,
            "mac",
            "10.0.0.5",
            true,
        );

        save_runner(app_data.path(), runner(&id)).expect("save");
        let saved = list(home.path(), app_data.path());
        // 상한이 없다(사용자 결정) — 저장 형식의 끝을 싣고, 화면은 그 값을 "0 이상"으로 읽는다.
        assert_eq!(saved.max_browsers, u32::MAX);
        let runner_id = saved.runners[0].id.clone();
        assert_eq!(saved.runners[0].browsers, 0);

        save_runner(
            app_data.path(),
            SaveRunnerRequest {
                id: Some(runner_id.clone()),
                browsers: Some(2),
                ..runner(&id)
            },
        )
        .expect("browsers");
        // 브라우저 칸 없이 자리 수만 고쳐도 브라우저 자리는 그대로다.
        save_runner(
            app_data.path(),
            SaveRunnerRequest {
                id: Some(runner_id.clone()),
                slots: Some(4),
                ..runner(&id)
            },
        )
        .expect("edit without browsers");
        let edited = list(home.path(), app_data.path());
        assert_eq!(
            (edited.runners[0].slots, edited.runners[0].browsers),
            (4, 2)
        );
        let agent = list_runners_for_agent_with(Some(home.path()), app_data.path()).expect("agent");
        assert_eq!(agent.runners[0].browsers, 2);
        let listing = runner_cli_listing_with(home.path(), app_data.path()).expect("listing");
        assert_eq!(listing.runners[0].browsers, 2);
        // 상한이 없어 큰 값도 받는다.
        save_runner(
            app_data.path(),
            SaveRunnerRequest {
                id: Some(runner_id.clone()),
                browsers: Some(64),
                ..runner(&id)
            },
        )
        .expect("many browsers");
        assert_eq!(list(home.path(), app_data.path()).runners[0].browsers, 64);
        // 0으로 되돌리면 브라우저 시험을 보내지 않는다.
        save_runner(
            app_data.path(),
            SaveRunnerRequest {
                id: Some(runner_id.clone()),
                browsers: Some(0),
                ..runner(&id)
            },
        )
        .expect("off");
        assert_eq!(list(home.path(), app_data.path()).runners[0].browsers, 0);

        // 이 칸이 생기기 전 저장본(browsers 없음)은 0으로 읽는다.
        let file = app_data.path().join(RUNNERS_STORE.file);
        let mut raw: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&file).expect("read")).expect("json");
        raw["runners"][0]
            .as_object_mut()
            .expect("runner")
            .remove("browsers");
        std::fs::write(&file, raw.to_string()).expect("write");
        let old = list(home.path(), app_data.path());
        assert_eq!(
            (old.runners[0].id.as_str(), old.runners[0].browsers),
            (runner_id.as_str(), 0)
        );
    }

    /// C21. 고치기 요청에 없는 칸(자리 수·켜짐)은 브라우저 칸처럼 저장값을 지킨다. 새 실행기만
    /// 기본값(자리 2·켜짐)으로 시작한다.
    #[test]
    fn c21_edits_without_slots_or_enabled_keep_the_stored_values() {
        let home = tempfile::tempdir().expect("home");
        let app_data = tempfile::tempdir().expect("app data");
        let fingerprint = key_fixture(home.path(), "id_runner", 7);
        let id = server(
            home.path(),
            app_data.path(),
            &fingerprint,
            "mac",
            "10.0.0.5",
            true,
        );

        save_runner(
            app_data.path(),
            SaveRunnerRequest {
                slots: Some(5),
                enabled: Some(false),
                ..runner(&id)
            },
        )
        .expect("save");
        let saved = list(home.path(), app_data.path());
        let runner_id = saved.runners[0].id.clone();
        assert_eq!(
            (saved.runners[0].slots, saved.runners[0].enabled),
            (5, false)
        );

        // 메모만 고치는 요청 — 자리 수와 켜짐 칸이 없다.
        save_runner(
            app_data.path(),
            SaveRunnerRequest {
                id: Some(runner_id.clone()),
                note: "메모".to_owned(),
                ..runner(&id)
            },
        )
        .expect("edit without slots or enabled");
        let edited = list(home.path(), app_data.path());
        assert_eq!(
            (
                edited.runners[0].slots,
                edited.runners[0].enabled,
                edited.runners[0].note.as_str()
            ),
            (5, false, "메모")
        );

        // 이 규칙이 지키는 쪽은 칸을 모르는 JSON 클라이언트다 — 본문에 없는 칸은 None으로 읽힌다.
        let wire: SaveRunnerRequest =
            serde_json::from_value(serde_json::json!({ "serverId": id, "name": "mac" }))
                .expect("deserialize");
        assert_eq!(
            (wire.slots, wire.enabled, wire.browsers),
            (None, None, None)
        );

        // 칸을 보내면 그 값이 이긴다.
        save_runner(
            app_data.path(),
            SaveRunnerRequest {
                id: Some(runner_id.clone()),
                slots: Some(3),
                enabled: Some(true),
                ..runner(&id)
            },
        )
        .expect("explicit edit");
        let explicit = list(home.path(), app_data.path());
        assert_eq!(
            (explicit.runners[0].slots, explicit.runners[0].enabled),
            (3, true)
        );
    }

    /// C21-4. 외부 도구 목록에는 켜져 있고, SSH 서버의 에이전트 사용이 켜져 있으며, 개인키를
    /// 외부 도구가 직접 쓸 수 있는 실행기만 실린다. 나머지는 이유와 함께 skipped로 가고,
    /// 화면의 skipReason도 같은 판정이다.
    #[test]
    fn c21_cli_listing_keeps_only_usable_runners_and_explains_the_rest() {
        let home = tempfile::tempdir().expect("home");
        let app_data = tempfile::tempdir().expect("app data");
        let work = tempfile::tempdir().expect("work");
        let fingerprint = key_fixture(home.path(), "id_runner", 7);
        let locked_key = key_fixture(home.path(), "id_locked", 9);
        let ready = server(
            home.path(),
            app_data.path(),
            &fingerprint,
            "ready",
            "10.0.0.5",
            true,
        );
        let agent_off = server(
            home.path(),
            app_data.path(),
            &fingerprint,
            "off",
            "10.0.0.6",
            false,
        );
        let disabled = server(
            home.path(),
            app_data.path(),
            &fingerprint,
            "idle",
            "10.0.0.7",
            true,
        );
        let gone = server(
            home.path(),
            app_data.path(),
            &fingerprint,
            "gone",
            "10.0.0.8",
            true,
        );
        let locked = server(
            home.path(),
            app_data.path(),
            &locked_key,
            "locked",
            "10.0.0.9",
            true,
        );
        let vault = crate::ssh_askpass::tests::MemoryVault::default();
        crate::ssh_askpass::store_passphrase(&vault, app_data.path(), &locked_key, "s3cret")
            .expect("passphrase");

        save_runner(
            app_data.path(),
            SaveRunnerRequest {
                slots: Some(3),
                ..runner(&ready)
            },
        )
        .expect("ready");
        save_runner(app_data.path(), runner(&agent_off)).expect("agent off");
        save_runner(
            app_data.path(),
            SaveRunnerRequest {
                enabled: Some(false),
                ..runner(&disabled)
            },
        )
        .expect("disabled");
        save_runner(app_data.path(), runner(&gone)).expect("gone");
        save_runner(app_data.path(), runner(&locked)).expect("locked");
        crate::ssh_endpoints::delete_ssh_server_for_test(home.path(), app_data.path(), &gone)
            .expect("delete server");
        add_runner_project(app_data.path(), project("game", work.path(), &["_land"]))
            .expect("projects");

        let listing = runner_cli_listing_with(home.path(), app_data.path()).expect("listing");
        assert_eq!(listing.schema_version, CLI_LISTING_VERSION);
        assert_eq!(listing.runners.len(), 1, "{listing:?}");
        let entry = &listing.runners[0];
        assert_eq!(entry.name, "ready");
        assert!(entry.id.starts_with(RUNNER_ID_PREFIX));
        assert_eq!(entry.host, "10.0.0.5");
        assert_eq!(entry.port, 22);
        assert_eq!(entry.user, "builder");
        assert_eq!(entry.slots, 3);
        assert!(Path::new(&entry.identity_path).ends_with(".ssh/id_runner"));
        // 접속 인자는 `ssh list`의 것과 같다 — 앱의 호스트 키 정책을 그대로 지닌다.
        let ssh_list =
            crate::ssh_endpoints::list_agent_ssh_endpoints_with(home.path(), app_data.path())
                .expect("ssh list");
        let same = ssh_list
            .endpoints
            .iter()
            .find(|endpoint| endpoint.server_id == ready)
            .expect("ssh list entry");
        assert_eq!(entry.ssh_args, same.ssh_args);
        assert!(entry.ssh_args.contains(&"BatchMode=yes".to_owned()));
        assert!(entry
            .ssh_args
            .iter()
            .all(|arg| !arg.contains("StrictHostKeyChecking")));

        let skipped: Vec<(&str, RunnerSkipCode)> = listing
            .skipped
            .iter()
            .map(|skip| (skip.name.as_str(), skip.code))
            .collect();
        assert_eq!(
            skipped,
            vec![
                ("off", RunnerSkipCode::AgentOff),
                ("idle", RunnerSkipCode::Disabled),
                ("gone", RunnerSkipCode::ServerMissing),
                ("locked", RunnerSkipCode::PassphraseProtected),
            ]
        );
        assert!(listing.skipped.iter().all(|skip| !skip.reason.is_empty()));
        assert_eq!(listing.projects.len(), 1);
        assert_eq!(listing.projects[0].name, "game");
        assert_eq!(listing.projects[0].exclude, vec!["_land".to_owned()]);

        // 응답에는 개인키 내용과 암호가 없다 — 경로만 실린다(G4).
        let json = serde_json::to_string(&listing).expect("json");
        assert!(!json.contains("private material"));
        assert!(!json.contains("s3cret"));
        assert!(json.contains("\"identityPath\""));
        assert!(json.contains("\"sshArgs\""));
        assert!(json.contains("\"schemaVersion\":1"));

        // 화면의 사유는 CLI와 같은 판정에서 나온다.
        let view = list(home.path(), app_data.path());
        for skip in &listing.skipped {
            let row = by_name(&view, &skip.name);
            assert_eq!(row.skip_code, Some(skip.code), "{}", skip.name);
            assert_eq!(row.skip_reason.as_deref(), Some(skip.reason.as_str()));
        }
        assert_eq!(by_name(&view, "ready").skip_code, None);
    }

    /// C21-3. AIA 목록은 에이전트 사용이 꺼진 서버의 접속 정보와 고를 수 있는 서버 목록을
    /// 싣지 않고, AIA의 접속 확인은 그 서버에 닿기 전에 거절된다.
    #[test]
    fn c21_agent_listing_hides_agent_off_servers_and_refuses_their_check() {
        let home = tempfile::tempdir().expect("home");
        let app_data = tempfile::tempdir().expect("app data");
        let fingerprint = key_fixture(home.path(), "id_runner", 7);
        let open = server(
            home.path(),
            app_data.path(),
            &fingerprint,
            "open",
            "10.0.0.5",
            true,
        );
        let closed = server(
            home.path(),
            app_data.path(),
            &fingerprint,
            "closed",
            "10.9.9.9",
            false,
        );
        save_runner(app_data.path(), runner(&open)).expect("open");
        save_runner(app_data.path(), runner(&closed)).expect("closed");

        let view = list_runners_for_agent_with(Some(home.path()), app_data.path()).expect("agent");
        let json = serde_json::to_value(&view).expect("json");
        assert!(json.get("sshServers").is_none());
        let hidden = view
            .runners
            .iter()
            .find(|entry| entry.name == "closed")
            .expect("closed");
        assert!(!hidden.agent_enabled);
        assert_eq!(hidden.skip_code, Some(RunnerSkipCode::AgentOff));
        assert!(hidden.host.is_none() && hidden.port.is_none() && hidden.user.is_none());
        assert!(hidden.key_fingerprint.is_none() && hidden.server_id.is_none());
        let text = serde_json::to_string(&view).expect("text");
        assert!(!text.contains("10.9.9.9"));
        assert!(!text.contains(&closed));
        let shown = view
            .runners
            .iter()
            .find(|entry| entry.name == "open")
            .expect("open");
        assert_eq!(shown.host.as_deref(), Some("10.0.0.5"));

        let closed_id = hidden.id.clone();
        let refused = check_runner(app_data.path(), RunnerRef { id: closed_id }, true);
        assert!(
            matches!(refused, Err(CoreError::Conflict(_))),
            "{refused:?}"
        );
    }

    /// C21-4. CLI 인자: `list`만 받고, `--app-data-dir`는 값이 있어야 하며 모르는 인자는 거절한다.
    #[test]
    fn c21_cli_arguments_are_parsed_strictly() {
        let parse = |args: &[&str]| parse_runners_cli(args.iter().map(|arg| (*arg).to_owned()));
        assert_eq!(parse(&["list"]).expect("bare"), None);
        assert_eq!(
            parse(&["list", "--app-data-dir", "/data"]).expect("dir"),
            Some(PathBuf::from("/data"))
        );
        for bad in [
            &[][..],
            &["bogus"][..],
            &["list", "--app-data-dir"][..],
            &["list", "--verbose"][..],
        ] {
            assert!(parse(bad).is_err(), "{bad:?} 는 거절돼야 합니다");
        }
    }
}
