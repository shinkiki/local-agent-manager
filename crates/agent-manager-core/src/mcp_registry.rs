use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::time::Duration;

use reqwest::blocking::{Client, Response};
use reqwest::header::{ACCEPT, AUTHORIZATION, CONTENT_TYPE};
use reqwest::redirect::Policy;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::app_data_file::open_private_append_file;
use crate::clock::now_ms;
use crate::json_store::{JsonStore, SchemaVersioned};
use crate::loopback_host::validate_mcp_endpoint;
use crate::text_limit;
use crate::CoreError;

const STORE_VERSION: u32 = 1;
const STORE: JsonStore = JsonStore {
    file: "aia-mcp-interfaces.json",
    lock_file: "aia-mcp-interfaces.lock",
    label: "AIA MCP 저장소",
    version: STORE_VERSION,
};
const AUDIT_FILE: &str = "aia-mcp-audit.jsonl";
const PREVIOUS_AUDIT_FILE: &str = "aia-mcp-audit.previous.jsonl";
const MCP_PROTOCOL_VERSION: &str = "2025-03-26";
/// 원격 MCP 응답 본문(HTTP) 상한. 읽는 동안 이 크기에서 끊어 메모리도 함께 묶는다.
///
/// 노출 상한 안의 결과가 본문에서 먼저 끊기지 않도록 그 세 배에 여유를 더한다. 본문은
/// 우리가 다시 직렬화한 결과보다 클 수 있다 — JSON-RPC 봉투가 붙고, 비ASCII 글자를
/// `\uXXXX`로 내보내는 서버면 한글(3바이트)은 6바이트로 두 배, 키릴·그리스 문자나
/// 악센트 붙은 라틴 문자(2바이트)는 6바이트로, BMP 밖 이모지(4바이트)는 서로게이트 쌍
/// 12바이트로 세 배가 된다. 외부 플러그인 프록시(`MAX_PROXY_RESPONSE_BYTES`, 8 MiB)보다는
/// 작아서 프록시를 지난 본문이 여기서 처음으로 묶인다. 이 상한을 넘은 `tools/call`
/// 응답은 오류 대신 생략 안내로 바꾼다([`oversized_body_result`]).
const MAX_REMOTE_BODY_BYTES: usize = 3 * MAX_EXPOSED_RESULT_BYTES + 512 * 1024;
/// 도구 결과를 에이전트에 그대로 넘기는 직렬화 크기 상한. 넘으면 본문을 통째로 빼고
/// 생략 안내와 `_meta.originalBytes`만 남긴다. 256 KB였을 때 노션 기획서 한 페이지
/// (`notion-fetch`, 직렬화 270,480바이트)가 잘려 기획 회차 4번이 연달아 실패했다
/// (2026-10-25). 노션 페이지는 수백 KB가 흔하고 문서는 자라므로 그 여덟 배쯤으로 둔다.
/// 큰 결과는 받는 쪽이 감당한다 — Claude Code는 큰 MCP 출력을 파일로 빼고, Codex
/// 회차는 결과를 프로그램으로 읽는다. 이 결과를 싣는 aia_system 응답은 외부 도구
/// 작업에만 이 상한에 봉투 몫을 더한 상한을 따로 쓴다(`system_mcp::remote_tool_success`).
pub(crate) const MAX_EXPOSED_RESULT_BYTES: usize = 2 * 1024 * 1024;
const MAX_AUDIT_FILE_BYTES: u64 = 2 * 1024 * 1024;
const MAX_INTERFACES: usize = 32;
const MAX_ENABLED_TOOLS: usize = 64;
/// 서버가 내놓는 도구 카탈로그 전체의 상한. E7의 64개는 **켜 둔** 도구 수이고(`enabledTools`),
/// 카탈로그는 그보다 클 수 있다 — 호스팅 노션 MCP가 64개를 넘기자 연결 확인이 통째로
/// 막혔다(2026-10-18). 응답 본문은 `MAX_REMOTE_BODY_BYTES`가 따로 묶는다.
const MAX_CATALOG_TOOLS: usize = 512;
const MAX_RECENT_AUDIT: usize = 50;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const TOOL_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Clone)]
pub(crate) struct McpInterfaceRegistry {
    app_data_dir: PathBuf,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct McpInterfaceProbeRequest {
    pub url: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct McpInterfaceRegisterRequest {
    pub id: String,
    pub display_name: String,
    pub url: String,
    pub expected_identity: String,
    pub enabled_tools: Vec<String>,
    #[serde(default)]
    pub grant_expires_at: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct McpInterfaceIdRequest {
    pub id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct McpInterfaceCallRequest {
    pub id: String,
    pub tool: String,
    #[serde(default = "empty_object")]
    pub arguments: Value,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct McpRemoteTool {
    pub(crate) name: String,
    pub(crate) title: Option<String>,
    pub(crate) description: Option<String>,
    pub(crate) input_schema: Value,
    pub(crate) read_only: bool,
    pub(crate) destructive: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct McpInterfaceProbe {
    url: String,
    server_name: String,
    server_version: Option<String>,
    identity_hash: String,
    tools: Vec<McpRemoteTool>,
}

/// 입력 검증을 통과한 등록 요청. 원격 조사 전에 확정되는 값만 담아, 조사 이후 단계가
/// 다시 검증할 필요가 없음을 타입으로 드러낸다.
struct ValidatedRegistration {
    id: String,
    display_name: String,
    url: String,
    enabled_tools: Vec<String>,
    expected_identity: String,
    grant_expires_at: Option<i64>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct StoredMcpInterface {
    id: String,
    display_name: String,
    url: String,
    identity_hash: String,
    enabled_tools: Vec<String>,
    tools: Vec<McpRemoteTool>,
    granted_at: i64,
    grant_expires_at: Option<i64>,
}

impl StoredMcpInterface {
    /// 권한 만료 여부를 확인한다.
    fn is_expired(&self, now: i64) -> bool {
        self.grant_expires_at.is_some_and(|expires| expires <= now)
    }

    /// 카탈로그에 표시할 상태 문자열을 반환한다.
    fn status(&self, now: i64) -> &'static str {
        if self.is_expired(now) {
            "expired"
        } else {
            "active"
        }
    }

    /// 카탈로그 응답용 JSON 객체로 변환한다.
    fn to_catalog_json(&self, now: i64) -> Value {
        json!({
            "id": self.id,
            "displayName": self.display_name,
            "url": self.url,
            "identityHash": self.identity_hash,
            "enabledTools": self.enabled_tools,
            "tools": self.tools,
            "grantedAt": self.granted_at,
            "grantExpiresAt": self.grant_expires_at,
            "status": self.status(now),
        })
    }
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct McpInterfaceStore {
    schema_version: u32,
    interfaces: BTreeMap<String, StoredMcpInterface>,
}

impl SchemaVersioned for McpInterfaceStore {
    fn schema_version(&self) -> u32 {
        self.schema_version
    }
}

impl Default for McpInterfaceStore {
    fn default() -> Self {
        Self {
            schema_version: STORE_VERSION,
            interfaces: BTreeMap::new(),
        }
    }
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct McpAuditEvent {
    id: String,
    timestamp: i64,
    action: String,
    interface_id: Option<String>,
    tool: Option<String>,
    outcome: String,
}

pub(crate) struct McpHttpSession {
    client: Client,
    url: String,
    /// 원격 서버에 붙일 `Authorization` 헤더 값. 외부 플러그인 검증처럼 인증이 있는
    /// 서버에 접속할 때만 채워지며, 로그·오류 문구에는 절대 넣지 않는다.
    authorization: Option<String>,
    session_id: Option<String>,
    next_id: u64,
}

impl McpInterfaceRegistry {
    pub(crate) fn new(app_data_dir: PathBuf) -> Self {
        Self { app_data_dir }
    }

    pub(crate) fn catalog(&self) -> Result<Value, CoreError> {
        self.with_store_lock(|| {
            let store = self.load_store_unlocked()?;
            let now = now_ms();
            let interfaces = store
                .interfaces
                .values()
                .map(|interface| interface.to_catalog_json(now))
                .collect::<Vec<_>>();
            Ok(json!({
                "interfaces": interfaces,
                "recentAudit": self.load_recent_audit_unlocked()?,
                "limits": {
                    "transport": "streamableHttp",
                    "remoteScheme": "https",
                    "localScheme": "http 또는 https",
                    "authentication": "1차에서는 URL에 인증정보가 없는 MCP만 지원",
                    "maxInterfaces": MAX_INTERFACES,
                    "maxEnabledToolsPerInterface": MAX_ENABLED_TOOLS,
                    "maxCatalogToolsPerInterface": MAX_CATALOG_TOOLS
                }
            }))
        })
    }

    pub(crate) fn probe(&self, request: McpInterfaceProbeRequest) -> Result<Value, CoreError> {
        let url = validate_mcp_endpoint(&request.url)?;
        match probe_remote(&url) {
            Ok((_, probe)) => {
                self.record_probe("succeeded");
                serde_json::to_value(probe).map_err(CoreError::Json)
            }
            Err(error) => {
                self.record_probe("failed");
                Err(error)
            }
        }
    }

    pub(crate) fn register(
        &self,
        request: McpInterfaceRegisterRequest,
    ) -> Result<Value, CoreError> {
        let request = validate_registration(request)?;
        let (_, probe) = probe_remote(&request.url)?;
        if !probe
            .identity_hash
            .eq_ignore_ascii_case(&request.expected_identity)
        {
            let _ = self.record_audit("register", Some(&request.id), None, "identityMismatch");
            return Err(CoreError::Conflict(
                "MCP 서버 identity가 probe 이후 변경되었습니다. 다시 조사하고 승인해 주세요"
                    .to_owned(),
            ));
        }
        let tools = select_granted_tools(probe.tools, &request.enabled_tools)?;
        self.insert_interface(StoredMcpInterface {
            id: request.id,
            display_name: request.display_name,
            url: request.url,
            identity_hash: probe.identity_hash,
            enabled_tools: request.enabled_tools,
            tools,
            granted_at: now_ms(),
            grant_expires_at: request.grant_expires_at,
        })
    }

    /// 검증과 대조를 모두 마친 인터페이스를 저장한다. 중복 등록과 총량 한도는 저장 잠금
    /// 안에서만 판정해야 같은 순간에 들어온 두 등록이 한도를 함께 넘기지 않는다.
    fn insert_interface(&self, stored: StoredMcpInterface) -> Result<Value, CoreError> {
        self.with_store_lock(|| {
            let mut store = self.load_store_unlocked()?;
            if store.interfaces.contains_key(&stored.id) {
                return Err(CoreError::Conflict(
                    "이미 등록된 MCP 인터페이스입니다. 먼저 기존 권한을 회수해 주세요".to_owned(),
                ));
            }
            if store.interfaces.len() >= MAX_INTERFACES {
                return Err(CoreError::Conflict(format!(
                    "동적 MCP 인터페이스는 최대 {MAX_INTERFACES}개까지 등록할 수 있습니다"
                )));
            }
            store.interfaces.insert(stored.id.clone(), stored.clone());
            self.save_store_unlocked(&store)?;
            self.append_audit_unlocked(McpAuditEvent::new(
                "register",
                Some(&stored.id),
                None,
                "succeeded",
            ))?;
            Ok(json!({"registered": true, "interface": stored}))
        })
    }

    pub(crate) fn revoke(&self, request: McpInterfaceIdRequest) -> Result<Value, CoreError> {
        validate_interface_id(&request.id)?;
        self.with_store_lock(|| {
            let mut store = self.load_store_unlocked()?;
            if store.interfaces.remove(&request.id).is_none() {
                return Err(CoreError::NotFound(
                    "등록된 MCP 인터페이스를 찾을 수 없습니다".to_owned(),
                ));
            }
            self.save_store_unlocked(&store)?;
            self.append_audit_unlocked(McpAuditEvent::new(
                "revoke",
                Some(&request.id),
                None,
                "succeeded",
            ))?;
            Ok(json!({"revoked": true, "interfaceId": request.id}))
        })
    }

    pub(crate) fn call_read(&self, request: McpInterfaceCallRequest) -> Result<Value, CoreError> {
        self.call(request, true)
    }

    pub(crate) fn call_execute(
        &self,
        request: McpInterfaceCallRequest,
    ) -> Result<Value, CoreError> {
        self.call(request, false)
    }

    /// 등록된 MCP 인터페이스를 ID로 조회한다.
    fn find_interface(&self, id: &str) -> Result<StoredMcpInterface, CoreError> {
        self.with_store_lock(|| {
            let store = self.load_store_unlocked()?;
            store.interfaces.get(id).cloned().ok_or_else(|| {
                CoreError::NotFound("등록된 MCP 인터페이스를 찾을 수 없습니다".to_owned())
            })
        })
    }

    /// MCP 도구 호출 전 입력 형식, 인터페이스 만료 여부, 도구 허용 여부 및 읽기/실행 접근 경로를 검증한다.
    fn resolve_callable_tool(
        &self,
        request: &McpInterfaceCallRequest,
        require_read_only: bool,
    ) -> Result<(StoredMcpInterface, McpRemoteTool), CoreError> {
        validate_interface_id(&request.id)?;
        validate_tool_name(&request.tool)?;
        if !request.arguments.is_object() {
            return Err(CoreError::InvalidInput(
                "MCP 도구 arguments는 객체여야 합니다".to_owned(),
            ));
        }
        let interface = self.find_interface(&request.id)?;
        if interface.is_expired(now_ms()) {
            return Err(self.reject_invoke(
                &request.id,
                &request.tool,
                "grantExpired",
                CoreError::Conflict(
                    "MCP 인터페이스 권한이 만료되었습니다. 다시 등록해 주세요".to_owned(),
                ),
            ));
        }
        let Some(granted_tool) = find_tool(&interface.tools, &request.tool).cloned() else {
            return Err(self.reject_invoke(
                &request.id,
                &request.tool,
                "notGranted",
                CoreError::InvalidInput("이 인터페이스에 허용되지 않은 MCP 도구입니다".to_owned()),
            ));
        };
        if granted_tool.read_only != require_read_only {
            return Err(self.reject_invoke(
                &request.id,
                &request.tool,
                "wrongAccessPath",
                CoreError::InvalidInput(if require_read_only {
                    "변경 가능 도구는 interface_execute로 호출해야 합니다".to_owned()
                } else {
                    "읽기 전용 도구는 interface_read로 호출해야 합니다".to_owned()
                }),
            ));
        }
        Ok((interface, granted_tool))
    }

    /// 원격 MCP 세션에 연결하여 identity 및 도구 변경 여부를 검증한 뒤 도구를 실행한다.
    fn invoke_remote_tool(
        interface: &StoredMcpInterface,
        granted_tool: &McpRemoteTool,
        tool: &str,
        arguments: Value,
    ) -> Result<Value, CoreError> {
        let (mut session, probe) = probe_remote(&interface.url)?;
        if probe.identity_hash != interface.identity_hash {
            return Err(CoreError::Conflict(
                "등록 이후 MCP 서버 identity가 변경되었습니다. 권한을 회수하고 다시 등록해 주세요"
                    .to_owned(),
            ));
        }
        let current_tool = find_tool(&probe.tools, tool).ok_or_else(|| {
            CoreError::Conflict("등록된 MCP 도구가 현재 서버 카탈로그에서 사라졌습니다".to_owned())
        })?;
        if current_tool.read_only != granted_tool.read_only {
            return Err(CoreError::Conflict(
                "MCP 도구의 읽기/변경 분류가 등록 이후 달라졌습니다".to_owned(),
            ));
        }
        session.call_tool(tool, arguments)
    }

    fn call(
        &self,
        request: McpInterfaceCallRequest,
        require_read_only: bool,
    ) -> Result<Value, CoreError> {
        let (interface, granted_tool) = self.resolve_callable_tool(&request, require_read_only)?;

        let invocation =
            Self::invoke_remote_tool(&interface, &granted_tool, &request.tool, request.arguments);

        match invocation {
            Ok(result) => {
                let remote_error = result.get("isError").and_then(Value::as_bool) == Some(true);
                let result = bounded_remote_result(result);
                // 상한 때문에 결과를 받지 못한 호출은 성공·원격 오류로 남기지 않는다.
                let outcome = match remote_result_omission(&result) {
                    Some(omission) => omission.audit_outcome(),
                    None if remote_error => "remoteError",
                    None => "succeeded",
                };
                let audit_recorded = self
                    .record_invoke(&request.id, &request.tool, outcome)
                    .is_ok();
                Ok(json!({
                    "interfaceId": request.id,
                    "tool": request.tool,
                    "result": result,
                    "auditRecorded": audit_recorded
                }))
            }
            Err(error) => {
                let outcome = if error.to_string().contains("identity") {
                    "identityMismatch"
                } else {
                    "failed"
                };
                Err(self.reject_invoke(&request.id, &request.tool, outcome, error))
            }
        }
    }

    /// 조사 감사는 인터페이스도 도구도 아직 정해지지 않은 자리라 결과만 남는다.
    fn record_probe(&self, outcome: &str) {
        let _ = self.record_audit("probe", None, None, outcome);
    }

    /// 도구 호출 감사는 성공·원격오류·거절이 모두 같은 `invoke` 한 줄이다. 행위 이름과
    /// 두 식별자를 호출 지점마다 다시 적으면 그중 하나만 빠져도 감사가 조용히 갈라진다.
    fn record_invoke(
        &self,
        interface_id: &str,
        tool: &str,
        outcome: &str,
    ) -> Result<(), CoreError> {
        self.record_audit("invoke", Some(interface_id), Some(tool), outcome)
    }

    /// 거절은 언제나 "감사 한 줄 + 그 이유의 오류"라 둘을 한 자리에서 만든다. 감사 기록
    /// 실패가 거절 사유를 덮지 않도록 기록 결과는 버린다.
    fn reject_invoke(
        &self,
        interface_id: &str,
        tool: &str,
        outcome: &str,
        error: CoreError,
    ) -> CoreError {
        let _ = self.record_invoke(interface_id, tool, outcome);
        error
    }

    fn record_audit(
        &self,
        action: &str,
        interface_id: Option<&str>,
        tool: Option<&str>,
        outcome: &str,
    ) -> Result<(), CoreError> {
        self.with_store_lock(|| {
            self.append_audit_unlocked(McpAuditEvent::new(action, interface_id, tool, outcome))
        })
    }

    fn with_store_lock<T>(
        &self,
        action: impl FnOnce() -> Result<T, CoreError>,
    ) -> Result<T, CoreError> {
        STORE.with_lock(&self.app_data_dir, action)
    }

    fn load_store_unlocked(&self) -> Result<McpInterfaceStore, CoreError> {
        STORE.load_unlocked(&self.app_data_dir)
    }

    fn save_store_unlocked(&self, store: &McpInterfaceStore) -> Result<(), CoreError> {
        STORE.save_unlocked(&self.app_data_dir, store)
    }

    fn append_audit_unlocked(&self, event: McpAuditEvent) -> Result<(), CoreError> {
        let path = self.app_data_dir.join(AUDIT_FILE);
        if fs::metadata(&path)
            .map(|metadata| metadata.len() >= MAX_AUDIT_FILE_BYTES)
            .unwrap_or(false)
        {
            let previous = self.app_data_dir.join(PREVIOUS_AUDIT_FILE);
            if previous.exists() {
                fs::remove_file(&previous)?;
            }
            fs::rename(&path, previous)?;
        }
        let mut file = open_private_append_file(&path)?;
        file.write_all(&serde_json::to_vec(&event)?)?;
        file.write_all(b"\n")?;
        file.sync_data()?;
        Ok(())
    }

    fn load_recent_audit_unlocked(&self) -> Result<Vec<McpAuditEvent>, CoreError> {
        let path = self.app_data_dir.join(AUDIT_FILE);
        if !path.is_file() {
            return Ok(Vec::new());
        }
        let text = fs::read_to_string(path)?;
        let mut events = text
            .lines()
            .rev()
            .take(MAX_RECENT_AUDIT)
            .filter_map(|line| serde_json::from_str::<McpAuditEvent>(line).ok())
            .collect::<Vec<_>>();
        events.reverse();
        Ok(events)
    }
}

impl McpAuditEvent {
    fn new(action: &str, interface_id: Option<&str>, tool: Option<&str>, outcome: &str) -> Self {
        Self {
            id: Uuid::new_v4().to_string(),
            timestamp: now_ms(),
            action: action.to_owned(),
            interface_id: interface_id.map(str::to_owned),
            tool: tool.map(str::to_owned),
            outcome: outcome.to_owned(),
        }
    }
}

impl McpHttpSession {
    fn connect(url: &str) -> Result<(Self, Value), CoreError> {
        Self::connect_with_authorization(url, None)
    }

    pub(crate) fn connect_with_authorization(
        url: &str,
        authorization: Option<&str>,
    ) -> Result<(Self, Value), CoreError> {
        let client = Client::builder()
            .connect_timeout(CONNECT_TIMEOUT)
            .timeout(TOOL_TIMEOUT)
            .redirect(Policy::none())
            .user_agent("agent-manager-aia-mcp/1")
            .build()
            .map_err(|error| {
                CoreError::Runtime(format!("MCP HTTP 클라이언트를 만들지 못했습니다: {error}"))
            })?;
        let mut session = Self {
            client,
            url: url.to_owned(),
            authorization: authorization.map(str::to_owned),
            session_id: None,
            next_id: 1,
        };
        let initialize = session.rpc(
            "initialize",
            json!({
                "protocolVersion": MCP_PROTOCOL_VERSION,
                "capabilities": {},
                "clientInfo": {
                    "name": "Agent Manager AIA",
                    "version": env!("CARGO_PKG_VERSION")
                }
            }),
        )?;
        session.notify("notifications/initialized", json!({}))?;
        Ok((session, initialize))
    }

    pub(crate) fn list_tools(&mut self) -> Result<Value, CoreError> {
        self.rpc("tools/list", json!({}))
    }

    /// 도구를 호출한다. 응답 본문이 [`MAX_REMOTE_BODY_BYTES`]를 넘으면 오류 대신
    /// [`oversized_body_result`]를 돌려준다 — 노출 상한을 넘은 결과처럼 `_meta.truncated`
    /// 생략 안내라 받는 쪽은 결과가 커서 빠졌다는 것을 같은 표시로 본다(본문을 끝까지
    /// 읽지 않았으므로 원래 크기 대신 `bodyLimitBytes`가 실린다).
    pub(crate) fn call_tool(&mut self, name: &str, arguments: Value) -> Result<Value, CoreError> {
        match self.rpc("tools/call", json!({"name": name, "arguments": arguments})) {
            Err(CoreError::TooLarge(limit)) => Ok(oversized_body_result(limit)),
            other => other,
        }
    }

    fn rpc(&mut self, method: &str, params: Value) -> Result<Value, CoreError> {
        let id = self.next_id;
        self.next_id = self.next_id.saturating_add(1);
        let response = self.post(json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params
        }))?;
        let mut value = response
            .ok_or_else(|| CoreError::Runtime(format!("MCP {method} 응답이 비어 있습니다")))?;
        if let Some(error) = value.get("error") {
            let message = error
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("알 수 없는 MCP JSON-RPC 오류");
            return Err(CoreError::Runtime(format!(
                "MCP {method} 요청이 실패했습니다: {}",
                text_limit::truncate_chars(message, 300)
            )));
        }
        // 결과는 수 MiB일 수 있어 복사하지 않고 응답에서 떼어 낸다.
        value
            .as_object_mut()
            .and_then(|object| object.remove("result"))
            .ok_or_else(|| CoreError::Runtime(format!("MCP {method} 응답에 result가 없습니다")))
    }

    fn notify(&mut self, method: &str, params: Value) -> Result<(), CoreError> {
        let _ = self.post(json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params
        }))?;
        Ok(())
    }

    fn post(&mut self, payload: Value) -> Result<Option<Value>, CoreError> {
        let mut request = self
            .client
            .post(&self.url)
            .header(CONTENT_TYPE, "application/json")
            .header(ACCEPT, "application/json, text/event-stream")
            .header("mcp-protocol-version", MCP_PROTOCOL_VERSION)
            .json(&payload);
        if let Some(session_id) = &self.session_id {
            request = request.header("mcp-session-id", session_id);
        }
        if let Some(authorization) = &self.authorization {
            request = request.header(AUTHORIZATION, authorization);
        }
        let response = request.send().map_err(|error| {
            CoreError::Runtime(format!("MCP 서버에 연결하지 못했습니다: {error}"))
        })?;
        if let Some(session_id) = response
            .headers()
            .get("mcp-session-id")
            .and_then(|value| value.to_str().ok())
        {
            self.session_id = Some(session_id.to_owned());
        }
        parse_http_response(response)
    }
}

/// initialize 응답이 알려 준 상류 서버 이름. 규약상 `title`이 사람에게 보일 이름이고
/// `name`은 식별자라, 둘 다 있으면 `title`을 쓴다. 동적 MCP 등록과 외부 플러그인의
/// 카탈로그·연결 확인이 같은 두 칸 들여다보기를 각자 하고 있었다.
pub(crate) fn server_name(initialize: &Value) -> Option<String> {
    server_info_field(initialize, "title").or_else(|| server_info_field(initialize, "name"))
}

fn server_info_field(initialize: &Value, field: &str) -> Option<String> {
    initialize
        .get("serverInfo")?
        .get(field)?
        .as_str()
        .map(str::to_owned)
}

fn probe_remote(url: &str) -> Result<(McpHttpSession, McpInterfaceProbe), CoreError> {
    let (mut session, initialize) = McpHttpSession::connect(url)?;
    let tools_result = session.list_tools()?;
    let tools = parse_tools(&tools_result)?;
    let server_name = server_name(&initialize).unwrap_or_else(|| "이름 없는 MCP 서버".to_owned());
    let server_version = server_info_field(&initialize, "version");
    let identity_hash = interface_identity(url, &server_name, server_version.as_deref(), &tools)?;
    Ok((
        session,
        McpInterfaceProbe {
            url: url.to_owned(),
            server_name,
            server_version,
            identity_hash,
            tools,
        },
    ))
}

pub(crate) fn parse_tools(result: &Value) -> Result<Vec<McpRemoteTool>, CoreError> {
    if result
        .get("nextCursor")
        .and_then(Value::as_str)
        .is_some_and(|cursor| !cursor.is_empty())
    {
        return Err(CoreError::Conflict(format!(
            "1차 동적 MCP는 최대 {MAX_CATALOG_TOOLS}개의 비페이지 도구 카탈로그만 지원합니다"
        )));
    }
    let raw_tools = result
        .get("tools")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            CoreError::Runtime("MCP tools/list 응답에 tools 배열이 없습니다".to_owned())
        })?;
    if raw_tools.len() > MAX_CATALOG_TOOLS {
        return Err(CoreError::Conflict(format!(
            "MCP 서버가 도구 {}개를 반환했습니다. 최대 {MAX_CATALOG_TOOLS}개까지 지원합니다",
            raw_tools.len()
        )));
    }
    let mut tools = Vec::with_capacity(raw_tools.len());
    let mut names = BTreeSet::new();
    for raw in raw_tools {
        let name = raw
            .get("name")
            .and_then(Value::as_str)
            .ok_or_else(|| CoreError::Runtime("MCP 도구 이름이 없습니다".to_owned()))?;
        validate_tool_name(name)?;
        if !names.insert(name.to_owned()) {
            return Err(CoreError::Conflict(format!(
                "MCP 서버가 중복 도구 이름을 반환했습니다: {name}"
            )));
        }
        let annotations = raw.get("annotations").unwrap_or(&Value::Null);
        tools.push(McpRemoteTool {
            name: name.to_owned(),
            title: raw
                .get("title")
                .and_then(Value::as_str)
                .map(|value| text_limit::truncate_chars(value, 120)),
            description: raw
                .get("description")
                .and_then(Value::as_str)
                .map(|value| text_limit::truncate_chars(value, 500)),
            input_schema: raw
                .get("inputSchema")
                .filter(|schema| schema.is_object())
                .cloned()
                .unwrap_or_else(|| json!({"type": "object"})),
            read_only: annotations
                .get("readOnlyHint")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            destructive: annotations
                .get("destructiveHint")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        });
    }
    tools.sort_by(|left, right| left.name.cmp(&right.name));
    Ok(tools)
}

fn interface_identity(
    url: &str,
    server_name: &str,
    server_version: Option<&str>,
    tools: &[McpRemoteTool],
) -> Result<String, CoreError> {
    let payload = serde_json::to_vec(&json!({
        "url": url,
        "serverName": server_name,
        "serverVersion": server_version,
        "tools": tools
    }))?;
    let digest = Sha256::digest(payload);
    Ok(digest.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn parse_http_response(response: Response) -> Result<Option<Value>, CoreError> {
    let status = response.status();
    if status.is_redirection() {
        return Err(CoreError::Conflict(
            "MCP 서버 리디렉션은 허용하지 않습니다. 최종 HTTPS URL을 등록해 주세요".to_owned(),
        ));
    }
    if !status.is_success() {
        return Err(CoreError::Runtime(format!(
            "MCP 서버가 HTTP {} 상태를 반환했습니다",
            status.as_u16()
        )));
    }
    let content_type = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_owned();
    let body = read_capped_body(
        response,
        MAX_REMOTE_BODY_BYTES,
        "MCP 서버 응답을 읽지 못했습니다",
    )?;
    if body.is_empty() {
        return Ok(None);
    }
    if is_event_stream(&content_type) {
        let text = std::str::from_utf8(&body)
            .map_err(|_| CoreError::Runtime("MCP SSE 응답이 UTF-8이 아닙니다".to_owned()))?;
        return parse_sse_json(text).map(Some);
    }
    serde_json::from_slice(&body)
        .map(Some)
        .map_err(CoreError::Json)
}

/// 응답 본문을 `limit` 안에서 읽는다. 선언된 길이가 상한을 넘으면 읽기 전에 거절하고,
/// 길이 선언이 없는 chunked·SSE 본문은 상한보다 한 바이트 더까지만 읽어 넘었는지 본다 —
/// 다 받은 뒤에 재면 상한이 메모리를 지켜 주지 못한다(`system_mcp::read_limited_body`와
/// 같은 규칙). 외부 플러그인 프록시도 이 함수로 읽는다.
pub(crate) fn read_capped_body(
    response: Response,
    limit: usize,
    unreadable: &str,
) -> Result<Vec<u8>, CoreError> {
    let declared = response.content_length();
    if declared.is_some_and(|length| length > limit as u64) {
        return Err(CoreError::TooLarge(limit as u64));
    }
    // 선언된 길이만큼 미리 잡아 read_to_end가 버퍼를 두 배씩 늘리며 상한의 두 배 가까이
    // 쥐지 않게 한다. 선언이 없으면 늘려 가며 읽되 상한+1에서 끊긴다.
    let mut body = Vec::with_capacity(declared.map_or(0, |length| length as usize));
    response
        .take(limit as u64 + 1)
        .read_to_end(&mut body)
        .map_err(|error| CoreError::Runtime(format!("{unreadable}: {error}")))?;
    if body.len() > limit {
        return Err(CoreError::TooLarge(limit as u64));
    }
    Ok(body)
}

/// 응답이 SSE 인지. 미디어 타입은 대소문자를 가리지 않고(RFC 9110 8.3.1) `;` 뒤 매개변수는
/// 판정에 쓰지 않는다. `starts_with` 로 보면 `Text/Event-Stream` 은 JSON 으로 읽혀 실패하고
/// `text/event-streamx` 같은 다른 타입이 SSE 로 읽힌다.
fn is_event_stream(content_type: &str) -> bool {
    content_type
        .split(';')
        .next()
        .is_some_and(|media| media.trim().eq_ignore_ascii_case("text/event-stream"))
}

fn parse_sse_json(text: &str) -> Result<Value, CoreError> {
    let normalized = text.replace("\r\n", "\n");
    for event in normalized.split("\n\n") {
        let data = event
            .lines()
            .filter_map(|line| line.strip_prefix("data:"))
            .map(str::trim_start)
            .collect::<Vec<_>>()
            .join("\n");
        if !data.is_empty() {
            return serde_json::from_str(&data).map_err(CoreError::Json);
        }
    }
    Err(CoreError::Runtime(
        "MCP SSE 응답에 JSON data 이벤트가 없습니다".to_owned(),
    ))
}

/// 쓰인 바이트 수만 센다. 수 MiB 결과의 크기를 재려고 그만한 버퍼를 또 만들지 않는다.
struct ByteCounter(usize);

impl Write for ByteCounter {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0 += buf.len();
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// 원격 응답 본문이 [`MAX_REMOTE_BODY_BYTES`]를 넘어 받지 못한 `tools/call`의 결과.
/// 본문을 끝까지 읽지 않았으므로 원래 크기는 모르고, 도구가 성공했는지도 알 수 없어
/// `isError`로 둔다.
fn oversized_body_result(limit: u64) -> Value {
    json!({
        "content": [{
            "type": "text",
            "text": "외부 MCP 응답이 Agent Manager가 받는 본문 상한을 넘어 결과를 받지 못했습니다. 도구가 실행됐는지와 그 결과는 확인할 수 없습니다. 더 좁은 조회 조건을 사용하세요."
        }],
        "isError": true,
        "_meta": {"truncated": true, "bodyLimitBytes": limit}
    })
}

/// 원격 도구 결과가 Agent Manager의 상한 때문에 빠진 까닭.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RemoteResultOmission {
    /// 응답 본문이 [`MAX_REMOTE_BODY_BYTES`]를 넘어 읽지 않았다. 도구가 실행됐는지도 모른다.
    BodyLimitExceeded,
    /// 결과는 받았지만 [`MAX_EXPOSED_RESULT_BYTES`]를 넘어 본문을 뺐다.
    Truncated,
}

impl RemoteResultOmission {
    /// 감사 기록에 남기는 결과 이름. 평범한 성공(`succeeded`)과 갈라 둔다.
    pub(crate) fn audit_outcome(self) -> &'static str {
        match self {
            Self::BodyLimitExceeded => "bodyLimitExceeded",
            Self::Truncated => "truncated",
        }
    }

    /// 시스템 감사의 실패 까닭 문구.
    pub(crate) fn audit_reason(self) -> &'static str {
        match self {
            Self::BodyLimitExceeded => {
                "bodyLimitExceeded: 외부 MCP 응답 본문이 받는 상한을 넘어 실행 결과를 확인하지 못했습니다"
            }
            Self::Truncated => {
                "truncated: 외부 MCP 결과가 노출 상한을 넘어 본문을 생략했습니다"
            }
        }
    }
}

/// [`bounded_remote_result`]·[`oversized_body_result`]를 거친 결과에서 상한 때문에 빠진
/// 것을 알아본다. 감사 기록이 이런 호출을 성공으로 남기지 않게 하는 자리라, 원격 서버가
/// 스스로 `_meta.truncated`를 달아 보내도 보수적으로 생략으로 본다.
pub(crate) fn remote_result_omission(result: &Value) -> Option<RemoteResultOmission> {
    let meta = result.get("_meta")?;
    if meta.get("truncated").and_then(Value::as_bool) != Some(true) {
        return None;
    }
    Some(if meta.get("bodyLimitBytes").is_some() {
        RemoteResultOmission::BodyLimitExceeded
    } else {
        RemoteResultOmission::Truncated
    })
}

pub(crate) fn bounded_remote_result(result: Value) -> Value {
    let mut counter = ByteCounter(0);
    let serialized_bytes = serde_json::to_writer(&mut counter, &result)
        .map(|()| counter.0)
        .unwrap_or(MAX_EXPOSED_RESULT_BYTES + 1);
    if serialized_bytes <= MAX_EXPOSED_RESULT_BYTES {
        result
    } else {
        json!({
            "content": [{
                "type": "text",
                "text": "외부 MCP 호출은 완료됐지만 결과가 커서 Agent Manager가 본문을 생략했습니다. 더 좁은 조회 조건을 사용하세요."
            }],
            "isError": result.get("isError").and_then(Value::as_bool).unwrap_or(false),
            "_meta": {"truncated": true, "originalBytes": serialized_bytes}
        })
    }
}

/// 등록 요청 중 원격 조사 없이 판정할 수 있는 입력만 먼저 검증한다. 네트워크를 타기 전에
/// 끝나야 하는 판정을 여기 모아 두면 `register`에는 조사 결과와의 대조만 남는다.
fn validate_registration(
    request: McpInterfaceRegisterRequest,
) -> Result<ValidatedRegistration, CoreError> {
    validate_interface_id(&request.id)?;
    let display_name = validate_display_name(&request.display_name)?;
    let url = validate_mcp_endpoint(&request.url)?;
    let enabled_tools = validate_enabled_tools(&request.enabled_tools)?;
    if request.expected_identity.len() != 64
        || !request
            .expected_identity
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(CoreError::InvalidInput(
            "expectedIdentity는 probe 결과의 SHA-256 identityHash여야 합니다".to_owned(),
        ));
    }
    if request
        .grant_expires_at
        .is_some_and(|expires| expires <= now_ms())
    {
        return Err(CoreError::InvalidInput(
            "grantExpiresAt은 현재 이후 시각이어야 합니다".to_owned(),
        ));
    }
    Ok(ValidatedRegistration {
        id: request.id,
        display_name,
        url,
        enabled_tools,
        expected_identity: request.expected_identity,
        grant_expires_at: request.grant_expires_at,
    })
}

/// 조사 결과에서 승인된 도구만 골라 낸다. 승인 목록에 서버가 더 이상 제공하지 않는 이름이
/// 하나라도 있으면 그 이름을 그대로 돌려주며 등록을 거절한다 — 빈손으로 등록해 두면
/// 사용자는 무엇이 빠졌는지 알 수 없다.
fn select_granted_tools(
    probed: Vec<McpRemoteTool>,
    enabled_tools: &[String],
) -> Result<Vec<McpRemoteTool>, CoreError> {
    let available = probed
        .iter()
        .map(|tool| tool.name.as_str())
        .collect::<BTreeSet<_>>();
    let missing = enabled_tools
        .iter()
        .filter(|tool| !available.contains(tool.as_str()))
        .cloned()
        .collect::<Vec<_>>();
    if !missing.is_empty() {
        return Err(CoreError::InvalidInput(format!(
            "MCP 서버에 없는 도구가 포함되어 있습니다: {}",
            missing.join(", ")
        )));
    }
    Ok(probed
        .into_iter()
        .filter(|tool| enabled_tools.iter().any(|enabled| enabled == &tool.name))
        .collect())
}

fn validate_interface_id(value: &str) -> Result<(), CoreError> {
    if !crate::identifier::is_lowercase_slug(value, 64) {
        return Err(CoreError::InvalidInput(
            "인터페이스 id는 영문 소문자나 숫자로 시작하는 64자 이하의 소문자·숫자·_·- 조합이어야 합니다"
                .to_owned(),
        ));
    }
    Ok(())
}

fn validate_display_name(value: &str) -> Result<String, CoreError> {
    let value = value.trim();
    if value.is_empty() || value.chars().count() > 80 || value.chars().any(char::is_control) {
        return Err(CoreError::InvalidInput(
            "인터페이스 표시 이름은 제어문자 없는 1~80자여야 합니다".to_owned(),
        ));
    }
    Ok(value.to_owned())
}

fn validate_enabled_tools(values: &[String]) -> Result<Vec<String>, CoreError> {
    if values.is_empty() || values.len() > MAX_ENABLED_TOOLS {
        return Err(CoreError::InvalidInput(format!(
            "enabledTools는 1~{MAX_ENABLED_TOOLS}개여야 합니다"
        )));
    }
    let mut unique = BTreeSet::new();
    for value in values {
        validate_tool_name(value)?;
        if !unique.insert(value.clone()) {
            return Err(CoreError::InvalidInput(format!(
                "enabledTools에 중복 도구가 있습니다: {value}"
            )));
        }
    }
    Ok(unique.into_iter().collect())
}

pub(crate) fn validate_tool_name(value: &str) -> Result<(), CoreError> {
    if value.is_empty()
        || value.len() > 128
        || value
            .chars()
            .any(|character| character.is_control() || character.is_whitespace())
    {
        return Err(CoreError::InvalidInput(
            "MCP 도구 이름은 공백과 제어문자 없는 1~128자여야 합니다".to_owned(),
        ));
    }
    Ok(())
}

/// 이름으로 도구를 찾는다. 조사 결과와 저장된 권한 모두 같은 검색 규칙을 사용한다.
fn find_tool<'a>(tools: &'a [McpRemoteTool], name: &str) -> Option<&'a McpRemoteTool> {
    tools.iter().find(|tool| tool.name == name)
}

