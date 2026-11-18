//! C23: AIA 대화 — 다른 기기의 AIA에게 묻고 답을 받는 피어 목록, 정책, 스킬 출처 장부.
//!
//! # 회원 자격은 테일넷이 증명한다
//!
//! 피어는 같은 테일넷에 있는 다른 Agent Manager 백엔드다. 요청을 받는 쪽은 Tailscale Serve가
//! 붙이는 사용자 로그인 헤더를 이미 설정의 사용자와 비교해 통과시키므로(`remote.rs`
//! `classify_channel`), 피어 통로는 그 원격 채널 위에서 **로그인 세션 없이** 연다. 기기를
//! 테일넷에 넣는 것이 곧 가입이고, 여기에는 비밀값이 하나도 없다(G4) — 주소·이름·토글·메모와
//! 스킬 출처 장부만 앱 데이터에 둔다(G7, `aia-peers-v1.json`).
//!
//! # 쌍이 아니라 회원
//!
//! 기기 쌍마다 인증하면 연결 수가 기기 수의 제곱으로 는다. 이 모듈은 "누구에게 물을 수
//! 있는가"(피어 목록과 에이전트 사용 토글)만 저장하고, "누가 나에게 물을 수 있는가"는
//! 정책 하나(`enabled`)가 테일넷 회원 전체에 답한다. 기기별 예외는 두지 않는다 — 필요해지면
//! 거절 목록을 정책에 더하는 것으로 충분하다.
//!
//! # 스킬은 동기화하지 않는다
//!
//! 피어의 스킬은 필요할 때 목록을 보고 하나씩 가져온다(2026-11-15 사용자 결정). 가져온
//! 스킬은 출처 장부(`imports`)에 그때의 피어 지문과 내 지문을 남기고, 다음에 목록을 볼 때
//! 그 둘과 비교해 `피어가 새로움`·`내가 고침`·`둘 다 바뀜`을 계산한다. 주기 작업은 없다.
//! 피어에 무엇이든 물으면 응답 봉투에 그 기기 스킬 목록 전체의 지문(`skillsRevision`)이
//! 실려 오고, 마지막으로 목록을 봤을 때 값과 다르면 화면에 배지만 켠다.

use std::collections::BTreeMap;
use std::path::Path;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::clock::now_ms;
use crate::json_store::{JsonStore, SchemaVersioned};
use crate::skill_library::{export_common_skill_files, ExportedSkillFile};
use crate::CoreError;

const STORE_VERSION: u32 = 1;
const STORE: JsonStore = JsonStore {
    file: "aia-peers-v1.json",
    lock_file: "aia-peers-v1.lock",
    label: "AIA 피어 저장소",
    version: STORE_VERSION,
};

/// 피어 API의 계약 버전. 받는 쪽이 모르는 버전은 거절한다.
pub const PEER_PROTOCOL_VERSION: u32 = 1;
/// 이 기기 자신을 피어처럼 부를 때의 id. 저장소에는 없고 정책의 `allowLocal`이 연다.
pub const LOCAL_PEER_ID: &str = "local";

const MAX_PEERS: usize = 32;
const MAX_NAME_CHARS: usize = 64;
const MAX_URL_CHARS: usize = 512;
const MAX_NOTE_CHARS: usize = 200;
const MAX_ID_CHARS: usize = 40;
const PEER_ID_PREFIX: &str = "peer-";
const MAX_IMPORT_RECORDS: usize = 512;

pub const MIN_MAX_DEPTH: u32 = 1;
pub const MAX_MAX_DEPTH: u32 = 4;
pub const DEFAULT_MAX_DEPTH: u32 = 2;
pub const MIN_MAX_CONCURRENT: u32 = 1;
pub const MAX_MAX_CONCURRENT: u32 = 8;
pub const DEFAULT_MAX_CONCURRENT: u32 = 1;
pub const MIN_TIMEOUT_MS: u64 = 60 * 1000;
pub const MAX_TIMEOUT_MS: u64 = 30 * 60 * 1000;
pub const DEFAULT_TIMEOUT_MS: u64 = 10 * 60 * 1000;
const DEFAULT_DEVICE_NAME: &str = "agent-manager";

/// 이 기기가 피어 요청을 받고 보내는 규칙. 기본은 모두 꺼짐이다 — 대화 통로를 여는 것은
/// 사람의 결정이고, 켜기 전에는 받지도 보내지도 않는다.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiaPeerPolicy {
    /// 피어 기능 전체. 꺼져 있으면 수신 통로는 403이고 AIA의 피어 작업도 거절된다.
    pub enabled: bool,
    /// 이 기기의 AIA가 같은 기기의 새 AIA에게 묻는 것을 허용할지.
    pub allow_local: bool,
    /// 요청이 거친 홉 수의 상한. 사슬 길이가 이 값에 닿으면 받는 쪽이 거절한다.
    pub max_depth: u32,
    /// 동시에 받아 돌리는 피어 요청 수의 상한.
    pub max_concurrent: u32,
    /// 한 요청의 답을 기다리는 상한. 넘으면 그 무인 AIA를 멈추고 timedOut으로 끝낸다.
    pub timeout_ms: u64,
    /// 다른 기기에 보이는 이 기기 이름. 비우면 Tailscale 호스트, 그것도 없으면 기본 이름.
    pub device_name: String,
}

impl Default for AiaPeerPolicy {
    fn default() -> Self {
        Self {
            enabled: false,
            allow_local: false,
            max_depth: DEFAULT_MAX_DEPTH,
            max_concurrent: DEFAULT_MAX_CONCURRENT,
            timeout_ms: DEFAULT_TIMEOUT_MS,
            device_name: String::new(),
        }
    }
}

/// 저장된 피어 한 대. 주소와 이름뿐이고 자격증명은 없다.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AiaPeerRecord {
    pub id: String,
    pub name: String,
    pub url: String,
    pub agent_enabled: bool,
    #[serde(default)]
    pub note: String,
    #[serde(default)]
    pub updated_at: i64,
    /// 마지막으로 스킬 목록을 봤을 때 그 기기의 목록 지문.
    #[serde(default)]
    pub skills_revision_seen: Option<String>,
    /// 마지막 교환 응답이 실어 온 목록 지문. `seen`과 다르면 변경이 있다는 뜻이다.
    #[serde(default)]
    pub skills_revision_latest: Option<String>,
}

