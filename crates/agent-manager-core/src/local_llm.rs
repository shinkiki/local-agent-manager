//! 로컬 LLM 서빙 서버 연결 한 벌. 기기 단위 설정이라 앱 데이터에만 둔다(G7).
//!
//! 이 공급자는 계정을 두지 않으므로 계정 레지스트리·자격증명 프로필 경로를 쓰지 않는다.
//! 대신 "어느 주소의 어떤 모델을 쓸 것인가" 한 벌만 저장하고, 선택 사항인 API 키는 값이
//! 아니라 **있는지 여부**만 저장본에 남긴다. 키 자체는 OS 보안 저장소에만 둔다(G4).

use std::collections::BTreeMap;
use std::path::Path;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use zeroize::Zeroizing;

use crate::json_store::{JsonStore, SchemaVersioned};
use crate::CoreError;

const STORE_VERSION: u32 = 1;
const STORE: JsonStore = JsonStore {
    file: "local-llm-connection-v1.json",
    lock_file: "local-llm-connection-v1.lock",
    label: "로컬 LLM 연결 저장소",
    version: STORE_VERSION,
};

/// API 키를 두는 OS 보안 저장소의 서비스명. 계정 볼트·데이터베이스와 같은 헬퍼를 쓰되
/// 이름공간은 나눈다.
pub(crate) const LOCAL_LLM_KEYCHAIN_SERVICE: &str = "Agent Manager Local LLM";

/// 기본 연결의 키체인 계정 이름. v1 시절 연결이 한 벌뿐일 때 쓰던 고정 이름을 그대로
/// 이어받아, 이행 뒤에도 저장된 키가 그 자리에 있다. 다른 연결은 `connection-<id>`.
const KEYCHAIN_ACCOUNT: &str = "connection";

/// 연결 목록 저장소(M7 7.1). 연결이 여러 개가 되면서 v1 단일 연결 파일은 읽기 전용
/// 씨앗으로만 남는다 — 첫 읽기에서 `default` 연결로 한 번 옮기고 v1 파일은 지우지 않는다.
const CONNECTIONS_STORE_VERSION: u32 = 2;
const CONNECTIONS_STORE: JsonStore = JsonStore {
    file: "local-llm-connections-v2.json",
    lock_file: "local-llm-connections-v2.lock",
    label: "로컬 LLM 연결 목록 저장소",
    version: CONNECTIONS_STORE_VERSION,
};

/// v1 단일 연결이 옮겨 가는 연결 id. 연결 id 를 적지 않은 옛 저장물(채팅·반복요청)은
/// 전부 이 연결로 읽힌다.
pub const DEFAULT_CONNECTION_ID: &str = "default";
const MAX_CONNECTION_ID_CHARS: usize = 32;
const MAX_CONNECTION_LABEL_CHARS: usize = 80;
const MAX_CONNECTIONS: usize = 16;

/// 서빙 서버는 첫 응답까지 모델을 올리느라 시간이 걸릴 수 있지만, 목록 조회는 그 전에
/// 답하는 가벼운 요청이라 짧게 끊는다.
const PROBE_TIMEOUT: Duration = Duration::from_secs(5);

const MAX_BASE_URL_CHARS: usize = 512;
const MAX_MODEL_CHARS: usize = 200;
/// 화면 목록에 그대로 올라가는 값이라 서버가 아무리 많이 돌려줘도 여기서 끊는다.
const MAX_PROBE_MODELS: usize = 200;
const MIN_CONTEXT_WINDOW: u32 = 1_024;
const MAX_CONTEXT_WINDOW: u32 = 10_000_000;

/// 저장된 연결 한 벌. 화면과 실행 경로가 같은 값을 본다.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalLlmConnection {
    /// OpenAI 호환 API의 기준 주소. 끝의 `/`는 떼고 저장한다.
    pub base_url: String,
    /// 새 채팅이 모델을 고르지 않았을 때 쓸 값.
    pub default_model: String,
    /// 서버가 알려 주지 않는 컨텍스트 크기를 사람이 적어 둔 값.
    pub context_window: Option<u32>,
    /// 키가 저장돼 있는지만 알린다. 값은 어떤 응답에도 실리지 않는다(G4).
    pub api_key_configured: bool,
    pub enabled: bool,
}

/// 화면이 보내는 저장 요청.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetLocalLlmConnectionRequest {
    pub base_url: String,
    pub default_model: String,
    pub context_window: Option<u32>,
    pub enabled: bool,
    /// `None`이면 저장된 키를 그대로 두고, 빈 문자열이면 지우며, 값이 있으면 바꾼다.
    /// 화면이 키를 다시 받지 않고도 주소만 고칠 수 있어야 하므로 세 갈래가 필요하다.
    pub api_key: Option<String>,
}

/// 주소 하나를 실제로 찔러 본 결과. 실패도 값으로 돌려준다 — 연결 카드는 "왜 안 되는지"를
/// 보여 줘야 하고, 오류로 올리면 그 사유가 화면까지 오지 않는다.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalLlmProbeResult {
    pub reachable: bool,
    pub models: Vec<String>,
    /// 응답의 `Server` 헤더. 어떤 서빙 소프트웨어인지 가늠하는 힌트다.
    pub server: Option<String>,
    pub error: Option<String>,
}

/// 목록에 든 연결 하나. `connection` 의 칸들이 그대로 펼쳐져 화면과 실행 경로가 v1 과 같은
/// 이름으로 읽는다.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalLlmConnectionEntry {
    pub id: String,
    /// 사람이 알아보는 이름("이 기계 ollama", "맥북 ollama").
    pub label: String,
    #[serde(flatten)]
    pub connection: LocalLlmConnection,
    /// 모델별 컨텍스트 크기. 없으면 `connection.context_window`, 그것도 없으면 서버에 묻는다.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub model_windows: BTreeMap<String, u32>,
}