pub(crate) fn empty_object() -> Value {
    json!({})
}

#[cfg(test)]
mod tests {
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::thread;

    use super::*;

    #[test]
    fn event_stream_media_type_ignores_case_and_parameters() {
        assert!(is_event_stream("text/event-stream"));
        assert!(is_event_stream("Text/Event-Stream; charset=utf-8"));
        assert!(is_event_stream(" text/event-stream ;charset=UTF-8"));
        assert!(!is_event_stream("application/json"));
        assert!(!is_event_stream("text/event-streamx"));
        assert!(!is_event_stream(""));
    }

    fn sample_tools() -> Vec<McpRemoteTool> {
        vec![McpRemoteTool {
            name: "search".to_owned(),
            title: Some("Search".to_owned()),
            description: Some("Search documents".to_owned()),
            input_schema: json!({"type": "object"}),
            read_only: true,
            destructive: false,
        }]
    }

    #[test]
    fn identity_is_stable_and_covers_tool_contract() {
        let first = interface_identity(
            "https://example.com/mcp",
            "Example",
            Some("1"),
            &sample_tools(),
        )
        .unwrap();
        let second = interface_identity(
            "https://example.com/mcp",
            "Example",
            Some("1"),
            &sample_tools(),
        )
        .unwrap();
        let mut changed = sample_tools();
        changed[0].read_only = false;
        let changed =
            interface_identity("https://example.com/mcp", "Example", Some("1"), &changed).unwrap();
        assert_eq!(first, second);
        assert_ne!(first, changed);
    }