/// 피어에서 가져온 스킬의 출처. 가져온 순간의 두 지문이 나중의 상태 판정 기준이다.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PeerSkillImport {
    pub key: String,
    pub peer_id: String,
    pub peer_digest: String,
    pub local_digest: String,
    pub imported_at: i64,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct AiaPeerStore {
    schema_version: u32,
    #[serde(default)]
    policy: AiaPeerPolicy,
    #[serde(default)]
    peers: Vec<AiaPeerRecord>,
    #[serde(default)]
    imports: Vec<PeerSkillImport>,
}

impl SchemaVersioned for AiaPeerStore {
    fn schema_version(&self) -> u32 {
        self.schema_version
    }
}

impl Default for AiaPeerStore {
    fn default() -> Self {
        Self {
            schema_version: STORE_VERSION,
            policy: AiaPeerPolicy::default(),
            peers: Vec::new(),
            imports: Vec::new(),
        }
    }
}

// ---------------------------------------------------------------------------
// 화면과 AIA가 보는 모양
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiaPeerView {
    pub id: String,
    pub name: String,
    pub url: String,
    pub agent_enabled: bool,
    pub note: String,
    pub updated_at: i64,
    /// 마지막 교환이 알려 온 스킬 목록 지문이 마지막으로 본 목록과 다른지.
    pub skills_changed: bool,
}