impl LocalLlmConnectionEntry {
    /// 이 연결에서 그 모델의 창 크기. 모델별 값 → 연결 값 순이고, 둘 다 없으면 `None`이라
    /// 호출자가 서버에 묻는다(M7 7.2).
    pub fn context_window_for(&self, model: &str) -> Option<u32> {
        self.model_windows
            .get(model)
            .copied()
            .or(self.connection.context_window)
    }
}

/// 화면이 받는 목록 전체.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalLlmConnections {
    pub default_id: String,
    pub connections: Vec<LocalLlmConnectionEntry>,
}

/// 연결 추가·편집 요청. `id` 가 없으면 새 연결이고 id 는 라벨에서 만든다.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpsertLocalLlmConnectionRequest {
    #[serde(default)]
    pub id: Option<String>,
    pub label: String,
    pub base_url: String,
    pub default_model: String,
    pub context_window: Option<u32>,
    #[serde(default)]
    pub model_windows: Option<BTreeMap<String, u32>>,
    pub enabled: bool,
    /// `None`이면 저장된 키를 그대로 두고, 빈 문자열이면 지우며, 값이 있으면 바꾼다.
    pub api_key: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalLlmConnectionIdRequest {
    pub id: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalLlmConnectionsStore {
    schema_version: u32,
    /// v1 단일 연결을 옮겼는지. 한 번만 옮긴다 — 사용자가 뒤에 목록을 비우거나 바꿔도
    /// 다시 씨앗을 심지 않는다.
    #[serde(default)]
    migrated: bool,
    #[serde(default)]
    default_id: String,
    #[serde(default)]
    connections: Vec<LocalLlmConnectionEntry>,
}

impl Default for LocalLlmConnectionsStore {
    fn default() -> Self {
        Self {
            schema_version: CONNECTIONS_STORE_VERSION,
            migrated: false,
            default_id: String::new(),
            connections: Vec::new(),
        }
    }
}

impl SchemaVersioned for LocalLlmConnectionsStore {
    fn schema_version(&self) -> u32 {
        self.schema_version
    }
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalLlmStore {
    schema_version: u32,
    #[serde(default)]
    connection: LocalLlmConnection,
}

impl Default for LocalLlmStore {
    fn default() -> Self {
        Self {
            schema_version: STORE_VERSION,
            connection: LocalLlmConnection::default(),
        }
    }
}

impl SchemaVersioned for LocalLlmStore {
    fn schema_version(&self) -> u32 {
        self.schema_version
    }
}

/// 기준 주소를 정규화한다. 자격증명이 박힌 URL과 query·fragment는 거절한다 — 그런 값은
/// 로그·오류 문구를 타고 흘러나가고 이 자리에서 필요하지도 않다(G4·E3).
///
/// `https`를 요구하지는 않는다. Ollama를 비롯한 서빙 서버는 TLS 없이 사설망에 뜨는 것이
/// 보통이고, 이 주소는 사용자가 자기 기기·자기 망을 가리켜 직접 적는 값이다.
fn normalize_base_url(input: &str) -> Result<String, CoreError> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err(CoreError::InvalidInput(
            "로컬 LLM 서버 주소를 입력하세요".to_owned(),
        ));
    }
    if trimmed.chars().count() > MAX_BASE_URL_CHARS {
        return Err(CoreError::InvalidInput(
            "로컬 LLM 서버 주소가 너무 깁니다".to_owned(),
        ));
    }
    let url = reqwest::Url::parse(trimmed)
        .map_err(|_| CoreError::InvalidInput("올바른 HTTP URL이 아닙니다".to_owned()))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(CoreError::InvalidInput(
            "로컬 LLM 서버 주소는 http 또는 https여야 합니다".to_owned(),
        ));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(CoreError::InvalidInput(
            "주소에 인증정보를 담지 마세요. API 키는 별도 칸에 입력합니다".to_owned(),
        ));
    }
    if url.query().is_some() || url.fragment().is_some() {
        return Err(CoreError::InvalidInput(
            "주소에 query나 fragment를 담을 수 없습니다".to_owned(),
        ));
    }
    if url.host_str().is_none() {
        return Err(CoreError::InvalidInput(
            "주소에 호스트가 없습니다".to_owned(),
        ));
    }
    Ok(url.as_str().trim_end_matches('/').to_owned())
}

fn normalize_model(input: &str) -> Result<String, CoreError> {
    let trimmed = input.trim();
    if trimmed.chars().count() > MAX_MODEL_CHARS {
        return Err(CoreError::InvalidInput(
            "모델 이름이 너무 깁니다".to_owned(),
        ));
    }
    Ok(trimmed.to_owned())
}

fn normalize_context_window(value: Option<u32>) -> Result<Option<u32>, CoreError> {
    match value {
        None | Some(0) => Ok(None),
        Some(value) if (MIN_CONTEXT_WINDOW..=MAX_CONTEXT_WINDOW).contains(&value) => {
            Ok(Some(value))
        }
        Some(_) => Err(CoreError::InvalidInput(format!(
            "컨텍스트 크기는 {MIN_CONTEXT_WINDOW}에서 {MAX_CONTEXT_WINDOW} 사이여야 합니다"
        ))),
    }
}

/// 기본 연결 한 벌. 연결 id 를 모르는 호출자(옛 채팅 저장물·옛 화면)가 쓰는 별칭이다.
pub fn get_local_llm_connection(app_data_dir: &Path) -> Result<LocalLlmConnection, CoreError> {
    Ok(get_local_llm_connection_by_id(app_data_dir, DEFAULT_CONNECTION_ID)?.connection)
}