    #[test]
    fn sse_crlf_pagination_and_large_results_are_bounded() {
        let event = parse_sse_json(
            "event: message\r\ndata: {\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{}}\r\n\r\n",
        )
        .unwrap();
        assert_eq!(event["id"], 1);
        assert!(parse_tools(&json!({"tools": [], "nextCursor": "more"})).is_err());

        // E7의 64개는 켜 둔 도구 수다. 그보다 큰 카탈로그도 읽혀야 한다.
        let catalog = |count: usize| {
            json!({"tools": (0..count)
                .map(|index| json!({"name": format!("tool_{index}")}))
                .collect::<Vec<_>>()})
        };
        assert_eq!(
            parse_tools(&catalog(MAX_ENABLED_TOOLS + 10)).unwrap().len(),
            MAX_ENABLED_TOOLS + 10
        );
        assert!(matches!(
            parse_tools(&catalog(MAX_CATALOG_TOOLS + 1)),
            Err(CoreError::Conflict(_))
        ));

        let bounded = bounded_remote_result(json!({
            "content": [{"type": "text", "text": "x".repeat(MAX_EXPOSED_RESULT_BYTES)}],
            "isError": false
        }));
        assert_eq!(bounded["_meta"]["truncated"], true);
        assert_eq!(bounded["isError"], false);
    }