/// 다른 기기에 보이는 이 기기. id는 백엔드 저장소 id라 앱 데이터마다 하나다.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiaPeerDevice {
    pub id: String,
    pub name: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiaPeerDefaults {
    pub max_depth_min: u32,
    pub max_depth_max: u32,
    pub max_concurrent_min: u32,
    pub max_concurrent_max: u32,
    pub timeout_ms_min: u64,
    pub timeout_ms_max: u64,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiaPeersSnapshot {
    pub schema_version: u32,
    pub policy: AiaPeerPolicy,
    pub device: AiaPeerDevice,
    /// 원격 접속(Tailscale)이 켜져 있어 다른 기기의 요청을 받을 수 있는지.
    pub inbound_ready: bool,
    pub peers: Vec<AiaPeerView>,
    pub issues: Vec<String>,
    pub defaults: AiaPeerDefaults,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentAiaPeerView {
    pub id: String,
    pub name: String,
    pub url: String,
    pub note: String,
    pub skills_changed: bool,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentAiaPeerSkip {
    pub id: String,
    pub name: String,
    pub reason: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentLocalPeer {
    pub available: bool,
    pub reason: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentAiaPeersView {
    pub schema_version: u32,
    pub enabled: bool,
    pub device: AiaPeerDevice,
    pub local: AgentLocalPeer,
    pub peers: Vec<AgentAiaPeerView>,
    pub skipped: Vec<AgentAiaPeerSkip>,
    pub issues: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SetAiaPeerPolicyRequest {
    #[serde(default)]
    pub enabled: Option<bool>,
    #[serde(default)]
    pub allow_local: Option<bool>,
    #[serde(default)]
    pub max_depth: Option<u32>,
    #[serde(default)]
    pub max_concurrent: Option<u32>,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
    #[serde(default)]
    pub device_name: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetAiaPeerRequest {
    #[serde(default)]
    pub id: Option<String>,
    pub name: String,
    pub url: String,
    #[serde(default)]
    pub note: String,
    #[serde(default)]
    pub agent_enabled: Option<bool>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiaPeerRef {
    pub id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetAiaPeerAgentEnabledRequest {
    pub id: String,
    pub enabled: bool,
}

// ---------------------------------------------------------------------------
// 저장소 읽기·쓰기
// ---------------------------------------------------------------------------

fn defaults() -> AiaPeerDefaults {
    AiaPeerDefaults {
        max_depth_min: MIN_MAX_DEPTH,
        max_depth_max: MAX_MAX_DEPTH,
        max_concurrent_min: MIN_MAX_CONCURRENT,
        max_concurrent_max: MAX_MAX_CONCURRENT,
        timeout_ms_min: MIN_TIMEOUT_MS,
        timeout_ms_max: MAX_TIMEOUT_MS,
    }
}

/// 이 기기의 피어 신원. id는 백엔드 서비스 설정의 저장소 id(UUID)라 앱 데이터마다 하나이고,
/// 이름은 정책에 적은 값 → Tailscale 호스트 → 기본 이름 순이다. 호스트는 떠 있는 서버가
/// 알고 있는 값을 호출자가 건넨다 — 저장소 함수가 Tailscale CLI를 부르지 않게 한다.
pub fn device_identity(
    app_data_dir: &Path,
    tailscale_host: Option<&str>,
) -> Result<AiaPeerDevice, CoreError> {
    let store: AiaPeerStore = STORE.read(app_data_dir)?;
    device_identity_of(app_data_dir, &store.policy, tailscale_host)
}

fn device_identity_of(
    app_data_dir: &Path,
    policy: &AiaPeerPolicy,
    tailscale_host: Option<&str>,
) -> Result<AiaPeerDevice, CoreError> {
    let id = crate::load_backend_service_settings(app_data_dir)?.store_id;
    let name = if policy.device_name.trim().is_empty() {
        tailscale_host
            .map(str::to_owned)
            .unwrap_or_else(|| DEFAULT_DEVICE_NAME.to_owned())
    } else {
        policy.device_name.trim().to_owned()
    };
    Ok(AiaPeerDevice { id, name })
}

pub fn policy(app_data_dir: &Path) -> Result<AiaPeerPolicy, CoreError> {
    let store: AiaPeerStore = STORE.read(app_data_dir)?;
    Ok(store.policy)
}

fn view_of(record: &AiaPeerRecord) -> AiaPeerView {
    AiaPeerView {
        id: record.id.clone(),
        name: record.name.clone(),
        url: record.url.clone(),
        agent_enabled: record.agent_enabled,
        note: record.note.clone(),
        updated_at: record.updated_at,
        skills_changed: skills_changed(record),
    }
}

fn skills_changed(record: &AiaPeerRecord) -> bool {
    match (&record.skills_revision_seen, &record.skills_revision_latest) {
        (Some(seen), Some(latest)) => seen != latest,
        (None, Some(_)) => true,
        _ => false,
    }
}

fn snapshot_of(
    app_data_dir: &Path,
    store: &AiaPeerStore,
    tailscale_host: Option<&str>,
) -> Result<AiaPeersSnapshot, CoreError> {
    let mut issues = Vec::new();
    let device = device_identity_of(app_data_dir, &store.policy, tailscale_host)?;
    let inbound_ready = tailscale_host.is_some();
    if store.policy.enabled && !inbound_ready {
        issues.push(
            "원격 접속(Tailscale)이 꺼져 있어 다른 기기의 요청을 받지 못합니다. 묻는 것만 됩니다"
                .to_owned(),
        );
    }
    Ok(AiaPeersSnapshot {
        schema_version: STORE_VERSION,
        policy: store.policy.clone(),
        device,
        inbound_ready,
        peers: store.peers.iter().map(view_of).collect(),
        issues,
        defaults: defaults(),
    })
}

pub fn get_aia_peers(
    app_data_dir: &Path,
    tailscale_host: Option<&str>,
) -> Result<AiaPeersSnapshot, CoreError> {
    let store: AiaPeerStore = STORE.read(app_data_dir)?;
    snapshot_of(app_data_dir, &store, tailscale_host)
}

pub fn set_aia_peer_policy(
    app_data_dir: &Path,
    tailscale_host: Option<&str>,
    request: SetAiaPeerPolicyRequest,
) -> Result<AiaPeersSnapshot, CoreError> {
    let store = STORE.update(app_data_dir, |store: &mut AiaPeerStore| {
        let mut next = store.policy.clone();
        if let Some(enabled) = request.enabled {
            next.enabled = enabled;
        }
        if let Some(allow_local) = request.allow_local {
            next.allow_local = allow_local;
        }
        if let Some(depth) = request.max_depth {
            next.max_depth = depth;
        }
        if let Some(concurrent) = request.max_concurrent {
            next.max_concurrent = concurrent;
        }
        if let Some(timeout) = request.timeout_ms {
            next.timeout_ms = timeout;
        }
        if let Some(name) = &request.device_name {
            next.device_name = name.trim().to_owned();
        }
        validate_policy(&next)?;
        let changed = next != store.policy;
        store.policy = next;
        Ok(changed)
    })?;
    snapshot_of(app_data_dir, &store, tailscale_host)
}

pub(crate) fn validate_policy(policy: &AiaPeerPolicy) -> Result<(), CoreError> {
    if !(MIN_MAX_DEPTH..=MAX_MAX_DEPTH).contains(&policy.max_depth) {
        return Err(CoreError::InvalidInput(format!(
            "홉 상한은 {MIN_MAX_DEPTH}~{MAX_MAX_DEPTH} 사이여야 합니다"
        )));
    }
    if !(MIN_MAX_CONCURRENT..=MAX_MAX_CONCURRENT).contains(&policy.max_concurrent) {
        return Err(CoreError::InvalidInput(format!(
            "동시 수신 상한은 {MIN_MAX_CONCURRENT}~{MAX_MAX_CONCURRENT} 사이여야 합니다"
        )));
    }
    if !(MIN_TIMEOUT_MS..=MAX_TIMEOUT_MS).contains(&policy.timeout_ms) {
        return Err(CoreError::InvalidInput(format!(
            "응답 대기 상한은 {}초~{}분 사이여야 합니다",
            MIN_TIMEOUT_MS / 1000,
            MAX_TIMEOUT_MS / 60_000
        )));
    }
    if !policy.device_name.is_empty() {
        validate_name(&policy.device_name, "기기 이름")?;
    }
    Ok(())
}

pub fn set_aia_peer(
    app_data_dir: &Path,
    tailscale_host: Option<&str>,
    request: SetAiaPeerRequest,
) -> Result<AiaPeersSnapshot, CoreError> {
    let existing_id = request
        .id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(validate_peer_id)
        .transpose()?
        .map(str::to_owned);
    let name = validate_name(&request.name, "피어 이름")?.to_owned();
    let url = validate_peer_url(&request.url)?;
    let note = validate_note(&request.note)?.to_owned();
    let store = STORE.update(app_data_dir, |store: &mut AiaPeerStore| {
        let now = now_ms();
        match existing_id.as_deref() {
            Some(id) => {
                if store
                    .peers
                    .iter()
                    .any(|peer| peer.id != id && peer.url.eq_ignore_ascii_case(&url))
                {
                    return Err(CoreError::Conflict(
                        "같은 주소의 피어가 이미 있습니다".to_owned(),
                    ));
                }
                let record = store
                    .peers
                    .iter_mut()
                    .find(|peer| peer.id == id)
                    .ok_or_else(|| CoreError::NotFound(format!("피어 {id}를 찾지 못했습니다")))?;
                record.name = name.clone();
                if !record.url.eq_ignore_ascii_case(&url) {
                    // 주소가 바뀌면 다른 기기일 수 있다 — 스킬 변경 표시는 처음부터 다시 센다.
                    record.skills_revision_seen = None;
                    record.skills_revision_latest = None;
                }
                record.url = url.clone();
                record.note = note.clone();
                if let Some(enabled) = request.agent_enabled {
                    record.agent_enabled = enabled;
                }
                record.updated_at = now;
            }
            None => {
                if store.peers.len() >= MAX_PEERS {
                    return Err(CoreError::InvalidInput(format!(
                        "피어는 {MAX_PEERS}대까지 등록할 수 있습니다"
                    )));
                }
                if store
                    .peers
                    .iter()
                    .any(|peer| peer.url.eq_ignore_ascii_case(&url))
                {
                    return Err(CoreError::Conflict(
                        "같은 주소의 피어가 이미 있습니다".to_owned(),
                    ));
                }
                store.peers.push(AiaPeerRecord {
                    id: new_id(),
                    name: name.clone(),
                    url: url.clone(),
                    agent_enabled: request.agent_enabled.unwrap_or(true),
                    note: note.clone(),
                    updated_at: now,
                    skills_revision_seen: None,
                    skills_revision_latest: None,
                });
            }
        }
        Ok(true)
    })?;
    snapshot_of(app_data_dir, &store, tailscale_host)
}

pub fn remove_aia_peer(
    app_data_dir: &Path,
    tailscale_host: Option<&str>,
    request: AiaPeerRef,
) -> Result<AiaPeersSnapshot, CoreError> {
    let id = validate_peer_id(&request.id)?.to_owned();
    let store = STORE.update(app_data_dir, |store: &mut AiaPeerStore| {
        let before = store.peers.len();
        store.peers.retain(|peer| peer.id != id);
        if store.peers.len() == before {
            return Err(CoreError::NotFound(format!("피어 {id}를 찾지 못했습니다")));
        }
        // 출처 장부는 남긴다 — 가져온 스킬은 그대로 있고, 어디서 왔는지는 여전히 사실이다.
        Ok(true)
    })?;
    snapshot_of(app_data_dir, &store, tailscale_host)
}

pub fn set_aia_peer_agent_enabled(
    app_data_dir: &Path,
    tailscale_host: Option<&str>,
    request: SetAiaPeerAgentEnabledRequest,
) -> Result<AiaPeersSnapshot, CoreError> {
    let id = validate_peer_id(&request.id)?.to_owned();
    let store = STORE.update(app_data_dir, |store: &mut AiaPeerStore| {
        let record = store
            .peers
            .iter_mut()
            .find(|peer| peer.id == id)
            .ok_or_else(|| CoreError::NotFound(format!("피어 {id}를 찾지 못했습니다")))?;
        if record.agent_enabled == request.enabled {
            return Ok(false);
        }
        record.agent_enabled = request.enabled;
        record.updated_at = now_ms();
        Ok(true)
    })?;
    snapshot_of(app_data_dir, &store, tailscale_host)
}

/// 저장된 피어 한 대. 화면 경로가 쓴다 — 에이전트 사용 토글은 보지 않는다.
pub(crate) fn peer_of(app_data_dir: &Path, id: &str) -> Result<AiaPeerRecord, CoreError> {
    let id = validate_peer_id(id)?;
    let store: AiaPeerStore = STORE.read(app_data_dir)?;
    store
        .peers
        .into_iter()
        .find(|peer| peer.id == id)
        .ok_or_else(|| CoreError::NotFound(format!("피어 {id}를 찾지 못했습니다")))
}

/// 에이전트 실행 경로가 쓰는 피어. 기능이 꺼져 있거나 그 피어의 에이전트 사용이 꺼져 있으면
/// 이름을 알아도 쓰지 못한다.
pub(crate) fn agent_peer_of(app_data_dir: &Path, id: &str) -> Result<AiaPeerRecord, CoreError> {
    let store: AiaPeerStore = STORE.read(app_data_dir)?;
    if !store.policy.enabled {
        return Err(disabled_error());
    }
    let id = validate_peer_id(id)?;
    let record = store
        .peers
        .into_iter()
        .find(|peer| peer.id == id)
        .ok_or_else(|| CoreError::NotFound(format!("피어 {id}를 찾지 못했습니다")))?;
    if !record.agent_enabled {
        return Err(CoreError::InvalidInput(format!(
            "{} 피어는 에이전트 사용이 꺼져 있습니다. 애드온 → AIA 대화에서 켜야 합니다",
            record.name
        )));
    }
    Ok(record)
}

pub(crate) fn disabled_error() -> CoreError {
    CoreError::InvalidInput(
        "AIA 대화 기능이 꺼져 있습니다. 애드온 → AIA 대화(show_ui_guide target addons.peers)에서 사용자가 켜야 합니다"
            .to_owned(),
    )
}

pub fn list_agent_aia_peers(
    app_data_dir: &Path,
    tailscale_host: Option<&str>,
) -> Result<AgentAiaPeersView, CoreError> {
    let store: AiaPeerStore = STORE.read(app_data_dir)?;
    let device = device_identity_of(app_data_dir, &store.policy, tailscale_host)?;
    let enabled = store.policy.enabled;
    let mut peers = Vec::new();
    let mut skipped = Vec::new();
    for record in &store.peers {
        if !enabled {
            skipped.push(AgentAiaPeerSkip {
                id: record.id.clone(),
                name: record.name.clone(),
                reason: "AIA 대화 기능이 꺼져 있습니다".to_owned(),
            });
            continue;
        }
        if !record.agent_enabled {
            skipped.push(AgentAiaPeerSkip {
                id: record.id.clone(),
                name: record.name.clone(),
                reason: "에이전트 사용이 꺼져 있습니다".to_owned(),
            });
            continue;
        }
        peers.push(AgentAiaPeerView {
            id: record.id.clone(),
            name: record.name.clone(),
            url: record.url.clone(),
            note: record.note.clone(),
            skills_changed: skills_changed(record),
        });
    }
    let local = if !enabled {
        AgentLocalPeer {
            available: false,
            reason: "AIA 대화 기능이 꺼져 있습니다".to_owned(),
        }
    } else if !store.policy.allow_local {
        AgentLocalPeer {
            available: false,
            reason: "같은 기기 AIA에게 묻기(allowLocal)가 꺼져 있습니다".to_owned(),
        }
    } else {
        AgentLocalPeer {
            available: true,
            reason: String::new(),
        }
    };
    Ok(AgentAiaPeersView {
        schema_version: STORE_VERSION,
        enabled,
        device,
        local,
        peers,
        skipped,
        issues: Vec::new(),
    })
}

/// 교환 응답이 실어 온 피어의 스킬 목록 지문을 적어 둔다. 바뀌었을 때만 쓴다.
pub(crate) fn note_peer_skills_revision(
    app_data_dir: &Path,
    peer_id: &str,
    revision: &str,
) -> Result<(), CoreError> {
    if peer_id == LOCAL_PEER_ID || !is_peer_identifier(revision) {
        return Ok(());
    }
    STORE.update(app_data_dir, |store: &mut AiaPeerStore| {
        let Some(record) = store.peers.iter_mut().find(|peer| peer.id == peer_id) else {
            return Ok(false);
        };
        if record.skills_revision_latest.as_deref() == Some(revision) {
            return Ok(false);
        }
        record.skills_revision_latest = Some(revision.to_owned());
        Ok(true)
    })?;
    Ok(())
}

/// 스킬 목록을 실제로 봤다. 본 값이 곧 최신값이므로 둘을 같이 맞춘다.
pub(crate) fn mark_peer_skills_seen(
    app_data_dir: &Path,
    peer_id: &str,
    revision: &str,
) -> Result<(), CoreError> {
    if peer_id == LOCAL_PEER_ID || !is_peer_identifier(revision) {
        return Ok(());
    }
    STORE.update(app_data_dir, |store: &mut AiaPeerStore| {
        let Some(record) = store.peers.iter_mut().find(|peer| peer.id == peer_id) else {
            return Ok(false);
        };
        let changed = record.skills_revision_seen.as_deref() != Some(revision)
            || record.skills_revision_latest.as_deref() != Some(revision);
        record.skills_revision_seen = Some(revision.to_owned());
        record.skills_revision_latest = Some(revision.to_owned());
        Ok(changed)
    })?;
    Ok(())
}

// ---------------------------------------------------------------------------
// 검증
// ---------------------------------------------------------------------------

/// 상대 기기가 보낸 식별자(교환 id, 스킬 목록 지문)의 상한. 우리가 내는 값은 `xchg-` 뒤
/// 12자와 64자 16진 지문이라 넉넉하다.
pub(crate) const MAX_PEER_IDENTIFIER_CHARS: usize = 64;

/// 상대 기기가 보낸 식별자가 URL 경로 조각과 장부에 그대로 들어가도 되는 모양인지 본다.
/// 교환 id 는 상태 조회 URL 의 마지막 조각이 되고, 스킬 목록 지문은 피어 행에 저장된다 —
/// 둘 다 상대가 지은 값이라 `..`·`?`·`#`·공백이나 끝없는 길이를 여기서 끊는다.
pub(crate) fn is_peer_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_PEER_IDENTIFIER_CHARS
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

fn new_id() -> String {
    format!(
        "{PEER_ID_PREFIX}{}",
        &uuid::Uuid::new_v4().simple().to_string()[..12]
    )
}

pub(crate) fn validate_peer_id(value: &str) -> Result<&str, CoreError> {
    let value = value.trim();
    let valid = value.starts_with(PEER_ID_PREFIX)
        && value.len() > PEER_ID_PREFIX.len()
        && value.len() <= MAX_ID_CHARS
        && value.chars().all(|character| {
            character.is_ascii_lowercase() || character.is_ascii_digit() || character == '-'
        });
    if !valid {
        return Err(CoreError::InvalidInput(format!(
            "피어 ID 형식이 아닙니다: {value}"
        )));
    }
    Ok(value)
}

fn validate_name<'a>(value: &'a str, label: &str) -> Result<&'a str, CoreError> {
    let value = value.trim();
    if value.is_empty()
        || value.chars().count() > MAX_NAME_CHARS
        || value.chars().any(|character| character.is_control())
    {
        return Err(CoreError::InvalidInput(format!(
            "{label}은 제어문자 없이 1~{MAX_NAME_CHARS}자여야 합니다"
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

/// 피어 주소. 테일넷 HTTPS 주소(`https://<기기>.<테일넷>.ts.net`)가 보통이고, 평문 http 는
/// 같은 기기 주소에만 받는다 — 시험용 두 번째 백엔드를 다른 포트에 띄울 때다. 계정 정보·
/// 질의·조각은 받지 않는다(E3).
pub(crate) fn validate_peer_url(value: &str) -> Result<String, CoreError> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.chars().count() > MAX_URL_CHARS {
        return Err(CoreError::InvalidInput(format!(
            "피어 주소는 1~{MAX_URL_CHARS}자여야 합니다"
        )));
    }
    let url = reqwest::Url::parse(trimmed)
        .map_err(|_| CoreError::InvalidInput("피어 주소가 URL이 아닙니다".to_owned()))?;
    if !url.username().is_empty() || url.password().is_some() {
        return Err(CoreError::InvalidInput(
            "피어 주소에 계정 정보를 넣지 마세요".to_owned(),
        ));
    }
    if url.query().is_some() || url.fragment().is_some() {
        return Err(CoreError::InvalidInput(
            "피어 주소에는 질의 문자열을 붙이지 않습니다".to_owned(),
        ));
    }
    let host = url
        .host_str()
        .ok_or_else(|| CoreError::InvalidInput("피어 주소에 호스트가 없습니다".to_owned()))?;
    match url.scheme() {
        "https" => {}
        "http" if matches!(host, "127.0.0.1" | "localhost" | "[::1]") => {}
        "http" => {
            return Err(CoreError::InvalidInput(
                "평문 http 는 같은 기기(127.0.0.1) 주소에만 씁니다. https 주소를 넣으세요"
                    .to_owned(),
            ))
        }
        other => {
            return Err(CoreError::InvalidInput(format!(
                "지원하지 않는 주소 형식입니다: {other}"
            )))
        }
    }
    if url.path() != "/" && !url.path().is_empty() {
        return Err(CoreError::InvalidInput(
            "피어 주소는 경로 없이 기기 주소만 적습니다".to_owned(),
        ));
    }
    Ok(trimmed.trim_end_matches('/').to_owned())
}

// ---------------------------------------------------------------------------
// 스킬 목록·묶음·출처 장부
// ---------------------------------------------------------------------------

/// 피어에 보여 주는 스킬 한 줄. 지문은 경로·본문만으로 낸 전송 지문이다.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PeerSkillSummary {
    pub key: String,
    pub name: String,
    pub description: String,
    pub transfer_digest: String,
    pub file_count: usize,
    pub total_bytes: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PeerSkillListing {
    pub protocol_version: u32,
    /// 목록 전체의 지문. 키와 전송 지문을 정렬해 묶은 값이라 어느 스킬이든 바뀌면 달라진다.
    pub revision: String,
    pub skills: Vec<PeerSkillSummary>,
    /// 텍스트가 아닌 파일이 있어 보낼 수 없는 스킬의 키와 사유.
    pub unavailable: Vec<PeerSkillUnavailable>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PeerSkillUnavailable {
    pub key: String,
    pub reason: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PeerSkillFile {
    pub path: String,
    pub content: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PeerSkillBundle {
    pub protocol_version: u32,
    pub key: String,
    pub name: String,
    pub description: String,
    pub transfer_digest: String,
    pub files: Vec<PeerSkillFile>,
}

/// 내 사본과 피어 사본의 관계. 화면과 AIA가 같은 값을 본다.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum PeerSkillState {
    /// 내 저장소에 없다.
    Absent,
    /// 내 사본과 피어 사본이 같다.
    Same,
    /// 이 피어에서 가져온 뒤 피어 쪽만 바뀌었다 — 그대로 갱신할 수 있다.
    PeerNewer,
    /// 이 피어에서 가져온 뒤 내 쪽만 바뀌었다 — 덮어쓰기를 명시해야 바꾼다.
    LocalModified,
    /// 양쪽 다 바뀌었다 — 덮어쓰기를 명시해야 바꾼다.
    BothChanged,
    /// 같은 키가 있지만 이 피어에서 가져온 기록이 없다 — 다른 출처의 스킬이다.
    Different,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PeerSkillView {
    pub key: String,
    pub name: String,
    pub description: String,
    pub transfer_digest: String,
    pub file_count: usize,
    pub total_bytes: u64,
    pub state: PeerSkillState,
    pub local_digest: Option<String>,
    pub imported_at: Option<i64>,
}

/// 경로·본문만으로 내는 전송 지문. 보내는 쪽과 받는 쪽이 같은 함수로 내므로 실행 비트나
/// 수정 시각 때문에 같은 내용이 다르게 보이지 않는다.
pub fn transfer_digest(files: &[PeerSkillFile]) -> String {
    let mut sorted: Vec<&PeerSkillFile> = files.iter().collect();
    sorted.sort_by(|left, right| left.path.cmp(&right.path));
    let mut hasher = Sha256::new();
    for file in sorted {
        hasher.update(file.path.as_bytes());
        hasher.update([0]);
        hasher.update(file.content.len().to_le_bytes());
        hasher.update(file.content.as_bytes());
    }
    crate::identifier::lower_hex(&hasher.finalize())
}

fn listing_revision(skills: &[PeerSkillSummary]) -> String {
    let mut hasher = Sha256::new();
    for skill in skills {
        hasher.update(skill.key.as_bytes());
        hasher.update([0]);
        hasher.update(skill.transfer_digest.as_bytes());
        hasher.update([0]);
    }
    crate::identifier::lower_hex(&hasher.finalize())
}

fn bundle_files(files: Vec<ExportedSkillFile>) -> Vec<PeerSkillFile> {
    files
        .into_iter()
        .map(|file| PeerSkillFile {
            path: file.path,
            content: file.content,
        })
        .collect()
}

/// 이 기기의 공통 스킬 목록을 피어에 보여 주는 모양으로 낸다. 읽지 못하는 스킬은 사유와
/// 함께 `unavailable`에 두고 목록에서 뺀다 — 목록 지문도 보낼 수 있는 것만으로 낸다.
pub fn local_skill_listing(app_data_dir: &Path) -> Result<PeerSkillListing, CoreError> {
    let digests = crate::skill_library::load_common_skill_digests(app_data_dir)?;
    let mut skills = Vec::new();
    let mut unavailable = Vec::new();
    for digest in digests {
        match local_skill_bundle(app_data_dir, &digest.key) {
            Ok(bundle) => skills.push(PeerSkillSummary {
                key: bundle.key,
                name: bundle.name,
                description: bundle.description,
                transfer_digest: bundle.transfer_digest,
                file_count: bundle.files.len(),
                total_bytes: bundle
                    .files
                    .iter()
                    .map(|file| file.content.len() as u64)
                    .sum(),
            }),
            Err(error) => unavailable.push(PeerSkillUnavailable {
                key: digest.key,
                reason: error.to_string(),
            }),
        }
    }
    skills.sort_by(|left, right| left.key.cmp(&right.key));
    let revision = listing_revision(&skills);
    Ok(PeerSkillListing {
        protocol_version: PEER_PROTOCOL_VERSION,
        revision,
        skills,
        unavailable,
    })
}

pub fn local_skill_bundle(app_data_dir: &Path, key: &str) -> Result<PeerSkillBundle, CoreError> {
    let (source, files) = export_common_skill_files(app_data_dir, key)?;
    let files = bundle_files(files);
    let transfer_digest = transfer_digest(&files);
    Ok(PeerSkillBundle {
        protocol_version: PEER_PROTOCOL_VERSION,
        key: source.key,
        name: source.name,
        description: source.description,
        transfer_digest,
        files,
    })
}

/// 내 사본의 전송 지문. 없으면 `None`, 텍스트가 아닌 파일이 섞여 있으면 비교할 수 없으므로
/// 오류를 돌린다.
fn local_transfer_digest(app_data_dir: &Path, key: &str) -> Result<Option<String>, CoreError> {
    match local_skill_bundle(app_data_dir, key) {
        Ok(bundle) => Ok(Some(bundle.transfer_digest)),
        Err(CoreError::NotFound(_)) => Ok(None),
        Err(error) => Err(error),
    }
}

/// 피어 목록 한 줄의 상태. 장부는 (스킬 키, 피어) 한 쌍에 한 줄이다.
pub(crate) fn skill_state(
    peer_digest: &str,
    local_digest: Option<&str>,
    import: Option<&PeerSkillImport>,
) -> PeerSkillState {
    let Some(local_digest) = local_digest else {
        return PeerSkillState::Absent;
    };
    if local_digest == peer_digest {
        return PeerSkillState::Same;
    }
    let Some(import) = import else {
        return PeerSkillState::Different;
    };
    let peer_changed = import.peer_digest != peer_digest;
    let local_changed = import.local_digest != local_digest;
    match (peer_changed, local_changed) {
        (true, false) => PeerSkillState::PeerNewer,
        (false, true) => PeerSkillState::LocalModified,
        (true, true) => PeerSkillState::BothChanged,
        (false, false) => PeerSkillState::Different,
    }
}

/// 피어가 보낸 목록에 내 사본과 장부를 대어 상태를 붙인다. 같은 피어의 가져오기 기록만 본다.
pub(crate) fn annotate_peer_skills(
    app_data_dir: &Path,
    peer_id: &str,
    listing: &PeerSkillListing,
) -> Result<Vec<PeerSkillView>, CoreError> {
    let store: AiaPeerStore = STORE.read(app_data_dir)?;
    let imports: BTreeMap<&str, &PeerSkillImport> = store
        .imports
        .iter()
        .filter(|import| import.peer_id == peer_id)
        .map(|import| (import.key.as_str(), import))
        .collect();
    let mut views = Vec::with_capacity(listing.skills.len());
    for skill in &listing.skills {
        let local_digest = match local_transfer_digest(app_data_dir, &skill.key) {
            Ok(value) => value,
            // 비교할 수 없는 내 사본은 "다름"으로 두고 사유는 가져오기 때 다시 선다.
            Err(_) => Some(String::from("(비교 불가)")),
        };
        let import = imports.get(skill.key.as_str()).copied();
        views.push(PeerSkillView {
            key: skill.key.clone(),
            name: skill.name.clone(),
            description: skill.description.clone(),
            transfer_digest: skill.transfer_digest.clone(),
            file_count: skill.file_count,
            total_bytes: skill.total_bytes,
            state: skill_state(&skill.transfer_digest, local_digest.as_deref(), import),
            local_digest,
            imported_at: import.map(|import| import.imported_at),
        });
    }
    Ok(views)
}

/// 가져오기 전에 덮어써도 되는지 판정한다. `overwrite`가 없으면 내 사본이 그대로일 때만 쓴다.
pub(crate) fn import_allowed(
    app_data_dir: &Path,
    peer_id: &str,
    key: &str,
    peer_digest: &str,
    overwrite: bool,
) -> Result<(PeerSkillState, Option<String>), CoreError> {
    let store: AiaPeerStore = STORE.read(app_data_dir)?;
    let import = store
        .imports
        .iter()
        .find(|import| import.peer_id == peer_id && import.key == key);
    let local_digest = local_transfer_digest(app_data_dir, key)?;
    let state = skill_state(peer_digest, local_digest.as_deref(), import);
    let allowed = match state {
        PeerSkillState::Absent | PeerSkillState::PeerNewer => true,
        PeerSkillState::Same => false,
        PeerSkillState::LocalModified | PeerSkillState::BothChanged | PeerSkillState::Different => {
            overwrite
        }
    };
    if state == PeerSkillState::Same {
        return Err(CoreError::Conflict(format!(
            "'{key}' 스킬은 피어와 같은 내용이라 가져올 것이 없습니다"
        )));
    }
    if !allowed {
        return Err(CoreError::Conflict(format!(
            "'{key}' 스킬의 내 사본이 피어 사본과 다릅니다({}). 덮어쓰려면 overwrite=true 를 주세요",
            state_label(state)
        )));
    }
    Ok((state, local_digest))
}

pub(crate) fn state_label(state: PeerSkillState) -> &'static str {
    match state {
        PeerSkillState::Absent => "없음",
        PeerSkillState::Same => "같음",
        PeerSkillState::PeerNewer => "피어가 새로움",
        PeerSkillState::LocalModified => "내가 고침",
        PeerSkillState::BothChanged => "둘 다 바뀜",
        PeerSkillState::Different => "다른 출처",
    }
}

/// 가져오기가 끝난 뒤 출처 장부에 적는다. 같은 (키, 피어)는 한 줄로 갱신한다.
pub(crate) fn record_skill_import(
    app_data_dir: &Path,
    peer_id: &str,
    key: &str,
    peer_digest: &str,
    local_digest: &str,
) -> Result<(), CoreError> {
    STORE.update(app_data_dir, |store: &mut AiaPeerStore| {
        store
            .imports
            .retain(|import| !(import.peer_id == peer_id && import.key == key));
        store.imports.push(PeerSkillImport {
            key: key.to_owned(),
            peer_id: peer_id.to_owned(),
            peer_digest: peer_digest.to_owned(),
            local_digest: local_digest.to_owned(),
            imported_at: now_ms(),
        });
        if store.imports.len() > MAX_IMPORT_RECORDS {
            let excess = store.imports.len() - MAX_IMPORT_RECORDS;
            store.imports.drain(..excess);
        }
        Ok(true)
    })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn app_data() -> tempfile::TempDir {
        tempfile::tempdir().expect("tempdir")
    }

    #[test]
    fn c23_1_policy_defaults_are_closed_and_bounds_are_enforced() {
        let policy = AiaPeerPolicy::default();
        assert!(!policy.enabled);
        assert!(!policy.allow_local);
        assert!(validate_policy(&policy).is_ok());
        let wide = AiaPeerPolicy {
            max_depth: MAX_MAX_DEPTH + 1,
            ..AiaPeerPolicy::default()
        };
        assert!(matches!(
            validate_policy(&wide),
            Err(CoreError::InvalidInput(_))
        ));
        let slow = AiaPeerPolicy {
            timeout_ms: MAX_TIMEOUT_MS + 1,
            ..AiaPeerPolicy::default()
        };
        assert!(matches!(
            validate_policy(&slow),
            Err(CoreError::InvalidInput(_))
        ));
    }

    #[test]
    fn c23_1_peer_url_accepts_tailnet_https_and_refuses_credentials_paths_and_plain_http() {
        assert_eq!(
            validate_peer_url(" https://nas.tail1234.ts.net/ ").unwrap(),
            "https://nas.tail1234.ts.net"
        );
        assert_eq!(
            validate_peer_url("http://127.0.0.1:54999").unwrap(),
            "http://127.0.0.1:54999"
        );
        for bad in [
            "http://nas.tail1234.ts.net",
            "https://user:pw@nas.tail1234.ts.net",
            "https://nas.tail1234.ts.net/api",
            "https://nas.tail1234.ts.net/?x=1",
            "ftp://nas",
            "nas.tail1234.ts.net",
            "",
        ] {
            assert!(validate_peer_url(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn c23_6_peer_sent_revisions_reach_the_store_only_in_identifier_shape() {
        let dir = app_data();
        let snapshot = set_aia_peer(
            dir.path(),
            None,
            SetAiaPeerRequest {
                id: None,
                name: "NAS".to_owned(),
                url: "https://nas.tail1234.ts.net".to_owned(),
                note: String::new(),
                agent_enabled: None,
            },
        )
        .expect("save");
        let id = snapshot.peers[0].id.clone();
        let revision_of = |dir: &Path| {
            let store: AiaPeerStore = STORE.read(dir).expect("store");
            let record = store
                .peers
                .into_iter()
                .find(|peer| peer.id == id)
                .expect("peer");
            (record.skills_revision_latest, record.skills_revision_seen)
        };
        let long = "a".repeat(MAX_PEER_IDENTIFIER_CHARS + 1);
        for bad in ["", "rev 1", "../x", "a?b=c", "r#1", long.as_str()] {
            assert!(!is_peer_identifier(bad), "{bad:?}");
            note_peer_skills_revision(dir.path(), &id, bad).expect("note");
            mark_peer_skills_seen(dir.path(), &id, bad).expect("seen");
            assert_eq!(revision_of(dir.path()), (None, None), "{bad:?}");
        }
        // 우리가 내는 값 — 64자 16진 목록 지문과 꽉 찬 길이 — 은 늘 통과해야 한다.
        assert!(is_peer_identifier(&listing_revision(&[])));
        assert!(is_peer_identifier(&"a".repeat(MAX_PEER_IDENTIFIER_CHARS)));
        let good = "0123456789abcdef_ok-1";
        assert!(is_peer_identifier(good));
        note_peer_skills_revision(dir.path(), &id, good).expect("note");
        assert_eq!(revision_of(dir.path()), (Some(good.to_owned()), None));
        mark_peer_skills_seen(dir.path(), &id, good).expect("seen");
        assert_eq!(
            revision_of(dir.path()),
            (Some(good.to_owned()), Some(good.to_owned()))
        );
    }

    #[test]
    fn c23_1_peer_rows_are_saved_without_secrets_and_duplicate_addresses_are_refused() {
        let dir = app_data();
        let snapshot = set_aia_peer(
            dir.path(),
            None,
            SetAiaPeerRequest {
                id: None,
                name: "NAS".to_owned(),
                url: "https://nas.tail1234.ts.net".to_owned(),
                note: "집".to_owned(),
                agent_enabled: None,
            },
        )
        .expect("save");
        assert_eq!(snapshot.peers.len(), 1);
        assert!(snapshot.peers[0].agent_enabled);
        assert!(snapshot.peers[0].id.starts_with(PEER_ID_PREFIX));
        let duplicate = set_aia_peer(
            dir.path(),
            None,
            SetAiaPeerRequest {
                id: None,
                name: "NAS2".to_owned(),
                url: "https://NAS.tail1234.ts.net/".to_owned(),
                note: String::new(),
                agent_enabled: None,
            },
        );
        assert!(matches!(duplicate, Err(CoreError::Conflict(_))));
        let raw = std::fs::read_to_string(dir.path().join("aia-peers-v1.json")).unwrap();
        assert!(!raw.contains("token"));
        let id = snapshot.peers[0].id.clone();
        let toggled = set_aia_peer_agent_enabled(
            dir.path(),
            None,
            SetAiaPeerAgentEnabledRequest {
                id: id.clone(),
                enabled: false,
            },
        )
        .unwrap();
        assert!(!toggled.peers[0].agent_enabled);
        let removed = remove_aia_peer(dir.path(), None, AiaPeerRef { id }).unwrap();
        assert!(removed.peers.is_empty());
    }

    #[test]
    fn c23_3_agent_listing_hides_peers_while_the_feature_or_their_toggle_is_off() {
        let dir = app_data();
        let snapshot = set_aia_peer(
            dir.path(),
            None,
            SetAiaPeerRequest {
                id: None,
                name: "NAS".to_owned(),
                url: "https://nas.tail1234.ts.net".to_owned(),
                note: String::new(),
                agent_enabled: Some(true),
            },
        )
        .unwrap();
        let id = snapshot.peers[0].id.clone();
        let off = list_agent_aia_peers(dir.path(), None).unwrap();
        assert!(!off.enabled);
        assert!(off.peers.is_empty());
        assert_eq!(off.skipped.len(), 1);
        assert!(!off.local.available);
        assert!(matches!(
            agent_peer_of(dir.path(), &id),
            Err(CoreError::InvalidInput(_))
        ));

        set_aia_peer_policy(
            dir.path(),
            None,
            SetAiaPeerPolicyRequest {
                enabled: Some(true),
                allow_local: Some(true),
                ..SetAiaPeerPolicyRequest::default()
            },
        )
        .unwrap();
        let on = list_agent_aia_peers(dir.path(), None).unwrap();
        assert_eq!(on.peers.len(), 1);
        assert!(on.local.available);
        assert!(agent_peer_of(dir.path(), &id).is_ok());

        set_aia_peer_agent_enabled(
            dir.path(),
            None,
            SetAiaPeerAgentEnabledRequest {
                id: id.clone(),
                enabled: false,
            },
        )
        .unwrap();
        let toggled = list_agent_aia_peers(dir.path(), None).unwrap();
        assert!(toggled.peers.is_empty());
        assert_eq!(toggled.skipped[0].reason, "에이전트 사용이 꺼져 있습니다");
    }

    #[test]
    fn c23_5_skill_state_follows_the_import_ledger() {
        let import = PeerSkillImport {
            key: "k".to_owned(),
            peer_id: "peer-1".to_owned(),
            peer_digest: "p1".to_owned(),
            local_digest: "p1".to_owned(),
            imported_at: 1,
        };
        assert_eq!(
            skill_state("p1", None, Some(&import)),
            PeerSkillState::Absent
        );
        assert_eq!(
            skill_state("p1", Some("p1"), Some(&import)),
            PeerSkillState::Same
        );
        assert_eq!(
            skill_state("p2", Some("p1"), Some(&import)),
            PeerSkillState::PeerNewer
        );
        assert_eq!(
            skill_state("p1", Some("l2"), Some(&import)),
            PeerSkillState::LocalModified
        );
        assert_eq!(
            skill_state("p2", Some("l2"), Some(&import)),
            PeerSkillState::BothChanged
        );
        assert_eq!(
            skill_state("p2", Some("l2"), None),
            PeerSkillState::Different
        );
    }

    #[test]
    fn c23_5_transfer_digest_ignores_file_order_and_tracks_content() {
        let a = vec![
            PeerSkillFile {
                path: "SKILL.md".to_owned(),
                content: "x".to_owned(),
            },
            PeerSkillFile {
                path: "b.md".to_owned(),
                content: "y".to_owned(),
            },
        ];
        let b = vec![a[1].clone(), a[0].clone()];
        assert_eq!(transfer_digest(&a), transfer_digest(&b));
        let c = vec![
            PeerSkillFile {
                path: "SKILL.md".to_owned(),
                content: "x!".to_owned(),
            },
            a[1].clone(),
        ];
        assert_ne!(transfer_digest(&a), transfer_digest(&c));
    }

    #[test]
    fn c23_5_skills_revision_badge_turns_on_when_an_exchange_reports_a_new_revision() {
        let dir = app_data();
        let snapshot = set_aia_peer(
            dir.path(),
            None,
            SetAiaPeerRequest {
                id: None,
                name: "NAS".to_owned(),
                url: "https://nas.tail1234.ts.net".to_owned(),
                note: String::new(),
                agent_enabled: None,
            },
        )
        .unwrap();
        let id = snapshot.peers[0].id.clone();
        assert!(!snapshot.peers[0].skills_changed);
        note_peer_skills_revision(dir.path(), &id, "r1").unwrap();
        assert!(get_aia_peers(dir.path(), None).unwrap().peers[0].skills_changed);
        mark_peer_skills_seen(dir.path(), &id, "r1").unwrap();
        assert!(!get_aia_peers(dir.path(), None).unwrap().peers[0].skills_changed);
        note_peer_skills_revision(dir.path(), &id, "r2").unwrap();
        assert!(get_aia_peers(dir.path(), None).unwrap().peers[0].skills_changed);
    }
}