/// 목록을 읽는다. v2 파일이 없으면 v1 단일 연결을 `default` 로 한 번 옮겨 저장한다.
fn load_connections(app_data_dir: &Path) -> Result<LocalLlmConnectionsStore, CoreError> {
    let store: LocalLlmConnectionsStore = CONNECTIONS_STORE.read(app_data_dir)?;
    if store.migrated {
        return Ok(store);
    }
    let legacy: LocalLlmStore = STORE.read(app_data_dir)?;
    CONNECTIONS_STORE.update(app_data_dir, |store: &mut LocalLlmConnectionsStore| {
        if store.migrated {
            return Ok(false);
        }
        store.schema_version = CONNECTIONS_STORE_VERSION;
        store
            .connections
            .retain(|entry| entry.id != DEFAULT_CONNECTION_ID);
        store.connections.insert(
            0,
            LocalLlmConnectionEntry {
                id: DEFAULT_CONNECTION_ID.to_owned(),
                label: "기본 연결".to_owned(),
                connection: legacy.connection.clone(),
                model_windows: BTreeMap::new(),
            },
        );
        if store.default_id.is_empty() {
            store.default_id = DEFAULT_CONNECTION_ID.to_owned();
        }
        store.migrated = true;
        Ok(true)
    })
}

pub fn get_local_llm_connections(app_data_dir: &Path) -> Result<LocalLlmConnections, CoreError> {
    let store = load_connections(app_data_dir)?;
    Ok(LocalLlmConnections {
        default_id: store.default_id,
        connections: store.connections,
    })
}

/// `default` 는 항목 이름이기 전에 **기본 연결 포인터**다. 사용자가 기본을 다른 연결로
/// 옮기면 연결 id 를 적지 않은 채팅·반복요청·옛 화면은 그 연결을 따라가야 한다 — 글자
/// "default" 항목만 찾으면 기본을 옮긴 순간부터 그 저장물이 전부 엉뚱한 서버로 간다
/// (2026-09-27 코드리뷰).
fn resolve_id(store: &LocalLlmConnectionsStore, id: &str) -> String {
    if id == DEFAULT_CONNECTION_ID && !store.default_id.is_empty() {
        store.default_id.clone()
    } else {
        id.to_owned()
    }
}

pub fn get_local_llm_connection_by_id(
    app_data_dir: &Path,
    id: &str,
) -> Result<LocalLlmConnectionEntry, CoreError> {
    let id = normalize_connection_id(id)?;
    let store = load_connections(app_data_dir)?;
    let id = resolve_id(&store, &id);
    store
        .connections
        .into_iter()
        .find(|entry| entry.id == id)
        .ok_or_else(|| CoreError::NotFound(format!("로컬 LLM 연결 {id} 이(가) 없습니다")))
}

/// 실행이 쓸 연결 id 를 정한다. `default`·빈 값은 기본 연결 포인터로, 목록에 없는 id(지워진
/// 연결을 고른 반복요청)는 기본 연결로 돌아간다 — 연결 카드가 지울 때 그렇게 약속한다.
pub fn resolve_local_llm_connection_id(app_data_dir: &Path, id: &str) -> Result<String, CoreError> {
    let id = normalize_connection_id(id)?;
    let store = load_connections(app_data_dir)?;
    let resolved = resolve_id(&store, &id);
    if store.connections.iter().any(|entry| entry.id == resolved) {
        return Ok(resolved);
    }
    Ok(resolve_id(&store, DEFAULT_CONNECTION_ID))
}

fn keychain_account(id: &str) -> String {
    if id == DEFAULT_CONNECTION_ID {
        KEYCHAIN_ACCOUNT.to_owned()
    } else {
        format!("{KEYCHAIN_ACCOUNT}-{id}")
    }
}

/// 연결 id 는 파일·키체인 계정·OpenCode 공급자 이름에 들어가므로 소문자 슬러그만 받는다.
pub(crate) fn normalize_connection_id(input: &str) -> Result<String, CoreError> {
    let id = input.trim().to_lowercase();
    let valid = !id.is_empty()
        && id.chars().count() <= MAX_CONNECTION_ID_CHARS
        && !id.starts_with('-')
        && !id.ends_with('-')
        && id.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '-');
    if !valid {
        return Err(CoreError::InvalidInput(
            "연결 id 는 영소문자·숫자·하이픈으로 된 1~32자여야 합니다".to_owned(),
        ));
    }
    Ok(id)
}

fn normalize_label(input: &str) -> Result<String, CoreError> {
    let label = input.trim();
    if label.is_empty()
        || label.chars().count() > MAX_CONNECTION_LABEL_CHARS
        || label.chars().any(|ch| ch.is_control())
    {
        return Err(CoreError::InvalidInput(
            "연결 이름은 제어문자 없는 1~80자여야 합니다".to_owned(),
        ));
    }
    Ok(label.to_owned())
}

/// 라벨에서 id 를 만든다. 슬러그가 안 나오거나 이미 있으면 뒤에 짧은 무작위 조각을 붙인다.
fn generate_connection_id(label: &str, taken: &[String]) -> String {
    let mut slug: String = label
        .to_lowercase()
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '-' })
        .collect::<String>()
        .split('-')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("-");
    slug.truncate(20);
    let slug = slug.trim_matches('-').to_owned();
    let base = if slug.is_empty() {
        "conn".to_owned()
    } else {
        slug
    };
    if !taken.contains(&base) {
        return base;
    }
    loop {
        let suffix: String = uuid::Uuid::new_v4().simple().to_string()[..6].to_owned();
        let candidate = format!("{}-{suffix}", &base[..base.len().min(20)]);
        if !taken.contains(&candidate) {
            return candidate;
        }
    }
}

fn normalize_model_windows(
    windows: Option<BTreeMap<String, u32>>,
) -> Result<BTreeMap<String, u32>, CoreError> {
    let mut out = BTreeMap::new();
    for (model, window) in windows.unwrap_or_default() {
        let model = normalize_model(&model)?;
        if let Some(window) = normalize_context_window(Some(window))? {
            out.insert(model, window);
        }
    }
    Ok(out)
}