    #[test]
    fn catalog_reports_expired_grants_without_exposing_secrets() {
        let temp = tempfile::tempdir().unwrap();
        let registry = McpInterfaceRegistry::new(temp.path().to_path_buf());
        registry
            .with_store_lock(|| {
                let mut store = McpInterfaceStore::default();
                store.interfaces.insert(
                    "docs".to_owned(),
                    StoredMcpInterface {
                        id: "docs".to_owned(),
                        display_name: "Docs".to_owned(),
                        url: "https://example.com/mcp".to_owned(),
                        identity_hash: "a".repeat(64),
                        enabled_tools: vec!["search".to_owned()],
                        tools: sample_tools(),
                        granted_at: 1,
                        grant_expires_at: Some(2),
                    },
                );
                registry.save_store_unlocked(&store)
            })
            .unwrap();
        let catalog = registry.catalog().unwrap();
        assert_eq!(catalog["interfaces"][0]["status"], "expired");
        assert_eq!(catalog["interfaces"][0]["enabledTools"][0], "search");
    }

    #[test]
    fn approved_http_interface_is_pinned_routed_audited_and_revoked() {
        let (url, server) = spawn_mock_mcp(10);
        let temp = tempfile::tempdir().unwrap();
        let registry = McpInterfaceRegistry::new(temp.path().to_path_buf());

        let probe = registry
            .probe(McpInterfaceProbeRequest { url: url.clone() })
            .unwrap();
        assert_eq!(probe["serverName"], "Mock MCP");
        assert_eq!(probe["tools"][0]["name"], "search");
        assert_eq!(probe["tools"][0]["readOnly"], true);
        let identity = probe["identityHash"].as_str().unwrap().to_owned();

        registry
            .register(McpInterfaceRegisterRequest {
                id: "mock".to_owned(),
                display_name: "Mock MCP".to_owned(),
                url,
                expected_identity: identity,
                enabled_tools: vec!["search".to_owned()],
                grant_expires_at: None,
            })
            .unwrap();

        let result = registry
            .call_read(McpInterfaceCallRequest {
                id: "mock".to_owned(),
                tool: "search".to_owned(),
                arguments: json!({"query": "approved"}),
            })
            .unwrap();
        assert_eq!(result["result"]["isError"], false);
        assert_eq!(result["auditRecorded"], true);
        assert!(registry
            .call_execute(McpInterfaceCallRequest {
                id: "mock".to_owned(),
                tool: "search".to_owned(),
                arguments: json!({}),
            })
            .is_err());

        let catalog = registry.catalog().unwrap();
        assert_eq!(catalog["interfaces"][0]["status"], "active");
        assert!(catalog["recentAudit"]
            .as_array()
            .unwrap()
            .iter()
            .any(|event| event["action"] == "invoke" && event["outcome"] == "succeeded"));

        registry
            .revoke(McpInterfaceIdRequest {
                id: "mock".to_owned(),
            })
            .unwrap();
        assert!(registry.catalog().unwrap()["interfaces"]
            .as_array()
            .unwrap()
            .is_empty());
        server.join().unwrap();
    }

