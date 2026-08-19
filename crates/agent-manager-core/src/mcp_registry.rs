use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File, OpenOptions};
use std::io::Write;
#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use fs4::FileExt;
use reqwest::blocking::{Client, Response};
use reqwest::header::{ACCEPT, CONTENT_TYPE};
use reqwest::redirect::Policy;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::CoreError;

const STORE_FILE: &str = "aia-mcp-interfaces.json";
const STORE_LOCK_FILE: &str = "aia-mcp-interfaces.lock";
const AUDIT_FILE: &str = "aia-mcp-audit.jsonl";
const PREVIOUS_AUDIT_FILE: &str = "aia-mcp-audit.previous.jsonl";
const STORE_VERSION: u32 = 1;
const MCP_PROTOCOL_VERSION: &str = "2025-03-26";
const MAX_REMOTE_BODY_BYTES: usize = 512 * 1024;
const MAX_EXPOSED_RESULT_BYTES: usize = 256 * 1024;
const MAX_AUDIT_FILE_BYTES: u64 = 2 * 1024 * 1024;
const MAX_INTERFACES: usize = 32;
const MAX_ENABLED_TOOLS: usize = 64;
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
struct McpRemoteTool {
    name: String,
    title: Option<String>,
    description: Option<String>,
    input_schema: Value,
    read_only: bool,
    destructive: bool,
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

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct McpInterfaceStore {
    schema_version: u32,
    interfaces: BTreeMap<String, StoredMcpInterface>,
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

struct McpHttpSession {
    client: Client,
    url: String,
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
                .map(|interface| {
                    json!({
                        "id": interface.id,
                        "displayName": interface.display_name,
                        "url": interface.url,
                        "identityHash": interface.identity_hash,
                        "enabledTools": interface.enabled_tools,
                        "tools": interface.tools,
                        "grantedAt": interface.granted_at,
                        "grantExpiresAt": interface.grant_expires_at,
                        "status": if interface.grant_expires_at.is_some_and(|expires| expires <= now) { "expired" } else { "active" }
                    })
                })
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
                    "maxEnabledToolsPerInterface": MAX_ENABLED_TOOLS
                }
            }))
        })
    }

    pub(crate) fn probe(&self, request: McpInterfaceProbeRequest) -> Result<Value, CoreError> {
        let url = validate_endpoint(&request.url)?;
        match probe_remote(&url) {
            Ok((_, probe)) => {
                let _ = self.record_audit("probe", None, None, "succeeded");
                serde_json::to_value(probe).map_err(CoreError::Json)
            }
            Err(error) => {
                let _ = self.record_audit("probe", None, None, "failed");
                Err(error)
            }
        }
    }

    pub(crate) fn register(
        &self,
        request: McpInterfaceRegisterRequest,
    ) -> Result<Value, CoreError> {
        validate_interface_id(&request.id)?;
        let display_name = validate_display_name(&request.display_name)?;
        let url = validate_endpoint(&request.url)?;
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

        let (_, probe) = probe_remote(&url)?;
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
        let available = probe
            .tools
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
        let tools = probe
            .tools
            .into_iter()
            .filter(|tool| enabled_tools.iter().any(|enabled| enabled == &tool.name))
            .collect::<Vec<_>>();
        let granted_at = now_ms();
        let stored = StoredMcpInterface {
            id: request.id.clone(),
            display_name,
            url,
            identity_hash: probe.identity_hash,
            enabled_tools,
            tools,
            granted_at,
            grant_expires_at: request.grant_expires_at,
        };

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

    fn call(
        &self,
        request: McpInterfaceCallRequest,
        require_read_only: bool,
    ) -> Result<Value, CoreError> {
        validate_interface_id(&request.id)?;
        validate_tool_name(&request.tool)?;
        if !request.arguments.is_object() {
            return Err(CoreError::InvalidInput(
                "MCP 도구 arguments는 객체여야 합니다".to_owned(),
            ));
        }
        let interface = self.with_store_lock(|| {
            let store = self.load_store_unlocked()?;
            store.interfaces.get(&request.id).cloned().ok_or_else(|| {
                CoreError::NotFound("등록된 MCP 인터페이스를 찾을 수 없습니다".to_owned())
            })
        })?;
        if interface
            .grant_expires_at
            .is_some_and(|expires| expires <= now_ms())
        {
            let _ = self.record_audit(
                "invoke",
                Some(&request.id),
                Some(&request.tool),
                "grantExpired",
            );
            return Err(CoreError::Conflict(
                "MCP 인터페이스 권한이 만료되었습니다. 다시 등록해 주세요".to_owned(),
            ));
        }
        let granted_tool = interface
            .tools
            .iter()
            .find(|tool| tool.name == request.tool)
            .cloned();
        let Some(granted_tool) = granted_tool else {
            let _ = self.record_audit(
                "invoke",
                Some(&request.id),
                Some(&request.tool),
                "notGranted",
            );
            return Err(CoreError::InvalidInput(
                "이 인터페이스에 허용되지 않은 MCP 도구입니다".to_owned(),
            ));
        };
        if granted_tool.read_only != require_read_only {
            let _ = self.record_audit(
                "invoke",
                Some(&request.id),
                Some(&request.tool),
                "wrongAccessPath",
            );
            return Err(CoreError::InvalidInput(if require_read_only {
                "변경 가능 도구는 interface_execute로 호출해야 합니다".to_owned()
            } else {
                "읽기 전용 도구는 interface_read로 호출해야 합니다".to_owned()
            }));
        }

        let invocation = (|| {
            let (mut session, probe) = probe_remote(&interface.url)?;
            if probe.identity_hash != interface.identity_hash {
                return Err(CoreError::Conflict(
                    "등록 이후 MCP 서버 identity가 변경되었습니다. 권한을 회수하고 다시 등록해 주세요"
                        .to_owned(),
                ));
            }
            let current_tool = probe
                .tools
                .iter()
                .find(|tool| tool.name == request.tool)
                .ok_or_else(|| {
                    CoreError::Conflict(
                        "등록된 MCP 도구가 현재 서버 카탈로그에서 사라졌습니다".to_owned(),
                    )
                })?;
            if current_tool.read_only != granted_tool.read_only {
                return Err(CoreError::Conflict(
                    "MCP 도구의 읽기/변경 분류가 등록 이후 달라졌습니다".to_owned(),
                ));
            }
            session.call_tool(&request.tool, request.arguments)
        })();

        match invocation {
            Ok(result) => {
                let remote_error = result.get("isError").and_then(Value::as_bool) == Some(true);
                let result = bounded_remote_result(result);
                let audit_recorded = self
                    .record_audit(
                        "invoke",
                        Some(&request.id),
                        Some(&request.tool),
                        if remote_error {
                            "remoteError"
                        } else {
                            "succeeded"
                        },
                    )
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
                let _ =
                    self.record_audit("invoke", Some(&request.id), Some(&request.tool), outcome);
                Err(error)
            }
        }
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
        fs::create_dir_all(&self.app_data_dir)?;
        let lock = open_private_file(&self.app_data_dir.join(STORE_LOCK_FILE), false)?;
        lock.lock().map_err(|error| {
            CoreError::Runtime(format!("AIA MCP 저장소 잠금을 얻지 못했습니다: {error}"))
        })?;
        let result = action();
        let _ = FileExt::unlock(&lock);
        result
    }

    fn load_store_unlocked(&self) -> Result<McpInterfaceStore, CoreError> {
        let path = self.app_data_dir.join(STORE_FILE);
        if !path.is_file() {
            return Ok(McpInterfaceStore::default());
        }
        let store: McpInterfaceStore = serde_json::from_slice(&fs::read(path)?)?;
        if store.schema_version != STORE_VERSION {
            return Err(CoreError::Conflict(format!(
                "지원하지 않는 AIA MCP 저장소 버전입니다: {}",
                store.schema_version
            )));
        }
        Ok(store)
    }

    fn save_store_unlocked(&self, store: &McpInterfaceStore) -> Result<(), CoreError> {
        let path = self.app_data_dir.join(STORE_FILE);
        let temporary = self
            .app_data_dir
            .join(format!(".{STORE_FILE}.{}.tmp", Uuid::new_v4()));
        let result = (|| {
            let mut file = open_private_file(&temporary, true)?;
            file.write_all(&serde_json::to_vec_pretty(store)?)?;
            file.write_all(b"\n")?;
            file.sync_all()?;
            drop(file);
            if cfg!(windows) && path.exists() {
                fs::remove_file(&path)?;
            }
            fs::rename(&temporary, &path)?;
            File::open(&self.app_data_dir)?.sync_all()?;
            Ok(())
        })();
        if result.is_err() {
            let _ = fs::remove_file(temporary);
        }
        result
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
        let mut file = open_private_file(&path, false)?;
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

    fn list_tools(&mut self) -> Result<Value, CoreError> {
        self.rpc("tools/list", json!({}))
    }

    fn call_tool(&mut self, name: &str, arguments: Value) -> Result<Value, CoreError> {
        self.rpc("tools/call", json!({"name": name, "arguments": arguments}))
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
        let value = response
            .ok_or_else(|| CoreError::Runtime(format!("MCP {method} 응답이 비어 있습니다")))?;
        if let Some(error) = value.get("error") {
            let message = error
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("알 수 없는 MCP JSON-RPC 오류");
            return Err(CoreError::Runtime(format!(
                "MCP {method} 요청이 실패했습니다: {}",
                truncate_text(message, 300)
            )));
        }
        value
            .get("result")
            .cloned()
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

fn probe_remote(url: &str) -> Result<(McpHttpSession, McpInterfaceProbe), CoreError> {
    let (mut session, initialize) = McpHttpSession::connect(url)?;
    let tools_result = session.list_tools()?;
    let tools = parse_tools(&tools_result)?;
    let server_info = initialize.get("serverInfo").cloned().unwrap_or(Value::Null);
    let server_name = server_info
        .get("title")
        .or_else(|| server_info.get("name"))
        .and_then(Value::as_str)
        .unwrap_or("이름 없는 MCP 서버")
        .to_owned();
    let server_version = server_info
        .get("version")
        .and_then(Value::as_str)
        .map(str::to_owned);
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

fn parse_tools(result: &Value) -> Result<Vec<McpRemoteTool>, CoreError> {
    if result
        .get("nextCursor")
        .and_then(Value::as_str)
        .is_some_and(|cursor| !cursor.is_empty())
    {
        return Err(CoreError::Conflict(format!(
            "1차 동적 MCP는 최대 {MAX_ENABLED_TOOLS}개의 비페이지 도구 카탈로그만 지원합니다"
        )));
    }
    let raw_tools = result
        .get("tools")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            CoreError::Runtime("MCP tools/list 응답에 tools 배열이 없습니다".to_owned())
        })?;
    if raw_tools.len() > MAX_ENABLED_TOOLS {
        return Err(CoreError::TooLarge(MAX_ENABLED_TOOLS as u64));
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
                .map(|value| truncate_text(value, 120)),
            description: raw
                .get("description")
                .and_then(Value::as_str)
                .map(|value| truncate_text(value, 500)),
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
    if response
        .content_length()
        .is_some_and(|length| length > MAX_REMOTE_BODY_BYTES as u64)
    {
        return Err(CoreError::TooLarge(MAX_REMOTE_BODY_BYTES as u64));
    }
    let content_type = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_owned();
    let body = response
        .bytes()
        .map_err(|error| CoreError::Runtime(format!("MCP 서버 응답을 읽지 못했습니다: {error}")))?;
    if body.len() > MAX_REMOTE_BODY_BYTES {
        return Err(CoreError::TooLarge(MAX_REMOTE_BODY_BYTES as u64));
    }
    if body.is_empty() {
        return Ok(None);
    }
    if content_type.starts_with("text/event-stream") {
        let text = std::str::from_utf8(&body)
            .map_err(|_| CoreError::Runtime("MCP SSE 응답이 UTF-8이 아닙니다".to_owned()))?;
        return parse_sse_json(text).map(Some);
    }
    serde_json::from_slice(&body)
        .map(Some)
        .map_err(CoreError::Json)
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

fn bounded_remote_result(result: Value) -> Value {
    let serialized_bytes = serde_json::to_vec(&result)
        .map(|bytes| bytes.len())
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

fn validate_endpoint(input: &str) -> Result<String, CoreError> {
    let url = reqwest::Url::parse(input.trim())
        .map_err(|_| CoreError::InvalidInput("올바른 MCP HTTP URL이 아닙니다".to_owned()))?;
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(CoreError::InvalidInput(
            "MCP URL에는 사용자정보, 비밀번호, query 또는 fragment를 넣을 수 없습니다".to_owned(),
        ));
    }
    let host = url
        .host_str()
        .ok_or_else(|| CoreError::InvalidInput("MCP URL에 호스트가 없습니다".to_owned()))?;
    let loopback = matches!(host, "localhost" | "127.0.0.1" | "::1");
    match url.scheme() {
        "https" => {}
        "http" if loopback => {}
        _ => {
            return Err(CoreError::InvalidInput(
                "원격 MCP는 HTTPS만, 로컬 MCP는 loopback HTTP 또는 HTTPS만 허용됩니다".to_owned(),
            ))
        }
    }
    Ok(url.to_string())
}

fn validate_interface_id(value: &str) -> Result<(), CoreError> {
    if value.is_empty()
        || value.len() > 64
        || !value.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'_' | b'-')
        })
        || !value
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphanumeric)
    {
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

fn validate_tool_name(value: &str) -> Result<(), CoreError> {
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

fn open_private_file(path: &Path, create_new: bool) -> Result<File, CoreError> {
    let mut options = OpenOptions::new();
    options.read(true).write(true);
    if create_new {
        options.create_new(true);
    } else {
        options
            .create(true)
            .append(path.file_name().and_then(|name| name.to_str()) == Some(AUDIT_FILE));
    }
    #[cfg(unix)]
    options.mode(0o600);
    options.open(path).map_err(CoreError::Io)
}

fn empty_object() -> Value {
    json!({})
}

fn truncate_text(value: &str, max_chars: usize) -> String {
    let mut chars = value.chars();
    let text = chars.by_ref().take(max_chars).collect::<String>();
    if chars.next().is_some() {
        format!("{text}…")
    } else {
        text
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

#[cfg(test)]
mod tests {
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::thread;

    use super::*;

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
    fn endpoint_requires_https_except_for_loopback() {
        assert!(validate_endpoint("https://example.com/mcp").is_ok());
        assert!(validate_endpoint("http://127.0.0.1:4179/mcp").is_ok());
        assert!(validate_endpoint("http://localhost:4179/mcp").is_ok());
        assert!(validate_endpoint("http://example.com/mcp").is_err());
        assert!(validate_endpoint("https://example.com/mcp?token=secret").is_err());
        assert!(validate_endpoint("https://user:secret@example.com/mcp").is_err());
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
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let handle = thread::spawn(move || {
            for _ in 0..request_count {
                let (mut stream, _) = listener.accept().unwrap();
                let body = read_http_body(&mut stream);
                let payload: Value = serde_json::from_slice(&body).unwrap();
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
                    "tools/call" => json!({
                        "content": [{"type": "text", "text": "approved result"}],
                        "isError": false
                    }),
                    other => panic!("unexpected MCP method: {other}"),
                };
                let response = serde_json::to_vec(&json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "result": result
                }))
                .unwrap();
                write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nMcp-Session-Id: mock-session\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    response.len()
                )
                .unwrap();
                stream.write_all(&response).unwrap();
            }
        });
        (format!("http://{address}/mcp"), handle)
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