/// 연결을 더하거나 고친다. 키는 저장본보다 먼저 보안 저장소로 옮긴다 — 저장본의
/// `api_key_configured` 가 앞서 참이 되면 실행 경로가 없는 키를 있다고 믿는다.
pub fn upsert_local_llm_connection(
    app_data_dir: &Path,
    request: UpsertLocalLlmConnectionRequest,
) -> Result<LocalLlmConnectionEntry, CoreError> {
    let label = normalize_label(&request.label)?;
    let base_url = normalize_base_url(&request.base_url)?;
    let default_model = normalize_model(&request.default_model)?;
    let context_window = normalize_context_window(request.context_window)?;
    let model_windows = normalize_model_windows(request.model_windows)?;
    let store = load_connections(app_data_dir)?;
    let taken: Vec<String> = store
        .connections
        .iter()
        .map(|entry| entry.id.clone())
        .collect();
    let (id, previous) = match request
        .id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty())
    {
        Some(id) => {
            let id = resolve_id(&store, &normalize_connection_id(id)?);
            let previous = store
                .connections
                .iter()
                .find(|entry| entry.id == id)
                .cloned();
            (id, previous)
        }
        None => (generate_connection_id(&label, &taken), None),
    };
    if previous.is_none() && store.connections.len() >= MAX_CONNECTIONS {
        return Err(CoreError::InvalidInput(format!(
            "로컬 LLM 연결은 {MAX_CONNECTIONS}개까지 둘 수 있습니다"
        )));
    }
    let account = keychain_account(&id);
    let api_key_configured = match request.api_key.as_deref().map(str::trim) {
        None => previous
            .as_ref()
            .is_some_and(|entry| entry.connection.api_key_configured),
        Some("") => {
            crate::accounts::delete_os_keychain_password(LOCAL_LLM_KEYCHAIN_SERVICE, &account)?;
            false
        }
        Some(secret) => {
            crate::accounts::write_os_keychain_password(
                LOCAL_LLM_KEYCHAIN_SERVICE,
                &account,
                secret,
            )?;
            true
        }
    };
    let entry = LocalLlmConnectionEntry {
        id: id.clone(),
        label,
        connection: LocalLlmConnection {
            base_url,
            default_model,
            context_window,
            api_key_configured,
            enabled: request.enabled,
        },
        model_windows,
    };
    let saved = entry.clone();
    CONNECTIONS_STORE.update(app_data_dir, |store: &mut LocalLlmConnectionsStore| {
        store.schema_version = CONNECTIONS_STORE_VERSION;
        match store
            .connections
            .iter_mut()
            .find(|existing| existing.id == id)
        {
            Some(existing) => *existing = entry.clone(),
            None => store.connections.push(entry.clone()),
        }
        if store.default_id.is_empty() {
            store.default_id = id.clone();
        }
        Ok(true)
    })?;
    Ok(saved)
}

/// 연결을 지운다. 마지막 하나는 지울 수 없고, 기본 연결을 지우면 남은 첫 연결이 기본이
/// 된다. 그 연결의 키도 보안 저장소에서 지운다.
pub fn remove_local_llm_connection(
    app_data_dir: &Path,
    id: &str,
) -> Result<LocalLlmConnections, CoreError> {
    let store = load_connections(app_data_dir)?;
    let id = resolve_id(&store, &normalize_connection_id(id)?);
    if !store.connections.iter().any(|entry| entry.id == id) {
        return Err(CoreError::NotFound(format!(
            "로컬 LLM 연결 {id} 이(가) 없습니다"
        )));
    }
    if store.connections.len() <= 1 {
        return Err(CoreError::Conflict(
            "마지막 로컬 LLM 연결은 지울 수 없습니다. 대신 사용을 끄세요".to_owned(),
        ));
    }
    let store =
        CONNECTIONS_STORE.update(app_data_dir, |store: &mut LocalLlmConnectionsStore| {
            store.connections.retain(|entry| entry.id != id);
            if store.default_id == id {
                store.default_id = store
                    .connections
                    .first()
                    .map(|entry| entry.id.clone())
                    .unwrap_or_default();
            }
            Ok(true)
        })?;
    // 저장본에서 지운 뒤에 키를 지운다. 순서가 반대면 저장이 실패했을 때 항목은 남고 키만
    // 사라져, 화면은 "키 저장됨"인데 실행은 401 이 된다.
    let _ = crate::accounts::delete_os_keychain_password(
        LOCAL_LLM_KEYCHAIN_SERVICE,
        &keychain_account(&id),
    );
    Ok(LocalLlmConnections {
        default_id: store.default_id,
        connections: store.connections,
    })
}

pub fn set_default_local_llm_connection(
    app_data_dir: &Path,
    id: &str,
) -> Result<LocalLlmConnections, CoreError> {
    let store = load_connections(app_data_dir)?;
    let id = resolve_id(&store, &normalize_connection_id(id)?);
    if !store.connections.iter().any(|entry| entry.id == id) {
        return Err(CoreError::NotFound(format!(
            "로컬 LLM 연결 {id} 이(가) 없습니다"
        )));
    }
    let store =
        CONNECTIONS_STORE.update(app_data_dir, |store: &mut LocalLlmConnectionsStore| {
            store.default_id = id.clone();
            Ok(true)
        })?;
    Ok(LocalLlmConnections {
        default_id: store.default_id,
        connections: store.connections,
    })
}

/// v1 화면·원격 API 가 쓰던 단일 저장. 기본 연결에 그대로 적는다(라벨은 지킨다).
pub fn set_local_llm_connection(
    app_data_dir: &Path,
    request: SetLocalLlmConnectionRequest,
) -> Result<LocalLlmConnection, CoreError> {
    let label = get_local_llm_connection_by_id(app_data_dir, DEFAULT_CONNECTION_ID)
        .map(|entry| entry.label)
        .unwrap_or_else(|_| "기본 연결".to_owned());
    let entry = upsert_local_llm_connection(
        app_data_dir,
        UpsertLocalLlmConnectionRequest {
            id: Some(DEFAULT_CONNECTION_ID.to_owned()),
            label,
            base_url: request.base_url,
            default_model: request.default_model,
            context_window: request.context_window,
            model_windows: None,
            enabled: request.enabled,
            api_key: request.api_key,
        },
    )?;
    Ok(entry.connection)
}