    fn spawn_mock_mcp(request_count: usize) -> (String, thread::JoinHandle<()>) {
        spawn_mock_mcp_with_call_result(
            request_count,
            json!({
                "content": [{"type": "text", "text": "approved result"}],
                "isError": false
            }),
            MockBody::default(),
        )
    }

    /// 모의 서버가 응답 본문을 내보내는 방식.
    #[derive(Clone, Copy, Default)]
    struct MockBody {
        /// 비ASCII 글자를 `\uXXXX`로 내보내 본문이 직렬화 결과보다 크게 오는 서버.
        ascii_only: bool,
        /// `Content-Length` 없이 연결을 닫아 본문 끝을 알리는 서버(chunked·SSE처럼 길이를
        /// 미리 모르는 본문).
        undeclared_length: bool,
    }

    /// `tools/call`이 `call_result`를 돌려주는 모의 서버.
    fn spawn_mock_mcp_with_call_result(
        request_count: usize,
        call_result: Value,
        body: MockBody,
    ) -> (String, thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let handle = thread::spawn(move || {
            for _ in 0..request_count {
                let (mut stream, _) = listener.accept().unwrap();
                let request = read_http_body(&mut stream);
                let payload: Value = serde_json::from_slice(&request).unwrap();
                let method = payload["method"].as_str().unwrap();
                if method == "notifications/initialized" {
                    stream
                        .write_all(
                            b"HTTP/1.1 202 Accepted\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                        )
                        .unwrap();
                    continue;
                }
                let id = payload["id"].clone();
                let result = match method {
                    "initialize" => json!({
                        "protocolVersion": MCP_PROTOCOL_VERSION,
                        "capabilities": {"tools": {"listChanged": false}},
                        "serverInfo": {"name": "mock", "title": "Mock MCP", "version": "1"}
                    }),
                    "tools/list" => json!({"tools": [{
                        "name": "search",
                        "title": "Search",
                        "description": "Search mock data",
                        "inputSchema": {"type": "object"},
                        "annotations": {"readOnlyHint": true, "destructiveHint": false}
                    }]}),
                    "tools/call" => call_result.clone(),
                    other => panic!("unexpected MCP method: {other}"),
                };
                let response = serde_json::to_string(&json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "result": result
                }))
                .unwrap();
                let response = if body.ascii_only {
                    escape_non_ascii(&response)
                } else {
                    response
                }
                .into_bytes();
                let length = if body.undeclared_length {
                    String::new()
                } else {
                    format!("Content-Length: {}\r\n", response.len())
                };
                write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nMcp-Session-Id: mock-session\r\n{length}Connection: close\r\n\r\n",
                )
                .unwrap();
                // 상한을 넘는 본문은 받는 쪽이 중간에 끊고 닫으므로 쓰기 실패는 정상이다.
                // 받는 쪽 판정은 각 시험이 결과로 확인한다.
                let _ = stream.write_all(&response);
            }
        });
        (format!("http://{address}/mcp"), handle)
    }

    /// serde가 낸 JSON 글의 비ASCII 글자를 `\uXXXX`(BMP 밖은 서로게이트 쌍)로 바꾼다.
    /// 비ASCII 글자는 문자열 값 안에만 있으므로 결과도 같은 값의 올바른 JSON이다.
    fn escape_non_ascii(text: &str) -> String {
        let mut escaped = String::with_capacity(text.len() * 2);
        for character in text.chars() {
            if character.is_ascii() {
                escaped.push(character);
            } else {
                let mut units = [0_u16; 2];
                for unit in character.encode_utf16(&mut units) {
                    escaped.push_str(&format!("\\u{unit:04x}"));
                }
            }
        }
        escaped
    }

    /// 노션 `notion-fetch`처럼 생긴 도구 결과. `content[0].text`가 다시 JSON 글이고, 그
    /// 안의 본문이 따옴표·줄바꿈·역슬래시·이모지가 섞인 한글 마크다운이다. 직렬화 크기가
    /// `target_bytes` 이상이 될 때까지 문단을 늘린다.
    fn notion_like_result(target_bytes: usize) -> Value {
        notion_like_result_with(target_bytes, KOREAN_PARAGRAPH)
    }

    const KOREAN_PARAGRAPH: &str = "## 3장. 생존 루프 \"밤의 습격\"\n\
            > 좀비 무리가 \"쿼터뷰\" 시야 밖에서 몰려온다 — 플레이어는 바리케이드(\\방어선\\)를 \
            세우고\t탄약을 아낀다. 🧟‍♂️🔦\n\
            - 규칙: {\"wave\": 3, \"spawn\": [\"walker\", \"runner\"]}\n\
            - 메모: 줄바꿈\r\n과 '작은따옴표', `코드`, <태그>, &amp; 도 그대로 둔다.\n\n";

    /// 키릴 문자(UTF-8 2바이트)는 `\uXXXX`로 오면 세 배가 된다 — 한글(두 배)보다 본문이
    /// 더 크게 불어나는 경우다.
    const CYRILLIC_PARAGRAPH: &str = "Глава 3. «Ночной штурм» — зомби идут волной; \
        баррикада держится, патроны на исходе. Ёжик в тумане сказал: «держись»\n";

    fn notion_like_result_with(target_bytes: usize, paragraph: &str) -> Value {
        let build = |markdown: &str| {
            let page = serde_json::to_string(&json!({
                "metadata": {"type": "page"},
                "title": "데드 루트 기획서",
                "url": "https://www.notion.so/deadroute",
                "text": format!("<page url=\"https://www.notion.so/deadroute\">\n{markdown}</page>")
            }))
            .unwrap();
            json!({"content": [{"type": "text", "text": page}], "isError": false})
        };
        // 문단 하나가 늘리는 직렬화 크기는 일정하므로 한 번 재서 필요한 개수를 셈한다.
        let size = |markdown: &str| serde_json::to_vec(&build(markdown)).unwrap().len();
        let base = size("");
        let step = size(paragraph) - base;
        let count = target_bytes.saturating_sub(base).div_ceil(step);
        let result = build(&paragraph.repeat(count));
        assert!(serde_json::to_vec(&result).unwrap().len() >= target_bytes);
        result
    }

    #[test]
    fn notion_sized_tool_result_reaches_agent_intact() {
        // 2026-10-25: 직렬화 270,480바이트 노션 페이지가 256 KB 상한에서 잘렸다.
        // 1.5 MiB(그 다섯 배 남짓)는 원격 본문·노출 상한을 모두 그대로 지나야 한다.
        let expected = notion_like_result(1536 * 1024);
        let serialized_bytes = serde_json::to_vec(&expected).unwrap().len();
        assert!(serialized_bytes < MAX_EXPOSED_RESULT_BYTES);

        // 서버가 한글을 \uXXXX로 보내면 본문은 결과보다 훨씬 커서 노출 상한도 넘는다 —
        // 그래도 본문 상한 안이라 여기서 끊기지 않는다.
        let body_bytes = escape_non_ascii(&serde_json::to_string(&expected).unwrap()).len();
        assert!(body_bytes > MAX_EXPOSED_RESULT_BYTES && body_bytes < MAX_REMOTE_BODY_BYTES);
        let (url, server) = spawn_mock_mcp_with_call_result(
            3,
            expected.clone(),
            MockBody {
                ascii_only: true,
                ..MockBody::default()
            },
        );
        let (mut session, _) = McpHttpSession::connect(&url).unwrap();
        let result = session
            .call_tool("notion-fetch", json!({"id": "deadroute"}))
            .unwrap();
        server.join().unwrap();

        let exposed = bounded_remote_result(result);
        assert!(exposed.get("_meta").is_none(), "결과가 생략되면 안 된다");
        assert_eq!(exposed, expected);
        let page: Value =
            serde_json::from_str(exposed["content"][0]["text"].as_str().unwrap()).unwrap();
        assert!(page["text"]
            .as_str()
            .unwrap()
            .contains("바리케이드(\\방어선\\)"));
    }

    #[test]
    fn tool_result_over_exposed_cap_is_replaced_with_notice() {
        // isError를 true로 바꾸면 한 바이트 줄어드니 상한보다 조금 더 크게 만든다.
        let mut oversized = notion_like_result(MAX_EXPOSED_RESULT_BYTES + 16);
        oversized["isError"] = json!(true);
        let serialized_bytes = serde_json::to_vec(&oversized).unwrap().len();
        assert!(serialized_bytes > MAX_EXPOSED_RESULT_BYTES);

        // 본문 상한(4 MiB)은 지나고, 노출 상한에서 생략된다.
        let (url, server) = spawn_mock_mcp_with_call_result(3, oversized, MockBody::default());
        let (mut session, _) = McpHttpSession::connect(&url).unwrap();
        let result = session
            .call_tool("notion-fetch", json!({"id": "deadroute"}))
            .unwrap();
        server.join().unwrap();

        let bounded = bounded_remote_result(result);
        assert_eq!(bounded["_meta"]["truncated"], true);
        assert_eq!(bounded["_meta"]["originalBytes"], serialized_bytes);
        assert_eq!(bounded["isError"], true);
        assert!(bounded["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("본문을 생략"));
        assert!(serde_json::to_vec(&bounded).unwrap().len() < 1024);
    }

    /// 노출 상한 바로 아래의 결과가 세 배로 불어난 본문으로 와도 본문 상한에서 먼저
    /// 끊기지 않아야 한다(본문 상한이 노출 상한의 두 배이던 때는 TooLarge 오류였다).
    #[test]
    fn escaped_cyrillic_result_just_under_exposed_cap_passes_body_cap() {
        let expected = notion_like_result_with(MAX_EXPOSED_RESULT_BYTES - 4096, CYRILLIC_PARAGRAPH);
        let serialized_bytes = serde_json::to_vec(&expected).unwrap().len();
        assert!(serialized_bytes <= MAX_EXPOSED_RESULT_BYTES);
        let body_bytes = escape_non_ascii(&serde_json::to_string(&expected).unwrap()).len();
        assert!(body_bytes > 2 * MAX_EXPOSED_RESULT_BYTES && body_bytes < MAX_REMOTE_BODY_BYTES);

        let (url, server) = spawn_mock_mcp_with_call_result(
            3,
            expected.clone(),
            MockBody {
                ascii_only: true,
                undeclared_length: true,
            },
        );
        let (mut session, _) = McpHttpSession::connect(&url).unwrap();
        let result = session
            .call_tool("notion-fetch", json!({"id": "cyrillic"}))
            .unwrap();
        server.join().unwrap();
        assert_eq!(bounded_remote_result(result), expected);
    }

    /// 본문 상한을 넘은 `tools/call` 응답은 오류가 아니라 생략 안내다. 길이를 선언한
    /// 본문은 읽기 전에, 선언하지 않은 본문은 상한까지만 읽고 끊는다.
    #[test]
    fn tool_call_body_over_body_cap_becomes_omitted_notice() {
        let oversized = notion_like_result(MAX_REMOTE_BODY_BYTES + 1024);
        for undeclared_length in [false, true] {
            let (url, server) = spawn_mock_mcp_with_call_result(
                3,
                oversized.clone(),
                MockBody {
                    ascii_only: false,
                    undeclared_length,
                },
            );
            let (mut session, _) = McpHttpSession::connect(&url).unwrap();
            let result = session
                .call_tool("notion-fetch", json!({"id": "huge"}))
                .unwrap();
            server.join().unwrap();
            let bounded = bounded_remote_result(result);
            assert_eq!(bounded["_meta"]["truncated"], true, "{undeclared_length}");
            assert_eq!(
                bounded["_meta"]["bodyLimitBytes"],
                MAX_REMOTE_BODY_BYTES as u64
            );
            assert_eq!(bounded["isError"], true);
            assert!(bounded["content"][0]["text"]
                .as_str()
                .unwrap()
                .contains("본문 상한"));
        }
    }

    #[test]
    fn omitted_results_are_told_apart_for_the_audit() {
        assert_eq!(
            remote_result_omission(&oversized_body_result(7)),
            Some(RemoteResultOmission::BodyLimitExceeded)
        );
        let truncated = bounded_remote_result(json!({
            "content": [{"type": "text", "text": "x".repeat(MAX_EXPOSED_RESULT_BYTES)}],
            "isError": false
        }));
        assert_eq!(
            remote_result_omission(&truncated),
            Some(RemoteResultOmission::Truncated)
        );
        let intact = bounded_remote_result(json!({
            "content": [{"type": "text", "text": "ok"}],
            "_meta": {"truncated": false},
            "isError": false
        }));
        assert_eq!(remote_result_omission(&intact), None);
    }

    /// 본문 상한을 넘은 호출은 생략 안내로 돌아오지만 감사에는 `remoteError`나 성공이
    /// 아니라 `bodyLimitExceeded`로 남는다.
    #[test]
    fn interface_call_over_body_cap_is_audited_as_body_limit_exceeded() {
        let oversized = notion_like_result(MAX_REMOTE_BODY_BYTES + 1024);
        // probe 3 + register 3 + call_read 4(연결 2, 도구 목록 1, 호출 1)
        let (url, server) = spawn_mock_mcp_with_call_result(10, oversized, MockBody::default());
        let temp = tempfile::tempdir().unwrap();
        let registry = McpInterfaceRegistry::new(temp.path().to_path_buf());
        let probe = registry
            .probe(McpInterfaceProbeRequest { url: url.clone() })
            .unwrap();
        registry
            .register(McpInterfaceRegisterRequest {
                id: "mock".to_owned(),
                display_name: "Mock MCP".to_owned(),
                url,
                expected_identity: probe["identityHash"].as_str().unwrap().to_owned(),
                enabled_tools: vec!["search".to_owned()],
                grant_expires_at: None,
            })
            .unwrap();
        let result = registry
            .call_read(McpInterfaceCallRequest {
                id: "mock".to_owned(),
                tool: "search".to_owned(),
                arguments: json!({}),
            })
            .unwrap();
        server.join().unwrap();
        assert_eq!(result["result"]["_meta"]["truncated"], true);
        let audit = registry.catalog().unwrap()["recentAudit"].clone();
        let invoke = audit
            .as_array()
            .unwrap()
            .iter()
            .find(|event| event["action"] == "invoke")
            .expect("호출 감사");
        assert_eq!(invoke["outcome"], "bodyLimitExceeded");
    }

    fn read_http_body(stream: &mut std::net::TcpStream) -> Vec<u8> {
        let mut bytes = Vec::new();
        let header_end = loop {
            let mut chunk = [0_u8; 1024];
            let read = stream.read(&mut chunk).unwrap();
            assert!(read > 0, "HTTP request ended before headers");
            bytes.extend_from_slice(&chunk[..read]);
            if let Some(index) = bytes.windows(4).position(|window| window == b"\r\n\r\n") {
                break index + 4;
            }
        };
        let headers = String::from_utf8_lossy(&bytes[..header_end]);
        let content_length = headers
            .lines()
            .find_map(|line| {
                let (name, value) = line.split_once(':')?;
                name.eq_ignore_ascii_case("content-length")
                    .then(|| value.trim().parse::<usize>().unwrap())
            })
            .unwrap_or(0);
        while bytes.len() < header_end + content_length {
            let mut chunk = [0_u8; 1024];
            let read = stream.read(&mut chunk).unwrap();
            assert!(read > 0, "HTTP request ended before body");
            bytes.extend_from_slice(&chunk[..read]);
        }
        bytes[header_end..header_end + content_length].to_vec()
    }
}