/// 연결 하나의 API 키. 실행 경로가 CLI에 넘긴다. 저장본이 "있다"고 말할 때만 보안
/// 저장소를 열고, 값은 호출자가 쓰고 바로 버린다(G4).
pub(crate) fn api_key_for(
    app_data_dir: &Path,
    id: &str,
) -> Result<Option<Zeroizing<String>>, CoreError> {
    let entry = get_local_llm_connection_by_id(app_data_dir, id)?;
    if !entry.connection.api_key_configured {
        return Ok(None);
    }
    crate::accounts::read_os_keychain_password(
        LOCAL_LLM_KEYCHAIN_SERVICE,
        &keychain_account(&entry.id),
    )
}

/// `/models` 응답에서 모델 식별자만 추려 낸다.
///
/// OpenAI 호환 서버는 `{"data":[{"id":..}]}`를 돌려주지만, 같은 주소에 자기 형식
/// (`{"models":[{"id"|"name":..}]}`)을 얹는 구현도 있다. 어느 쪽이든 목록만 얻으면 되므로
/// 두 모양을 모두 읽고, 그 밖의 모양은 빈 목록으로 본다 — 여기서 오류를 올리면 "서버는
/// 떠 있는데 목록만 못 읽는" 상태가 "닿지 않음"으로 뭉개진다.
fn parse_models(body: &Value) -> Vec<String> {
    let Some(items) = body
        .get("data")
        .and_then(Value::as_array)
        .or_else(|| body.get("models").and_then(Value::as_array))
    else {
        return Vec::new();
    };
    let mut models: Vec<String> = Vec::new();
    for item in items {
        let name = item
            .get("id")
            .and_then(Value::as_str)
            .or_else(|| item.get("name").and_then(Value::as_str))
            .or_else(|| item.as_str())
            .unwrap_or_default()
            .trim();
        if name.is_empty() || name.chars().count() > MAX_MODEL_CHARS {
            continue;
        }
        if !models.iter().any(|existing| existing == name) {
            models.push(name.to_owned());
        }
        if models.len() >= MAX_PROBE_MODELS {
            break;
        }
    }
    models
}

/// 주소 하나를 확인한다. 저장본을 읽지도 쓰지도 않으므로 아직 저장하지 않은 값을
/// 화면에서 바로 시험해 볼 수 있다.
/// 이 모델이 그림을 볼 수 있는지. Ollama가 `/api/show`로 능력을 알려 준다.
///
/// 알 수 없으면 `false`다. 못 보는 모델에 그림을 보내면 턴 전체가 거절당하지만, 안 보내면
/// 첨부가 경로로 남아 도구로 읽을 수는 있다. 덜 나쁜 쪽을 고른다.
///
/// 주소는 OpenAI 호환 경로(`…/v1`)로 저장돼 있고 `/api/show`는 그 바깥이라 `/v1`을 떼고
/// 부른다. OpenAI 규격에는 능력을 알려 주는 자리가 없어 서빙 서버 고유 경로를 쓴다.
pub(crate) fn model_supports_vision(base_url: &str, model: &str) -> bool {
    let root = base_url.trim_end_matches('/');
    let root = root.strip_suffix("/v1").unwrap_or(root);
    let Ok(client) = reqwest::blocking::Client::builder()
        .timeout(PROBE_TIMEOUT)
        .build()
    else {
        return false;
    };
    let Ok(response) = client
        .post(format!("{root}/api/show"))
        .json(&serde_json::json!({ "model": model }))
        .send()
    else {
        return false;
    };
    if !response.status().is_success() {
        return false;
    }
    let Ok(body) = response.json::<Value>() else {
        return false;
    };
    body.get("capabilities")
        .and_then(Value::as_array)
        .is_some_and(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .any(|item| item.eq_ignore_ascii_case("vision"))
        })
}

/// 서버가 **실제로 서빙 중인** 창 크기. 알아내지 못하면 `None`이다.
///
/// 사람이 연결 설정에 크기를 적지 않으면 하네스가 창을 모르고, 그러면 자동 압축이 걸리지
/// 않아 창이 차는 순간부터 매 턴이 잘린다. 값을 받아올 수 있으면 받아 온다.
///
/// **아키텍처 최대가 아니라 `num_ctx` 를 본다.** 둘이 다르다 — 2026-09-26 실측에서
/// `gpt-oss-cpu-low` 는 `gptoss.context_length` 가 131,072 인데 실제로는 `num_ctx`
/// 16,384 로 돈다. 큰 쪽을 적으면 하네스가 128k 인 줄 알고 영영 압축하지 않아, 값을
/// 비워 두는 것보다 나쁘다.
pub fn served_context_window(base_url: &str, model: &str) -> Option<u32> {
    let base_url = base_url.to_owned();
    let model = model.to_owned();
    std::thread::scope(|scope| {
        scope
            .spawn(|| served_context_window_blocking(&base_url, &model))
            .join()
    })
    .ok()
    .flatten()
}

fn served_context_window_blocking(base_url: &str, model: &str) -> Option<u32> {
    // `/api/show` 는 OpenAI 호환 경로(`/v1`) 밖에 있다. Ollama 에만 있는 길이라 없으면
    // 조용히 물러난다 — 다른 서버를 쓰는 사람에게 오류를 내밀 일이 아니다.
    let root = normalize_base_url(base_url)
        .ok()?
        .trim_end_matches("/v1")
        .to_owned();
    let client = reqwest::blocking::Client::builder()
        .timeout(PROBE_TIMEOUT)
        .build()
        .ok()?;
    let response = client
        .post(format!("{root}/api/show"))
        .json(&serde_json::json!({ "model": model }))
        .send()
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    window_from_show(&response.json::<Value>().ok()?)
}

/// `/api/show` 응답에서 창 크기를 고른다. 순수 부분이라 따로 둔다.
fn window_from_show(body: &Value) -> Option<u32> {
    let served = body
        .get("parameters")
        .and_then(Value::as_str)
        .and_then(num_ctx_from_parameters);
    let architecture = body
        .get("model_info")
        .and_then(Value::as_object)
        .and_then(|info| {
            info.iter()
                .filter(|(key, _)| {
                    key.ends_with(".context_length") && !key.contains("original_context_length")
                })
                .filter_map(|(_, value)| value.as_u64())
                .max()
        })
        .and_then(|value| u32::try_from(value).ok());
    // 서빙 값이 있으면 그것이 진실이다. 없을 때만 아키텍처 값으로 물러난다.
    let chosen = served.or(architecture)?;
    normalize_context_window(Some(chosen)).ok().flatten()
}

/// `num_ctx  131072` 같은 줄에서 숫자를 뽑는다.
fn num_ctx_from_parameters(parameters: &str) -> Option<u32> {
    parameters.lines().find_map(|line| {
        let rest = line.trim().strip_prefix("num_ctx")?;
        rest.trim().parse::<u32>().ok()
    })
}

/// 서빙 서버를 한 번 두드려 본다.
///
/// 본체는 `reqwest::blocking`을 쓰는데, 그 클라이언트는 자기 tokio 런타임을 들고 있고
/// **비동기 문맥 안에서 떨어지면 패닉한다**(`Cannot drop a runtime in a context where
/// blocking is not allowed`). 로컬 채팅 기동은 `chat::start_opencode_acp`를 거쳐 서버의
/// `/api/chat` 소켓 태스크 안에서 이 함수를 그대로 부르므로, 그 패닉이 소켓 태스크를
/// 통째로 죽여 화면에는 "채팅 연결이 시작 전에 종료되었습니다"만 남았다. 그래서 본체를
/// 전용 스레드에서 돌린다 — 그쪽에는 비동기 문맥이 없어 런타임이 제자리에서 떨어진다.
pub fn probe_local_llm(base_url: &str) -> Result<LocalLlmProbeResult, CoreError> {
    let base_url = base_url.to_owned();
    std::thread::scope(|scope| scope.spawn(|| probe_local_llm_blocking(&base_url)).join())
        .map_err(|_| CoreError::Runtime("서빙 서버 점검이 중단되었습니다".to_owned()))?
}

fn probe_local_llm_blocking(base_url: &str) -> Result<LocalLlmProbeResult, CoreError> {
    let base_url = normalize_base_url(base_url)?;
    let client = reqwest::blocking::Client::builder()
        .timeout(PROBE_TIMEOUT)
        .build()
        .map_err(|error| {
            CoreError::Runtime(format!("HTTP 클라이언트를 만들지 못했습니다: {error}"))
        })?;
    let response = match client.get(format!("{base_url}/models")).send() {
        Ok(response) => response,
        Err(error) => {
            return Ok(LocalLlmProbeResult {
                error: Some(format!("서버에 연결하지 못했습니다: {error}")),
                ..LocalLlmProbeResult::default()
            })
        }
    };
    let status = response.status();
    let server = response
        .headers()
        .get(reqwest::header::SERVER)
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.chars().take(MAX_MODEL_CHARS).collect::<String>());
    if !status.is_success() {
        return Ok(LocalLlmProbeResult {
            server,
            error: Some(format!("서버가 {status}로 응답했습니다")),
            ..LocalLlmProbeResult::default()
        });
    }
    let body: Value = match response.json() {
        Ok(body) => body,
        Err(error) => {
            return Ok(LocalLlmProbeResult {
                reachable: true,
                server,
                error: Some(format!("모델 목록을 읽지 못했습니다: {error}")),
                ..LocalLlmProbeResult::default()
            })
        }
    };
    let models = parse_models(&body);
    let error = models
        .is_empty()
        .then(|| "서버가 모델을 하나도 알려 주지 않았습니다".to_owned());
    Ok(LocalLlmProbeResult {
        reachable: true,
        models,
        server,
        error,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn temp_dir() -> tempfile::TempDir {
        tempfile::Builder::new()
            .prefix("agent-manager-local-llm-")
            .tempdir()
            .expect("임시 폴더")
    }

    #[test]
    fn a_saved_connection_round_trips_through_the_store() {
        let dir = temp_dir();
        assert_eq!(
            get_local_llm_connection(dir.path()).expect("빈 저장본"),
            LocalLlmConnection::default()
        );

        let saved = set_local_llm_connection(
            dir.path(),
            SetLocalLlmConnectionRequest {
                // 끝의 `/`는 떨어지고 나머지는 그대로 남아야 한다.
                base_url: "  http://127.0.0.1:11434/v1/  ".to_owned(),
                default_model: " qwen3.5:9b ".to_owned(),
                context_window: Some(65_536),
                enabled: true,
                api_key: None,
            },
        )
        .expect("저장");

        let expected = LocalLlmConnection {
            base_url: "http://127.0.0.1:11434/v1".to_owned(),
            default_model: "qwen3.5:9b".to_owned(),
            context_window: Some(65_536),
            api_key_configured: false,
            enabled: true,
        };
        assert_eq!(saved, expected);
        assert_eq!(
            get_local_llm_connection(dir.path()).expect("다시 읽기"),
            expected
        );
    }

    #[test]
    fn a_base_url_with_credentials_or_a_query_is_rejected() {
        assert!(normalize_base_url("http://user:pw@127.0.0.1:11434/v1").is_err());
        assert!(normalize_base_url("http://127.0.0.1:11434/v1?key=abc").is_err());
        assert!(normalize_base_url("ftp://127.0.0.1/v1").is_err());
        assert!(normalize_base_url("   ").is_err());
        assert_eq!(
            normalize_base_url("https://gpu.example.net:8000/v1/").expect("원격 주소"),
            "https://gpu.example.net:8000/v1"
        );
    }

    /// 아키텍처 최대가 아니라 실제 서빙 창을 고른다.
    ///
    /// 2026-09-26 실측: `gpt-oss-cpu-low` 는 `gptoss.context_length` 가 131,072 인데
    /// `num_ctx` 는 16,384 다. 큰 쪽을 적으면 하네스가 영영 압축하지 않아 값을 비워 두는
    /// 것보다 나쁘다. `rope.scaling.original_context_length` 는 창이 아니라 학습 길이라
    /// 보지 않는다.
    #[test]
    fn the_served_window_beats_the_architecture_maximum() {
        let body = serde_json::json!({
            "parameters": "num_ctx 16384\nnum_gpu 0\ntemperature 1",
            "model_info": {
                "gptoss.context_length": 131072u64,
                "gptoss.rope.scaling.original_context_length": 4096u64,
            },
        });
        assert_eq!(super::window_from_show(&body), Some(16_384));
    }

    /// 서빙 값이 없으면 아키텍처 값으로 물러난다. 둘 다 없으면 비운다.
    #[test]
    fn without_a_served_value_the_architecture_one_is_used() {
        let body = serde_json::json!({
            "model_info": { "qwen35.context_length": 262144u64 },
        });
        assert_eq!(super::window_from_show(&body), Some(262_144));
        assert_eq!(super::window_from_show(&serde_json::json!({})), None);
        // 상한 밖 값은 비운다 — 틀린 크기는 없는 것보다 나쁘다.
        let absurd = serde_json::json!({ "parameters": "num_ctx 8" });
        assert_eq!(super::window_from_show(&absurd), None);
    }

    #[test]
    fn the_context_window_is_bounded_and_zero_means_unset() {
        assert_eq!(normalize_context_window(None).expect("없음"), None);
        assert_eq!(normalize_context_window(Some(0)).expect("0은 없음"), None);
        assert_eq!(
            normalize_context_window(Some(65_536)).expect("정상"),
            Some(65_536)
        );
        assert!(normalize_context_window(Some(16)).is_err());
        assert!(normalize_context_window(Some(u32::MAX)).is_err());
    }

    #[test]
    fn the_probe_parser_reads_both_catalog_shapes() {
        // OpenAI 호환 모양.
        assert_eq!(
            parse_models(&json!({
                "object": "list",
                "data": [{"id": "qwen3.5:9b"}, {"id": "qwen3.6:27b"}]
            })),
            vec!["qwen3.5:9b".to_owned(), "qwen3.6:27b".to_owned()]
        );
        // 서버 자체 모양과 이름 칸.
        assert_eq!(
            parse_models(&json!({"models": [{"name": "llama4"}, {"id": "llama4"}]})),
            vec!["llama4".to_owned()]
        );
        // 모양을 모르면 빈 목록이지 오류가 아니다.
        assert!(parse_models(&json!({"object": "list"})).is_empty());
        assert!(parse_models(&json!([])).is_empty());
        // 상한을 넘겨 오면 잘라 낸다.
        let many = json!({
            "data": (0..(MAX_PROBE_MODELS + 20))
                .map(|index| json!({"id": format!("model-{index}")}))
                .collect::<Vec<_>>()
        });
        assert_eq!(parse_models(&many).len(), MAX_PROBE_MODELS);
    }

    /// G4. 저장본에는 키가 있는지 여부만 남고 값은 어디에도 실리지 않는다.
    #[test]
    fn the_stored_connection_never_carries_the_api_key() {
        let dir = temp_dir();
        // 키체인을 건드리지 않고 "키 있음" 표시만 남기기 위해 저장본에 바로 적는다.
        CONNECTIONS_STORE
            .update(dir.path(), |store: &mut LocalLlmConnectionsStore| {
                store.migrated = true;
                store.default_id = DEFAULT_CONNECTION_ID.to_owned();
                store.connections = vec![LocalLlmConnectionEntry {
                    id: DEFAULT_CONNECTION_ID.to_owned(),
                    label: "기본 연결".to_owned(),
                    connection: LocalLlmConnection {
                        base_url: "http://127.0.0.1:11434/v1".to_owned(),
                        default_model: "qwen3.5:9b".to_owned(),
                        context_window: None,
                        api_key_configured: true,
                        enabled: true,
                    },
                    model_windows: BTreeMap::new(),
                }];
                Ok(true)
            })
            .expect("저장");

        let raw = std::fs::read_to_string(CONNECTIONS_STORE.path(dir.path())).expect("저장 파일");
        assert!(raw.contains("\"apiKeyConfigured\": true"));
        assert!(!raw.to_ascii_lowercase().contains("\"apikey\""));

        let view = serde_json::to_string(&get_local_llm_connection(dir.path()).expect("조회"))
            .expect("직렬화");
        assert!(view.contains("\"apiKeyConfigured\":true"));
        assert!(!view.to_ascii_lowercase().contains("\"apikey\":"));
    }
}

#[cfg(test)]
mod connection_list_tests {
    use super::*;

    fn temp_dir() -> tempfile::TempDir {
        tempfile::Builder::new()
            .prefix("agent-manager-local-llm-list-")
            .tempdir()
            .expect("임시 폴더")
    }

    fn request(id: Option<&str>, label: &str, url: &str) -> UpsertLocalLlmConnectionRequest {
        UpsertLocalLlmConnectionRequest {
            id: id.map(str::to_owned),
            label: label.to_owned(),
            base_url: url.to_owned(),
            default_model: "qwen3.5:9b".to_owned(),
            context_window: None,
            model_windows: None,
            enabled: true,
            api_key: None,
        }
    }

    // M7 7.1: v1 단일 연결은 첫 읽기에서 default 로 한 번 옮겨지고 v1 파일은 남는다.
    #[test]
    fn the_v1_connection_migrates_once_into_the_default_entry() {
        let dir = temp_dir();
        let legacy = LocalLlmStore {
            schema_version: STORE_VERSION,
            connection: LocalLlmConnection {
                base_url: "http://127.0.0.1:11434/v1".to_owned(),
                default_model: "qwen3.5:9b".to_owned(),
                context_window: Some(32_768),
                api_key_configured: false,
                enabled: true,
            },
        };
        STORE
            .update(dir.path(), |store: &mut LocalLlmStore| {
                *store = legacy;
                Ok(true)
            })
            .expect("v1 저장");

        let list = get_local_llm_connections(dir.path()).expect("목록");
        assert_eq!(list.default_id, DEFAULT_CONNECTION_ID);
        assert_eq!(list.connections.len(), 1);
        assert_eq!(
            list.connections[0].connection.base_url,
            "http://127.0.0.1:11434/v1"
        );
        assert_eq!(
            get_local_llm_connection(dir.path()).unwrap().default_model,
            "qwen3.5:9b"
        );
        assert!(STORE.path(dir.path()).exists(), "v1 파일은 지우지 않는다");

        // 목록을 비운 뒤 다시 읽어도 씨앗을 또 심지 않는다.
        upsert_local_llm_connection(
            dir.path(),
            request(None, "맥북 ollama", "http://100.64.0.2:11434/v1"),
        )
        .unwrap();
        remove_local_llm_connection(dir.path(), DEFAULT_CONNECTION_ID).unwrap();
        let list = get_local_llm_connections(dir.path()).expect("다시 읽기");
        assert_eq!(list.connections.len(), 1);
        assert_ne!(list.connections[0].id, DEFAULT_CONNECTION_ID);
        assert_eq!(
            list.default_id, list.connections[0].id,
            "기본이 남은 연결로 옮겨진다"
        );
    }

    #[test]
    fn ids_come_from_labels_and_never_collide_and_the_last_one_cannot_be_removed() {
        let dir = temp_dir();
        let first = upsert_local_llm_connection(
            dir.path(),
            request(None, "MacBook Ollama", "http://100.64.0.2:11434/v1"),
        )
        .unwrap();
        assert_eq!(first.id, "macbook-ollama");
        let second = upsert_local_llm_connection(
            dir.path(),
            request(None, "MacBook Ollama", "http://100.64.0.3:11434/v1"),
        )
        .unwrap();
        assert!(second.id.starts_with("macbook-ollama-"), "{}", second.id);
        assert_ne!(first.id, second.id);
        // 빈 저장소에서 처음 더한 연결 뒤에는 이행된 default 도 있다(빈 v1 씨앗).
        let list = get_local_llm_connections(dir.path()).unwrap();
        assert_eq!(list.connections.len(), 3);
        assert!(upsert_local_llm_connection(
            dir.path(),
            request(Some("Bad Id!"), "x", "http://h/v1")
        )
        .is_err());
        assert!(
            upsert_local_llm_connection(dir.path(), request(None, "   ", "http://h/v1")).is_err()
        );

        remove_local_llm_connection(dir.path(), &second.id).unwrap();
        remove_local_llm_connection(dir.path(), DEFAULT_CONNECTION_ID).unwrap();
        let error = remove_local_llm_connection(dir.path(), &first.id).expect_err("마지막 연결");
        assert!(matches!(error, CoreError::Conflict(_)));
        assert!(matches!(
            remove_local_llm_connection(dir.path(), "nope").unwrap_err(),
            CoreError::NotFound(_)
        ));
    }

    #[test]
    fn editing_by_id_keeps_the_id_and_the_default_pointer_moves_only_when_asked() {
        let dir = temp_dir();
        let a = upsert_local_llm_connection(dir.path(), request(None, "A", "http://a/v1")).unwrap();
        let b = upsert_local_llm_connection(dir.path(), request(None, "B", "http://b/v1")).unwrap();
        let edited =
            upsert_local_llm_connection(dir.path(), request(Some(&a.id), "A2", "http://a2/v1"))
                .unwrap();
        assert_eq!(edited.id, a.id);
        assert_eq!(edited.label, "A2");
        assert_eq!(edited.connection.base_url, "http://a2/v1");
        assert_eq!(
            get_local_llm_connections(dir.path()).unwrap().default_id,
            DEFAULT_CONNECTION_ID
        );
        let list = set_default_local_llm_connection(dir.path(), &b.id).unwrap();
        assert_eq!(list.default_id, b.id);
        assert!(set_default_local_llm_connection(dir.path(), "missing").is_err());
        // "default" 는 포인터다 — 기본을 옮기면 연결 id 를 적지 않은 호출이 그 연결을 따라간다.
        assert_eq!(
            get_local_llm_connection_by_id(dir.path(), DEFAULT_CONNECTION_ID)
                .unwrap()
                .id,
            b.id
        );
        assert_eq!(
            get_local_llm_connection(dir.path()).unwrap().base_url,
            "http://b/v1"
        );
        assert_eq!(
            resolve_local_llm_connection_id(dir.path(), "default").unwrap(),
            b.id
        );
        assert_eq!(
            resolve_local_llm_connection_id(dir.path(), &a.id).unwrap(),
            a.id
        );
        // 지워진 연결을 고른 저장물은 기본 연결로 돌아간다.
        assert_eq!(
            resolve_local_llm_connection_id(dir.path(), "gone").unwrap(),
            b.id
        );
        // 기본이 b 로 옮겨간 뒤에는 v1 별칭 저장도 b 에 적힌다.
        let saved = set_local_llm_connection(
            dir.path(),
            SetLocalLlmConnectionRequest {
                base_url: "http://b2/v1".to_owned(),
                default_model: "m".to_owned(),
                context_window: None,
                enabled: true,
                api_key: None,
            },
        )
        .unwrap();
        assert_eq!(saved.base_url, "http://b2/v1");
        assert_eq!(
            get_local_llm_connection_by_id(dir.path(), &b.id)
                .unwrap()
                .connection
                .base_url,
            "http://b2/v1"
        );
        assert_eq!(
            get_local_llm_connection_by_id(dir.path(), &a.id)
                .unwrap()
                .connection
                .base_url,
            "http://a2/v1"
        );
    }
}
